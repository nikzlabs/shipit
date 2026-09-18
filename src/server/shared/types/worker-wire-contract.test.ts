// Older workers survive updates. Keep the wire contract additive until version negotiation exists.
// These assignments require typecheck; Vitest alone does not enforce them.
// Route names and SSE event types need separate review: these types cannot guard them.
import { describe, it, expect } from "vitest";
import type { WorkerAgentStartBody, WorkerAgentStatus } from "./agent-types.js";

// Frozen July 2026 contract; do not update it just to silence a breaking change.
interface FrozenWorkerAgentStatus {
  running: boolean;
  latestSseSeq: number;
  oldestSseSeq?: number;
  turnActive?: boolean;
  turnStartSseSeq?: number;
  runToken?: string;
  deliveryId?: string;
  agentId?: "claude" | "codex";
  streaming?: boolean;
}

interface FrozenAgentRunParams {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: { data: string; mediaType: string; filename?: string }[];
  cwd: string;
  permissionMode?: string;
  mcpConfigPath?: string;
  mcpServers?: object[];
  model?: string;
  reasoningEffort?: string;
  settingsPath?: string;
  autoCreatePr?: boolean;
  sandbox?: boolean;
  guardDestructiveGit?: boolean;
  useStreaming?: boolean;
  compact?: boolean;
}

interface FrozenWorkerAgentStartBody {
  agentId: string;
  params: FrozenAgentRunParams;
  runToken?: string;
  deliveryId?: string;
}

describe("worker wire contract (additive-only guard)", () => {
  it("an old worker's /agent/status response still satisfies the current WorkerAgentStatus", () => {
    const minimal: FrozenWorkerAgentStatus = { running: false, latestSseSeq: 0 };
    const maximal: FrozenWorkerAgentStatus = {
      running: true,
      latestSseSeq: 42,
      oldestSseSeq: 1,
      turnActive: true,
      turnStartSseSeq: 7,
      runToken: "tok",
      deliveryId: "d1",
      agentId: "claude",
      streaming: true,
    };
    const asCurrentMinimal: WorkerAgentStatus = minimal;
    const asCurrentMaximal: WorkerAgentStatus = maximal;
    expect(asCurrentMinimal.running).toBe(false);
    expect(asCurrentMaximal.turnActive).toBe(true);
  });

  it("the current /agent/start body still satisfies what an old worker requires", () => {
    const currentBody: WorkerAgentStartBody = {
      agentId: "claude",
      params: { prompt: "hello", cwd: "/workspace" },
      runToken: "tok",
      deliveryId: "d1",
    };
    const asOldWorkerSeesIt: FrozenWorkerAgentStartBody = currentBody;
    expect(asOldWorkerSeesIt.params.prompt).toBe("hello");
    expect(asOldWorkerSeesIt.params.cwd).toBe("/workspace");
  });
});
