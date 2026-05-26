import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "../services/marketplace.js";

/** Minimal handler context — postTurnCommit only needs git + chat history + auto-push. */
type PostTurnCtx = Pick<ConnectionCtx & AppCtx, "createGitManager" | "chatHistoryManager"> & {
  scheduleAutoPush: (git: ReturnType<AppCtx["createGitManager"]>, sessionId?: string) => void;
};

/**
 * Auto-commit working tree changes after an agent turn and link the commit to
 * the last assistant message in chat history. Returns the commit hash or null.
 *
 * `turnSummary` is required and must be supplied by the caller from the
 * captured runner (`runner.turnSummary`). It used to fall back to
 * `ctx.getTurnSummary()`, but that getter routes through the per-connection
 * `attachedRunner` and silently returns "" after WS disconnect — see feature
 * 095 for context.
 *
 * Wrapped in the per-workspace mutex shared with `services/marketplace.ts` so
 * a plugin-install path-scoped `git add` cannot race the post-turn `git add -A`
 * on the same workspace (docs/149). When no install is in flight the mutex
 * resolves immediately.
 */
export async function postTurnCommit(
  ctx: PostTurnCtx,
  opts: {
    sessionDir: string;
    sessionId: string | undefined;
    emit: (msg: WsServerMessage) => void;
    turnSummary: string;
    /**
     * The runner that owns this turn. When provided, the commit info is also
     * stashed on `runner.pendingCommitLink` so the agent_result handler in
     * `wireAgentListeners` can apply it after `replaceInProgress` finalizes
     * the chat rows. Without this fallback, a turn where `agent_result`
     * persists the rows AFTER `postTurnCommit` runs (codex sometimes emits
     * two `turn/completed` events) ends up with a successful commit but no
     * commit_hash on any chat row — so the rewind preview shows "0 files".
     */
    runner?: SessionRunnerInterface | null;
  },
): Promise<string | null> {
  return withWorkspaceLock(opts.sessionDir, async () => {
    const git = ctx.createGitManager(opts.sessionDir);
    const parentHash = await git.getHeadHash();
    const firstLine = opts.turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
    const commitHash = await git.autoCommit(firstLine);
    if (!commitHash) return null;

    opts.emit({ type: "git_committed", hash: commitHash, message: firstLine });
    ctx.scheduleAutoPush(git, opts.sessionId);

    if (opts.sessionId && parentHash) {
      // Stash the link info on the runner FIRST so the agent_result handler
      // can retry the link if our updateLastMessage call below finds no
      // in_progress=0 rows yet (the racy case described above).
      if (opts.runner) {
        opts.runner.pendingCommitLink = { commitHash, parentCommitHash: parentHash };
      }
      const updatedId = ctx.chatHistoryManager.updateLastMessage(opts.sessionId, {
        commitHash,
        parentCommitHash: parentHash,
      });
      if (updatedId !== null) {
        if (opts.runner) opts.runner.pendingCommitLink = null;
        const messageIndex = ctx.chatHistoryManager.indexOfMessageId(opts.sessionId, updatedId);
        if (messageIndex >= 0) {
          opts.emit({
            type: "commit_linked",
            messageIndex,
            commitHash,
            parentCommitHash: parentHash,
          });
        }
      }
    }
    return commitHash;
  });
}
