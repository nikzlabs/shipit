import type { WsClientMessage, FileDiff } from "../types.js";
import type { HandlerContext } from "./types.js";
import { getErrorMessage } from "../validation.js";

type WsGetTurnDiff = Extract<WsClientMessage, { type: "get_turn_diff" }>;
type WsRejectChanges = Extract<WsClientMessage, { type: "reject_changes" }>;

export async function handleGetTurnDiff(ctx: HandlerContext, msg: WsGetTurnDiff): Promise<void> {
  try {
    if (!msg.fromCommit || !msg.toCommit) {
      ctx.send({ type: "error", message: "get_turn_diff requires fromCommit and toCommit" });
      return;
    }

    const git = ctx.getActiveGitManager();
    const changedFiles = await git.diffNameStatus(msg.fromCommit, msg.toCommit);
    const diffSummary = await git.diffSummary();

    // Build a lookup of insertions/deletions by file path
    const statsMap = new Map<string, { insertions: number; deletions: number }>();
    for (const f of diffSummary) {
      statsMap.set(f.file, { insertions: f.insertions, deletions: f.deletions });
    }

    const files: FileDiff[] = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (const entry of changedFiles) {
      const stats = statsMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      const isBinary = stats.insertions === 0 && stats.deletions === 0 && entry.status !== "D";

      let status: FileDiff["status"];
      switch (entry.status) {
        case "A": status = "added"; break;
        case "D": status = "deleted"; break;
        case "R": status = "renamed"; break;
        default: status = "modified"; break;
      }

      let oldContent = "";
      let newContent = "";

      if (!isBinary) {
        if (status === "deleted") {
          oldContent = await git.getFileAtCommit(msg.fromCommit, entry.path);
        } else if (status === "added") {
          newContent = await git.getFileAtCommit(msg.toCommit, entry.path);
        } else if (status === "renamed") {
          oldContent = await git.getFileAtCommit(msg.fromCommit, entry.oldPath ?? entry.path);
          newContent = await git.getFileAtCommit(msg.toCommit, entry.path);
        } else {
          oldContent = await git.getFileAtCommit(msg.fromCommit, entry.path);
          newContent = await git.getFileAtCommit(msg.toCommit, entry.path);
        }
      }

      totalInsertions += stats.insertions;
      totalDeletions += stats.deletions;

      files.push({
        path: entry.path,
        oldPath: entry.oldPath,
        status,
        insertions: stats.insertions,
        deletions: stats.deletions,
        binary: isBinary,
        oldContent,
        newContent,
      });
    }

    ctx.send({
      type: "turn_diff",
      fromCommit: msg.fromCommit,
      toCommit: msg.toCommit,
      files,
      stats: { totalInsertions, totalDeletions, filesChanged: files.length },
    });
  } catch (err) {
    ctx.send({ type: "error", message: `Failed to get diff: ${getErrorMessage(err)}` });
  }
}

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
