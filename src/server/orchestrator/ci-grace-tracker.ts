/**
 * CiGraceTracker — "no checks reported" grace window extracted from PrStatusPoller.
 *
 * When GitHub initially reports `state: "none"` for a PR but we have signals
 * that the repo runs CI (local `.github/workflows` files, or checks observed
 * on any other PR in this repo), we want to suppress the merge button for a
 * short grace window so the user doesn't merge before GitHub registers the
 * workflow runs.
 *
 * After `NO_CHECKS_GRACE_MS` elapses without any check being registered for
 * the current head SHA, we accept that no workflows apply (e.g. docs-only
 * PRs against a repo whose CI is scoped with `paths:` filters) and let the
 * state fall back to `"none"`, which the client treats as "CI doesn't apply,
 * mergeable."
 *
 * This module also caches per-repo workflow detection and the sticky
 * "observed checks on any PR" signal.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Grace window for the "no checks reported but repo runs CI" override.
 *
 * 60s is a balance: long enough that a slow GitHub workflow registration
 * (typically <30s) doesn't get classified as "no CI"; short enough that
 * the user isn't kept waiting.
 */
export const NO_CHECKS_GRACE_MS = 60_000;

export class CiGraceTracker {
  /**
   * repoKey (owner/repo) → whether the repo has .github/workflows files.
   * Only positive results are cached — a `false` result (no workflow dir found
   * yet) is rechecked on every poll because the local clone may not have the
   * workflow files yet (initial fetch, workflow files added on the PR branch,
   * etc.). Caching a `false` here permanently used to leave the merge button
   * enabled for repos whose workflows weren't visible on first inspection.
   */
  private repoHasWorkflows = new Map<string, boolean>();
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
   * Decide whether the "force pending" override should apply for this
   * session right now. Returns true when the caller should rewrite a
   * `checks.state === "none"` reading to `"pending"`.
   *
   * Called only when `summary.checks.state === "none"`. Also updates the
   * per-session grace timer as a side effect.
   */
  shouldForcePending(args: {
    sessionId: string;
    repoKey: string;
    repoUrl: string | undefined;
    headSha: string;
    now?: number;
  }): boolean {
    if (!this.repoRunsCi(args.repoKey, args.repoUrl)) return false;
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
   * Called when checks ARE present on this PR (state !== "none"). Clears the
   * grace timer for the session since GitHub registered something.
   */
  clearForSession(sessionId: string): void {
    this.firstObservedNoChecks.delete(sessionId);
  }

  /**
   * Returns true when we have ANY signal that this repo runs CI:
   * either local workflow files OR we've observed checks on at least one PR.
   */
  private repoRunsCi(repoKey: string, repoUrl: string | undefined): boolean {
    if (this.repoHasObservedChecks.get(repoKey)) return true;
    if (repoUrl && this.checkRepoHasWorkflows(repoKey, repoUrl)) return true;
    return false;
  }

  /**
   * Check whether a repo has GitHub Actions workflow files.
   * Positive results are cached per repoKey for the process lifetime.
   * Negative results are NOT cached — we retry on every poll because the
   * shared clone may not have the workflow files yet (fetch in progress,
   * workflows added on PR branch only, etc.).
   */
  private checkRepoHasWorkflows(repoKey: string, repoUrl: string): boolean {
    if (this.repoHasWorkflows.get(repoKey) === true) return true;

    if (!this.getSharedRepoDir) {
      return false;
    }

    let hasWorkflows = false;
    try {
      const repoDir = this.getSharedRepoDir(repoUrl);
      const workflowDir = path.join(repoDir, ".github", "workflows");
      if (fs.existsSync(workflowDir)) {
        const entries = fs.readdirSync(workflowDir);
        hasWorkflows = entries.some(
          (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
        );
      }
    } catch {
      // If we can't read the directory, assume no workflows
    }

    if (hasWorkflows) {
      this.repoHasWorkflows.set(repoKey, true);
    }
    return hasWorkflows;
  }
}
