/**
 * docs/150 — move an already-pinned session from one provider account to
 * another **without losing the conversation** (req 9).
 *
 * This is the transition Phase 3's automatic failover calls when an account is
 * exhausted, and the same one a user-initiated "switch account" would call. It
 * is deliberately a plain service over domain types so both entrypoints share
 * one implementation.
 *
 * ## Why the agent process has to die
 *
 * Both CLIs read their credentials **once**, at process start, from `$HOME`.
 * The per-session credentials dir is bind-mounted into the container, so
 * rewriting the files on disk is visible immediately — but a *running* agent
 * already holds the old account's token in memory and will keep using it until
 * it exits. So the order is: kill, rewrite, then let the next turn spawn fresh.
 *
 * ## Why the conversation survives anyway
 *
 * Resume is **local and account-agnostic** — verified in code, not assumed:
 * Claude's `--resume <id>` reads
 * `.claude/projects/<encoded-cwd>/<id>.jsonl` and Codex's `thread/resume`
 * reads `.codex/sessions/.../rollout-*.jsonl`. Both files live in the
 * session's own credential subtree and carry no account identity; neither
 * provider validates the transcript against the authenticated account. So the
 * switch keeps `agentSessionId` untouched and the next turn resumes normally.
 *
 * The one thing that *would* break it is the reprovision step deleting those
 * files, which is exactly what a blanket subtree wipe used to do —
 * `provisionProviderAccountCredentials` preserves the conversation-state
 * allowlist instead. That guarantee lives in `session-agent-credentials.ts`;
 * this module depends on it and the tests here assert it end to end rather
 * than trusting the docstring.
 */

import type { AgentId, SessionInfo } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerInterface, SessionRunnerRegistry } from "../session-runner.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { provisionProviderAccountCredentials } from "../session-agent-credentials.js";
import { routeFromSelection } from "../provider-route-preflight.js";
import { ServiceError } from "./types.js";

/**
 * docs/150 reqs 3, 7, 8 — does this session's pinned route need to move before
 * its next turn?
 *
 * Cheap and side-effect free, so a caller can ask it at a point where doing the
 * move would be unsafe. `runAgentWithMessage` uses exactly that: it asks before
 * it captures the resident streaming process, and releases the process if the
 * answer is yes — the switch itself still happens once, later, inside
 * `prepareSessionAgentEnvironment` where all routing lives.
 *
 * Answers `false` for an unpinned session (the first-turn path already routes
 * through the router) and for reserved env/API-key routes (metered billing has
 * no subscription window to exhaust, and req 12 forbids moving a turn off one
 * for quota reasons anyway).
 */
export function sessionNeedsAccountFailover(
  session: Pick<SessionInfo, "agentId" | "providerRouteKind" | "providerRouteId" | "model"> | undefined,
  providerAccountManager: Pick<ProviderAccountManager, "isRouteUsableForTurn"> | undefined,
): boolean {
  if (!session || !providerAccountManager) return false;
  const { agentId, providerRouteKind, providerRouteId } = session;
  if (!agentId || providerRouteKind !== "account" || !providerRouteId) return false;
  return !providerAccountManager.isRouteUsableForTurn(
    agentId,
    { kind: "account", id: providerRouteId },
    session.model === undefined ? {} : { model: session.model },
  );
}

export interface SwitchSessionProviderAccountDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  providerAccountManager: ProviderAccountManager;
  credentialsDir: string;
}

export interface SwitchSessionProviderAccountResult {
  sessionId: string;
  provider: AgentId;
  fromAccountId: string | undefined;
  toAccountId: string;
  /** The resume id carried across the switch — `undefined` if the session had none yet. */
  agentSessionId: string | undefined;
  /** True when a live agent process had to be killed to release the old token. */
  killedRunningAgent: boolean;
}

/**
 * Repoint `sessionId` at `toAccountId`.
 *
 * Refuses rather than guesses when the move is not obviously safe: unknown
 * session, unknown/foreign-provider target account, an account that is not
 * usable, or a session that is mid-turn. A caller that legitimately needs to
 * preempt a running turn (failover on mid-turn exhaustion, req 14) stops the
 * turn first and then calls this — that ordering is the caller's decision to
 * make, not something this function should do silently on their behalf.
 */
export function switchSessionProviderAccount(
  sessionId: string,
  toAccountId: string,
  deps: SwitchSessionProviderAccountDeps,
): SwitchSessionProviderAccountResult {
  const session = deps.sessionManager.get(sessionId);
  if (!session) throw new ServiceError(404, "Session not found");

  const provider = session.agentId;
  if (!provider) throw new ServiceError(409, "Session has no pinned agent to switch");

  const target = deps.providerAccountManager
    .list(provider)
    .find((account) => account.id === toAccountId);
  if (!target) {
    throw new ServiceError(404, `No ${provider} account ${toAccountId}`);
  }
  if (target.status !== "ready" && target.status !== "authenticating") {
    throw new ServiceError(409, `Account ${toAccountId} is not usable (status: ${target.status})`);
  }

  const fromAccountId =
    session.providerRouteKind === "account" ? session.providerRouteId : undefined;
  if (fromAccountId === toAccountId) {
    return {
      sessionId,
      provider,
      fromAccountId,
      toAccountId,
      agentSessionId: session.agentSessionId,
      killedRunningAgent: false,
    };
  }

  const runner = deps.runnerRegistry.get(sessionId);
  if (runner?.running) {
    throw new ServiceError(409, "Cannot switch accounts while a turn is running");
  }

  // Kill first: a live process holds the outgoing account's token in memory and
  // would keep spending it regardless of what we write to disk.
  let killedRunningAgent = false;
  const agent = runner?.getAgent() ?? null;
  if (agent) {
    try {
      agent.kill();
    } catch {
      // A process that is already gone is the state we wanted; the reprovision
      // below is what actually matters and must not be skipped because a dead
      // handle threw.
    }
    runner?.setAgent(null);
    killedRunningAgent = true;
  }

  // Rewrite credentials from the incoming account, preserving the resume files.
  provisionProviderAccountCredentials(deps.credentialsDir, sessionId, provider, toAccountId);

  // Persist the new route. `agentSessionId` is deliberately left alone — it is
  // what makes the next turn resume the same conversation (req 9).
  deps.sessionManager.setProviderRoute(sessionId, "account", toAccountId);

  return {
    sessionId,
    provider,
    fromAccountId,
    toAccountId,
    agentSessionId: session.agentSessionId,
    killedRunningAgent,
  };
}

/**
 * The move a failover made, for the caller to report to the user (req 11).
 * Labels are the user's own account names, because "moved from acct_9f3e… to
 * acct_1b77…" tells them nothing about which subscription is now paying.
 */
export interface PinnedAccountFailover {
  provider: AgentId;
  fromAccountId: string;
  fromLabel: string;
  toAccountId: string;
  toLabel: string;
}

export interface FailoverPinnedSessionDeps {
  sessionManager: Pick<SessionManager, "get" | "setProviderRoute">;
  providerAccountManager: Pick<
    ProviderAccountManager,
    "isRouteUsableForTurn" | "selectAccountForTurn" | "get"
  >;
  credentialsDir: string;
}

/**
 * docs/150 reqs 3, 7, 8 — move a pinned session onto the next eligible account
 * when the one it is pinned to can no longer run a turn.
 *
 * Returns `null` when nothing needed to change (the common case, checked on
 * every turn). **Throws** `ProviderRouteUnavailableError` when the pinned
 * account is spent and no other account can serve the turn — reqs 8 + 13
 * together: failover applies to existing sessions, and when it has nowhere to
 * go the turn fails immediately with the earliest reset time.
 *
 * The conversation survives because `provisionProviderAccountCredentials`
 * preserves the resume files and `agentSessionId` is left untouched — the same
 * guarantee `switchSessionProviderAccount` above documents and relies on.
 *
 * Deliberately does NOT consult a running turn: the caller is the turn's own
 * pre-spawn step, so "a turn is running" is always true and would refuse every
 * failover. Killing the resident process is exactly the point — it holds the
 * outgoing account's token in memory.
 */
export function failoverPinnedSession(
  runner: Pick<SessionRunnerInterface, "getAgent" | "setAgent"> | null,
  sessionId: string,
  deps: FailoverPinnedSessionDeps,
): PinnedAccountFailover | null {
  const session = deps.sessionManager.get(sessionId);
  if (!sessionNeedsAccountFailover(session, deps.providerAccountManager)) return null;
  // Narrowing: `sessionNeedsAccountFailover` already established all three.
  const provider = session?.agentId;
  const fromAccountId = session?.providerRouteId;
  if (!session || !provider || !fromAccountId) return null;

  // Re-run the router rather than "pick the next one in the list": it is the
  // single place that knows the priority order, the exhaustion rules, and req
  // 12's refusal to roll onto metered billing. A blocking failure throws from
  // here, which is what makes req 13 apply to existing sessions too.
  const next = routeFromSelection(
    provider,
    deps.providerAccountManager.selectAccountForTurn(
      provider,
      session.model === undefined ? {} : { model: session.model },
    ),
  );
  // A reserved route is not a failover target (req 12), and re-selecting the
  // same account would mean the router disagrees with `isRouteUsableForTurn` —
  // in either case, leave the session where it is rather than churn it.
  if (!next || next.kind !== "account" || next.id === fromAccountId) return null;

  // Kill first: a live process keeps spending the outgoing account's token
  // regardless of what we write to disk.
  const agent = runner?.getAgent() ?? null;
  if (agent) {
    try {
      agent.kill();
    } catch {
      // Already gone is the state we wanted; the reprovision below is what
      // matters and must not be skipped because a dead handle threw.
    }
    runner?.setAgent(null);
  }

  provisionProviderAccountCredentials(deps.credentialsDir, sessionId, provider, next.id);
  deps.sessionManager.setProviderRoute(sessionId, "account", next.id);

  const accountLabel = (id: string): string =>
    deps.providerAccountManager.get(provider, id)?.label ?? id;
  return {
    provider,
    fromAccountId,
    fromLabel: accountLabel(fromAccountId),
    toAccountId: next.id,
    toLabel: accountLabel(next.id),
  };
}
