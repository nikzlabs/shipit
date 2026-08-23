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

import type { ProviderRouteKind } from "../shared/types/domain-types/provider.js";
import path from "node:path";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { CredentialStore } from "./credential-store.js";
import type { ServiceManager } from "./service-manager.js";
import type { AgentId, SessionInfo } from "../shared/types.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import {
  ensureLocalWorkspaceTrust,
  ensureSessionAgentUserConfig,
  ensureSessionAccountCredentials,
  provisionAgentCredentials,
  provisionRepoMemory,
  readSessionAccountMarker,
  syncAgentTokenIn,
  syncProviderAccountTokenIn,
  syncAgentTokenBack,
  syncProviderAccountTokenBack,
  syncMemoryBack,
  repushAgentToken,
  repushProviderAccountToken,
  writeSessionResidentRoute,
} from "./session-credentials.js";
import {
  startTokenWriteBackWatch,
  stopTokenWriteBackWatch,
} from "./session-token-publisher.js";
import {
  clearAgentHomeCredentialLinks,
  isLocalRuntime,
  linkAgentHomeToCredentials,
} from "./local-agent-credentials.js";
import { repoUrlToHash } from "./git-utils.js";
import { agentHome, codexHome } from "../shared/agent-home.js";
import type { ProviderAccountManager, ProviderRoute } from "./provider-account-manager.js";
import { accountServiceForHarness, providerAccountCredentialRoot } from "./provider-account-manager.js";
import { routeFromSelection } from "./provider-route-preflight.js";
import {
  markCredentialRouteUsed,
  firstEligibleSelectionForHarness,
  selectRouteForSelection,
} from "./service-routing.js";
import type { ModelSelection } from "../shared/catalogue/index.js";
import { ensureCodexHomeInitialized } from "./agents/codex/home-init.js";
import { ensureLocalAgentOpsHost } from "./local-agent-ops.js";
import { refreshExpiredMcpOAuthTokens } from "./services/mcp-oauth.js";
import { collectAccountAgentEnv, collectServiceCredentialEnv } from "./secret-resolver.js";
import {
  credentialStorageEnvNames,
  getService,
  loginIntegrationForService,
  nativeServiceForHarness,
} from "../shared/catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "../shared/types/domain-types/credential-route.js";
import { buildConversationReplay } from "./services/replay.js";
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
  /**
   * Chat history, read only when a session's CLI-side conversation turns out
   * to be unresumable and the pointer has to be cleared. ShipIt's own
   * transcript is the durable copy of that conversation, so it is replayed
   * into the fresh agent conversation instead of starting contextless — the
   * same `conversationReplay` mechanism the rollback/fork paths use.
   *
   * Optional: without it the recovery still clears the dead pointer (so a
   * session can never get stuck resume-looping), the new conversation just
   * starts without the prior transcript.
   */
  chatHistoryManager?: Pick<ChatHistoryManager, "load" | "replaceInProgress" | "append">;
}

/**
 * Seed `sessions.conversation_replay` from ShipIt's persisted transcript so
 * the next agent spawn continues the visible conversation even though the
 * CLI-side conversation state is gone.
 *
 * Consumed within the SAME turn: `executeAgentTurn` runs `prepareAgentEnv`
 * before `buildRunParams`, and `buildAgentRunParams` calls
 * `consumeConversationReplay` — which both appends the replay to the system
 * prompt and drops the resume id. Verified at `turn-executor.ts`
 * (`prepareAgentEnv` → `buildRunParams`) and
 * `session-agent-run-params.ts:buildAgentRunParams`.
 *
 * Best-effort by design: a failure here must not block the turn, and the
 * pointer has already been cleared either way.
 */
function armConversationReplay(deps: SessionAgentEnvDeps, sessionId: string): void {
  const chatHistory = deps.chatHistoryManager;
  if (!chatHistory) return;
  try {
    const messages = chatHistory.load(sessionId);
    const replay = buildConversationReplay(messages);
    if (!replay) return;
    deps.sessionManager.setConversationReplay(sessionId, replay);
    console.log(
      `[credentials] armed visible-history replay for ${sessionId} (${messages.length} messages) — the new agent conversation continues the transcript instead of starting empty`,
    );
  } catch (err) {
    console.warn("[credentials] failed to arm conversation replay:", getErrorMessage(err));
  }
}

/**
 * Compute the full agent-env map that should be pushed to the worker's
 * `process.env` ahead of `/agent/start` (docs/088).
 *
 * Two regimes, distinguished by whether the runner has a `ServiceManager`:
 *
 *   * Compose-less session (`serviceManager` is `null`) — pull directly from
 *     `CredentialStore`. The account-level set covers `mcp__*` secrets,
 *     `MCP_PLATFORM_*` OAuth tokens, `OPENAI_API_KEY`-style top-level keys,
 *     and (docs/252 phase 2) every stored service credential materialized into
 *     its catalogue `storageEnv` name. `collectAccountAgentEnv` returns all of
 *     those; the `mcp__*` ones overlap with `getAllAgentEnv()` but the values
 *     are identical, so spread order doesn't matter there.
 *
 *   * Compose session — return the snapshot's `agentValues` map. The snapshot
 *     is the merged set (compose-declared + account-level) produced inside the
 *     most recent `ServiceManager.syncSecrets()` pass. The worker REPLACES its
 *     tracked set on every `PUT /secrets` call, so we MUST carry the *full*
 *     merged set here — pushing just the account-level subset would clobber
 *     the compose-declared `agent: true` secrets.
 *
 *     docs/252 phase 2 closes the gap that made a stored service key unreachable
 *     here: the loader `ServiceManager` merges from is now
 *     `collectAccountAgentEnv`, not the `mcp__*`-only `collectMcpAgentEnv`. A
 *     credential saved while a compose session is running reaches it on the
 *     next secrets sync, which every credential-route write triggers
 *     ({@link refreshAgentEnvForAllSessions}) — exactly the path an MCP secret
 *     already takes.
 */
export function selectAgentEnvForPush(input: {
  serviceManager: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  credentialStore: AccountAgentEnvSource;
}): Record<string, string> {
  if (input.serviceManager) {
    return withServiceCredentialsReconciled(
      input.serviceManager.getSecretsSnapshot(),
      input.credentialStore,
    );
  }
  return {
    ...input.credentialStore.getAllAgentEnv(),
    ...collectAccountAgentEnv(input.credentialStore),
  };
}

/**
 * Reconcile a compose snapshot against the credential store, in both
 * directions.
 *
 * **Dropping.** The snapshot is only as fresh as the last successful
 * `syncSecrets()`, and that pass **returns early** when the repo's compose file
 * is missing or unparsable (`service-manager.ts`). Without this, revoking a
 * credential on a session whose compose file happens to be broken re-pushes the
 * stale snapshot and the worker keeps the revoked key — indefinitely, until some
 * later parse succeeds. Revocation must not depend on the user's YAML being
 * valid.
 *
 * Narrow on purpose, in both directions. Only names the **catalogue** claims as
 * a `storageEnv` are candidates, and only those the compose file does **not**
 * declare: a repo that deliberately declares `DEEPSEEK_API_KEY` as an
 * `agent: true` secret is exercising the documented per-repo override, and that
 * value is its own, not a stale copy of the user's. What is left is exactly the
 * set that could only have come from the account-level loader.
 *
 * **Overwriting (docs/252 phase 5).** The same staleness cuts the other way for
 * the per-credential names, and there it is not merely a delayed revocation —
 * spawn shaping now *sources* the pinned credential from its own variable, so a
 * snapshot taken before those names existed makes a shaped turn find no
 * credential and raise `auth_required`. Every session already holding a compose
 * stack would have been in that state on the deploy that shipped this.
 *
 * The store therefore **wins outright** for `SHIPIT_CREDENTIAL_*`, rather than
 * only filling a gap: filling gaps alone would keep pushing the *old* secret
 * after a rotation, since the name is present in the stale snapshot and a broken
 * compose file means no sync ever replaces it — a revoked key delivered
 * indefinitely, which is the exact failure the dropping half exists to prevent.
 * Safe for exactly this prefix and no wider: it is ShipIt's own namespace, so
 * unlike a catalogue `storageEnv` a compose file cannot legitimately be
 * declaring its own value under it.
 */
function withServiceCredentialsReconciled(
  snapshot: { agentValues: Record<string, string>; declared: { name: string }[] },
  credentialStore: AccountAgentEnvSource,
): Record<string, string> {
  const delivered = collectServiceCredentialEnv(credentialStore);
  const declaredByCompose = new Set(snapshot.declared.map((d) => d.name));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshot.agentValues)) {
    // docs/252 phase 5 — the per-credential names are ShipIt's own namespace, so
    // they are candidates on the same terms as the catalogue's group names. A
    // deleted credential leaves a stale `SHIPIT_CREDENTIAL_*` in the snapshot
    // exactly as it used to leave a stale group name, and a snapshot is only as
    // fresh as the last successful sync.
    const isCatalogueCredential =
      credentialStorageEnvNames().includes(name) || name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX);
    if (isCatalogueCredential && !declaredByCompose.has(name) && delivered[name] === undefined) {
      continue;
    }
    out[name] = value;
  }
  for (const [name, value] of Object.entries(delivered)) {
    if (name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX)) out[name] = value;
  }
  return out;
}

/** The `CredentialStore` surface the account-level env collection reads. */
export type AccountAgentEnvSource = Pick<
  CredentialStore,
  "getAllAgentEnv" | "getAllMcpOAuthTokens" | "listCredentialRoutes" | "getCredentialSecret"
>;

/**
 * A runner that can accept a credential push. Structural rather than an
 * `instanceof ContainerSessionRunner` check, so a local-mode runner and a test
 * double satisfy it on the same terms the container runner does.
 */
export interface AgentSecretsCapableRunner {
  sessionId: string;
  serviceManager?: Pick<ServiceManager, "getSecretsSnapshot"> | null;
  tryPushAgentSecrets(values: Record<string, string>): Promise<void>;
}

export function isAgentSecretsCapable(runner: unknown): runner is AgentSecretsCapableRunner {
  return (
    !!runner
    && typeof (runner as AgentSecretsCapableRunner).tryPushAgentSecrets === "function"
  );
}

/**
 * Re-run every live compose stack's secrets sync so a credential change reaches
 * the sessions already running.
 *
 * Each `refreshSecrets()` re-reads the account-level set, rewrites the state
 * dir's `.env.agent`, and pushes the full set to the worker via `PUT /secrets`.
 * The worker REPLACES its tracked set on every push, so a removed credential is
 * dropped without an explicit clear list. Fire-and-forget per session: a
 * settings write must not fail because one session's stack is unhealthy.
 *
 * Lifted out of `api-routes-mcp.ts`, which had the only copy, when docs/252
 * gave it a second caller — the credential-route endpoints. Two copies of "how
 * a credential reaches a running session" is how one of them ends up stale.
 */
export function refreshAgentEnvForAllSessions(
  serviceManagers: Map<string, Pick<ServiceManager, "refreshSecrets">>,
): void {
  for (const [sessionId, mgr] of serviceManagers) {
    mgr.refreshSecrets().catch((err: unknown) => {
      console.warn(`[credentials] agent-env refresh failed for session ${sessionId}:`, getErrorMessage(err));
    });
  }
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
   * docs/260 §1b — the route this turn authenticates with, selected here and
   * threaded by the executor as a VALUE through run-params, spawn, listener
   * attribution, and write-back. The session row is no longer the handoff:
   * nothing on the turn path reads `sessions.provider_route_*`.
   *
   * `undefined` when this call was a warm-up (`enforceAccountRouting` unset —
   * warm-ups are account-neutral and select nothing) or when nothing is
   * signed in (`auth_required` falls through to the legacy env path).
   */
  turnRoute?: ProviderRoute;
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

/**
 * Resolve the provider route for a turn that has not pinned one yet.
 *
 * With `enforce`, throws {@link ProviderRouteUnavailableError} when no
 * credential of the selected `(service, billing mode)` can serve the turn
 * (docs/150-multiple-provider-subscriptions req 13). Returns `undefined` when the only problem is that nothing
 * is signed in (which has its own UX), or when this call isn't the turn's own
 * preflight.
 *
 * **docs/252 phase 5 — no longer gated on there being an account manager.** The
 * early return predated a world in which a credential could live anywhere but
 * `ProviderAccountManager`, and it makes a GLM-only install — no accounts at
 * all — resolve no route, pin nothing, and get no failover. `selectRouteForSelection`
 * already answers correctly without one; a session with no selection still
 * reaches `auth_required` and so still resolves `undefined`, which is what kept
 * the pre-feature behaviour.
 */
function selectTurnRoute(
  agentId: AgentId,
  session: SessionInfo,
  deps: SessionAgentEnvDeps,
  opts: {
    excludeRouteIds?: readonly string[] | undefined;
    residentRoute?: { kind: ProviderRouteKind; id: string } | undefined;
    requireResidentRoute?: boolean;
  },
): ProviderRoute | undefined {
  const manager = deps.providerAccountManager;
  // docs/260-turn-level-account-routing reqs 8/13 — a reused or busy resident process fixes the route:
  // the turn runs on the credential the live process already holds, whatever
  // the strategy prefers. Only while that credential still exists — a
  // deleted account or removed key has nothing left to protect, and normal
  // selection (below) is what re-routes the session.
  if (opts.requireResidentRoute && opts.residentRoute) {
    const { kind, id } = opts.residentRoute;
    const stillExists =
      kind === "account"
        ? manager?.getByRouteId(id) !== undefined
        : !id.startsWith("cred_") || deps.credentialStore.getCredentialRoute(id) !== undefined;
    if (stillExists) return { kind, id };
  }
  // Any resident kind qualifies for balanced session-spreading (req 8): the
  // account walk matches an account id, the string walk a stored-credential
  // id, and an env-reserved id simply matches neither.
  const residentRouteId = opts.residentRoute?.id;
  // docs/252 phase 3 — scoped to the SELECTED `(service, billing mode)`. Asking
  // one question per `AgentId` could answer with a credential belonging to a
  // different mode entirely, which is how an included turn became a metered one.
  //
  // docs/260-turn-level-account-routing req 12 — `optimistic` is unconditional here: this is the turn's
  // own pre-spawn selection and the result WILL be attempted, so refusal
  // memory may order candidates but not produce `all_exhausted` on its own.
  // The blocking throw fires only when every candidate was actually refused
  // this turn (all excluded), and the executor's attempt loop rewrites that
  // failure from its own ledger (req 6).
  const selection = selectRouteForSelection(
    agentId,
    modelSelectionOf(session),
    {
      credentialStore: deps.credentialStore,
      ...(manager ? { providerAccountManager: manager } : {}),
    },
    {
      optimistic: true,
      ...(opts.excludeRouteIds ? { exclude: opts.excludeRouteIds } : {}),
      ...(residentRouteId ? { residentRouteId } : {}),
    },
  );
  return routeFromSelection(agentId, selection, blockedSubjectFor(agentId, session));
}

/**
 * What to name in a blocked-turn message, when the selected service is not the
 * harness's own vendor.
 *
 * `undefined` for the first-party case, which keeps req 13's existing sentence
 * byte-identical — "Every connected Claude account is out of quota" is right
 * there and wrong for a spent GLM coding plan running on the same harness.
 */
function blockedSubjectFor(agentId: AgentId, session: SessionInfo): string | undefined {
  const serviceId = session.serviceId;
  if (!serviceId) return undefined;
  // The pre-feature sentence is kept only where "first party" still means a
  // login-backed vendor. "Every connected OpenCode account is out of quota"
  // would be wrong about OpenCode's native service (docs/272), which has no
  // accounts at all — its credentials are pasted keys, so it gets the
  // service-named sentence like any other supplied-key service.
  const accountBackedNative =
    serviceId === nativeServiceForHarness(agentId)
    && loginIntegrationForService(serviceId) !== undefined;
  if (accountBackedNative) return undefined;
  return getService(serviceId)?.name ?? serviceId;
}

/**
 * The session's persisted triple, or `undefined` when it holds no complete one.
 *
 * Exported since planning#460, so the two message-admission paths can ask the
 * catalogue about the pinned model without a second, subtly different reading of
 * "what is this session on" — an incomplete triple must answer `undefined`
 * there too, or a half-written selection would resolve to some other model's
 * capabilities.
 */
export function modelSelectionOf(session: SessionInfo): ModelSelection | undefined {
  if (!session.model || !session.serviceId || !session.billingMode) return undefined;
  return {
    serviceId: session.serviceId,
    billingMode: session.billingMode,
    modelId: session.model,
  };
}

export async function prepareSessionAgentEnvironment(
  runner: SessionRunnerInterface | null,
  args: {
    sessionId: string;
    agentId: AgentId;
    deps: SessionAgentEnvDeps;
    /**
     * docs/150-multiple-provider-subscriptions req 13 — set by the two callers that are the turn's own
     * pre-spawn step (`turn-executor` via `SystemTurnDeps.prepareAgentEnv`,
     * for both the WS and dispatched paths). Only there may this function
     * throw: a blocked turn has to fail *as a turn*, so the agent-error path
     * writes the reason into the session's transcript, clears turn state, and
     * drains the queue.
     *
     * The service-level warm-up calls (child spawn, headless create, CI fix,
     * session wake) leave it unset and keep their fail-open contract — they
     * run before the turn exists, and throwing there would abort a session
     * *creation* instead of a turn, leaving a session in the sidebar that no
     * one asked for. Those paths simply pin nothing; the executor's own
     * preflight, moments later, is what stops the turn and tells the user.
     */
    enforceAccountRouting?: boolean;
    /**
     * docs/260 §3 — route ids already refused by the provider during THIS
     * logical turn. Set by the attempt loop's retries so selection cannot
     * hand back an account that just refused; empty on the first attempt.
     */
    excludeRouteIds?: readonly string[];
    /**
     * docs/260 §5 — the credential route backing the session's live resident
     * CLI process, when one exists. Under `balanced` its account keeps
     * serving this session while eligible (the mode spreads sessions, not
     * turns — req 8); under `strict` it is only a preference when
     * `requireResidentRoute` forces it.
     */
    residentRoute?: { kind: ProviderRouteKind; id: string };
    /**
     * docs/260-turn-level-account-routing reqs 8/13 — the turn MUST run on `residentRoute`: the process
     * is being reused (its token is in memory), or it holds background work
     * and may not be killed for a move. Selection short-circuits to the
     * resident route while its credential still exists; a deleted credential
     * falls through to normal selection (there is nothing left to protect).
     */
    requireResidentRoute?: boolean;
    /**
     * True when this turn will REUSE a resident agent process rather than
     * spawn a fresh one (live steering, docs/140). Set by the turn executor,
     * which is the only caller that knows.
     *
     * It suppresses the docs/153 leak repair, and only that. The repair is
     * destructive — unlink `.claude`, re-copy the subtree, merge the orphan,
     * `rmSync` the orphan root — and running it under a live CLI is what
     * produced `Not logged in · Please run /login` mid-session
     * (nikzlabs/shipit#1874): between the unlink and the copy there is a real
     * window with no `.claude/.credentials.json` on disk, and the CLI re-reads
     * that file per API call. Nothing the repair produces is consumed by a
     * reuse turn — the on-disk convergence is for the next `--resume`, and the
     * recovered `agentSessionId` is read by `buildRunParams`, which the reuse
     * branch never calls — so deferring it to the next spawn loses nothing.
     *
     * The per-turn token copy still runs: that is what keeps a long-lived
     * process authenticated across a rotation (docs/142 A).
     */
    reusingResidentAgent?: boolean;
  },
): Promise<PrepareSessionAgentEnvironmentResult> {
  const { sessionId, agentId, deps } = args;
  let session = deps.sessionManager.get(sessionId);
  if (!session) return {};
  // docs/260 §1 — every routed turn selects its account HERE, from the
  // strategy and the quota picture; no pinned route is consulted and none is
  // persisted. A warm-up (`enforceAccountRouting` unset — child spawn,
  // headless create, CI fix, session wake) is account-neutral by design: it
  // selects nothing, provisions nothing, and stamps nothing, so it cannot
  // double-select against the real turn that follows moments later.
  const isTurn = args.enforceAccountRouting === true;
  // planning#353 — settle the turn's model onto the row when the session has
  // none, rather than letting route selection fall through to the harness's own
  // vendor on an install that has no credential for it.
  //
  // **Written to the row, not derived per reader.** The turn has two
  // independent readers of the selection: the route walk below, and
  // `buildRunParams`, which rebuilds the triple from the row to produce the
  // spawn's endpoint, credential and `--model`. Deriving in the first alone
  // pins a DeepSeek route onto a spawn still shaped for Anthropic — worse than
  // the bug, because it also mis-attributes. Deriving in both is one rule
  // written twice. The row is already "the authoritative answer to what this
  // session will run next" (`session-agent-run-params.ts`), so writing it keeps
  // that single source rather than adding a second beside it.
  //
  // **Only when the derived service is NOT the harness's own vendor**, which
  // makes this a strict no-op wherever the old fallback already worked. If the
  // first eligible model belongs to the native vendor, the old question —
  // `selectAccountForTurn(nativeService)` — reaches the same credential, so
  // writing would change nothing about routing and plenty about the spawn:
  // shaping a previously-unshaped first-party turn also starts sending
  // `--model` and an explicit endpoint, which is a behavior change for no
  // routing gain (a derived `anthropic:sub` would ALSO have delivered the
  // stored `ANTHROPIC_AUTH_TOKEN` through the shaped path — fixed at the
  // catalogue in planning#354, so the credential hazard is gone but the
  // spawn-shape change is not). Cross-agent review caught that.
  // So the write is confined to the case the old answer got wrong: a harness
  // whose own vendor this install cannot authenticate.
  //
  // Turns only. A warm-up is account-neutral by design, and pinning a model
  // there would make an untouched session silently acquire one.
  //
  // One ordering note, since it looks like a hole: the resident-reuse decision
  // (`releaseResidentOnSpawnChange`, `agent-execution.ts`) reads the row BEFORE
  // this runs, so a resident spawned under the selection-less identity would be
  // kept and handed a turn whose row now says otherwise. Unreachable in
  // practice under the guard above — on an install this writes for, a
  // selection-less resident could only have been spawned against the native
  // vendor it cannot authenticate, so there is no live process to reuse; and a
  // credential disappearing mid-session releases residents anyway
  // (`releaseResidentForCredentialChange`). From the next turn on the row and
  // the resident identity agree.
  if (isTurn && !modelSelectionOf(session)) {
    const derived = firstEligibleSelectionForHarness(agentId, { credentialStore: deps.credentialStore });
    // docs/272 — the skip's premise is that the OLD fallback works for the
    // native vendor, and it does only where an unshaped spawn can authenticate:
    // a login-backed vendor whose OAuth is on disk (claude, codex). OpenCode's
    // native service is key-authenticated with no login, and its adapter
    // refuses an unshaped turn outright — so where the native service has no
    // login integration, the row is written even for the native service.
    const nativeAuthenticatesUnshaped =
      loginIntegrationForService(nativeServiceForHarness(agentId)) !== undefined;
    if (derived && (derived.serviceId !== nativeServiceForHarness(agentId) || !nativeAuthenticatesUnshaped)) {
      deps.sessionManager.setModelSelection(sessionId, derived);
      session = deps.sessionManager.get(sessionId) ?? session;
      // req 4's convergence, for a selection the SERVER moved rather than the
      // user: `set_model` sends this after persisting precisely because the
      // composer otherwise keeps deriving its own display from live state and
      // never reads the row back. A write with no message leaves every viewer
      // showing a model the turn is not using.
      runner?.emitMessage({
        type: "model_selection_changed",
        sessionId,
        agentId,
        selection: derived,
        modelId: derived.modelId,
        reasoningEffort: session.reasoningEffort ?? null,
        // docs/272 — the role in force is unchanged by this write (the server is
        // filling a model nobody selected, not moving one the user chose), so it
        // is reported as it stands rather than cleared.
        roleName: session.roleName ?? null,
        notice: `No model was selected, so this session is running ${
          getService(derived.serviceId)?.name ?? derived.serviceId
        }.`,
      });
    }
  }
  const selectedRoute = isTurn
    ? selectTurnRoute(agentId, session, deps, {
        excludeRouteIds: args.excludeRouteIds,
        residentRoute: args.residentRoute,
        requireResidentRoute: args.requireResidentRoute === true,
      })
    : undefined;

  // docs/260 §5 — stamp the selection onto the runner BEFORE the spawn: the
  // local-mode HOME resolver and the pre-capture release check read this, and
  // the spawn that follows may resolve synchronously, before the executor's
  // own post-run stamp could land.
  if (isTurn && runner && selectedRoute) {
    runner.residentRoute = { kind: selectedRoute.kind, id: selectedRoute.id };
    // docs/260 §5 — persist the same stamp, so a post-restart adoption can
    // recover the identity of a surviving process whose credential left no
    // subtree marker (string/env-delivered routes; reqs 11 and 13). Best
    // effort: the file only ever improves attribution.
    if (runner instanceof ContainerSessionRunner) {
      try {
        writeSessionResidentRoute(deps.credentialsDir, sessionId, agentId, {
          kind: selectedRoute.kind, id: selectedRoute.id,
        });
      } catch (err) {
        console.warn("[credentials] resident-route record failed:", getErrorMessage(err));
      }
    }
  }

  // docs/150-multiple-provider-subscriptions req 21 — stamp the credential this turn actually resolved onto,
  // which is what `balanced` sorts by. An account merely *considered* has not
  // been used; a warm-up stamps nothing (it resolved nothing).
  if (selectedRoute?.kind === "account" && deps.providerAccountManager) {
    deps.providerAccountManager.markAccountUsed(accountServiceForHarness(agentId), selectedRoute.id);
  }
  // docs/252 phase 5 — the same stamp for a string-delivered credential, which
  // is what makes `balanced` mean anything for a subscription authenticated by
  // a key. A no-op for an env-delivered route, which has no row to stamp.
  markCredentialRouteUsed(deps.credentialStore, selectedRoute);

  // One line per preparation recording the decisions that shaped it: which
  // route the turn resolved to and whether the leak repair ran. Route ids are
  // opaque account handles (`acct_…`); no token material is logged here or
  // anywhere below.
  const routeLabel = selectedRoute ? `${selectedRoute.kind}:${selectedRoute.id}` : "none";
  const repairLabel = args.reusingResidentAgent ? "skipped(resident-agent)" : "run";
  console.log(
    `[env-prep] ${sessionId} agent=${agentId} route=${routeLabel} turn=${isTurn ? "yes" : "warm-up"} repair=${repairLabel}`,
  );

  // Step 1 (docs/260-turn-level-account-routing req 4): the session's credential subtree FOLLOWS the
  // turn. For an account route, `ensureSessionAccountCredentials` verifies by
  // recorded identity that the subtree belongs to the chosen account and
  // reprovisions it wholesale on any mismatch — a wrong-account token can
  // never survive to spawn time, which closes the "session spends account A
  // while telemetry benches account B" poisoning class the 2026-08-10
  // incident exposed. Reserved/legacy routes keep the write-once copy gated
  // on `agentPinned` (their flat source has no per-account identity, and a
  // per-turn re-copy would clobber session-local state with an older root).
  if (isTurn && runner instanceof ContainerSessionRunner) {
    // docs/260-turn-level-account-routing req 4 — the account-identity step fails CLOSED. If the subtree
    // cannot be verified/reprovisioned for the chosen account, the turn must
    // NOT spawn: the tree on disk may still hold ANOTHER account's token, and
    // a spawn would spend that account while the capture attributes this one
    // (the poisoning class req 4 exists to close). The throw surfaces as a
    // failed turn via the executor's error path — visible and resendable,
    // unlike a silently mis-billed turn.
    if (selectedRoute?.kind === "account") {
      const outcome = ensureSessionAccountCredentials(
        deps.credentialsDir, sessionId, agentId, selectedRoute.id,
      );
      if (outcome !== "match") {
        console.log(
          `[credentials] ${sessionId} account subtree ${outcome} for ${selectedRoute.id}`,
        );
      }
    }
    // Everything below stays best-effort: the legacy flat copy and memory
    // seeding are write-once scaffolding with no account identity at stake.
    try {
      if (selectedRoute?.kind !== "account" && !session.agentPinned) {
        provisionAgentCredentials(deps.credentialsDir, sessionId, agentId);
      }
      // docs/155 — seed the shared per-repo Claude memory dir into this
      // session's memory subtree (write-once, on first turn). Only Claude
      // has the `.claude/projects/-workspace/memory` layout, and only a
      // session with a remote URL has a stable repo hash to share by;
      // sessions without one keep memory ephemeral in their per-session dir.
      // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-only memory dir layout, see provisionRepoMemory
      if (!session.agentPinned && agentId === "claude" && session.remoteUrl) {
        provisionRepoMemory(deps.credentialsDir, sessionId, repoUrlToHash(session.remoteUrl));
      }
    } catch (err) {
      console.warn("[credentials] provisioning failed:", getErrorMessage(err));
    }
  }
  if (isTurn && !session.agentPinned) {
    deps.sessionManager.setAgentId(sessionId, agentId);
    // docs/260 — `agentPinned` no longer pins anything about routing; it
    // survives only as the "scaffolded once" boundary for the write-once
    // provisioning branches above (legacy flat credentials, repo memory).
    deps.sessionManager.setAgentPinned(sessionId);
  } else if (isTurn && runner instanceof ContainerSessionRunner) {
    // The account path's provisioning normalizes the agent's user config only
    // when it reprovisions; re-assert it on every turn. Idempotent and
    // merge-only: it reads one small JSON file and writes only when a key is
    // actually missing.
    try {
      ensureSessionAgentUserConfig(deps.credentialsDir, sessionId, agentId);
    } catch (err) {
      console.warn("[credentials] agent user-config normalization failed:", getErrorMessage(err));
    }
  }

  // Step 1b (planning#284): the local-mode twin of Step 1. Every branch above is
  // gated on `ContainerSessionRunner`, and in local mode there is no container
  // — so a dogfood turn spawned a CLI whose HOME had never been given
  // credentials at all, for either agent.
  //
  // This maintains the process-global *fallback* home only. A session turn's
  // own spawn gets `HOME` pointed straight at its account root by
  // `local-agent-home.ts`, so it does not read these links; what does is a
  // spawn with no session route to resolve (`generateText`, and the cases
  // `resolveLocalAgentHome` deliberately answers `undefined` for). See
  // `local-agent-credentials.ts` for why linking rather than copying, and for
  // the one-physical-file invariant that lets both point at the same account.
  //
  // Runs on every turn, not just at pin time: local sessions share one home,
  // so a sibling on another account may have repointed it since.
  //
  // A RESERVED route (`claude-api-key` / `claude-env-oauth` / `codex-api-key`)
  // authenticates from the environment and has no account subtree, so it
  // *clears* instead of linking. Leaving an earlier account turn's link behind
  // meant the home held one route's subscription credentials while the turn ran
  // on another; the CLI's env-beats-disk preference picked the right one by
  // luck, not by design (docs/150-multiple-provider-subscriptions req 12).
  if (isLocalRuntime() && isTurn) {
    const accountId = selectedRoute?.kind === "account" ? selectedRoute.id : undefined;
    try {
      const outcomes = selectedRoute?.kind === "reserved"
        ? clearAgentHomeCredentialLinks({ agentId })
        : linkAgentHomeToCredentials({
          credentialsDir: deps.credentialsDir,
          agentId,
          ...(accountId ? { accountId } : {}),
        });
      const linked = Object.entries(outcomes).filter(([, o]) => o === "linked");
      if (linked.length > 0) {
        console.log(
          `[local-credentials] ${sessionId} agent=${agentId} linked ${linked.map(([rel]) => rel).join(", ")}`
            + ` from ${accountId ? `account:${accountId}` : "the flat credentials root"}`,
        );
      }
      const cleared = Object.entries(outcomes).filter(([, o]) => o === "unlinked");
      if (cleared.length > 0) {
        console.log(
          `[local-credentials] ${sessionId} agent=${agentId} cleared ${cleared.map(([rel]) => rel).join(", ")}`
            + ` — routed to reserved:${selectedRoute?.id ?? "?"}, which authenticates from the environment`,
        );
      }
    } catch (err) {
      console.warn("[local-credentials] updating agent home links failed:", getErrorMessage(err));
    }

    // The other half of the Codex cold-start gate (`agents/codex/home-init.ts`).
    //
    // In local mode this turn's CLI spawns with HOME at the account root the
    // links above just pointed at — the SAME root `graduateSession`'s naming CLI
    // is spawning against right now, on this very message. Codex's first-run
    // initialization of that root is not concurrency-safe, so on the first turn
    // after connecting an account the two collide and the loser exits 1 with
    // `failed to initialize sqlite state runtime`. When the loser is the turn,
    // the user gets a dead turn — while naming succeeds and gives the session a
    // real title and branch, so it reads like a turn that ran.
    //
    // Awaiting here rather than in the adapter keeps `CodexAgentProcess.run()`
    // synchronous, and env-prep is already the awaited pre-spawn step. Costs one
    // directory read once the root is warm; the naming call awaits the same
    // single-flight promise, so only one process ever does the initializing.
    //
    // planning#390 — gated on the ROUTE'S root, not on `accountId`. This used to
    // read `agentId === "codex" && accountId`, on the premise that an account
    // route is the only way two spawners land on one root. That was true only
    // because the unscoped route's turn never reached the CLI: it inherited an
    // ambient `HOME` the adapter had not set and died on `/root`. With the
    // adapter naming its own home, an unscoped turn and the naming shell-out
    // both resolve `codexHome()` — the SAME root, cold on a first message, and
    // neither one gated. That is exactly the race this gate exists to prevent,
    // newly reachable on the whole redirected surface. The expression mirrors
    // the `ensureLocalWorkspaceTrust` call below and the adapter's
    // `codexConfigDir()`; all three have to name one root or the warm-up warms a
    // directory the turn will not read.
    //
    // eslint-disable-next-line no-restricted-syntax -- genuine per-CLI-shape exception (docs/155): the non-atomic first-run init of a `.codex` state directory is a property of the Codex CLI, not a capability any agent could declare.
    if (agentId === "codex") {
      await ensureCodexHomeInitialized(
        accountId
          ? path.join(providerAccountCredentialRoot(deps.credentialsDir, agentId, accountId), ".codex")
          : codexHome(),
      );
    }

    // The `/agent-ops` host that makes the `gh` shim work here (docs/251).
    //
    // A containerized turn reaches `gh` through the worker's broker; local mode
    // has no worker, so `Dockerfile.dogfood` shipped no shim and a dogfood turn
    // could not open a PR. This starts a session-bound loopback host whose URL
    // reaches the CLI as `SHIPIT_AGENT_OPS_URL` (`local-agent-mcp.ts`).
    //
    // Awaited here for the same reason as the Codex gate above: the adapters
    // spawn synchronously, so the URL has to be in the registry BEFORE the
    // spawn reads it. Single-flight, so a session's later turns are a map hit.
    // Fails open — a host that cannot start leaves `gh` unavailable for the
    // turn rather than killing it.
    await ensureLocalAgentOpsHost({ sessionId });

    // Step 1c (docs/118, planning#61): the local-mode workspace-trust write — the third
    // container-gated writer this mode was missing, after planning#284 and planning#300.
    //
    // The Claude CLI silently drops a workspace's own `.claude/settings.json`
    // `permissions.allow` entries until that workspace is trusted ("Ignoring N
    // permissions.allow entries … this workspace has not been trusted"), so the
    // agent gets approval prompts for tools that were explicitly allowlisted.
    // A container is covered because its cwd IS `/workspace`, one of
    // `CLAUDE_PRE_TRUSTED_DIRS`; a local session's workspace is
    // `<dataDir>/sessions/<id>/workspace`, and trust is keyed by EXACT
    // directory, so that pre-trust never reaches it.
    //
    // The CLI exposes no switch to turn the check off, which is what the
    // product decision here asked for. Probed against 2.1.219 and all
    // ineffective: `CLAUDE_CODE_SANDBOXED=1`, `IS_SANDBOX=1`,
    // `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
    // `--add-dir <workspace>`, a trust key on an ANCESTOR directory, a `"*"` or
    // glob `projects` key, a top-level `hasTrustDialogAccepted`, and every
    // plausible `--settings` key. The per-directory key in the user config is
    // the only mechanism, so local mode writes it per session and
    // `ensureClaudeWorkspaceTrusted` prunes the entries whose workspace is
    // gone — which bounds the file at the set of live local sessions rather
    // than letting it accumulate forever.
    //
    // Local mode only, by product decision: it is a testing surface that runs
    // only trusted repositories, so there is nothing there for the check to
    // protect against. A container session can hold an arbitrary user
    // repository — exactly the case the check exists for — and nothing here
    // runs for it.
    //
    // The home mirrors `resolveLocalAgentHome`'s session branch: the CLI is
    // spawned with HOME at the routed account root, or the process-global
    // `agentHome()` for a reserved route (which has no account subtree). Both
    // read `accountId` above, so the config written here is the config the
    // spawn will read.
    if (runner) {
      try {
        ensureLocalWorkspaceTrust(
          accountId
            ? providerAccountCredentialRoot(deps.credentialsDir, agentId, accountId)
            : agentHome(),
          agentId,
          runner.sessionDir,
        );
      } catch (err) {
        console.warn("[local-credentials] workspace trust write failed:", getErrorMessage(err));
      }
    }
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
    isTurn &&
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
  // docs/260 — warm-ups skip the token sync too: it is route-directional
  // (account subtree vs the legacy flat root), a warm-up has no route, and
  // pulling the FLAT root's token into an account-provisioned subtree is the
  // wrong-account overwrite req 4 exists to prevent. The executor's own
  // enforce-routing call, moments later, performs the sync.
  if (isTurn && runner instanceof ContainerSessionRunner) {
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
            console.log(`[credentials] clearing agent_session_id for ${sessionId} (was ${current}; no resumable conversation found on disk)`);
            deps.sessionManager.clearAgentSessionId(sessionId);
            // The CLI-side conversation is unrecoverable, but ShipIt's own
            // transcript isn't — replay it so the fresh conversation picks up
            // where the user left off rather than answering from nothing.
            armConversationReplay(deps, sessionId);
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
      // See `reusingResidentAgent` — the repair is a spawn-time concern and
      // must not run under a live CLI.
      const syncOpts = { repairLeakedSubtrees: !args.reusingResidentAgent };
      if (selectedRoute?.kind === "account") {
        syncProviderAccountTokenIn(
          deps.credentialsDir, sessionId, agentId, selectedRoute.id,
          onRecover, currentAgentSessionId, syncOpts,
        );
      } else if (selectedRoute?.id !== "claude-env-oauth") {
        syncAgentTokenIn(
          deps.credentialsDir, sessionId, agentId,
          onRecover, currentAgentSessionId, syncOpts,
        );
      }
    } catch (err) {
      console.warn("[credentials] token sync-in failed:", getErrorMessage(err));
    }
  }

  // Step 2b (docs/153): publish a rotation the CLI performs DURING this turn
  // as soon as it lands, instead of at turn end. `syncAgentTokenBack` alone
  // leaves the source serving a token the rotation already invalidated
  // upstream for the whole remainder of the turn — minutes, during which every
  // sibling session's sync-in pulls the dead token and 401s. The watch runs
  // the same sync-back, guard included; only the timing changes.
  //
  // Gated on `enforceAccountRouting` because that flag marks the turn's own
  // pre-spawn step — the moment a CLI is about to start writing. The
  // service-level warm-ups (child spawn, headless create, CI fix, wake) run
  // before any turn exists and are followed by the executor's own call moments
  // later, which is what arms the watch. Route branching mirrors Step 2's
  // exactly, including skipping the reserved `claude-env-oauth` route.
  if (runner instanceof ContainerSessionRunner && args.enforceAccountRouting) {
    if (selectedRoute?.kind === "account") {
      startTokenWriteBackWatch({
        credentialsDir: deps.credentialsDir, sessionId, agentId,
        accountId: selectedRoute.id, runner,
      });
    } else if (selectedRoute?.id !== "claude-env-oauth") {
      startTokenWriteBackWatch({ credentialsDir: deps.credentialsDir, sessionId, agentId, runner });
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

  return {
    ...(selectedRoute ? { turnRoute: selectedRoute } : {}),
    ...(overrideAgentSessionId !== undefined ? { overrideAgentSessionId } : {}),
  };
}

/**
 * docs/179 — force the orchestrator's source OAuth token into ONE session's
 * credential subtree, bypassing the per-turn sync-in's expiry-ordering guard.
 * Called only from the runtime-401 recovery, immediately before the healed turn
 * is re-dispatched.
 *
 * Why the ordinary sync-in isn't enough. Every guard in the credential system —
 * `syncAgentTokenIn`, `syncAgentTokenBack`, the refresher's schedule, and
 * `ensureFresh` — keys off one number, `expiresAt`. That is a sound proxy for
 * *ordering* and no proxy at all for *validity*: a rotating single-use OAuth
 * token's validity is set membership (only the newest token lives), so a
 * rotation on another machine, a revocation, or an account change leaves a
 * perfectly future-dated `expiresAt` on a token that is already dead. The
 * sync-in's guard then reads that dead-but-later timestamp
 * (`srcExp <= dstExp` ⇒ `continue`) and *refuses* to hand the session the good
 * source token — so the quiet retry re-spawns on the identical dead
 * credentials and 401s again. `repushAgentToken` is the escape hatch the
 * credential layer already ships for exactly this state (see its docstring),
 * wired until now only to the manual `auth_complete` re-login.
 *
 * Route-aware in the same way `finalizeSessionAgentEnvironment` is: an
 * account-pinned session (docs/150) is repushed from its account root, a
 * legacy null-route session from the shared root, and a session on
 * `claude-env-oauth` is left alone (its credentials aren't ours to write).
 * Best-effort — a failure here just means the retry runs on whatever the
 * ordinary sync-in provides, which is today's behavior.
 */
export function repushSessionAgentToken(
  runner: SessionRunnerInterface | null,
  args: { sessionId: string; agentId: AgentId; deps: Pick<SessionAgentEnvDeps, "credentialsDir" | "sessionManager"> },
): void {
  if (!(runner instanceof ContainerSessionRunner)) return;
  try {
    // docs/260 — the source to repush from is the subtree's own recorded
    // account (the marker), never a session row: the row records no route any
    // more, and a null read here would force-push the FLAT root's token over
    // an account session's copy — the cross-account overwrite this feature
    // exists to end. No marker + a reserved env-OAuth route means the
    // credentials aren't ours to write; no marker otherwise is a true legacy
    // session and keeps the flat repush.
    const marked = readSessionAccountMarker(args.deps.credentialsDir, args.sessionId)[args.agentId];
    if (marked) {
      repushProviderAccountToken(args.deps.credentialsDir, args.sessionId, args.agentId, marked);
    } else if (runner.residentRoute?.id !== "claude-env-oauth") {
      repushAgentToken(args.deps.credentialsDir, args.sessionId, args.agentId);
    }
  } catch (err) {
    console.warn("[credentials] 401-recovery token repush failed:", getErrorMessage(err));
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
  args: {
    sessionId: string;
    agentId: AgentId;
    deps: SessionAgentEnvDeps;
    capturedRoute?: Pick<SessionInfo, "providerRouteKind" | "providerRouteId">;
  },
): void {
  // docs/153 — the turn is over; the CLI is not necessarily gone. A streaming
  // process stays resident across turns and refreshes on its own schedule
  // hours later, so tearing the watch down here left those rotations
  // unobserved until the next turn — the daily-reconnect bug. Keep watching
  // while a process is alive; the runner's `disposed` event stops it when the
  // container goes. With no resident process nothing can rotate, so drop the
  // watch (and any debounced publish still pending) — the unconditional
  // sync-back below is then the authoritative final publication.
  // `?? null` for the same reason `sessionHasLiveAgent` uses it: actual process
  // liveness is the question, and a runner that cannot answer counts as no.
  const residentAgentAlive =
    runner instanceof ContainerSessionRunner && (runner.getAgent() ?? null) !== null;
  if (!residentAgentAlive) stopTokenWriteBackWatch(args.sessionId);
  if (!(runner instanceof ContainerSessionRunner)) return;
  const session = args.deps.sessionManager.get(args.sessionId);
  // docs/260 — the write-back target is the TURN'S OWN captured route; with
  // no capture (a path that never ran env-prep), the subtree's recorded
  // account marker decides. The old fallback read the session row, and a
  // missing row value sent an account session's token to the FLAT root —
  // the exact cross-account write-back that poisoned installs pre-260.
  const markerAccountId = readSessionAccountMarker(args.deps.credentialsDir, args.sessionId)[args.agentId];
  const route = args.capturedRoute
    ?? (markerAccountId
      ? { providerRouteKind: "account" as const, providerRouteId: markerAccountId }
      : undefined);
  try {
    if (route?.providerRouteKind === "account" && route.providerRouteId) {
      syncProviderAccountTokenBack(
        args.deps.credentialsDir,
        args.sessionId,
        args.agentId,
        route.providerRouteId,
        // `sessionOwnRoute` — both branches above resolve the SESSION'S route
        // (the turn's own capture, or failing that the subtree's own marker),
        // never an account borrowed for a sub-agent. planning#445: that is the
        // caller class allowed to repair a marker lost mid-turn rather than
        // drop the rotation, which for a rotating token kills the source.
        { sessionOwnRoute: true },
      );
    } else if (route?.providerRouteId !== "claude-env-oauth") {
      syncAgentTokenBack(args.deps.credentialsDir, args.sessionId, args.agentId, { sessionOwnRoute: true });
    }
  } catch (err) {
    console.warn("[credentials] token sync-back failed:", getErrorMessage(err));
  }

  // docs/155 — mirror any memory files the Claude CLI wrote this turn back to
  // the shared per-repo dir. Same gate as provisioning: Claude-only layout,
  // and only when the session has a remote URL to key the shared dir by.
  // eslint-disable-next-line no-restricted-syntax -- docs/155: Claude-only memory dir layout, see syncMemoryBack
  if (args.agentId === "claude" && session?.remoteUrl) {
    try {
      syncMemoryBack(args.deps.credentialsDir, args.sessionId, repoUrlToHash(session.remoteUrl));
    } catch (err) {
      console.warn("[credentials] memory sync-back failed:", getErrorMessage(err));
    }
  }
}
