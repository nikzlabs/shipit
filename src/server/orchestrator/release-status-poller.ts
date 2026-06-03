/**
 * ReleaseStatusPoller — orchestrator-level release lifecycle poller (docs/171
 * Phase 1), modeled on `pr-status-poller.ts`.
 *
 * Lifecycle: the agent proposes a release (card → `proposed`), the user confirms
 * on the card, the agent bumps + tags + pushes (card → `gating`), and this
 * poller reflects the gate/CI status and the published GitHub Release inline via
 * the `release_status` SSE event, reusing the PR poller's global poll gate and
 * fast/slow cadence.
 *
 * Card state is in-memory only (a release is an ephemeral, per-turn flow), so
 * there is no persistence layer here — unlike `PrStatusSummary`, which the
 * session store persists across restarts.
 *
 * Idempotency / dedup: a release is keyed by `{repoKey, tag}`. Once a tag is
 * observed as published/released, that `{repoKey, tag}` is remembered so a
 * second confirm of the same release surfaces the existing result instead of
 * re-polling a duplicate card (docs/171 "Idempotency races").
 */

import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ReleaseStatusSummary, ReleasePhase } from "../shared/types/release-types.js";
import { parseGitHubRemote } from "./git-utils.js";

/** Fast bucket — a release mid-gate/deploy wants prompt CI feedback. */
export const RELEASE_POLL_INTERVAL_MS = 15_000;
/** Slow bucket — a settled (published, awaiting deploy) release. */
export const RELEASE_SLOW_INTERVAL_MS = 120_000;
/**
 * Keep polling for this long after the last viewer detaches before pausing —
 * tolerates page reloads. Aligned with the PR poller's grace window.
 */
const VIEWER_DETACH_GRACE_MS = 60_000;

/** Phases that still need polling (a remote artifact may still change). */
const ACTIVE_PHASES: ReadonlySet<ReleasePhase> = new Set(["gating", "deploying"]);
/** Terminal phases — no further polling. */
const TERMINAL_PHASES: ReadonlySet<ReleasePhase> = new Set(["released", "failed"]);

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
  notes?: string;
}

export interface ReleaseTaggedInput {
  tag: string;
  version: string;
  prerelease: boolean;
  sha?: string;
  notes?: string;
}

export class ReleaseStatusPoller {
  private githubAuth: GitHubAuthManager;
  private sseBroadcast: (event: string, data: unknown) => void;
  private runnerRegistry?: SessionRunnerRegistry;

  /** Single supervisor timer (one for the whole poller). */
  private supervisor: ReturnType<typeof setInterval> | null = null;
  /** sessionId → current card snapshot. */
  private cards = new Map<string, ReleaseStatusSummary>();
  /** sessionId → repo coordinates. */
  private sessionRepos = new Map<string, TrackedRepo>();
  /** sessionId → timestamp of this session's last poll. */
  private lastPolledAt = new Map<string, number>();
  /** `${repoKey}#${tag}` → published release snapshot, for dedup across sessions. */
  private releasedByKey = new Map<string, ReleaseStatusSummary>();
  /** `0` means viewers present / never seen; else the last-detach timestamp. */
  private lastViewerDetachAt = 0;

  constructor(opts: {
    githubAuth: GitHubAuthManager;
    sseBroadcast: (event: string, data: unknown) => void;
    runnerRegistry?: SessionRunnerRegistry;
  }) {
    this.githubAuth = opts.githubAuth;
    this.sseBroadcast = opts.sseBroadcast;
    this.runnerRegistry = opts.runnerRegistry;
  }

  // ---- Global gate (mirrors PrStatusPoller) ----

  private anyViewersConnected(): boolean {
    const registry = this.runnerRegistry;
    if (!registry) return true;
    for (const id of registry.ids()) {
      const r = registry.get(id);
      if (r && r.viewerCount > 0) return true;
    }
    return false;
  }

  /** True when any tracked release is mid-flight (its result still changes). */
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

  // ---- Public hooks ----

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

  /**
   * Record an agent-proposed release. Sets the card to `proposed` (Confirm &
   * publish / Cancel) — no tag exists yet, so nothing is polled.
   */
  propose(sessionId: string, repoUrl: string | undefined, input: ReleaseProposeInput): void {
    this.resolveRepo(sessionId, repoUrl);
    const card: ReleaseStatusSummary = {
      sessionId,
      phase: "proposed",
      version: input.version,
      tag: input.tag,
      prerelease: input.prerelease,
      ...(input.bumpType ? { bumpType: input.bumpType } : {}),
      ...(input.versionSource ? { versionSource: input.versionSource } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.setCard(card);
  }

  /**
   * Record that the agent has tagged + pushed (post-confirmation). Moves the
   * card to `gating` and starts polling the gate + the published Release. If
   * this `{repoKey, tag}` was already observed as released, surface that result
   * instead (dedup).
   */
  markTagged(sessionId: string, repoUrl: string | undefined, input: ReleaseTaggedInput): void {
    const repo = this.resolveRepo(sessionId, repoUrl);
    const prev = this.cards.get(sessionId);

    if (repo) {
      const dedup = this.releasedByKey.get(`${repo.repoKey}#${input.tag}`);
      if (dedup) {
        this.setCard({ ...dedup, sessionId, alreadyReleased: true });
        return;
      }
    }

    const card: ReleaseStatusSummary = {
      sessionId,
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

  /**
   * Record that the tag already existed (idempotency no-op). Reads the existing
   * Release (if any) and shows the card in a terminal "already released" state.
   */
  markAlreadyReleased(
    sessionId: string,
    repoUrl: string | undefined,
    input: { tag: string; version?: string },
  ): void {
    const repo = this.resolveRepo(sessionId, repoUrl);
    const prev = this.cards.get(sessionId);
    const base: ReleaseStatusSummary = {
      sessionId,
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

  /** Read the existing Release for an "already released" card and fold it in. */
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

  /** Dismiss a session's release card (user cancelled). */
  cancel(sessionId: string): void {
    if (!this.cards.has(sessionId)) return;
    this.cards.delete(sessionId);
    this.lastPolledAt.delete(sessionId);
    this.sseBroadcast("release_status", { updates: [], removals: [sessionId] });
  }

  /** Drop all state for a session (archive / untrack). */
  untrackSession(sessionId: string): void {
    const had = this.cards.delete(sessionId);
    this.sessionRepos.delete(sessionId);
    this.lastPolledAt.delete(sessionId);
    if (had) this.sseBroadcast("release_status", { updates: [], removals: [sessionId] });
  }

  getStatus(sessionId: string): ReleaseStatusSummary | undefined {
    return this.cards.get(sessionId);
  }

  /** All current cards — for the SSE snapshot on connect. */
  getAllStatuses(): ReleaseStatusSummary[] {
    return [...this.cards.values()];
  }

  destroy(): void {
    this.stopSupervisor();
    this.lastPolledAt.clear();
  }

  // ---- Internals ----

  private setCard(card: ReleaseStatusSummary): void {
    const prev = this.cards.get(card.sessionId);
    if (prev && JSON.stringify(prev) === JSON.stringify(card)) return;
    this.cards.set(card.sessionId, card);
    if (TERMINAL_PHASES.has(card.phase)) this.lastPolledAt.delete(card.sessionId);
    this.sseBroadcast("release_status", { updates: [card] });
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

  /**
   * Poll one session's gate + published Release and advance its card.
   *
   *   - Release published → `released` (and remember for dedup).
   *   - No Release yet, gate failed → `failed`.
   *   - No Release yet, gate pending/none → stay `gating`.
   */
  private async pollSession(sessionId: string): Promise<void> {
    const card = this.cards.get(sessionId);
    const repo = this.sessionRepos.get(sessionId);
    if (!card || !repo || !ACTIVE_PHASES.has(card.phase)) return;
    if (!this.githubAuth.authenticated) return;

    this.lastPolledAt.set(sessionId, Date.now());

    const checks = card.commitSha
      ? await this.githubAuth.getCheckStatus(repo.owner, repo.repo, card.commitSha)
      : undefined;
    const release = await this.githubAuth.getReleaseByTag(repo.owner, repo.repo, card.tag);

    // Re-read after the awaits — the session may have been cancelled/retagged.
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

    // Still gating — surface check progress if we have it.
    if (checks) this.setCard({ ...current, phase: "gating", checks });
  }
}
