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

/**
 * Hard ceilings for the two network/worker awaits in the pre-spawn env-prep
 * path. The whole point of this module is that env prep MUST NOT block a turn
 * (see the file docstring) — but an un-timed awaited network call violates
 * that contract: a hung MCP-OAuth token endpoint or a wedged worker socket
 * would stall `executeAgentTurn` forever, BEFORE `agent.run()` ever fires, so
 * the worker never receives `/agent/start` and the turn silently stalls. This
 * was the warm-pool quick-session hang (docs/162 follow-up): the install gate
 * resolved, but step 3's network OAuth refresh never settled.
 *
 * These bounds FAIL OPEN — on timeout we log and continue to the spawn. A
 * stale MCP token at worst makes the first MCP call fail (the worker surfaces
 * a `mcp_server_status` failure); a skipped secrets push is retried by the
 * next compose reconcile. Both are strictly better than a dead turn.
 */
export const MCP_OAUTH_REFRESH_TIMEOUT_MS = 8_000;
export const PUSH_AGENT_SECRETS_TIMEOUT_MS = 12_000;

/**
 * docs/179 — ceiling for the pre-spawn OAuth source-token heal. Only does real
 * work when the source token is within the refresh safety margin (a degraded
 * window the scheduled refresher normally prevents), so it's near-free on the
 * healthy hot path. Bounded so a hung token endpoint can't stall the turn, and
 * fails open: a Tier-1 (`claude auth status`) refresh usually settles well
 * inside this, and if a slow Tier-2 fallback exceeds it the background refresh
 * keeps running (single-flight) and the runtime-401 auto-retry awaits the same
 * in-flight refresh, so the worst case is one quiet retry, not a dead turn.
 */
export const ENSURE_TOKEN_FRESH_TIMEOUT_MS = 30_000;

/**
 * Race a promise against a timeout that FAILS OPEN: on timeout (or rejection)
 * we log and resolve instead of throwing, so a hung dependency can never
 * block the caller. Logs elapsed time on success too, so a slow-but-eventual
 * settle is visible in the logs without being fatal.
 */
const TIMEOUT = Symbol("env-prep-timeout");

async function withFailOpenTimeout(
  label: string,
  start: () => Promise<unknown>,
  ms: number,
): Promise<void> {
  const began = Date.now();
  let timer: NodeJS.Timeout | undefined;
  // The work arm catches its own rejection so the race never rejects — the
  // whole helper resolves on either the work settling or the timeout firing.
  const work = (async (): Promise<unknown> => {
    try {
      await start();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(getErrorMessage(err));
    }
  })();
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    const result = await Promise.race([work, timeout]);
    if (result === TIMEOUT) {
      console.warn(`[env-prep] ${label} timed out after ${ms}ms — continuing without it (fail-open)`);
    } else if (result instanceof Error) {
      console.warn(`[env-prep] ${label} failed after ${Date.now() - began}ms:`, getErrorMessage(result));
    } else {
      console.log(`[env-prep] ${label} completed in ${Date.now() - began}ms`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SessionAgentEnvDeps {
  /** Source-of-truth credentials root (e.g. `/credentials`). */
  credentialsDir: string;
  credentialStore: CredentialStore;
  sessionManager: SessionManager;
  providerAccountManager?: ProviderAccountManager;
  /**
   * docs/179 — proactively heal the agent's OAuth source token if it's within
   * the refresh safety margin, BEFORE it's copied into the session. A no-op for
   * a healthy token. Optional — tests / local runtime omit it (token freshness
   * is the orchestrator's job only in containerized mode). Resolves `true` when
   * the token is usable after the call.
   */
  ensureAgentTokenFresh?: (agentId: AgentId, accountId?: string) => Promise<boolean>;
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
export interface PrepareSessionAgentEnvironmentResult {
  /**
   * docs/153 — the per-turn leak repair's terminal state regarding the
   * Claude CLI session id. Tri-state:
   *
   *   - `undefined` (omitted): no leak repair fired; caller uses the
   *     captured-at-turn-start `agentSessionId` unchanged.
   *   - `string`: leak repair recovered a resumable conversation jsonl;
   *     caller MUST override the captured `agentSessionId` with this
   *     value before spawning so `--resume <recovered>` finds it. DB
   *     row has already been updated as a side effect.
   *   - `null`: leak repair fired but found no resumable conversation;
   *     caller MUST drop the `--resume` arg entirely so the CLI starts
   *     a fresh conversation instead of `--resume <known-bad-id>`-looping.
   *     DB row has already been cleared as a side effect.
   *
   * On a healthy turn this field is `undefined`; on a recovery turn it's
   * either the recovered id or null. The caller's spawn-arg branching
   * must distinguish the null-clear case from the undefined-no-action
   * case — they look the same at the destructured site but mean opposite
   * things for `--resume`.
   */
  overrideAgentSessionId?: string | null;
}

export async function prepareSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: { sessionId: string; agentId: AgentId; deps: SessionAgentEnvDeps },
): Promise<PrepareSessionAgentEnvironmentResult> {
  const { sessionId, agentId, deps } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session) return {};
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

  // Step 2a (docs/179): heal the source OAuth token if it's within the refresh
  // safety margin BEFORE Step 2 copies it into the session. The scheduled
  // refresher normally keeps the source fresh, but if a tick has fallen behind
  // its margin (a run of 429 backoffs ate the lead time), a session starting in
  // that window would otherwise sync in a dying token and 401 on its first CLI
  // call — the "new session 401 once a day" report. `ensureAgentTokenFresh` is
  // a no-op for a healthy token, so this is near-free on the hot path. Time-
  // bounded + fail-open like steps 3/4: if a slow refresh can't finish in time
  // we proceed, and the runtime-401 auto-retry awaits the same in-flight
  // refresh. Skipped for the env-provided OAuth route (not refresher-managed).
  if (
    runner instanceof ContainerSessionRunner &&
    deps.ensureAgentTokenFresh &&
    selectedRoute?.id !== "claude-env-oauth"
  ) {
    const accountId = selectedRoute?.kind === "account" ? selectedRoute.id : undefined;
    const ensureFresh = deps.ensureAgentTokenFresh;
    await withFailOpenTimeout(
      "token-fresh",
      () => ensureFresh(agentId, accountId),
      ENSURE_TOKEN_FRESH_TIMEOUT_MS,
    );
  }

  // Step 2: pull the freshest source token into the session subtree. Runs
  // every turn (docs/142 A) — the rotating refresh token is single-use, so
  // a write-once provisioning copy goes stale the moment any other session
  // rotates the source.
  let overrideAgentSessionId: string | null | undefined;
  if (runner instanceof ContainerSessionRunner) {
    try {
      // docs/153 — if the per-turn sync repairs a leaked symlink, recover
      // the Claude CLI's `sessionId` from the orphan jsonl tree so the next
      // turn's `--resume <id>` finds the existing conversation file instead
      // of treating it as a missing session. Without this, the agent emits
      // a fresh init UUID, we persist that, and the next retry fails again
      // because the conversation history lives under the old id — the
      // "no conversation found" loop. See docs/153.
      //
      // Stash the recovered id so the caller can override the
      // captured-at-turn-start `agentSessionId` before spawning the CLI.
      // The DB-row update below is also needed (the listener's agent_result
      // path reads from the DB), but the spawn-arg has already been captured
      // by the time prepareSessionAgentEnvironment runs — caller MUST honor
      // the returned override.
      const onRecover = (recoveredOrClear: string | null): void => {
        const current = deps.sessionManager.get(sessionId)?.agentSessionId;
        if (recoveredOrClear === null) {
          // docs/153 — the leak repair fired but couldn't find a resumable
          // conversation jsonl on disk. Clear the DB pointer and signal
          // the caller to drop the `--resume` arg so the CLI starts a
          // fresh conversation instead of `--resume`-looping on a
          // known-bad id.
          overrideAgentSessionId = null;
          if (current) {
            console.log(`[credentials] clearing agent_session_id for ${sessionId} (was ${current}; no resumable jsonl found)`);
            deps.sessionManager.clearAgentSessionId(sessionId);
          }
          return;
        }
        overrideAgentSessionId = recoveredOrClear;
        if (current === recoveredOrClear) return;
        const wasNote = current ? ` (was ${current})` : "";
        console.log(`[credentials] recovered agent_session_id for ${sessionId}: ${recoveredOrClear}${wasNote}`);
        deps.sessionManager.setAgentSessionId(sessionId, recoveredOrClear);
      };
      // docs/153 Case 4 — pass the DB's current agent_session_id so the
      // repair can detect a stale pointer (DB id has no matching jsonl on
      // disk, but a different one is the latest) and recover by reading
      // the existing `<sessionDir>/.claude/projects/` tree.
      const currentAgentSessionId = session.agentSessionId ?? null;
      if (selectedRoute?.kind === "account") {
        syncProviderAccountTokenIn(
          deps.credentialsDir, sessionId, agentId, selectedRoute.id,
          onRecover, currentAgentSessionId,
        );
      } else if (selectedRoute?.id !== "claude-env-oauth") {
        syncAgentTokenIn(deps.credentialsDir, sessionId, agentId, onRecover, currentAgentSessionId);
      }
    } catch (err) {
      console.warn("[credentials] token sync-in failed:", getErrorMessage(err));
    }
  }

  // Step 3: pre-emptively refresh any MCP OAuth tokens within the safety
  // margin of expiry, so the env we're about to push doesn't carry a token
  // that's about to die on the first MCP call. Fault-tolerant AND time-bounded
  // — this is a NETWORK call to the provider's token endpoint; an un-timed
  // await here was the warm-pool turn hang. Fails open: a stale token at worst
  // fails the first MCP call, which is far better than a dead turn.
  await withFailOpenTimeout(
    "mcp-oauth-refresh",
    () => refreshExpiredMcpOAuthTokens({ credentialStore: deps.credentialStore }),
    MCP_OAUTH_REFRESH_TIMEOUT_MS,
  );

  // Step 4: push the merged agent-env to the worker's `process.env` ahead
  // of `/agent/start`. Compose vs. compose-less selection in `selectAgentEnvForPush`.
  // Time-bounded too: `tryPushAgentSecrets` awaits `_workerReady` (which can
  // hang if the worker never comes up) before its own 10s-bounded POST, so we
  // cap the whole step and fail open — the next compose reconcile retries.
  if (runner instanceof ContainerSessionRunner) {
    const containerRunner = runner;
    await withFailOpenTimeout(
      "push-agent-secrets",
      () =>
        containerRunner.tryPushAgentSecrets(
          selectAgentEnvForPush({
            serviceManager: containerRunner.serviceManager,
            credentialStore: deps.credentialStore,
          }),
        ),
      PUSH_AGENT_SECRETS_TIMEOUT_MS,
    );
  }

  return overrideAgentSessionId !== undefined ? { overrideAgentSessionId } : {};
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
