import type { AgentRuntime, RuntimeEvent } from "@/lib/agent/adapter";
import { parseCheckpoint, parseRunComplete } from "@/lib/agent/protocol";
import { computeRunningMs, estimateRunCostCeiling, estimateTokens } from "@/lib/agent/usage";
import type { RunStore } from "@/lib/runs/store";

export type RunDeps = {
  store: RunStore;
  runtime: AgentRuntime;
  model: string;
  /** 산출 파일 harvest 재시도 (Files API 인덱싱 지연 대응). 테스트에서 delayMs=0으로 즉시화. */
  harvest?: { attempts?: number; delayMs?: number };
};
const TERMINAL = ["succeeded", "failed", "canceled"];
const ACTIVE: ("running" | "waiting_checkpoint")[] = ["running", "waiting_checkpoint"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lastMessageText(events: RuntimeEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "message") return e.text;
  }
  return "";
}

function isIdle(events: RuntimeEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "status_idle") return true;
    if (e.type === "status_running") return false;
  }
  return false;
}

/** 유일한 run 상태 전이 지점. 어디서 몇 번 불려도 안전(멱등). */
export async function syncRun(deps: RunDeps, runId: string): Promise<{ status: string }> {
  const { store, runtime, model } = deps;
  const run = await store.getRun(runId);
  if (TERMINAL.includes(run.status)) return { status: run.status };
  if (!run.agent_session_id) return { status: run.status };

  const events = await runtime.listEvents(run.agent_session_id);
  const outputTokens = events.reduce((n, e) => (e.type === "message" ? n + estimateTokens(e.text) : n), 0);
  const runningMs = computeRunningMs(events, new Date().toISOString());
  // 상한 판정·기록은 보수 추정치(요율 미등록 모델은 최고 요율)로 — 화면 표시는 stream 경로가 "요율 미등록"으로 드러낸다.
  const cost = estimateRunCostCeiling({ outputTokens, runningMs, model });
  await store.updateRun(runId, { output_tokens: outputTokens, cost_usd: cost }, { onlyIfStatus: ACTIVE });

  const idle = isIdle(events);
  const { run_cost_cap_usd } = await store.getSettings();
  if (cost > run_cost_cap_usd && !idle) {
    await runtime.interrupt(run.agent_session_id);
    await store.updateRun(
      runId,
      {
        status: "failed",
        error: `비용 상한 초과 (추정 $${cost} > $${run_cost_cap_usd})`,
        finished_at: new Date().toISOString(),
      },
      { onlyIfStatus: ACTIVE },
    );
    await store.updateCaseStatus(run.round.case_id, "대기");
    return { status: "failed" };
  }

  const errorEvent = events.find((e) => e.type === "error");
  if (errorEvent && errorEvent.type === "error") {
    await store.updateRun(
      runId,
      { status: "failed", error: errorEvent.message, finished_at: new Date().toISOString() },
      { onlyIfStatus: ACTIVE },
    );
    await store.updateCaseStatus(run.round.case_id, "대기");
    return { status: "failed" };
  }

  if (!idle) return { status: run.status };

  const text = lastMessageText(events);
  const checkpoint = parseCheckpoint(text);
  const complete = parseRunComplete(text);

  if (checkpoint) {
    const open = await store.openCheckpoint(runId);
    if (!open) {
      await store.insertCheckpoint({ runId, kind: checkpoint.type, payload: checkpoint });
      await store.updateRun(runId, { status: "waiting_checkpoint" }, { onlyIfStatus: ["running"] });
      await store.updateCaseStatus(run.round.case_id, "응답 필요");
    }
    return { status: "waiting_checkpoint" };
  }

  if (run.status === "waiting_checkpoint") return { status: run.status }; // 응답 대기 중 idle은 정상

  if (complete) {
    const claimed = await store.updateRun(runId, { status: "succeeded" }, { onlyIfStatus: ["running"] });
    if (!claimed) return { status: (await store.getRun(runId)).status }; // 경쟁 호출이 선점

    // 산출 파일은 /mnt/session/outputs/ 에 써야 Files API가 자동 캡처한다. idle 직후에는
    // 인덱싱 지연(~1–3s)이 있어 선언 파일이 아직 목록에 없을 수 있으므로 짧게 재시도한다.
    const declared = complete.files;
    const someMissing = (list: { filename: string }[]) =>
      declared.some((f) => !list.some((s) => s.filename === f.filename));
    const attempts = deps.harvest?.attempts ?? 3;
    const delayMs = deps.harvest?.delayMs ?? 1500;
    let sessionFiles = await runtime.listSessionFiles(run.agent_session_id);
    for (let i = 1; i < attempts && someMissing(sessionFiles); i++) {
      await sleep(delayMs);
      sessionFiles = await runtime.listSessionFiles(run.agent_session_id);
    }

    let harvested = 0;
    for (const f of declared) {
      const match = sessionFiles.find((s) => s.filename === f.filename);
      if (!match) continue; // 일부 선언 파일 누락은 허용(부분 harvest)
      const content = await runtime.downloadFile(match.fileId);
      const version = await store.nextFileVersion(run.round.case_id, f.kind, f.filename);
      await store.saveArtifact({ caseId: run.round.case_id, kind: f.kind, filename: f.filename, version, content, runId });
      harvested++;
    }

    // 선언 파일을 하나도 회수하지 못하면 산출물 없는 '유령 성공'이 되어 검수 탭이 빈다 —
    // 조용히 넘기지 말고 실패로 표면화한다(에이전트가 잘못된 경로에 썼을 가능성 안내).
    if (harvested === 0) {
      const got = sessionFiles.map((s) => s.filename).join(", ") || "(없음)";
      const want = declared.map((f) => f.filename).join(", ");
      await store.updateRun(
        runId,
        {
          status: "failed",
          error: `산출 파일을 세션에서 회수하지 못했습니다 — 선언: [${want}] / 세션 파일: [${got}]. 에이전트가 /mnt/session/outputs/ 에 파일을 썼는지 확인하세요.`,
          finished_at: new Date().toISOString(),
        },
        { onlyIfStatus: ["succeeded"] },
      );
      await store.updateCaseStatus(run.round.case_id, "대기");
      return { status: "failed" };
    }

    await store.updateRun(runId, { finished_at: new Date().toISOString(), output_tokens: outputTokens, cost_usd: cost });
    if (run.stage === "verify") {
      const report = await store.latestArtifactText(run.round.case_id, "검증보고");
      await store.updateCaseStatus(run.round.case_id, report?.includes("FAIL") ? "제출 금지" : "검수 대기");
    } else {
      await store.updateCaseStatus(run.round.case_id, "검수 대기");
    }
    return { status: "succeeded" };
  }

  await store.updateRun(
    runId,
    {
      status: "failed",
      error: "완료/체크포인트 마커 없이 세션이 종료됨 — 세션 로그 확인 필요",
      finished_at: new Date().toISOString(),
    },
    { onlyIfStatus: ACTIVE },
  );
  await store.updateCaseStatus(run.round.case_id, "대기");
  return { status: "failed" };
}

export async function cancelRun(deps: RunDeps, runId: string): Promise<void> {
  const { store, runtime } = deps;
  const run = await store.getRun(runId);
  if (TERMINAL.includes(run.status)) return;
  if (run.agent_session_id) await runtime.interrupt(run.agent_session_id);
  await store.updateRun(runId, { status: "canceled", finished_at: new Date().toISOString() }, { onlyIfStatus: ACTIVE });
  await store.updateCaseStatus(run.round.case_id, "대기");
}
