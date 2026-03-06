import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";

/** Full handler context — send-message handlers need all three sub-contexts. */
type PostTurnCtx = Pick<ConnectionCtx & AppCtx, "createGitManager" | "chatHistoryManager"> & {
  getTurnSummary: () => string;
  scheduleAutoPush: (git: ReturnType<AppCtx["createGitManager"]>) => void;
};

/**
 * Auto-commit working tree changes after an agent turn and link the commit to
 * the last assistant message in chat history. Returns the commit hash or null.
 */
export async function postTurnCommit(
  ctx: PostTurnCtx,
  opts: {
    sessionDir: string;
    sessionId: string | undefined;
    emit: (msg: WsServerMessage) => void;
  },
): Promise<string | null> {
  const git = ctx.createGitManager(opts.sessionDir);
  const parentHash = await git.getHeadHash();
  const firstLine = ctx.getTurnSummary().split("\n")[0]?.slice(0, 120) || "Agent turn";
  const commitHash = await git.autoCommit(firstLine);
  if (!commitHash) return null;

  opts.emit({ type: "git_committed", hash: commitHash, message: firstLine });
  ctx.scheduleAutoPush(git);

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
