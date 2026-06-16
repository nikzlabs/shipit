/**
 * `shipit issue *` handlers — tracker-neutral issue access (docs/175 read +
 * docs/177 + docs/187 write).
 *
 * `shipit issue` is the ONE issue interface, identical across GitHub and Linear
 * (the tracker is inferred from the pointer shape via the shared parseIssueRef).
 * Read = view/list; write = create/comment/edit/status/assign. Creation is
 * do-then-surface (docs/187) — the issue is created immediately and a provenance
 * card with Undo (which cancels it) is posted. Only destructive verbs are gated.
 * The `shipit issue` dispatch + the rejected-subcommand gate live in `shipit.ts`.
 */

import { parseIssueRef } from "../../shared/issue-ref.js";
import { wrapUntrustedContent } from "../../shared/untrusted-input.js";
import {
  asString,
  fail,
  normalizeLabels,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
  type ShimIO,
} from "./shim-common.js";
import { REJECTED_HELP, formatError, type RunDeps } from "./shipit.js";

/**
 * Resolve a pointer (`SHI-28`, `owner/repo#42`, a URL, …) to a tracker id and a
 * tracker-native issue id via the shared `parseIssueRef`. `--tracker` overrides
 * an ambiguous/unknown shape; when overriding, the raw pointer (minus a leading
 * `#`) is used as the id.
 */
function resolveIssuePointer(
  io: ShimIO,
  pointer: string | undefined,
  override: string | undefined,
): { tracker: string; id: string } {
  if (!pointer) {
    fail(io, "shipit issue: a pointer is required (e.g. SHI-28, owner/repo#42, or an issue URL).");
  }
  const parsed = parseIssueRef(pointer);
  const tracker = override || (parsed.tracker !== "unknown" ? parsed.tracker : "");
  if (!tracker) {
    fail(
      io,
      `shipit issue: could not infer the tracker from "${pointer}". Pass --tracker github|linear.`,
    );
  }
  const raw = pointer.replace(/^#/, "").trim();
  const id = override && override !== parsed.tracker ? raw : (parsed.issueId ?? raw);
  return { tracker, id };
}

/** Read a write body from `--body` (inline) or `--body-file` (file / `-` stdin). */
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

const VALID_TRACKERS = new Set(["github", "linear"]);

/** Normalized priority levels accepted by `--priority` (Linear-only). */
const VALID_PRIORITIES = new Set(["urgent", "high", "medium", "low", "none"]);

/**
 * Validate `--priority` against the tracker (SHI-92). GitHub has no native
 * priority field, so `--priority` is rejected there with a pointer at the label
 * convention rather than silently dropped. On Linear we accept the normalized
 * levels (the server also accepts native names, but the shim keeps the surface
 * tight). Returns the value to send, or fails the command.
 */
function validatePriority(
  io: RunDeps["io"],
  verb: string,
  priority: string | undefined,
  tracker: string,
): string | undefined {
  if (priority === undefined) return undefined;
  if (tracker === "github") {
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

export async function handleIssueView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json", "--comments": "comments" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const pointer = parsed.positional[0];
  if (!pointer) {
    fail(
      deps.io,
      'shipit issue view: an issue pointer is required, e.g. shipit issue view SHI-28 or shipit issue view owner/repo#42.',
    );
  }

  const override = parsed.values.tracker?.toLowerCase();
  if (override && !VALID_TRACKERS.has(override)) {
    fail(deps.io, `shipit issue view: --tracker must be 'github' or 'linear' (got '${parsed.values.tracker}').`);
  }

  const ref = parseIssueRef(pointer);
  const tracker = override ?? (ref.tracker === "unknown" ? undefined : ref.tracker);
  if (!tracker) {
    fail(
      deps.io,
      `shipit issue view: could not infer the tracker from "${pointer}". Pass --tracker github|linear.`,
    );
  }

  // Resolve the tracker-native id. `parseIssueRef` supplies it for recognized
  // shapes; with an explicit --tracker the agent may pass a bare number (GitHub)
  // or key (Linear) that the parser leaves as "unknown".
  let issueId = ref.issueId;
  if (!issueId) {
    if (/^\d+$/.test(pointer)) issueId = pointer;
    else if (/^[A-Za-z]+-\d+$/.test(pointer)) issueId = pointer.toUpperCase();
  }
  if (!issueId) {
    fail(
      deps.io,
      `shipit issue view: could not determine the issue id from "${pointer}".`,
    );
  }

  const qs = `?tracker=${encodeURIComponent(tracker)}&id=${encodeURIComponent(issueId)}`;
  const res = await deps.call("GET", `/agent-ops/issue/view${qs}`, undefined, deps.env);
  if (res.status === 404) {
    fail(deps.io, formatError(res, `Issue not found: ${ref.identifier}`), 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read issue"), 1);
  }

  const issue = res.body.issue as Record<string, unknown> | undefined;
  if (!issue) {
    fail(deps.io, `Issue not found: ${ref.identifier}`, 1);
  }

  // `--comments` pulls the thread over a second brokered read (SHI-137). The
  // `view` leg already emitted the jump-to-issue card; this read adds none.
  let comments: Record<string, unknown>[] | undefined;
  if (parsed.booleans.has("comments")) {
    const cres = await deps.call("GET", `/agent-ops/issue/comments${qs}`, undefined, deps.env);
    if (cres.status < 200 || cres.status >= 300) {
      fail(deps.io, formatError(cres, "Failed to read issue comments"), 1);
    }
    comments = (cres.body.comments as Record<string, unknown>[] | undefined) ?? [];
  }

  if (parsed.booleans.has("json")) {
    // Embed comments on the issue object when requested so the shape stays a
    // superset of plain `--json` (existing fields untouched, `comments` added).
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
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const tracker = (parsed.values.tracker ?? "github").toLowerCase();
  if (!VALID_TRACKERS.has(tracker)) {
    fail(deps.io, `shipit issue list: --tracker must be 'github' or 'linear' (got '${parsed.values.tracker}').`);
  }
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
    deps.io.stdout(`${JSON.stringify(issues)}\n`);
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
  // Issue titles are reporter-authored free-text too (SHI-85 / docs/176), so the
  // list is wrapped in the same untrusted-input envelope — no issue field reaches
  // the agent as unframed prose. The leading `identifier`/`priority` columns are
  // tracker-derived, but they ride inside the block since the row is one line.
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

/**
 * Caps on the untrusted free-text the shim emits (SHI-85 / docs/176 §4). A giant
 * issue body or comment thread would flood the agent's context (and is a cheap
 * context-stuffing vector), so we clamp the enveloped free-text and mark the
 * envelope `(truncated)`. The metadata lines (identifier/status/url) are tiny and
 * tracker-derived, so only the reporter-authored prose is bounded.
 */
const MAX_ISSUE_FREETEXT_CHARS = 24_000;
const MAX_ISSUE_COMMENTS_CHARS = 24_000;

/** Clamp `text` to `max` chars, reporting whether it was truncated. */
function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n…[truncated]`, truncated: true };
}

/**
 * Render a single `TrackerIssue` as a stable human-readable block.
 *
 * SHI-85 (docs/176): the reporter-authored free-text — the **title and body** —
 * is attacker-influenceable on a public tracker (anyone with an account can file
 * an issue), so it is wrapped in the SHI-98 untrusted-input provenance envelope
 * (`shared/untrusted-input.ts`, `source: "issue"`) and treated as DATA, not
 * instructions. This is the agent's single text-ingestion point for issue
 * content; `--json` returns the same fields structurally instead. The framing is
 * defense-in-depth, never the barrier — the load-bearing controls are the
 * environment layer (egress allowlist SHI-90, scoped tokens SHI-79).
 *
 * The metadata lines (identifier, status, priority, assignee, url, available
 * statuses) are ShipIt/tracker-derived structured values, not reporter prose, so
 * they stay outside the envelope as ordinary output. `provenance` carries the
 * tracker + identifier so a steered action is at least attributable.
 */
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
  // Title is reporter-authored free-text too — keep it inside the envelope, not
  // on a trusted metadata line.
  const title = asString(issue.title);
  const description = asString(issue.description);
  const freeText = [`title: ${title}`, ...(description.trim() ? ["", description] : [])].join("\n");
  const { text: capped, truncated } = capText(freeText, MAX_ISSUE_FREETEXT_CHARS);
  const envelope = wrapUntrustedContent({
    source: "issue",
    content: capped,
    provenance: `${tracker}:${identifier}`,
    truncated,
  });
  return [meta.join("\n"), "", envelope].join("\n");
}

/**
 * Render an issue's comment thread for `shipit issue view --comments` (SHI-137).
 * Oldest-first (the order the orchestrator returns), one block per comment with
 * an author · timestamp header.
 *
 * Comment bodies are attacker-controllable data, same as the issue body — and
 * **strictly lower trust** (docs/176 §3: anyone can comment, no maintainer
 * gate), so the whole thread is wrapped in the SHI-98 untrusted-input envelope
 * with a provenance note that says so. Printed verbatim, never interpreted.
 */
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
    provenance: `${tracker}:${identifier} comments — lower trust than the body; anyone may post`,
    truncated,
  });
}

/** Pull the display label off an issue's priority object, defaulting gracefully. */
function priorityLabel(issue: Record<string, unknown>): string {
  const priority = issue.priority as Record<string, unknown> | undefined;
  return priority ? asString(priority.label) || "No priority" : "No priority";
}

/** Print the write provenance result (a do-then-surface confirmation). */
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
    },
    arrays: { "--label": "label", "-l": "label" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const title = parsed.values.title;
  if (!title?.trim()) {
    fail(deps.io, "shipit issue create: --title is required.");
  }
  // No pointer to infer from, so default to Linear (the workspace-wide tracker,
  // and the design-doc convention). Pass `--tracker github` to file on the
  // session's repo instead.
  const tracker = (parsed.values.tracker ?? "linear").toLowerCase();
  if (!VALID_TRACKERS.has(tracker)) {
    fail(deps.io, `shipit issue create: --tracker must be 'github' or 'linear' (got '${parsed.values.tracker}').`);
  }
  const labels = normalizeLabels(parsed.arrays.label);
  const priority = validatePriority(deps.io, "create", parsed.values.priority, tracker);
  const body = (await readIssueBody(parsed.values, deps)) ?? "";
  const payload: Record<string, unknown> = { tracker, title, body };
  if (labels.length > 0) payload.labels = labels;
  if (priority !== undefined) payload.priority = priority;
  const res = await deps.call("POST", "/agent-ops/issue/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueComment(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "-b": "body", "--body": "body", "-F": "bodyFile", "--body-file": "bodyFile", "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue comment: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const { tracker, id } = resolveIssuePointer(deps.io, parsed.positional[0], parsed.values.tracker);
  const body = await readIssueBody(parsed.values, deps);
  if (!body?.trim()) {
    fail(deps.io, "shipit issue comment: -b/--body (or --body-file -) is required.");
  }
  const res = await deps.call("POST", "/agent-ops/issue/comment", { tracker, id, body }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to comment on issue"), 1);
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
    },
    arrays: { "--label": "label", "-l": "label" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const { tracker, id } = resolveIssuePointer(deps.io, parsed.positional[0], parsed.values.tracker);
  const body = await readIssueBody(parsed.values, deps);
  const title = parsed.values.title;
  const labels = normalizeLabels(parsed.arrays.label);
  const priority = validatePriority(deps.io, "edit", parsed.values.priority, tracker);
  if (title === undefined && body === undefined && labels.length === 0 && priority === undefined) {
    fail(deps.io, "shipit issue edit: at least one of --title, --body/--body-file, --label, or --priority is required.");
  }
  const payload: Record<string, unknown> = { tracker, id };
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (labels.length > 0) payload.labels = labels;
  if (priority !== undefined) payload.priority = priority;
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
  const { tracker, id } = resolveIssuePointer(deps.io, parsed.positional[0], parsed.values.tracker);
  const status = parsed.positional[1];
  if (!status) {
    fail(deps.io, "shipit issue status: a target status is required (a normalized type like `completed`, or a native state name).");
  }
  const res = await deps.call("POST", "/agent-ops/issue/status", { tracker, id, status }, deps.env);
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
  const { tracker, id } = resolveIssuePointer(deps.io, parsed.positional[0], parsed.values.tracker);
  const none = parsed.booleans.has("none");
  const assignee = none ? null : parsed.positional[1];
  if (!none && !assignee) {
    fail(deps.io, "shipit issue assign: an assignee is required (a login/email/display name, `me`, or --none to unassign).");
  }
  const res = await deps.call("POST", "/agent-ops/issue/assign", { tracker, id, assignee }, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to set assignee"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}
