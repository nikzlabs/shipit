import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentId, AgentProcess, ServiceRouting } from "../shared/types.js";
import type { AgentHomeResolver } from "../shared/agent-home.js";
import {
  buildSubAgentRunParams,
  runAgentToCompletion,
  type SubAgentRunResult,
} from "../shared/sub-agent-run.js";
import {
  provisionSubAgentSpawnHome,
  releaseSubAgentSpawnHome,
  subAgentSpawnHomeDir,
} from "./session-credentials.js";
import { getErrorMessage } from "./validation.js";
import { toolsOffRefusal } from "../shared/agent-tools-off.js";

/** Cleanup prompts are one paragraph of tidied transcript, not a report. */
export const BACKGROUND_HARNESS_MAX_OUTPUT_CHARS = 8_000;

/**
 * A caller with a deadline of its own passes it; this is what the run gets when
 * nobody says, and it is deliberately not the worker transport's 10-second
 * default, which would cut a measured 3-4.5 s one-shot far too close.
 */
export const BACKGROUND_HARNESS_TIMEOUT_MS = 30_000;

export interface BackgroundHarnessRun {
  harnessId: AgentId;
  prompt: string;
  model: string;
  serviceRouting?: ServiceRouting | undefined;
  /**
   * The routed credential's value. A session container has every configured
   * credential pushed into its environment; this container has none, so a
   * routed run must carry its own or the harness raises `auth_required` without
   * starting. `NonTurnTarget.credentialSecret` already resolves it.
   */
  credentialSecret?: string | undefined;
  /** Provider account whose credentials the spawn home projects. */
  accountId?: string | undefined;
  reasoningEffort?: string | undefined;
  /** Abandoning the run cancels the CLI; it does not merely stop waiting. */
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxOutputChars?: number | undefined;
}

/**
 * Run one prompt through the background-work harness, with no session, no
 * repository and no tools. The caller owns its own deadline: passing an aborted
 * signal cancels the CLI rather than leaving it running (docs/299 req 9).
 */
export interface BackgroundHarnessRunner {
  run(req: BackgroundHarnessRun): Promise<SubAgentRunResult>;
}

/**
 * Answer a harness with no measured tools-off configuration here, where the run
 * still costs nothing. The adapter already fails closed on one
 * (`agent-tools-off.ts`), so this is not the safety net — it is what stops the
 * cleanup container being created, and a spawn home provisioned, for a run that
 * cannot happen, and what turns the refusal into an ordinary failed result
 * instead of an adapter error event.
 */
export function refuseIfToolsStayOn(
  harnessId: AgentId,
  startedAt: number,
): SubAgentRunResult | undefined {
  const refusal = toolsOffRefusal(harnessId);
  return refusal === undefined ? undefined : failedRun(refusal, startedAt);
}

export function failedRun(error: string, startedAt = Date.now()): SubAgentRunResult {
  return {
    status: "error",
    text: "",
    truncated: false,
    durationMs: Math.max(0, Date.now() - startedAt),
    costUsd: 0,
    error,
  };
}

/**
 * Borrow credentials into a private home for the duration of one spawn, and
 * publish anything the CLI rotated on the way out. Never bypass this:
 * `provisionSubAgentSpawnHome` also builds OpenCode's access-only ChatGPT
 * projection, and its release keeps the home when publishing a token it finds
 * there fails (`session-agent-credentials.ts`).
 *
 * That retention covers a publish that failed, NOT a CLI that is still running:
 * the release reads the home once and then deletes it, so a rotation written
 * after that read is lost, whatever the outcome flag said. `body` owes this the
 * CLI's real exit, which is why the timeout path in `runAgentToCompletion` waits
 * for it rather than settling on the kill.
 */
export async function withSpawnHome<T>(
  credentialsDir: string,
  sessionId: string,
  harnessId: AgentId,
  accountId: string | undefined,
  body: (spawnId: string, hostHomeDir: string) => Promise<T>,
): Promise<T> {
  const spawnId = randomUUID();
  provisionSubAgentSpawnHome(credentialsDir, sessionId, spawnId, harnessId, accountId);
  try {
    return await body(spawnId, subAgentSpawnHomeDir(credentialsDir, sessionId, spawnId));
  } finally {
    releaseSubAgentSpawnHome(credentialsDir, sessionId, spawnId);
  }
}

/** Deliver the routed credential for exactly the synchronous span that reads it. */
function withRoutedCredential(req: BackgroundHarnessRun, body: () => void): void {
  const name = req.serviceRouting?.credentialSourceEnv;
  if (!name || !req.credentialSecret) {
    body();
    return;
  }
  const previous = process.env[name];
  process.env[name] = req.credentialSecret;
  try {
    body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  }
}

export interface LocalBackgroundHarnessDeps {
  agentFactory: (agentId: AgentId, resolveHome?: AgentHomeResolver) => AgentProcess;
  credentialsDir: string;
  /** Reserved id the spawn homes hang off; it owns no session. */
  sessionId: string;
}

/**
 * `RUNTIME_MODE=local` has no container manager (`app-lifecycle.ts`), so there
 * is no cleanup container to spawn into. Run the same adapter from the
 * orchestrator instead — the one session-independent harness invocation ShipIt
 * already has, and the one that keeps the result parsing, routing and process
 * teardown identical to the container path.
 */
export class LocalBackgroundHarnessRunner implements BackgroundHarnessRunner {
  constructor(private readonly deps: LocalBackgroundHarnessDeps) {}

  async run(req: BackgroundHarnessRun): Promise<SubAgentRunResult> {
    const startedAt = Date.now();
    if (req.signal?.aborted) return failedRun("The cleanup run was abandoned before it started.", startedAt);
    const refusal = refuseIfToolsStayOn(req.harnessId, startedAt);
    if (refusal) return refusal;
    try {
      return await withSpawnHome(
        this.deps.credentialsDir,
        this.deps.sessionId,
        req.harnessId,
        req.accountId,
        async (_spawnId, hostHomeDir) => this.runWithHome(req, hostHomeDir, startedAt),
      );
    } catch (err) {
      return failedRun(getErrorMessage(err), startedAt);
    }
  }

  private async runWithHome(
    req: BackgroundHarnessRun,
    homeDir: string,
    startedAt: number,
  ): Promise<SubAgentRunResult> {
    const opts = {
      prompt: req.prompt,
      // No repository: background work reads nothing from a tree.
      cwd: os.tmpdir(),
      model: req.model,
      homeDir,
      toolsOff: true,
      ...(req.serviceRouting !== undefined ? { serviceRouting: req.serviceRouting } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      timeoutMs: req.timeoutMs ?? BACKGROUND_HARNESS_TIMEOUT_MS,
      maxOutputChars: req.maxOutputChars ?? BACKGROUND_HARNESS_MAX_OUTPUT_CHARS,
    };
    const agent = this.deps.agentFactory(req.harnessId, () => homeDir);
    const handle = runAgentToCompletion(agent, opts, startedAt);
    const onAbort = (): void => { handle.cancel(); };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Every adapter reads the routed credential out of the environment inside
      // run(), synchronously; the value goes back before anything can await.
      withRoutedCredential(req, () => { agent.run(buildSubAgentRunParams(opts)); });
      // cancel() does not settle the promise — the process does. Awaiting it is
      // what lets the spawn home outlive a CLI that is still shutting down.
      return await handle.promise;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      // The adapters' kill() uses killProcessTree; a pid-only kill would strand children.
      try { agent.kill(); } catch { /* already exited */ }
    }
  }
}
