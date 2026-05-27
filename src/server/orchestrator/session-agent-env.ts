/**
 * Session agent environment preparation (docs/149).
 *
 * Two free functions that own everything required for an agent inside a
 * session container to talk to its upstream dependencies — Anthropic OAuth,
 * MCP servers, the compose secrets pipeline. The functions are session-scoped,
 * idempotent, and orthogonal to whether a turn is about to start; the caller
 * invokes them before/after agent runs to keep the user-spawn path
 * (`runAgentWithMessage`) and the system-turn path (`runDispatchedTurn` — used by
 * `spawnChildSession`, `sendChildMessage`, `triggerCIFix`) at parity. Without
 * this, agent-spawned sessions launch with a stale OAuth token (the rotating
 * refresh token is single-use, so any other session refreshing it leaves the
 * write-once copy dead), missing MCP env, and no compose-secret push.
 *
 * Deliberately kept out of any turn-execution module so it cannot drift back
 * into a per-turn responsibility — credentials and secrets are about the
 * container's connection to its dependencies, not about the prompt the agent
 * is about to run.
 */

import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { CredentialStore } from "./credential-store.js";
import type { ServiceManager } from "./service-manager.js";
import type { AgentId } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  provisionAgentCredentials,
  provisionProviderAccountCredentials,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
} from "./session-credentials.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import { refreshExpiredMcpOAuthTokens } from "./services/mcp-oauth.js";
import { collectMcpAgentEnv } from "./secret-resolver.js";
import { getErrorMessage } from "./validation.js";

export interface SessionAgentEnvDeps {
  /** Source-of-truth credentials root (e.g. `/credentials`). */
  credentialsDir: string;
  credentialStore: CredentialStore;
  sessionManager: SessionManager;
  providerAccountManager?: ProviderAccountManager;
}

/**
 * Compute the full agent-env map that should be pushed to the worker's
 * `process.env` ahead of `/agent/start` (docs/088).
 *
 * Two regimes, distinguished by whether the runner has a `ServiceManager`:
 *
 *   * Compose-less session (`serviceManager` is `null`) — pull directly from
 *     `CredentialStore`. The account-level set covers `mcp__*` secrets,
 *     `MCP_PLATFORM_*` OAuth tokens, and `OPENAI_API_KEY`-style top-level
 *     keys. `collectMcpAgentEnv` returns both `mcp__*` and `MCP_PLATFORM_*`
 *     entries; the `mcp__*` ones overlap with `getAllAgentEnv()` but the
 *     values are identical, so spread order doesn't matter.
 *
 *   * Compose session — return the snapshot's `agentValues` map. The snapshot
 *     is the merged set (compose-declared + MCP) produced inside the most
 *     recent `ServiceManager.syncSecrets()` pass. The worker REPLACES its
 *     tracked set on every `PUT /secrets` call, so we MUST carry the *full*
 *     merged set here — pushing just the account-level subset would clobber
 *     the compose-declared `agent: true` secrets.
 */
export function selectAgentEnvForPush(input: {
  serviceManager: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  credentialStore: Pick<CredentialStore, "getAllAgentEnv" | "getAllMcpOAuthTokens">;
}): Record<string, string> {
  if (input.serviceManager) {
    return input.serviceManager.getSecretsSnapshot().agentValues;
  }
  return {
    ...input.credentialStore.getAllAgentEnv(),
    ...collectMcpAgentEnv(input.credentialStore),
  };
}

/**
 * Provision per-session credentials (write-once), pull in the freshest OAuth
 * token from the orchestrator source, refresh any near-expired MCP OAuth
 * tokens, and push the merged agent-env to the session worker. Idempotent
 * and fault-tolerant — failures are logged but never thrown, since env prep
 * must not block a turn.
 *
 * Safe (and intended) to call unconditionally before every agent start.
 *
 * docs/149 — the four steps mirror the previously-inline blocks at the bottom
 * of `runAgentWithMessage`, factored out so the system-turn / agent-spawned-
 * session paths get them too.
 */
export async function prepareSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: { sessionId: string; agentId: AgentId; deps: SessionAgentEnvDeps },
): Promise<void> {
  const { sessionId, agentId, deps } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session) return;
  const selectedRoute =
    session.providerRouteKind && session.providerRouteId
      ? { kind: session.providerRouteKind, id: session.providerRouteId }
      : deps.providerAccountManager?.selectRouteForTurn(agentId);

  // Step 1: provision the pinned agent's credential subtree (write-once),
  // then mark the session as pinned. After the first turn `session.agentPinned`
  // is true, so subsequent calls skip both the copy and the mark.
  if (!session.agentPinned) {
    if (runner instanceof ContainerSessionRunner) {
      try {
        if (selectedRoute?.kind === "account") {
          provisionProviderAccountCredentials(deps.credentialsDir, sessionId, agentId, selectedRoute.id);
        } else {
          provisionAgentCredentials(deps.credentialsDir, sessionId, agentId);
        }
      } catch (err) {
        console.warn("[credentials] provisioning failed:", getErrorMessage(err));
      }
    }
    deps.sessionManager.setAgentId(sessionId, agentId);
    if (selectedRoute) deps.sessionManager.setProviderRoute(sessionId, selectedRoute.kind, selectedRoute.id);
    deps.sessionManager.setAgentPinned(sessionId);
  }

  // Step 2: pull the freshest source token into the session subtree. Runs
  // every turn (docs/142 A) — the rotating refresh token is single-use, so
  // a write-once provisioning copy goes stale the moment any other session
  // rotates the source.
  if (runner instanceof ContainerSessionRunner) {
    try {
      // docs/153 — if the per-turn sync repairs a leaked symlink, recover
      // the Claude CLI's `sessionId` from the orphan jsonl tree so the next
      // turn's `--resume <id>` finds the existing conversation file instead
      // of treating it as a missing session. Without this, the agent emits
      // a fresh init UUID, we persist that, and the next retry fails again
      // because the conversation history lives under the old id — the
      // "no conversation found" loop. See docs/153.
      const onRecover = (recovered: string): void => {
        const current = deps.sessionManager.get(sessionId)?.agentSessionId;
        if (current === recovered) return;
        const wasNote = current ? ` (was ${current})` : "";
        console.log(`[credentials] recovered agent_session_id for ${sessionId}: ${recovered}${wasNote}`);
        deps.sessionManager.setAgentSessionId(sessionId, recovered);
      };
      if (selectedRoute?.kind === "account") {
        syncProviderAccountTokenIn(deps.credentialsDir, sessionId, agentId, selectedRoute.id, onRecover);
      } else if (selectedRoute?.id !== "claude-env-oauth") {
        syncAgentTokenIn(deps.credentialsDir, sessionId, agentId, onRecover);
      }
    } catch (err) {
      console.warn("[credentials] token sync-in failed:", getErrorMessage(err));
    }
  }

  // Step 3: pre-emptively refresh any MCP OAuth tokens within the safety
  // margin of expiry, so the env we're about to push doesn't carry a token
  // that's about to die on the first MCP call. Fault-tolerant.
  await refreshExpiredMcpOAuthTokens({ credentialStore: deps.credentialStore }).catch(
    (err: unknown) => {
      console.warn("[mcp-oauth] background refresh failed:", getErrorMessage(err));
    },
  );

  // Step 4: push the merged agent-env to the worker's `process.env` ahead
  // of `/agent/start`. Compose vs. compose-less selection in `selectAgentEnvForPush`.
  if (runner instanceof ContainerSessionRunner) {
    await runner.tryPushAgentSecrets(
      selectAgentEnvForPush({
        serviceManager: runner.serviceManager,
        credentialStore: deps.credentialStore,
      }),
    );
  }
}

/**
 * Write the session's (possibly CLI-refreshed) OAuth token back to the
 * orchestrator source if it advanced. Mirror of `syncAgentTokenIn` — without
 * this, a rotating refresh token landed via the CLI's in-place rewrite is
 * stranded in this session's subtree and the source slowly dies.
 *
 * Safe to call after every turn; no-op outside container mode or when
 * nothing rotated. Fault-tolerant.
 */
export function finalizeSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: { sessionId: string; agentId: AgentId; deps: SessionAgentEnvDeps },
): void {
  if (!(runner instanceof ContainerSessionRunner)) return;
  const session = args.deps.sessionManager.get(args.sessionId);
  try {
    if (session?.providerRouteKind === "account" && session.providerRouteId) {
      syncProviderAccountTokenBack(
        args.deps.credentialsDir,
        args.sessionId,
        args.agentId,
        session.providerRouteId,
      );
    } else if (session?.providerRouteId !== "claude-env-oauth") {
      syncAgentTokenBack(args.deps.credentialsDir, args.sessionId, args.agentId);
    }
  } catch (err) {
    console.warn("[credentials] token sync-back failed:", getErrorMessage(err));
  }
}
