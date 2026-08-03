/**
 * Account-scoped agent HOME for `RUNTIME_MODE=local` (docs/150 req 19, docs/118).
 *
 * In containerized mode the account a session was routed to reaches the CLI
 * through the filesystem: the worker image symlinks `~/.claude` / `~/.codex`
 * into `/credentials`, which is a per-session mount whose contents were copied
 * from `provider-accounts/<provider>/<accountId>/` on the session's first turn
 * (docs/138). The CLI reads the right account without knowing accounts exist.
 *
 * Local mode has no container, no mount, and — because every credential step in
 * `session-agent-env.ts` is gated on `runner instanceof ContainerSessionRunner`
 * — no per-session credential subtree at all. Every session in the process
 * spawned its CLI with the same process-global `agentHome()`, so the router
 * selected an account, pinned it on the session, and the CLI then read whatever
 * the orchestrator's own HOME happened to hold. Selection was computed and
 * ignored.
 *
 * The fix is to spawn the CLI with HOME at the **account root itself**
 * (`<credentialsDir>/provider-accounts/<provider>/<accountId>`), which already
 * has the `.claude` / `.claude.json` / `.codex` layout a home needs — it is the
 * same directory the account-scoped auth and OAuth-refresh subprocesses already
 * run against (each provider's `auth-manager.ts` / `oauth-refresher.ts`). No
 * per-session copy is interposed, which is right for local mode: the copy
 * exists to keep one container from reading another's credentials, and in local
 * mode every session is already the same process and the same OS user. It also
 * means a token the CLI rotates lands directly on the source, so none of the
 * per-turn sync-in / sync-back machinery is needed here.
 *
 * HOME alone is not sufficient, and the adapters carry the other half: a
 * provider CLI prefers an env-supplied key/token over the credentials on disk,
 * so a scoped spawn also drops the ones that do not belong to the selected
 * route (`scrubEnvAuthForScopedHome` in `agents/claude/process.ts`; the Codex
 * adapter's existing subscription-wins branch, tightened so a scoped account
 * never falls back to `OPENAI_API_KEY` — req 12).
 *
 * Two local-mode-only consequences, deliberate and documented in
 * `docs/150-multiple-provider-subscriptions/plan.md`:
 *
 *   - Sessions sharing an account share its `.claude` tree. Conversation state
 *     is keyed by workspace path and conversation id, and each session has its
 *     own workspace, so they do not collide.
 *   - A mid-session account switch does not carry the CLI-side conversation
 *     file across to the new account root, so the CLI starts a fresh thread.
 *     ShipIt's own transcript and the workspace are untouched (req 9's
 *     user-visible half); the container path preserves the CLI file too.
 */

import type { AgentId } from "../shared/types/agent-types.js";
import type { AgentProcess, SessionInfo } from "../shared/types.js";
import type { AgentHomeResolver } from "../shared/agent-home.js";
import type { ProviderAccountManager } from "./provider-account-manager.js";
import { providerAccountCredentialRoot } from "./provider-account-manager.js";

/**
 * The local-mode agent factory (`app-di.ts` → `buildLocalAgentFactory`).
 *
 * Same shape as the process-wide `agentFactory`, plus the optional per-spawn
 * HOME resolver that carries provider-account selection into a CLI that has no
 * per-session credentials mount to read it from.
 */
export type LocalAgentFactory = (
  agentId: AgentId,
  resolveHome?: AgentHomeResolver,
) => AgentProcess;

export interface LocalAgentHomeDeps {
  /** Session lookup — only `get` is used, so tests can pass a stub. */
  sessionManager: { get(sessionId: string): SessionInfo | undefined };
  /**
   * Used only for an agent this session is NOT pinned to (a cross-provider
   * sub-agent spawn), where the session's own route says nothing about which
   * account of *that* provider to use. Optional: without it such a spawn keeps
   * the process-global home, which is the pre-existing behavior.
   */
  providerAccountManager?: Pick<ProviderAccountManager, "selectRouteForTurn">;
  /** Orchestrator credentials root (`provider-accounts/` lives under it). */
  credentialsDir: string;
}

/**
 * The HOME a local-mode `agentId` CLI should spawn with for `sessionId`, or
 * `undefined` to keep the process-global {@link agentHome}.
 *
 * `undefined` is the honest answer for a reserved route (`claude-api-key`,
 * `claude-env-oauth`, `codex-api-key`): those authenticate from the
 * environment, have no account root, and are exactly the routes a dogfood
 * install running on `ANTHROPIC_API_KEY` resolves to.
 *
 * Called at spawn time, never at construction — see {@link AgentHomeResolver}.
 * The session is pinned by `prepareSessionAgentEnvironment` immediately before
 * the spawn, and a failover repoints an already-pinned session under the same
 * runner, so an answer computed any earlier can be wrong.
 */
export function resolveLocalAgentHome(
  sessionId: string,
  agentId: AgentId,
  deps: LocalAgentHomeDeps,
): string | undefined {
  const session = deps.sessionManager.get(sessionId);

  // The pinned route belongs to the session's own agent. Read it directly
  // rather than re-selecting, so this never disagrees with the account
  // env-prep pinned, stamped `lastUsedAt` on, and reported in diagnostics —
  // including when the pin is a RESERVED route, which authenticates from the
  // environment and must keep the process-global home rather than fall through
  // to an account.
  if (session?.agentId === agentId && session?.providerRouteKind) {
    return session.providerRouteKind === "account" && session.providerRouteId
      ? providerAccountCredentialRoot(deps.credentialsDir, agentId, session.providerRouteId)
      : undefined;
  }

  // A different provider than the session is pinned to: a cross-provider
  // sub-agent spawn (`shipit agent run`, docs/144). Its account is chosen the
  // same way session naming chooses one (`graduate-session.ts`) — the route a
  // turn for that provider would take right now.
  const route = deps.providerAccountManager?.selectRouteForTurn(agentId);
  if (route?.kind === "account") {
    return providerAccountCredentialRoot(deps.credentialsDir, agentId, route.id);
  }

  return undefined;
}
