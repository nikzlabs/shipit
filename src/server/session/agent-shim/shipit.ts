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
import { parseIssueRef } from "../../shared/issue-ref.js";

const SHIM_NAME = "shipit (ShipIt)";

const REJECTED_HELP = `${SHIM_NAME} only supports a curated subset of session-management operations.
See /shipit-docs/sessions.md for the full list.`;

const HELP = `${SHIM_NAME} — agent-driven session management.

Supported subcommands:
  shipit session create  --prompt-file FILE --title T
                          [--base REF] [--agent claude|codex] [--model M]
                          [--turn ID] [--shipit-source] [--approximate] [--json]
  shipit session list    [--turn ID] [--json]
  shipit session view    <id> [--json]
  shipit session message <id> -m "TEXT" [--json]
  shipit session wait    <id...> [--timeout SECONDS] [--any|--all] [--json]
  shipit session archive <id> [--json]
  shipit session help

Issues (tracker-neutral — tracker inferred from the pointer; docs/175 + docs/177):
  shipit issue view      <pointer> [--tracker github|linear] [--json]
  shipit issue list      [--tracker github|linear] [--state open|closed|all] [--json]
  shipit issue comment   <pointer> -b BODY | --body-file FILE [--tracker T] [--json]
  shipit issue edit      <pointer> [--title T] [--body B | --body-file FILE] [--tracker T] [--json]
  shipit issue status    <pointer> <state> [--tracker T] [--json]
  shipit issue assign    <pointer> <user|me | --none> [--tracker T] [--json]

  A <pointer> is whatever the user/doc gave you — SHI-28, owner/repo#42, or an
  issue URL; the tracker is inferred from its shape. Writes are do-then-surface:
  the change is made immediately and an inline provenance card with an Undo
  button is posted in the chat. Creating issues is NOT supported (human-gated).

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

\`--title\` is REQUIRED: you are naming the session, so give it a short,
human-readable name describing what it's for. It appears in the sidebar.

Use \`shipit session create\` when the user explicitly asked for a separate
session / parallel branch / independent workspace. For in-turn fan-out
under Claude, prefer the built-in \`Task\` tool.

In an Ops session, use \`shipit source *\` to read the ShipIt source code that
runs this host, then \`shipit session create --shipit-source --title "..."\` to
spawn a repo-backed fix session branched from the exact inspected commit.
With \`--shipit-source\` the diagnosis is wrapped in an incident packet and
can't name the session, so the \`--title\` describes what the fix is for.

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
  timeoutMs?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${workerBaseUrl(env)}${path}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined && method !== "GET") {
    init.body = JSON.stringify(body);
  }
  // docs/182 — an AbortController-based per-request timeout so a black-holed
  // (half-open) socket on the shim→worker leg fails fast instead of hanging
  // until an OS-level timeout. The wait loop passes one per segment; a timed-out
  // request surfaces as `status: 0`, which the loop classifies as transient and
  // retries with backoff — never as a terminal outcome.
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  timer?.unref?.();
  if (controller) init.signal = controller.signal;
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
  } finally {
    if (timer) clearTimeout(timer);
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
  /** Sleep helper (injectable for deterministic backoff tests). */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic clock (injectable so deadline-driven loops are testable). */
  now: () => number;
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
 * docs/182 — resilient-wait tuning. The shim owns the overall deadline and
 * drives a segment loop beneath it, so each network leg is short and a reset
 * costs one retried segment rather than the whole wait.
 */
const WAIT_DEFAULT_OVERALL_SECS = 5 * 60; // matches the server's old default
const WAIT_SEGMENT_SECS = 25; // bounded server segment (keepalive-friendly)
const WAIT_INITIAL_BACKOFF_MS = 500;
const WAIT_MAX_BACKOFF_MS = 8_000;
/** Per-request abort budget: one segment plus margin for the server's resolve. */
const WAIT_REQUEST_MARGIN_MS = 10_000;

/** Exit codes for `shipit session wait` (docs/182 distinguishable outcomes). */
const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_TIMED_OUT = 1;
const WAIT_EXIT_ERROR = 3;

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
  // A title is REQUIRED for every spawn: the spawning agent already knows what
  // the session is for and is the best-placed namer, so it must name the
  // session explicitly rather than leaning on an AI naming round-trip. Fail
  // fast here with a clear message; the orchestrator (`spawnChildSession`)
  // enforces this authoritatively too. The `--shipit-source` path gets a
  // fix-specific message because its diagnosis is wrapped in a verbose incident
  // packet (docs/162) and can never double as the session name.
  if (!(parsed.values.title ?? "").trim()) {
    fail(
      deps.io,
      parsed.booleans.has("shipitSource")
        ? "shipit session create --shipit-source requires --title: give the fix session a short, " +
            "human-readable name describing what it fixes."
        : "shipit session create requires --title: give the session a short, " +
            "human-readable name describing what it's for.",
    );
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

/** A terminal or transport classification of one child's wait. */
type WaitTerminal =
  | "idle"
  | "error"
  | "archived"
  | "timed-out"
  | "not-found"
  | "http-error";

interface SingleWaitResult {
  id: string;
  outcome: WaitTerminal;
  child: Record<string, unknown> | null;
  /** The last server response body (for `--json` passthrough). */
  body: Record<string, unknown>;
  /** Set when transport errors were swallowed during the wait. */
  lastTransportError?: string;
  /** Human message for not-found / http-error outcomes. */
  errorMessage?: string;
}

/** Transient (retry) vs terminal HTTP/transport statuses. */
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/**
 * Map a server wait response to a normalized outcome. New servers send an
 * explicit `outcome`; legacy responses are derived from `idle` / `timedOut`.
 * An unrecognized 2xx is treated as `pending` so the loop keeps polling
 * (bounded by the overall deadline) rather than returning a wrong terminal.
 */
function normalizeServerOutcome(
  body: Record<string, unknown>,
): "idle" | "error" | "archived" | "pending" | "timed-out" {
  const o = body.outcome;
  if (o === "idle" || o === "error" || o === "archived" || o === "pending" || o === "timed-out") {
    return o;
  }
  if (body.timedOut === true) return "timed-out";
  if (body.idle === true) return "idle";
  return "pending";
}

/**
 * docs/182 — wait on a single child with a resumable segment loop. Each
 * iteration issues a bounded server segment; on `pending` it re-issues, and on
 * a transient transport failure it backs off and retries — all beneath the
 * overall `deadline`. Only a genuine terminal condition (idle / error /
 * archived) or the deadline (`timed-out`) ends the loop. Never throws.
 */
async function waitForChildOnce(
  id: string,
  deadline: number,
  deps: RunDeps,
): Promise<SingleWaitResult> {
  let backoff = WAIT_INITIAL_BACKOFF_MS;
  let lastTransportError: string | undefined;
  let lastBody: Record<string, unknown> = {};

  while (deps.now() < deadline) {
    const remainingMs = deadline - deps.now();
    const segSecs = Math.max(1, Math.min(WAIT_SEGMENT_SECS, Math.ceil(remainingMs / 1000)));
    const overallSecs = Math.max(1, Math.ceil(remainingMs / 1000));
    const path =
      `/agent-ops/session/wait/${encodeURIComponent(id)}` +
      `?timeout=${overallSecs}&segment=${segSecs}`;
    const res = await deps.call(
      "GET",
      path,
      undefined,
      deps.env,
      segSecs * 1000 + WAIT_REQUEST_MARGIN_MS,
    );

    if (res.status === 404) {
      return {
        id,
        outcome: "not-found",
        child: null,
        body: res.body,
        errorMessage: "Spawned session not found, or not a descendant of this parent.",
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }
    if (isTransientStatus(res.status)) {
      // Transport failure is NEVER an outcome — swallow and retry with backoff.
      lastTransportError = formatError(res, "transport error reaching the ShipIt orchestrator");
      const sleepMs = Math.min(backoff, Math.max(0, deadline - deps.now()));
      if (sleepMs <= 0) break;
      await deps.sleep(sleepMs);
      backoff = Math.min(backoff * 2, WAIT_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        id,
        outcome: "http-error",
        child: null,
        body: res.body,
        errorMessage: formatError(res, "Failed to wait on spawned session"),
        ...(lastTransportError ? { lastTransportError } : {}),
      };
    }

    // 2xx — reset backoff and act on the outcome.
    backoff = WAIT_INITIAL_BACKOFF_MS;
    lastBody = res.body;
    const outcome = normalizeServerOutcome(res.body);
    if (outcome === "pending") continue;
    if (outcome === "timed-out") break; // legacy server timed out; honor the deadline below
    return {
      id,
      outcome,
      child: (res.body.child as Record<string, unknown> | null) ?? null,
      body: res.body,
      ...(lastTransportError ? { lastTransportError } : {}),
    };
  }

  // Overall deadline exhausted (or a legacy server reported timed-out).
  return {
    id,
    outcome: "timed-out",
    child: (lastBody.child as Record<string, unknown> | null) ?? null,
    body: lastBody,
    ...(lastTransportError ? { lastTransportError } : {}),
  };
}

/** Map a single wait outcome to its process exit code. */
function exitCodeForWait(outcome: WaitTerminal): number {
  switch (outcome) {
    case "idle":
    case "archived":
      return WAIT_EXIT_IDLE;
    case "error":
      return WAIT_EXIT_ERROR;
    case "timed-out":
      return WAIT_EXIT_TIMED_OUT;
    default:
      return 1; // not-found / http-error
  }
}

/**
 * `shipit session wait <id...> [--timeout SECONDS] [--any|--all] [--json]`.
 *
 * docs/182 — resilient, level-triggered, resumable wait with distinguishable
 * outcomes. A single call is the robust unit: the shim owns the overall deadline
 * and absorbs transport resets beneath it, so a parent agent never has to script
 * its own retry loop. Multiple ids fan out over the same resilient single-wait
 * with one shared deadline (`--any` = first finisher, `--all` = every child).
 */
async function handleSessionWait(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--timeout": "timeout", "-T": "timeout" },
    booleans: { "--json": "json", "--any": "any", "--all": "all" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit session wait: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const ids = parsed.positional;
  if (ids.length === 0) {
    fail(deps.io, "shipit session wait: child session id is required.");
  }
  if (parsed.booleans.has("any") && parsed.booleans.has("all")) {
    fail(deps.io, "shipit session wait: --any and --all are mutually exclusive.");
  }

  // Defense-in-depth client-side validation. The orchestrator also enforces.
  let overallSecs = WAIT_DEFAULT_OVERALL_SECS;
  if (parsed.values.timeout) {
    const n = Number(parsed.values.timeout);
    if (!Number.isFinite(n) || n <= 0) {
      fail(deps.io, "shipit session wait: --timeout must be a positive number of seconds.");
    }
    overallSecs = Math.min(Math.floor(n), MAX_WAIT_TIMEOUT_SECS);
  }

  const json = parsed.booleans.has("json");
  const deadline = deps.now() + overallSecs * 1000;

  // Single id — the common case. Preserve the legacy text/JSON shape.
  if (ids.length === 1) {
    const result = await waitForChildOnce(ids[0], deadline, deps);
    renderSingleWait(result, deps, json);
    return;
  }

  // Multi id (docs/182 §F) — fan out over the resilient single-wait, sharing
  // one overall deadline so `--timeout` bounds the whole call, not each child.
  const mode: "any" | "all" = parsed.booleans.has("any") ? "any" : "all";
  if (mode === "any") {
    const winner = await waitAnyChild(ids, deadline, deps);
    renderMultiWait([winner], ids, mode, deps, json);
    return;
  }
  const results = await Promise.all(ids.map((id) => waitForChildOnce(id, deadline, deps)));
  renderMultiWait(results, ids, mode, deps, json);
}

/**
 * `--any` — resolve as soon as the first listed child reaches a terminal
 * (non-timed-out) outcome; if none do before the shared deadline, resolve with
 * the first (timed-out) result. Returns the winner so the parent can act on it
 * and wait on the rest.
 */
function waitAnyChild(ids: string[], deadline: number, deps: RunDeps): Promise<SingleWaitResult> {
  return new Promise<SingleWaitResult>((resolve) => {
    let done = false;
    const tasks = ids.map(async (id) => {
      const r = await waitForChildOnce(id, deadline, deps);
      if (!done && r.outcome !== "timed-out") {
        done = true;
        resolve(r);
      }
      return r;
    });
    void (async () => {
      const all = await Promise.all(tasks);
      if (done) return;
      done = true;
      resolve(all[0]);
    })();
  });
}

/** Render a single-child wait result (text or JSON) and exit. */
function renderSingleWait(result: SingleWaitResult, deps: RunDeps, json: boolean): void {
  if (result.outcome === "not-found") {
    fail(deps.io, result.errorMessage ?? "Spawned session not found.", 1);
  }
  if (result.outcome === "http-error") {
    fail(deps.io, result.errorMessage ?? "Failed to wait on spawned session.", 1);
  }

  if (json) {
    const out = {
      ...result.body,
      outcome: result.outcome,
      ...(result.lastTransportError ? { lastTransportError: result.lastTransportError } : {}),
    };
    deps.io.stdout(`${JSON.stringify(out)}\n`);
    deps.io.exit(exitCodeForWait(result.outcome));
    return;
  }

  const child = result.child;
  const idle = result.outcome === "idle" || result.outcome === "archived";
  const timedOut = result.outcome === "timed-out";
  const lines = [
    `${asString(child?.title)} (${asString(child?.id)})`,
    `status:     ${asString(child?.status) || "idle"}`,
    `branch:     ${asString(child?.branch) || "(no branch)"}`,
    `queue:      ${asString(child?.queueLength) || "0"}`,
    `outcome:    ${result.outcome}`,
    `idle:       ${idle}`,
    `timed-out:  ${timedOut}`,
  ];
  if (result.lastTransportError) {
    lines.push(`note:       transport retried (${result.lastTransportError})`);
  }
  if (child?.latestAssistantMessage) {
    lines.push("", asString(child.latestAssistantMessage));
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
  deps.io.exit(exitCodeForWait(result.outcome));
}

/**
 * Aggregate exit code for a multi-child wait: any reaching error (3) takes
 * precedence, then any not-found/http-error/timed-out (1), else idle (0).
 */
function aggregateExitCode(results: SingleWaitResult[]): number {
  if (results.some((r) => r.outcome === "error")) return WAIT_EXIT_ERROR;
  if (results.some((r) => exitCodeForWait(r.outcome) !== WAIT_EXIT_IDLE)) return WAIT_EXIT_TIMED_OUT;
  return WAIT_EXIT_IDLE;
}

/** Render a multi-child wait (`--any` winner, or `--all` results) and exit. */
function renderMultiWait(
  results: SingleWaitResult[],
  ids: string[],
  mode: "any" | "all",
  deps: RunDeps,
  json: boolean,
): void {
  const exit = mode === "any" ? exitCodeForWait(results[0].outcome) : aggregateExitCode(results);

  if (json) {
    const out = {
      mode,
      ids,
      results: results.map((r) => ({
        id: r.id,
        outcome: r.outcome,
        child: r.child,
        ...(r.lastTransportError ? { lastTransportError: r.lastTransportError } : {}),
      })),
    };
    deps.io.stdout(`${JSON.stringify(out)}\n`);
    deps.io.exit(exit);
    return;
  }

  const lines: string[] = [];
  if (mode === "any") {
    const w = results[0];
    lines.push(`first-finished: ${w.id}`);
    lines.push(`outcome:        ${w.outcome}`);
    const remaining = ids.filter((id) => id !== w.id);
    if (remaining.length > 0) {
      lines.push(`still-waiting:   ${remaining.join(", ")}`);
    }
  } else {
    for (const r of results) {
      lines.push(`${r.id}\t${r.outcome}`);
    }
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
  deps.io.exit(exit);
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
// Tracker-neutral issue access (docs/175 read + docs/177 write)
//
// `shipit issue` is the ONE issue interface, identical across GitHub and Linear
// (the tracker is inferred from the pointer shape via the shared parseIssueRef).
// Read = view/list; write = comment/edit/status/assign. Issue CREATION stays
// human-gated (docs/164) and is rejected here, like `shipit session delete`.
// ---------------------------------------------------------------------------

const REJECTED_ISSUE_SUBCOMMANDS = new Set([
  "create", // human-gated via the bug-filing review card (docs/164); never agent-driven.
  "new",    // alias the agent might reach for — same gate.
  "delete", // destructive; not part of the agent's surface.
  "close",  // use `shipit issue status <pointer> closed` instead.
]);

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
    try {
      return values.bodyFile === "-" ? await readStdin() : await fsp.readFile(values.bodyFile, "utf8");
    } catch (err) {
      fail(deps.io, `shipit issue: could not read body file ${values.bodyFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return undefined;
}

const VALID_TRACKERS = new Set(["github", "linear"]);

async function handleIssueView(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--tracker": "tracker" },
    booleans: { "--json": "json" },
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
  if (parsed.booleans.has("json")) {
    deps.io.stdout(`${JSON.stringify(issue)}\n`);
    deps.io.exit(0);
    return;
  }
  success(deps.io, renderIssue(issue));
}

async function handleIssueList(args: string[], deps: RunDeps): Promise<void> {
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
  const lines = issues.map((i) =>
    [asString(i.identifier), priorityLabel(i), asString(i.title)].join("\t"),
  );
  success(deps.io, lines.join("\n"));
}

/** Render a single `TrackerIssue` as a stable human-readable block. */
function renderIssue(issue: Record<string, unknown>): string {
  const status = issue.status as Record<string, unknown> | undefined;
  const assignee = issue.assignee as Record<string, unknown> | undefined;
  const lines = [
    `${asString(issue.identifier)}  ${asString(issue.title)}`,
    `status:    ${status ? asString(status.name) : "(unknown)"}`,
    `priority:  ${priorityLabel(issue)}`,
  ];
  if (assignee && asString(assignee.name)) lines.push(`assignee:  ${asString(assignee.name)}`);
  if (issue.url) lines.push(`url:       ${asString(issue.url)}`);
  const available = issue.availableStatuses as { name?: string }[] | undefined;
  if (available && available.length > 0) {
    lines.push(`statuses:  ${available.map((s) => s.name).filter(Boolean).join(", ")}`);
  }
  const description = asString(issue.description);
  if (description.trim()) lines.push("", description);
  return lines.join("\n");
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
  const lines = [
    `done:       ${asString(res.body.summary) || "ok"}`,
    "A provenance card with an Undo button has been posted in the chat.",
  ];
  if (res.body.url) lines.push(`url:        ${asString(res.body.url)}`);
  success(deps.io, lines.join("\n"));
}

async function handleIssueComment(args: string[], deps: RunDeps): Promise<void> {
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

async function handleIssueEdit(args: string[], deps: RunDeps): Promise<void> {
  const parsed = parseFlags(args, {
    values: { "--title": "title", "-b": "body", "--body": "body", "--body-file": "bodyFile", "--tracker": "tracker" },
    booleans: { "--json": "json" },
  });
  if (parsed.unsupported.length > 0) {
    fail(deps.io, `Unsupported flag for shipit issue edit: ${parsed.unsupported[0]}\n${REJECTED_HELP}`);
  }
  const { tracker, id } = resolveIssuePointer(deps.io, parsed.positional[0], parsed.values.tracker);
  const body = await readIssueBody(parsed.values, deps);
  const title = parsed.values.title;
  if (title === undefined && body === undefined) {
    fail(deps.io, "shipit issue edit: at least one of --title or --body/--body-file is required.");
  }
  const payload: Record<string, unknown> = { tracker, id };
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  const res = await deps.call("POST", "/agent-ops/issue/edit", payload, deps.env);
  if (res.status < 200 || res.status >= 300) {
    fail(deps.io, formatError(res, "Failed to edit issue"), 1);
  }
  reportWrite(res, deps, parsed.booleans.has("json"));
}

async function handleIssueStatus(args: string[], deps: RunDeps): Promise<void> {
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

async function handleIssueAssign(args: string[], deps: RunDeps): Promise<void> {
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

const ISSUE_HANDLERS: Record<
  string,
  (args: string[], deps: RunDeps) => Promise<void>
> = {
  view: handleIssueView,
  list: handleIssueList,
  comment: handleIssueComment,
  edit: handleIssueEdit,
  status: handleIssueStatus,
  assign: handleIssueAssign,
};

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
  timing?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<void> {
  const deps: RunDeps = {
    env,
    io,
    call,
    sleep: timing?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: timing?.now ?? (() => Date.now()),
  };

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

  if (command === "issue") {
    await dispatchIssue(args.slice(1), deps, io);
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
 * Dispatch a `shipit issue <sub>` invocation (docs/175 read + docs/177 write).
 * Issue creation is rejected with a pointer to the human-gated bug-filing flow;
 * everything else maps to a read (view/list) or a do-then-surface write.
 */
async function dispatchIssue(args: string[], deps: RunDeps, io: ShimIO): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    success(io, HELP);
    return;
  }
  if (REJECTED_ISSUE_SUBCOMMANDS.has(sub)) {
    fail(
      io,
      `${SHIM_NAME} does not support \`shipit issue ${sub}\`. ` +
        "Creating/closing/deleting issues is not an agent action — filing a new issue is human-gated " +
        "via the bug-report review card. Use `shipit issue status <pointer> completed` to mark work done.\n" +
        "See /shipit-docs/issues.md.",
    );
  }
  const handler = ISSUE_HANDLERS[sub];
  if (!handler) {
    fail(io, `Unsupported shipit issue subcommand: ${sub}\n${REJECTED_HELP}`);
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
