/**
 * docs/276 — OpenCode's on-demand context compaction.
 *
 * **The trigger is not on `opencode run`.** Two `run`-shaped triggers were
 * probed at CLI 1.18.18 and both fail, with negative controls:
 *
 *  - `/compact` as the prompt is an ORDINARY prompt. It reaches the model
 *    verbatim and burns a turn — the exact opposite of Claude, where the same
 *    string is intercepted.
 *  - `--command compact` fails identically to `--command __definitely_bogus__`
 *    (the same `UnknownError` thrown at `SessionPrompt.command`). `--command`
 *    resolves REGISTERED commands only and `compact` is not one; `--command
 *    init` IS registered and succeeds, which is the control proving the flag
 *    itself works.
 *
 * What DOES work is the server's documented `POST /session/{id}/summarize`
 * (opencode.ai/docs/server → "Summarize the session"). So compaction here is a
 * short-lived `opencode serve` spawned against the SAME config and env as an
 * ordinary turn, one HTTP call, and a kill. That is the same shape as Claude's
 * no-resident-process fallback — a fresh process whose whole job is to
 * compact — differing only in that the request travels over HTTP instead of
 * argv.
 *
 * Do NOT reach for the v2 route `POST /api/session/{id}/compact`. It is in the
 * OpenAPI document, which makes it look like the obvious modern choice, and it
 * returns `503 ServiceUnavailableError: "Session compact is not available yet"`
 * — declared, not implemented. Re-probe before switching; when it lands it is
 * the better route (no provider/model in the body).
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../../shared/kill-child.js";
import { SHIPIT_PROVIDER_ID } from "../../../shared/spawn-routing.js";

/** How long to wait for the transient server to announce its port. */
const SERVER_READY_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the summarize call itself. Compaction is a full model
 * round-trip over the whole transcript, so this is generous — but bounded, or a
 * hung server would hold the turn open forever.
 */
const SUMMARIZE_TIMEOUT_MS = 300_000;

/**
 * Matches the readiness line the CLI prints on stdout, e.g.
 * `opencode server listening on http://127.0.0.1:4096`.
 *
 * The PORT MUST be parsed rather than assumed. `--port 0` documents itself as
 * "random" but actually resolves to OpenCode's fixed default 4096; it falls
 * back to a real ephemeral port ONLY when 4096 is already taken (verified — a
 * second concurrent server came up on 34439). Both are normal outcomes here, so
 * the announced URL is the only thing that can be trusted.
 */
const LISTENING_RE = /listening on\s+(https?:\/\/\S+)/i;

export interface OpencodeCompactionOptions {
  /** The OpenCode session to compact. */
  sessionId: string;
  /**
   * The model the summarization itself runs on. Required by the route: a
   * summarize with no `providerID` is rejected `400 Missing key ["providerID"]`.
   */
  modelId: string;
  cwd: string;
  /**
   * The turn env, built by the adapter — `OPENCODE_CONFIG` (which carries the
   * `shipit` provider block), `HOME`, and the single delivered credential.
   * Passing anything less would leave the server unable to authenticate the
   * summarization model.
   */
  env: Record<string, string>;
  spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Surfaced on the session's Logs panel. */
  onLog?: (message: string) => void;
  /**
   * Hands the transient server to the caller the moment it exists, so a
   * `kill()` / `interrupt()` arriving mid-compaction has something to stop.
   *
   * Without it the adapter is deaf to an interrupt for the whole
   * {@link SUMMARIZE_TIMEOUT_MS} window: this path sets no `this.proc`, which
   * is what both of those methods key off. Killing the server aborts the
   * in-flight request, which rejects and settles the turn through the ordinary
   * failure path.
   */
  onServerSpawned?: (proc: ChildProcess) => void;
}

/**
 * Compact one OpenCode session. Resolves when the summary has been written,
 * rejects with a human-readable reason otherwise. The transient server is
 * always killed, including on every failure path.
 */
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
        body: JSON.stringify({ providerID: SHIPIT_PROVIDER_ID, modelID: modelId }),
      },
      SUMMARIZE_TIMEOUT_MS,
    );

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`summarize returned HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    // The route answers a bare `true` on success. Anything else means the
    // server accepted the request and declined the work, which must NOT be
    // reported as a compaction — a silent no-op rendered as a "Context
    // compacted" card is exactly the failure docs/276 set out to rule out.
    if (text.trim() !== "true") {
      throw new Error(`summarize did not confirm compaction (body: ${text.slice(0, 300)})`);
    }
  } finally {
    // Tree-wide: the transient server loads the session's MCP servers like any
    // other OpenCode process, so it can leave the same descendants behind.
    killProcessTree(proc, "SIGTERM", { label: "opencode-compaction-server" });
  }
}

/**
 * Resolve the transient server's base URL from its own readiness line.
 *
 * Watches stderr as well as stdout: the line is on stdout today, but a startup
 * FAILURE is only ever reported on stderr, and a rejection quoting it beats
 * one that can only say "timed out".
 */
function waitForServer(proc: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(url!);
    };

    const timer = setTimeout(() => {
      const detail = stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 300)})` : "";
      finish(
        new Error(
          `the compaction server did not start within ${String(SERVER_READY_TIMEOUT_MS / 1000)}s${detail}`,
        ),
      );
    }, SERVER_READY_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      const m = LISTENING_RE.exec(stdout);
      if (m) finish(null, m[1].replace(/\/$/, ""));
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    proc.on("error", (err: Error) => {
      finish(new Error(`could not start the compaction server: ${err.message}`));
    });
    proc.on("exit", (code) => {
      const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "";
      finish(
        new Error(`the compaction server exited (code ${String(code)}) before it was ready${detail}`),
      );
    });
  });
}

/**
 * `fetch` with a bounded deadline. `AbortSignal.timeout` would be shorter, but
 * this keeps the reason legible in the rejection the caller surfaces.
 */
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
