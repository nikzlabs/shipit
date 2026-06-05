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
  IssueWriteUndo,
  IssueWriteVerb,
  IssueWriteCard,
} from "../../shared/types.js";
import {
  buildTrackerRegistry,
  listLinearTeams,
  TrackerResolutionError,
  type Tracker,
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
 * Resolve a configured tracker or throw a `ServiceError` the route maps to an
 * HTTP status: 404 for an unknown tracker, 409 for a known-but-unconnected one
 * (the agent should connect it, not retry). Used by the write services below.
 */
function resolveConfiguredTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Tracker {
  const tracker = buildTrackerRegistry(credentialStore, fetchImpl, github).get(trackerId as TrackerId);
  if (!tracker) throw new ServiceError(404, `Unknown tracker: ${trackerId}`);
  if (!tracker.isConfigured()) {
    throw new ServiceError(409, `${tracker.label} is not connected. Connect it in Settings → Issues.`);
  }
  return tracker;
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

// ---- Writes (docs/177) ------------------------------------------------------

/**
 * The result of a do-then-surface write: the issue (post-write for edit/status/
 * assignee; current for comment), a human summary, and the undo snapshot the
 * provenance card carries. The route stamps tracker/attribution/cardId on top.
 */
export interface IssueWriteOutcome {
  issue: TrackerIssue;
  verb: IssueWriteVerb;
  summary: string;
  undo: IssueWriteUndo;
}

/** Map a `TrackerResolutionError` to a 422 listing the valid options. */
function toResolutionServiceError(err: unknown): never {
  if (err instanceof TrackerResolutionError) {
    const list = err.options.length > 0 ? `\nValid ${err.kind} options: ${err.options.join(", ")}` : "";
    throw new ServiceError(422, `${err.message}${list}`);
  }
  throw new ServiceError(502, err instanceof Error ? err.message : String(err));
}

async function loadIssueOr404(tracker: Tracker, id: string): Promise<TrackerIssue> {
  let issue: TrackerIssue | null;
  try {
    issue = await tracker.getIssue(id);
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
  if (!issue) throw new ServiceError(404, `Issue not found: ${id}`);
  return issue;
}

/** Add a comment; undo deletes it by the returned comment id. */
export async function commentOnIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  body: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  const issue = await loadIssueOr404(tracker, id);
  let commentId: string;
  try {
    commentId = (await tracker.addComment(id, body)).id;
  } catch (err) {
    toResolutionServiceError(err);
  }
  return {
    issue,
    verb: "comment",
    summary: `commented on ${issue.identifier}`,
    undo: { kind: "comment", commentId: commentId! },
  };
}

/** Edit title and/or description; snapshot the prior values for undo. */
export async function updateIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  patch: { title?: string; description?: string },
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  const prior = await loadIssueOr404(tracker, id);
  let updated: TrackerIssue;
  try {
    updated = await tracker.updateIssue(id, patch);
  } catch (err) {
    toResolutionServiceError(err);
  }
  const undo: IssueWriteUndo = {
    kind: "edit",
    ...(patch.title !== undefined ? { previousTitle: prior.title } : {}),
    ...(patch.description !== undefined ? { previousDescription: prior.description ?? "" } : {}),
  };
  const changed = [patch.title !== undefined ? "title" : null, patch.description !== undefined ? "description" : null]
    .filter(Boolean)
    .join(" & ");
  return { issue: updated!, verb: "edit", summary: `edited ${changed || "issue"} on ${updated!.identifier}`, undo };
}

/** Set status (normalized type or native name); snapshot the prior native name. */
export async function setIssueStatusForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  status: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  const prior = await loadIssueOr404(tracker, id);
  let updated: TrackerIssue;
  try {
    updated = await tracker.setStatus(id, status);
  } catch (err) {
    toResolutionServiceError(err);
  }
  return {
    issue: updated!,
    verb: "status",
    summary: `set ${updated!.identifier} → ${updated!.status?.name ?? status}`,
    // Restore by the prior native state name (both trackers accept native names).
    undo: { kind: "status", previousStatus: prior.status?.name ?? "open" },
  };
}

/** Set/clear assignee; snapshot the prior tracker-internal assignee id. */
export async function setIssueAssigneeForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  assignee: string | null,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  const prior = await loadIssueOr404(tracker, id);
  let updated: TrackerIssue;
  try {
    updated = await tracker.setAssignee(id, assignee);
  } catch (err) {
    toResolutionServiceError(err);
  }
  const summary =
    assignee === null
      ? `unassigned ${updated!.identifier}`
      : `assigned ${updated!.identifier} → ${updated!.assignee?.name ?? assignee}`;
  return {
    issue: updated!,
    verb: "assignee",
    summary,
    undo: { kind: "assignee", previousAssigneeId: prior.assigneeId ?? null },
  };
}

/**
 * Reverse a previously-recorded write — the Undo affordance on the provenance
 * card (docs/177). Replays the snapshot captured at write time: delete the
 * comment, restore the prior title/description, restore the prior status name,
 * or re-assign the prior internal id (verbatim, never re-resolved).
 */
export async function undoIssueWrite(
  credentialStore: CredentialStore,
  card: Pick<IssueWriteCard, "tracker" | "issueId" | "undo">,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<void> {
  const tracker = resolveConfiguredTracker(credentialStore, card.tracker, fetchImpl, github);
  try {
    switch (card.undo.kind) {
      case "comment":
        await tracker.deleteComment(card.undo.commentId);
        return;
      case "edit":
        await tracker.updateIssue(card.issueId, {
          ...(card.undo.previousTitle !== undefined ? { title: card.undo.previousTitle } : {}),
          ...(card.undo.previousDescription !== undefined ? { description: card.undo.previousDescription } : {}),
        });
        return;
      case "status":
        await tracker.setStatus(card.issueId, card.undo.previousStatus);
        return;
      case "assignee":
        // raw: replay the exact prior id (or null → unassign), no re-resolution.
        await tracker.setAssignee(card.issueId, card.undo.previousAssigneeId, { raw: true });
    }
  } catch (err) {
    toResolutionServiceError(err);
  }
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
