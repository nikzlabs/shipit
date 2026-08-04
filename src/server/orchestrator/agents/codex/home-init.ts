/**
 * One-time initialization of a Codex `CODEX_HOME`, serialized across spawners.
 *
 * The Codex CLI initializes its config root lazily on first use: a `.codex`
 * directory holding only `auth.json` gains `state_<N>.sqlite`, `logs_<N>.sqlite`,
 * `memories_<N>.sqlite`, `skills/`, and an `installation_id` the first time any
 * `codex` process runs against it. **That first-run initialization is not
 * concurrency-safe.** Two `codex` processes starting against the same cold root
 * race on it, and the loser aborts before doing any work:
 *
 *     Error: failed to initialize sqlite state runtime under <dir>:
 *            failed to initialize state runtime at <dir>
 *
 * exiting 1. (A milder sibling shows up as `failed to install system skills: io
 * error while remove existing system skills dir: Directory not empty`.)
 *
 * ShipIt starts exactly two `codex` processes against one root, ~simultaneously,
 * exactly once per account — on a session's **first message**:
 *
 *   1. `graduateSession` fires AI naming fire-and-forget, which shells out to
 *      `codex exec` against the account root (`session-namer.ts`).
 *   2. The turn itself spawns `codex app-server`. In local/dogfood mode that
 *      resolves to the *same* root — the scoped `AGENT_HOME/.codex` is a symlink
 *      to it (`local-agent-credentials.ts`, `local-agent-home.ts`).
 *
 * A cold root is precisely the state after connecting a Codex account, so the
 * collision lands on a user's very first Codex message and, when the turn is the
 * loser, surfaces as a bare "Agent process exited with code 1" — while naming
 * *succeeds*, giving the session a real title and branch, so the turn looks like
 * it ran. Observed in production dogfood; reproduced 2 of 4 control trials with
 * two concurrent `codex app-server` against a fresh root.
 *
 * The fix is to make the first-run init happen **once, alone**, before anything
 * else touches the root. Every ShipIt path that spawns `codex` against a root it
 * does not exclusively own awaits {@link ensureCodexHomeInitialized} first; the
 * first caller performs a short throwaway `codex app-server` handshake (~165 ms
 * on a cold root, and it needs no auth and no network), later callers join the
 * same in-flight promise, and once the root is warm the gate is a directory read.
 * A warm root handles concurrent spawns fine — verified at 2 and 3 processes —
 * so the gate has to cover only the cold window.
 *
 * Retrying the loser was the alternative and is worse: it leaves two writers
 * entering an unsynchronized state directory and only papers over the outcome.
 *
 * **Scope.** This is orchestrator-side, so it covers spawns the orchestrator
 * makes: the naming CLI (both runtimes) and, in local mode, the turn's own
 * agent. It cannot reach a *containerized* turn, whose CLI runs inside the
 * session container against a per-session copy of the credentials mounted at
 * `/credentials` (`container-lifecycle.ts`) — but that copy is exclusively that
 * container's, so the orchestrator's naming spawn is not a second writer to it
 * and this particular collision does not exist there.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killChild } from "../../../shared/kill-child.js";
import { getErrorMessage } from "../../validation.js";

/**
 * Ceiling for the warm-up handshake. Fails **open**: on timeout we give up and
 * let the caller spawn anyway, exactly like the `withFailOpenTimeout` steps in
 * `session-agent-env.ts`. A racy spawn is strictly better than a turn that never
 * starts, and the observed cold-root warm-up is ~165 ms, so reaching this bound
 * at all means something is wrong that blocking would not fix.
 */
export const CODEX_HOME_INIT_TIMEOUT_MS = 20_000;

/** In-flight (or completed) warm-ups, keyed by resolved config-root path. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Has the Codex CLI already initialized this config root?
 *
 * Detected by the presence of a `state_<N>.sqlite` — the exact file whose
 * creation the failing processes contend over. Matched by pattern rather than by
 * the literal `state_5.sqlite` of Codex 0.146 so a CLI upgrade that bumps the
 * schema suffix re-arms the gate (that upgrade re-runs first-run init, and a
 * hardcoded name would report "warm" through precisely the window that isn't).
 */
export function isCodexHomeInitialized(codexHome: string): boolean {
  try {
    return fs
      .readdirSync(codexHome)
      .some((entry) => /^state_\d+\.sqlite$/.test(entry));
  } catch {
    // Missing/unreadable root — nothing has initialized it, so treat it as cold.
    return false;
  }
}

/**
 * Run the throwaway handshake that makes the CLI initialize `codexHome`.
 *
 * `codex app-server` does the full first-run init before answering
 * `initialize`, so a single request/response is enough; we kill the process the
 * moment it replies. Deliberately NOT `codex --version`, which touches nothing
 * (verified against 0.146 — a fresh root stays empty).
 */
function runWarmup(codexHome: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChild(child);
      resolve();
    };

    const child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: path.dirname(codexHome), CODEX_HOME: codexHome },
    });

    const timer = setTimeout(finish, CODEX_HOME_INIT_TIMEOUT_MS);

    // Any stdout at all means the server answered, which means init is done.
    child.stdout?.on("data", finish);
    // Covers a missing `codex` binary (ENOENT) and an exit before any reply.
    child.on("error", finish);
    child.on("close", finish);

    try {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { clientInfo: { name: "shipit-codex-home-init", version: "1.0.0" } },
        })}\n`,
      );
    } catch {
      // Broken pipe — the process is already gone; `close` settles us.
    }
  });
}

/**
 * Make sure `codexHome` has been through Codex's first-run initialization
 * before the caller spawns its own `codex` process against it.
 *
 * Resolves immediately for an already-initialized root (one `readdir`).
 * Otherwise single-flights the warm-up per path, so N concurrent callers produce
 * one initializing process and N−1 waiters. Never rejects: a failed or timed-out
 * warm-up logs and resolves, leaving the caller no worse off than before.
 *
 * Concurrency-safe only *within* this process. That is the scope of the bug —
 * both racing spawns are started by the orchestrator (see the module docstring)
 * — and a cross-process lock would have to be a lockfile in the very directory
 * whose first-write concurrency is the thing in question.
 */
export async function ensureCodexHomeInitialized(codexHome: string): Promise<void> {
  const key = path.resolve(codexHome);
  if (isCodexHomeInitialized(key)) return;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const started = Date.now();
  console.log(`[codex-home] initializing cold config root ${key} before spawning against it`);
  const run = (async (): Promise<void> => {
    try {
      await runWarmup(key);
      const ok = isCodexHomeInitialized(key);
      console.log(
        `[codex-home] ${key} ${ok ? "initialized" : "warm-up finished but root still looks cold"}`
          + ` in ${Date.now() - started}ms`,
      );
    } catch (err) {
      // Fail-open: a spawn we could not perform must not block a turn.
      console.warn(`[codex-home] warm-up for ${key} failed:`, getErrorMessage(err));
    } finally {
      // Drop the entry either way. A successful run leaves the root warm, so the
      // cheap `isCodexHomeInitialized` check short-circuits every later call; a
      // failed one SHOULD be retried by the next caller rather than cached.
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Test seam — drops memoized in-flight warm-ups between cases. */
export function resetCodexHomeInitForTests(): void {
  inFlight.clear();
}
