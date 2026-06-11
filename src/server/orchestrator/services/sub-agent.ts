/**
 * Sub-agent spawning service (docs/144).
 *
 * The orchestrator-side authority for the `shipit agent run` primitive: a
 * pinned session's agent spawns *any* registered agent with *any* prompt and
 * gets that agent's final text back, synchronously, within the same turn. The
 * spawned agent never becomes the session's agent — it runs as a one-shot
 * subprocess (over the worker's `/agent/spawn`, or in-process in local mode),
 * returns its text, and goes away.
 *
 * This service owns every load-bearing concern except the actual adapter run:
 * the global setting gate, auth/pin/recursion/per-turn-cap checks, lazy +
 * account-correct cross-agent credential provisioning, the transient spawn
 * chip, usage attribution to the sub-agent, and the token-sync-back + wipe in a
 * `finally`. The run itself is delegated to `runner.spawnSubAgent`.
 *
 * Review is the first *consumer* of this primitive, not the primitive itself:
 * "get a second opinion from Codex on this diff" is just a review-shaped prompt
 * handed to `subAgentId: "codex"`.
 */

import { randomUUID } from "node:crypto";
import type { AgentId } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { UsageManager } from "../usage.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import {
  provisionSubAgentCredentials,
  removeSubAgentCredentials,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "../session-credentials.js";
import type { SubAgentRunResult } from "../../shared/sub-agent-run.js";
import { ServiceError } from "./types.js";

/** §5 — modest per-turn fan-out cap; the forgery-resistant bound on total spawns. */
export const SUB_AGENT_PER_TURN_CAP = 3;

export interface RunSubAgentDeps {
  sessionManager: SessionManager;
  credentialStore: CredentialStore;
  agentRegistry: AgentRegistry;
  providerAccountManager?: ProviderAccountManager;
  runnerRegistry: SessionRunnerRegistry;
  usageManager: UsageManager;
  /** Source-of-truth credentials root (`/credentials`). Omitted in local mode / tests. */
  credentialsDir?: string;
}

export interface RunSubAgentInput {
  subAgentId: AgentId;
  prompt: string;
  /**
   * The caller's recursion depth, forwarded from the shim's inherited
   * `SHIPIT_AGENT_DEPTH` (absent ⇒ 0, i.e. a primary). A non-zero depth means
   * the caller is itself a spawned sub-agent — rejected by the best-effort
   * recursion guard.
   */
  depth: number;
}

export interface RunSubAgentResult extends SubAgentRunResult {
  subAgentId: AgentId;
}

/**
 * Run a one-shot sub-agent on behalf of a pinned session's primary agent and
 * return its final assistant text. Throws {@link ServiceError} for every
 * authorization failure so the route maps it to the right HTTP status (the
 * shim turns those into a clear, non-zero `shipit agent` exit).
 */
export async function runSubAgent(
  deps: RunSubAgentDeps,
  sessionId: string,
  input: RunSubAgentInput,
): Promise<RunSubAgentResult> {
  const { subAgentId, prompt, depth } = input;

  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  // §1 — the global gate, checked on EVERY spawn (not cached at boot) so toggling
  // it off mid-session takes effect on the next attempt.
  if (!deps.credentialStore.getEnableSubAgents()) {
    throw new ServiceError(403, "Sub-agents are disabled. Enable them in Settings → Multi-agent sessions.");
  }

  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new ServiceError(400, "A prompt is required (pass it via --prompt-file -).");
  }

  // §3 — the agent must be registered and authed. Re-probe first so a just-
  // -completed sign-in is seen.
  deps.agentRegistry.refreshAuth(subAgentId);
  const info = deps.agentRegistry.get(subAgentId);
  if (!info) throw new ServiceError(400, `Unknown agent: ${subAgentId}`);
  if (!info.authConfigured) {
    throw new ServiceError(400, `${info.name} is not signed in. Connect it in Settings before spawning it.`);
  }

  // §3 — a pre-pin session has no primary identity to spawn on behalf of.
  if (!session.agentPinned) {
    throw new ServiceError(409, "This session has no pinned agent yet — send a message first.");
  }

  // §3 — best-effort recursion guard. A non-zero forwarded depth means the
  // caller is a spawned sub-agent. NOT forgery-resistant (a shell-capable
  // sub-agent can spoof depth: 0); the per-turn cap below is the real bound.
  if (depth !== 0) {
    throw new ServiceError(403, "Sub-agents cannot spawn further sub-agents.");
  }

  const runner = deps.runnerRegistry.get(sessionId);
  if (!runner) throw new ServiceError(409, "Session is not active.");

  // §5 — the forgery-resistant per-turn cap. Keyed by the worker-injected
  // SESSION_ID (this runner), so every spawn in the turn — including any a
  // sub-agent forges past the depth guard — decrements the same budget.
  if (runner.subAgentSpawnsThisTurn >= SUB_AGENT_PER_TURN_CAP) {
    throw new ServiceError(429, `Sub-agent spawn cap reached for this turn (max ${SUB_AGENT_PER_TURN_CAP}).`);
  }
  runner.subAgentSpawnsThisTurn += 1;

  // §4 — resolve the sub-agent's provider-account route exactly as the primary
  // turn path does, so a multi-account user provisions from the freshest account
  // root rather than the stale flat root.
  const route = deps.providerAccountManager?.selectRouteForTurn(subAgentId) ?? null;
  const accountId = route?.kind === "account" ? route.id : undefined;

  // A same-provider spawn reuses the pinned agent's already-present credentials
  // and provisions nothing. A cross-provider spawn provisions the other agent's
  // subtree — only on a container runner (local mode is a no-op, docs/138).
  const crossProvider = subAgentId !== session.agentId;
  const isContainer = runner instanceof ContainerSessionRunner;
  const provisioned = crossProvider && isContainer && !!deps.credentialsDir;
  const credentialsDir = deps.credentialsDir;

  if (provisioned && credentialsDir) {
    provisionSubAgentCredentials(credentialsDir, sessionId, subAgentId, accountId);
  }

  const spawnId = randomUUID();
  // §7 — transient spawn chip (status only): "Asking Codex…" while in flight.
  runner.emitMessage({ type: "sub_agent_spawn", spawnId, subAgentId, phase: "running" });

  try {
    const result = await runner.spawnSubAgent({ agentId: subAgentId, prompt, spawnId, depth });

    // §5 — attribute the sub-agent's cost to subAgentId, not the pinned agentId.
    if (result.costUsd > 0 || result.durationMs > 0) {
      deps.usageManager.record(sessionId, result.costUsd, result.durationMs, undefined, undefined, { subAgentId });
    }

    // §7 — replace the chip with the terminal "Consulted Codex · 47s · $0.03".
    runner.emitMessage({
      type: "sub_agent_spawn",
      spawnId,
      subAgentId,
      phase: "done",
      status: result.status,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      truncated: result.truncated,
    });

    return { ...result, subAgentId };
  } finally {
    // §4 — token-sync-back THEN wipe, both targeting the same resolved account
    // root. Runs on success, failure, crash, or cancel. Skipped for a
    // same-provider spawn (no window opened) and in local mode.
    if (provisioned && credentialsDir) {
      try {
        if (accountId) syncProviderAccountTokenBack(credentialsDir, sessionId, subAgentId, accountId);
        else syncAgentTokenBack(credentialsDir, sessionId, subAgentId);
      } catch {
        // Best-effort: a failed sync-back at worst makes the next provision
        // start from a slightly older token, which heals on its own refresh.
      }
      removeSubAgentCredentials(credentialsDir, sessionId, subAgentId);
    }
  }
}

/**
 * §4 — sign-out sweep. When the user signs out of `agentId`, drop any in-flight
 * cross-agent credential subtree provisioned for a spawn from sessions where
 * `agentId` is NOT the pinned agent, so a sub-agent's creds never outlive the
 * user's authorization. Wired to {@link AgentRegistry}'s `sign-out` event.
 */
export function sweepSubAgentCredentialsOnSignOut(
  agentId: AgentId,
  deps: { sessionManager: SessionManager; credentialsDir?: string },
): void {
  if (!deps.credentialsDir) return;
  for (const session of deps.sessionManager.list()) {
    if (session.agentId === agentId) continue; // it's the pinned agent here — leave it
    removeSubAgentCredentials(deps.credentialsDir, session.id, agentId);
  }
}
