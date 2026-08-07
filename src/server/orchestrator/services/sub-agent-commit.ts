/**
 * Commit the work a sub-agent consult left in the workspace after its parent
 * turn had already ended (planning#301, docs/144).
 *
 * ## The hole this closes
 *
 * `postTurnCommit` is a *turn-end* hook — it is reachable only from the four
 * terminal paths a turn can end on (`turn-executor.ts`). A `shipit agent run`
 * does not end a turn: `shipit-docs/agent.md` actively tells the agent to
 * BACKGROUND a long consult, and the transport allows it 35 minutes, so the
 * normal shape is a spawn whose HTTP call outlives the turn that started it. In
 * the incident that produced this module the parent turn auto-committed and
 * pushed at 14:10:56; the Codex consult finished at 14:22:36 and wrote into the
 * same workspace with nothing left scheduled to commit it. Two consequences,
 * both observed:
 *
 *  - **The work missed the PR.** It was in no commit at the moment the PR was
 *    reviewed and merged — reported twice as "changes missing from the merged PR".
 *  - **It silently blocked the docs/218 pre-turn auto-reset.** `computeResetEligible`
 *    requires `git.isClean()`; a tree left dirty by a finished consult fails that
 *    clause, so the merged session was never synced back to base and the next
 *    turn authored a commit onto an already-merged branch.
 *
 * ## Shape of the fix
 *
 * One commit path, not a third one: `flushPendingTurnCommit` already exists for
 * the structurally identical problem on the `gh pr create` route (docs/116,
 * "Commit flush") — the agent asks for something that must see its edits before
 * `postTurnCommit` has fired. It carries the secret scan (docs/213) and the
 * conflict notice, and refuses the commit on a secret finding. This module adds
 * only what that helper deliberately leaves to its caller: the workspace mutex,
 * the session-kind gates, the push, and the user-visible notice.
 *
 * Deliberate non-choices, each of which was the tempting one:
 *
 *  - **Not `postTurnCommit`.** It ends by writing `commit_hash` /
 *    `parent_commit_hash` onto the last *finalized* assistant message
 *    (`updateLastMessage`). Outside a turn that row belongs to the PREVIOUS turn
 *    and already carries that turn's commit link, so calling it here would
 *    silently repoint a finished turn's rewind target at a commit that turn did
 *    not make.
 *  - **Not "commit unconditionally".** A consult that finishes while its parent
 *    turn is still running (the foreground case — the invoking agent is blocked
 *    on it) needs nothing from us: `postTurnCommit` will pick the edits up at
 *    turn end, and committing early would split one turn's work across two
 *    commits with two different subjects.
 *  - **Not a bespoke push.** The push is armed through
 *    `runner.schedulePostTurnPush()`, which delegates to the same
 *    `SystemTurnDeps.scheduleAutoPush` closure the post-turn path pushes
 *    through — so gates added there (notably the merged-PR gate) apply here
 *    without being written twice.
 *
 * Fail-safe throughout: nothing in here may break the consult's result delivery.
 * Every failure is caught and logged; the card, the persisted output and
 * `shipit agent result` are unaffected.
 */

import type { GitManager } from "../../shared/git.js";
import type { AgentId } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { withWorkspaceLock } from "./marketplace.js";
import { flushPendingTurnCommit } from "./github.js";
import { getErrorMessage } from "../validation.js";

export interface SubAgentCommitDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  /**
   * Optional so the extreme-minimal test setups that exercise the spawn gates
   * (and any runtime without a git-backed workspace) keep working. Absent ⇒ the
   * commit is skipped, which is exactly the pre-planning#301 behavior.
   */
  createGitManager?: (dir: string) => GitManager;
  /** Only `append` is used — the post-turn notice path. */
  chatHistoryManager: { append(sessionId: string, message: PersistedMessage): unknown };
}

/**
 * The commit subject. Attributable by construction: a reader looking at the
 * branch must be able to tell this commit came from a consult that finished
 * outside a turn, not from an agent turn. Kept to one line — `autoCommit` takes
 * the subject only.
 */
export function subAgentCommitSubject(subAgentId: AgentId): string {
  return `Sub-agent consult (${subAgentId}): work committed after the turn ended`;
}

/**
 * Commit whatever a finished sub-agent run left in the session workspace, if
 * the parent turn is already over. Returns the commit hash, or null when
 * nothing was committed (no work, turn still running, gated session kind, or a
 * failure — all of which are non-events for the caller).
 *
 * Never throws.
 */
export async function commitSubAgentWork(
  deps: SubAgentCommitDeps,
  sessionId: string,
  run: { spawnId: string; subAgentId: AgentId },
): Promise<string | null> {
  try {
    if (!deps.createGitManager) return null;

    const session = deps.sessionManager.get(sessionId);
    // docs/211 — a sandbox session has NO root git repo (the agent clones into
    // subdirs), so `autoCommit` would error on the non-repo root. Skipped by
    // KIND, exactly as `postTurnCommit` does, not inferred from `remoteUrl`.
    if (!session || session.kind === "sandbox") return null;

    // Re-resolve the runner at completion time rather than reusing the one the
    // spawn started with: a restart / idle dispose replaces it, and the stale
    // handle would emit into nothing and push through a dead closure.
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) return null;

    // The whole point of this path is the turn that is already OVER. A consult
    // that lands mid-turn is the ordinary post-turn commit's business; taking
    // it here would split one turn into two commits under two subjects.
    if (runner.running) return null;

    const subject = subAgentCommitSubject(run.subAgentId);

    // docs/149 — the same per-workspace mutex `postTurnCommit` takes. A consult
    // finishing while a new turn is starting is a real race: two concurrent
    // `git add -A` runs on one workspace. When nothing else holds it the mutex
    // resolves immediately.
    const commitHash = await withWorkspaceLock(runner.sessionDir, async () => {
      const git = deps.createGitManager!(runner.sessionDir);
      const { commitHash, secretBlocked } = await flushPendingTurnCommit(git, {
        sessionId,
        runnerRegistry: deps.runnerRegistry,
        chatHistory: deps.chatHistoryManager,
        summary: subject,
      });
      // docs/213 — a commit refused for a secret finding stays refused. The
      // redacted warning was already emitted + persisted by the flush; the tree
      // stays dirty on purpose, because scrubbing it is the agent's job.
      if (secretBlocked || !commitHash) return null;
      return commitHash;
    });

    if (!commitHash) return null;

    // docs/128 — an ops session's workspace is a throwaway cockpit with no
    // remote and no branch lifecycle; it COMMITS (the history is part of the
    // incident log) but must never auto-push. Same gate `postTurnCommit` applies
    // to the post-turn push.
    if (session.kind !== "ops") runner.schedulePostTurnPush();

    console.log(
      `[sub-agent] post-turn-commit session=${sessionId} spawn=${run.spawnId} `
      + `agent=${run.subAgentId} commit=${commitHash.slice(0, 8)} pushed=${session.kind !== "ops"}`,
    );

    // This incident is fundamentally about an invisible state change: work
    // appeared in the branch with nothing in the transcript saying so. One
    // persisted line is cheap and makes it legible. Post-turn by construction
    // (the running check above), so `emitNoticePostTurn`'s append is the right
    // persist path — an in-progress persist here would revive the finished turn.
    emitNoticePostTurn(
      (m) => runner.emitMessage(m),
      deps.chatHistoryManager,
      sessionId,
      `Committed changes left by the ${run.subAgentId} consult, which finished after the turn ended (\`${commitHash.slice(0, 8)}\`).`,
      "info",
    );

    return commitHash;
  } catch (err) {
    // Fail-safe: the consult's result delivery must not depend on this.
    console.warn(
      `[sub-agent] post-turn-commit-failed session=${sessionId} spawn=${run.spawnId} `
      + `agent=${run.subAgentId}: ${getErrorMessage(err)}`,
    );
    return null;
  }
}
