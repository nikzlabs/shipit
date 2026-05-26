/**
 * `shipit` shim — a curated, sandboxed subset of session-management
 * operations for the inner agent (Claude or Codex).
 *
 * Installed at /usr/local/bin/shipit inside the session worker container so
 * the agent's bash tool can run `shipit session create -p "<prompt>"` to
 * spawn sibling sessions. The shim does not touch the orchestrator directly;
 * it POSTs to the worker's `/agent-ops/session/*` router on localhost, which
 * brokers through the orchestrator's session-scoped routes.
 *
 * Mirrors the `gh.ts` shim from doc 116 — same shape, same conventions,
 * same security model. The worker injects this container's session id as
 * the parent on every request, so the agent cannot spawn sessions under
 * a different parent (or read/mutate sessions it didn't spawn).
 *
 * Output:
 *   `shipit session create` prints a stable text block on stdout (id, branch,
 *   status) and exits 0. With `--json`, it prints a JSON object instead.
 *   `shipit session list/view` print plain-text tables or JSON when `--json`
 *   is requested. Errors go to stderr; exit code is non-zero.
 *
 * For documentation: see /shipit-docs/sessions.md inside the container.
 */

const SHIM_NAME = "shipit (ShipIt)";

const REJECTED_HELP = `${SHIM_NAME} only supports a curated subset of session-management operations.
See /shipit-docs/sessions.md for the full list.`;

const HELP = `${SHIM_NAME} — agent-driven session management.

Supported subcommands:
  shipit session create  -p "PROMPT" [--title T]
                          [--base REF] [--agent claude|codex] [--model M]
                          [--turn ID] [--json]
  shipit session list    [--turn ID] [--json]
  shipit session view    <id> [--json]
  shipit session message <id> -m "TEXT" [--json]
  shipit session wait    <id> [--timeout SECONDS] [--json]
  shipit session archive <id> [--json]
  shipit session help

The shim brokers session operations through the ShipIt orchestrator. The
parent session is always the session this container belongs to — the agent
cannot spawn sessions under a different parent, or view/manage sessions it
didn't spawn.

Use \`shipit session create\` when the user explicitly asked for a separate
session / parallel branch / independent workspace. For in-turn fan-out
under Claude, prefer the built-in \`Task\` tool.

See /shipit-docs/sessions.md for the full reference, including allowed
flags and the list of intentionally-rejected operations
(\`shipit session delete\`, cross-repo spawns, etc.).`;

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
  /** Boolean flags → output key. e.g. { "--json": "json" } */
  booleans?: Record<string, string>;
}

/**
 * Parse args using a flag spec. Anything not in the spec is treated as
 * positional unless it begins with `-`, in which case it's tracked as
 * "unsupported" and surfaced as an error by the caller.
 *
 * Kept in lock-step with `gh.ts`'s parser — same `--flag=value` shorthand,
 * same "missing value → unsupported" behavior, so the two shims stay
 * symmetric in how they handle agent typos.
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

/**
 * Subcommands that exist in the agent's mental model of ShipIt but the
 * shim refuses to expose. Listed explicitly so the agent gets a helpful
 * error pointing at the docs, instead of a generic "unknown command".
 */
const REJECTED_SESSION_SUBCOMMANDS = new Set([
  "delete",   // destructive; user-only.
  "adopt",    // not supported by design (cross-parent reparenting).
  "merge",    // future extension; user merges via the PR/merge UI today.
  "fork",     // separate primitive owned by the UI.
  "rename",   // user-driven; not part of the agent's surface.
  "switch",   // user navigation; not the agent's affordance.
]);

/**
 * Server-enforced cap on `shipit session wait --timeout`. The shim mirrors
 * the orchestrator's `MAX_WAIT_FOR_CHILD_IDLE_MS` so a flag-side check can
 * reject obvious typos (`--timeout 99999h`) without a round-trip.
 */
const MAX_WAIT_TIMEOUT_SECS = 60 * 60; // 1 hour

async function handleSessionCreate(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-p": "prompt", "--prompt": "prompt",
      "-m": "prompt", // alias for symmetry with `gh pr comment -b`
      "-t": "title", "--title": "title",
      "-B": "base", "--base": "base",
      "--agent": "agent",
      "--model": "model",
      "--turn": "turn",
      "--repo": "repo", "-R": "repo",
      "--owner": "owner",
    },
    booleans: {
      "--json": "json",
    },
  });

  if ("repo" in parsed.values || "owner" in parsed.values) {
    fail(
      deps.io,
      "shipit session create does not support --repo/--owner. Spawned sessions inherit the parent's repo.",
    );
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const prompt = parsed.values.prompt;
  if (!prompt) {
    fail(
      deps.io,
      "shipit session create: -p/--prompt is required (the initial user message for the new session).",
    );
  }
  // Defensive client-side validation — the orchestrator also enforces these,
  // but failing fast on the shim side avoids a network round-trip.
  if (prompt.length > 50_000) {
    fail(deps.io, "shipit session create: --prompt exceeds 50,000 characters.");
  }

  const payload: Record<string, unknown> = { prompt };
  if (parsed.values.title) payload.title = parsed.values.title;
  if (parsed.values.base) payload.base = parsed.values.base;
  if (parsed.values.agent) payload.agent = parsed.values.agent;
  if (parsed.values.model) payload.model = parsed.values.model;
  if (parsed.values.turn) payload.spawnedByTurn = parsed.values.turn;

  const res = await deps.call("POST", "/agent-ops/session/create", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to create spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }

  // Plain-text rendering. Keep this stable — the agent learns to parse it.
  const lines = [
    `session-id: ${asString(res.body.sessionId)}`,
    `branch:     ${asString(res.body.branch)}`,
    `status:     ${asString(res.body.status) || "running"}`,
  ];
  success(deps.io, lines.join("\n"));
}

async function handleSessionList(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--turn": "turn" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session list: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }

  const turn = parsed.values.turn;
  const qs = turn ? `?turn=${encodeURIComponent(turn)}` : "";
  const res = await deps.call("GET", `/agent-ops/session/list${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list spawned sessions"), 1);
  }
  const children = (res.body.children as Record<string, unknown>[] | undefined) ?? [];
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(children)}\n`);
    deps.io.exit(0);
    return;
  }
  if (children.length === 0) {
    success(deps.io, "No spawned sessions for this parent.");
    return;
  }
  const lines = children.map((c) =>
    [
      asString(c.id),
      asString(c.status) || "idle",
      asString(c.branch) || "(no branch)",
      asString(c.title),
    ].join("\t"),
  );
  success(deps.io, lines.join("\n"));
}

async function handleSessionView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {},
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session view: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session view: child session id is required.");
  }

  const res = await deps.call(
    "GET",
    `/agent-ops/session/view/${encodeURIComponent(id)}`,
    undefined,
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, "Spawned session not found, or not a descendant of this parent.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to view spawned session"), 1);
  }
  const child = res.body.child as Record<string, unknown> | null;
  if (!child) {
    fail(deps.io, "Spawned session not found.", 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(child)}\n`);
    deps.io.exit(0);
    return;
  }
  const lines = [
    `${asString(child.title)} (${asString(child.id)})`,
    `status:     ${asString(child.status) || "idle"}`,
    `branch:     ${asString(child.branch) || "(no branch)"}`,
    `queue:      ${asString(child.queueLength) || "0"}`,
    `spawned-at: ${asString(child.spawnedAt)}`,
  ];
  if (child.spawnedByTurn) {
    lines.push(`turn:       ${asString(child.spawnedByTurn)}`);
  }
  if (child.latestAssistantMessage) {
    lines.push("", asString(child.latestAssistantMessage));
  }
  success(deps.io, lines.join("\n"));
}

async function handleSessionMessage(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {
      "-m": "text", "--message": "text",
      "-p": "text", "--prompt": "text",
    },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session message: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session message: child session id is required.");
  }
  const text = parsed.values.text;
  if (!text) {
    fail(deps.io, "shipit session message: -m/--message is required (the prompt text to send).");
  }
  if (text.length > 50_000) {
    fail(deps.io, "shipit session message: --message exceeds 50,000 characters.");
  }

  const res = await deps.call(
    "POST",
    `/agent-ops/session/message/${encodeURIComponent(id)}`,
    { text },
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, "Spawned session not found, or not a descendant of this parent.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to send message to spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const queuePosition = Number(res.body.queuePosition ?? 0);
  const enqueued = res.body.enqueued === true;
  const lines = [
    `session-id: ${id}`,
    `delivered:  ${enqueued ? `queued (position ${queuePosition})` : "starting turn"}`,
  ];
  success(deps.io, lines.join("\n"));
}

async function handleSessionWait(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--timeout": "timeout", "-T": "timeout" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session wait: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session wait: child session id is required.");
  }
  // Defense-in-depth client-side validation. The orchestrator also enforces.
  let timeoutSecs: number | undefined;
  if (parsed.values.timeout) {
    const n = Number(parsed.values.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, "shipit session wait: --timeout must be a positive number of seconds.");
    }
    timeoutSecs = Math.min(Math.floor(n), MAX_WAIT_TIMEOUT_SECS);
  }

  const qs = timeoutSecs ? `?timeout=${timeoutSecs}` : "";
  const res = await deps.call(
    "GET",
    `/agent-ops/session/wait/${encodeURIComponent(id)}${qs}`,
    undefined,
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, "Spawned session not found, or not a descendant of this parent.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to wait on spawned session"), 1);
  }

  const child = res.body.child as Record<string, unknown> | null;
  const timedOut = res.body.timedOut === true;

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    // Non-zero on timeout so coordination scripts can detect it without
    // parsing the JSON. Matches the plan's "non-zero exit on timeout".
    deps.io.exit(timedOut ? 1 : 0);
    return;
  }

  if (!child) {
    fail(deps.io, "Spawned session not found.", 1);
  }

  const lines = [
    `${asString(child.title)} (${asString(child.id)})`,
    `status:     ${asString(child.status) || "idle"}`,
    `branch:     ${asString(child.branch) || "(no branch)"}`,
    `queue:      ${asString(child.queueLength) || "0"}`,
    `idle:       ${!timedOut}`,
    `timed-out:  ${timedOut}`,
  ];
  if (child.latestAssistantMessage) {
    lines.push("", asString(child.latestAssistantMessage));
  }
  if (timedOut) {
    deps.io.stdout(`${lines.join("\n")}\n`);
    deps.io.exit(1);
    return;
  }
  success(deps.io, lines.join("\n"));
}

async function handleSessionArchive(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: {},
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session archive: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const id = parsed.positional[0];
  if (!id) {
    fail(deps.io, "shipit session archive: child session id is required.");
  }

  const res = await deps.call(
    "POST",
    `/agent-ops/session/archive/${encodeURIComponent(id)}`,
    {},
    deps.env,
  );
  if (res.status === 404) {
    fail(deps.io, "Spawned session not found, or not a descendant of this parent.", 1);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to archive spawned session"), 1);
  }

  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  success(deps.io, `session-id: ${id}\narchived:   true`);
}

/** Format a broker/orchestrator error response as a single-line message. */
function formatError(
  res: { status: number; body: Record<string, unknown> },
  fallback: string,
): string {
  const message = typeof res.body.error === "string" ? res.body.error : fallback;
  if (res.status === 0) return message;
  if (res.status === 429) {
    return `${message}\n\nThis session has reached its per-turn or per-parent spawn cap. See /shipit-docs/sessions.md.`;
  }
  if (res.status === 401) {
    return `${message}\n\nShipIt was unable to authenticate the request against the orchestrator.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

const SESSION_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  create: handleSessionCreate,
  list: handleSessionList,
  view: handleSessionView,
  message: handleSessionMessage,
  wait: handleSessionWait,
  archive: handleSessionArchive,
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

  const args = stripNodeArgs(argv);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    success(io, HELP);
    return;
  }
  if (args[0] === "--version") {
    success(io, "shipit (ShipIt shim) 0.1.0");
    return;
  }

  const command = args[0];

  if (command !== "session") {
    fail(io, `Unknown shipit subcommand: ${command}\n${REJECTED_HELP}`);
  }

  const sub = args[1];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }

  if (REJECTED_SESSION_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit session ${sub}\`.\nTried: shipit session ${sub}\nSee /shipit-docs/sessions.md for the full list.`,
    );
  }

  const handler = SESSION_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit session subcommand: ${sub}\n${REJECTED_HELP}`);
  }

  await handler(args.slice(2), deps);
}

/**
 * Strip "node ..." or "tsx ..." prefixes from argv. Allows runShim to accept
 * either raw user args (`["session", "create", ...]`) or full process.argv.
 *
 * Same logic as `gh.ts`.
 */
function stripNodeArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const first = argv[0];
  if (
    first === "node" ||
    first === "tsx" ||
    first.startsWith("/") ||
    first.endsWith("node") ||
    first.endsWith("tsx")
  ) {
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
    process.stderr.write(`shipit: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
