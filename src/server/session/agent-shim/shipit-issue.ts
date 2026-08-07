/**
 * `shipit issue *` handlers — tracker-neutral issue access (docs/175 read +
 * docs/177 + docs/187 write, reworked by docs/248).
 *
 * `shipit issue` is the ONE issue interface, identical across every backend.
 * Read = view/list; write = create/comment/comment edit/edit/status/assign.
 * `comment edit` (SHI-86) rewrites a comment ShipIt itself posted — someone
 * else's is refused server-side, and there is no `comment delete`. Creation is
 * do-then-surface (docs/187) — the issue is created immediately and a provenance
 * card with Undo (which cancels it) is posted. The `shipit issue` dispatch + the
 * rejected-subcommand gate live in `shipit.ts`.
 *
 * docs/248 — **every operation names the tracker it acts on.** The trackers a
 * session can reach are the ones its repository declared in `shipit.yaml`, plus
 * the session's own GitHub Issues; there is no built-in tracker and no implicit
 * fallback (req 1). So this module starts by asking the orchestrator for that
 * set (`/agent-ops/issue/trackers`) and resolves the reference locally against
 * it, which is what lets a failure — an unrecognized shape, a name nobody
 * declared, an ambiguous address — be reported in CLI output with the declared
 * names in hand (reqs 8, 19) instead of coming back as an opaque 404 from a
 * write that should never have been attempted.
 *
 * Two shapes of destination-naming, matching requirements 12 and 13:
 *
 *  - An operation on an **existing** issue names its tracker in the pointer
 *    (`planning#42`, `roadmap#SHI-304`, `owner/repo#42`, `SHI-304`) or with
 *    `--tracker <name>`. The one exception is the session's own repository,
 *    which needs no declaration and no name — a bare pointer and a bare `list`
 *    both mean it.
 *  - **`create` always names its destination** (req 13). There is no default and
 *    no unnamed fallback, because for a public code repository the unnamed
 *    destination is the *public* repo: a forgotten flag would file a planning
 *    issue publicly. To file into its own repository, a repository declares it.
 */

import {
  describeDeclaredNames,
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

/** A destination an operation resolved to: the routing id plus the name used. */
interface ResolvedTarget {
  tracker: string;
  trackerName?: string;
}

/** A resolved issue target: a destination plus the tracker-native issue id. */
interface ResolvedIssueTarget extends ResolvedTarget {
  id: string;
  identifier: string;
}

/**
 * Fetch the destinations this session can reach, and print the repository's
 * declaration warnings (req 8) to stderr before anything else runs.
 *
 * The warnings go to stderr rather than being folded into the command's output
 * so they surface on a *successful* command too: an entry dropped for a
 * duplicate `name` or an unrecognized `kind` is exactly the case where the rest
 * of the command still works and the agent would otherwise never learn the
 * declaration is broken.
 */
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

/**
 * Resolve an issue pointer to a destination + a tracker-native id (docs/248
 * req 10). All three reference forms are accepted, and requirement 11's
 * fail-closed rules apply: a well-formed reference naming no declared
 * destination, or naming more than one, is an error here rather than a request
 * routed at a guess.
 *
 * `--tracker <name>` names the destination for a pointer that carries none — a
 * bare `42` or `SHI-9` with no declaration to match. Passing both is only
 * allowed when they agree, because silently preferring either one is exactly the
 * substitution requirement 17 forbids: an operation that names two different
 * destinations is a mistake, not a precedence question.
 */
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

  // Only an *unrecognized shape* may be resolved by naming a destination: the
  // pointer is then a bare native id (a GitHub number, a Linear key) for that
  // destination. With no `--tracker`, a bare id means the session's own
  // repository — req 12's one unnamed exception, the same default `list` takes.
  // A recognized reference that failed to resolve — undeclared, ambiguous,
  // mismatched — is a real routing failure and is reported as one, never
  // silently redirected at the session's repo.
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

/**
 * Interpret a bare id (`42`, `SHI-9`) against an explicitly named destination.
 * GitHub wants a number; Linear wants a key, and a bare number is completed from
 * the declaration's team key — the same completion `roadmap#304` gets.
 */
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

/**
 * Resolve `--tracker <name>` to a declared destination, failing closed with the
 * declared names when it matches none (reqs 11, 19).
 */
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
  return {
    tracker: found.destination.id,
    ...(found.destination.name ? { trackerName: found.destination.name } : {}),
  };
}

/**
 * The destination for a verb that has no pointer to infer one from — `list`,
 * `labels`, `statuses`. With no `--tracker` this is the session's own repository
 * (req 12's one unnamed exception); that is deliberately NOT true of `create`,
 * which has its own required-destination rule (req 13, {@link requireCreateTarget}).
 */
/** The session's own repository, when it has one (req 12's unnamed exception). */
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

/**
 * docs/248 req 13 — a create ALWAYS names its destination. No default, and no
 * unnamed fallback to the session's own repository: for a public code repository
 * that fallback is the *public* repo, so a forgotten flag would file a planning
 * issue publicly. A repository that wants `create` to reach its own issues
 * declares itself and gives it a name.
 */
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

/**
 * Provenance label for the untrusted-input envelope, e.g. `linear:SHI-28` or
 * `github:planning#42`.
 *
 * Uses the tracker *kind*, not the full id: a GitHub `identifier` already names
 * its destination, so a qualified id would render it twice (docs/248).
 */
function provenanceLabel(tracker: string, identifier: string): string {
  const kind = isGitHubTracker(tracker) ? "github" : isLinearTracker(tracker) ? "linear" : tracker;
  return `${kind}:${identifier}`;
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

/** `--parent` values that DETACH (clear the parent), mirroring `assign --none`. */
const PARENT_DETACH = new Set(["none", "null", "detach"]);

/**
 * Validate + normalize `--parent` against the tracker (SHI-206). Sub-issue
 * nesting is **Linear-only** — GitHub issues are flat — so `--parent` is rejected
 * on GitHub with a pointer at the limitation, mirroring how `--priority` is
 * rejected. On Linear, `none`/`null`/`detach` clears the parent; otherwise the
 * value is resolved as a tracker-neutral pointer (`SHI-204` or a Linear URL) to
 * the parent's issue key. Returns:
 *   - `undefined` → the flag wasn't passed (leave the parent untouched),
 *   - `null`      → detach (clear the parent),
 *   - `string`    → the parent issue key to nest under.
 */
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
  // docs/248 — a parent is a reference like any other, so it resolves through the
  // declarations too (`roadmap#SHI-204` and a bare `SHI-204` both work). It must
  // land on the SAME destination as the issue being written: Linear nests only
  // within a team, and silently reparenting across teams would be exactly the
  // substitution requirement 17 forbids.
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
    // Token economy (SHI-199): a `--json` list is almost always a "which issue do
    // I pick?" scan needing only identifier/title/status/priority/assignee — never
    // every issue's full markdown body. Both adapters populate `description` on
    // every row, so a default list could ship tens of thousands of tokens of body
    // the agent didn't ask for. Drop it by default; `--full` opts back in. This is
    // a shim-only projection (the UI's own `/api/issues` payload is untouched), so
    // it can't break the browser Issues list that renders `description`.
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
 * Project a list row down to the lean default for `shipit issue list --json`
 * (SHI-199) — strip the heavy `description` (full markdown body) that both
 * adapters populate per row. The body belongs on `view`, not on a pick-an-issue
 * scan; `--full` skips this projection. A shallow copy, so the source object is
 * untouched.
 */
function leanListRow(issue: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...issue };
  delete rest.description;
  return rest;
}

/**
 * `shipit issue labels` — list the tracker's pickable labels (SHI-199). The
 * discovery surface that lets the agent see valid `--label` values for
 * create/edit without guessing and tripping the rejection error. Read-only;
 * label names are workspace/repo-configured metadata (not reporter free-text),
 * so they print plain — no untrusted-input envelope.
 */
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
  // One name per line — directly usable as `--label <name>` on create/edit.
  success(deps.io, labels.map((l) => asString(l.name)).filter(Boolean).join("\n"));
}

/**
 * `shipit issue statuses` — list the tracker's assignable statuses (SHI-199).
 * Lets the agent pick a valid `shipit issue status <pointer> <state>` target
 * without first `view`-ing an issue (which only carries `availableStatuses`
 * per-issue). Read-only; status names are tracker-config metadata, printed plain
 * (no envelope), each annotated with its normalized type so the portable type
 * (`completed`, `started`, …) is visible alongside the native name.
 */
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
  // `name (type)` per line — the native name feeds `issue status`, the type is
  // the portable target that also works.
  const lines = statuses.map((s) => {
    const name = asString(s.name);
    const type = asString(s.type);
    return type ? `${name} (${type})` : name;
  });
  success(deps.io, lines.filter(Boolean).join("\n"));
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
    provenance: provenanceLabel(tracker, identifier),
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
    provenance: `${provenanceLabel(tracker, identifier)} comments — lower trust than the body; anyone may post`,
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

/** Accepted `--color` shapes for `label create` — a 6-digit hex, `#` optional. */
const LABEL_COLOR_RE = /^#?[0-9a-fA-F]{6}$/;

/**
 * `shipit issue label create` — mint a tracker label so `--label` can apply it
 * (SHI-230). Do-then-surface like the other writes: created immediately, with a
 * provenance card whose Undo deletes the label if it's still unused. It mutates a
 * tracker's CONFIG, so docs/248 req 13's rule applies as it does to
 * `issue create`: `--tracker <name>` is required, there is no default.
 * `label` is a verb group so future label verbs can slot in, but only `create`
 * exists — listing stays on `shipit issue labels`.
 */
export async function handleIssueLabel(args: string[], deps: RunDeps): Promise<void> {
  const sub = args[0];
  if (sub !== "create") {
    fail(
      deps.io,
      "shipit issue label: only `label create` is supported. " +
        "List existing labels with `shipit issue labels`; apply them with --label on create/edit.",
    );
  }
  const parsed = parseFlags(args.slice(1), {
    values: {
      "--name": "name",
      "-n": "name",
      "--color": "color",
      "--description": "description",
      "-d": "description",
      "--tracker": "tracker",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue label create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const name = parsed.values.name;
  if (!name?.trim()) {
    fail(deps.io, "shipit issue label create: --name is required.");
  }
  // Creating a label mutates a tracker's CONFIG, so like `issue create` it always
  // names its destination (req 13's reasoning applies unchanged — a forgotten
  // flag would mint a label in this session's own repository).
  const destinations = await loadDestinations(deps);
  const target = requireCreateTarget(deps.io, "label create", parsed.values.tracker, destinations);
  const tracker = target.tracker;
  const color = parsed.values.color;
  if (color !== undefined && !LABEL_COLOR_RE.test(color.trim())) {
    fail(deps.io, `shipit issue label create: --color must be a 6-digit hex like '#0ea5e9' (got '${color}').`);
  }
  const payload: Record<string, unknown> = { tracker, name: name.trim() };
  if (target.trackerName) payload.trackerName = target.trackerName;
  if (color !== undefined) payload.color = color.trim();
  if (parsed.values.description !== undefined) payload.description = parsed.values.description;
  const res = await deps.call("POST", "/agent-ops/issue/label/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create label"), 1);
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
  // A new issue has no prior parent to clear, so only forward a parent to SET
  // (a truthy key); `none`/detach (null) is a no-op on create.
  if (parent) payload.parent = parent;
  // Opt-in (SHI-230): unknown --label names are created before being applied.
  // Without the flag they keep failing with the label-create hint.
  if (parsed.booleans.has("createMissingLabels")) payload.createMissingLabels = true;
  const res = await deps.call("POST", "/agent-ops/issue/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

export async function handleIssueComment(args: string[], deps: RunDeps): Promise<void> {
  // `comment` is a small verb group: bare `comment <ref>` posts, `comment edit`
  // rewrites (SHI-86) — the same shape `label create` uses. No pointer form is
  // the bare word `edit`, so the two can't be confused. (`shipit issue edit`
  // remains the ISSUE editor; this one edits a comment on it.)
  if (args[0] === "edit") {
    return handleIssueCommentEdit(args.slice(1), deps);
  }
  // Deliberately absent, so say so rather than letting `delete` fall through and
  // fail as an unrecognized pointer. A comment id is backend-global and a delete
  // has no honest undo (re-posting mints a new id, author and timestamp), so it
  // needs its own design pass — see docs/177.
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

/**
 * `shipit issue comment edit <ref> --comment <id> -b BODY` — rewrite a comment
 * the agent posted (SHI-86).
 *
 * The issue pointer is required alongside `--comment` rather than derived from
 * the comment id: a comment id is backend-global, so the issue is what names the
 * destination (docs/248's rule that every operation names what it acts on) and
 * what scopes the id. The orchestrator re-checks the pairing, and refuses a
 * comment ShipIt did not author.
 *
 * Both ids come from one read — `shipit issue view <ref> --comments --json`
 * returns each comment's `id` — so nothing extra is needed to address one.
 */
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
  // `parent` may be a key (set) or null (detach); forward both, omit undefined.
  if (parent !== undefined) payload.parent = parent;
  // Opt-in (SHI-230), mirroring create.
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
