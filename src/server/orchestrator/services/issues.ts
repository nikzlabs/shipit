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
  ListIssueCommentsResult,
  ListLabelsResult,
  PostIssueCommentResult,
  MutateIssueResult,
  TrackerId,
  TrackerInfo,
  TrackerIssue,
  IssueLabel,
  IssueWriteUndo,
  IssueWriteVerb,
  IssueWriteContent,
  IssueWriteCard,
} from "../../shared/types.js";
import {
  buildTrackerRegistry,
  listLinearTeams,
  TrackerPermissionError,
  TrackerResolutionError,
  type Tracker,
  type TrackerRegistry,
  type FetchImpl,
  type GitHubTrackerContext,
} from "../trackers/index.js";
import type { TrackerDestination } from "../../shared/declared-tracker.js";
import { ServiceError } from "./types.js";

/**
 * Whether an issue's status marks it as a duplicate. A duplicate is terminal —
 * the work lives on the issue it duplicates — so it belongs with the done set,
 * not the open working set, and is dropped when the caller hasn't opted into
 * done issues (the Issues tab's "Show done" toggle off; the agent's default
 * `open` list scope). Matched on the normalized status *name* because neither
 * tracker exposes "duplicate" as a status *type*: Linear models it as a
 * workflow state named "Duplicate" (whose type may be `canceled` or, in some
 * teams, a non-terminal type that the adapter's type filter wouldn't catch),
 * and GitHub as a close-reason the read adapter folds into a plain "Closed".
 */
export function isDuplicateStatus(name?: string): boolean {
  return name?.trim().toLowerCase() === "duplicate";
}

/**
 * docs/248 req 11/19 — the message a fail-closed destination lookup produces.
 * Names the declared set so the agent can correct the reference instead of
 * retrying blind, and states plainly that there is no fallback.
 */
function undeclaredTrackerMessage(trackerId: string, registry: TrackerRegistry): string {
  const names = registry
    .destinations()
    .map((d) => d.name)
    .filter((n): n is string => Boolean(n));
  const declared =
    names.length > 0
      ? `Declared trackers: ${names.join(", ")}.`
      : "This repository declares no issue trackers — add an `issues.trackers` entry to shipit.yaml.";
  return `\`${trackerId}\` is not a tracker this repository declares, and ShipIt has no implicit tracker to fall back to. ${declared}`;
}

/**
 * docs/248 — the destinations a session can reach, plus the warnings its
 * `shipit.yaml` parse produced (req 8). This is the reference-resolution context
 * the `shipit issue` shim needs: names are declared in the repository, and the
 * shim resolves `planning#42` against exactly the set the orchestrator would.
 * Returning the warnings on the same call is what puts declaration problems in
 * CLI output where the agent can act on them.
 */
export function listTrackerDestinations(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): { destinations: TrackerDestination[]; warnings: string[] } {
  return {
    destinations: buildTrackerRegistry(credentialStore, fetchImpl, github).destinations(),
    warnings: github?.warnings ?? [],
  };
}

/** All declared trackers + their configured state — drives the sub-tab switcher. */
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
    throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
  }
  if (!tracker.isConfigured()) {
    return { tracker: tracker.info(), issues: [] };
  }
  try {
    // Fetch the issues and the tracker's assignable statuses together — the
    // latter powers the list's inline status editor (docs/191). Statuses are
    // best-effort: a failed states lookup must not blank the whole list, so it
    // degrades to "no inline editor" rather than a 502.
    const [issues, availableStatuses] = await Promise.all([
      tracker.listIssues(options),
      tracker.listStatuses().catch(() => [] as { name: string; type?: string; color?: string }[]),
    ]);
    // Duplicates are terminal, so they only belong in the list once the caller
    // opts into done issues — drop them from the default open working set
    // (tracker-neutral; see `isDuplicateStatus`).
    const visible = options?.includeDone
      ? issues
      : issues.filter((i) => !isDuplicateStatus(i.status?.name));
    return {
      tracker: tracker.info(),
      issues: visible,
      ...(availableStatuses.length > 0 ? { availableStatuses } : {}),
    };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * List the full set of available labels (name + color) for one tracker — the
 * foundation a follow-up label filter facet / on-page editor consumes, and the
 * same fetch that yields the real per-label colors the chips render (SHI-92
 * foundation). Like `listIssuesForTracker`, an unconfigured tracker is a normal
 * empty state (`{ labels: [] }`), not an error — the follow-up UI degrades to
 * "no labels to pick from" rather than surfacing a failure. A reachable-tracker
 * failure (auth/network) surfaces as a 502.
 */
export async function listLabelsForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<ListLabelsResult> {
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) {
    throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
  }
  if (!tracker.isConfigured()) {
    return { labels: [] };
  }
  try {
    return { labels: await tracker.listLabels() };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * List the full set of assignable statuses (name + type + color) for one tracker
 * — Linear's team workflow states in board order, GitHub's fixed Open/Closed
 * pair (SHI-199). The read-only discovery surface behind `shipit issue statuses`,
 * so the agent can see the valid `status` targets without first viewing an issue
 * (`view` only carries `availableStatuses` per-issue). Like `listLabelsForTracker`
 * an unconfigured tracker is a normal empty state (`{ statuses: [] }`), not an
 * error; a reachable-tracker failure (auth/network) surfaces as a 502.
 */
export async function listStatusesForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<{ statuses: { name: string; type?: string; color?: string }[] }> {
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) {
    throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
  }
  if (!tracker.isConfigured()) {
    return { statuses: [] };
  }
  try {
    return { statuses: await tracker.listStatuses() };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve a configured tracker or throw a `ServiceError` the route maps to an
 * HTTP status: 404 for an undeclared tracker, 409 for a declared-but-unconnected
 * one (the agent should connect it, not retry). Used by the write services below.
 *
 * docs/248 req 11 — the 404 is a **fail-closed**, not a lookup miss to route
 * around: an id naming no declared destination has nowhere to go, and the
 * message says so rather than leaving the agent to guess (req 19).
 */
function resolveConfiguredTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Tracker {
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
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
    throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
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

/**
 * List an issue's comments for the inline detail-view thread (docs/189
 * follow-up). The read sibling of `getIssueForTracker`: an unconfigured tracker
 * is an error (the thread has no useful empty state if the tracker can't be
 * reached), a missing issue surfaces as the tracker's own error. Oldest-first,
 * the order a reader expects a discussion in.
 */
export async function listIssueCommentsForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<ListIssueCommentsResult> {
  if (!id.trim()) {
    throw new ServiceError(400, "An issue id is required");
  }
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) {
    throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
  }
  if (!tracker.isConfigured()) {
    throw new ServiceError(400, `${tracker.label} is not configured`);
  }
  try {
    return { comments: await tracker.listComments(id) };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Post a comment a USER typed in the inline detail view (docs/189 follow-up).
 * Deliberately separate from `commentOnIssueForTracker` (the agent's
 * do-then-surface write): a user-authored comment is visible in the thread it
 * lands in, so it does NOT emit a provenance card into the chat transcript and
 * has no undo lifecycle. Returns the created comment so the client appends it to
 * the open thread without a refetch.
 */
export async function addIssueCommentForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  body: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<PostIssueCommentResult> {
  if (!id.trim()) throw new ServiceError(400, "An issue id is required");
  if (!body.trim()) throw new ServiceError(400, "A comment body is required");
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  try {
    return { comment: await tracker.addComment(id, body) };
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
}

// ---- User-initiated inline writes (docs/191) --------------------------------
//
// The status/priority siblings of `addIssueCommentForTracker`: a direct user
// manipulation in the Issues tab, NOT the agent's do-then-surface write. They
// return the updated issue for an in-place patch and emit no provenance card /
// undo (unlike `setIssueStatusForTracker`, which returns an `IssueWriteOutcome`).

/**
 * Set an issue's status from a user action in the UI (docs/191). `status` is a
 * native state name or a normalized type; an unresolvable value surfaces as a
 * 422 listing the valid options (via {@link toResolutionServiceError}).
 */
export async function userSetIssueStatus(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  status: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<MutateIssueResult> {
  if (!id.trim()) throw new ServiceError(400, "An issue id is required");
  if (!status.trim()) throw new ServiceError(400, "A status is required");
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  let issue: TrackerIssue;
  try {
    issue = await tracker.setStatus(id, status);
  } catch (err) {
    toResolutionServiceError(err);
  }
  return { issue: issue! };
}

/**
 * Set an issue's priority from a user action in the UI (docs/191). Linear-only
 * by product decision: GitHub has no native priority field and its adapter
 * rejects the write, so the UI only surfaces this control for Linear; a GitHub
 * call here returns a 422. `priority` is a normalized level
 * (`urgent|high|medium|low|none`).
 */
export async function userSetIssuePriority(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  priority: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<MutateIssueResult> {
  if (!id.trim()) throw new ServiceError(400, "An issue id is required");
  if (!priority.trim()) throw new ServiceError(400, "A priority is required");
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  let issue: TrackerIssue;
  try {
    issue = await tracker.updateIssue(id, { priority });
  } catch (err) {
    toResolutionServiceError(err);
  }
  return { issue: issue! };
}

/**
 * Replace an issue's full label set from a user action in the UI (the on-page
 * label editor). `labels` is the COMPLETE desired set of label names — a
 * wholesale replace, not a delta — because the editor commits the issue's
 * end-state, so removals are names left out and `[]` clears all labels. Both
 * trackers support labels natively (Linear issue labels, GitHub REST labels),
 * so this isn't gated like priority. An unresolvable name surfaces as a 422
 * listing the valid options (via {@link toResolutionServiceError}); GitHub, for
 * instance, rejects a name that isn't a defined repo label.
 */
export async function userSetIssueLabels(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  labels: string[],
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<MutateIssueResult> {
  if (!id.trim()) throw new ServiceError(400, "An issue id is required");
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  let issue: TrackerIssue;
  try {
    issue = await tracker.updateIssue(id, { labels });
  } catch (err) {
    toResolutionServiceError(err);
  }
  return { issue: issue! };
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
  /**
   * docs/189 — the display-only "what changed" values for the card's second
   * line (comment preview, title/status/assignee deltas). The route copies this
   * onto `IssueWriteCard.content`. Absent for a `create` (no "before" state).
   */
  content?: IssueWriteContent;
  /**
   * SHI-230 — labels minted on the fly by `--create-missing-labels` before this
   * write applied them. Each gets its OWN provenance card (verb `label`, undo =
   * delete-if-unused) in addition to the main write card, so a flag-driven
   * label creation is exactly as visible and reversible as an explicit
   * `shipit issue label create`. Absent when no labels were created.
   */
  labelCreations?: LabelCreation[];
}

/**
 * One label created as a do-then-surface write (SHI-230) — by the standalone
 * `shipit issue label create` or by `--create-missing-labels` on create/edit.
 * Carries everything the route needs to mint the provenance card.
 */
export interface LabelCreation {
  label: IssueLabel;
  summary: string;
  undo: Extract<IssueWriteUndo, { kind: "label" }>;
}

/**
 * Clip a comment body to a short preview for the provenance card's second line
 * (docs/189). Collapses runs of whitespace to keep the two-line clamp honest,
 * then truncates with an ellipsis. The full comment lives in the tracker.
 */
function clipComment(body: string): string {
  const collapsed = body.trim().replace(/\s+/g, " ");
  const MAX = 280;
  return collapsed.length > MAX ? `${collapsed.slice(0, MAX).trimEnd()}…` : collapsed;
}

/**
 * Map a `TrackerResolutionError` to a 422 listing the valid options. On the
 * agent's create/edit paths (`opts.labelHint`), an unknown-label rejection also
 * points at the two sanctioned ways to mint the label (SHI-230) — before that,
 * the dead end forced users to create labels by hand in the tracker UI.
 */
function toResolutionServiceError(err: unknown, opts?: { labelHint?: boolean }): never {
  // A refusal, not a resolution failure (SHI-86) — 403, and no options list,
  // because there is no other value the agent could have passed that would work.
  if (err instanceof TrackerPermissionError) {
    throw new ServiceError(403, err.message);
  }
  if (err instanceof TrackerResolutionError) {
    const list = err.options.length > 0 ? `\nValid ${err.kind} options: ${err.options.join(", ")}` : "";
    const hint =
      opts?.labelHint && err.kind === "label"
        ? "\nTo create a new label, run `shipit issue label create --name <name>` first, or re-run with --create-missing-labels."
        : "";
    throw new ServiceError(422, `${err.message}${list}${hint}`);
  }
  throw new ServiceError(502, err instanceof Error ? err.message : String(err));
}

/**
 * A short " (priority: High, labels: security, bug)" suffix for a write summary,
 * so the provenance card reflects the labels/priority that were set (SHI-92).
 * Empty when the issue has no labels and no explicit priority.
 */
function describeAttrs(issue: TrackerIssue): string {
  const parts: string[] = [];
  if (issue.priority.level !== "none") parts.push(`priority: ${issue.priority.label}`);
  if (issue.labels && issue.labels.length > 0) {
    parts.push(`labels: ${issue.labels.map((l) => l.name).join(", ")}`);
  }
  if (issue.parentIdentifier) parts.push(`parent: ${issue.parentIdentifier}`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
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

/**
 * Create a new tracker label so `--label` can apply it (SHI-230 — the
 * `shipit issue label create` verb). Do-then-surface like the other writes:
 * the label is created immediately and the route mints a provenance card whose
 * undo deletes the label if it's still unused. A same-name label already
 * existing (case-insensitive) is a 409 — nothing to create, and re-creating
 * would silently fork casing.
 */
export async function createLabelForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  name: string,
  opts: { color?: string; description?: string } = {},
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<LabelCreation> {
  const trimmed = name.trim();
  if (!trimmed) throw new ServiceError(400, "A label name is required");
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  let existing: IssueLabel[];
  try {
    existing = await tracker.listLabels();
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
  const clash = existing.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  if (clash) {
    throw new ServiceError(409, `Label "${clash.name}" already exists on ${tracker.label} — nothing to create.`);
  }
  let created: IssueLabel & { id: string };
  try {
    created = await tracker.createLabel({ name: trimmed, ...opts });
  } catch (err) {
    toResolutionServiceError(err);
  }
  return {
    label: { name: created!.name, ...(created!.color ? { color: created!.color } : {}) },
    summary: `created label "${created!.name}"`,
    undo: { kind: "label", labelId: created!.id, labelName: created!.name },
  };
}

/**
 * Create any requested label that doesn't exist yet — the `--create-missing-
 * labels` opt-in on create/edit (SHI-230). Matching is case-insensitive against
 * the tracker's existing set (the same contract label RESOLUTION uses), so a
 * mere casing difference never forks a duplicate label. Returns one
 * `LabelCreation` per label actually minted, for the per-label provenance
 * cards. Without the flag this is never called and unknown labels keep failing.
 */
async function createMissingLabels(tracker: Tracker, names: string[]): Promise<LabelCreation[]> {
  let existing: IssueLabel[];
  try {
    existing = await tracker.listLabels();
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
  const known = new Set(existing.map((l) => l.name.toLowerCase()));
  const creations: LabelCreation[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || known.has(name.toLowerCase())) continue;
    let created: IssueLabel & { id: string };
    try {
      created = await tracker.createLabel({ name });
    } catch (err) {
      toResolutionServiceError(err);
    }
    known.add(created!.name.toLowerCase());
    creations.push({
      label: { name: created!.name, ...(created!.color ? { color: created!.color } : {}) },
      summary: `created label "${created!.name}"`,
      undo: { kind: "label", labelId: created!.id, labelName: created!.name },
    });
  }
  return creations;
}

/**
 * Create a new issue in the tracker's bound scope (docs/187). Unlike the other
 * writes there is no prior state to snapshot — the undo target is the new
 * issue's own id, and undo cancels/closes it. The route stamps `card.issueId`
 * from `outcome.issue.id`.
 */
export async function createIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  title: string,
  body: string,
  opts: { labels?: string[]; priority?: string; parent?: string; createMissingLabels?: boolean } = {},
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  // Opt-in only (SHI-230): mint unknown labels BEFORE the create so label
  // resolution can't reject them. Without the flag an unknown label still fails
  // (with the label-create hint) — a typo must not silently spawn a label.
  const labelCreations =
    opts.createMissingLabels && opts.labels && opts.labels.length > 0
      ? await createMissingLabels(tracker, opts.labels)
      : [];
  let issue: TrackerIssue;
  try {
    issue = await tracker.createIssue({
      title,
      body,
      ...(opts.labels && opts.labels.length > 0 ? { labels: opts.labels } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
    });
  } catch (err) {
    toResolutionServiceError(err, { labelHint: true });
  }
  return {
    issue: issue!,
    verb: "create",
    summary: `created ${issue!.identifier}${describeAttrs(issue!)}`,
    undo: { kind: "create" },
    ...(labelCreations.length > 0 ? { labelCreations } : {}),
  };
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
    content: { comment: clipComment(body) },
  };
}

/**
 * Rewrite one of the issue's comments (SHI-86 — `shipit issue comment edit`);
 * undo restores the body it replaced.
 *
 * A comment was write-once before this: an agent that posted a wrong or stale
 * comment could only post another asking readers to ignore the first, and
 * `CLAUDE.md` has agents commenting on every design-doc update, so the mistakes
 * accumulated in the surface meant to be read. It also removes the one-way door
 * in docs/247's migration, which replays 1,344 comments — issue bodies stay
 * editable, comments did not.
 *
 * The issue is named alongside the comment (not derived from it) for the same
 * reason every other verb names its destination: a comment id is backend-global,
 * so the issue is what scopes it. The adapter enforces that pairing, plus
 * authorship. `shipit issue view <ref> --comments --json` already returns both
 * ids together, so requiring both costs the caller nothing.
 */
export async function editCommentForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  commentId: string,
  body: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  const issue = await loadIssueOr404(tracker, id);
  let previousBody: string;
  try {
    ({ previousBody } = await tracker.updateComment(id, commentId, body));
  } catch (err) {
    toResolutionServiceError(err);
  }
  return {
    issue,
    verb: "comment-edit",
    summary: `edited a comment on ${issue.identifier}`,
    undo: { kind: "comment-edit", commentId, previousBody: previousBody! },
    // The NEW body is the card's second line; the prior text is one Undo away.
    content: { comment: clipComment(body) },
  };
}

/**
 * Edit title, description, labels, and/or priority; snapshot the prior values
 * for undo. Labels are ADDITIVE (SHI-92): the requested names are merged into
 * the issue's existing labels rather than replacing them, so editing labels can
 * never silently drop a label the agent didn't mention. The adapter's
 * `updateIssue({ labels })` is a wholesale replace, so we pass it the merged
 * set; undo restores the prior set by replacing back to it.
 */
export async function updateIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  id: string,
  patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
  opts: { createMissingLabels?: boolean } = {},
): Promise<IssueWriteOutcome> {
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);
  // Opt-in only (SHI-230): mint unknown labels up front, mirroring create.
  const labelCreations =
    opts.createMissingLabels && patch.labels && patch.labels.length > 0
      ? await createMissingLabels(tracker, patch.labels)
      : [];
  const prior = await loadIssueOr404(tracker, id);
  // The prior label *names* (the read shape now carries colors; the write API
  // resolves names → ids, and undo restores by name).
  const priorLabelNames = (prior.labels ?? []).map((l) => l.name);
  // Merge requested labels into the existing set (additive, de-duped).
  const mergedLabels =
    patch.labels !== undefined
      ? [...priorLabelNames, ...patch.labels.filter((l) => !priorLabelNames.includes(l))]
      : undefined;
  let updated: TrackerIssue;
  try {
    updated = await tracker.updateIssue(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(mergedLabels !== undefined ? { labels: mergedLabels } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.parent !== undefined ? { parent: patch.parent } : {}),
    });
  } catch (err) {
    toResolutionServiceError(err, { labelHint: true });
  }
  const undo: IssueWriteUndo = {
    kind: "edit",
    ...(patch.title !== undefined ? { previousTitle: prior.title } : {}),
    ...(patch.description !== undefined ? { previousDescription: prior.description ?? "" } : {}),
    ...(patch.labels !== undefined ? { previousLabels: priorLabelNames } : {}),
    ...(patch.priority !== undefined ? { previousPriority: prior.priority.level } : {}),
    // Reparent (SHI-206): snapshot the prior parent's internal id so undo restores
    // the exact relation (or `null` when it was top-level → undo detaches back).
    ...(patch.parent !== undefined ? { previousParentId: prior.parentId ?? null } : {}),
  };
  const changed = [
    patch.title !== undefined ? "title" : null,
    patch.description !== undefined ? "description" : null,
    patch.labels !== undefined ? "labels" : null,
    patch.priority !== undefined ? "priority" : null,
    patch.parent !== undefined ? "parent" : null,
  ]
    .filter(Boolean)
    .join(" & ");
  // Surface the change on the card's second line (docs/189): the title
  // before/after when it changed, a description-touched flag, and a faint note
  // for label/priority/parent edits so an attrs-only edit isn't a blank line.
  const attrParts: string[] = [];
  if (patch.priority !== undefined) attrParts.push(`priority → ${updated!.priority.label}`);
  if (patch.labels !== undefined) {
    attrParts.push(`labels: ${(updated!.labels ?? []).map((l) => l.name).join(", ") || "none"}`);
  }
  if (patch.parent !== undefined) attrParts.push(`parent → ${updated!.parentIdentifier ?? "none"}`);
  const content: IssueWriteContent = {
    ...(patch.title !== undefined ? { title: { before: prior.title, after: patch.title } } : {}),
    ...(patch.description !== undefined ? { descriptionChanged: true } : {}),
    ...(attrParts.length > 0 ? { attrs: attrParts.join(" · ") } : {}),
  };
  return {
    issue: updated!,
    verb: "edit",
    summary: `edited ${changed || "issue"} on ${updated!.identifier}${describeAttrs(updated!)}`,
    undo,
    content,
    ...(labelCreations.length > 0 ? { labelCreations } : {}),
  };
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
  const fromStatus = prior.status?.name ?? "open";
  const toStatus = updated!.status?.name ?? status;
  return {
    issue: updated!,
    verb: "status",
    summary: `set ${updated!.identifier} → ${toStatus}`,
    // Restore by the prior native state name (both trackers accept native names).
    undo: { kind: "status", previousStatus: fromStatus },
    content: { status: { from: fromStatus, to: toStatus } },
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
  const assigneeName = assignee === null ? null : updated!.assignee?.name ?? assignee;
  const summary =
    assignee === null
      ? `unassigned ${updated!.identifier}`
      : `assigned ${updated!.identifier} → ${assigneeName}`;
  return {
    issue: updated!,
    verb: "assignee",
    summary,
    undo: { kind: "assignee", previousAssigneeId: prior.assigneeId ?? null },
    content: { assignee: assigneeName },
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
  card: Pick<IssueWriteCard, "tracker" | "trackerName" | "issueId" | "undo">,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<void> {
  // docs/248 req 11's carve-out — an Undo acts on the destination recorded on
  // the card, even when the repository no longer declares it. This is the one
  // path that does NOT go through the narrowed `get()`; see
  // `TrackerRegistry.getRecorded`.
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);

  // req 16's exception. Undo is not re-targeted by a re-pointed name: the write
  // happened to a specific issue, and the snapshot being restored is that
  // issue's. Following the name would apply it to a different issue of the same
  // number that never had it — on Linear the team guard would catch the attempt,
  // but on GitHub nothing would, so the wrong repository's issue would silently
  // be rewritten. Undo is for reversing something done minutes ago; once the
  // declaration has moved under it, refusing is the honest answer.
  if (card.trackerName) {
    const now = registry.destinationForName(card.trackerName);
    if (now && now.id !== card.tracker) {
      throw new ServiceError(
        409,
        `\`${card.trackerName}\` now points at \`${now.id}\`, but this write was made against ` +
          `\`${card.tracker}\`. ShipIt will not undo it against a different destination — the ` +
          `snapshot belongs to the issue that was actually changed. Undo it before re-pointing ` +
          `the declaration, or reverse the change by hand.`,
      );
    }
  }

  const tracker = registry.getRecorded(card.tracker);
  if (!tracker) throw new ServiceError(404, undeclaredTrackerMessage(card.tracker, registry));
  if (!tracker.isConfigured()) {
    throw new ServiceError(409, `${tracker.label} is not connected. Connect it in Settings → Issues.`);
  }
  try {
    switch (card.undo.kind) {
      case "comment":
        await tracker.deleteComment(card.undo.commentId);
        return;
      case "comment-edit":
        // Restore the exact body the rewrite replaced. The adapter re-runs the
        // same belonging + authorship guards the forward write passed, which
        // still hold — ShipIt edited it once, so ShipIt authored it.
        await tracker.updateComment(card.issueId, card.undo.commentId, card.undo.previousBody);
        return;
      case "edit":
        await tracker.updateIssue(card.issueId, {
          ...(card.undo.previousTitle !== undefined ? { title: card.undo.previousTitle } : {}),
          ...(card.undo.previousDescription !== undefined ? { description: card.undo.previousDescription } : {}),
          // Replace the label set back to the prior one, and re-apply the prior
          // priority level (SHI-92). previousLabels is the exact set to restore.
          ...(card.undo.previousLabels !== undefined ? { labels: card.undo.previousLabels } : {}),
          ...(card.undo.previousPriority !== undefined ? { priority: card.undo.previousPriority } : {}),
          // Restore the prior parent relation (SHI-206): the snapshotted internal
          // id (which the adapter resolves verbatim), or `null` to detach back to
          // top-level when the issue had no parent before the edit.
          ...(card.undo.previousParentId !== undefined ? { parent: card.undo.previousParentId } : {}),
        });
        return;
      case "status":
        await tracker.setStatus(card.issueId, card.undo.previousStatus);
        return;
      case "assignee":
        // raw: replay the exact prior id (or null → unassign), no re-resolution.
        await tracker.setAssignee(card.issueId, card.undo.previousAssigneeId, { raw: true });
        return;
      case "create":
        // No prior state to restore — cancel the issue we created. Prefer a
        // `canceled` state, but some Linear teams have none configured; fall
        // back to `completed` (close it) rather than leaving the created issue
        // stranded with a dead Undo. GitHub always resolves `canceled`
        // (close-as-not_planned), so the fallback only fires for Linear.
        try {
          await tracker.setStatus(card.issueId, "canceled");
        } catch (statusErr) {
          if (statusErr instanceof TrackerResolutionError) {
            await tracker.setStatus(card.issueId, "completed");
          } else {
            throw statusErr;
          }
        }
        return;
      case "label":
        // Delete the created label only while nothing carries it; the adapter
        // throws an explanation otherwise, which surfaces on the card (SHI-230).
        await tracker.deleteUnusedLabel(card.undo.labelId, card.undo.labelName);
    }
  } catch (err) {
    toResolutionServiceError(err);
  }
}

// ---- Linear connect / binding (settings) ----

/**
 * Store a Linear API token after validating it can reach the API. We validate
 * by listing teams (cheap, read-only); the returned teams are handed back as a
 * **lookup**, so the settings UI can show which team keys are available for a
 * `kind: linear` declaration. docs/248 req 4 — picking one here no longer binds
 * anything: the team lives in the repository's declaration.
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

/**
 * List the workspace's Linear teams. docs/248 req 4 — a lookup for *writing* a
 * declaration (which team keys does this credential reach?), not a picker that
 * persists a binding.
 */
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

/** Disconnect Linear: clear the stored credential. */
export function disconnectLinear(credentialStore: CredentialStore): void {
  credentialStore.clearLinear();
}
