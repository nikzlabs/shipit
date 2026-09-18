import {
  describeDeclaredNames,
  matchedDestinationName,
  resolveDestinationByName,
  resolveIssueRef,
} from "../../shared/issue-ref-resolution.js";
import type { TrackerDestination } from "../../shared/declared-tracker.js";
import { isGitHubTracker, isLinearTracker } from "../../shared/tracker-id.js";
import { wrapUntrustedContent } from "../../shared/untrusted-input.js";
import {
  asString,
  capText,
  fail,
  normalizeLabels,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
  type ShimIO,
} from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

interface ResolvedTarget {
  tracker: string;
  trackerName?: string;
}

interface ResolvedIssueTarget extends ResolvedTarget {
  id: string;
  identifier: string;
}

async function loadDestinations(deps: RunDeps): Promise<TrackerDestination[]> {
  const res = await deps.call("GET", "/agent-ops/issue/trackers", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read this repository's tracker declarations"), 1);
  }
  for (const warning of (res.body.warnings as string[] | undefined) ?? []) {
    deps.io.stderr(`shipit issue: ${warning}\n`);
  }
  return (res.body.destinations as TrackerDestination[] | undefined) ?? [];
}

function resolveIssuePointer(
  io: ShimIO,
  verb: string,
  pointer: string | undefined,
  trackerFlag: string | undefined,
  destinations: TrackerDestination[],
): ResolvedIssueTarget {
  if (!pointer) {
    fail(
      io,
      `shipit issue ${verb}: a pointer is required (e.g. planning#42, SHI-28, owner/repo#42, or an issue URL).`,
    );
  }

  const named = trackerFlag !== undefined ? requireDestination(io, verb, trackerFlag, destinations) : null;
  const resolution = resolveIssueRef(pointer, destinations);

  if (resolution.ok) {
    if (named && named.tracker !== resolution.ref.tracker) {
      fail(
        io,
        `shipit issue ${verb}: --tracker ${trackerFlag} contradicts the tracker named in "${pointer}". ` +
          `Drop --tracker, or pass a bare issue id with it.`,
      );
    }
    return {
      tracker: resolution.ref.tracker,
      ...(resolution.ref.trackerName ? { trackerName: resolution.ref.trackerName } : {}),
      id: resolution.ref.issueId,
      identifier: resolution.ref.identifier,
    };
  }

  // Never redirect a recognized but unresolved reference to another tracker.
  if (resolution.reason === "unrecognized") {
    const target = named ?? ownRepoTarget(destinations);
    if (target) {
      const raw = pointer.replace(/^#/, "").trim();
      const id = nativeIdFor(io, verb, target, raw);
      return {
        ...target,
        id,
        identifier: target.trackerName ? `${target.trackerName}#${id}` : `#${id}`,
      };
    }
  }

  fail(io, `shipit issue ${verb}: ${resolution.message}`);
}

function nativeIdFor(io: ShimIO, verb: string, target: ResolvedTarget, raw: string): string {
  if (isGitHubTracker(target.tracker)) {
    if (!/^\d+$/.test(raw)) {
      fail(io, `shipit issue ${verb}: "${raw}" is not a GitHub issue number.`);
    }
    return raw;
  }
  const team = target.tracker.replace(/^linear:/, "").toUpperCase();
  if (/^\d+$/.test(raw)) return `${team}-${raw}`;
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(raw)) return raw.toUpperCase();
  fail(io, `shipit issue ${verb}: "${raw}" is not a Linear issue key.`);
}

function requireDestination(
  io: ShimIO,
  verb: string,
  name: string,
  destinations: TrackerDestination[],
): ResolvedTarget {
  const found = resolveDestinationByName(destinations, name);
  if (!found.ok) {
    fail(io, `shipit issue ${verb}: ${found.message}`);
  }
  // Preserve the alias: it distinguishes plugin feedback from project issues.
  const matched = matchedDestinationName(found.destination, name);
  return {
    tracker: found.destination.id,
    ...(matched ? { trackerName: matched } : {}),
  };
}

function ownRepoTarget(destinations: TrackerDestination[]): ResolvedTarget | null {
  const own = destinations.find((d) => !d.name);
  return own ? { tracker: own.id } : null;
}

function resolveListTarget(
  io: ShimIO,
  verb: string,
  trackerFlag: string | undefined,
  destinations: TrackerDestination[],
): ResolvedTarget {
  if (trackerFlag !== undefined) return requireDestination(io, verb, trackerFlag, destinations);
  const own = ownRepoTarget(destinations);
  if (!own) {
    fail(
      io,
      `shipit issue ${verb}: this session has no GitHub repository of its own, so a tracker must be named. ${describeDeclaredNames(destinations)}`,
    );
  }
  return own;
}

function requireCreateTarget(
  io: ShimIO,
  verb: string,
  trackerFlag: string | undefined,
  destinations: TrackerDestination[],
): ResolvedTarget {
  if (trackerFlag === undefined) {
    const why =
      "--tracker <name> is required — a create always names where it files, so a forgotten flag " +
      "cannot file into this session's own (possibly public) repository.";
    fail(io, `shipit issue ${verb}: ${why} ${describeDeclaredNames(destinations)}`);
  }
  return requireDestination(io, verb, trackerFlag, destinations);
}

function provenanceLabel(tracker: string, identifier: string): string {
  const kind = isGitHubTracker(tracker) ? "github" : isLinearTracker(tracker) ? "linear" : tracker;
  return `${kind}:${identifier}`;
}

async function readIssueBody(
  values: Record<string, string>,
  deps: RunDeps,
): Promise<string | undefined> {
  if (values.body !== undefined) return values.body;
  if (values.bodyFile !== undefined) {
    return readBodyFromFileOrStdin(values.bodyFile, deps.io, "shipit issue", "body file");
  }
  return undefined;
}

const VALID_PRIORITIES = new Set(["urgent", "high", "medium", "low", "none"]);

function validatePriority(
  io: RunDeps["io"],
  verb: string,
  priority: string | undefined,
  tracker: string,
): string | undefined {
  if (priority === undefined) return undefined;
  if (isGitHubTracker(tracker)) {
    fail(
      io,
      `shipit issue ${verb}: --priority is not supported on GitHub (no native priority field). ` +
        `Use a label instead, e.g. --label 'priority: high'.`,
    );
  }
  if (!VALID_PRIORITIES.has(priority.toLowerCase())) {
    fail(
      io,
      `shipit issue ${verb}: --priority must be one of urgent|high|medium|low|none (got '${priority}').`,
    );
  }
  return priority.toLowerCase();
}

const PARENT_DETACH = new Set(["none", "null", "detach"]);

function validateParent(
  io: RunDeps["io"],
  verb: string,
  parent: string | undefined,
  tracker: string,
  destinations: TrackerDestination[],
): string | null | undefined {
  if (parent === undefined) return undefined;
  if (isGitHubTracker(tracker)) {
    fail(
      io,
      `shipit issue ${verb}: --parent is not supported on GitHub (issues are flat — no sub-issues). ` +
        `Sub-issue nesting is Linear-only.`,
    );
  }
  if (PARENT_DETACH.has(parent.trim().toLowerCase())) return null;
  const resolution = resolveIssueRef(parent, destinations);
  if (!resolution.ok) {
    fail(io, `shipit issue ${verb}: --parent ${resolution.message}`);
  }
  if (resolution.ref.tracker !== tracker) {
    fail(
      io,
      `shipit issue ${verb}: --parent ${parent} is on a different tracker than the issue being written. ` +
        `A sub-issue must nest under a parent on the same Linear team.`,
    );
  }
  return resolution.ref.issueId;
}

export async function handleIssueView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json", "--comments": "comments" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const target = resolveIssuePointer(
    deps.io,
    "view",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const { tracker, id: issueId, identifier } = target;

  const qs = `?tracker=${encodeURIComponent(tracker)}&id=${encodeURIComponent(issueId)}`;
  const res = await deps.call("GET", `/agent-ops/issue/view${qs}`, undefined, deps.env);
  if (res.status === 404) {
    fail(deps.io, formatError(res, `Issue not found: ${identifier}`), 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read issue"), 1);
  }

  const issue = res.body.issue as Record<string, unknown> | undefined;
  if (!issue) {
    fail(deps.io, `Issue not found: ${identifier}`, 1);
  }

  let comments: Record<string, unknown>[] | undefined;
  if (parsed.booleans.has("comments")) {
    const cres = await deps.call("GET", `/agent-ops/issue/comments${qs}`, undefined, deps.env);
    if (cres.status < 200 || cres.status >= 300) {
      fail(deps.io, formatError(cres, "Failed to read issue comments"), 1);
    }
    comments = (cres.body.comments as Record<string, unknown>[] | undefined) ?? [];
  }

  if (parsed.booleans.has("json")) {
    const payload = comments ? { ...issue, comments } : issue;
    deps.io.stdout(`${JSON.stringify(payload)}\n`);
    deps.io.exit(0);
    return;
  }
  let text = renderIssue(issue, tracker);
  if (comments) text += `\n\n${renderComments(comments, tracker, asString(issue.identifier))}`;
  success(deps.io, text);
}

export async function handleIssueList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker", "--state": "state" },
    booleans: { "--json": "json", "--full": "full" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker } = resolveListTarget(deps.io, "list", parsed.values.tracker, destinations);
  const state = parsed.values.state?.toLowerCase();
  if (state && !["open", "closed", "all"].includes(state)) {
    fail(deps.io, `shipit issue list: --state must be 'open', 'closed', or 'all' (got '${parsed.values.state}').`);
  }

  const params = new URLSearchParams({ tracker });
  if (state) params.set("state", state);
  const res = await deps.call("GET", `/agent-ops/issue/list?${params.toString()}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list issues"), 1);
  }

  const issues = (res.body.issues as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    const rows = parsed.booleans.has("full") ? issues : issues.map(leanListRow);
    deps.io.stdout(`${JSON.stringify(rows)}\n`);
    deps.io.exit(0);
    return;
  }
  if (issues.length === 0) {
    const info = res.body.tracker as Record<string, unknown> | undefined;
    if (info?.configured === false) {
      success(deps.io, `${tracker} is not configured in ShipIt — no issues to list.`);
      return;
    }
    success(deps.io, `No issues for ${tracker}.`);
    return;
  }
  const lines = issues.map((i) =>
    [asString(i.identifier), priorityLabel(i), asString(i.title)].join("\t"),
  );
  const { text: capped, truncated } = capText(lines.join("\n"), MAX_ISSUE_FREETEXT_CHARS);
  success(
    deps.io,
    wrapUntrustedContent({
      source: "issue",
      content: capped,
      provenance: `${tracker} issue list`,
      truncated,
    }),
  );
}

function leanListRow(issue: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...issue };
  delete rest.description;
  return rest;
}

export async function handleIssueLabels(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue labels: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker } = resolveListTarget(deps.io, "labels", parsed.values.tracker, destinations);
  const res = await deps.call(
    "GET",
    `/agent-ops/issue/labels?tracker=${encodeURIComponent(tracker)}`,
    undefined,
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list labels"), 1);
  }
  const labels = (res.body.labels as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(labels)}\n`);
    deps.io.exit(0);
    return;
  }
  if (labels.length === 0) {
    success(deps.io, `No labels available for ${tracker}.`);
    return;
  }
  success(deps.io, labels.map((l) => asString(l.name)).filter(Boolean).join("\n"));
}

export async function handleIssueStatuses(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue statuses: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker } = resolveListTarget(deps.io, "statuses", parsed.values.tracker, destinations);
  const res = await deps.call(
    "GET",
    `/agent-ops/issue/statuses?tracker=${encodeURIComponent(tracker)}`,
    undefined,
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list statuses"), 1);
  }
  const statuses = (res.body.statuses as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(statuses)}\n`);
    deps.io.exit(0);
    return;
  }
  if (statuses.length === 0) {
    success(deps.io, `No statuses available for ${tracker}.`);
    return;
  }
  const lines = statuses.map((s) => {
    const name = asString(s.name);
    const type = asString(s.type);
    return type ? `${name} (${type})` : name;
  });
  success(deps.io, lines.filter(Boolean).join("\n"));
}

const MAX_ISSUE_FREETEXT_CHARS = 24_000;
const MAX_ISSUE_COMMENTS_CHARS = 24_000;


function renderIssue(issue: Record<string, unknown>, tracker: string): string {
  const status = issue.status as Record<string, unknown> | undefined;
  const assignee = issue.assignee as Record<string, unknown> | undefined;
  const identifier = asString(issue.identifier);
  const meta = [
    identifier,
    `status:    ${status ? asString(status.name) : "(unknown)"}`,
    `priority:  ${priorityLabel(issue)}`,
  ];
  if (assignee && asString(assignee.name)) meta.push(`assignee:  ${asString(assignee.name)}`);
  if (issue.url) meta.push(`url:       ${asString(issue.url)}`);
  const available = issue.availableStatuses as { name?: string }[] | undefined;
  if (available && available.length > 0) {
    meta.push(`statuses:  ${available.map((s) => s.name).filter(Boolean).join(", ")}`);
  }
  // Titles are untrusted user text, so include them in the envelope.
  const title = asString(issue.title);
  const description = asString(issue.description);
  const freeText = [`title: ${title}`, ...(description.trim() ? ["", description] : [])].join("\n");
  const { text: capped, truncated } = capText(freeText, MAX_ISSUE_FREETEXT_CHARS);
  const envelope = wrapUntrustedContent({
    source: "issue",
    content: capped,
    provenance: provenanceLabel(tracker, identifier),
    truncated,
  });
  return [meta.join("\n"), "", envelope].join("\n");
}

function renderComments(
  comments: Record<string, unknown>[],
  tracker: string,
  identifier: string,
): string {
  if (comments.length === 0) return "comments:  (none)";
  const blocks = comments.map((c) => {
    const author = c.author as Record<string, unknown> | undefined;
    const who = (author && asString(author.name)) || "(unknown)";
    const when = asString(c.createdAt);
    const head = when ? `${who} · ${when}` : who;
    return `— ${head}\n${asString(c.body)}`;
  });
  const body = [`comments (${comments.length}):`, ...blocks].join("\n\n");
  const { text: capped, truncated } = capText(body, MAX_ISSUE_COMMENTS_CHARS);
  return wrapUntrustedContent({
    source: "issue",
    content: capped,
    provenance: `${provenanceLabel(tracker, identifier)} comments — lower trust than the body; anyone may post`,
    truncated,
  });
}

function priorityLabel(issue: Record<string, unknown>): string {
  const priority = issue.priority as Record<string, unknown> | undefined;
  return priority ? asString(priority.label) || "No priority" : "No priority";
}

function reportWrite(res: { status: number; body: Record<string, unknown> }, deps: RunDeps, json: boolean): void {
  if (json) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const lines = [`done:       ${asString(res.body.summary) || "ok"}`];
  if (res.body.url) lines.push(`url:        ${asString(res.body.url)}`);
  success(deps.io, lines.join("\n"));
}

const LABEL_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

export async function handleIssueLabel(args: string[], deps: RunDeps): Promise<void> {
  const sub = args[0];
  if (sub === "delete" || sub === "rm" || sub === "remove") {
    fail(
      deps.io,
      "shipit issue label: there is no `label delete` — undoing one would mint a fresh label that no " +
        "issue carries, so the Undo on its card would be a lie. Fix a wrong label with " +
        "`shipit issue label edit` (rename/recolor in place, every issue keeps it); if it truly must go, " +
        "delete it in the tracker's own UI, which warns how many issues it strips it from.",
    );
  }
  if (sub !== "create" && sub !== "edit") {
    fail(
      deps.io,
      "shipit issue label: only `label create` and `label edit` are supported. " +
        "List existing labels with `shipit issue labels`; apply them with --label on create/edit.",
    );
  }
  const isEdit = sub === "edit";
  const parsed = parseFlags(args.slice(1), {
    values: {
      "--name": "name",
      "-n": "name",
      "--new-name": "newName",
      "--color": "color",
      "--description": "description",
      "-d": "description",
      "--tracker": "tracker",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue label ${sub}: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const name = parsed.values.name;
  if (!name?.trim()) {
    fail(deps.io, `shipit issue label ${sub}: --name is required.`);
  }
  if (!isEdit && parsed.values.newName !== undefined) {
    fail(deps.io, "shipit issue label create: --new-name applies to `label edit` (a create names the label with --name).");
  }
  if (
    isEdit &&
    parsed.values.newName === undefined &&
    parsed.values.color === undefined &&
    parsed.values.description === undefined
  ) {
    fail(
      deps.io,
      "shipit issue label edit: pass at least one of --new-name, --color or --description — --name only says which label to edit.",
    );
  }
  const destinations = await loadDestinations(deps);
  const target = requireCreateTarget(deps.io, `label ${sub}`, parsed.values.tracker, destinations);
  const tracker = target.tracker;
  const color = parsed.values.color;
  if (color !== undefined && !LABEL_COLOR_RE.test(color.trim())) {
    fail(deps.io, `shipit issue label ${sub}: --color must be a 6-digit hex like '#0ea5e9' (got '${color}').`);
  }
  const payload: Record<string, unknown> = { tracker, name: name.trim() };
  if (target.trackerName) payload.trackerName = target.trackerName;
  if (color !== undefined) payload.color = color.trim();
  if (parsed.values.description !== undefined) payload.description = parsed.values.description;
  if (isEdit && parsed.values.newName !== undefined) payload.newName = parsed.values.newName.trim();
  const path = isEdit ? "/agent-ops/issue/label/edit" : "/agent-ops/issue/label/create";
  const res = await deps.call("POST", path, payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, `Failed to ${isEdit ? "edit" : "create"} label`), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueCreate(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--title": "title",
      "-t": "title",
      "-b": "body",
      "--body": "body",
      "-F": "bodyFile",
      "--body-file": "bodyFile",
      "--tracker": "tracker",
      "--priority": "priority",
      "--parent": "parent",
    },
    arrays: { "--label": "label", "-l": "label" },
    booleans: { "--json": "json", "--create-missing-labels": "createMissingLabels" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const title = parsed.values.title;
  if (!title?.trim()) {
    fail(deps.io, "shipit issue create: --title is required.");
  }
  const destinations = await loadDestinations(deps);
  const target = requireCreateTarget(deps.io, "create", parsed.values.tracker, destinations);
  const tracker = target.tracker;
  const labels = normalizeLabels(parsed.arrays.label);
  const priority = validatePriority(deps.io, "create", parsed.values.priority, tracker);
  const parent = validateParent(deps.io, "create", parsed.values.parent, tracker, destinations);
  const body = (await readIssueBody(parsed.values, deps)) ?? "";
  const payload: Record<string, unknown> = { tracker, title, body };
  if (target.trackerName) payload.trackerName = target.trackerName;
  if (labels.length > 0) payload.labels = labels;
  if (priority !== undefined) payload.priority = priority;
  if (parent) payload.parent = parent;
  if (parsed.booleans.has("createMissingLabels")) payload.createMissingLabels = true;
  const res = await deps.call("POST", "/agent-ops/issue/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueComment(args: string[], deps: RunDeps): Promise<void> {
  if (args[0] === "edit") {
    return handleIssueCommentEdit(args.slice(1), deps);
  }
  if (args[0] === "delete") {
    fail(
      deps.io,
      "shipit issue comment: there is no `comment delete`. Rewrite the comment with " +
        "`shipit issue comment edit <ref> --comment <id> -b '<new body>'` instead.",
    );
  }
  const parsed = parseFlags(args, {
    values: { "-b": "body", "--body": "body", "-F": "bodyFile", "--body-file": "bodyFile", "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue comment: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker, trackerName, id } = resolveIssuePointer(
    deps.io,
    "comment",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const body = await readIssueBody(parsed.values, deps);
  if (!body?.trim()) {
    fail(deps.io, "shipit issue comment: -b/--body (or --body-file -) is required.");
  }
  const res = await deps.call("POST", "/agent-ops/issue/comment", { tracker, trackerName, id, body }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to comment on issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueCommentEdit(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-b": "body",
      "--body": "body",
      "-F": "bodyFile",
      "--body-file": "bodyFile",
      "--tracker": "tracker",
      "--comment": "comment",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue comment edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker, trackerName, id } = resolveIssuePointer(
    deps.io,
    "comment edit",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const commentId = parsed.values.comment;
  if (!commentId?.trim()) {
    fail(
      deps.io,
      "shipit issue comment edit: --comment <id> is required. " +
        "Get a comment's id with `shipit issue view <ref> --comments --json`.",
    );
  }
  const body = await readIssueBody(parsed.values, deps);
  if (!body?.trim()) {
    fail(deps.io, "shipit issue comment edit: -b/--body (or --body-file -) is required.");
  }
  const res = await deps.call(
    "POST",
    "/agent-ops/issue/comment/edit",
    { tracker, trackerName, id, commentId: commentId.trim(), body },
    deps.env,
  );
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to edit comment"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueEdit(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--title": "title",
      "-b": "body",
      "--body": "body",
      "--body-file": "bodyFile",
      "--tracker": "tracker",
      "--priority": "priority",
      "--parent": "parent",
    },
    arrays: { "--label": "label", "-l": "label" },
    booleans: { "--json": "json", "--create-missing-labels": "createMissingLabels" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker, trackerName, id } = resolveIssuePointer(
    deps.io,
    "edit",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const body = await readIssueBody(parsed.values, deps);
  const title = parsed.values.title;
  const labels = normalizeLabels(parsed.arrays.label);
  const priority = validatePriority(deps.io, "edit", parsed.values.priority, tracker);
  const parent = validateParent(deps.io, "edit", parsed.values.parent, tracker, destinations);
  if (title === undefined && body === undefined && labels.length === 0 && priority === undefined && parent === undefined) {
    fail(deps.io, "shipit issue edit: at least one of --title, --body/--body-file, --label, --priority, or --parent is required.");
  }
  const payload: Record<string, unknown> = { tracker, id };
  if (trackerName) payload.trackerName = trackerName;
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (labels.length > 0) payload.labels = labels;
  if (priority !== undefined) payload.priority = priority;
  if (parent !== undefined) payload.parent = parent;
  if (parsed.booleans.has("createMissingLabels")) payload.createMissingLabels = true;
  const res = await deps.call("POST", "/agent-ops/issue/edit", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to edit issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueStatus(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue status: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker, trackerName, id } = resolveIssuePointer(
    deps.io,
    "status",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const status = parsed.positional[1];
  if (!status) {
    fail(deps.io, "shipit issue status: a target status is required (a normalized type like `completed`, or a native state name).");
  }
  const res = await deps.call("POST", "/agent-ops/issue/status", { tracker, trackerName, id, status }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to set status"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueAssign(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json", "--none": "none" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue assign: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const destinations = await loadDestinations(deps);
  const { tracker, trackerName, id } = resolveIssuePointer(
    deps.io,
    "assign",
    parsed.positional[0],
    parsed.values.tracker,
    destinations,
  );
  const none = parsed.booleans.has("none");
  const assignee = none ? null : parsed.positional[1];
  if (!none && !assignee) {
    fail(deps.io, "shipit issue assign: an assignee is required (a login/email/display name, `me`, or --none to unassign).");
  }
  const res = await deps.call("POST", "/agent-ops/issue/assign", { tracker, trackerName, id, assignee }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to set assignee"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}
