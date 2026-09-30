import { createHash } from "node:crypto";
import type { AgentRuntime, Mount, RuntimeEvent } from "@/lib/agent/adapter";
import {
  anthropicDownload,
  anthropicHeaders,
  anthropicJson,
  anthropicUpload,
  parseSseStream,
} from "@/lib/agent/anthropic-http";
import { SYSTEM_PROMPT } from "@/lib/agent/prompts";
import { loadBundle } from "@/lib/agent/bundle";
import { mcpServerUrl } from "@/lib/mcp/server-url";
import { getAppSettings, saveProvision, type SettingsDb } from "@/lib/db/settings";

type RuntimeEnv = {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_AGENT_MODEL: string;
  APP_PUBLIC_URL: string;
  MCP_SHARED_SECRET: string;
};

/**
 * 에이전트 도구 구성. mcp_toolset은 permission_policy를 명시적으로 always_allow로 둔다 —
 * 생략 시 기본값 always_ask라서 MCP 도구 호출이 승인 대기로 멈추고 세션이 결과 없이
 * idle로 끝난다(리서치 단계 연쇄 실패의 원인).
 */
const AGENT_TOOLS = [
  { type: "agent_toolset_20260401" },
  {
    type: "mcp_toolset",
    mcp_server_name: "korean-law",
    default_config: { enabled: true, permission_policy: { type: "always_allow" } },
  },
];

export function computeConfigHash(i: {
  bundleHash: string;
  model: string;
  mcpUrl: string;
  systemPrompt: string;
  toolsConfig: string;
}): string {
  return createHash("sha256")
    .update([i.bundleHash, i.model, i.mcpUrl, i.systemPrompt, i.toolsConfig].join("\0"))
    .digest("hex");
}

type RawEvent = {
  id: string;
  type: string;
  processed_at?: string;
  content?: { type: string; text?: string; thinking?: string }[];
  name?: string;
  input?: unknown;
  message?: string;
};

function toRuntimeEvent(raw: RawEvent): RuntimeEvent | null {
  const at = raw.processed_at ?? null;
  switch (raw.type) {
    case "session.status_running":
      return { id: raw.id, at, type: "status_running" };
    case "session.status_idle":
      return { id: raw.id, at, type: "status_idle" };
    case "session.error":
      return { id: raw.id, at, type: "error", message: raw.message ?? JSON.stringify(raw).slice(0, 300) };
    case "agent.message": {
      const text = (raw.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      return { id: raw.id, at, type: "message", text };
    }
    case "agent.thinking": {
      // Sonnet 5.5·Opus 5.5·Fable 5.1은 도구 호출 사이의 서술을 text가 아닌 thinking 블록으로 낸다.
      // Managed Agents 문서상 agent.thinking은 내용 없는 진행 신호이고 에이전트 구성에 thinking.display
      // 설정도 없다 — 그래서 요청 쪽 플래그는 두지 않고, 내용이 실려 오는 경우에만 진행 노트로 표시한다.
      const text = (raw.content ?? [])
        .map((c) => (c.type === "thinking" ? c.thinking : c.type === "text" ? c.text : undefined) ?? "")
        .join("")
        .trim();
      return text ? { id: raw.id, at, type: "progress", text } : null;
    }
    case "agent.tool_use":
      return {
        id: raw.id,
        at,
        type: "tool_use",
        name: raw.name ?? "?",
        inputSummary: JSON.stringify(raw.input ?? {}).slice(0, 300),
      };
    default:
      return null; // 미지의 이벤트는 무시 (베타 — 형상 추가에 관대하게)
  }
}

export function createManagedRuntime(deps: { env: RuntimeEnv; settingsDb: SettingsDb }) {
  const { env, settingsDb } = deps;
  const key = env.ANTHROPIC_API_KEY;
  const mcpUrl = mcpServerUrl(env);
  const configHash = computeConfigHash({
    bundleHash: loadBundle().hash,
    model: env.ANTHROPIC_AGENT_MODEL,
    mcpUrl,
    systemPrompt: SYSTEM_PROMPT,
    toolsConfig: JSON.stringify(AGENT_TOOLS),
  });
  let cached: { agentId: string; environmentId: string } | null = null;

  async function ensureProvisioned(): Promise<{ agentId: string; environmentId: string }> {
    if (cached) return cached;
    const s = await getAppSettings(settingsDb);
    if (s.agent_config_hash === configHash && s.anthropic_agent_id && s.anthropic_environment_id) {
      cached = { agentId: s.anthropic_agent_id, environmentId: s.anthropic_environment_id };
      return cached;
    }
    // 환경은 재사용, 에이전트는 구성 변경 시 새로 생성 (베타: update 대신 create가 단순·안전)
    const environmentId =
      s.anthropic_environment_id ??
      (
        await anthropicJson<{ id: string }>(key, "POST", "/v1/environments", {
          name: "litigation-writer",
          config: { type: "cloud", networking: { type: "unrestricted" } },
        })
      ).id;
    const agent = await anthropicJson<{ id: string }>(key, "POST", "/v1/agents", {
      name: "litigation-writer",
      model: env.ANTHROPIC_AGENT_MODEL,
      system: SYSTEM_PROMPT,
      tools: AGENT_TOOLS,
      mcp_servers: [{ type: "url", name: "korean-law", url: mcpUrl }],
    });
    await saveProvision(settingsDb, { environmentId, agentId: agent.id, configHash });
    cached = { agentId: agent.id, environmentId };
    return cached;
  }

  const runtime: AgentRuntime & { currentConfigHash(): string } = {
    currentConfigHash: () => configHash,
    ensureProvisioned,

    async uploadFile(filename, content) {
      const { id } = await anthropicUpload(key, filename, content);
      return { fileId: id };
    },

    async createSession({ title, mounts }: { title: string; mounts: Mount[] }) {
      const p = cached ?? (await ensureProvisioned());
      const res = await anthropicJson<{ id: string }>(key, "POST", "/v1/sessions", {
        agent: p.agentId,
        environment_id: p.environmentId,
        resources: mounts.map((m) => ({ type: "file", file_id: m.fileId, mount_path: m.mountPath })),
        title,
      });
      return { sessionId: res.id };
    },

    async sendMessage(sessionId, text) {
      await anthropicJson(key, "POST", `/v1/sessions/${sessionId}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    },

    async interrupt(sessionId) {
      await anthropicJson(key, "POST", `/v1/sessions/${sessionId}/events`, {
        events: [{ type: "user.interrupt" }],
      });
    },

    async listEvents(sessionId) {
      const res = await anthropicJson<{ data: RawEvent[] }>(key, "GET", `/v1/sessions/${sessionId}/events`);
      return (res.data ?? []).map(toRuntimeEvent).filter((e): e is RuntimeEvent => e !== null);
    },

    async *streamEvents(sessionId, signal) {
      const res = await fetch(`https://api.anthropic.com/v1/sessions/${sessionId}/events/stream`, {
        headers: { ...anthropicHeaders(key), accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`이벤트 스트림 연결 실패 ${res.status}`);
      for await (const { data } of parseSseStream(res.body)) {
        let raw: RawEvent;
        try {
          raw = JSON.parse(data) as RawEvent;
        } catch {
          continue;
        }
        const ev = toRuntimeEvent(raw);
        if (ev) yield ev;
      }
    },

    async listSessionFiles(sessionId) {
      const res = await anthropicJson<{ data: { id: string; filename: string }[] }>(
        key,
        "GET",
        `/v1/files?scope_id=${sessionId}`,
      );
      return (res.data ?? []).map((f) => ({ fileId: f.id, filename: f.filename }));
    },

    async downloadFile(fileId) {
      return anthropicDownload(key, fileId);
    },
  };
  return runtime;
}
