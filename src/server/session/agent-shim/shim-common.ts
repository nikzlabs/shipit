
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { exitAfterFlush, shimWrite } from "./shim-exit.js";


export interface ParsedFlags {
  positional: string[];
  values: Record<string, string>;
  arrays: Record<string, string[]>;
  booleans: Set<string>;
  unsupported: string[];
}

export interface FlagSpec {
  /** Flag to output key, e.g. { "--title": "title", "-t": "title" }. */
  values?: Record<string, string>;
  arrays?: Record<string, string>;
  booleans?: Record<string, string>;
}

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


export interface ShimEnv {
  workerUrl?: string;
}

export function workerBaseUrl(env: ShimEnv = {}): string {
  if (env.workerUrl) return env.workerUrl.replace(/\/$/, "");
  const fromEnv = process.env.SHIPIT_AGENT_OPS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = process.env.WORKER_PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

function describeTransportError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === "string" ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

// fetch retains a 300s header/body timeout even without an AbortController.
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

export function isTransientStatus(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

// timeoutMs: omitted uses fetch defaults; positive bounds headers; zero is unbounded.
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


export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n…[truncated]`, truncated: true };
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

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


type JqStep =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "iterate" };

export type JqResult =
  | { ok: true; values: string[] }
  | { ok: false; kind: "unsupported" | "evaluation"; message: string };

export const JQ_SUPPORTED_FORMS = "`.`, `.field`, `.a.b`, `.[]`, `.[].field`, `.[0]`, `.field[].sub`";

const JQ_MAX_STEPS = 16;

// Accept only bounded paths; never evaluate jq code.
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

function formatJqValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

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


export interface ShimIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}

export const defaultIO: ShimIO = {
  stdout: (text) => shimWrite(process.stdout, text),
  stderr: (text) => shimWrite(process.stderr, text),
  exit: (code) => exitAfterFlush(code),
};

export function fail(io: ShimIO, message: string, code = 2): never {
  io.stderr(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(code);
  throw new Error("__shim_exit__");
}

export function success(io: ShimIO, message: string): void {
  io.stdout(message.endsWith("\n") ? message : `${message}\n`);
  io.exit(0);
}

// The handler replaces default signal behavior and must exit the process.
export function onTerminationSignal(handler: () => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) process.on(signal, handler);
  return () => {
    for (const signal of signals) process.off(signal, handler);
  };
}


// Bound empty inherited pipes, but let started input run to EOF without truncation.
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

export async function readBodyFromFileOrStdin(
  source: string,
  io: ShimIO,
  errorPrefix: string,
  noun = "body file",
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  if (source === "-" && stdin.isTTY) {
    const kind = noun.replace(/ file$/, "");
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
    throw new Error("__shim_exit__", { cause: err });
  }
}
