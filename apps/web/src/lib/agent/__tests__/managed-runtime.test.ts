import { describe, it, expect, vi, afterEach } from "vitest";
import { createManagedRuntime, computeConfigHash } from "@/lib/agent/managed-runtime";
import type { SettingsDb } from "@/lib/db/settings";

afterEach(() => vi.unstubAllGlobals());

const ENV = {
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_AGENT_MODEL: "claude-sonnet-5",
  APP_PUBLIC_URL: "https://ex.vercel.app",
  MCP_SHARED_SECRET: "0123456789abcdef0123456789abcdef",
} as never;

function settingsDb(row: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }),
      update: (v: Record<string, unknown>) => ({ eq: async () => (updates.push(v), { error: null }) }),
    }),
  } as unknown as SettingsDb;
  return { db, updates };
}

const EMPTY_SETTINGS = {
  id: 1,
  run_cost_cap_usd: 5,
  anthropic_environment_id: null,
  anthropic_agent_id: null,
  agent_config_hash: null,
  updated_at: "2026-07-22T00:00:00Z",
};

function jsonRes(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ensureProvisioned", () => {
  it("캐시 없으면 environment→agent를 만들고 저장한다", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url.endsWith("/v1/environments")) return jsonRes({ id: "env_1" });
        if (url.endsWith("/v1/agents")) return jsonRes({ id: "agt_1" });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { db, updates } = settingsDb(EMPTY_SETTINGS);
    const rt = createManagedRuntime({ env: ENV, settingsDb: db });
    const out = await rt.ensureProvisioned();
    expect(out).toEqual({ agentId: "agt_1", environmentId: "env_1" });
    const agentBody = calls.find((c) => c.url.endsWith("/v1/agents"))!.body as Record<string, never>;
    expect(agentBody["model"]).toBe("claude-sonnet-5");
    expect(agentBody["tools"]).toEqual([
      { type: "agent_toolset_20260401" },
      {
        type: "mcp_toolset",
        mcp_server_name: "korean-law",
        // 명시 안 하면 기본값 always_ask — MCP 도구 호출이 승인 대기로 멈춰 세션이 idle로 끝난다
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      },
    ]);
    expect(agentBody["mcp_servers"]).toEqual([
      {
        type: "url",
        name: "korean-law",
        url: `https://ex.vercel.app/api/mcp/korean-law/mcp?secret=${ENV.MCP_SHARED_SECRET}`,
      },
    ]);
    expect(updates[0]).toMatchObject({ anthropic_agent_id: "agt_1", anthropic_environment_id: "env_1" });
  });

  it("구성 해시가 같으면 API 호출 없이 캐시를 쓴다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db } = settingsDb(EMPTY_SETTINGS);
    const rt = createManagedRuntime({ env: ENV, settingsDb: db });
    const hash = rt.currentConfigHash();
    const { db: db2 } = settingsDb({
      ...EMPTY_SETTINGS,
      anthropic_environment_id: "env_9",
      anthropic_agent_id: "agt_9",
      agent_config_hash: hash,
    });
    const rt2 = createManagedRuntime({ env: ENV, settingsDb: db2 });
    const out = await rt2.ensureProvisioned();
    expect(out).toEqual({ agentId: "agt_9", environmentId: "env_9" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("세션·이벤트·파일 요청 형상", () => {
  it("createSession/sendMessage/interrupt/listEvents", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url.endsWith("/v1/environments")) return jsonRes({ id: "env_1" });
        if (url.endsWith("/v1/agents")) return jsonRes({ id: "agt_1" });
        if (url.endsWith("/v1/sessions")) return jsonRes({ id: "sesn_1" });
        if (url.includes("/events") && init?.method === "POST") return jsonRes({ ok: true });
        if (url.includes("/events"))
          return jsonRes({
            data: [
              { id: "sevt_1", type: "session.status_running" },
              {
                id: "sevt_2",
                type: "agent.message",
                processed_at: "2026-07-22T01:00:00Z",
                content: [
                  { type: "text", text: "안녕" },
                  { type: "text", text: "하세요" },
                ],
              },
              { id: "sevt_3", type: "agent.tool_use", name: "bash", input: { command: "ls" } },
              { id: "sevt_t1", type: "agent.thinking" },
              { id: "sevt_t2", type: "agent.thinking", content: [{ type: "thinking", thinking: "" }] },
              { id: "sevt_t3", type: "agent.thinking", content: [{ type: "thinking", thinking: "판례를 찾았습니다. 원문을 확인합니다." }] },
              { id: "sevt_4", type: "session.status_idle" },
            ],
          });
        throw new Error(`unexpected ${url}`);
      }),
    );
    // 프로비전 완료 상태(캐시 히트)로 세팅해 세션 POST가 첫 fetch가 되게 한다
    const probe = createManagedRuntime({ env: ENV, settingsDb: settingsDb(EMPTY_SETTINGS).db });
    const { db } = settingsDb({
      ...EMPTY_SETTINGS,
      anthropic_environment_id: "env_1",
      anthropic_agent_id: "agt_1",
      agent_config_hash: probe.currentConfigHash(),
    });
    const rt = createManagedRuntime({ env: ENV, settingsDb: db });

    const s = await rt.createSession({
      title: "t",
      mounts: [{ fileId: "file_1", mountPath: "/workspace/bundle.tar.gz" }],
    });
    expect(s.sessionId).toBe("sesn_1");
    expect(calls[0].body).toMatchObject({
      environment_id: expect.anything(),
      resources: [{ type: "file", file_id: "file_1", mount_path: "/workspace/bundle.tar.gz" }],
      title: "t",
    });

    await rt.sendMessage("sesn_1", "시작");
    expect(calls.at(-1)!.body).toEqual({ events: [{ type: "user.message", content: [{ type: "text", text: "시작" }] }] });

    await rt.interrupt("sesn_1");
    expect(calls.at(-1)!.body).toEqual({ events: [{ type: "user.interrupt" }] });

    const evs = await rt.listEvents("sesn_1");
    expect(evs).toEqual([
      { id: "sevt_1", at: null, type: "status_running" },
      { id: "sevt_2", at: "2026-07-22T01:00:00Z", type: "message", text: "안녕하세요" },
      { id: "sevt_3", at: null, type: "tool_use", name: "bash", inputSummary: '{"command":"ls"}' },
      // 내용 없는 agent.thinking(문서상 기본 형상)은 버리고, 텍스트가 실린 것만 진행 노트가 된다
      { id: "sevt_t3", at: null, type: "progress", text: "판례를 찾았습니다. 원문을 확인합니다." },
      { id: "sevt_4", at: null, type: "status_idle" },
    ]);
  });
});

describe("computeConfigHash", () => {
  it("입력이 같으면 같고 다르면 다르다", () => {
    const base = { bundleHash: "b", model: "m", mcpUrl: "u", systemPrompt: "s", toolsConfig: "t" };
    const a = computeConfigHash(base);
    expect(a).toBe(computeConfigHash({ ...base }));
    expect(a).not.toBe(computeConfigHash({ ...base, bundleHash: "b2" }));
  });

  it("도구 구성이 바뀌면 해시가 바뀐다 (권한 정책 변경 시 재프로비저닝 보장)", () => {
    const base = { bundleHash: "b", model: "m", mcpUrl: "u", systemPrompt: "s", toolsConfig: "t" };
    expect(computeConfigHash(base)).not.toBe(computeConfigHash({ ...base, toolsConfig: "t2" }));
  });
});
