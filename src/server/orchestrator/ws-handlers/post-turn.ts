import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "../services/marketplace.js";
import { formatUnresolvedConflictNotice } from "../services/conflict-marker-notice.js";
import { formatSecretScanNotice } from "../services/secret-scan-notice.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { chownWorkspaceGitToSessionWorker } from "../session-worker-uid.js";

/** Minimal handler context — postTurnCommit only needs git + chat history + auto-push + the session kind gate. */
type PostTurnCtx = Pick<ConnectionCtx & AppCtx, "createGitManager" | "chatHistoryManager" | "sessionManager"> & {
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
     * HEAD captured when the turn started. If the agent performs its own clean
     * git operation during the turn (for example a rebase), autoCommit() sees
     * no working-tree changes. We still need to auto-push when the branch tip
     * moved.
     */
    turnStartHeadHash?: string | null;
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
  // docs/211 — the sandbox invariant: a `kind === "sandbox"` session has NO root
  // git repo (the agent clones into subdirs), so session-level auto-commit /
  // auto-push / PR card are skipped *explicitly by kind*, not inferred from
  // `remoteUrl`. `git.autoCommit()` runs unconditionally below and would error on
  // the non-repo root otherwise. Returning null also short-circuits the caller's
  // PR-lifecycle flow (`runCommitAndPr` only runs it when a commit hash comes
  // back), so no PR card or push fires for a sandbox.
  if (opts.sessionId && ctx.sessionManager.get(opts.sessionId)?.kind === "sandbox") {
    return null;
  }
  return withWorkspaceLock(opts.sessionDir, async () => {
    try {
      return await commitInLock();
    } finally {
      // docs/150 §7 addendum: the git ops above run as the root orchestrator and
      // write into the worker-owned (uid 1000) workspace — `git status` refreshes
      // `.git/index`, and a commit writes objects/refs/reflogs. Left root:root,
      // they block the agent's next in-container `git` (which appends to the
      // root-owned reflog). Hand `.git` back here, on every path (commit, no-op,
      // throw). No-op unless SHIPIT_SESSION_WORKER_UID is set.
      chownWorkspaceGitToSessionWorker(opts.sessionDir);
    }
  });

  async function commitInLock(): Promise<string | null> {
    const git = ctx.createGitManager(opts.sessionDir);
    const parentHash = await git.getHeadHash();
    const firstLine = opts.turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
    const { commitHash, conflictedFiles, rebaseInProgress, secretFindings } = await git.autoCommit(firstLine);
    if (secretFindings.length > 0 && opts.sessionId) {
      // docs/213 — the commit was refused because the staged diff carried a
      // likely secret. Persist (append + emit) the redacted warning so it
      // survives a reload, exactly like the conflict notice below. commitHash
      // is null, so the no-commit path below short-circuits push + PR.
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        opts.sessionId,
        formatSecretScanNotice(secretFindings),
        "warn",
      );
    }
    if ((conflictedFiles.length > 0 || rebaseInProgress) && opts.sessionId) {
      // Persisted (append + emit), not emit-only, so the conflict warning
      // survives a reload. It fires after the turn's final persist, so
      // appending lands it at the current end of history — the right spot.
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        opts.sessionId,
        formatUnresolvedConflictNotice({ conflictedFiles, rebaseInProgress }),
        "warn",
      );
    }
    if (!commitHash) {
      const currentHeadHash = await git.getHeadHash();
      if (
        opts.turnStartHeadHash &&
        currentHeadHash &&
        currentHeadHash !== opts.turnStartHeadHash
      ) {
        ctx.scheduleAutoPush(git, opts.sessionId);
      }
      return null;
    }

    opts.emit({ type: "git_committed", hash: commitHash, message: firstLine });
    // docs/171 — release carve-out: auto-push pushes the session BRANCH only and
    // MUST NOT push tags. `scheduleAutoPush` → `GitManager.push(remote, branch)`
    // never passes `--tags` or a tag refspec, so a version-bump commit rides the
    // normal branch push while the release TAG is pushed separately and only
    // after explicit confirmation (the agent's `git push origin vX.Y.Z`, see
    // /shipit-docs/release.md). A published tag is outward-facing and effectively
    // irreversible, so it is never an automatic side-effect of a turn.
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
  }
}
