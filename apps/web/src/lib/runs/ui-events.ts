import type { RuntimeEvent } from "@/lib/agent/adapter";
import { parseSeniorAdvice, stripSeniorAdvice } from "@/lib/agent/protocol";

export type UiEvent =
  | { kind: "timeline"; id: string; text: string; state: "done" | "running" }
  | { kind: "advice"; lines: string[] }
  | { kind: "cost"; usd: number | null } // null = 모델 요율 미등록(usage.ts MODEL_RATES)
  | { kind: "status"; runStatus: string };

/** 시니어 조언은 live 스트림에서만 1회 방출 — 리플레이·저장 경로에서는 절대 내보내지 않는다. */
export function toUiEvents(e: RuntimeEvent, opts: { live: boolean }): UiEvent[] {
  switch (e.type) {
    case "message": {
      const out: UiEvent[] = [];
      const advice = opts.live ? parseSeniorAdvice(e.text) : null;
      const text = stripSeniorAdvice(e.text).trim();
      if (text.length > 0) out.push({ kind: "timeline", id: e.id, text, state: "done" });
      if (advice) out.push({ kind: "advice", lines: advice });
      return out;
    }
    case "progress":
      // thinking 블록으로 온 진행 노트(비어 있지 않은 것만 도착한다) — 에이전트 서술과 같은 타임라인 한 줄.
      return [{ kind: "timeline", id: e.id, text: e.text, state: "done" }];
    case "tool_use":
      // 도구 실행 세부는 표시하지 않는다 — 진행 상황은 에이전트의 한국어 서술(message)로 전달된다.
      return [];
    case "error":
      return [{ kind: "timeline", id: e.id, text: `오류: ${e.message}`, state: "done" }];
    default:
      return [];
  }
}
