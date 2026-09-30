import type { RuntimeEvent } from "@/lib/agent/adapter";

type Rates = { inPerMTok: number; outPerMTok: number };

/** USD per 1M tokens. 요율 개정 시 여기만 수정. ANTHROPIC_AGENT_MODEL을 바꾸면 그 모델 행을 함께 추가한다. */
export const MODEL_RATES: Record<string, Rates> = {
  "claude-sonnet-5": { inPerMTok: 3, outPerMTok: 15 },
  "claude-opus-4-8": { inPerMTok: 15, outPerMTok: 75 },
};
const COMPUTE_USD_PER_HOUR = 0.08;
/** 입력측(히스토리 재전송 등)을 계측할 수 없어 출력 비용에 2배 마진 */
const UNMEASURED_INPUT_MARGIN = 2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** status_running→status_idle 구간(ms) 합산. 열린 구간은 now까지. at 없는 이벤트 무시. */
export function computeRunningMs(events: RuntimeEvent[], nowIso: string): number {
  let total = 0;
  let openStart: number | null = null;
  for (const e of events) {
    if (!e.at) continue;
    const t = Date.parse(e.at);
    if (e.type === "status_running" && openStart === null) openStart = t;
    if (e.type === "status_idle" && openStart !== null) {
      total += Math.max(0, t - openStart);
      openStart = null;
    }
  }
  if (openStart !== null) total += Math.max(0, Date.parse(nowIso) - openStart);
  return total;
}

type CostInput = { outputTokens: number; runningMs: number; model: string };

function costWith(rates: Rates, i: CostInput): number {
  const tokenCost = (i.outputTokens / 1_000_000) * rates.outPerMTok * UNMEASURED_INPUT_MARGIN;
  const computeCost = (i.runningMs / 3_600_000) * COMPUTE_USD_PER_HOUR;
  return Math.round((tokenCost + computeCost) * 10_000) / 10_000;
}

/**
 * 화면 표시용 추정 비용. 요율표에 없는 모델이면 null — 다른 모델 요율로 조용히 계산하지 않는다.
 * 호출 측은 null을 "요율 미등록"으로 드러낸다.
 */
export function estimateRunCost(i: CostInput): number | null {
  const rates = MODEL_RATES[i.model];
  return rates ? costWith(rates, i) : null;
}

/**
 * 비용 상한 판정·run 기록용 추정치. 요율표에 없는 모델은 표의 최고 요율로 보수 계산해
 * 모델을 바꿔도 비용 상한 안전장치가 꺼지지 않게 한다.
 */
export function estimateRunCostCeiling(i: CostInput): number {
  const rates =
    MODEL_RATES[i.model] ??
    Object.values(MODEL_RATES).reduce((a, b) => (b.outPerMTok > a.outPerMTok ? b : a));
  return costWith(rates, i);
}
