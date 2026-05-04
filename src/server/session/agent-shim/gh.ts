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
 * the shim cannot specify a different repo (`--repo` is rejected).
 *
 * For documentation: see /shipit-docs/github.md inside the container.
 */

const SHIM_NAME = "gh (ShipIt)";

const REJECTED_HELP = `${SHIM_NAME} only supports a subset of pull-request operations.
See /shipit-docs/github.md for the full list.`;

const HELP = `${SHIM_NAME} — pull-request operations brokered through the ShipIt orchestrator.

Supported subcommands:
  gh pr create   [-t TITLE] [-b BODY] [-B BASE] [-d|--draft] [--fill]
  gh pr edit     [<number>] [-t TITLE] [-b BODY]
  gh pr view     [<number>] [--json FIELDS] [-w|--web]
  gh pr list     [--state STATE] [--json FIELDS]
  gh pr status
  gh pr comment  [<number>] -b BODY
  gh pr ready    [<number>]
  gh pr close    [<number>]
  gh pr reopen   <number>

Operations are scoped to this session's GitHub repo. The --repo flag is not
supported.

This is a ShipIt shim, not the real gh CLI. Subcommands like \`gh api\`, \`gh repo\`,
\`gh release\`, \`gh workflow\`, \`gh auth\`, and \`gh secret\` are intentionally
unavailable. See /shipit-docs/github.md.`;

const REJECTED_SUBCOMMANDS = new Set([
  "api", "auth", "browse", "codespace", "completion", "config", "extension",
  "gist", "gpg-key", "issue", "label", "release", "repo", "run", "ruleset",
  "secret", "ssh-key", "status", "variable", "workflow", "cache", "alias",
  "attestation", "co", "search", "org", "project",
]);

interface ParsedFlags {
  positional: string[];
  /** Map flag name → string value (last value wins). */
  values: Record<string, string>;
  /** Boolean flags that were present. */
  booleans: Set<string>;
  /** Tracks unsupported flags so we can reject them with a helpful error. */
  unsupported: string[];
}

interface FlagSpec {
  /** Flag → output key. e.g. { "--title": "title", "-t": "title" } */
  values?: Record<string, string>;
  /** Boolean flags → output key. e.g. { "--draft": "draft", "-d": "draft" } */
  booleans?: Record<string, string>;
}

/**
 * Parse args using a flag spec. Anything not in the spec is treated as
 * positional unless it begins with `-`, in which case it's tracked as
 * "unsupported" and surfaced as an error by the caller.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const valueSpec = spec.values ?? {};
  const booleanSpec = spec.booleans ?? {};
  const out: ParsedFlags = {
    positional: [],
    values: {},
    booleans: new Set(),
    unsupported: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // `--flag=value` shorthand — split it up before classifying.
    let token = arg;
    let inlineValue: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    if (token in valueSpec) {
      const key = valueSpec[token];
      if (inlineValue !== undefined) {
        out.values[key] = inlineValue;
      } else {
        const next = args[i + 1];
        if (next === undefined) {
          out.unsupported.push(`${token} requires a value`);
        } else {
          out.values[key] = next;
          i++;
        }
      }
      continue;
    }

    if (token in booleanSpec) {
      out.booleans.add(booleanSpec[token]);
      continue;
    }

    if (token.startsWith("-")) {
      out.unsupported.push(token);
      continue;
    }

    out.positional.push(token);
  }
  return out;
}

interface ShimEnv {
  /** Worker URL. Defaults to http://127.0.0.1:9100. */
  workerUrl?: string;
}

function workerBaseUrl(env: ShimEnv = {}): string {
  if (env.workerUrl) return env.workerUrl.replace(/\/$/, "");
  const fromEnv = process.env.SHIPIT_AGENT_OPS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.WORKER_PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

/**
 * Send a request to the worker's /agent-ops broker.
 * Returns parsed JSON and HTTP status. Network errors are surfaced as
 * status: 0 with an error body so the caller can format a helpful message.
 */
async function callBroker(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  env: ShimEnv,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${workerBaseUrl(env)}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined && method !== "GET") {
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      body: {
        error: `Could not reach the ShipIt session worker at ${url}: ${message}`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  return {
    status: res.status,
    body: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>,
  };
}

/**
 * Coerce an unknown value to a printable string. Strings and numbers pass
 * through; everything else (null, undefined, objects) becomes the empty
 * string so we never write `[object Object]` or `null` into agent output.
 */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Strict whitelist of `--json FIELDS` filters the shim supports.
 * Used by `gh pr view --json …` and `gh pr list --json …`.
 */
function filterJson(
  obj: Record<string, unknown>,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (!fields || fields.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) out[f] = obj[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO abstraction so tests can capture stdout/stderr without spawning processes
// ---------------------------------------------------------------------------

export interface ShimIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}

const defaultIO: ShimIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
};

function fail(io: ShimIO, message: string, code = 2): never {
  io.stderr(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(code);
  throw new Error("__shim_exit__"); // unreachable in practice; thrown so TS narrows
}

function success(io: ShimIO, message: string): void {
  io.stdout(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

interface RunDeps {
  env: ShimEnv;
  io: ShimIO;
  call: typeof callBroker;
}

async function handlePrCreate(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-t": "title", "--title": "title",
      "-b": "body", "--body": "body",
      "-B": "base", "--base": "base",
      "--repo": "repo", "-R": "repo",
    },
    booleans: {
      "-d": "draft", "--draft": "draft",
      "--fill": "fill",
      "--web": "web", "-w": "web",
    },
  });

  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag. Operations are scoped to the session's repo.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web. The PR URL is printed on stdout.");
  }

  const payload = {
    title: parsed.values.title,
    body: parsed.values.body,
    base: parsed.values.base,
    draft: parsed.booleans.has("draft"),
    fill: parsed.booleans.has("fill"),
  };
  const res = await deps.call("POST", "/agent-ops/pr/create", payload, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
    if (res.body.alreadyExisted) {
      // Match real gh behavior: we still print the URL (the user gets exactly
      // what they expect), but note the dedup on stderr for logs.
      deps.io.stderr(`Existing PR for this branch — printing its URL.\n`);
    }
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
      "--repo": "repo", "-R": "repo",
    },
  });
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const num = await resolvePrNumber(parsed.positional, deps);

  const payload = {
    title: parsed.values.title,
    body: parsed.values.body,
  };
  if (payload.title === undefined && payload.body === undefined) {
    fail(deps.io, "gh pr edit: provide a title (-t) or body (-b) to update.");
  }

  const res = await deps.call("PATCH", `/agent-ops/pr/${num}`, payload, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
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
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("web")) {
    fail(deps.io, "ShipIt's gh shim does not support --web.");
  }

  const numArg = parsed.positional[0];
  const qs = numArg ? `?number=${encodeURIComponent(numArg)}` : "";
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
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const stateRaw = parsed.values.state;
  const qs = stateRaw ? `?state=${encodeURIComponent(stateRaw)}` : "";
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
  const parsed = parseFlags(args, { values: { "--repo": "repo" }, booleans: {} });
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr status: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const res = await deps.call("GET", "/agent-ops/pr/status", undefined, deps.env);
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
      "--repo": "repo", "-R": "repo",
    },
  });
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr comment: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const body = parsed.values.body;
  if (!body) fail(deps.io, "gh pr comment: -b/--body is required.");
  const num = await resolvePrNumber(parsed.positional, deps);
  const res = await deps.call("POST", `/agent-ops/pr/${num}/comment`, { body }, deps.env);
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
  if ("repo" in parsed.values) {
    fail(deps.io, "ShipIt's gh shim does not support the --repo flag.");
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for gh pr ${op}: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const num = await resolvePrNumber(parsed.positional, deps, { requiredFor: op === "reopen" });
  const res = await deps.call("POST", `/agent-ops/pr/${num}/${op}`, {}, deps.env);
  if (res.status >= 200 && res.status < 300) {
    const url = typeof res.body.url === "string" ? res.body.url : "";
    success(deps.io, url || `PR #${num} ${op}d`);
    return;
  }
  fail(deps.io, formatError(res, `Failed to ${op} PR`), 1);
}

/**
 * Resolve the PR number from positional args. When omitted, falls back to the
 * open PR for the current branch via /agent-ops/pr/status.
 */
async function resolvePrNumber(
  positional: string[],
  deps: RunDeps,
  opts: { requiredFor?: boolean } = {},
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
  // Look up via status route
  const res = await deps.call("GET", "/agent-ops/pr/status", undefined, deps.env);
  const pr = res.body.pr as Record<string, unknown> | null;
  if (!pr || typeof pr.number !== "number") {
    fail(deps.io, "No open PR for the current branch — pass a PR number explicitly.");
  }
  return pr.number;
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
): Promise<void> {
  const deps: RunDeps = { env, io, call };

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
    fail(io, `${SHIM_NAME} only supports a subset of pull-request operations.\nTried: gh ${command}\nSee /shipit-docs/github.md for the full list.`);
  }

  if (command !== "pr") {
    fail(io, `Unknown gh subcommand: ${command}\n${REJECTED_HELP}`);
  }

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h") {
    success(io, HELP);
    return;
  }

  const handler = PR_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported gh pr subcommand: ${sub}\n${REJECTED_HELP}`);
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
