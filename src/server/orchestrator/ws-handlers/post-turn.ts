import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "../services/marketplace.js";
import { formatUnresolvedConflictNotice } from "../services/conflict-marker-notice.js";
import { recordSecretBlock, clearSecretBlock } from "../services/secret-block.js";
import { evaluateMergedBranchPush, formatMergedPushNotice } from "../services/merged-push-guard.js";
import { scanDiffForSecrets } from "../../shared/secret-scan.js";
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
  // docs/128 — an ops session's workspace is a throwaway cockpit (the ops
  // template's README + prompts, plus whatever the investigation writes). It
  // has no remote, no branch lifecycle and no PR card, and the way it fixes a
  // ShipIt bug is by spawning a `--shipit-source` session or filing an issue —
  // never by pushing itself. So it COMMITS (the workspace is a real repo and
  // the history is part of the incident log) but never auto-pushes.
  //
  // This is the second half of the ops-session push bug: `resolveGitHubRemote`
  // is no longer able to hand this workspace an `origin` behind a `gh pr list`,
  // and even if some other path does, the push never fires. Worth having both,
  // because the failure mode is an ops session pushing its template commits at
  // whatever repo it acquired, on branch `main` — that one was caught by
  // unrelated histories, which is luck, not a guarantee.
  //
  // Only the debounced POST-TURN push is gated. An explicit agent-driven
  // `gh pr create` still pushes through its own path, so a cwd-scoped clone
  // inside an ops workspace is unaffected.
  const isOpsSession =
    !!opts.sessionId && ctx.sessionManager.get(opts.sessionId)?.kind === "ops";
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

  /**
   * SHI-295 — the single auto-push site for this turn, gated on the merged-branch
   * guard (`services/merged-push-guard.ts`, which carries the full rationale).
   *
   * A merged session's branch has no open pull request and, on most repos, no
   * remote branch either — so the ordinary debounced push RECREATES it, stranding
   * the commit as an orphan nobody reviews. The commit above still stands (work is
   * never lost); only the silent push is refused, and only this one: an explicit
   * `gh pr create` pushes through its own force-pushing path, exactly like the
   * ops-session gate above.
   *
   * The refusal is loud by construction — it is the *silence* that made this a
   * user-reported bug twice, so a blocked push always leaves a persisted notice.
   */
  async function pushUnlessMerged(
    git: ReturnType<AppCtx["createGitManager"]>,
    commitHash: string | null,
  ): Promise<void> {
    if (isOpsSession) return;
    const sessionId = opts.sessionId;
    const block = sessionId
      ? await evaluateMergedBranchPush(
          ctx.sessionManager.get(sessionId),
          () => ctx.sessionManager.getPrStatus(sessionId),
          git,
        )
      : null;
    if (!block || !sessionId) {
      ctx.scheduleAutoPush(git, opts.sessionId);
      return;
    }
    console.warn(
      `[merged-push-guard] auto-push refused for ${sessionId}: pull request `
        + `${block.prNumber ? `#${block.prNumber}` : "(unknown)"} already merged and this commit `
        + `${commitHash ? `(${commitHash.slice(0, 7)}) ` : ""}is stacked on the merged tip.`,
    );
    try {
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        sessionId,
        formatMergedPushNotice(block, commitHash),
        "warn",
      );
    } catch (err) {
      // The notice is the point, but it must not be able to fail the turn: this
      // runs inside the post-turn commit, whose caller treats a throw as "the
      // commit failed" and skips the PR flow. Losing the notice is bad; losing
      // the PR card because the notice threw is worse.
      console.error(`[merged-push-guard] notice failed for ${sessionId}:`, err);
    }
  }

  async function commitInLock(): Promise<string | null> {
    const git = ctx.createGitManager(opts.sessionDir);
    const parentHash = await git.getHeadHash();
    const firstLine = opts.turnSummary.split("\n")[0]?.slice(0, 120) || "Agent turn";
    const { commitHash, conflictedFiles, rebaseInProgress, secretFindings } = await git.autoCommit(firstLine);
    if (secretFindings.length > 0 && opts.sessionId) {
      // docs/213 / SHI-315 — the commit was refused because the staged diff
      // carried a likely secret. `recordSecretBlock` owns all three responses:
      // the persisted redacted notice (as before), the sticky banner state, and
      // a bounded remediation turn so the agent learns its work did not land.
      // commitHash is null, so the no-commit path below short-circuits push + PR.
      recordSecretBlock(
        {
          sessionId: opts.sessionId,
          sessionManager: ctx.sessionManager,
          chatHistory: ctx.chatHistoryManager,
          emit: opts.emit,
          runner: opts.runner,
        },
        secretFindings,
      );
    }
    // SHI-315 — the scan actually ran and came back clean, so any standing block
    // is over. Deliberately NOT cleared on the conflict/rebase branch:
    // `autoCommit` returns there BEFORE staging or scanning, so a secret still in
    // the tree would go unscanned and the banner would clear on a lie. Only "no
    // findings, and nothing stopped us from looking" retires the block — which
    // covers both a successful commit and a genuinely clean tree.
    if (opts.sessionId && secretFindings.length === 0 && conflictedFiles.length === 0 && !rebaseInProgress) {
      clearSecretBlock({
        sessionId: opts.sessionId,
        sessionManager: ctx.sessionManager,
        emit: opts.emit,
      });
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
        // docs/213 — the agent moved HEAD itself this turn (e.g. it ran its own
        // `git commit`), so `autoCommit` saw a clean tree and never scanned that
        // content. Guard the auto-push: if the move is a pure ADDITION on top of
        // the turn-start HEAD (turnStartHead is an ancestor of HEAD), scan the
        // newly-added commits and refuse the push on a finding. If history was
        // rewritten instead (rebase/amend/reset — turnStartHead is NOT an
        // ancestor), skip the scan: those commits replay pre-existing history, so
        // re-flagging them would false-block a legitimate rebase (and any secret
        // there is already in history, not newly introduced this turn).
        const addedOnTop = await git.isAncestor(opts.turnStartHeadHash, currentHeadHash);
        if (addedOnTop) {
          const findings = scanDiffForSecrets(
            await git.diffRange(opts.turnStartHeadHash, currentHeadHash),
          );
          if (findings.length > 0) {
            if (opts.sessionId) {
              recordSecretBlock(
                {
                  sessionId: opts.sessionId,
                  sessionManager: ctx.sessionManager,
                  chatHistory: ctx.chatHistoryManager,
                  emit: opts.emit,
                  runner: opts.runner,
                },
                findings,
              );
            }
            // Do NOT push the secret-bearing commit(s). It stays local; the agent
            // must amend/scrub it before it can reach the remote.
            return null;
          }
        }
        await pushUnlessMerged(git, currentHeadHash);
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
    await pushUnlessMerged(git, commitHash);

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
