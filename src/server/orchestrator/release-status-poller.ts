import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ReleaseStatusSummary, ReleasePhase } from "../shared/types/release-types.js";
import { parseGitHubRemote } from "./git-utils.js";

export const RELEASE_POLL_INTERVAL_MS = 15_000;
export const RELEASE_SLOW_INTERVAL_MS = 120_000;
const VIEWER_DETACH_GRACE_MS = 60_000;

const ACTIVE_PHASES: ReadonlySet<ReleasePhase> = new Set(["pr_open", "pr_merged", "gating", "deploying"]);
const TERMINAL_PHASES: ReadonlySet<ReleasePhase> = new Set(["released", "failed", "cancelled"]);

function cardIdFor(sessionId: string, tag: string): string {
  return `release:${sessionId}:${tag}`;
}

interface TrackedRepo {
  owner: string;
  repo: string;
  repoKey: string;
}

export interface ReleaseProposeInput {
  version: string;
  tag: string;
  prerelease: boolean;
  bumpType?: ReleaseStatusSummary["bumpType"];
  versionSource?: string;
  mechanism?: ReleaseStatusSummary["mechanism"];
  notes?: string;
}

export interface ReleaseTaggedInput {
  tag: string;
  version: string;
  prerelease: boolean;
  sha?: string;
  notes?: string;
}

export interface ReleasePrOpenedInput {
  version: string;
  tag: string;
  prerelease: boolean;
  prNumber: number;
  prUrl: string;
  releaseBranch: string;
  bumpType?: ReleaseStatusSummary["bumpType"];
  versionSource?: string;
  notes?: string;
}

export class ReleaseStatusPoller {
  private githubAuth: GitHubAuthManager;
  // bootstrap-managers wires this to history persistence and live emission.
  private onCard: (card: ReleaseStatusSummary) => void;
  private runnerRegistry?: SessionRunnerRegistry;

  private supervisor: ReturnType<typeof setInterval> | null = null;
  private cards = new Map<string, ReleaseStatusSummary>();
  private sessionRepos = new Map<string, TrackedRepo>();
  private lastPolledAt = new Map<string, number>();
  private releasedByKey = new Map<string, ReleaseStatusSummary>();
  // Zero means viewers present or no detach observed.
  private lastViewerDetachAt = 0;

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    onCard?: (card: ReleaseStatusSummary) => void;
    runnerRegistry?: SessionRunnerRegistry;
  }) {
    this.githubAuth = opts.githubAuth;
    this.onCard = opts.onCard ?? (() => {});
    this.runnerRegistry = opts.runnerRegistry;
  }

  private anyViewersConnected(): boolean {
    const registry = this.runnerRegistry;
    if (!registry) return true;
    for (const id of registry.ids()) {
      const r = registry.get(id);
      if (r && r.viewerCount > 0) return true;
    }
    return false;
  }

  private anyActiveRelease(): boolean {
    for (const card of this.cards.values()) {
      if (ACTIVE_PHASES.has(card.phase)) return true;
    }
    return false;
  }

  private globalGateOpen(): boolean {
    if (this.anyViewersConnected()) return true;
    if (this.anyActiveRelease()) return true;
    if (
      this.lastViewerDetachAt > 0 &&
      Date.now() - this.lastViewerDetachAt < VIEWER_DETACH_GRACE_MS
    ) {
      return true;
    }
    return false;
  }

  private perSessionInterval(sessionId: string): number {
    const card = this.cards.get(sessionId);
    if (card && ACTIVE_PHASES.has(card.phase)) return RELEASE_POLL_INTERVAL_MS;
    return RELEASE_SLOW_INTERVAL_MS;
  }

  notifyViewerAttached(): void {
    this.lastViewerDetachAt = 0;
    this.ensureSupervisor();
  }

  notifyViewerDetached(): void {
    if (this.anyViewersConnected()) return;
    if (this.lastViewerDetachAt === 0) this.lastViewerDetachAt = Date.now();
  }

  private resolveRepo(sessionId: string, repoUrl: string | undefined): TrackedRepo | null {
    const existing = this.sessionRepos.get(sessionId);
    if (existing) return existing;
    if (!repoUrl) return null;
    const parsed = parseGitHubRemote(repoUrl);
    if (!parsed) return null;
    const tracked: TrackedRepo = {
      owner: parsed.owner,
      repo: parsed.repo,
      repoKey: `${parsed.owner}/${parsed.repo}`,
    };
    this.sessionRepos.set(sessionId, tracked);
    return tracked;
  }

  propose(sessionId: string, repoUrl: string | undefined, input: ReleaseProposeInput): void {
    this.resolveRepo(sessionId, repoUrl);
    const card: ReleaseStatusSummary = {
      sessionId,
      cardId: cardIdFor(sessionId, input.tag),
      phase: "proposed",
      version: input.version,
      tag: input.tag,
      prerelease: input.prerelease,
      ...(input.bumpType ? { bumpType: input.bumpType } : {}),
      ...(input.versionSource ? { versionSource: input.versionSource } : {}),
      ...(input.mechanism ? { mechanism: input.mechanism } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.setCard(card);
  }

  markPrOpened(sessionId: string, repoUrl: string | undefined, input: ReleasePrOpenedInput): void {
    const repo = this.resolveRepo(sessionId, repoUrl);
    const prev = this.cards.get(sessionId);

    if (repo) {
      const dedup = this.releasedByKey.get(`${repo.repoKey}#${input.tag}`);
      if (dedup) {
        this.setCard({ ...dedup, sessionId, cardId: cardIdFor(sessionId, input.tag), alreadyReleased: true });
        return;
      }
    }

    const card: ReleaseStatusSummary = {
      sessionId,
      cardId: cardIdFor(sessionId, input.tag),
      phase: "pr_open",
      version: input.version,
      tag: input.tag,
      prerelease: input.prerelease,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      releaseBranch: input.releaseBranch,
      ...(input.bumpType ?? prev?.bumpType ? { bumpType: input.bumpType ?? prev?.bumpType } : {}),
      ...(input.versionSource ?? prev?.versionSource ? { versionSource: input.versionSource ?? prev?.versionSource } : {}),
      ...(input.notes ?? prev?.notes ? { notes: input.notes ?? prev?.notes } : {}),
    };
    this.setCard(card);
    this.ensureSupervisor();
    void this.pollSession(sessionId).catch((err: unknown) => {
      console.error(`[release-poller] initial PR poll error for ${sessionId}:`, err);
    });
  }

  markTagged(sessionId: string, repoUrl: string | undefined, input: ReleaseTaggedInput): void {
    const repo = this.resolveRepo(sessionId, repoUrl);
    const prev = this.cards.get(sessionId);

    if (repo) {
      const dedup = this.releasedByKey.get(`${repo.repoKey}#${input.tag}`);
      if (dedup) {
        this.setCard({ ...dedup, sessionId, cardId: cardIdFor(sessionId, input.tag), alreadyReleased: true });
        return;
      }
    }

    const card: ReleaseStatusSummary = {
      sessionId,
      cardId: cardIdFor(sessionId, input.tag),
      phase: "gating",
      version: input.version,
      tag: input.tag,
      prerelease: input.prerelease,
      ...(input.sha ? { commitSha: input.sha } : {}),
      ...(input.notes ?? prev?.notes ? { notes: input.notes ?? prev?.notes } : {}),
      ...(prev?.bumpType ? { bumpType: prev.bumpType } : {}),
      ...(prev?.versionSource ? { versionSource: prev.versionSource } : {}),
    };
    this.setCard(card);
    this.ensureSupervisor();
    void this.pollSession(sessionId).catch((err: unknown) => {
      console.error(`[release-poller] initial poll error for ${sessionId}:`, err);
    });
  }

  markAlreadyReleased(
    sessionId: string,
    repoUrl: string | undefined,
    input: { tag: string; version?: string },
  ): void {
    const repo = this.resolveRepo(sessionId, repoUrl);
    const prev = this.cards.get(sessionId);
    const base: ReleaseStatusSummary = {
      sessionId,
      cardId: cardIdFor(sessionId, input.tag),
      phase: "published",
      version: input.version ?? prev?.version ?? input.tag.replace(/^v/, ""),
      tag: input.tag,
      prerelease: prev?.prerelease ?? false,
      alreadyReleased: true,
      ...(prev?.notes ? { notes: prev.notes } : {}),
    };
    this.setCard(base);

    if (!repo) return;
    void this.loadAlreadyReleased(sessionId, repo, input.tag).catch((err: unknown) => {
      console.error(`[release-poller] already-released read error for ${sessionId}:`, err);
    });
  }

  private async loadAlreadyReleased(sessionId: string, repo: TrackedRepo, tag: string): Promise<void> {
    const release = await this.githubAuth.getReleaseByTag(repo.owner, repo.repo, tag);
    if (!release) return;
    const current = this.cards.get(sessionId);
    if (!current) return;
    if (current.tag !== tag) return;
    const next: ReleaseStatusSummary = {
      ...current,
      phase: "released",
      prerelease: release.prerelease,
      notes: release.body || current.notes,
      release: {
        name: release.name,
        body: release.body,
        htmlUrl: release.htmlUrl,
        prerelease: release.prerelease,
        publishedAt: release.publishedAt,
        tagName: release.tagName,
      },
    };
    this.setCard(next);
    this.releasedByKey.set(`${repo.repoKey}#${tag}`, next);
  }

  cancel(sessionId: string): void {
    const prev = this.cards.get(sessionId);
    if (!prev) return;
    this.lastPolledAt.delete(sessionId);
    this.setCard({ ...prev, phase: "cancelled" });
  }

  untrackSession(sessionId: string): void {
    this.cards.delete(sessionId);
    this.sessionRepos.delete(sessionId);
    this.lastPolledAt.delete(sessionId);
  }

  getStatus(sessionId: string): ReleaseStatusSummary | undefined {
    return this.cards.get(sessionId);
  }

  destroy(): void {
    this.stopSupervisor();
    this.lastPolledAt.clear();
  }

  private setCard(card: ReleaseStatusSummary): void {
    const prev = this.cards.get(card.sessionId);
    if (prev && JSON.stringify(prev) === JSON.stringify(card)) return;
    this.cards.set(card.sessionId, card);
    if (TERMINAL_PHASES.has(card.phase)) this.lastPolledAt.delete(card.sessionId);
    this.onCard(card);
  }

  private ensureSupervisor(): void {
    if (this.supervisor) return;
    if (!this.globalGateOpen()) return;
    this.supervisor = setInterval(() => this.supervisorTick(), RELEASE_POLL_INTERVAL_MS);
  }

  private stopSupervisor(): void {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
  }

  private supervisorTick(): void {
    if (!this.globalGateOpen()) {
      this.stopSupervisor();
      return;
    }
    const now = Date.now();
    for (const [sessionId, card] of this.cards) {
      if (!ACTIVE_PHASES.has(card.phase)) continue;
      const interval = this.perSessionInterval(sessionId);
      const last = this.lastPolledAt.get(sessionId) ?? 0;
      if (now - last < interval) continue;
      void this.pollSession(sessionId).catch((err: unknown) => {
        console.error(`[release-poller] poll error for ${sessionId}:`, err);
      });
    }
  }

  private async pollSession(sessionId: string): Promise<void> {
    const card = this.cards.get(sessionId);
    const repo = this.sessionRepos.get(sessionId);
    if (!card || !repo || !ACTIVE_PHASES.has(card.phase)) return;
    if (!this.githubAuth.authenticated) return;

    this.lastPolledAt.set(sessionId, Date.now());

    if (card.phase === "pr_open") {
      if (typeof card.prNumber !== "number") return;
      const pr = await this.githubAuth.viewPullRequest(repo.owner, repo.repo, card.prNumber);
      const current = this.cards.get(sessionId);
      if (!current) return;
      if (current.tag !== card.tag || current.phase !== "pr_open") return;
      if (!pr) return;
      if (pr.merged) {
        this.setCard({ ...current, phase: "pr_merged" });
        void this.pollSession(sessionId).catch((err: unknown) => {
          console.error(`[release-poller] post-merge poll error for ${sessionId}:`, err);
        });
        return;
      }
      if (pr.state === "closed") {
        this.setCard({
          ...current,
          phase: "failed",
          errorMessage: "The release PR was closed without merging.",
        });
      }
      return;
    }

    const checks = card.commitSha
      ? await this.githubAuth.getCheckStatus(repo.owner, repo.repo, card.commitSha)
      : undefined;
    const release = await this.githubAuth.getReleaseByTag(repo.owner, repo.repo, card.tag);

    // Cancellation or a new tag can arrive during the awaits.
    const current = this.cards.get(sessionId);
    if (!current) return;
    if (current.tag !== card.tag || !ACTIVE_PHASES.has(current.phase)) return;

    if (release) {
      const next: ReleaseStatusSummary = {
        ...current,
        phase: "released",
        prerelease: release.prerelease,
        ...(checks ? { checks } : {}),
        notes: release.body || current.notes,
        release: {
          name: release.name,
          body: release.body,
          htmlUrl: release.htmlUrl,
          prerelease: release.prerelease,
          publishedAt: release.publishedAt,
          tagName: release.tagName,
        },
      };
      this.releasedByKey.set(`${repo.repoKey}#${current.tag}`, next);
      this.setCard(next);
      return;
    }

    if (checks?.state === "failure") {
      this.setCard({
        ...current,
        phase: "failed",
        checks,
        errorMessage: `Release gate failed (${checks.failed} of ${checks.total} checks failed).`,
      });
      return;
    }

    if (checks) this.setCard({ ...current, phase: "gating", checks });
  }
}
