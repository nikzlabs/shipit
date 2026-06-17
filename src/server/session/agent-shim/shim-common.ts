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
 * Send a request to the worker's /agent-ops broker.
 * Returns parsed JSON and HTTP status. Network errors are surfaced as
 * status: 0 with an error body so the caller can format a helpful message.
 *
 * `timeoutMs` (docs/182) is an optional AbortController-based per-request
 * timeout so a black-holed (half-open) socket on the shim→worker leg fails
 * fast instead of hanging until an OS-level timeout. The `shipit` wait loop
 * passes one per segment; a timed-out request surfaces as `status: 0`, which
 * the loop classifies as transient and retries with backoff. When omitted (the
 * `gh` shim and most `shipit` paths) there is no abort signal at all, so the
 * behavior is identical to a plain `fetch`.
 */
export async function callBroker(
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

export const defaultIO: ShimIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
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
