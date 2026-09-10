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
import { describeDeclaredNames } from "../../shared/issue-ref-resolution.js";
import {
  addressedAsPluginRepo,
  pluginFeedbackTrackerId,
  withPluginFeedbackContext,
  type PluginFeedbackRepo,
} from "../../shared/plugin-feedback.js";
import { ServiceError } from "./types.js";

// Linear can assign a non-terminal type to its Duplicate state, so match the name.
export function isDuplicateStatus(name?: string): boolean {
  return name?.trim().toLowerCase() === "duplicate";
}

function undeclaredTrackerMessage(trackerId: string, registry: TrackerRegistry): string {
  return `\`${trackerId}\` is not a tracker this repository declares, and ShipIt has no implicit tracker to fall back to. ${describeDeclaredNames(registry.destinations())}`;
}

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

export function listTrackers(
  credentialStore: CredentialStore,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): TrackerInfo[] {
  return buildTrackerRegistry(credentialStore, fetchImpl, github).list();
}

/** An unconfigured tracker returns the UI's Connect empty state. */
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
    // Status lookup failure disables the editor without hiding the issue list.
    const [issues, availableStatuses] = await Promise.all([
      tracker.listIssues(options),
      tracker.listStatuses().catch(() => [] as { name: string; type?: string; color?: string }[]),
    ]);
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

function resolveConfiguredTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Tracker {
  return resolveConfiguredTrackerIn(
    buildTrackerRegistry(credentialStore, fetchImpl, github),
    trackerId,
  );
}

function resolveConfiguredTrackerIn(registry: TrackerRegistry, trackerId: string): Tracker {
  const tracker = registry.get(trackerId as TrackerId);
  if (!tracker) throw new ServiceError(404, undeclaredTrackerMessage(trackerId, registry));
  if (!tracker.isConfigured()) {
    throw new ServiceError(409, `${tracker.label} is not connected. Connect it in Settings → Issues.`);
  }
  return tracker;
}

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

/** Direct UI writes return the changed item without an agent provenance card or undo. */
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

/** Replace the complete label set; [] clears all labels. */
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

export interface IssueWriteOutcome {
  issue: TrackerIssue;
  verb: IssueWriteVerb;
  summary: string;
  undo: IssueWriteUndo;
  content?: IssueWriteContent;
  /** Each implicitly created label gets its own provenance card and undo. */
  labelCreations?: LabelCreation[];
}

export interface LabelCreation {
  label: IssueLabel;
  summary: string;
  undo: Extract<IssueWriteUndo, { kind: "label" }>;
}

export interface LabelEdit {
  label: IssueLabel;
  summary: string;
  undo: Extract<IssueWriteUndo, { kind: "label-edit" }>;
  content: IssueWriteContent;
}

export type LabelWrite = LabelCreation | LabelEdit;

function sameColor(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => (v ?? "").trim().replace(/^#/, "").toLowerCase();
  return norm(a) === norm(b);
}

function clipComment(body: string): string {
  const collapsed = body.trim().replace(/\s+/g, " ");
  const MAX = 280;
  return collapsed.length > MAX ? `${collapsed.slice(0, MAX).trimEnd()}…` : collapsed;
}

function toResolutionServiceError(err: unknown, opts?: { labelHint?: boolean }): never {
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
    // Creation must not modify an existing label used by other issues.
    throw new ServiceError(
      409,
      `Label "${clash.name}" already exists on ${tracker.label} — nothing to create. ` +
        `To change its color, name or description, run \`shipit issue label edit --name "${clash.name}"\`.`,
    );
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

export async function updateLabelForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  name: string,
  patch: { name?: string; color?: string; description?: string },
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<LabelEdit> {
  const trimmed = name.trim();
  if (!trimmed) throw new ServiceError(400, "A label name is required");
  const newName = patch.name?.trim();
  if (patch.name !== undefined && !newName) {
    throw new ServiceError(400, "The new label name cannot be empty");
  }
  if (patch.name === undefined && patch.color === undefined && patch.description === undefined) {
    throw new ServiceError(400, "At least one of name, color or description is required");
  }
  const tracker = resolveConfiguredTracker(credentialStore, trackerId, fetchImpl, github);

  let target: (IssueLabel & { id: string; description?: string }) | null;
  try {
    target = await tracker.findLabel(trimmed);
  } catch (err) {
    throw new ServiceError(502, err instanceof Error ? err.message : String(err));
  }
  if (!target) {
    let options: string[] = [];
    try {
      options = (await tracker.listLabels()).map((l) => l.name).slice(0, 50);
    } catch {
      // Preserve the original lookup failure.
    }
    const list = options.length > 0 ? ` Existing labels: ${options.join(", ")}.` : "";
    throw new ServiceError(404, `No label "${trimmed}" exists on ${tracker.label}.${list}`);
  }

  // A casing-only rename is not a collision with another label.
  if (newName && newName.toLowerCase() !== target.name.toLowerCase()) {
    let clash: (IssueLabel & { id: string }) | null;
    try {
      clash = await tracker.findLabel(newName);
    } catch (err) {
      throw new ServiceError(502, err instanceof Error ? err.message : String(err));
    }
    if (clash) {
      throw new ServiceError(
        409,
        `Label "${clash.name}" already exists on ${tracker.label}, so "${target.name}" cannot be renamed to ` +
          `"${newName}" — ShipIt does not merge labels. Re-label the issues onto "${clash.name}" instead.`,
      );
    }
  }

  // Undo must restore only fields this write changed.
  const renamed = newName !== undefined && newName !== target.name;
  const recolored = patch.color !== undefined && !sameColor(patch.color, target.color);
  const redescribed = patch.description !== undefined && patch.description !== (target.description ?? "");
  if (!renamed && !recolored && !redescribed) {
    throw new ServiceError(
      409,
      `Label "${target.name}" already has those values on ${tracker.label} — nothing to change.`,
    );
  }

  let updated: IssueLabel & { id: string; description?: string };
  try {
    updated = await tracker.updateLabel(target.id, {
      ...(renamed && newName ? { name: newName } : {}),
      ...(recolored ? { color: patch.color! } : {}),
      ...(redescribed ? { description: patch.description! } : {}),
    });
  } catch (err) {
    toResolutionServiceError(err);
  }

  const parts: string[] = [];
  if (renamed) parts.push(`renamed "${target.name}" → "${updated!.name}"`);
  if (recolored) parts.push(`color → ${updated!.color ?? patch.color}`);
  if (redescribed) parts.push(patch.description ? "description updated" : "description cleared");
  const attrParts: string[] = [];
  if (recolored) attrParts.push(`color → ${updated!.color ?? patch.color}`);
  if (redescribed) attrParts.push(patch.description ? "description updated" : "description cleared");
  return {
    label: { name: updated!.name, ...(updated!.color ? { color: updated!.color } : {}) },
    summary: `edited label ${parts.join(", ")}`,
    undo: {
      kind: "label-edit",
      // GitHub uses the name as the ID, so undo must use the post-rename ID.
      labelId: updated!.id,
      ...(renamed ? { previousName: target.name } : {}),
      ...(recolored && target.color ? { previousColor: target.color } : {}),
      ...(redescribed ? { previousDescription: target.description ?? "" } : {}),
    },
    content: {
      ...(renamed ? { label: { before: target.name, after: updated!.name } } : {}),
      ...(attrParts.length > 0 ? { attrs: attrParts.join(" · ") } : {}),
    },
  };
}

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

/** Use the addressed name: one destination can have tracker and plugin aliases. */
function pluginFeedbackTarget(
  registry: TrackerRegistry,
  trackerId: string,
  addressedAs: string | undefined,
  github?: GitHubTrackerContext,
): PluginFeedbackRepo | undefined {
  const destination = registry.destinationFor(trackerId as TrackerId);
  if (!addressedAsPluginRepo(destination, addressedAs)) return undefined;
  const name = addressedAs?.trim().toLowerCase();
  const repos = (github?.pluginRepos ?? []).filter(
    (r) => pluginFeedbackTrackerId(r).toLowerCase() === trackerId.toLowerCase(),
  );
  return name ? repos.find((r) => r.name.toLowerCase() === name) ?? repos[0] : repos[0];
}

export async function createIssueForTracker(
  credentialStore: CredentialStore,
  trackerId: string,
  title: string,
  body: string,
  opts: {
    labels?: string[];
    priority?: string;
    parent?: string;
    createMissingLabels?: boolean;
    trackerName?: string;
  } = {},
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<IssueWriteOutcome> {
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);
  const tracker = resolveConfiguredTrackerIn(registry, trackerId);
  const feedbackRepo = pluginFeedbackTarget(registry, trackerId, opts.trackerName, github);
  const finalBody = feedbackRepo ? withPluginFeedbackContext(body, feedbackRepo) : body;
  // Create missing labels only on explicit opt-in; a typo must not create one.
  const labelCreations =
    opts.createMissingLabels && opts.labels && opts.labels.length > 0
      ? await createMissingLabels(tracker, opts.labels)
      : [];
  let issue: TrackerIssue;
  try {
    issue = await tracker.createIssue({
      title,
      body: finalBody,
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

/** The adapter checks that this comment belongs to the issue and the current author. */
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
    content: { comment: clipComment(body) },
  };
}

/** Agent label edits are additive; the adapter replaces sets, so pass the merged set. */
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
  const labelCreations =
    opts.createMissingLabels && patch.labels && patch.labels.length > 0
      ? await createMissingLabels(tracker, patch.labels)
      : [];
  const prior = await loadIssueOr404(tracker, id);
  const priorLabelNames = (prior.labels ?? []).map((l) => l.name);
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
    undo: { kind: "status", previousStatus: fromStatus },
    content: { status: { from: fromStatus, to: toStatus } },
  };
}

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

export async function undoIssueWrite(
  credentialStore: CredentialStore,
  card: Pick<IssueWriteCard, "tracker" | "trackerName" | "issueId" | "undo">,
  fetchImpl?: FetchImpl,
  github?: GitHubTrackerContext,
): Promise<void> {
  // Undo can reach its recorded destination after its declaration is removed.
  const registry = buildTrackerRegistry(credentialStore, fetchImpl, github);

  // A moved name must not apply this snapshot to a different destination.
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
        await tracker.updateComment(card.issueId, card.undo.commentId, card.undo.previousBody);
        return;
      case "edit":
        await tracker.updateIssue(card.issueId, {
          ...(card.undo.previousTitle !== undefined ? { title: card.undo.previousTitle } : {}),
          ...(card.undo.previousDescription !== undefined ? { description: card.undo.previousDescription } : {}),
          ...(card.undo.previousLabels !== undefined ? { labels: card.undo.previousLabels } : {}),
          ...(card.undo.previousPriority !== undefined ? { priority: card.undo.previousPriority } : {}),
          ...(card.undo.previousParentId !== undefined ? { parent: card.undo.previousParentId } : {}),
        });
        return;
      case "status":
        await tracker.setStatus(card.issueId, card.undo.previousStatus);
        return;
      case "assignee":
        await tracker.setAssignee(card.issueId, card.undo.previousAssigneeId, { raw: true });
        return;
      case "create":
        // Some Linear teams have no canceled state; close the created issue instead.
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
        await tracker.deleteUnusedLabel(card.undo.labelId, card.undo.labelName);
        return;
      case "label-edit": {
        const restore = {
          ...(card.undo.previousName !== undefined ? { name: card.undo.previousName } : {}),
          ...(card.undo.previousColor !== undefined ? { color: card.undo.previousColor } : {}),
          ...(card.undo.previousDescription !== undefined
            ? { description: card.undo.previousDescription }
            : {}),
        };
        await tracker.updateLabel(card.undo.labelId, restore);
      }
    }
  } catch (err) {
    toResolutionServiceError(err);
  }
}

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

export function disconnectLinear(credentialStore: CredentialStore): void {
  credentialStore.clearLinear();
}
