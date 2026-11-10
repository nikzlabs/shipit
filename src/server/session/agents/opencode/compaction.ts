// CLI 1.18.18 cannot compact through `run`; its v2 /compact route returns 503.
// Use a temporary server's /summarize route with the turn's config and credentials.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../../shared/kill-child.js";
import { SHIPIT_PROVIDER_ID } from "../../../shared/spawn-routing.js";

const SERVER_READY_TIMEOUT_MS = 30_000;

const SUMMARIZE_TIMEOUT_MS = 300_000;

// --port 0 tries 4096 first, then an ephemeral port; read the announced URL.
const LISTENING_RE = /listening on\s+(https?:\/\/\S+)/i;

export interface OpencodeCompactionOptions {
  sessionId: string;
  modelId: string;
  providerId?: "openai" | "shipit";
  cwd: string;
  env: Record<string, string>;
  spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  onLog?: (message: string) => void;
  // Expose the server immediately so an interrupt can stop compaction.
  onServerSpawned?: (proc: ChildProcess) => void;
}

export async function compactOpencodeSession(opts: OpencodeCompactionOptions): Promise<void> {
  const { sessionId, modelId, cwd, env, spawnFn, onLog, onServerSpawned } = opts;

  const proc = spawnFn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  onServerSpawned?.(proc);

  try {
    const baseUrl = await waitForServer(proc);
    onLog?.(`Compacting context via ${baseUrl}`);

    const res = await fetchWithTimeout(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/summarize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerID: opts.providerId ?? SHIPIT_PROVIDER_ID, modelID: modelId }),
      },
      SUMMARIZE_TIMEOUT_MS,
    );

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`summarize returned HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    // HTTP success alone does not confirm compaction; the body must be true.
    if (text.trim() !== "true") {
      throw new Error(`summarize did not confirm compaction (body: ${text.slice(0, 300)})`);
    }
  } finally {
    killProcessTree(proc, "SIGTERM", { label: "opencode-compaction-server" });
  }
}

/** Resolves with the announced URL; the listeners go once it settles, so a turn server's output does not pile up. */
export function waitForServer(proc: ChildProcess, name = "compaction server"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onStdout = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      const m = LISTENING_RE.exec(stdout);
      if (m) finish(null, m[1].replace(/\/$/, ""));
    };
    const onStderr = (chunk: Buffer | string): void => {
      stderr += String(chunk);
    };
    const onError = (err: Error): void => {
      finish(new Error(`could not start the ${name}: ${err.message}`));
    };
    const onExit = (code: number | null): void => {
      const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "";
      finish(new Error(`the ${name} exited (code ${String(code)}) before it was ready${detail}`));
    };

    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      if (err) reject(err);
      else resolve(url!);
    };

    const timer = setTimeout(() => {
      const detail = stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 300)})` : "";
      finish(new Error(`the ${name} did not start within ${String(SERVER_READY_TIMEOUT_MS / 1000)}s${detail}`));
    }, SERVER_READY_TIMEOUT_MS);

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`compaction timed out after ${String(timeoutMs / 1000)}s`, { cause: err });
    }
    throw err instanceof Error ? err : new Error(String(err), { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
