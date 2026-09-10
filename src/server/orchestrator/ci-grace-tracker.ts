import {
  loadAndParseWorkflows,
  workflowAppliesToPr,
  type ParsedWorkflow,
} from "./workflow-loader.js";

export const NO_CHECKS_GRACE_MS = 20_000;

export class CiGraceTracker {
  private parsedWorkflows = new Map<string, ParsedWorkflow[]>();
  private loadingPromises = new Map<string, Promise<void>>();
  private repoHasObservedChecks = new Map<string, boolean>();
  private firstObservedNoChecks = new Map<string, { headSha: string; observedAt: number }>();

  constructor(private readonly getSharedRepoDir?: (repoUrl: string) => string) {}

  untrack(sessionId: string): void {
    this.firstObservedNoChecks.delete(sessionId);
  }

  markRepoHasChecks(repoKey: string): void {
    this.repoHasObservedChecks.set(repoKey, true);
  }

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
        // Leave uncached so the next poll retries.
      } finally {
        this.loadingPromises.delete(repoKey);
      }
    })();
    this.loadingPromises.set(repoKey, promise);
    await promise;
  }

  setParsedWorkflowsForTest(repoKey: string, parsed: ParsedWorkflow[]): void {
    this.parsedWorkflows.set(repoKey, parsed);
  }

  /** Called only for checks.state === "none"; starts or checks the session's grace window. */
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
    return false;
  }

  // Different PRs can share a head SHA and must have separate merge windows.
  private firstMergeNoChecks = new Map<string, number>();

  /** Merges wait even with unknown CI history; polling can revise its answer later. */
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

  /** Lets the browser expire a pending state even while server polling is paused. */
  graceDeadlineFor(sessionId: string): number | undefined {
    const tracker = this.firstObservedNoChecks.get(sessionId);
    return tracker ? tracker.observedAt + NO_CHECKS_GRACE_MS : undefined;
  }

  clearForSession(sessionId: string): void {
    this.firstObservedNoChecks.delete(sessionId);
  }

  private repoRunsCi(repoKey: string): boolean {
    if (this.repoHasObservedChecks.get(repoKey)) return true;
    if ((this.parsedWorkflows.get(repoKey)?.length ?? 0) > 0) return true;
    return false;
  }
}
