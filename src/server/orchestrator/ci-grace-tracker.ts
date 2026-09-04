/**
 * CiGraceTracker — "no checks reported" grace window extracted from PrStatusPoller.
 *
 * When GitHub initially reports `state: "none"` for a PR but we have signals
 * that the repo runs CI (parsed `.github/workflows` files, or checks observed
 * on any other PR in this repo), we want to suppress the merge button for a
 * short grace window so the user doesn't merge before GitHub registers the
 * workflow runs.
 *
 * Two ways grace exits:
 *
 *   1. **Workflow trigger short-circuit** (fast path) — if we've parsed the
 *      repo's workflow files and NONE of them would trigger for this PR, we
 *      know upfront that GitHub won't ever register a check. Grace doesn't
 *      apply; the terminal "no checks" state shows immediately. Two shapes
 *      hit this: path filters (`paths-ignore: ['**.md']` + a docs-only PR)
 *      and event/branch filters (a repo whose only workflow is
 *      `on: { workflow_dispatch:, push: { branches: [release] } }`, so a PR
 *      into `main` matches nothing at all — nikzlabs/shipit#1730).
 *
 *   2. **Time-based fallback** — if workflows haven't been parsed yet, or
 *      the repo signals CI via external check_runs only (Vercel, etc.),
 *      we time-box the override at `NO_CHECKS_GRACE_MS`. After that, we
 *      accept that no workflows apply and let state revert to `"none"`,
 *      which the client treats as "CI doesn't apply, mergeable."
 *
 * The deadline is also published to the client (`checks.graceUntil`) so a
 * forced-pending state can expire in the browser even if polling paused
 * before the poller got to observe the expiry — see `graceDeadlineFor`.
 *
 * This module also caches per-repo workflow parsing and the sticky
 * "observed checks on any PR" signal.
 */

import {
  loadAndParseWorkflows,
  workflowAppliesToPr,
  type ParsedWorkflow,
} from "./workflow-loader.js";

/**
 * Grace window for the time-based fallback (when workflow parsing isn't
 * available or hasn't ruled out applicability).
 *
 * 20s: most workflows that GitHub will run register a check_run within
 * 2–10 seconds of the push, so 20s comfortably covers the slow tail. The
 * remaining tail-of-tail (rare GitHub-side latency >20s) is acceptable —
 * a transient false "no CI" with a re-spinner once the check arrives is a
 * better UX than a 60s spinner that turns out to be wrong.
 *
 * Pre-fix this was 60s; the bulk of that conservatism is now obviated by
 * the workflow-filter short-circuit in `shouldForcePending`.
 */
export const NO_CHECKS_GRACE_MS = 20_000;

export class CiGraceTracker {
  /**
   * repoKey (owner/repo) → parsed workflow filters. Cached after a
   * successful load. `null` / absent entries are not cached so retries
   * pick up newly-fetched workflow files on subsequent polls.
   */
  private parsedWorkflows = new Map<string, ParsedWorkflow[]>();
  /**
   * Per-repo in-flight workflow load promise. Deduplicates concurrent
   * `ensureWorkflowsLoaded` calls so we don't fire `git ls-tree` /
   * `git show` multiple times for the same repo while the first call is
   * still running.
   */
  private loadingPromises = new Map<string, Promise<void>>();
  /**
   * repoKey (owner/repo) → whether we've ever observed any CI checks for any
   * PR in this repo. Sticky flag — once true, stays true for the process
   * lifetime. Catches external CI systems (Vercel, third-party status checks)
   * that don't have local workflow files, plus repos whose `.github/workflows`
   * directory isn't present in the local shared clone.
   */
  private repoHasObservedChecks = new Map<string, boolean>();
  /**
   * sessionId → { headSha, observedAt }: when we first observed `state: "none"`
   * for the current head SHA on this session's PR. Used to time out the
   * "force pending" override (see `NO_CHECKS_GRACE_MS`). Cleared when a check
   * is observed (any state other than "none"), when the head SHA changes
   * (new push — give GitHub fresh time to register workflows), and on
   * `untrack`.
   */
  private firstObservedNoChecks = new Map<string, { headSha: string; observedAt: number }>();

  constructor(private readonly getSharedRepoDir?: (repoUrl: string) => string) {}

  /** Forget a session's per-session grace state (called on untrack). */
  untrack(sessionId: string): void {
    this.firstObservedNoChecks.delete(sessionId);
  }

  /** Record that we observed checks for any PR in this repo (sticky). */
  markRepoHasChecks(repoKey: string): void {
    this.repoHasObservedChecks.set(repoKey, true);
  }

  /**
   * Async-load and cache the repo's workflow filters. Safe to call every
   * poll — the first successful load is cached; concurrent calls dedupe
   * via `loadingPromises`. Failed loads (no workflow dir yet, git error)
   * are NOT cached so the next poll can retry.
   */
  async ensureWorkflowsLoaded(repoKey: string, repoUrl: string | undefined): Promise<void> {
    if (this.parsedWorkflows.has(repoKey)) return;
    if (!this.getSharedRepoDir || !repoUrl) return;
    const existing = this.loadingPromises.get(repoKey);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      try {
        const repoDir = this.getSharedRepoDir!(repoUrl);
        const parsed = await loadAndParseWorkflows(repoDir);
        if (parsed && parsed.length > 0) {
          this.parsedWorkflows.set(repoKey, parsed);
        }
      } catch {
        // Swallow — leave entry unset so we retry next poll.
      } finally {
        this.loadingPromises.delete(repoKey);
      }
    })();
    this.loadingPromises.set(repoKey, promise);
    await promise;
  }

  /**
   * Test-only seam to inject parsed workflows directly without going
   * through `git ls-tree`. Public so unit tests can exercise the
   * short-circuit logic in isolation.
   */
  setParsedWorkflowsForTest(repoKey: string, parsed: ParsedWorkflow[]): void {
    this.parsedWorkflows.set(repoKey, parsed);
  }

  /**
   * Decide whether the "force pending" override should apply for this
   * session right now. Returns true when the caller should rewrite a
   * `checks.state === "none"` reading to `"pending"`.
   *
   * Called only when `summary.checks.state === "none"`. Also updates the
   * per-session grace timer as a side effect.
   *
   * If we've parsed the repo's workflows, we short-circuit to `false` when
   * none of them would trigger for this PR — the grace window doesn't apply
   * because GitHub won't be running anything. The branch/event half of that
   * decision needs no `changedFiles` (a workflow with no `pull_request`
   * trigger and a `push` branch filter that excludes the head branch can
   * never fire), so the short-circuit runs even when the changed-file list
   * is unavailable; path filters stay conservative in that case.
   */
  shouldForcePending(args: {
    sessionId: string;
    repoKey: string;
    repoUrl: string | undefined;
    headSha: string;
    headBranch?: string;
    baseBranch?: string;
    changedFiles?: string[];
    now?: number;
  }): boolean {
    if (!this.repoRunsCi(args.repoKey)) return false;

    // Fast path: if we have the parsed workflow triggers and none of them
    // would fire for this PR, no point waiting for a check that can't come.
    const parsed = this.parsedWorkflows.get(args.repoKey);
    if (parsed && parsed.length > 0) {
      const anyApplies = parsed.some((w) =>
        workflowAppliesToPr(w, {
          headBranch: args.headBranch,
          baseBranch: args.baseBranch,
          changedFiles: args.changedFiles,
        }),
      );
      if (!anyApplies) return false;
    }

    const now = args.now ?? Date.now();
    const tracker = this.firstObservedNoChecks.get(args.sessionId);
    if (tracker?.headSha !== args.headSha) {
      this.firstObservedNoChecks.set(args.sessionId, { headSha: args.headSha, observedAt: now });
      return true;
    }
    if (now - tracker.observedAt < NO_CHECKS_GRACE_MS) {
      return true;
    }
    // Grace expired — leave state as "none" so the merge button appears.
    return false;
  }

  /**
   * `repoKey#prNumber@headSha` → when a merge decision first saw zero checks
   * for that exact pull request and commit. Separate from
   * {@link firstObservedNoChecks}, which is per SESSION: two pull requests in
   * one repository can share a head SHA (a branch pushed twice, a stacked pair),
   * and one session can ask about a pull request that is not the one the poller
   * is tracking for it.
   */
  private firstMergeNoChecks = new Map<string, number>();

  /**
   * docs/287-agent-merge-per-repo — should an agent merge WAIT, having read zero
   * checks for this commit?
   *
   * The same question {@link shouldForcePending} answers for the poller, decided
   * differently in one place that matters: **an unknown CI history starts the
   * grace here instead of ending it.** The poller returns false for a repository
   * it has no CI signal for because it will see that repository again in a few
   * seconds and can revise; a merge is a one-shot, irreversible decision that
   * gets no second look, so "we do not know yet whether this repository runs CI"
   * must not read as "it does not".
   *
   * The workflow short-circuit is kept, because it is positive evidence rather
   * than absence: when the repository's parsed workflows are known and none of
   * them can fire for this pull request, no check is coming and waiting for one
   * would refuse a merge that will never have anything to report.
   *
   * Keyed by repository + pull request + head SHA so the window belongs to the
   * commit being merged, not to a session.
   */
  shouldWaitForMergeChecks(args: {
    repoKey: string;
    prNumber: number;
    headSha: string;
    headBranch?: string;
    baseBranch?: string;
    changedFiles?: string[];
    now?: number;
  }): boolean {
    const parsed = this.parsedWorkflows.get(args.repoKey);
    if (parsed && parsed.length > 0) {
      const anyApplies = parsed.some((w) =>
        workflowAppliesToPr(w, {
          headBranch: args.headBranch,
          baseBranch: args.baseBranch,
          changedFiles: args.changedFiles,
        }),
      );
      if (!anyApplies) return false;
    }

    const key = `${args.repoKey}#${args.prNumber}@${args.headSha}`;
    const now = args.now ?? Date.now();
    const first = this.firstMergeNoChecks.get(key);
    if (first === undefined) {
      this.firstMergeNoChecks.set(key, now);
      return true;
    }
    return now - first < NO_CHECKS_GRACE_MS;
  }

  /**
   * Wall-clock instant at which this session's current grace window expires,
   * or `undefined` when no window is armed. Published to the client as
   * `checks.graceUntil` so the browser can retire a forced-pending spinner on
   * its own schedule.
   *
   * This matters because grace expiry is only *observed* on a poll, and
   * polling pauses when the last viewer detaches (`PollingGlobalGate`). A
   * forced-pending summary persisted just before the gate closed would
   * otherwise be rehydrated as an indefinite spinner on the next page load —
   * the reported "spins forever" symptom.
   */
  graceDeadlineFor(sessionId: string): number | undefined {
    const tracker = this.firstObservedNoChecks.get(sessionId);
    return tracker ? tracker.observedAt + NO_CHECKS_GRACE_MS : undefined;
  }

  /**
   * Called when checks ARE present on this PR (state !== "none"). Clears the
   * grace timer for the session since GitHub registered something.
   */
  clearForSession(sessionId: string): void {
    this.firstObservedNoChecks.delete(sessionId);
  }

  /**
   * Returns true when we have ANY signal that this repo runs CI:
   * either parsed workflow files OR we've observed checks on at least one PR.
   */
  private repoRunsCi(repoKey: string): boolean {
    if (this.repoHasObservedChecks.get(repoKey)) return true;
    if ((this.parsedWorkflows.get(repoKey)?.length ?? 0) > 0) return true;
    return false;
  }
}
