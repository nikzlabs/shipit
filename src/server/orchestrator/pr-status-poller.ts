import type { GitHubAuthManager } from "./github-auth.js";
import type { TerminalPrFacts } from "./github-auth-prs.js";
import type { SessionManager } from "./sessions.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { GitManager } from "../shared/git.js";
import type { PrStatusSummary, AutoFixState, AutoMergeManagedReason, AutoMergeState, PrAutoMergeError } from "../shared/types/github-types.js";
import { parseGitHubRemote } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";
import { readBranchSync, resolveMergeSync } from "./services/branch-sync.js";
import { logMergeObserved } from "./services/merge-attribution.js";
import {
  buildPrStatusQuery,
  extractFocusedPrNodes,
  type GraphQLPrNode,
  type GraphQLResponse,
  parsePrNode,
  extractHeadSha,
  extractCurrentHeadOid,
  extractBaseSha,
  extractFailedCheckRuns,
  extractChangedFiles,
  prStatusEqual,
} from "./pr-status-parser.js";
import { AutoFixManager, MAX_AUTO_FIX_ATTEMPTS, type FetchAndFixCb } from "./auto-fix-manager.js";
import { AutoMergeManager } from "./auto-merge-manager.js";
import { CiGraceTracker } from "./ci-grace-tracker.js";
import { AutoConflictResolveManager, MAX_AUTO_RESOLVE_ATTEMPTS, type RebaseAndResolveCb } from "./auto-conflict-resolve-manager.js";
import { RemediationArbiter } from "./auto-remediation-arbiter.js";
import type { MergedPrInfo } from "./issue-lifecycle.js";
import { PrSessionTracker } from "./pr-session-tracker.js";
import { PollingGlobalGate } from "./polling-global-gate.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import {
  PrPollingSupervisor,
  PR_STATUS_POLL_INTERVAL_MS,
  PR_STATUS_SLOW_INTERVAL_MS,
} from "./pr-polling-supervisor.js";

export { PR_STATUS_POLL_INTERVAL_MS, PR_STATUS_SLOW_INTERVAL_MS };

export interface PrTerminalStateInfo {
  sessionId: string;
  outcome: "merged" | "closed";
  prNumber: number;
  prUrl: string;
  prTitle: string;
  branch: string;
  mergeSha?: string;
}

export { parsePrNode, extractHeadSha, extractCurrentHeadOid, extractBaseSha, extractFailedCheckRuns, extractChangedFiles };

export class PrStatusPoller {
  private githubAuth: GitHubAuthManager;
  private sessionManager: SessionManager;
  private sseBroadcast: (event: string, data: unknown) => void;

  private readonly tracker = new PrSessionTracker();
  private readonly gate: PollingGlobalGate;
  private readonly supervisor: PrPollingSupervisor;
  private lastBroadcastLimited = false;

  private autoFix: AutoFixManager;
  private autoMerge: AutoMergeManager;
  private graceTracker: CiGraceTracker;
  public autoConflictResolveManager: AutoConflictResolveManager | undefined;

  private runnerRegistry?: SessionRunnerRegistry;
  private onMergeDetectedCb?: (sessionId: string) => Promise<void>;
  // The callback stamps merged_at after detection; pre-turn reset must await it.
  private readonly mergeHandling = new Map<string, Promise<void>>();
  private onMergedPr?: (info: MergedPrInfo) => Promise<void>;
  private onPrTerminalState?: (info: PrTerminalStateInfo) => Promise<void>;
  private createGitManager?: (dir: string) => GitManager;

  /**
   * A session's checkout as a GitManager, or `undefined` when it is not on
   * disk. The local clone only ever *enriches* GitHub's answer here, so its
   * absence must degrade — and the absence is routine: the disk janitor
   * reclaims an idle session's tree (`diskTier: "evicted"`, docs/183).
   *
   * The guard has to sit at construction rather than around the callers'
   * awaits, because `new GitManager(dir)` reaches simple-git's
   * `gitInstanceFactory`, which throws `GitConstructError` SYNCHRONOUSLY on an
   * absent baseDir. Unguarded, one evicted checkout threw past `pollRepo`'s
   * per-session loop and killed the whole repo's poll — no PR-state broadcast,
   * auto-fix, auto-merge or missing-PR verify for any session on it — on every
   * tick, forever. try/catch and not an `existsSync` precheck: the janitor can
   * reclaim the tree in between.
   */
  private openSessionGit(dir: string | undefined): GitManager | undefined {
    if (!dir || !this.createGitManager) return undefined;
    try {
      const git = this.createGitManager(dir);
      this.absentCheckoutLogged.delete(dir);
      return git;
    } catch (err: unknown) {
      // Deduplicated, not silent: an evicted checkout is expected, but an
      // unexpected factory failure would otherwise vanish. Per-tick logging is
      // the noise this replaces.
      if (!this.absentCheckoutLogged.has(dir)) {
        this.absentCheckoutLogged.add(dir);
        console.log(`[pr-poller] Skipping local git for ${dir} (checkout unavailable):`, getErrorMessage(err));
      }
      return undefined;
    }
  }

  private readonly absentCheckoutLogged = new Set<string>();

  private isAutoResolveEnabled: () => boolean;

  private isAutoFixEnabled: () => boolean;

  public readonly remediationArbiter = new RemediationArbiter();

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sessionManager: SessionManager;
    sseBroadcast: (event: string, data: unknown) => void;
    runnerRegistry?: SessionRunnerRegistry;
    getSharedRepoDir?: (repoUrl: string) => string;
    fetchAndFixCb?: FetchAndFixCb;
    onMergeDetectedCb?: (sessionId: string) => Promise<void>;
    onMergedPr?: (info: MergedPrInfo) => Promise<void>;
    onPrTerminalState?: (info: PrTerminalStateInfo) => Promise<void>;
    createGitManager?: (dir: string) => GitManager;
    isAutoResolveEnabled?: () => boolean;
    rebaseAndResolveCb?: RebaseAndResolveCb;
    isAutoFixEnabled?: () => boolean;
    ensureRunner?: (sessionId: string) => Promise<SessionRunnerInterface | undefined>;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sessionManager = opts.sessionManager;
    this.sseBroadcast = opts.sseBroadcast;
    this.runnerRegistry = opts.runnerRegistry;
    this.onMergeDetectedCb = opts.onMergeDetectedCb;
    this.onMergedPr = opts.onMergedPr;
    this.onPrTerminalState = opts.onPrTerminalState;
    this.createGitManager = opts.createGitManager;
    this.isAutoResolveEnabled = opts.isAutoResolveEnabled ?? (() => false);
    this.isAutoFixEnabled = opts.isAutoFixEnabled ?? (() => false);

    const onSessionChange = (sessionId: string) => this.broadcastSessionStatus(sessionId);
    this.autoFix = new AutoFixManager(
      onSessionChange,
      (sessionId) => opts.runnerRegistry?.get(sessionId),
      this.isAutoFixEnabled,
      opts.fetchAndFixCb,
      undefined,
      this.remediationArbiter,
      (sessionId) => !this.sessionManager.get(sessionId)?.autoFixCiPaused,
      opts.ensureRunner,
    );
    this.autoMerge = new AutoMergeManager(
      this.githubAuth,
      onSessionChange,
      (sessionId) => opts.runnerRegistry?.get(sessionId),
      // Fetch at merge time: poll-time tracking refs can miss a remote force-push.
      // `requireFetch` is what makes that true — without it a failed fetch falls
      // back to the very refs this reading exists to replace.
      async (sessionId, headBranch) => {
        const git = this.openSessionGit(this.sessionManager.get(sessionId)?.workspaceDir);
        return git ? resolveMergeSync(git, headBranch, "origin", { requireFetch: true }) : undefined;
      },
    );
    this.graceTracker = new CiGraceTracker(opts.getSharedRepoDir);
    if (opts.runnerRegistry) {
      const registry = opts.runnerRegistry;
      this.autoConflictResolveManager = new AutoConflictResolveManager(
        onSessionChange,
        (sessionId) => registry.get(sessionId),
        this.isAutoResolveEnabled,
        opts.rebaseAndResolveCb,
        undefined,
        this.remediationArbiter,
        opts.ensureRunner,
      );
    }

    this.gate = new PollingGlobalGate({
      runnerRegistry: opts.runnerRegistry,
      tracker: this.tracker,
      autoFix: this.autoFix,
      autoMerge: this.autoMerge,
      autoConflictResolve: this.autoConflictResolveManager,
      hasPendingMergeWatch: () => this.sessionManager.listPendingMergeWatches().length > 0,
    });
    this.supervisor = new PrPollingSupervisor({
      gate: this.gate,
      tracker: this.tracker,
      autoFix: this.autoFix,
      autoMerge: this.autoMerge,
      pollRepo: (repoKey, owner, repo) => this.pollRepo(repoKey, owner, repo),
    });
  }

  notifyViewerAttached(): void {
    this.gate.clearDetachGrace();
    this.supervisor.ensure();
  }

  notifyViewerDetached(): void {
    this.gate.armDetachGrace();
  }

  notifyAutoPush(sessionId: string): void {
    this.tracker.lastAutoPushAt.set(sessionId, Date.now());
    if (this.gate.isOpen()) this.supervisor.ensure();
  }

  trackSession(sessionId: string, repoUrl: string): void {
    const parsed = parseGitHubRemote(repoUrl);
    if (!parsed) return;

    const repoKey = `${parsed.owner}/${parsed.repo}`;
    this.tracker.sessionRepos.set(sessionId, repoKey);
    this.tracker.mergedSessions.delete(sessionId);
    this.tracker.verifiedAbsent.delete(sessionId);

    this.graceTracker.ensureWorkflowsLoaded(repoKey, repoUrl).catch(() => {});

    if (this.gate.isOpen()) {
      this.supervisor.ensure();
      this.pollRepo(repoKey, parsed.owner, parsed.repo, { force: true }).catch((err: unknown) => {
        console.error(`[pr-poller] Error on initial poll ${repoKey}:`, err);
      });
    }
  }

  async forceRefreshSession(
    sessionId: string,
    opts: { waitForMissingVerify?: boolean } = {},
  ): Promise<void> {
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    this.gate.clearDetachGrace();
    this.supervisor.ensure();
    this.tracker.verifiedAbsent.delete(sessionId);

    const owner = repoKey.slice(0, slash);
    const repo = repoKey.slice(slash + 1);
    await this.pollRepo(repoKey, owner, repo, {
      force: true,
      waitForMissingVerify: opts.waitForMissingVerify ?? false,
    });
  }

  /** Awaits workflow loading, not the grace window. */
  async awaitCiGraceDecision(args: {
    repoUrl: string | undefined;
    repoKey: string;
    prNumber: number;
    headSha: string;
    headBranch?: string;
    baseBranch?: string;
  }): Promise<boolean> {
    await this.graceTracker.ensureWorkflowsLoaded(args.repoKey, args.repoUrl).catch(() => {});
    return this.graceTracker.shouldWaitForMergeChecks({
      repoKey: args.repoKey,
      prNumber: args.prNumber,
      headSha: args.headSha,
      ...(args.headBranch ? { headBranch: args.headBranch } : {}),
      ...(args.baseBranch ? { baseBranch: args.baseBranch } : {}),
    });
  }

  /** Use REST because the OPEN GraphQL view can lag a merge.
   * Pre-turn checks must disable armAbsentDebounce so later merges are still probed.
   */
  async forceVerifySessionPrState(
    sessionId: string,
    opts: { armAbsentDebounce?: boolean } = {},
  ): Promise<void> {
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    const slash = repoKey?.indexOf("/") ?? -1;
    if (!repoKey || slash <= 0) return;

    const session = this.sessionManager.get(sessionId);
    if (!session?.branch) return;

    this.gate.clearDetachGrace();
    this.supervisor.ensure();
    this.tracker.verifiedAbsent.delete(sessionId);

    const polledOwner = repoKey.slice(0, slash);
    const polledRepo = repoKey.slice(slash + 1);
    const { owner, repo } = await this.resolveCanonicalApiTarget(repoKey, polledOwner, polledRepo);
    const outcome = await this.verifyMissingPr(sessionId, owner, repo, session.branch);
    if (outcome !== "suppressed" && (opts.armAbsentDebounce ?? true)) {
      this.tracker.verifiedAbsent.add(sessionId);
    }
  }

  /** Caller must bound this wait; merge callbacks can require network work. */
  async awaitMergeHandling(sessionId: string): Promise<void> {
    await this.mergeHandling.get(sessionId);
  }

  untrackSession(sessionId: string): void {
    const repoKey = this.tracker.sessionRepos.get(sessionId);
    this.tracker.untrack(sessionId);
    this.autoFix.delete(sessionId);
    this.autoMerge.delete(sessionId);
    this.autoConflictResolveManager?.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    this.graceTracker.untrack(sessionId);
    this.mergeHandling.delete(sessionId);

    if (repoKey && !this.tracker.repoHasTrackedSessions(repoKey)) {
      this.supervisor.deleteRepoCadence(repoKey);
    }
  }

  broadcastAllSnapshots(): void {
    const updates: PrStatusSummary[] = [];
    for (const [sessionId, summary] of this.tracker.lastKnown) {
      if (this.tracker.mergedSessions.has(sessionId)) continue;
      updates.push(this.attachAutomationState(summary));
    }
    if (updates.length > 0) this.sseBroadcast("pr_status", { updates });
  }

  setPrTabActive(sessionId: string, active: boolean): void {
    const was = this.tracker.prTabActiveSessions.has(sessionId);
    if (active) this.tracker.prTabActiveSessions.add(sessionId);
    else this.tracker.prTabActiveSessions.delete(sessionId);
    if (active === was) return;

    if (active) {
      const repoKey = this.tracker.sessionRepos.get(sessionId);
      const slash = repoKey?.indexOf("/") ?? -1;
      if (repoKey && slash > 0) {
        const owner = repoKey.slice(0, slash);
        const repo = repoKey.slice(slash + 1);
        this.gate.clearDetachGrace();
        this.supervisor.ensure();
        this.pollRepo(repoKey, owner, repo, { force: true }).catch((err: unknown) => {
          console.error(`[pr-poller] Error on PR-tab-activated poll ${repoKey}:`, err);
        });
      }
    }
  }

  // Do not seed mergedSessions: polling must recheck persisted terminal states.
  loadPersisted(): void {
    const persisted = this.sessionManager.getAllPrStatuses();
    for (const snapshot of persisted) {
      const clean: PrStatusSummary = { ...snapshot };
      delete clean.autoFix;
      delete clean.autoMerge;
      this.tracker.lastKnown.set(snapshot.sessionId, clean);
    }
    // Retain old-PR suppression across restarts of re-armed sessions.
    for (const session of this.sessionManager.list()) {
      if (session.previousMergedPr) {
        this.tracker.supersededPrNumbers.set(session.id, session.previousMergedPr.number);
      }
    }
  }

  clearPersisted(sessionId: string): void {
    this.tracker.lastKnown.delete(sessionId);
    this.tracker.mergedSessions.delete(sessionId);
    this.sessionManager.setPrStatus(sessionId, null);
    this.sseBroadcast("pr_status", { updates: [], removals: [sessionId] });
  }

  /** Clear silently: an SSE removal can race and erase the new WS PR card.
   * Suppress the old PR before trackSession starts its immediate poll.
   */
  reArm(sessionId: string, supersededPrNumber?: number): void {
    // Drop a hung callback from the previous merge episode.
    this.mergeHandling.delete(sessionId);
    this.tracker.lastKnown.delete(sessionId);
    this.tracker.lastPrNodes.delete(sessionId);
    this.tracker.mergedSessions.delete(sessionId);
    this.tracker.verifiedAbsent.delete(sessionId);
    this.sessionManager.setPrStatus(sessionId, null);
    if (typeof supersededPrNumber === "number") {
      this.tracker.supersededPrNumbers.set(sessionId, supersededPrNumber);
    }
    const repoUrl = this.sessionManager.get(sessionId)?.remoteUrl;
    if (repoUrl) this.trackSession(sessionId, repoUrl);
  }

  getStatus(sessionId: string): PrStatusSummary | undefined {
    return this.tracker.lastKnown.get(sessionId);
  }

  getAllStatuses(): PrStatusSummary[] {
    return [...this.tracker.lastKnown.values()].map((s) => this.attachAutomationState(s));
  }

  getAutoFixState(sessionId: string): AutoFixState | undefined {
    return this.autoFix.get(sessionId);
  }

  notifyRunnerIdle(sessionId: string): void {
    void this.autoFix.onRunnerIdle(sessionId).catch((err: unknown) => {
      console.error(`[pr-poller] auto-fix onRunnerIdle error for ${sessionId}:`, err);
    });
    void this.autoConflictResolveManager?.onRunnerIdle(sessionId).catch((err: unknown) => {
      console.error(`[pr-poller] auto-resolve onRunnerIdle error for ${sessionId}:`, err);
    });
  }

  resetRemediationForUserActivity(sessionId: string): void {
    this.autoFix.resetForUserActivity(sessionId);
    this.autoConflictResolveManager?.resetForUserActivity(sessionId);
  }

  getLastPrNode(sessionId: string): GraphQLPrNode | undefined {
    return this.tracker.lastPrNodes.get(sessionId);
  }

  getAutoMergeState(sessionId: string): AutoMergeState | undefined {
    return this.autoMerge.get(sessionId);
  }

  setAutoMergeEnabled(sessionId: string, enabled: boolean): AutoMergeState {
    return this.autoMerge.setEnabled(sessionId, enabled);
  }

  setAutoMergeManaged(
    sessionId: string,
    managed: boolean,
    opts: { settingsUrl?: string; reason?: string; managedReason?: AutoMergeManagedReason } = {},
  ): void {
    this.autoMerge.setManaged(sessionId, managed, opts);
    if (managed) this.supervisor.ensure();
  }

  /** An idle runner can start a turn after arming; native auto-merge cannot gate it. */
  hasLiveRunner(sessionId: string): boolean {
    return this.runnerRegistry?.get(sessionId) !== undefined;
  }

  setAutoMergeError(sessionId: string, error: PrAutoMergeError): void {
    this.autoMerge.setError(sessionId, error);
  }

  setMergeMethod(sessionId: string, method: "squash" | "merge" | "rebase"): void {
    this.autoMerge.setMergeMethod(sessionId, method);
  }

  destroy(): void {
    this.supervisor.destroy();
  }

  private broadcastSessionStatus(sessionId: string): void {
    const status = this.tracker.lastKnown.get(sessionId);
    if (status) {
      const updated = this.attachAutomationState(status);
      this.sseBroadcast("pr_status", { updates: [updated] });
    }
  }

  private attachAutomationState(summary: PrStatusSummary): PrStatusSummary {
    let result = summary;
    const fixState = this.autoFix.get(summary.sessionId);
    // Keep fix progress while CI reruns, but hide it once checks pass.
    if (fixState && summary.checks.state !== "success") {
      result = {
        ...result,
        autoFix: {
          // Stored count excludes the running attempt; display is one-based.
          attemptCount:
            fixState.status === "running" ? fixState.attemptCount + 1 : fixState.attemptCount,
          status: fixState.status,
          maxAttempts: MAX_AUTO_FIX_ATTEMPTS,
        },
      };
    }
    const mergeState = this.autoMerge.get(summary.sessionId);
    if (mergeState && summary.prState !== "merged" && summary.prState !== "closed") {
      result = {
        ...result,
        autoMerge: {
          enabled: mergeState.enabled,
          mergeMethod: mergeState.mergeMethod,
          managed: mergeState.managed,
          managedReason: mergeState.managedReason,
          settingsUrl: mergeState.settingsUrl,
          reason: mergeState.reason,
          error: mergeState.error,
        },
      };
    }
    const resolveState = this.autoConflictResolveManager?.get(summary.sessionId);
    if (resolveState && this.isAutoResolveEnabled()) {
      result = {
        ...result,
        autoResolve: {
          status: resolveState.status,
          attemptCount: resolveState.attemptCount,
          maxAttempts: MAX_AUTO_RESOLVE_ATTEMPTS,
          ...(resolveState.lastError !== undefined ? { lastError: resolveState.lastError } : {}),
          ...(resolveState.nextEligibleAt !== undefined ? { nextEligibleAt: resolveState.nextEligibleAt } : {}),
        },
      };
    }
    return result;
  }

  /** REST head filters need the new owner after a transfer.
   * Keep stored URLs unchanged: session grouping requires exact URL matches.
   */
  private canonicalApiTarget(
    polledKey: string,
    polledOwner: string,
    polledRepo: string,
    nameWithOwner: string | undefined,
  ): { owner: string; repo: string } {
    const unchanged = { owner: polledOwner, repo: polledRepo };
    if (!nameWithOwner) return unchanged;
    const slash = nameWithOwner.indexOf("/");
    if (slash <= 0 || slash >= nameWithOwner.length - 1) return unchanged;
    const owner = nameWithOwner.slice(0, slash);
    const repo = nameWithOwner.slice(slash + 1);
    if (`${owner}/${repo}` === polledKey) return unchanged;
    return { owner, repo };
  }

  private async resolveCanonicalApiTarget(
    repoKey: string,
    owner: string,
    repo: string,
  ): Promise<{ owner: string; repo: string }> {
    const result = await this.githubAuth.graphqlQuery<{
      data?: { repository?: { nameWithOwner?: string } };
    }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }`,
      { owner, name: repo },
    );
    const nameWithOwner = result?.data?.repository?.nameWithOwner;
    return this.canonicalApiTarget(repoKey, owner, repo, nameWithOwner);
  }

  private async pollRepo(
    repoKey: string,
    owner: string,
    repo: string,
    opts: { force?: boolean; waitForMissingVerify?: boolean } = {},
  ): Promise<void> {
    if (!this.githubAuth.authenticated) return;

    const rateLimit = this.githubAuth.getRateLimitState();
    const stillLimited = rateLimit.limited && (rateLimit.resetAt === null || rateLimit.resetAt > Date.now());

    if (stillLimited && !this.lastBroadcastLimited) {
      this.lastBroadcastLimited = true;
      this.sseBroadcast("gh_rate_limited", { resetAt: rateLimit.resetAt });
    } else if (!stillLimited && this.lastBroadcastLimited) {
      this.lastBroadcastLimited = false;
      this.sseBroadcast("gh_rate_limited_cleared", {});
    }

    if (stillLimited) return;

    this.supervisor.recordPolledAt(repoKey);

    const first = this.tracker.computeBulkFirst(repoKey);
    const focusedPrNumbers = this.tracker.collectFocusedPrNumbers(repoKey);
    const coveragePrNumbers = this.tracker.collectCoveragePrNumbers(repoKey);
    const query = buildPrStatusQuery({ first, focusedPrNumbers, coveragePrNumbers });
    const result = await this.githubAuth.graphqlQuery<GraphQLResponse>(
      query,
      { owner, name: repo },
    );

    // Missing data is not evidence that PRs closed.
    const repository = (result as unknown as GraphQLResponse)?.data?.repository;
    const prNodes = repository?.pullRequests?.nodes;
    if (!prNodes) return;

    ({ owner, repo } = this.canonicalApiTarget(repoKey, owner, repo, repository.nameWithOwner));

    const focusedByPrNumber = extractFocusedPrNodes(result);

    // Observed checks also detect external CI absent from local workflow files.
    const prByBranch = new Map<string, GraphQLPrNode>();
    let observedChecksThisPoll = false;
    for (const node of prNodes) {
      prByBranch.set(node.headRefName, node);
      if (!observedChecksThisPoll) {
        const contexts = node.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes;
        if (contexts && contexts.length > 0) observedChecksThisPoll = true;
      }
    }

    // parsePrNode assumes open; terminal aliases must go through REST verification.
    for (const node of focusedByPrNumber.values()) {
      if (node.state !== "OPEN") continue;
      if (!prByBranch.has(node.headRefName)) prByBranch.set(node.headRefName, node);
    }
    if (observedChecksThisPoll) {
      this.graceTracker.markRepoHasChecks(repoKey);
    }

    const updates: PrStatusSummary[] = [];
    const sessions = this.sessionManager.list();
    // Archived sessions still need polling when ShipIt owns their pending merge.
    for (const sessionId of this.tracker.sessionRepos.keys()) {
      if (this.tracker.sessionRepos.get(sessionId) !== repoKey) continue;
      const armed = this.autoMerge.get(sessionId);
      if (!armed?.enabled || !armed.managed) continue;
      if (sessions.some((s) => s.id === sessionId)) continue;
      const archived = this.sessionManager.get(sessionId);
      if (archived) sessions.push(archived);
    }

    const trackedSession = sessions.find(
      (s) => this.tracker.sessionRepos.get(s.id) === repoKey && s.remoteUrl,
    );
    if (trackedSession?.remoteUrl) {
      await this.graceTracker.ensureWorkflowsLoaded(repoKey, trackedSession.remoteUrl);
    }

    for (const session of sessions) {
      const sessionRepoKey = this.tracker.sessionRepos.get(session.id);
      if (sessionRepoKey !== repoKey) continue;
      if (this.tracker.mergedSessions.has(session.id)) continue;
      if (!session.branch) continue;

      const bulkNode = prByBranch.get(session.branch);

      if (bulkNode) {
        this.tracker.verifiedAbsent.delete(session.id);
        this.tracker.supersededPrNumbers.delete(session.id);
        const prNode = focusedByPrNumber.get(bulkNode.number) ?? bulkNode;
        this.tracker.lastPrNodes.set(session.id, prNode);

        const summary = parsePrNode(prNode, session.id);
        const headSha = extractHeadSha(prNode) ?? "";

        // Allow expected CI time to register before treating absent checks as none.
        if (summary.checks.state === "none") {
          const force = this.graceTracker.shouldForcePending({
            sessionId: session.id,
            repoKey,
            repoUrl: session.remoteUrl,
            headSha,
            headBranch: summary.headBranch,
            baseBranch: summary.baseBranch,
            changedFiles: extractChangedFiles(prNode),
          });
          if (force) {
            summary.checks.state = "pending";
            // The client must expire the spinner even if polling pauses.
            const until = this.graceTracker.graceDeadlineFor(session.id);
            if (until !== undefined) summary.checks.graceUntil = until;
          }
        } else {
          this.graceTracker.clearForSession(session.id);
        }

        // Match the local diff dialog while GitHub's diff indexing catches up.
        const localGit = this.openSessionGit(session.workspaceDir);
        // Distinguish "no clone on disk" from "no factory wired" — only the
        // former is evidence, and it is what holds the managed merge below.
        const checkoutMissing = Boolean(this.createGitManager && session.workspaceDir && !localGit);
        if (localGit) {
          try {
            const local = await localGit.diffStatVsBranch(summary.baseBranch);
            summary.insertions = local.insertions;
            summary.deletions = local.deletions;
          } catch {
            // Retain GitHub's counts if local stats are unavailable.
          }
          // This display read uses local refs; the merge path fetches fresh state.
          const sync = await readBranchSync(localGit, summary.headBranch);
          if (sync) summary.branchSync = sync;
        }

        const prev = this.tracker.lastKnown.get(session.id);

        // A light poll must not erase previously fetched conversation.
        if (summary.issueComments === undefined && prev?.issueComments !== undefined) {
          summary.issueComments = prev.issueComments;
        }
        if (summary.reviewThreads === undefined && prev?.reviewThreads !== undefined) {
          summary.reviewThreads = prev.reviewThreads;
        }

        // Do not let one session's worker requests delay other sessions' polls.
        void this.autoFix.handleTransition(session.id, summary, prNode, owner, repo)
          .catch((err: unknown) => {
            console.error(`[pr-poller] Auto-fix handleTransition error for ${session.id}:`, err);
          });

        if (!this.remediationArbiter.isClaimed(session.id)) {
          this.autoMerge.handleManaged(session.id, summary, owner, repo, { checkoutMissing }).catch((err: unknown) => {
            console.error(`[pr-poller] Managed auto-merge error for ${session.id}:`, err);
          });
        }

        if (this.autoConflictResolveManager) {
          const headShaForResolve = extractHeadSha(prNode) ?? "";
          const baseShaForResolve = extractBaseSha(prNode);
          this.autoConflictResolveManager
            .handleTransition(session.id, summary, summary.baseBranch, headShaForResolve, baseShaForResolve)
            .catch((err: unknown) => {
              console.error(`[pr-poller] Auto-resolve handleTransition error for ${session.id}:`, err);
            });
        }

        const withAutomation = this.attachAutomationState(summary);

        if (!prev || !prStatusEqual(prev, summary)) {
          this.tracker.lastKnown.set(session.id, summary);
          this.sessionManager.setPrStatus(session.id, summary);
          updates.push(withAutomation);
        }
      } else {
        // Pagination and indexing lag can omit an open PR; verify through REST.
        if ((!opts.force && this.tracker.verifiedAbsent.has(session.id)) || this.tracker.inFlightVerify.has(session.id)) continue;
        this.tracker.inFlightVerify.add(session.id);
        // eslint-disable-next-line no-restricted-syntax -- async outcome controls debounce
        const verify = this.verifyMissingPr(session.id, owner, repo, session.branch)
          .then((outcome) => {
            // Keep probing after suppression: a new PR can open and merge between polls.
            if (outcome !== "suppressed") this.tracker.verifiedAbsent.add(session.id);
          })
          .catch((err: unknown) => {
            console.error(`[pr-poller] REST verify error for ${session.id}:`, err);
            // Avoid repeated failures; a forced refresh clears this debounce.
            this.tracker.verifiedAbsent.add(session.id);
          })
          .finally(() => {
            this.tracker.inFlightVerify.delete(session.id);
          });
        if (opts.waitForMissingVerify) await verify;
      }
    }

    if (updates.length > 0) {
      this.sseBroadcast("pr_status", { updates });
    }
  }

  /** Callers must not debounce a suppressed result: the new PR is still unknown. */
  private async verifyMissingPr(
    sessionId: string,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<"absent" | "open" | "terminal" | "suppressed"> {
    const pr = await this.githubAuth.findPullRequestAnyState(owner, repo, branch);
    if (!pr) return "absent";

    const isMerged = pr.merged_at !== null;
    const prState = isMerged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;

    const superseded = this.tracker.supersededPrNumbers.get(sessionId);
    if (superseded !== undefined && pr.number !== superseded) {
      this.tracker.supersededPrNumbers.delete(sessionId);
    } else if (superseded !== undefined && prState !== "open") {
      return "suppressed";
    }

    if (prState === "open") {
      const prev = this.tracker.lastKnown.get(sessionId);
      // Retain the richer GraphQL snapshot when one exists.
      if (prev?.prState === "open") return "open";

      this.tracker.mergedSessions.delete(sessionId);
      this.tracker.lastPrNodes.delete(sessionId);

      const forcePending = this.graceTracker.shouldForcePending({
        sessionId,
        repoKey: `${owner}/${repo}`,
        repoUrl: this.sessionManager.get(sessionId)?.remoteUrl,
        headSha: "",
        headBranch: branch,
        baseBranch: pr.base,
      });
      const checksState: PrStatusSummary["checks"]["state"] = forcePending ? "pending" : "none";
      const graceUntil = forcePending ? this.graceTracker.graceDeadlineFor(sessionId) : undefined;

      const summary: PrStatusSummary = {
        sessionId,
        prNumber: pr.number,
        prUrl: pr.url,
        prTitle: pr.title,
        prBody: pr.body,
        prState: "open",
        baseBranch: pr.base,
        headBranch: branch,
        insertions: pr.additions,
        deletions: pr.deletions,
        checks: {
          state: checksState,
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          ...(graceUntil !== undefined ? { graceUntil } : {}),
        },
        mergeable: "unknown",
        reviewDecision: "none",
        autoMergeEnabled: false,
      };
      this.tracker.lastKnown.set(sessionId, summary);
      this.sessionManager.setPrStatus(sessionId, summary);
      this.sseBroadcast("pr_status", { updates: [this.attachAutomationState(summary)] });
      return "open";
    }

    this.promoteTerminal({ sessionId, owner, repo, branch, pr });
    return "terminal";
  }

  private promoteTerminal(args: {
    sessionId: string;
    owner: string;
    repo: string;
    branch: string;
    pr: {
      number: number; url: string; title: string; body: string; base: string;
      state: "open" | "closed"; merged_at: string | null; merge_commit_sha: string | null;
      head_sha: string | null; additions: number; deletions: number;
    };
    /** Replay effects after an interrupted settlement. */
    force?: boolean;
  }): void {
    const { sessionId, owner, repo, branch, pr, force } = args;
    const isMerged = pr.merged_at !== null;
    const prState = isMerged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;
    const prevState = this.tracker.lastKnown.get(sessionId)?.prState;
    // Capture native arming before the terminal snapshot overwrites it.
    const nativeArmedOnGitHub = this.tracker.lastKnown.get(sessionId)?.autoMergeEnabled === true;
    // Persisted state prevents replay on re-track; force repairs interrupted effects.
    const alreadyTerminal = force
      ? false
      : this.tracker.mergedSessions.has(sessionId)
      || prevState === "merged"
      || prevState === "closed";

    // Log before persistence can cause a restart to suppress this observation.
    if (isMerged && !alreadyTerminal) {
      logMergeObserved({ owner, repo, prNumber: pr.number, sessionId });
    }

    const summary: PrStatusSummary = {
      sessionId,
      prNumber: pr.number,
      prUrl: pr.url,
      prTitle: pr.title,
      prBody: pr.body,
      prState,
      baseBranch: pr.base,
      headBranch: branch,
      insertions: pr.additions,
      deletions: pr.deletions,
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: "unknown",
      reviewDecision: "none",
      autoMergeEnabled: false,
    };

    this.tracker.lastKnown.set(sessionId, summary);
    this.sessionManager.setPrStatus(sessionId, summary);
    // pr_status updates the card; session_list updates the sidebar's closed state.
    if (prState === "closed" && this.sessionManager.markClosed(sessionId)) {
      this.sseBroadcast("session_list", { sessions: this.sessionManager.list() });
    }
    this.tracker.mergedSessions.add(sessionId);
    this.autoConflictResolveManager?.delete(sessionId);
    this.autoFix.delete(sessionId);
    this.remediationArbiter.delete(sessionId);
    // Record then clear arming: it must not carry into the session's next PR.
    const armedAtTerminal = this.autoMerge.get(sessionId);
    if (!alreadyTerminal && (armedAtTerminal?.enabled || nativeArmedOnGitHub)) {
      const mode = armedAtTerminal?.enabled && armedAtTerminal.managed
        ? `managed (${armedAtTerminal.managedReason ?? "native-unavailable"})`
        : "native";
      console.log(
        `[auto-merge] PR #${pr.number} for ${sessionId} reached ${prState} with auto-merge armed: ${mode}`,
      );
    }
    this.autoMerge.delete(sessionId);
    this.sseBroadcast("pr_status", { updates: [summary] });

    if (!alreadyTerminal && this.onPrTerminalState) {
      this.onPrTerminalState({
        sessionId,
        outcome: isMerged ? "merged" : "closed",
        prNumber: pr.number,
        prUrl: pr.url,
        prTitle: pr.title,
        branch,
        ...(pr.merge_commit_sha ? { mergeSha: pr.merge_commit_sha } : {}),
      }).catch((err: unknown) => {
        console.error(`[pr-poller] notify-on-merge watch handling error for ${sessionId}:`, err);
      });
    }

    if (isMerged && !alreadyTerminal) {
      // Anchor reset to the merged PR head; local HEAD may contain later unmerged work.
      if (pr.head_sha) {
        this.sessionManager.setMergedHeadSha(sessionId, pr.head_sha);
      } else {
        console.warn(`[pr-poller] merged PR #${pr.number} for ${sessionId} had no head.sha — auto-reset anchor not recorded`);
      }
      if (this.onMergeDetectedCb) {
        const handling = this.onMergeDetectedCb(sessionId)
          .catch((err: unknown) => {
            console.error(`[pr-poller] Post-merge archive error for ${sessionId}:`, err);
          })
          .finally(() => {
            if (this.mergeHandling.get(sessionId) === handling) this.mergeHandling.delete(sessionId);
          });
        this.mergeHandling.set(sessionId, handling);
      }
      if (this.onMergedPr) {
        this.onMergedPr({
          sessionId,
          prNumber: pr.number,
          prUrl: pr.url,
          prTitle: pr.title,
          body: pr.body,
        }).catch((err: unknown) => {
          console.error(`[pr-poller] Issue-lifecycle merge handling error for ${sessionId}:`, err);
        });
      }
    }

  }

  /** A re-armed branch can name another PR; settlement must use the original number.
   * Recheck the caller's guard after the read, before writing session state.
   */
  async promoteMergedPrByNumber(args: {
    sessionId: string;
    owner: string;
    repo: string;
    prNumber: number;
    guard?: (pr: TerminalPrFacts) => boolean;
  }): Promise<{ pr: TerminalPrFacts; promoted: boolean } | null> {
    const pr = await this.githubAuth.findPullRequestByNumber(args.owner, args.repo, args.prNumber);
    if (!pr) return null;
    if (pr.merged_at === null && pr.state !== "closed") return { pr, promoted: false };
    if (args.guard && !args.guard(pr)) return { pr, promoted: false };
    this.promoteTerminal({
      sessionId: args.sessionId,
      owner: args.owner,
      repo: args.repo,
      branch: pr.head_ref,
      pr,
      force: true,
    });
    return { pr, promoted: true };
  }

  async readPrByNumber(owner: string, repo: string, prNumber: number): Promise<TerminalPrFacts | null> {
    return this.githubAuth.findPullRequestByNumber(owner, repo, prNumber);
  }
}
