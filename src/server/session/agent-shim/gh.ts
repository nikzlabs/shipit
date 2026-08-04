/**
 * `gh` shim — a curated, sandboxed subset of the real GitHub CLI.
 *
 * Installed at /usr/local/bin/gh inside the session worker container so the
 * agent's bash tool can run `gh pr create -t "..." -b "..."` like it would
 * with the real CLI. The shim does not call GitHub directly — it POSTs to
 * the worker's `/agent-ops/*` router on localhost, which brokers through
 * the orchestrator's session-scoped routes.
 *
 * Why a shim, not the real gh:
 * - The real `gh` exposes `gh api`, `gh repo create/delete`, `gh workflow run`,
 *   `gh release`, `gh secret set`, `gh ssh-key`, etc. Backed by the user's
 *   GitHub token, that's a large mutation surface reachable from any process
 *   the agent spawns.
 * - The shim's allowlist is narrow on purpose: pull-request operations only.
 *
 * Output:
 * - `gh pr create` prints the PR URL on stdout, exits 0 (matches real gh).
 * - `gh pr view --json fields` prints valid JSON on stdout.
 * - Errors go to stderr; exit code is non-zero.
 *
 * The agent never sees the GitHub token. The worker injects the session ID;
 * the agent cannot ask for operations against a different *session*.
 *
 * Repo targeting (docs/211 — Sandbox sessions): the shim forwards the working
 * directory it ran in (`cwd`) and an optional `--repo owner/name`, so the
 * orchestrator can resolve the target repo from the current clone rather than a
 * fixed session repo. For a normal repo-bound session this is a no-op (the one
 * repo lives at the workspace root); for a sandbox it lets the agent open PRs
 * per-clone. The no-raw-token property is unchanged — only *which* repo the
 * (server-side) broker may act on widens.
 *
 * The shared CLI plumbing (flag parsing, the broker HTTP call, the IO
 * abstraction, body-from-file/stdin reading, the value/JSON-filter helpers)
 * lives in `shim-common.ts` and is shared with the `shipit` shim. Only the
 * PR-specific surface is in this file.
 *
 * For documentation: see /shipit-docs/github.md inside the container.
 */

import {
  asString,
  callBroker,
  defaultIO,
  fail,
  filterJson,
  normalizeLabels,
  parseFlags,
  readBodyFromFileOrStdin,
  success,
  type ShimEnv,
  type ShimIO,
} from "./shim-common.js";

// Re-exported so existing importers (and tests) keep resolving these from
// `./gh.js` after the move into shim-common.
export { parseFlags, type ShimIO };

const SHIM_NAME = "gh (ShipIt)";

const REJECTED_HELP = `${SHIM_NAME} only supports a subset of pull-request operations.
See /shipit-docs/github.md for the full list.`;

const HELP = `${SHIM_NAME} — pull-request operations brokered through the ShipIt orchestrator.

Supported subcommands:
  gh pr create   [-t TITLE] [-b BODY|--body-file FILE] [-B BASE] [-d|--draft] [--fill] [-l|--label LABEL]
  gh pr edit     [<number>] [-t TITLE] [-b BODY|--body-file FILE] [--add-label LABEL] [--remove-label LABEL]
  gh pr view     [<number>] [--json FIELDS] [-w|--web]
  gh pr list     [--state STATE] [--json FIELDS]
  gh pr status
  gh pr comment  [<number>] (-b BODY|--body-file FILE)
  gh pr ready    [<number>]
  gh pr close    [<number>]
  gh pr reopen   <number>
  gh pr merge    [<number>] [--merge|--squash|--rebase] [--auto]   (Sandbox sessions with "Allow merging PRs" only)

  gh run list      [-w WORKFLOW] [-b BRANCH] [-s STATUS] [-L LIMIT] [--json FIELDS]
  gh run view      [<run-id>] [--log] [--log-failed] [--json FIELDS]
  gh workflow list [--json FIELDS]
  gh workflow view <workflow> [--json FIELDS]

Operations target the repo of the current working directory's clone. Pass
--repo OWNER/NAME to target a specific repo explicitly.

This is a ShipIt shim, not the real gh CLI. \`gh run\`/\`gh workflow\` are
READ-ONLY here — listing and viewing runs/workflows (e.g. the result of a
manually-dispatched workflow). Subcommands like \`gh api\`, \`gh repo\`,
\`gh release\`, \`gh auth\`, \`gh secret\`, and the workflow *manipulation* verbs
(\`gh workflow run\`, \`gh run rerun\`, \`gh run cancel\`, \`gh run delete\`) are
intentionally unavailable. See /shipit-docs/github.md.`;

const REJECTED_SUBCOMMANDS = new Set([
  "api", "auth", "browse", "codespace", "completion", "config", "extension",
  "gist", "gpg-key", "issue", "label", "release", "repo", "ruleset",
  "secret", "ssh-key", "status", "variable", "cache", "alias",
  "attestation", "co", "search", "org", "project",
]);

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

interface RunDeps {
  env: ShimEnv;
  io: ShimIO;
  call: typeof callBroker;
  /**
   * The working directory `gh` was invoked in (docs/211). Forwarded to the
   * broker so the orchestrator resolves the target repo from this clone. The
   * standalone entry passes `process.cwd()`; tests inject a fixed value.
   */
  cwd: string;
}

/**
 * Build the `cwd`/`repo` fields a POST/PATCH PR op forwards in its body so the
 * orchestrator can resolve the repo-aware target (docs/211). Only populated
 * fields are included.
 */
function targetBody(deps: RunDeps, repo: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (deps.cwd) out.cwd = deps.cwd;
  if (repo) out.repo = repo;
  return out;
}

/**
 * Build the querystring a GET PR op forwards (docs/211): the repo-aware target
 * (`cwd` + `--repo`) merged with op-specific params (`number`, `state`). Only
 * defined values are included.
 */
function targetQuery(
  deps: RunDeps,
  repo: string | undefined,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  if (deps.cwd) params.set("cwd", deps.cwd);
  if (repo) params.set("repo", repo);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
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
      // Match real gh behavior: we still print the URL (the user gets exactly
      // what they expect), but note the dedup on stderr for logs.
      deps.io.stderr(`Existing PR for this branch — printing its URL.\n`);
    }
    // Labeling is best-effort: a bad label name never blocks the PR. When the
    // orchestrator couldn't apply a label it returns a non-fatal warning here.
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
      // `--add-label` is the real-gh edit flag; `--label`/`-l` are kept as
      // additive aliases so existing scripts keep working. All three add.
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

  const qs = targetQuery(deps, parsed.values.repo, { number: parsed.positional[0] });
  const res = await deps.call("GET", `/agent-ops/pr/view${qs}`, undefined, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const pr = res.body.pr as Record<string, unknown> | null;
    if (!pr) {
      fail(deps.io, "No pull request found for this branch.", 1);
    }
    if (parsed.values.json !== undefined) {
      const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
      deps.io.stdout(`${JSON.stringify(filterJson(pr, fields))}\n`);
      deps.io.exit(0);
      return;
    }
    // Plain-text rendering similar to real gh. We coerce field values to
    // strings explicitly because the broker response is typed as `unknown`.
    const lines = [
      `${asString(pr.title)} #${asString(pr.number)}`,
      `${asString(pr.state)}${pr.isDraft === true ? " (draft)" : ""}`.trim(),
      `${asString(pr.head)} → ${asString(pr.base)}`,
      asString(pr.url),
      "",
      asString(pr.body),
    ];
    success(deps.io, lines.join("\n"));
    return;
  }
  fail(deps.io, formatError(res, "Failed to view PR"), 1);
}

async function handlePrList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--state": "state",
      "--json": "json",
      "-L": "limit", "--limit": "limit",
      "--repo": "repo", "-R": "repo",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const qs = targetQuery(deps, parsed.values.repo, { state: parsed.values.state });
  const res = await deps.call("GET", `/agent-ops/pr/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list PRs"), 1);
  }
  const prs = (res.body.prs as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.values.json !== undefined) {
    const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
    deps.io.stdout(`${JSON.stringify(prs.map((pr) => filterJson(pr, fields)))}\n`);
    deps.io.exit(0);
    return;
  }
  if (prs.length === 0) {
    success(deps.io, "No pull requests found.");
    return;
  }
  const lines = prs.map(
    (pr) => `#${asString(pr.number)}\t${asString(pr.title)}\t${asString(pr.head)}\t${asString(pr.state)}${pr.isDraft === true ? " DRAFT" : ""}`,
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

/**
 * `gh pr merge` (docs/224). Brokered only for Sandbox sessions with the
 * "Allow merging PRs" grant — the orchestrator enforces that gate plus the
 * green-checks / branch-protection / no-force guardrails and returns a clear
 * message. The shim's job is to parse the method/auto flags, reject `--admin`
 * (force-merge is never available), and surface the result.
 */
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
  // Method is one of --merge / --squash / --rebase (mutually exclusive). Default merge.
  const methods = ["merge", "squash", "rebase"].filter((m) => parsed.booleans.has(m));
  if (methods.length > 1) {
    fail(deps.io, "gh pr merge: choose only one of --merge, --squash, --rebase.");
  }
  const method = methods[0] ?? "merge";
  if (parsed.booleans.has("deleteBranch")) {
    // Branch deletion isn't brokered — note it rather than silently dropping it.
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
    // A guardrail refusal (checks not green, draft, branch protection) comes back
    // 200 with success:false — surface it as a non-zero exit, matching real gh on
    // an un-mergeable PR.
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

/**
 * Resolve the PR number from positional args. When omitted, falls back to the
 * open PR for the current branch via /agent-ops/pr/status.
 */
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
  // Look up via status route — repo-aware so the fallback resolves the PR of
  // the same clone the op targets (docs/211).
  const res = await deps.call("GET", `/agent-ops/pr/status${targetQuery(deps, opts.repo)}`, undefined, deps.env);
  const pr = res.body.pr as Record<string, unknown> | null;
  if (!pr || typeof pr.number !== "number") {
    fail(deps.io, "No open PR for the current branch — pass a PR number explicitly.");
  }
  return pr.number;
}

/**
 * Print a best-effort label warning to stderr, if the orchestrator returned
 * one. Labeling never blocks the PR operation (the URL is still printed and
 * the exit code stays 0) — a missing label or a token without label-write just
 * surfaces this note for the agent/user.
 */
function emitLabelWarning(io: ShimIO, warning: unknown): void {
  if (typeof warning === "string" && warning.trim()) {
    io.stderr(warning.endsWith("\n") ? warning : `${warning}\n`);
  }
}

/** Format a broker/orchestrator error response as a single-line message. */
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

// ---------------------------------------------------------------------------
// GitHub Actions handlers (read-only) — `gh run` / `gh workflow`
// ---------------------------------------------------------------------------

async function handleRunList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-w": "workflow", "--workflow": "workflow",
      "-b": "branch", "--branch": "branch",
      "-s": "status", "--status": "status",
      "-L": "limit", "--limit": "limit",
      "--json": "json",
      "--repo": "repo", "-R": "repo",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh run list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const qs = targetQuery(deps, parsed.values.repo, {
    workflow: parsed.values.workflow,
    branch: parsed.values.branch,
    status: parsed.values.status,
    limit: parsed.values.limit,
  });
  const res = await deps.call("GET", `/agent-ops/run/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list workflow runs"), 1);
  }
  const runs = (res.body.runs as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.values.json !== undefined) {
    const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
    deps.io.stdout(`${JSON.stringify(runs.map((r) => filterJson(r, fields)))}\n`);
    deps.io.exit(0);
    return;
  }
  if (runs.length === 0) {
    success(deps.io, "No workflow runs found.");
    return;
  }
  // STATUS  CONCLUSION  TITLE  WORKFLOW  BRANCH  EVENT  ID
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

  if (parsed.values.json !== undefined) {
    const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
    // Merge jobs/logs into the run object so `--json jobs` / `--json …` works.
    const merged = { ...run, jobs, logs };
    deps.io.stdout(`${JSON.stringify(filterJson(merged, fields))}\n`);
    deps.io.exit(0);
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

async function handleWorkflowList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "--json": "json",
      "--repo": "repo", "-R": "repo",
      // Accepted for real-gh compatibility but not forwarded (the orchestrator
      // returns the repo's workflows up to a fixed cap).
      "-L": "limit", "--limit": "limit",
    },
    booleans: { "-a": "all", "--all": "all" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh workflow list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const res = await deps.call("GET", `/agent-ops/workflow/list${targetQuery(deps, parsed.values.repo)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list workflows"), 1);
  }
  const workflows = (res.body.workflows as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.values.json !== undefined) {
    const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
    deps.io.stdout(`${JSON.stringify(workflows.map((w) => filterJson(w, fields)))}\n`);
    deps.io.exit(0);
    return;
  }
  if (workflows.length === 0) {
    success(deps.io, "No workflows found.");
    return;
  }
  // NAME  STATE  ID
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
    },
    booleans: {
      "-w": "web", "--web": "web",
      "-y": "yaml", "--yaml": "yaml",
    },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh workflow view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
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
  if (parsed.values.json !== undefined) {
    const fields = parsed.values.json.split(",").map((s) => s.trim()).filter(Boolean);
    deps.io.stdout(`${JSON.stringify(filterJson(workflow, fields))}\n`);
    deps.io.exit(0);
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
};

const WORKFLOW_HANDLERS: Record<string, (args: string[], deps: RunDeps) => Promise<void>> = {
  list: handleWorkflowList,
  view: handleWorkflowView,
};

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

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

/** Top-level command groups the shim allows, each with its own subcommand map. */
const COMMAND_GROUPS: Record<
  string,
  Record<string, (args: string[], deps: RunDeps) => Promise<void>>
> = {
  pr: PR_HANDLERS,
  run: RUN_HANDLERS,
  workflow: WORKFLOW_HANDLERS,
};

/**
 * Top-level shim entry point. Tests call this directly with stubs so we can
 * verify behavior without spawning a subprocess.
 */
export async function runShim(
  argv: string[],
  io: ShimIO = defaultIO,
  env: ShimEnv = {},
  call: typeof callBroker = callBroker,
  cwd: string = process.cwd(),
): Promise<void> {
  const deps: RunDeps = { env, io, call, cwd };

  // Strip "node /path/to/gh.ts" if present (real invocations omit them, but
  // tests often pass full argv). Also handle direct shebang invocation.
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
    fail(io, `${SHIM_NAME} only supports a subset of pull-request and read-only workflow operations.\nTried: gh ${command}\nSee /shipit-docs/github.md for the full list.`);
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

/**
 * Strip "node ..." or "tsx ..." prefixes from argv. Allows runShim to accept
 * either raw user args (`["pr", "create", ...]`) or full process.argv.
 */
function stripNodeArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const first = argv[0];
  // Heuristic: real CLI args start with the subcommand ("pr"/"--help"/etc).
  // process.argv would start with "/usr/bin/node" or similar.
  if (first === "node" || first === "tsx" || first.startsWith("/") || first.endsWith("node") || first.endsWith("tsx")) {
    // Skip node + the script path
    return argv.slice(2);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// Standalone entry — only when run as a script, not when imported by tests
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  runShim(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof Error && err.message === "__shim_exit__") return;
    process.stderr.write(`gh: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
