import type { GitHubDeploymentStatus } from "./deployment-types.js";

export type ReleaseBumpType = "major" | "minor" | "patch" | "prerelease";

// release-branch delegates tagging to CI after the bump PR merges.
export type ReleaseMechanism = "tag-triggered" | "brokered" | "release-branch";

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

export interface ReleaseChecksSummary {
  state: "pending" | "success" | "failure" | "none";
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface PublishedReleaseInfo {
  name: string;
  body: string;
  htmlUrl: string;
  prerelease: boolean;
  publishedAt: string | null;
  tagName: string;
}

export interface ReleaseStatusSummary {
  sessionId: string;
  /** Stable across phases for both history and live upserts. */
  cardId: string;
  phase: ReleasePhase;
  /** No leading "v". */
  version: string;
  tag: string;
  prerelease: boolean;
  bumpType?: ReleaseBumpType;
  versionSource?: string;
  notes?: string;
  commitSha?: string;
  alreadyReleased?: boolean;
  checks?: ReleaseChecksSummary;
  release?: PublishedReleaseInfo;
  deployments?: GitHubDeploymentStatus[];
  errorMessage?: string;
  prNumber?: number;
  prUrl?: string;
  releaseBranch?: string;
  /** Absent defaults to tag-triggered. */
  mechanism?: ReleaseMechanism;
}
