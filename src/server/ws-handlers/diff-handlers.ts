import type { WsClientMessage } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsRejectChanges = Extract<WsClientMessage, { type: "reject_changes" }>;

export async function handleRejectChanges(ctx: HandlerContext, msg: WsRejectChanges): Promise<void> {
  try {
    if (!msg.fromCommit) {
      ctx.send({ type: "error", message: "reject_changes requires fromCommit" });
      return;
    }

    const git = ctx.getActiveGitManager();
    const filesToRevert = msg.files.length > 0 ? msg.files : [];

    if (filesToRevert.length === 0) {
      // Revert all — hard reset to fromCommit
      await git.rollback(msg.fromCommit);
      ctx.send({ type: "reject_changes_complete", revertedFiles: [], commitHash: msg.fromCommit });
    } else {
      // Revert specific files
      await git.checkoutFiles(msg.fromCommit, filesToRevert);
      const hash = await git.autoCommit(`Revert ${filesToRevert.length} file(s)`);
      ctx.send({
        type: "reject_changes_complete",
        revertedFiles: filesToRevert,
        commitHash: hash ?? msg.fromCommit,
      });
    }

    // Restart preview since files changed
    ctx.previewManager.restart(ctx.getActiveDir());
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to reject changes: ${getErrorMessage(err)}` });
  }
}
