import { noteMergePerformed } from "./services/merge-attribution.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type {
  AutoMergeManagedReason,
  AutoMergeState,
  BranchSyncStatus,
  PrAutoMergeError,
  PrStatusSummary,
} from "../shared/types/github-types.js";

export class AutoMergeManager {
  private states = new Map<string, AutoMergeState>();
  private busyLogged = new Set<string>();
  private syncLogged = new Set<string>();

  constructor(
    private readonly githubAuth: GitHubAuthManager,
    private readonly onChange: (sessionId: string) => void,
    private readonly getRunner?: (sessionId: string) => SessionRunnerInterface | undefined,
    private readonly resolveSync?: (
      sessionId: string,
      headBranch: string,
    ) => Promise<BranchSyncStatus | undefined>,
  ) {}

  get(sessionId: string): AutoMergeState | undefined {
    return this.states.get(sessionId);
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.busyLogged.delete(sessionId);
    this.syncLogged.delete(sessionId);
  }

  setEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled, mergeMethod: "squash" };
      this.states.set(sessionId, state);
    } else {
      state.enabled = enabled;
      this.busyLogged.delete(sessionId);
      this.syncLogged.delete(sessionId);
      delete state.completed;
      if (enabled) {
        delete state.error;
      } else {
        state.managed = false;
        delete state.managedReason;
        delete state.settingsUrl;
        delete state.reason;
      }
    }

    this.onChange(sessionId);
    return state;
  }

  setManaged(
    sessionId: string,
    managed: boolean,
    opts: { settingsUrl?: string; reason?: string; managedReason?: AutoMergeManagedReason } = {},
  ): void {
    const managedReason = managed ? opts.managedReason ?? "native-unavailable" : undefined;
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        enabled: false,
        mergeMethod: "squash",
        managed,
        managedReason,
        settingsUrl: opts.settingsUrl,
        reason: opts.reason,
      };
      this.states.set(sessionId, state);
    } else {
      state.managed = managed;
      state.managedReason = managedReason;
      state.settingsUrl = opts.settingsUrl;
      state.reason = opts.reason;
    }

    this.onChange(sessionId);
  }

  setError(sessionId: string, error: PrAutoMergeError): void {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: "squash", error };
      this.states.set(sessionId, state);
    } else {
      state.error = error;
    }

    this.onChange(sessionId);
  }

  setMergeMethod(sessionId: string, method: "squash" | "merge" | "rebase"): void {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled: false, mergeMethod: method };
      this.states.set(sessionId, state);
    } else {
      state.mergeMethod = method;
    }

    this.onChange(sessionId);
  }

  /**
   * `opts.checkoutMissing` — the session's clone is known to be gone from disk
   * (disk-evicted, or archived, which deletes a repo-backed checkout outright).
   * Hold: the poll-time gate below reads `undefined` as "cannot tell, don't
   * block", because that reading is stale by design — so an `ahead`/`diverged`
   * block that WOULD have fired is indistinguishable from `in-sync`, and ShipIt
   * would merge a remote branch that may be missing the session's last commits.
   * Until the crash in `pollRepo` was fixed this was unreachable: the throw
   * aborted the poll before any merge. Fixing the crash is what exposes it.
   */
  async handleManaged(
    sessionId: string,
    summary: PrStatusSummary,
    owner: string,
    repo: string,
    opts: { checkoutMissing?: boolean } = {},
  ): Promise<void> {
    const mergeState = this.states.get(sessionId);
    if (!mergeState?.enabled || !mergeState.managed) return;

    if (mergeState.completed) return;

    if (opts.checkoutMissing) {
      if (!this.syncLogged.has(sessionId)) {
        this.syncLogged.add(sessionId);
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}:`
          + " the session's checkout is not on disk, so its branch cannot be verified against GitHub",
        );
      }
      return;
    }

    if (summary.checks.state !== "success" && summary.checks.state !== "none") return;

    if (
      summary.reviewDecision === "review_required" ||
      summary.reviewDecision === "changes_requested"
    ) {
      return;
    }

    if (summary.mergeable === "conflicting") {
      if (mergeState.error) {
        delete mergeState.error;
        this.onChange(sessionId);
      }
      return;
    }

    if (summary.mergeable !== "mergeable") return;

    // A failed push can leave unshipped commits after agentBusy clears.
    const syncState = summary.branchSync?.state;
    if (syncState === "ahead" || syncState === "diverged") {
      if (!this.syncLogged.has(sessionId)) {
        this.syncLogged.add(sessionId);
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}:`
          + ` local branch is ${syncState} of ${summary.headBranch} on GitHub`,
        );
      }
      return;
    }
    this.syncLogged.delete(sessionId);

    // agentBusy covers post-turn commits and pushes; systemTurnInProgress covers branch rewrites.
    const runner = this.getRunner?.(sessionId);
    if (runner?.agentBusy || runner?.systemTurnInProgress) {
      if (!this.busyLogged.has(sessionId)) {
        this.busyLogged.add(sessionId);
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}: agent busy`,
        );
      }
      return;
    }
    this.busyLogged.delete(sessionId);

    // Fetch before merging: another clone can move the remote without updating our tracking ref.
    if (this.resolveSync) {
      const fresh = await this.resolveSync(sessionId, summary.headBranch)
        .catch(() => undefined);
      // No answer holds here, unlike the poll-time gate above. Most causes are
      // ordinary (no checkout, a different branch or a detached HEAD checked
      // out, no tracking ref yet) and the hold clears on the poll after the
      // cause does — no user action, and nothing terminal is recorded. The
      // cause that is NOT ordinary is a failed fetch, which is correlated with
      // the outage that leaves commits unpushed in the first place; merging on
      // it ships the branch without them, and nothing can undo that. Reaching
      // this on a failed fetch takes `requireFetch` at the resolver: the shared
      // helper otherwise answers from the stale refs this reading replaces.
      if (!fresh) {
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}:`
          + ` the branch could not be compared with ${summary.headBranch} on GitHub`,
        );
        return;
      }
      if (fresh.state !== "in-sync" && fresh.state !== "behind") {
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}:`
          + ` the branch is ${fresh.state} of ${summary.headBranch} on GitHub (verified against the remote)`,
        );
        return;
      }
    }

    const result = await this.githubAuth.mergePullRequest(
      owner, repo, summary.prNumber, mergeState.mergeMethod,
    );

    if (result.success) {
      // Keep enabled until the merged poll arrives, or the open PR briefly asks for attention.
      mergeState.completed = true;
      delete mergeState.error;
      noteMergePerformed(owner, repo, summary.prNumber);
      console.log(
        `[auto-merge] Merged PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}`
        + ` via managed merge (${mergeState.mergeMethod}, reason=${mergeState.managedReason ?? "native-unavailable"})`,
      );
      // A turn can start during the awaited merge; report why its later push will be refused.
      if (this.getRunner?.(sessionId)?.agentBusy) {
        console.warn(
          `[auto-merge] PR #${summary.prNumber} for ${sessionId} merged as a turn began`
          + " — later commits will be refused by merged-push-guard",
        );
      }
      this.onChange(sessionId);
    } else {
      mergeState.error = {
        code: "no_branch_protection",
        message: result.message,
        settingsUrl: summary.prUrl,
      };
      this.onChange(sessionId);
    }
  }
}
