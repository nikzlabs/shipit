/**
 * `shipit` shim — a curated, sandboxed subset of session-management
 * operations for the inner agent (Claude or Codex).
 *
 * Installed at /usr/local/bin/shipit inside the session worker container so
 * the agent's bash tool can run `shipit session create --prompt-file -` to
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

import fsp from "node:fs/promises";

const SHIM_NAME = "shipit (ShipIt)";

const REJECTED_HELP = `${SHIM_NAME} only supports a curated subset of session-management operations.
See /shipit-docs/sessions.md for the full list.`;

const HELP = `${SHIM_NAME} — agent-driven session management.

Supported subcommands:
  shipit session create  --prompt-file FILE [--title T]
                          [--base REF] [--agent claude|codex] [--model M]
                          [--turn ID] [--shipit-source] [--approximate] [--json]
  shipit session list    [--turn ID] [--json]
  shipit session view    <id> [--json]
  shipit session message <id> -m "TEXT" [--json]
  shipit session wait    <id> [--timeout SECONDS] [--json]
  shipit session archive <id> [--json]
  shipit session help

Ops-only (read-only ShipIt source, docs/162):
  shipit source status   [--json]
  shipit source tree     [PATH] [--json]
  shipit source search   "QUERY" [--path PATH] [--json]
  shipit source cat      PATH [--json]
  shipit source log      [PATH] [--limit N] [--json]
  shipit source blame    PATH [--json]
  shipit source show     COMMIT [PATH] [--json]

The shim brokers session operations through the ShipIt orchestrator. The
parent session is always the session this container belongs to — the agent
cannot spawn sessions under a different parent, or view/manage sessions it
didn't spawn.

The new session's first user message is passed via \`--prompt-file\` — a file
path, or \`-\` to read the prompt from stdin. There is no inline \`-p\`/\`--prompt\`
flag: a prompt on the command line gets mangled when it contains backticks or
\`$(...)\`, which the shell evaluates before the shim sees them. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit session create --prompt-file - --title "Port API" <<'EOF'
  Port the API in /server to TypeScript. Land it as a separate PR.
  EOF

Use \`shipit session create\` when the user explicitly asked for a separate
session / parallel branch / independent workspace. For in-turn fan-out
under Claude, prefer the built-in \`Task\` tool.

In an Ops session, use \`shipit source *\` to read the ShipIt source code that
runs this host, then \`shipit session create --shipit-source --title "..."\` to
spawn a repo-backed fix session branched from the exact inspected commit.
\`--title\` is REQUIRED with \`--shipit-source\`: the diagnosis is wrapped in an
incident packet and can't name the session, so pass a short human-readable name.

See /shipit-docs/sessions.md for the full reference, including allowed
flags and the list of intentionally-rejected operations
(\`shipit session delete\`, \`shipit source edit\`, cross-repo spawns, etc.).`;

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

/**
 * Inline prompt flags the agent might reach for out of muscle memory. We
 * intentionally do NOT accept them: a prompt passed on the command line gets
 * mangled the moment it contains backticks or `$(...)`, which the shell
 * evaluates before the shim ever sees the value. The prompt must come from a
 * file (or stdin via `--prompt-file -`), exactly like the `gh` shim's
 * `--body-file`. Detected here so the agent gets a redirect, not a generic
 * "unsupported flag" error.
 */
const INLINE_PROMPT_FLAGS = ["-p", "--prompt", "-m", "--message"];

const INLINE_PROMPT_REDIRECT = `shipit session create: inline prompt flags (-p/--prompt/-m) are not supported.
Pass the prompt via --prompt-file FILE, or --prompt-file - to read it from stdin,
so backticks and $(...) in the prompt are not evaluated by the shell. Use a
single-quoted heredoc, exactly like \`gh pr create --body-file -\`:

  shipit session create --prompt-file - --title "..." <<'EOF'
  Your prompt here, with \`backticks\` and $(literal) preserved verbatim.
  EOF`;

async function handleSessionCreate(args: string[], deps: RunDeps): Promise<void> {
  // Catch inline prompt flags before generic flag parsing so the agent gets a
  // targeted redirect to --prompt-file instead of a vague "unsupported flag".
  const usedInline = args.some(
    (a) =>
      INLINE_PROMPT_FLAGS.includes(a) ||
      a.startsWith("--prompt=") ||
      a.startsWith("--message="),
  );
  if (usedInline) {
    fail(deps.io, INLINE_PROMPT_REDIRECT);
  }

  const parsed = parseFlags(args, {
    values: {
      "--prompt-file": "promptFile", "-f": "promptFile", "-F": "promptFile",
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
      // docs/162 — Ops-only: target the ShipIt source repo, branched off the
      // exact deployed commit the Ops session inspected.
      "--shipit-source": "shipitSource",
      // docs/162 — allow spawning even when the inspected source ref is only
      // approximate (checkout HEAD, not the exact build commit).
      "--approximate": "approximate",
    },
  });

  if ("repo" in parsed.values || "owner" in parsed.values) {
    fail(
      deps.io,
      "shipit session create does not support --repo/--owner. Spawned sessions inherit the parent's repo (or use --shipit-source in an Ops session).",
    );
  }
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session create: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  if (parsed.booleans.has("approximate") && !parsed.booleans.has("shipitSource")) {
    fail(deps.io, "shipit session create: --approximate only applies with --shipit-source.");
  }
  // docs/162 — a ShipIt fix spawn wraps the diagnosis in a verbose incident
  // packet, so the prompt can't be used to name the session. Require an
  // explicit, human-readable title so the spawned fix is identifiable in the
  // sidebar. (Fail fast here; the orchestrator enforces this too.)
  if (parsed.booleans.has("shipitSource") && !(parsed.values.title ?? "").trim()) {
    fail(
      deps.io,
      "shipit session create --shipit-source requires --title: give the fix session a short, " +
        "human-readable name describing what it fixes.",
    );
  }

  const promptFile = parsed.values.promptFile;
  if (!promptFile) {
    fail(
      deps.io,
      "shipit session create: --prompt-file is required (a file, or `-` for stdin, holding the initial user message for the new session).",
    );
  }
  const prompt = await readPromptFile(promptFile, deps);
  if (prompt.trim().length === 0) {
    fail(
      deps.io,
      "shipit session create: the prompt is empty. --prompt-file must hold the initial user message for the new session.",
    );
  }
  // Defensive client-side validation — the orchestrator also enforces these,
  // but failing fast on the shim side avoids a network round-trip.
  if (prompt.length > 50_000) {
    fail(deps.io, "shipit session create: the prompt exceeds 50,000 characters.");
  }

  const payload: Record<string, unknown> = { prompt };
  if (parsed.values.title) payload.title = parsed.values.title;
  if (parsed.values.base) payload.base = parsed.values.base;
  if (parsed.values.agent) payload.agent = parsed.values.agent;
  if (parsed.values.model) payload.model = parsed.values.model;
  if (parsed.values.turn) payload.spawnedByTurn = parsed.values.turn;
  if (parsed.booleans.has("shipitSource")) payload.shipitSource = true;
  if (parsed.booleans.has("approximate")) payload.approximateSource = true;

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

/**
 * Read the new session's prompt from a file path, or from stdin when the path
 * is `-`. Mirrors the `gh` shim's `resolveBody` so the two shims read external
 * content the same way. Exits non-zero with a helpful message when the file
 * can't be read.
 */
async function readPromptFile(promptFile: string, deps: RunDeps): Promise<string> {
  try {
    return promptFile === "-" ? await readStdin() : await fsp.readFile(promptFile, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(deps.io, `shipit session create: could not read prompt file ${promptFile}: ${message}`);
    throw new Error("__shim_exit__"); // unreachable; fail() exits.
  }
}

async function readStdin(): Promise<string> {
  let out = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    out += typeof chunk === "string" ? chunk : String(chunk);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Read-only ShipIt source subcommands (docs/162) — Ops sessions only.
// ---------------------------------------------------------------------------

/**
 * Source subcommands the agent might reach for that the shim refuses to expose.
 * Source access is strictly read-only — mutation happens through a spawned
 * `--shipit-source` fix session, never against the source snapshot directly.
 */
const REJECTED_SOURCE_SUBCOMMANDS = new Set([
  "edit",
  "write",
  "commit",
  "push",
  "checkout",
  "git",
  "apply",
  "patch",
]);

async function handleSourceStatus(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source status: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const res = await deps.call("GET", "/agent-ops/source/status", undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source status"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  if (res.body.available !== true) {
    fail(deps.io, asString(res.body.reason) || "ShipIt source is unavailable.", 1);
  }
  const lines = [
    `available:  true`,
    `ref:        ${asString(res.body.ref)}`,
    `exact:      ${res.body.exact === true}`,
    `ref-source: ${asString(res.body.refSource) || "unknown"}`,
  ];
  if (res.body.remoteUrl) lines.push(`remote:     ${asString(res.body.remoteUrl)}`);
  if (res.body.exact !== true) {
    lines.push(
      "",
      "NOTE: this ref is approximate (the source checkout's HEAD, not the exact",
      "deployed build). `shipit session create --shipit-source` needs --approximate.",
    );
  }
  success(deps.io, lines.join("\n"));
}

async function handleSourceTree(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source tree: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0] ?? "";
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await deps.call("GET", `/agent-ops/source/tree${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to list source tree"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const entries = (res.body.entries as Record<string, unknown>[] | undefined) ?? [];
  if (entries.length === 0) {
    success(deps.io, `(empty: ${asString(res.body.path) || "."} @ ${asString(res.body.ref).slice(0, 12)})`);
    return;
  }
  const lines = entries.map((e) =>
    `${e.type === "dir" ? "dir " : "file"}  ${asString(e.name)}${e.type === "dir" ? "/" : ""}`,
  );
  if (res.body.truncated === true) lines.push("… (truncated)");
  success(deps.io, lines.join("\n"));
}

async function handleSourceSearch(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--path": "path" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source search: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const query = parsed.positional[0];
  if (!query) {
    fail(deps.io, 'shipit source search: a query is required, e.g. shipit source search "ContainerSessionRunner".');
  }
  const params = new URLSearchParams({ q: query });
  if (parsed.values.path) params.set("path", parsed.values.path);
  const res = await deps.call("GET", `/agent-ops/source/search?${params.toString()}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to search source"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const matches = (res.body.matches as Record<string, unknown>[] | undefined) ?? [];
  if (matches.length === 0) {
    success(deps.io, `No matches for "${query}".`);
    return;
  }
  const lines = matches.map((m) => `${asString(m.path)}:${asString(m.line)}:${asString(m.text)}`);
  if (res.body.truncated === true) lines.push("… (truncated; narrow with --path)");
  success(deps.io, lines.join("\n"));
}

async function handleSourceCat(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source cat: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0];
  if (!path) {
    fail(deps.io, "shipit source cat: a file path is required, e.g. shipit source cat src/server/orchestrator/index.ts.");
  }
  const res = await deps.call("GET", `/agent-ops/source/cat?path=${encodeURIComponent(path)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source file"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const content = asString(res.body.content);
  deps.io.stdout(content.endsWith("\n") ? content : `${content}\n`);
  if (res.body.truncated === true) deps.io.stderr("… (truncated; file exceeds the source cat size cap)\n");
  deps.io.exit(0);
}

async function handleSourceLog(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--limit": "limit" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source log: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const params = new URLSearchParams();
  const path = parsed.positional[0];
  if (path) params.set("path", path);
  if (parsed.values.limit) params.set("limit", parsed.values.limit);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await deps.call("GET", `/agent-ops/source/log${qs}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to read source history"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const commits = (res.body.commits as Record<string, unknown>[] | undefined) ?? [];
  if (commits.length === 0) {
    success(deps.io, `(no commits${path ? ` touching ${path}` : ""})`);
    return;
  }
  const lines = commits.map((c) =>
    `${asString(c.shortHash)}  ${asString(c.date).slice(0, 10)}  ${asString(c.author)}  ${asString(c.subject)}`,
  );
  if (res.body.truncated === true) lines.push("… (truncated; pass --limit to widen)");
  success(deps.io, lines.join("\n"));
}

async function handleSourceBlame(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source blame: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const path = parsed.positional[0];
  if (!path) {
    fail(deps.io, "shipit source blame: a file path is required, e.g. shipit source blame src/server/orchestrator/index.ts.");
  }
  const res = await deps.call("GET", `/agent-ops/source/blame?path=${encodeURIComponent(path)}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to blame source file"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const lines = (res.body.lines as Record<string, unknown>[] | undefined) ?? [];
  const out = lines.map((l) =>
    `${asString(l.shortHash)}  ${asString(l.line).padStart(5)}  ${asString(l.text)}`,
  );
  if (res.body.truncated === true) out.push("… (truncated)");
  success(deps.io, out.join("\n"));
}

async function handleSourceShow(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, { booleans: { "--json": "json" } });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit source show: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const commit = parsed.positional[0];
  if (!commit) {
    fail(deps.io, "shipit source show: a commit is required, e.g. shipit source show abc123 [PATH].");
  }
  const params = new URLSearchParams({ commit });
  const path = parsed.positional[1];
  if (path) params.set("path", path);
  const res = await deps.call("GET", `/agent-ops/source/show?${params.toString()}`, undefined, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to show source commit"), 1);
  }
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(res.body)}\n`);
    deps.io.exit(0);
    return;
  }
  const content = asString(res.body.content);
  deps.io.stdout(content.endsWith("\n") ? content : `${content}\n`);
  if (res.body.truncated === true) deps.io.stderr("… (truncated; diff exceeds the source show size cap)\n");
  deps.io.exit(0);
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

const SOURCE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  status: handleSourceStatus,
  tree: handleSourceTree,
  search: handleSourceSearch,
  cat: handleSourceCat,
  log: handleSourceLog,
  blame: handleSourceBlame,
  show: handleSourceShow,
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

  if (command === "source") {
    await dispatchSource(args.slice(1), deps, io);
    return;
  }

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
 * Dispatch a `shipit source <sub>` invocation (docs/162). Read-only by
 * construction: mutating subcommands are rejected with a pointer to the
 * `--shipit-source` fix-session flow.
 */
async function dispatchSource(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_SOURCE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit source ${sub}\` — source access is read-only.\n` +
        "To change ShipIt source, spawn a fix session: shipit session create --shipit-source --prompt-file - <<'EOF' ... EOF.\n" +
        "See /shipit-docs/sessions.md.",
    );
  }
  const handler = SOURCE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit source subcommand: ${sub}\n${REJECTED_HELP}`);
  }
  await handler(args.slice(1), deps);
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
