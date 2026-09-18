
import { isValidRepoFlag, REPO_FLAG_FORMS } from "../../shared/github-repo-flag.js";
import { wrapUntrustedContent } from "../../shared/untrusted-input.js";
import {
  applyJq,
  asString,
  callBroker,
  capText,
  defaultIO,
  fail,
  filterJson,
  JQ_SUPPORTED_FORMS,
  normalizeLabels,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
  type ShimEnv,
  type ShimIO,
} from "./shim-common.js";
import { exitAfterFlush, shimWrite } from "./shim-exit.js";

export { parseFlags, type ShimIO };

const SHIM_NAME = "gh (ShipIt)";

const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

const REJECTED_HELP = `${SHIM_NAME} only supports a subset of pull-request operations.
See /shipit-docs/github.md for the full list.`;

const HELP = `${SHIM_NAME} — pull-request operations brokered through the ShipIt orchestrator.

Supported subcommands:
  gh pr create   [-t TITLE] [-b BODY|--body-file FILE] [-B BASE] [-d|--draft] [--fill] [-l|--label LABEL]
  gh pr edit     [<number>] [-t TITLE] [-b BODY|--body-file FILE] [--add-label LABEL] [--remove-label LABEL]
  gh pr view     [<number>] [-c|--comments] [--json FIELDS] [-q|--jq EXPR]
  gh pr list     [--state open|closed|merged|all] [-L|--limit N] [--json FIELDS] [-q|--jq EXPR]
  gh pr status
  gh pr comment  [<number>] (-b BODY|--body-file FILE)
  gh pr ready    [<number>]
  gh pr close    [<number>]
  gh pr reopen   <number>
  gh pr merge    [<number>] [--merge|--squash|--rebase] [--auto]   (Sandbox sessions with "Allow merging PRs" only)

  gh run list      [-w WORKFLOW] [-b BRANCH] [-s STATUS] [-L LIMIT] [--json FIELDS] [-q|--jq EXPR]
  gh run view      [<run-id>] [--log] [--log-failed] [--json FIELDS] [-q|--jq EXPR]
  gh run rerun     [<run-id>] [--failed]      (your branch, your commit, push/PR runs)
  gh workflow list [--json FIELDS] [-q|--jq EXPR]
  gh workflow view <workflow> [--json FIELDS] [-q|--jq EXPR]

Operations target the repo of the current working directory's clone. Pass
--repo OWNER/NAME to target a specific repo explicitly; a --repo that is not
${REPO_FLAG_FORMS} is refused rather than falling back to the current repo.

-L/--limit takes a whole number from ${LIMIT_MIN} to ${LIMIT_MAX} (default 30 for
pr list, 20 for run list); anything else is refused.

-q/--jq requires --json and supports simple paths only (${JQ_SUPPORTED_FORMS});
anything else exits 3 with a message naming the expression.

--json validates its field names: an unsupported one exits 2 listing what the
subcommand can return, never an empty object. Review feedback is read with
\`gh pr view <n> --comments\` (or --json comments,reviews,reviewThreads).

This is a ShipIt shim, not the real gh CLI. \`gh run\`/\`gh workflow\` are reads
plus \`gh run rerun\` — re-running an existing run on the branch you are working
on. Subcommands like \`gh api\`, \`gh repo\`, \`gh release\`, \`gh auth\`,
\`gh secret\`, and the verbs that choose new code or destroy state
(\`gh workflow run\`, \`gh run cancel\`, \`gh run delete\`) are intentionally
unavailable. See /shipit-docs/github.md.`;

const REJECTED_SUBCOMMANDS = new Set([
  "api", "auth", "browse", "codespace", "completion", "config", "extension",
  "gist", "gpg-key", "issue", "label", "release", "repo", "ruleset",
  "secret", "ssh-key", "status", "variable", "cache", "alias",
  "attestation", "co", "search", "org", "project",
]);


interface RunDeps {
  env: ShimEnv;
  io: ShimIO;
  call: typeof callBroker;
  cwd: string;
}

function requireValidRepo(deps: RunDeps, repo: string | undefined): void {
  if (!isValidRepoFlag(repo)) {
    fail(deps.io, `Invalid --repo "${repo}". Expected ${REPO_FLAG_FORMS}.`);
  }
}

function targetBody(deps: RunDeps, repo: string | undefined): Record<string, string> {
  requireValidRepo(deps, repo);
  const out: Record<string, string> = {};
  if (deps.cwd) out.cwd = deps.cwd;
  if (repo) out.repo = repo;
  return out;
}

function targetQuery(
  deps: RunDeps,
  repo: string | undefined,
  extra: Record<string, string | undefined> = {},
): string {
  requireValidRepo(deps, repo);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  if (deps.cwd) params.set("cwd", deps.cwd);
  if (repo) params.set("repo", repo);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function parseLimit(raw: string | undefined, deps: RunDeps, command: string): string | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
    fail(
      deps.io,
      `${command}: --limit must be a whole number between ${LIMIT_MIN} and ${LIMIT_MAX}, got "${raw}"`,
    );
  }
  return String(n);
}

const JQ_FLAGS = { "-q": "jq", "--jq": "jq" } as const;

function requireJsonForJq(deps: RunDeps, command: string, parsed: { values: Record<string, string> }): void {
  if (parsed.values.jq !== undefined && parsed.values.json === undefined) {
    fail(
      deps.io,
      `${command}: cannot use -q/--jq without --json. Name the fields first, e.g. ${command} --json state -q .state`,
    );
  }
}

function emitJson(deps: RunDeps, command: string, payload: unknown, jq: string | undefined): void {
  if (jq === undefined) {
    deps.io.stdout(`${JSON.stringify(payload)}\n`);
    deps.io.exit(0);
    return;
  }
  const result = applyJq(payload, jq);
  if (!result.ok) {
    if (result.kind === "unsupported") {
      fail(
        deps.io,
        `${command}: ${result.message}\nShipIt's gh shim implements simple jq paths only: ${JQ_SUPPORTED_FORMS}.\nDrop -q and parse the --json output yourself for anything richer.`,
        3,
      );
    }
    fail(deps.io, `${command}: ${result.message}`, 1);
  }
  if (result.values.length > 0) deps.io.stdout(`${result.values.join("\n")}\n`);
  deps.io.exit(0);
}


const PR_VIEW_JSON_FIELDS = [
  "additions", "author", "base", "baseRefName", "body", "comments", "createdAt",
  "deletions", "head", "headRefName", "isDraft", "labels", "merged", "mergedAt",
  "number", "reviewDecision", "reviewThreads", "reviews", "state", "title",
  "updatedAt", "url",
];

const PR_CONVERSATION_FIELDS = new Set(["comments", "reviews", "reviewThreads", "reviewDecision"]);

const PR_LIST_JSON_FIELDS = ["base", "head", "isDraft", "mergedAt", "number", "state", "title", "url"];

const PR_LIST_STATES = ["open", "closed", "merged", "all"];

const RUN_JSON_FIELDS = [
  "conclusion", "createdAt", "databaseId", "displayTitle", "event", "headBranch",
  "headSha", "number", "status", "updatedAt", "url", "workflowDatabaseId", "workflowName",
];
const RUN_VIEW_JSON_FIELDS = [...RUN_JSON_FIELDS, "jobs", "logs"];

const WORKFLOW_JSON_FIELDS = ["id", "name", "path", "state", "url"];

function jsonFields(
  raw: string,
  deps: RunDeps,
  command: string,
  supported: string[],
): string[] {
  const available = `Supported fields for ${command}: ${supported.join(", ")}`;
  const fields = raw.split(",").map((s) => s.trim());
  if (raw.trim() === "") {
    fail(deps.io, `${command}: --json needs at least one comma-separated field.\n${available}`);
  }
  if (fields.some((f) => f === "")) {
    fail(deps.io, `${command}: --json has an empty field name in "${raw}".\n${available}`);
  }
  const unknown = fields.filter((f) => !supported.includes(f));
  if (unknown.length > 0) {
    fail(
      deps.io,
      `${command}: unknown --json field${unknown.length > 1 ? "s" : ""}: ${unknown.map((f) => `"${f}"`).join(", ")}\n${available}`,
    );
  }
  return fields;
}

function existingPrNotice(body: Record<string, unknown>): string {
  const reason = body.alreadyExistedReason;
  if (reason !== "merged-not-progressed" && reason !== "closed-not-progressed") {
    return "Existing open PR for this branch — printing its URL.\n";
  }
  const merged = reason === "merged-not-progressed";
  const state = merged ? "MERGED" : "CLOSED";
  const num = typeof body.number === "number" ? `#${body.number}` : "for this branch";
  const base = safeBaseRef(body.baseBranch);
  const why = merged
    ? "a merged PR cannot take new commits"
    : "ShipIt does not reopen a closed PR";
  const head = `No new PR was opened. The last PR ${num} on this branch is ${state}, and ${why}.\n`;

  if (body.notProgressedBecause === "no-new-work") {
    return `${head}This branch's tree is identical to \`origin/${base}\`, so there is nothing to open `
      + `a PR for. If you expected new work here, check that your edits were committed — and note `
      + `that commits which change nothing still count as no work.\n`;
  }
  if (body.notProgressedBecause === "base-unknown") {
    return `${head}ShipIt could not resolve \`origin/${base}\` in this clone, so it could not tell `
      + `whether this branch has new work. Run \`git fetch origin\` and try again.\n`;
  }
  if (body.notProgressedBecause === "fetch-failed") {
    return `${head}ShipIt could not refresh \`origin/${base}\`, so it declined to decide off a `
      + `possibly-stale ref rather than risk opening a duplicate PR of work that already shipped. `
      + `Run \`git fetch origin\` yourself to see the real error, then try again.\n`;
  }
  return `${head}ShipIt did not open a replacement because this branch does not contain the current `
    + `tip of \`origin/${base}\` — the base moved on under you — so any new commits here are NOT `
    + `shipped and have nowhere to go yet.\n`
    + `To ship them, merge the base into the branch and re-run \`gh pr create\`:\n`
    + `    git fetch origin && git merge origin/${base}\n`
    + `That rewrites no published history, needs no force-push and discards nothing. `
    + `Do NOT rebase or \`git reset --hard\` onto the base.\n`
    + `The ${state.toLowerCase()} PR's URL is printed below for reference.\n`;
}

// Git refs can contain shell metacharacters; this value enters a suggested command.
function safeBaseRef(value: unknown): string {
  if (typeof value !== "string" || value === "") return "<base>";
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : "<base>";
}

async function handlePrCreate(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-t": "title", "--title": "title",
      "-b": "body", "--body": "body",
      "--body-file": "bodyFile", "-F": "bodyFile",
      "-B": "base", "--base": "base",
      "--repo": "repo", "-R": "repo",
    },
    arrays: {
      "--label": "label", "-l": "label",
    },
    booleans: {
      "-d": "draft", "--draft": "draft",
      "--fill": "fill",
      "--web": "web", "-w": "web",
    },
  });

  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web. The PR URL is printed on stdout.");
  }
  const body = await resolveBody(parsed.values.body, parsed.values.bodyFile, deps, "gh pr create");
  const labels = normalizeLabels(parsed.arrays.label);

  const payload = {
    title: parsed.values.title,
    body,
    base: parsed.values.base,
    draft: parsed.booleans.has("draft"),
    fill: parsed.booleans.has("fill"),
    ...(labels.length > 0 ? { labels } : {}),
    ...targetBody(deps, parsed.values.repo),
  };
  const res = await deps.call("POST", "/agent-ops/pr/create", payload, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
    if (res.body.alreadyExisted) {
      deps.io.stderr(existingPrNotice(res.body));
    }
    emitLabelWarning(deps.io, res.body.labelWarning);
    success(deps.io, url);
    return;
  }
  fail(deps.io, formatError(res, "Failed to create PR"), 1);
}

async function handlePrEdit(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-t": "title", "--title": "title",
      "-b": "body", "--body": "body",
      "--body-file": "bodyFile", "-F": "bodyFile",
      "--repo": "repo", "-R": "repo",
    },
    arrays: {
      "--add-label": "addLabel",
      "--label": "addLabel", "-l": "addLabel",
      "--remove-label": "removeLabel",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const num = await resolvePrNumber(parsed.positional, deps, { repo: parsed.values.repo });
  const body = await resolveBody(parsed.values.body, parsed.values.bodyFile, deps, "gh pr edit");
  const addLabels = normalizeLabels(parsed.arrays.addLabel);
  const removeLabels = normalizeLabels(parsed.arrays.removeLabel);

  const payload = {
    title: parsed.values.title,
    body,
    ...(addLabels.length > 0 ? { addLabels } : {}),
    ...(removeLabels.length > 0 ? { removeLabels } : {}),
    ...targetBody(deps, parsed.values.repo),
  };
  if (
    payload.title === undefined && payload.body === undefined &&
    addLabels.length === 0 && removeLabels.length === 0
  ) {
    fail(deps.io, "gh pr edit: provide a title (-t), body (-b), --add-label, or --remove-label to update.");
  }

  const res = await deps.call("PATCH", `/agent-ops/pr/${num}`, payload, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
    emitLabelWarning(deps.io, res.body.labelWarning);
    success(deps.io, url);
    return;
  }
  fail(deps.io, formatError(res, "Failed to update PR"), 1);
}

async function handlePrView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      ...JQ_FLAGS,
    },
    booleans: {
      "-w": "web", "--web": "web",
      "-c": "comments", "--comments": "comments",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web.");
  }
  requireJsonForJq(deps, "gh pr view", parsed);

  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh pr view", PR_VIEW_JSON_FIELDS)
    : undefined;
  const wantsComments = parsed.booleans.has("comments");
  // Fetch conversation data only when the output needs its extra round-trip.
  const wantsConversationJson = fields?.some((f) => PR_CONVERSATION_FIELDS.has(f)) === true;
  const needsConversation = wantsComments || wantsConversationJson || fields === undefined;

  const qs = targetQuery(deps, parsed.values.repo, {
    number: parsed.positional[0],
    comments: needsConversation ? "true" : undefined,
  });
  const res = await deps.call("GET", `/agent-ops/pr/view${qs}`, undefined, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const pr = res.body.pr as Record<string, unknown> | null;
    if (!pr) {
      fail(deps.io, "No pull request found for this branch.", 1);
    }
    const conversationError = asString(pr.conversationError);
    if (conversationError && (wantsComments || wantsConversationJson)) {
      fail(deps.io, `gh pr view: could not read this PR's conversation: ${conversationError}`, 1);
    }

    if (fields !== undefined) {
      emitJson(deps, "gh pr view", filterJson(pr, fields), parsed.values.jq);
      return;
    }
    const lines = [
      `${asString(pr.title)} #${asString(pr.number)}`,
      `${asString(pr.state)}${pr.isDraft === true ? " (draft)" : ""}`.trim(),
      `${asString(pr.head)} → ${asString(pr.base)}`,
      asString(pr.url),
      "",
      asString(pr.body),
    ];
    if (conversationError) {
      deps.io.stderr(`Note: this PR's comments could not be read: ${conversationError}\n`);
    } else if (wantsComments) {
      lines.push("", renderConversation(pr));
    } else {
      lines.push("", conversationSummary(pr));
    }
    success(deps.io, lines.join("\n"));
    return;
  }
  fail(deps.io, formatError(res, "Failed to view PR"), 1);
}


const MAX_CONVERSATION_CHARS = 40_000;

function conversationOf(pr: Record<string, unknown>): {
  comments: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  threads: Record<string, unknown>[];
} {
  const arr = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  return {
    comments: arr(pr.comments),
    reviews: arr(pr.reviews),
    threads: arr(pr.reviewThreads),
  };
}

function totalOf(pr: Record<string, unknown>, key: string, fetched: number): number {
  const value = pr[key];
  return typeof value === "number" && value >= fetched ? value : fetched;
}

function windowNote(total: number, fetched: number): string {
  return total > fetched ? ` (showing ${fetched})` : "";
}

function authorOf(item: Record<string, unknown>): string {
  const author = item.author as Record<string, unknown> | null | undefined;
  const login = author ? asString(author.login) : "";
  return `@${login || "ghost"}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function conversationSummary(pr: Record<string, unknown>): string {
  const { comments, reviews, threads } = conversationOf(pr);
  const commentTotal = totalOf(pr, "commentsTotal", comments.length);
  const reviewTotal = totalOf(pr, "reviewsTotal", reviews.length);
  const threadTotal = totalOf(pr, "reviewThreadsTotal", threads.length);
  if (commentTotal === 0 && reviewTotal === 0 && threadTotal === 0) {
    return "No comments, reviews, or review threads.";
  }
  const parts: string[] = [];
  if (commentTotal > 0) parts.push(plural(commentTotal, "comment"));
  if (reviewTotal > 0) parts.push(plural(reviewTotal, "review"));
  if (threadTotal > 0) {
    const unresolved = threads.filter((t) => t.isResolved !== true).length;
    parts.push(`${plural(threadTotal, "review thread")}${unresolved > 0 ? ` (${unresolved} unresolved)` : ""}`);
  }
  const num = asString(pr.number);
  return `${parts.join(" · ")} — run \`gh pr view ${num} --comments\` to read them.`;
}

function threadLocation(t: Record<string, unknown>): string {
  const path = asString(t.path) || "(file unknown)";
  // Outdated threads may have only the original line.
  const line = t.line ?? t.originalLine;
  if (line === null || line === undefined) return path;
  return `${path}:${asString(line)}`;
}

function renderConversation(pr: Record<string, unknown>): string {
  const { comments, reviews, threads } = conversationOf(pr);
  const commentTotal = totalOf(pr, "commentsTotal", comments.length);
  const reviewTotal = totalOf(pr, "reviewsTotal", reviews.length);
  const threadTotal = totalOf(pr, "reviewThreadsTotal", threads.length);
  const out: string[] = [];

  if (commentTotal === 0 && reviewTotal === 0 && threadTotal === 0) {
    return "No comments, reviews, or review threads.";
  }

  if (comments.length > 0) {
    out.push(`--- Comments (${commentTotal}${windowNote(commentTotal, comments.length)}) ---`);
    for (const c of comments) {
      out.push("", `${authorOf(c)} · ${asString(c.createdAt)}`, asString(c.body));
    }
  }

  if (reviews.length > 0) {
    if (out.length > 0) out.push("");
    out.push(`--- Reviews (${reviewTotal}${windowNote(reviewTotal, reviews.length)}) ---`);
    for (const r of reviews) {
      out.push("", `${authorOf(r)} ${asString(r.state)} · ${asString(r.submittedAt)}`);
      const body = asString(r.body);
      out.push(body.trim() ? body : "(no summary body)");
    }
  }

  if (threads.length > 0) {
    const unresolved = threads.filter((t) => t.isResolved !== true).length;
    if (out.length > 0) out.push("");
    out.push(`--- Review threads (${threadTotal}${windowNote(threadTotal, threads.length)}, ${unresolved} unresolved) ---`);
    for (const t of threads) {
      const flags = [
        t.isResolved === true ? "resolved" : "unresolved",
        ...(t.isOutdated === true ? ["outdated"] : []),
      ].join(", ");
      out.push("", `${threadLocation(t)} [${flags}]`);
      const hunk = asString(t.diffHunk);
      if (hunk.trim()) out.push(...hunk.split("\n").map((l) => `  ${l}`));
      for (const c of (Array.isArray(t.comments) ? (t.comments as Record<string, unknown>[]) : [])) {
        out.push(`  ${authorOf(c)}: ${asString(c.body)}`);
      }
    }
  }

  if (out.length === 0) return "No comments, reviews, or review threads.";

  const { text, truncated } = capText(out.join("\n"), MAX_CONVERSATION_CHARS);
  return wrapUntrustedContent({
    source: "pr",
    content: text,
    provenance: `pull request #${asString(pr.number)} — anyone who can comment authors this`,
    truncated,
  });
}

async function handlePrList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--state": "state",
      "--json": "json",
      "-L": "limit", "--limit": "limit",
      "--repo": "repo", "-R": "repo",
      ...JQ_FLAGS,
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  requireJsonForJq(deps, "gh pr list", parsed);
  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh pr list", PR_LIST_JSON_FIELDS)
    : undefined;

  const state = parsed.values.state;
  if (state !== undefined && !PR_LIST_STATES.includes(state)) {
    fail(
      deps.io,
      `gh pr list: unknown --state "${state}"\nSupported states for gh pr list: ${PR_LIST_STATES.join(", ")}`,
    );
  }

  const qs = targetQuery(deps, parsed.values.repo, {
    state,
    limit: parseLimit(parsed.values.limit, deps, "gh pr list"),
  });
  const res = await deps.call("GET", `/agent-ops/pr/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list PRs"), 1);
  }
  const prs = (res.body.prs as Record<string, unknown>[] | undefined) ?? [];
  if (fields !== undefined) {
    emitJson(deps, "gh pr list", prs.map((pr) => filterJson(pr, fields)), parsed.values.jq);
    return;
  }
  if (prs.length === 0) {
    success(deps.io, "No pull requests found.");
    return;
  }
  const lines = prs.map(
    (pr) => `#${asString(pr.number)}\t${asString(pr.title)}\t${asString(pr.head)}\t${pr.mergedAt ? "merged" : asString(pr.state)}${pr.isDraft === true ? " DRAFT" : ""}`,
  );
  success(deps.io, lines.join("\n"));
}

async function handlePrStatus(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { values: { "--repo": "repo", "-R": "repo" }, booleans: {} });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr status: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const res = await deps.call("GET", `/agent-ops/pr/status${targetQuery(deps, parsed.values.repo)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to fetch PR status"), 1);
  }
  const pr = res.body.pr as Record<string, unknown> | null;
  if (!pr) {
    success(deps.io, "No PR for the current branch.");
    return;
  }
  const lines = [
    `${asString(pr.title)} #${asString(pr.number)}`,
    `${asString(pr.headBranch)} → ${asString(pr.baseBranch)}`,
    asString(pr.url),
  ];
  success(deps.io, lines.join("\n"));
}

async function handlePrComment(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-b": "body", "--body": "body",
      "--body-file": "bodyFile", "-F": "bodyFile",
      "--repo": "repo", "-R": "repo",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr comment: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const body = await resolveBody(parsed.values.body, parsed.values.bodyFile, deps, "gh pr comment");
  if (!body) fail(deps.io, "gh pr comment: -b/--body is required.");
  const num = await resolvePrNumber(parsed.positional, deps, { repo: parsed.values.repo });
  const res = await deps.call("POST", `/agent-ops/pr/${num}/comment`, { body, ...targetBody(deps, parsed.values.repo) }, deps.env);
  if (res.status >= 200 && res.status < 300) {
    success(deps.io, asString(res.body.commentUrl));
    return;
  }
  fail(deps.io, formatError(res, "Failed to comment"), 1);
}

async function handlePrSimple(args: string[], deps: RunDeps, op: "ready" | "close" | "reopen"): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--repo": "repo", "-R": "repo" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr ${op}: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const num = await resolvePrNumber(parsed.positional, deps, { requiredFor: op === "reopen", repo: parsed.values.repo });
  const res = await deps.call("POST", `/agent-ops/pr/${num}/${op}`, targetBody(deps, parsed.values.repo), deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
    success(deps.io, url || `PR #${num} ${op}d`);
    return;
  }
  fail(deps.io, formatError(res, `Failed to ${op} PR`), 1);
}

async function handlePrMerge(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--repo": "repo", "-R": "repo" },
    booleans: {
      "--merge": "merge",
      "--squash": "squash",
      "--rebase": "rebase",
      "--auto": "auto",
      "--admin": "admin",
      "-d": "deleteBranch", "--delete-branch": "deleteBranch",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr merge: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("admin")) {
    fail(
      deps.io,
      "ShipIt's gh shim does not support --admin (force-merge / bypassing branch protection). A merge must satisfy the repo's required checks and reviews.",
    );
  }
  const methods = ["merge", "squash", "rebase"].filter((m) => parsed.booleans.has(m));
  if (methods.length > 1) {
    fail(deps.io, "gh pr merge: choose only one of --merge, --squash, --rebase.");
  }
  const method = methods[0] ?? "merge";
  if (parsed.booleans.has("deleteBranch")) {
    deps.io.stderr("Note: ShipIt's gh shim does not delete the branch after merge (--delete-branch ignored).\n");
  }
  const num = await resolvePrNumber(parsed.positional, deps, { repo: parsed.values.repo });
  const payload = {
    method,
    auto: parsed.booleans.has("auto"),
    ...targetBody(deps, parsed.values.repo),
  };
  const res = await deps.call("POST", `/agent-ops/pr/${num}/merge`, payload, deps.env);
  if (res.status >= 200 && res.status < 300) {
    // The broker can refuse a merge with HTTP 200 and success:false.
    if (res.body.success === false) {
      fail(deps.io, asString(res.body.message) || `Failed to merge PR #${num}`, 1);
    }
    success(deps.io, asString(res.body.message) || `Merged PR #${num}`);
    return;
  }
  fail(deps.io, formatError(res, `Failed to merge PR #${num}`), 1);
}

async function resolveBody(
  body: string | undefined,
  bodyFile: string | undefined,
  deps: RunDeps,
  command: string,
): Promise<string | undefined> {
  if (body !== undefined && bodyFile !== undefined) {
    fail(deps.io, `${command}: use either -b/--body or --body-file, not both.`);
  }
  if (bodyFile === undefined) return body;
  return readBodyFromFileOrStdin(bodyFile, deps.io, command, "body file");
}

async function resolvePrNumber(
  positional: string[],
  deps: RunDeps,
  opts: { requiredFor?: boolean; repo?: string } = {},
): Promise<number> {
  const raw = positional[0];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, `Invalid PR number: ${raw}`);
    }
    return n;
  }
  if (opts.requiredFor) {
    fail(deps.io, "PR number is required.");
  }
  const res = await deps.call("GET", `/agent-ops/pr/status${targetQuery(deps, opts.repo)}`, undefined, deps.env);
  const pr = res.body.pr as Record<string, unknown> | null;
  if (!pr || typeof pr.number !== "number") {
    fail(deps.io, "No open PR for the current branch — pass a PR number explicitly.");
  }
  return pr.number;
}

function emitLabelWarning(io: ShimIO, warning: unknown): void {
  if (typeof warning === "string" && warning.trim()) {
    io.stderr(warning.endsWith("\n") ? warning : `${warning}\n`);
  }
}

function formatError(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): string {
  const message = typeof res.body.error === "string" ? res.body.error : fallback;
  if (res.status === 0) return message;
  if (res.status === 401) {
    return `${message}\n\nGitHub is not connected for this ShipIt session. Ask the user to connect GitHub in the UI.`;
  }
  return message;
}


async function handleRunList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-w": "workflow", "--workflow": "workflow",
      "-b": "branch", "--branch": "branch",
      "-s": "status", "--status": "status",
      "-L": "limit", "--limit": "limit",
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      ...JQ_FLAGS,
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh run list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  requireJsonForJq(deps, "gh run list", parsed);
  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh run list", RUN_JSON_FIELDS)
    : undefined;
  const qs = targetQuery(deps, parsed.values.repo, {
    workflow: parsed.values.workflow,
    branch: parsed.values.branch,
    status: parsed.values.status,
    limit: parseLimit(parsed.values.limit, deps, "gh run list"),
  });
  const res = await deps.call("GET", `/agent-ops/run/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list workflow runs"), 1);
  }
  const runs = (res.body.runs as Record<string, unknown>[] | undefined) ?? [];
  if (fields !== undefined) {
    emitJson(deps, "gh run list", runs.map((r) => filterJson(r, fields)), parsed.values.jq);
    return;
  }
  if (runs.length === 0) {
    success(deps.io, "No workflow runs found.");
    return;
  }
  const lines = runs.map((r) =>
    [
      asString(r.status),
      asString(r.conclusion) || "-",
      asString(r.displayTitle),
      asString(r.workflowName),
      asString(r.headBranch),
      asString(r.event),
      asString(r.databaseId),
    ].join("\t"),
  );
  success(deps.io, lines.join("\n"));
}

async function handleRunView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      ...JQ_FLAGS,
    },
    booleans: {
      "--log": "log",
      "--log-failed": "logFailed",
      "-w": "web", "--web": "web",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh run view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web. The run details are printed on stdout.");
  }
  requireJsonForJq(deps, "gh run view", parsed);
  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh run view", RUN_VIEW_JSON_FIELDS)
    : undefined;
  const wantsLog = parsed.booleans.has("log");
  const wantsLogFailed = parsed.booleans.has("logFailed");
  const qs = targetQuery(deps, parsed.values.repo, {
    id: parsed.positional[0],
    log: wantsLog ? "true" : undefined,
    logFailed: wantsLogFailed ? "true" : undefined,
  });
  const res = await deps.call("GET", `/agent-ops/run/view${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to view workflow run"), 1);
  }
  const run = res.body.run as Record<string, unknown> | null;
  if (!run) {
    fail(deps.io, "No workflow run found.", 1);
  }
  const jobs = (res.body.jobs as Record<string, unknown>[] | undefined) ?? [];
  const logs = asString(res.body.logs);

  if (fields !== undefined) {
    const merged = { ...run, jobs, logs };
    emitJson(deps, "gh run view", filterJson(merged, fields), parsed.values.jq);
    return;
  }

  const lines = [
    `${asString(run.displayTitle)} · ${asString(run.workflowName)} #${asString(run.number)}`,
    `${asString(run.status)}${run.conclusion ? ` (${asString(run.conclusion)})` : ""}`.trim(),
    `${asString(run.headBranch)} · ${asString(run.event)}`,
    asString(run.url),
  ];
  if (jobs.length > 0) {
    lines.push("", "Jobs:");
    for (const j of jobs) {
      lines.push(`  ${asString(j.status)}${j.conclusion ? ` (${asString(j.conclusion)})` : ""}\t${asString(j.name)}`);
    }
  }
  if (wantsLog || wantsLogFailed) {
    lines.push("", logs.trim() ? logs : "(no logs available)");
  }
  success(deps.io, lines.join("\n"));
}

async function handleRunRerun(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--repo": "repo", "-R": "repo" },
    booleans: {
      "--failed": "failed",
      "-d": "debug", "--debug": "debug",
      "-j": "job", "--job": "job",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh run rerun: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("debug")) {
    fail(deps.io, "ShipIt's gh shim does not support --debug (re-run with debug logging). Re-run without it and read the logs with gh run view --log-failed.");
  }
  if (parsed.booleans.has("job")) {
    fail(deps.io, "ShipIt's gh shim does not support --job. Use --failed to re-run the failed jobs, or omit it to re-run the whole run.");
  }

  if (parsed.positional.length > 1) {
    fail(deps.io, `gh run rerun takes at most one run id — got ${parsed.positional.length}: ${parsed.positional.join(" ")}`);
  }
  const raw = parsed.positional[0];
  if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
    fail(deps.io, `Invalid run id: ${raw}. Pass the numeric id from gh run list, or omit it for this branch's latest run.`);
  }
  const onlyFailed = parsed.booleans.has("failed");
  const payload = {
    ...(raw !== undefined ? { id: raw } : {}),
    failed: onlyFailed,
    ...targetBody(deps, parsed.values.repo),
  };
  const res = await deps.call("POST", "/agent-ops/run/rerun", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to re-run the workflow run"), 1);
  }
  const run = (res.body.run as Record<string, unknown> | null) ?? {};
  const what = onlyFailed ? "Re-running failed jobs in" : "Re-running";
  const id = asString(run.databaseId) || raw || "";
  const name = asString(run.workflowName);
  const lines = [`${what} run${id ? ` ${id}` : ""}${name ? ` (${name})` : ""}.`];
  const url = asString(run.url);
  if (url) lines.push(url);
  if (id) lines.push("", `Watch it with: gh run view ${id}`);
  success(deps.io, lines.join("\n"));
}

async function handleWorkflowList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      "-L": "limit", "--limit": "limit",
      ...JQ_FLAGS,
    },
    booleans: { "-a": "all", "--all": "all" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh workflow list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  requireJsonForJq(deps, "gh workflow list", parsed);
  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh workflow list", WORKFLOW_JSON_FIELDS)
    : undefined;
  const limit = parseLimit(parsed.values.limit, deps, "gh workflow list");
  const res = await deps.call("GET", `/agent-ops/workflow/list${targetQuery(deps, parsed.values.repo)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list workflows"), 1);
  }
  const all = (res.body.workflows as Record<string, unknown>[] | undefined) ?? [];
  const workflows = limit !== undefined ? all.slice(0, Number(limit)) : all;
  if (fields !== undefined) {
    emitJson(deps, "gh workflow list", workflows.map((w) => filterJson(w, fields)), parsed.values.jq);
    return;
  }
  if (workflows.length === 0) {
    success(deps.io, "No workflows found.");
    return;
  }
  const lines = workflows.map((w) =>
    [asString(w.name), asString(w.state), asString(w.id)].join("\t"),
  );
  success(deps.io, lines.join("\n"));
}

async function handleWorkflowView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      ...JQ_FLAGS,
    },
    booleans: {
      "-w": "web", "--web": "web",
      "-y": "yaml", "--yaml": "yaml",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh workflow view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  requireJsonForJq(deps, "gh workflow view", parsed);
  const fields = parsed.values.json !== undefined
    ? jsonFields(parsed.values.json, deps, "gh workflow view", WORKFLOW_JSON_FIELDS)
    : undefined;
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web.");
  }
  if (parsed.booleans.has("yaml")) {
    fail(deps.io, "ShipIt's gh shim does not support --yaml. Read the workflow file from the workspace directly (e.g. cat .github/workflows/<file>).");
  }
  const wf = parsed.positional[0];
  if (!wf) {
    fail(deps.io, "gh workflow view: a workflow name, filename, or id is required.");
  }
  const qs = targetQuery(deps, parsed.values.repo, { workflow: wf });
  const res = await deps.call("GET", `/agent-ops/workflow/view${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to view workflow"), 1);
  }
  const workflow = res.body.workflow as Record<string, unknown> | null;
  if (!workflow) {
    fail(deps.io, `No workflow matching "${wf}" found.`, 1);
  }
  if (fields !== undefined) {
    emitJson(deps, "gh workflow view", filterJson(workflow, fields), parsed.values.jq);
    return;
  }
  const runs = (res.body.runs as Record<string, unknown>[] | undefined) ?? [];
  const lines = [
    `${asString(workflow.name)} (${asString(workflow.state)})`,
    asString(workflow.path),
    asString(workflow.url),
  ];
  if (runs.length > 0) {
    lines.push("", "Recent runs:");
    for (const r of runs) {
      lines.push(
        `  ${asString(r.status)}${r.conclusion ? ` (${asString(r.conclusion)})` : ""}\t${asString(r.displayTitle)}\t${asString(r.headBranch)}\t${asString(r.databaseId)}`,
      );
    }
  }
  success(deps.io, lines.join("\n"));
}

const RUN_HANDLERS: Record<string, (args: string[], deps: RunDeps) => Promise<void>> = {
  list: handleRunList,
  view: handleRunView,
  rerun: handleRunRerun,
};

const WORKFLOW_HANDLERS: Record<string, (args: string[], deps: RunDeps) => Promise<void>> = {
  list: handleWorkflowList,
  view: handleWorkflowView,
};


const PR_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  create: handlePrCreate,
  edit: handlePrEdit,
  view: handlePrView,
  list: handlePrList,
  status: handlePrStatus,
  comment: handlePrComment,
  ready: (args, deps) => handlePrSimple(args, deps, "ready"),
  close: (args, deps) => handlePrSimple(args, deps, "close"),
  reopen: (args, deps) => handlePrSimple(args, deps, "reopen"),
  merge: handlePrMerge,
};

const COMMAND_GROUPS: Record<
  string,
  Record<string, (args: string[], deps: RunDeps) => Promise<void>>
> = {
  pr: PR_HANDLERS,
  run: RUN_HANDLERS,
  workflow: WORKFLOW_HANDLERS,
};

export async function runShim(
  argv: string[],
  io: ShimIO = defaultIO,
  env: ShimEnv = {},
  call: typeof callBroker = callBroker,
  cwd: string = process.cwd(),
): Promise<void> {
  const deps: RunDeps = { env, io, call, cwd };

  const args = stripNodeArgs(argv);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    success(io, HELP);
    return;
  }
  if (args[0] === "--version") {
    success(io, "gh (ShipIt shim) 0.1.0");
    return;
  }

  const command = args[0];

  if (REJECTED_SUBCOMMANDS.has(command)) {
    fail(io, `${SHIM_NAME} only supports a subset of pull-request and workflow-run operations.\nTried: gh ${command}\nSee /shipit-docs/github.md for the full list.`);
  }

  const group = COMMAND_GROUPS[command];
  if (!group) {
    fail(io, `Unknown gh subcommand: ${command}\n${REJECTED_HELP}`);
  }

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    success(io, HELP);
    return;
  }

  const handler = group[sub];
  if (!handler) {
    fail(io, `Unsupported gh ${command} subcommand: ${sub}\n${REJECTED_HELP}`);
  }

  await handler(args.slice(2), deps);
}

function stripNodeArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const first = argv[0];
  if (first === "node" || first === "tsx" || first.startsWith("/") || first.endsWith("node") || first.endsWith("tsx")) {
    return argv.slice(2);
  }
  return argv;
}


if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runShim(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof Error && err.message === "__shim_exit__") return;
    shimWrite(process.stderr, `gh: ${err instanceof Error ? err.message : String(err)}\n`);
    exitAfterFlush(1);
  });
}
