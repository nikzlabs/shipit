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

import type { AgentId } from "../../shared/types/agent-types.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import { provisionProviderAccountCredentials } from "../session-agent-credentials.js";
import { ServiceError } from "./types.js";

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
