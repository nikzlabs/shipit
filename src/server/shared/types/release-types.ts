/**
 * Release lifecycle types — the inline "release lifecycle card" feature
 * (docs/171). A release of a repo is proposed by the agent in chat, confirmed
 * by the user on the card, then tagged + pushed by the agent; the repo's own
 * CI publishes the GitHub Release off the pushed tag (the MVP is tag-triggered,
 * option (a) in docs/171). The `ReleaseStatusPoller` reflects gate/CI + the
 * published Release inline via the `release_status` SSE event, mirroring the
 * PR lifecycle card (`PrStatusSummary` / `pr_status`).
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
 * - `gating`    — tag pushed; the repo's CI is running its release gate.
 * - `published` — the GitHub Release exists (grouped notes, prerelease flag).
 * - `deploying` — a downstream deploy is in flight for the tagged commit.
 * - `released`  — Release published AND (deploy succeeded OR no deploy target).
 * - `failed`    — gate failed / push rejected / API error.
 */
export type ReleasePhase =
  | "proposed"
  | "tagging"
  | "gating"
  | "published"
  | "deploying"
  | "released"
  | "failed";

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
 * One session's release lifecycle snapshot, broadcast over `release_status`.
 * Keyed by `sessionId` exactly like `PrStatusSummary`.
 */
export interface ReleaseStatusSummary {
  sessionId: string;
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
}
