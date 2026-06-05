/**
 * Issue tracker services (docs/170 — inline tracker Issues tab).
 *
 * Pure functions over `CredentialStore` + the tracker registry, consumed by
 * `api-routes-issues.ts`. Read-only + connect/bind: list trackers, list issues
 * for a tracker, and the Linear connect/team-binding mutations. No write-back
 * to the tracker (setting priority/status/comments) — that's a deferred
 * follow-up per the SHI-67 scope.
 */

import type { CredentialStore } from "../credential-store.js";
import type {
  ListIssuesResult,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
} from "../../shared/types.js";
import {
  buildTrackerRegistry,
  listLinearTeams,
  type FetchImpl,
  type GitHubTrackerContext,
} from "../trackers/index.js";
import { ServiceError } from "./types.js";

/** All known trackers + their configured state — drives the sub-tab switcher. */
export function listTrackers(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerInfo[] {
  return buildTrackerRegistry(credentialStore, fetchImpl, github).list();
}

/**
 * List issues for one tracker, priority-sorted. When the tracker isn't
 * configured we return its info with an empty list (the client renders the
 * "Connect" empty state) rather than erroring — an unconfigured tracker is a
 * normal state, not a failure.
 */
export async function listIssuesForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
  options?: { includeDone?: boolean },
): Promise<ListIssuesResult> {
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) {
    throw new ServiceError(404, `Unknown tracker: ${trackerId}`);
  }
  if (!tracker.isConfigured()) {
    return { tracker: tracker.info(), issues: [] };
  }
  try {
    const issues = await tracker.listIssues(options);
    return { tracker: tracker.info(), issues };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetch a single issue from one tracker by its tracker-native id (docs/175 —
 * the agent's `shipit issue view` path). The same registry that backs the
 * Issues tab, reused for a single-issue read: GitHub wants the bare number,
 * Linear the key (the caller resolves this via `parseIssueRef`).
 *
 * Unlike `listIssuesForTracker`, an unconfigured tracker is an error here, not
 * an empty result: a `view` has no useful "empty state" — if the tracker can't
 * be reached the agent needs to know why. A missing issue (or a GitHub PR
 * number, which `getIssue` returns null for) is a 404.
 */
export async function getIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<{ tracker: TrackerInfo; issue: TrackerIssue }> {
  if (!id.trim()) {
    throw new ServiceError(400, "An issue id is required");
  }
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) {
    throw new ServiceError(404, `Unknown tracker: ${trackerId}`);
  }
  if (!tracker.isConfigured()) {
    throw new ServiceError(400, `${tracker.label} is not configured`);
  }
  let issue: TrackerIssue | null;
  try {
    issue = await tracker.getIssue(id);
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
  if (!issue) {
    throw new ServiceError(404, `Issue not found: ${id}`);
  }
  return { tracker: tracker.info(), issue };
}

// ---- Linear connect / binding (settings) ----

/**
 * Store a Linear API token after validating it can reach the API. We validate
 * by listing teams (cheap, read-only); the returned teams are handed back so
 * the settings UI can immediately populate the team picker.
 */
export async function connectLinear(
  credentialStore: CredentialStore,
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ teams: { id: string; key: string; name: string }[] }> {
  const trimmed = token?.trim();
  if (!trimmed) throw new ServiceError(400, "A Linear API token is required");
  let teams: { id: string; key: string; name: string }[];
  try {
    teams = await listLinearTeams(trimmed, fetchImpl);
  } catch (err) {
    throw new ServiceError(400, `Could not validate Linear token: ${err instanceof Error ? err.message : String(err)}`);
  }
  credentialStore.setLinearToken(trimmed);
  return { teams };
}

/** List the workspace's Linear teams for the settings team picker. */
export async function getLinearTeams(
  credentialStore: CredentialStore,
  fetchImpl: FetchImpl = fetch,
): Promise<{ id: string; key: string; name: string }[]> {
  const token = credentialStore.getLinearToken();
  if (!token) throw new ServiceError(400, "Connect Linear first");
  try {
    return await listLinearTeams(token, fetchImpl);
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/** Bind the Issues tab to a specific Linear team. */
export function setLinearTeam(
  credentialStore: CredentialStore,
  team: { id?: string; key?: string; name?: string } | undefined,
): TrackerInfo {
  if (!team?.id?.trim() || !team.key?.trim() || !team.name?.trim()) {
    throw new ServiceError(400, "A Linear team (id, key, name) is required");
  }
  if (!credentialStore.getLinearToken()) {
    throw new ServiceError(400, "Connect Linear first");
  }
  credentialStore.setLinearTeam({ id: team.id, key: team.key, name: team.name });
  return buildTrackerRegistry(credentialStore).get("linear")!.info();
}

/** Disconnect Linear: clear token + team binding. */
export function disconnectLinear(credentialStore: CredentialStore): void {
  credentialStore.clearLinear();
}
