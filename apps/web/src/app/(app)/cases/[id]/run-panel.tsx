"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, RotateCcw } from "lucide-react";
import {
  RunningConsole,
  CheckpointConsole,
  type TimelineItem,
  type CheckpointIssue,
} from "@/components/case/console-drawer";
import { SeniorAdviceModal } from "@/components/case/senior-advice-modal";
import type { UiEvent } from "@/lib/runs/ui-events";
import { stageLabel } from "@/lib/runs/labels";

type CheckpointDto = {
  id: string;
  kind: "쟁점승인" | "질문";
  payload: { type: string; issues?: CheckpointIssue[]; question?: string };
};

/** POST /api/cases/{caseId}/runs — 성공 시 router.refresh(), 실패 시 alert. */
function useStartStage(caseId: string, stage: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) alert(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "실행 시작 실패");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return { busy, start };
}

export function StartRunButton({ caseId, stage, label }: { caseId: string; stage: string; label: string }) {
  const { busy, start } = useStartStage(caseId, stage);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={start}
      className="flex items-center gap-1.5 rounded-md bg-app-primary px-3 py-[7px] text-xs font-semibold text-white disabled:opacity-50"
    >
      <Play className="size-3.5" />
      {busy ? "시작 중…" : label}
    </button>
  );
}

/**
 * 단계 재실행 버튼.
 * - kind="retry": 실패 단계 — 빨간 톤 "다시 시도" 버튼, 확인 없이 즉시 실행
 * - kind="rerun": 완료·검수대기 단계 — 작은 ↻ 아이콘, confirm 후 실행
 */
export function RerunButton({
  caseId,
  stage,
  stageName,
  kind,
}: {
  caseId: string;
  stage: string;
  stageName: string;
  kind: "retry" | "rerun";
}) {
  const { busy, start } = useStartStage(caseId, stage);
  if (kind === "retry") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={start}
        className="flex items-center gap-1.5 rounded-md bg-st-block px-3 py-[7px] text-xs font-semibold text-white disabled:opacity-50"
      >
        <RotateCcw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
        {busy ? "시작 중…" : "다시 시도"}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      title={`${stageName} 다시 실행`}
      aria-label={`${stageName} 다시 실행`}
      onClick={() => {
        if (busy) return;
        if (confirm(`${stageName} 단계를 다시 실행할까요? 새 산출물 버전이 생성되며 기존 버전은 보존됩니다. (실행 비용 발생)`))
          start();
      }}
      className="flex size-6 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
    >
      <RotateCcw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
    </button>
  );
}

export function RunPanel({
  caseId,
  run,
  checkpoint,
}: {
  caseId: string;
  run: { id: string; stage: string; status: string } | null;
  checkpoint: CheckpointDto | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cost, setCost] = useState<{ usd: number | null } | null>(null); // usd null = 요율 미등록 모델
  const [advice, setAdvice] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const es = new EventSource(`/api/runs/${run.id}/stream`);
    esRef.current = es;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as UiEvent;
      if (e.kind === "timeline") {
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.text === e.text) return prev; // 동일 문구 반복은 한 줄로 유지
          return [...prev.map((p) => ({ ...p, state: "done" as const })), { text: e.text, state: "running" }];
        });
      } else if (e.kind === "cost") setCost({ usd: e.usd });
      else if (e.kind === "advice") setAdvice(e.lines);
      else if (e.kind === "status") {
        es.close();
        router.refresh(); // 체크포인트·검수 대기·실패 등 서버 상태 반영
      }
    };
    es.onerror = () => {
      /* EventSource가 자동 재접속 — 프록시가 히스토리 dedup */
    };
    return () => es.close();
  }, [run?.id, run?.status, router]); // eslint-disable-line react-hooks/exhaustive-deps

  async function post(url: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({ error: "요청 실패" }))) as { error?: string };
        alert(error ?? "요청 실패");
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  if (!run) return advice ? <SeniorAdviceModal advice={advice} onClose={() => setAdvice(null)} /> : null;

  return (
    <>
      {run.status === "waiting_checkpoint" && checkpoint ? (
        <CheckpointConsole
          issues={checkpoint.payload.issues ?? []}
          question={checkpoint.kind === "질문" ? checkpoint.payload.question : undefined}
          submitting={busy}
          onSubmit={async (issues) => {
            if (busy) return;
            if (await post(`/api/checkpoints/${checkpoint.id}/respond`, { response: { issues } })) router.refresh();
          }}
          onSubmitAnswer={async (answer) => {
            if (busy) return;
            if (await post(`/api/checkpoints/${checkpoint.id}/respond`, { response: { answer } })) router.refresh();
          }}
        />
      ) : (
        <RunningConsole
          title={`실행 중 — ${stageLabel(run.stage)}`}
          submitting={busy}
          items={items.length > 0 ? items : [{ text: "세션 준비 중…", state: "running" }]}
          footer={
            cost === null
              ? "idle 대기 중에는 과금되지 않습니다"
              : cost.usd === null
                ? "추정 비용 — 요율 미등록 모델 · idle 대기 중에는 과금되지 않습니다"
                : `추정 비용 $${cost.usd.toFixed(2)} · idle 대기 중에는 과금되지 않습니다`
          }
          onCancel={async () => {
            if (busy) return;
            if (confirm("실행을 취소할까요?") && (await post(`/api/runs/${run.id}/cancel`))) router.refresh();
          }}
        />
      )}
      {advice && <SeniorAdviceModal advice={advice} onClose={() => setAdvice(null)} />}
    </>
  );
}
