import type { WsServerMessage } from "../../shared/types.js";
import type { ConnectionCtx, AppCtx } from "./types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import { withWorkspaceLock } from "../services/marketplace.js";
import { formatUnresolvedConflictNotice } from "../services/conflict-marker-notice.js";
import { recordSecretBlock, clearSecretBlock } from "../services/secret-block.js";
import { evaluateMergedBranchPush, formatMergedPushNotice } from "../services/merged-push-guard.js";
import { scanDiffForSecrets } from "../../shared/secret-scan.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import { sessionAutoCommitAllowed } from "../services/auto-commit-gate.js";
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
  // docs/128 / docs/211 — ShipIt does not auto-commit an `ops` or `sandbox`
  // session. The rule and its full rationale live in ONE place,
  // `services/auto-commit-gate.ts`; this is one of its five consult sites.
  //
  // Two kinds, one gate, for two originally-different reasons:
  //   - **sandbox** has NO root git repo (the agent clones into subdirs), so the
  //     unconditional `git.autoCommit()` below would error on the non-repo root.
  //   - **ops** is a throwaway host-debugging cockpit with no remote, no branch
  //     lifecycle and no PR card. docs/128 originally let it COMMIT (calling the
  //     workspace history "part of the incident log") while gating only the
  //     push. That decision is REVERSED at the operator's request: an ops
  //     session's history is no longer an incident log, and the ops agent is
  //     told in its system prompt (`prompts/git-workflow-ops.md`) that it owns
  //     git itself — so anything an investigation wants to keep is committed
  //     deliberately by the agent, filed as an issue, or carried into a
  //     `--shipit-source` fix session.
  //
  // Gated by KIND, never inferred from `remoteUrl`. Returning null also
  // short-circuits the caller's PR-lifecycle flow (`runCommitAndPr` only runs it
  // when a commit hash comes back), so no push and no PR card fire either.
  //
  // Only ShipIt's automatic commit is refused. An explicit agent-driven
  // `gh pr create` still commits + pushes through its own path, so a cwd-scoped
  // clone inside an ops workspace is unaffected.
  if (!sessionAutoCommitAllowed(ctx.sessionManager, opts.sessionId)) {
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

  /**
   * planning#297 — the single auto-push site for this turn, gated on the merged-branch
   * guard (`services/merged-push-guard.ts`, which carries the full rationale).
   *
   * A merged session's branch has no open pull request and, on most repos, no
   * remote branch either — so the ordinary debounced push RECREATES it, stranding
   * the commit as an orphan nobody reviews. The commit above still stands (work is
   * never lost); only the silent push is refused, and only this one: an explicit
   * `gh pr create` pushes through its own force-pushing path, exactly like the
   * auto-commit gate above.
   *
   * The refusal is loud by construction — it is the *silence* that made this a
   * user-reported bug twice, so a blocked push always leaves a persisted notice.
   *
   * No ops/sandbox check here: those kinds return at the top of `postTurnCommit`
   * and never reach this function at all.
   */
  async function pushUnlessMerged(
    git: ReturnType<AppCtx["createGitManager"]>,
    commitHash: string | null,
  ): Promise<void> {
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
    const { commitHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable } = await git.autoCommit(firstLine);
    // docs/266 reqs 14 + 15 — orchestrator git now runs as the session's uid, so
    // for the first time it can hit workspace content it cannot read (a compose
    // service running at its own explicit `user:`). The two outcomes need
    // different words, which is why they are two requirements and not one: an
    // unreadable DIRECTORY leaves a commit that exists and is short, an
    // unreadable FILE leaves no commit at all. Persisted, not logged — the whole
    // point is that git's exit codes report success in the first case and
    // `postTurnStep` would swallow the second into a log line nobody reads.
    if (unreadable && opts.sessionId) {
      emitNoticePostTurn(
        opts.emit,
        ctx.chatHistoryManager,
        opts.sessionId,
        unreadable.kind === "omitted"
          ? `This commit is short. ShipIt could not read \`${unreadable.detail}\` in your workspace, `
            + "so its contents were left out of the commit — everything else was committed normally. "
            + "A service in your `docker-compose.yml` running as its own `user:` is the usual cause; "
            + "gitignoring that path removes the problem entirely."
          : `This turn was NOT committed. ShipIt could not read \`${unreadable.detail}\`, and \`git add\` `
            + "stages nothing at all when that happens — so the rest of the turn's work is still in the "
            + "working tree, uncommitted. Fix that path's permissions (or gitignore it) and the next turn "
            + "will commit everything.",
        "warn",
      );
    }
    if (secretFindings.length > 0 && opts.sessionId) {
      // docs/213 / planning#317 — the commit was refused because the staged diff
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
    // planning#317 — the scan actually ran and came back clean, so any standing block
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
