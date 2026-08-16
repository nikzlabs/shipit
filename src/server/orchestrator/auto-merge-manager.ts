/**
 * AutoMergeManager — auto-merge state machine extracted from PrStatusPoller.
 *
 * Owns the per-session auto-merge state map and the "ShipIt-managed" merge
 * loop that runs when GitHub native auto-merge isn't available (no branch
 * protection rules configured). The poller drives `handleManaged()` on
 * every observed PR update; this module decides whether to call the merge
 * REST API and updates state in place.
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type {
  AutoMergeManagedReason,
  AutoMergeState,
  PrAutoMergeError,
  PrStatusSummary,
} from "../shared/types/github-types.js";

export class AutoMergeManager {
  /** sessionId → auto-merge state */
  private states = new Map<string, AutoMergeState>();
  /**
   * Sessions currently parked at the busy gate, so the "waiting for the session"
   * line is logged once per wait rather than once per poll tick. Cleared when
   * the gate opens (or the arming is retired), which is what makes the next wait
   * log again.
   */
  private busyLogged = new Set<string>();

  /**
   * @param getRunner resolves the session's runner for the busy gate. Optional —
   *   degraded setups (and tests) that wire no runner registry pass nothing, and
   *   an unresolvable runner reads as "not busy" so the merge still happens. The
   *   contract is deliberate: an absent registry must never turn into a merge
   *   that never runs.
   */
  constructor(
    private readonly githubAuth: GitHubAuthManager,
    private readonly onChange: (sessionId: string) => void,
    private readonly getRunner?: (sessionId: string) => SessionRunnerInterface | undefined,
  ) {}

  /** Get auto-merge state for a session. */
  get(sessionId: string): AutoMergeState | undefined {
    return this.states.get(sessionId);
  }

  /** Drop state for a session (untrack). */
  delete(sessionId: string): void {
    this.states.delete(sessionId);
    this.busyLogged.delete(sessionId);
  }

  /** Set auto-merge enabled/disabled for a session. */
  setEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { enabled, mergeMethod: "squash" };
      this.states.set(sessionId, state);
    } else {
      state.enabled = enabled;
      // A deliberate user toggle resets the managed-merge lifecycle, so clear
      // the `completed` short-circuit either way (a re-enable must be able to
      // merge again; a disable shouldn't leave stale bookkeeping behind).
      delete state.completed;
      if (enabled) {
        // Clear any previous error when re-enabling
        delete state.error;
      } else {
        // Clear managed flag when disabling
        state.managed = false;
        delete state.managedReason;
        delete state.settingsUrl;
        delete state.reason;
      }
    }

    this.onChange(sessionId);
    return state;
  }

  /**
   * Mark auto-merge as ShipIt-managed — ShipIt's own merge loop owns this PR
   * instead of GitHub's native auto-merge.
   *
   * `opts.managedReason` says WHY, and the two reasons read very differently to
   * the user (docs/266): `native-unavailable` is a repo misconfiguration the
   * card explains and links to settings, `session-live` is a normal wait. It
   * defaults to `native-unavailable` so the pre-existing call sites — all of
   * which are the GitHub-refused fallback — keep their meaning unchanged.
   *
   * `opts.reason` is the real GitHub error that blocked native auto-merge,
   * surfaced verbatim in the managed-merge tooltip so the user sees the actual
   * missing precondition.
   */
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

  /** Set an auto-merge error (toggle reverts to OFF). */
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

  /** Set the preferred merge method for a session. */
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

  /** Handle ShipIt-managed auto-merge: merge via REST when CI passes. */
  async handleManaged(
    sessionId: string,
    summary: PrStatusSummary,
    owner: string,
    repo: string,
  ): Promise<void> {
    const mergeState = this.states.get(sessionId);
    if (!mergeState?.enabled || !mergeState.managed) return;

    // A prior tick's REST merge already succeeded — the poller just hasn't
    // observed the merged state yet. Don't re-attempt (GitHub rejects an
    // already-merged PR, which would set a spurious sticky error) and don't
    // touch the state: auto-merge stays "in charge" until `prState` flips to
    // merged. Released by the poller's terminal-state branch (`verifyMissingPr`)
    // the moment that merged state is observed.
    if (mergeState.completed) return;

    // Merge when CI passes, or when there are no required checks at all.
    // Mirrors the client's `isCiPassed || isCiNone` mergeability rule
    // (docs/113) so a docs-only PR with path-filtered CI ("none") isn't left
    // stuck: native auto-merge falls back to managed, the manual button hides,
    // and this executor must finish the merge. `pending`/`failure` stay excluded.
    if (summary.checks.state !== "success" && summary.checks.state !== "none") return;

    // Wait for required review approval. `review_required`/`changes_requested`
    // mean the base branch's protection rule isn't satisfied — GitHub's REST
    // merge would reject every tick, so bail and re-evaluate next poll once an
    // approval lands. Unlike the conflict case we set no sticky error: awaiting
    // approval is a normal transient wait, not a misconfiguration. docs/174.
    if (
      summary.reviewDecision === "review_required" ||
      summary.reviewDecision === "changes_requested"
    ) {
      return;
    }

    // A conflict already has its own dedicated surface on the card — the
    // "Merge conflicts" indicator + Resolve button (and, when enabled, the
    // auto-resolve loop). Setting a sticky auto-merge error here would render a
    // redundant second "PR has merge conflicts" line. So, like the review gate
    // above, bail without a sticky error and re-evaluate next poll once the
    // branch is rebased clean. Clear any stale error from a prior tick.
    if (summary.mergeable === "conflicting") {
      if (mergeState.error) {
        delete mergeState.error;
        this.onChange(sessionId);
      }
      return;
    }

    // "unknown" — GitHub hasn't computed mergeability yet. Wait for the next
    // poller tick rather than racing into a merge attempt that would fail.
    if (summary.mergeable !== "mergeable") return;

    // docs/266 — the PR is ready to merge, but the session is still working.
    // Auto-commit fires AFTER the turn ends, so a merge now ships a PR whose
    // remaining edits land on a branch with a closed PR: `merged-push-guard`
    // then correctly refuses the push and the work never reaches CI. This is the
    // same rule the UI merge route has always enforced, on the path that had no
    // guard at all.
    //
    // `agentBusy`, never bare `running`: the terminal sequence and the debounced
    // auto-push it arms both run once `running` is false (see the runner
    // interface + `services/auto-push-scheduler.ts`), so a `running` check would
    // still merge inside that window — the same bug with a smaller mouth.
    //
    // Like the review gate (docs/174) and the conflict branch, bail WITHOUT a
    // sticky error and re-evaluate on the next poll tick: being busy is a normal
    // transient wait, not a misconfiguration.
    const runner = this.getRunner?.(sessionId);
    if (runner?.agentBusy) {
      if (!this.busyLogged.has(sessionId)) {
        this.busyLogged.add(sessionId);
        console.log(
          `[auto-merge] Holding merge of PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}: agent busy`,
        );
      }
      return;
    }
    this.busyLogged.delete(sessionId);

    // Attempt the merge via REST API
    const result = await this.githubAuth.mergePullRequest(
      owner, repo, summary.prNumber, mergeState.mergeMethod,
    );

    if (result.success) {
      // Merge REST succeeded — the PR is merging. Keep `enabled`/`managed` as
      // they are so the client keeps treating auto-merge as owning the next
      // move and stays SILENT until the merged state lands. Flipping
      // `enabled=false` here is what caused the spurious chime: the poller
      // re-broadcasts `lastKnown` (still `prState:"open"`, `checks:"success"`)
      // via this onChange, and an open+green+auto-merge-disabled summary reads
      // as "Waiting for your input" → an attention notification fires a beat
      // before the PR is observed merged. `completed` short-circuits further
      // attempts; the whole state is dropped by the poller's terminal-state
      // branch as soon as the merged PR is observed, so `completed` can never
      // outlive its PR and wedge auto-merge for the session's next one.
      mergeState.completed = true;
      delete mergeState.error;
      // docs/266 — the merge record. Without it an incident review cannot tell
      // whether a PR was merged by a human, by GitHub native auto-merge, or by
      // this loop (the merge routes and this manager logged nothing at all).
      console.log(
        `[auto-merge] Merged PR #${summary.prNumber} (${owner}/${repo}) for ${sessionId}`
        + ` via managed merge (${mergeState.mergeMethod}, reason=${mergeState.managedReason ?? "native-unavailable"})`,
      );
      this.onChange(sessionId);
    } else {
      // Merge failed — surface error, stays enabled for retry next poll
      mergeState.error = {
        code: "no_branch_protection",
        message: result.message,
        settingsUrl: summary.prUrl,
      };
      this.onChange(sessionId);
    }
  }
}
