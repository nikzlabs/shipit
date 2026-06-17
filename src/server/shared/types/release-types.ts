/**
 * Release lifecycle types — the inline "release lifecycle card" feature
 * (docs/171). A release of a repo is proposed by the agent in chat, confirmed
 * by the user on the card, then tagged + pushed by the agent; the repo's own
 * CI publishes the GitHub Release off the pushed tag (the MVP is tag-triggered,
 * option (a) in docs/171). The `ReleaseStatusPoller` reflects gate/CI + the
 * published Release, driving every phase transition through one sink that
 * persists this summary to chat history (the card is a persisted transcript
 * card) and emits a per-session `release_card` WS — so it survives a reload and
 * an orchestrator restart.
 *
 * Phase 1 (MVP) only — the multi-ecosystem `release:` config, scaffolding, and
 * orchestrator-brokered `createRelease` are later phases and not represented
 * here.
 */

import type { GitHubDeploymentStatus } from "./deployment-types.js";

/** Semver bump category the agent proposed. */
export type ReleaseBumpType = "major" | "minor" | "patch" | "prerelease";

/**
 * Release lifecycle card state machine (docs/171 "Card state machine"):
 *
 * - `proposed`  — agent computed the next version + notes preview; the card
 *   shows Confirm & publish / Cancel. No tag exists yet.
 * - `tagging`   — confirmed; the agent is bumping + committing + tagging + pushing.
 * - `pr_open`   — (docs/214, release-branch mechanism) a version-bump PR is open
 *   against the release branch, awaiting a human merge. Long-lived (a release PR
 *   can sit open for days), so the card is persisted and the poller polls the PR.
 * - `pr_merged` — (docs/214) the release PR merged; the repo's CI is now tagging
 *   + publishing off the merged commit. Folds into the same gate/release polling
 *   as `gating`.
 * - `gating`    — tag pushed; the repo's CI is running its release gate.
 * - `published` — the GitHub Release exists (grouped notes, prerelease flag).
 * - `deploying` — a downstream deploy is in flight for the tagged commit.
 * - `released`  — Release published AND (deploy succeeded OR no deploy target).
 * - `failed`    — gate failed / push rejected / PR closed unmerged / API error.
 * - `cancelled` — the user declined the proposal on the card (terminal). The
 *   card collapses to a "Release cancelled" row and persists like any other
 *   terminal state, rather than vanishing.
 */
export type ReleasePhase =
  | "proposed"
  | "tagging"
  | "pr_open"
  | "pr_merged"
  | "gating"
  | "published"
  | "deploying"
  | "released"
  | "failed"
  | "cancelled";

/** CI/gate check rollup — same shape as the PR card's `checks`. */
export interface ReleaseChecksSummary {
  state: "pending" | "success" | "failure" | "none";
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/** The published GitHub Release, read by tag (`GET …/releases/tags/{tag}`). */
export interface PublishedReleaseInfo {
  /** Release name (falls back to the tag name when GitHub omits it). */
  name: string;
  /** Release body — grouped notes markdown from `.github/release.yml`. */
  body: string;
  /** Link-out to the Release on GitHub (overflow escape hatch only). */
  htmlUrl: string;
  prerelease: boolean;
  publishedAt: string | null;
  tagName: string;
}

/**
 * One session's release lifecycle snapshot. Persisted to chat history and
 * emitted over the per-session `release_card` WS (keyed by `cardId`).
 */
export interface ReleaseStatusSummary {
  sessionId: string;
  /**
   * Stable transcript-card id, `release:${sessionId}:${tag}`. The release card
   * is a persisted transcript card (docs/171, like the bug-report / issue-write
   * cards): this id keys both the in-place chat-history upsert and the live
   * `release_card` WS upsert, so every phase transition patches the SAME card
   * rather than appending a duplicate.
   */
  cardId: string;
  phase: ReleasePhase;
  /** Proposed/published version (no leading `v`), e.g. "0.3.0". */
  version: string;
  /** Tag name, e.g. "v0.3.0". */
  tag: string;
  prerelease: boolean;
  /** Bump category the agent proposed (proposed phase). */
  bumpType?: ReleaseBumpType;
  /** Version source file, e.g. "package.json". */
  versionSource?: string;
  /** Notes preview (proposed) or the published grouped notes (markdown). */
  notes?: string;
  /** The tag's commit SHA — used to poll the gate's check status. */
  commitSha?: string;
  /**
   * True when the tag already existed locally/remotely before this flow ran —
   * the flow is a no-op and the card shows an "already released" state instead
   * of duplicating the tag (docs/171 idempotency).
   */
  alreadyReleased?: boolean;
  checks?: ReleaseChecksSummary;
  release?: PublishedReleaseInfo;
  deployments?: GitHubDeploymentStatus[];
  errorMessage?: string;
  /**
   * docs/214 (release-branch mechanism) — the version-bump PR opened against the
   * release branch. Present from the `pr_open` phase onward. The poller polls
   * this PR until it merges, then falls into the existing tag/Release polling.
   */
  prNumber?: number;
  /** Link-out to the release PR on GitHub (overflow escape hatch only). */
  prUrl?: string;
  /** The release (maintenance) branch the bump PR targets, e.g. "stable". */
  releaseBranch?: string;
}
