/**
 * Frozen wire-contract guard for the orchestrator ↔ session-worker boundary
 * (docs/113, slimmed from its §4).
 *
 * Since docs/113 Phase 1, `deploy.sh` no longer kills session containers on
 * update: a worker built from an OLDER image keeps running under a NEWER
 * orchestrator until it idles out (lazy rotation). There is deliberately no
 * runtime version handshake yet — the compatibility guarantee is the
 * ADDITIVE-ONLY convention on the wire contract, and this file is the tripwire
 * that turns breaking it into an explicit, reviewed decision instead of an
 * accident nobody notices until a grandfathered session misbehaves.
 *
 * The `Frozen*` types below are a copy of the contract as it stood when the
 * freeze was taken. The assignability assertions are COMPILE-TIME checks —
 * they bite in `npm run typecheck`, which CI runs on every PR (the vitest run
 * itself transpiles without typechecking, so the `it()` bodies are just
 * runtime smoke on top). Directionality matters:
 *
 * - Worker → orchestrator RESPONSES (`WorkerAgentStatus`): a value produced by
 *   an old worker must still satisfy the current type ⇒ assert
 *   Frozen-assignable-to-Current. Adding an optional field is fine; adding a
 *   REQUIRED field or retyping an existing one goes red.
 * - Orchestrator → worker REQUESTS (`WorkerAgentStartBody` / `AgentRunParams`):
 *   what the current orchestrator sends must still satisfy what an old worker
 *   requires ⇒ assert Current-assignable-to-Frozen. Adding an optional request
 *   field is fine (old workers ignore unknown JSON keys); removing or retyping
 *   a field an old worker requires goes red.
 *
 * Frozen field types are deliberately LOOSE where exactness would only make
 * noise: request-side unions are frozen as `string` (widening `AgentId` or
 * `PermissionMode` should not trip the guard), and `mcpServers` elements as
 * `object` (their resolution is worker-internal). The guard aims at the
 * accident class — dropped/renamed/retyped fields — not at exhaustive schema
 * pinning.
 *
 * When this file goes red, you are changing the wire contract non-additively.
 * In order of preference:
 * 1. Make the change additive (new OPTIONAL field, new endpoint) and extend
 *    the frozen copy to match.
 * 2. If it must be breaking, FIRST build the runtime version handshake
 *    (docs/113 §4: worker `GET /version`, adoption-time check, per-session
 *    "restart container" banner) so grandfathered workers are refused loudly
 *    instead of driven wrongly — then re-freeze.
 *
 * Not machine-checked here (equally breaking — treat them the same way):
 * renaming/removing worker routes (`/agent/*`, `/terminal/*`, `/files/*`,
 * `/secrets`, `/install`, `/events`) and renaming/removing SSE event types —
 * the SSE envelope is stringly-typed, so those changes are loud, grep-visible
 * edits rather than type edits.
 */

import { describe, it, expect } from "vitest";
import type { WorkerAgentStartBody, WorkerAgentStatus } from "./agent-types.js";

// ---------------------------------------------------------------------------
// Frozen copies (contract as of docs/113 Phase 1, 2026-07)
// ---------------------------------------------------------------------------

/** `GET /agent/status` response as an old worker produces it. */
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

/** `AgentRunParams` as an old worker requires it (request direction — loose). */
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

/** `POST /agent/start` body as an old worker's handler destructures it. */
interface FrozenWorkerAgentStartBody {
  agentId: string;
  params: FrozenAgentRunParams;
  runToken?: string;
  deliveryId?: string;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

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
    // Compile-time contract: Frozen must stay assignable to Current. If either
    // line errors, the current orchestrator can no longer parse what a
    // grandfathered worker sends — see the header for what to do.
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
    // Compile-time contract: Current must stay assignable to Frozen. If this
    // line errors, the orchestrator dropped or retyped a request field an old
    // worker requires — see the header for what to do.
    const asOldWorkerSeesIt: FrozenWorkerAgentStartBody = currentBody;
    expect(asOldWorkerSeesIt.params.prompt).toBe("hello");
    expect(asOldWorkerSeesIt.params.cwd).toBe("/workspace");
  });
});
