import { describe, it, expect } from "vitest";
import { estimateTokens, computeRunningMs, estimateRunCost, estimateRunCostCeiling } from "@/lib/agent/usage";
import type { RuntimeEvent } from "@/lib/agent/adapter";

describe("estimateTokens", () => {
  it("한국어 대략 2자당 1토큰", () => {
    expect(estimateTokens("가나다라")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("computeRunningMs", () => {
  const ev = (type: "status_running" | "status_idle", at: string): RuntimeEvent => ({ id: at, at, type }) as RuntimeEvent;

  it("running→idle 구간 합산", () => {
    const events = [
      ev("status_running", "2026-07-22T00:00:00Z"),
      ev("status_idle", "2026-07-22T00:10:00Z"),
      ev("status_running", "2026-07-22T01:00:00Z"),
      ev("status_idle", "2026-07-22T01:05:00Z"),
    ];
    expect(computeRunningMs(events, "2026-07-22T02:00:00Z")).toBe(15 * 60_000);
  });

  it("열린 running 구간은 now까지", () => {
    const events = [ev("status_running", "2026-07-22T00:00:00Z")];
    expect(computeRunningMs(events, "2026-07-22T00:03:00Z")).toBe(3 * 60_000);
  });

  it("타임스탬프 없는 이벤트는 무시", () => {
    const events: RuntimeEvent[] = [{ id: "x", at: null, type: "status_running" }];
    expect(computeRunningMs(events, "2026-07-22T00:03:00Z")).toBe(0);
  });
});

describe("estimateRunCost", () => {
  it("sonnet-5: 출력토큰×$15/M×2마진 + 시간×$0.08", () => {
    // 100만 출력토큰, 1시간 → 15*2 + 0.08 = 30.08
    expect(estimateRunCost({ outputTokens: 1_000_000, runningMs: 3_600_000, model: "claude-sonnet-5" })).toBe(30.08);
  });

  it("요율표에 없는 모델은 null (다른 모델 요율로 조용히 계산하지 않음)", () => {
    expect(estimateRunCost({ outputTokens: 1_000_000, runningMs: 0, model: "unknown" })).toBeNull();
  });
});

describe("estimateRunCostCeiling", () => {
  it("등록 모델은 estimateRunCost와 같다", () => {
    const i = { outputTokens: 1_000_000, runningMs: 3_600_000, model: "claude-sonnet-5" };
    expect(estimateRunCostCeiling(i)).toBe(estimateRunCost(i));
  });

  it("미등록 모델은 표의 최고 요율로 보수 계산 (비용 상한 유지)", () => {
    // 최고 출력 요율 $75/M × 2마진 = 150
    expect(estimateRunCostCeiling({ outputTokens: 1_000_000, runningMs: 0, model: "unknown" })).toBe(150);
  });
});
