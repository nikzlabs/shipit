import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
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
      ctx.chatHistoryManager.updateLastMessage(opts.sessionId, {
        commitHash,
        parentCommitHash: parentHash,
      });
      const messages = ctx.chatHistoryManager.load(opts.sessionId);
      opts.emit({
        type: "commit_linked",
        messageIndex: messages.length - 1,
        commitHash,
        parentCommitHash: parentHash,
      });
    }
    return commitHash;
  });
}
