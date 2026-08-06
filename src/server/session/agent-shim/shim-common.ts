/**
 * Shared CLI plumbing for the `gh` and `shipit` agent shims.
 *
 * Both shims are curated, sandboxed CLIs installed inside the session worker
 * container; they don't touch the orchestrator directly but POST to the
 * worker's `/agent-ops/*` broker on localhost. The mechanics of that — flag
 * parsing, the broker HTTP call, the IO abstraction tests inject into, reading
 * a body from a file or stdin, and the small value-coercion / JSON-filter
 * helpers — are identical between the two, so they live here and are imported
 * by both `gh.ts` and `shipit.ts`.
 *
 * Shim-specific surface (help text, the rejected-subcommand allowlists, the
 * per-shim `formatError` messages, the resilient wait loop) stays in the
 * respective entry module.
 */

import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { exitAfterFlush, shimWrite } from "./shim-exit.js";

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export interface ParsedFlags {
  positional: string[];
  /** Map flag name → string value (last value wins). */
  values: Record<string, string>;
  /**
   * Repeatable value flags collected into arrays, in the order seen. e.g.
   * `--label a --label b` → `{ label: ["a", "b"] }`. Used for flags like
   * `--label` that the underlying CLI accepts more than once.
   */
  arrays: Record<string, string[]>;
  /** Boolean flags that were present. */
  booleans: Set<string>;
  /** Tracks unsupported flags so we can reject them with a helpful error. */
  unsupported: string[];
}

export interface FlagSpec {
  /** Flag → output key. e.g. { "--title": "title", "-t": "title" } */
  values?: Record<string, string>;
  /**
   * Repeatable value flags → output key. e.g. { "--label": "label", "-l": "label" }.
   * Each occurrence is appended to an array rather than overwriting.
   */
  arrays?: Record<string, string>;
  /** Boolean flags → output key. e.g. { "--json": "json" } */
  booleans?: Record<string, string>;
}

/**
 * Parse args using a flag spec. Anything not in the spec is treated as
 * positional unless it begins with `-`, in which case it's tracked as
 * "unsupported" and surfaced as an error by the caller.
 *
 * Both shims share this parser — same `--flag=value` shorthand, same
 * "missing value → unsupported" behavior — so they handle agent typos
 * symmetrically.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const valueSpec = spec.values ?? {};
  const arraySpec = spec.arrays ?? {};
  const booleanSpec = spec.booleans ?? {};
  const out: ParsedFlags = {
    positional: [],
    values: {},
    arrays: {},
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

    if (token in arraySpec) {
      const key = arraySpec[token];
      const target = (out.arrays[key] ??= []);
      if (inlineValue !== undefined) {
        target.push(inlineValue);
      } else {
        const next = args[i + 1];
        if (next === undefined) {
          out.unsupported.push(`${token} requires a value`);
        } else {
          target.push(next);
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

// ---------------------------------------------------------------------------
// Broker HTTP call
// ---------------------------------------------------------------------------

export interface ShimEnv {
  /** Worker URL. Defaults to http://127.0.0.1:9100. */
  workerUrl?: string;
}

export function workerBaseUrl(env: ShimEnv = {}): string {
  if (env.workerUrl) return env.workerUrl.replace(/\/$/, "");
  const fromEnv = process.env.SHIPIT_AGENT_OPS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.WORKER_PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

/**
 * Describe a transport error, surfacing the underlying cause code when present.
 * The global `fetch` (undici) collapses every low-level failure into the opaque
 * `TypeError: fetch failed`; the real signal (connection refused, reset, or a
 * client-side header/body timeout) lives on `err.cause.code`. Exposing it turns
 * an unactionable "fetch failed" into "fetch failed (UND_ERR_HEADERS_TIMEOUT)".
 */
function describeTransportError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === "string" ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * Unbounded JSON request over Node's `http`/`https` — no response timeout at
 * all. Used for the long-lived `shipit agent run` spawn leg, which legitimately
 * runs up to the sub-agent wall-clock cap (tens of minutes). The global `fetch`
 * (undici) imposes a default 300s `headersTimeout`/`bodyTimeout` that an
 * AbortController-free call CANNOT disable, so a multi-minute consult aborts
 * with the opaque "fetch failed" even though the run is still in flight. Node's
 * `http` has no default response timeout, so it honors the unbounded contract.
 * Resolves with the parsed JSON + status; rejects on a genuine transport error.
 */
function requestJsonUnbounded(
  method: string,
  url: string,
  payload: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = {}; }
          resolve({
            status: res.statusCode ?? 0,
            body: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Send a request to the worker's /agent-ops broker.
 * Returns parsed JSON and HTTP status. Network errors are surfaced as
 * status: 0 with an error body so the caller can format a helpful message.
 *
 * `timeoutMs` selects the transport:
 * - omitted (the `gh` shim and most `shipit` paths) → plain `fetch`.
 * - positive (docs/182, the `shipit` wait loop) → `fetch` with an
 *   AbortController per-segment timeout so a black-holed (half-open) socket
 *   fails fast instead of hanging until an OS-level timeout. A timed-out
 *   request surfaces as `status: 0`, which the loop retries with backoff.
 * - `0` → an explicitly UNBOUNDED request (the `shipit agent run` spawn). Routed
 *   over Node's `http` rather than `fetch`, because undici's default 300s
 *   `headersTimeout` would otherwise abort a multi-minute sub-agent consult with
 *   the opaque "fetch failed" — misread as an unreachable worker.
 */
/**
 * Statuses a resilient wait loop must treat as "the transport hiccuped, retry"
 * rather than as an outcome: 0 is the shim's own unreachable/aborted marker,
 * and 502/503/504 are a proxy or a restarting orchestrator. Shared by
 * `shipit session wait` (docs/182) and `shipit agent result --wait` (docs/248)
 * so the two loops cannot drift apart on what counts as transient.
 */
export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

export async function callBroker(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  env: ShimEnv,
  timeoutMs?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${workerBaseUrl(env)}${path}`;
  const payload = body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined;

  if (timeoutMs === 0) {
    try {
      return await requestJsonUnbounded(method, url, payload);
    } catch (err) {
      return {
        status: 0,
        body: { error: `Could not reach the ShipIt session worker at ${url}: ${describeTransportError(err)}` },
      };
    }
  }

  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (payload !== undefined) {
    init.body = payload;
  }
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  timer?.unref?.();
  if (controller) init.signal = controller.signal;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      status: 0,
      body: {
        error: `Could not reach the ShipIt session worker at ${url}: ${describeTransportError(err)}`,
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

// ---------------------------------------------------------------------------
// Value / output helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an unknown value to a printable string. Strings and numbers pass
 * through; everything else (null, undefined, objects) becomes the empty
 * string so we never write `[object Object]` or `null` into agent output.
 */
export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Project an object down to a whitelist of `--json FIELDS`. Used by
 * `gh pr view --json …` and `gh pr list --json …`. An empty/absent field list
 * returns the object unchanged.
 */
export function filterJson(
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
// `-q` / `--jq` — a deliberately tiny jq subset over an already-filtered payload
// ---------------------------------------------------------------------------

/**
 * One step of a supported jq path expression.
 *
 * Deliberately closed: field access, array index, array/object iteration. There
 * is no pipe, no filter, no function call, no arithmetic — see `applyJq`.
 */
type JqStep =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "iterate" };

export type JqResult =
  | { ok: true; values: string[] }
  /**
   * `unsupported` — the expression is outside the implemented subset (a parse
   * refusal, reported before any data is touched). `evaluation` — the
   * expression is supported but doesn't fit the data (jq's own error class).
   * Callers map the two onto distinct exit codes so a caller that swallows
   * stderr can still tell them apart.
   */
  | { ok: false; kind: "unsupported" | "evaluation"; message: string };

/** Human-readable list of what `applyJq` accepts, for error messages. */
export const JQ_SUPPORTED_FORMS = "`.`, `.field`, `.a.b`, `.[]`, `.[].field`, `.[0]`, `.field[].sub`";

/** Bound on path depth — a shim payload is a flat PR/run record, not a tree. */
const JQ_MAX_STEPS = 16;

/**
 * Parse a simple-path jq expression into steps, or `null` if it uses anything
 * outside the supported subset.
 *
 * The parser is the security boundary: it accepts ONLY `.`, identifiers,
 * `[<digits>]` and `[]`, so nothing that reaches `applyJq` can express a
 * computation, reach outside the value it is handed, or run unbounded. Anything
 * else — a pipe, `select(...)`, string literals, `..`, `@base64` — is rejected
 * here rather than partially interpreted.
 */
function parseJqPath(expr: string): JqStep[] | null {
  const src = expr.trim();
  if (!src.startsWith(".")) return null;
  if (src === ".") return [];

  const steps: JqStep[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ".") {
      i++;
      // `.[]` / `.[0]` — the bracket is consumed by the next iteration.
      if (src[i] === "[") continue;
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (!m) return null;
      steps.push({ kind: "field", name: m[0] });
      i += m[0].length;
    } else if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end === -1) return null;
      const inner = src.slice(i + 1, end);
      if (inner === "") steps.push({ kind: "iterate" });
      else if (/^\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else return null;
      i = end + 1;
    } else {
      return null;
    }
    if (steps.length > JQ_MAX_STEPS) return null;
  }
  return steps;
}

function jqTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

/**
 * Render one jq output value the way `jq -r` (which is what `gh -q` uses) does:
 * strings raw and unquoted, scalars stringified, `null` as `null`, and
 * containers as compact JSON.
 */
function formatJqValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Evaluate a simple-path jq expression against an already-filtered JSON payload
 * (docs: `gh … --json FIELDS -q EXPR`).
 *
 * This is NOT a jq implementation and must not become one — it exists so that
 * the idiomatic `gh pr view --json state -q .state` works instead of failing as
 * an unsupported flag. It walks a fixed list of path steps over the value it is
 * handed; it has no access to anything else, evaluates no user-supplied code,
 * and cannot loop. Expressions beyond the subset are refused explicitly
 * (`kind: "unsupported"`) rather than silently returning nothing.
 */
export function applyJq(value: unknown, expr: string): JqResult {
  const steps = parseJqPath(expr);
  if (!steps) {
    return {
      ok: false,
      kind: "unsupported",
      message: `unsupported jq expression: ${expr}`,
    };
  }

  let current: unknown[] = [value];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const v of current) {
      if (step.kind === "field") {
        if (v === null || v === undefined) { next.push(null); continue; }
        if (Array.isArray(v) || typeof v !== "object") {
          return { ok: false, kind: "evaluation", message: `cannot index ${jqTypeName(v)} with "${step.name}"` };
        }
        next.push((v as Record<string, unknown>)[step.name] ?? null);
      } else if (step.kind === "index") {
        if (v === null || v === undefined) { next.push(null); continue; }
        if (!Array.isArray(v)) {
          return { ok: false, kind: "evaluation", message: `cannot index ${jqTypeName(v)} with number` };
        }
        next.push((v as unknown[])[step.index] ?? null);
      } else {
        if (Array.isArray(v)) { next.push(...(v as unknown[])); continue; }
        if (v !== null && v !== undefined && typeof v === "object") {
          next.push(...Object.values(v as Record<string, unknown>));
          continue;
        }
        return { ok: false, kind: "evaluation", message: `cannot iterate over ${jqTypeName(v)}` };
      }
    }
    current = next;
  }
  return { ok: true, values: current.map(formatJqValue) };
}

/**
 * Normalize repeated `--label`/`-l` occurrences into a flat, de-duped string
 * array. Matches real gh semantics: `--label a --label b` and `--label a,b`
 * both yield `["a", "b"]`. Whitespace is trimmed and empty entries dropped.
 * Shared so the two shims handle `--label` the same way (SHI-92).
 */
export function normalizeLabels(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const label = part.trim();
      if (label && !out.includes(label)) out.push(label);
    }
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

/**
 * The real process IO. Writes go through `shimWrite` and the exit through
 * `exitAfterFlush` so a large document piped to `jq`/`head`/`$(…)` is not
 * silently truncated at the 64 KiB pipe buffer — see `shim-exit.ts`.
 */
export const defaultIO: ShimIO = {
  stdout: (text) => shimWrite(process.stdout, text),
  stderr: (text) => shimWrite(process.stderr, text),
  exit: (code) => exitAfterFlush(code),
};

export function fail(io: ShimIO, message: string, code = 2): never {
  io.stderr(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(code);
  throw new Error("__shim_exit__"); // unreachable in practice; thrown so TS narrows
}

export function success(io: ShimIO, message: string): void {
  io.stdout(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(0);
}

/**
 * Run `handler` if the shim is asked to terminate while a long call is in
 * flight, and return a release function to call once it isn't (SHI-245).
 *
 * Node's default SIGTERM behavior is to die with no output, which is precisely
 * wrong for a command whose work continues on the server after the process is
 * gone: the caller is left with nothing, and nothing that says there is
 * anything to go back for. Installing a listener replaces that default, so the
 * handler is responsible for exiting.
 */
export function onTerminationSignal(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}

// ---------------------------------------------------------------------------
// Body-from-file/stdin resolution
// ---------------------------------------------------------------------------

/**
 * Read all of stdin to a string.
 *
 * `stdin` is injectable so unit tests can feed a fake stream without touching
 * the real `process.stdin`. The `idleTimeoutMs` backstop guards the
 * "non-TTY-but-never-EOF" case — an inherited open pipe with no writer that
 * delivers zero bytes and never reaches EOF, which would otherwise hang the
 * async read forever (the production hang behind this fix). The timer fires
 * ONLY while nothing has arrived yet; once any byte is seen we assume a real
 * producer and wait for natural EOF, so a legitimately slow/large heredoc is
 * never truncated. The TTY check in `readBodyFromFileOrStdin` is the primary,
 * fast-failing guard; this is belt-and-suspenders.
 */
export async function readStdin(
  stdin: NodeJS.ReadStream = process.stdin,
  idleTimeoutMs = 15_000,
): Promise<string> {
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let out = "";
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (out.length === 0) {
        cleanup();
        reject(new Error("no input received on stdin"));
      }
    }, idleTimeoutMs);
    timer.unref?.();
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onErr);
    };
    const onData = (chunk: string | Buffer) => {
      out += typeof chunk === "string" ? chunk : String(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(out);
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onErr);
  });
}

/**
 * Read a body/prompt from a file path, or from stdin when the path is `-`.
 *
 * When the source is `-` but there is no piped stdin (it's a TTY, so nothing
 * will ever be written), fail fast with actionable guidance instead of hanging
 * on a read that never completes — the production bug this fix targets. The
 * message is derived from `noun` ("body file" → "body"/`--body-file`,
 * "prompt file" → "prompt"/`--prompt-file`) so it reads correctly for every
 * caller (`gh ... --body-file -`, `shipit issue/session/agent ... -file -`).
 *
 * On a read error, fails the command with `<errorPrefix>: could not read
 * <noun> <source>: <message>` (matching each shim's existing wording via the
 * `errorPrefix`/`noun` parameters) and never returns.
 *
 * `stdin` is injectable for tests; real callers use the default `process.stdin`.
 */
export async function readBodyFromFileOrStdin(
  source: string,
  io: ShimIO,
  errorPrefix: string,
  noun = "body file",
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  if (source === "-" && stdin.isTTY) {
    const kind = noun.replace(/ file$/, ""); // "body file" → "body", "prompt file" → "prompt"
    fail(
      io,
      `${errorPrefix}: no ${kind} on stdin — pass a file path instead of '-', or pipe the ${kind} via a single-quoted heredoc (… --${kind}-file - <<'EOF' … EOF).`,
    );
  }
  try {
    return source === "-" ? await readStdin(stdin) : await fsp.readFile(source, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(io, `${errorPrefix}: could not read ${noun} ${source}: ${message}`);
    throw new Error("__shim_exit__", { cause: err }); // unreachable; fail() exits.
  }
}
