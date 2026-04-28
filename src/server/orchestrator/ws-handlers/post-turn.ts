import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type PostTurnCtx = Pick<ConnectionCtx & AppCtx, "createGitManager" | "chatHistoryManager"> & {
  getTurnSummary: () => string;
  scheduleAutoPush: (git: ReturnType<AppCtx["createGitManager"]>, sessionId?: string) => void;
};

/**
 * Auto-commit working tree changes after an agent turn and link the commit to
 * the last assistant message in chat history. Returns the commit hash or null.
 *
 * Callers may pass `opts.turnSummary` explicitly. This is required when the
 * caller cannot rely on `ctx.getTurnSummary()` because the WebSocket has
 * detached (the ctx getter goes through the per-connection `attachedRunner`,
 * which is null after disconnect — the queue-drain path is the main case).
 */
export async function postTurnCommit(
  ctx: PostTurnCtx,
  opts: {
    sessionDir: string;
    sessionId: string | undefined;
    emit: (msg: WsServerMessage) => void;
    /** Explicit turn summary; falls back to ctx.getTurnSummary() if omitted. */
    turnSummary?: string;
  },
): Promise<string | null> {
  const git = ctx.createGitManager(opts.sessionDir);
  const parentHash = await git.getHeadHash();
  const summary = opts.turnSummary ?? ctx.getTurnSummary();
  const firstLine = summary.split("\n")[0]?.slice(0, 120) || "Agent turn";
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
}
