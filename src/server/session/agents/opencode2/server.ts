// The per-turn `opencode2 serve` (docs/269-opencode-v2 plan.md, "Integration shape").
// `run --standalone` snapshots tools before its MCP servers connect, so the adapter
// starts the server itself and waits for every MCP server before sending the turn.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { McpServerStatus } from "../../../shared/types/mcp-types.js";
import type { OpencodeTokens } from "../../../shared/opencode-stream.js";

export const OPENCODE2_BIN = "opencode2";

const SERVER_READY_TIMEOUT_MS = 30_000;
const MCP_SETTLE_TIMEOUT_MS = 30_000;
const MCP_POLL_MS = 100;
// The connect publishes a tools change that a 100 ms debounce turns into a reload.
const MCP_RELOAD_GRACE_MS = 300;
const REQUEST_TIMEOUT_MS = 5_000;
const COMPACTION_TIMEOUT_MS = 300_000;
const COMPACTION_POLL_MS = 500;
const MESSAGE_PAGE_LIMIT = 100;
const MESSAGE_PAGE_MAX = 20;

const LISTENING_RE = /listening on\s+(https?:\/\/\S+)/i;
const SETTLED_MCP_STATES = new Set(["connected", "failed", "disabled", "needs_auth"]);

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
export type FetchFn = typeof fetch;

export interface Opencode2Server {
  url: string;
  authorization: string;
}

export function newServerPassword(): string {
  return randomBytes(24).toString("base64url");
}

export function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

export function spawnOpencode2Server(spawnFn: SpawnFn, cwd: string, env: Record<string, string>): ChildProcess {
  return spawnFn(OPENCODE2_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolves with the announced URL; the process may still log afterwards. */
export function waitForServerUrl(proc: ChildProcess, timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      if (err) reject(err);
      else resolve(url!);
    };
    const onData = (chunk: Buffer | string): void => {
      output += String(chunk);
      const match = LISTENING_RE.exec(output);
      if (match) finish(null, match[1].replace(/\/$/, ""));
    };
    const timer = setTimeout(() => {
      finish(new Error(`the OpenCode 2 server did not start within ${String(timeoutMs / 1000)}s${detail(output)}`));
    }, timeoutMs);
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", (err: Error) => finish(new Error(`could not start the OpenCode 2 server: ${err.message}`)));
    proc.once("exit", (code, signal) => {
      finish(new Error(`the OpenCode 2 server exited (${signal ?? `code ${String(code)}`}) before it was ready${detail(output)}`));
    });
  });
}

function detail(output: string): string {
  const trimmed = output.trim();
  return trimmed ? `: ${trimmed.slice(-300)}` : "";
}

async function request<T>(
  server: Opencode2Server,
  path: string,
  fetchFn: FetchFn,
  init: { method?: "GET" | "POST"; body?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: server.authorization, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]} returned HTTP ${String(res.status)}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

interface McpListResponse {
  data?: { name?: string; status?: { status?: string; error?: string } }[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until every configured MCP server has connected or given up. The first call
 * also boots the directory's Location, which is what connects the servers.
 */
export async function waitForMcpServers(
  server: Opencode2Server,
  cwd: string,
  expected: readonly string[],
  fetchFn: FetchFn,
  opts: { timeoutMs?: number; pollMs?: number; graceMs?: number; isCancelled?: () => boolean } = {},
): Promise<{ statuses: McpServerStatus[]; settled: boolean }> {
  const deadline = Date.now() + (opts.timeoutMs ?? MCP_SETTLE_TIMEOUT_MS);
  const query = `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
  let servers: NonNullable<McpListResponse["data"]> = [];
  let settled = false;
  while (!opts.isCancelled?.()) {
    try {
      servers = (await request<McpListResponse>(server, `/api/mcp?${query}`, fetchFn)).data ?? [];
      // A Location that has not loaded its config yet lists no servers at all.
      settled = expected.every((name) => servers.some((s) => s.name === name))
        && servers.every((s) => SETTLED_MCP_STATES.has(s.status?.status ?? ""));
    } catch {
      settled = false;
    }
    if (settled || Date.now() >= deadline) break;
    await sleep(opts.pollMs ?? MCP_POLL_MS);
  }
  if (settled && servers.length > 0) await sleep(opts.graceMs ?? MCP_RELOAD_GRACE_MS);
  const statuses = servers.map((s): McpServerStatus => {
    const state = s.status?.status;
    if (state === "connected") return { name: s.name ?? "", state: "loaded" };
    if (state === "disabled") return { name: s.name ?? "", state: "disabled" };
    return { name: s.name ?? "", state: "failed", reason: s.status?.error ?? `status: ${state ?? "unknown"}` };
  });
  return { statuses, settled };
}

interface MessageListResponse {
  data?: { type?: string; tokens?: OpencodeTokens; cost?: number }[];
  cursor?: { next?: string | null };
}

/** Every model call of the newest turn: the steps after its user message, oldest first. */
export async function readTurnSteps(
  server: Opencode2Server,
  sessionId: string,
  fetchFn: FetchFn,
): Promise<{ tokens?: OpencodeTokens; cost?: number }[]> {
  const steps: { tokens?: OpencodeTokens; cost?: number }[] = [];
  const base = `/api/session/${encodeURIComponent(sessionId)}/message`;
  let path = `${base}?order=desc&limit=${String(MESSAGE_PAGE_LIMIT)}`;
  for (let page = 0; page < MESSAGE_PAGE_MAX; page++) {
    const body = await request<MessageListResponse>(server, path, fetchFn);
    for (const message of body.data ?? []) {
      if (message.type === "user") return steps.reverse();
      if ((message.type === "assistant" || message.type === "compaction") && message.tokens) {
        steps.push({ tokens: message.tokens, ...(typeof message.cost === "number" ? { cost: message.cost } : {}) });
      }
    }
    const next = body.cursor?.next;
    if (!next) break;
    path = `${base}?limit=${String(MESSAGE_PAGE_LIMIT)}&cursor=${encodeURIComponent(next)}`;
  }
  return steps.reverse();
}

interface CompactionMessage {
  data?: { id?: string; status?: string; error?: { message?: string } };
}

export async function compactOpencode2Session(
  server: Opencode2Server,
  sessionId: string,
  model: { providerID: string; id: string },
  fetchFn: FetchFn,
  opts: { timeoutMs?: number; pollMs?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const base = `/api/session/${encodeURIComponent(sessionId)}`;
  // Compaction runs on the session's last model, which this turn's config may not declare.
  await request(server, `${base}/model`, fetchFn, { method: "POST", body: JSON.stringify({ model }) });
  const admitted = await request<CompactionMessage>(server, `${base}/compact`, fetchFn, { method: "POST", body: "{}" });
  const id = admitted.data?.id;
  if (!id) throw new Error("the server admitted no compaction");
  const deadline = Date.now() + (opts.timeoutMs ?? COMPACTION_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error("compaction was interrupted");
    await sleep(opts.pollMs ?? COMPACTION_POLL_MS);
    let message: CompactionMessage;
    try {
      message = await request<CompactionMessage>(server, `${base}/message/${encodeURIComponent(id)}`, fetchFn);
    } catch {
      continue;
    }
    if (message.data?.status === "completed") return;
    if (message.data?.status === "failed") throw new Error(message.data.error?.message ?? "compaction failed");
  }
  throw new Error(`compaction timed out after ${String((opts.timeoutMs ?? COMPACTION_TIMEOUT_MS) / 1000)}s`);
}
