export type RuntimeEvent =
  | { id: string; at: string | null; type: "status_running" }
  | { id: string; at: string | null; type: "status_idle" }
  | { id: string; at: string | null; type: "message"; text: string }
  /** 도구 호출 사이의 진행 노트(thinking 블록으로 오는 서술). run-complete·checkpoint 판독 대상이 아니다. */
  | { id: string; at: string | null; type: "progress"; text: string }
  | { id: string; at: string | null; type: "tool_use"; name: string; inputSummary: string }
  | { id: string; at: string | null; type: "error"; message: string };

export type Mount = { fileId: string; mountPath: string };

export interface AgentRuntime {
  /** 환경·에이전트 정의를 보장하고 agentId를 반환 (구성 해시 불변이면 캐시 재사용) */
  ensureProvisioned(): Promise<{ agentId: string; environmentId: string }>;
  uploadFile(filename: string, content: Uint8Array): Promise<{ fileId: string }>;
  createSession(opts: { title: string; mounts: Mount[] }): Promise<{ sessionId: string }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  listEvents(sessionId: string): Promise<RuntimeEvent[]>;
  streamEvents(sessionId: string, signal?: AbortSignal): AsyncGenerator<RuntimeEvent>;
  /** 세션이 산출한 파일 목록 (Files API scope) */
  listSessionFiles(sessionId: string): Promise<{ fileId: string; filename: string }[]>;
  downloadFile(fileId: string): Promise<Uint8Array>;
}
