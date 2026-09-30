import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, buildKickoffPrompt, buildCheckpointReply, STAGE_SKILL } from "@/lib/agent/prompts";

describe("prompts", () => {
  it("시스템 프롬프트에 3대 프로토콜 마커가 있다", () => {
    expect(SYSTEM_PROMPT).toContain("```checkpoint");
    expect(SYSTEM_PROMPT).toContain("```run-complete");
    expect(SYSTEM_PROMPT).toContain("```senior-advice");
    expect(SYSTEM_PROMPT).toContain("/mnt/session/outputs");
  });

  it("시스템 프롬프트에 안전수칙 5조가 모두 있다 (원본: litigation-writer/CLAUDE.md)", () => {
    for (const rule of ["사실 생성 금지", "인용 단일 진입로", "모르면 확인필요", "검증 게이트", "렌더 전 키 검사"]) {
      expect(SYSTEM_PROMPT).toContain(rule);
    }
    expect(SYSTEM_PROMPT).toContain("제출 금지");
  });

  it("draft 킥오프는 라운드 종류에 따라 스킬이 갈린다", () => {
    expect(buildKickoffPrompt({ stage: "draft", roundKind: "소장" })).toContain("draft-complaint");
    expect(buildKickoffPrompt({ stage: "draft", roundKind: "준비서면" })).toContain("draft-brief");
    expect(buildKickoffPrompt({ stage: "draft", roundKind: "소장" })).toContain("pip install docxtpl");
  });

  it("intake 킥오프에 번들 해제·스킬 경로·완료 마커 지시가 있다", () => {
    const p = buildKickoffPrompt({ stage: "intake", roundKind: "소장" });
    expect(p).toContain("tar xzf");
    expect(p).toContain("bundle/skills/case-intake/SKILL.md");
    expect(p).toContain("run-complete");
    expect(p).not.toContain("pip install");
  });

  it("수정 지시가 있으면 지시문 절이 포함된다", () => {
    const p = buildKickoffPrompt({ stage: "draft", roundKind: "소장", instruction: "청구취지 2항 이율 수정" });
    expect(p).toContain("변호사 수정 지시");
    expect(p).toContain("청구취지 2항 이율 수정");
  });

  it("체크포인트 응답 메시지는 JSON 펜스를 포함한다", () => {
    const m = buildCheckpointReply("쟁점승인", { issues: [{ id: "쟁점1", title: "t", claim: "c" }] });
    expect(m).toContain("checkpoint-response");
    expect(m).toContain('"쟁점1"');
  });

  it("STAGE_SKILL 매핑", () => {
    expect(STAGE_SKILL.intake).toBe("case-intake");
    expect(STAGE_SKILL.research).toBe("legal-research");
    expect(STAGE_SKILL.verify).toBe("verify-citations");
  });
});
