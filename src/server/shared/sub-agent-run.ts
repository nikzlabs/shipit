/**
 * docs/144 — drive a freshly-instantiated agent adapter to completion and
 * return its final assistant text, synchronously, without touching any SSE
 * broadcast or the worker's single-occupant agent slot.
 *
 * This is the shared core of the sub-agent spawn primitive. Both execution
 * paths use it:
 *   - the container path (session worker's `POST /agent/spawn`), which
 *     instantiates a per-agent adapter outside the `/agent/start` slot;
 *   - the local/dogfood path (orchestrator `SessionRunner.spawnSubAgent`),
 *     which runs the same adapters in-process.
 *
 * The helper is deliberately layer-agnostic: it operates purely on the
 * `AgentProcess` interface and never references the worker, the runner, SSE,
 * credentials, or the registry. Wiring those is the caller's job.
 */

import type { AgentProcess, AgentRunParams, AgentEvent, AgentId } from "./types.js";

/**
 * Default wall-clock cap on a single sub-agent run.
 *
 * §5 shipped an initial 5-minute cap, but a real consult — an audit, a review of
 * a large diff, a generation task — routinely runs past that, and the 5-minute
 * SIGTERM was killing otherwise-healthy spawns mid-answer. The HTTP transport is
 * unbounded on every leg (`{ timeoutMs: 0 }`), so this timer is the only thing
 * that bounds a spawn; we raise it to 30 minutes. Override with
 * `SHIPIT_SUB_AGENT_TIMEOUT_MS` (milliseconds) for an even longer cap.
 *
 * NB "unbounded" was once aspirational: the shim→worker and worker→orchestrator
 * legs use the global `fetch` (undici), whose default 300s `headersTimeout` an
 * AbortController-free call cannot disable, so a consult past ~5 min aborted
 * with the opaque "fetch failed". Those two legs now route `timeoutMs: 0` over
 * Node `http` (no default response timeout) so the contract actually holds; the
 * orchestrator→worker leg already used Node `http` (`worker-http.ts`).
 */
export const DEFAULT_SUB_AGENT_TIMEOUT_MS = parseTimeoutEnv(
  process.env.SHIPIT_SUB_AGENT_TIMEOUT_MS,
  30 * 60_000,
);

/** Parse a positive-integer ms env override, falling back to `fallback`. */
function parseTimeoutEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Default output cap. §5 sets an ~8K output-token cap; we bound the captured
 * final text at ~4 chars/token ≈ 32K characters. A run that overshoots is
 * truncated and flagged so the primary can surface "the sub-agent's answer was
 * cut off".
 */
export const DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS = 32_000;

export interface SubAgentRunOptions {
  prompt: string;
  cwd: string;
  /** Optional model alias/id; defaults to the adapter's default model. */
  model?: string;
  /** docs/217 — reasoning effort for the sub-agent (the invoked agent's global default). */
  reasoningEffort?: string;
  /** Wall-clock cap in ms. Defaults to {@link DEFAULT_SUB_AGENT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Output character cap. Defaults to {@link DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS}. */
  maxOutputChars?: number;
}

export type SubAgentRunStatus = "success" | "error" | "timeout" | "cancelled";

export interface SubAgentRunResult {
  status: SubAgentRunStatus;
  /** The sub-agent's final assistant message (possibly truncated). */
  text: string;
  /** True when the output hit the wall-clock or character cap. */
  truncated: boolean;
  durationMs: number;
  costUsd: number;
  /**
   * Turn-wide token totals from the sub-agent's `agent_result` (docs/144 usage
   * attribution). Carried so the consult's usage is recorded with the same
   * fidelity as a primary turn — without these the spawn's tokens were dropped
   * and only its (often $0, for a subscription backend like Codex) cost landed.
   * Undefined when the backend reported no token telemetry.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /** Real context-window occupancy at the sub-agent's turn end (last API call). */
  contextTokens?: number;
  /**
   * Latest subscription rate-limit snapshot the backend pushed during the run
   * (docs/144). A consult consumes the sub-agent's subscription quota, but its
   * `agent_rate_limits` events are confined to the one-shot adapter and never
   * reach the orchestrator's `LimitsRegistry` on their own — so the last one is
   * carried back here for `runSubAgent` to forward into the right provider,
   * keeping the limit pill from going stale until the next primary turn.
   * Undefined when the backend pushed no snapshot during the run.
   */
  rateLimits?: {
    session: { usedPct: number | null; resetAt: string } | null;
    weekly: { usedPct: number | null; resetAt: string } | null;
  };
  /** Backend-reported error message, when status is "error". */
  error?: string;
}

/**
 * The runner-facing spawn request: a session runner's `spawnSubAgent` receives
 * this and runs the named agent to completion (over the worker for a container
 * runner, in-process for a local runner). The orchestrator service builds it
 * after passing the authorization gates.
 */
export interface SubAgentSpawnRequest {
  agentId: AgentId;
  prompt: string;
  /** Orchestrator-internal handle for tracking + cancellation (not an auth token). */
  spawnId: string;
  /** The caller's recursion depth (0 for a primary). The worker stamps depth+1. */
  depth: number;
  model?: string;
  /** docs/217 — reasoning effort for the sub-agent (the invoked agent's global default). */
  reasoningEffort?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface SubAgentRunHandle {
  promise: Promise<SubAgentRunResult>;
  /** SIGTERM the underlying process; resolves the run with status "cancelled". */
  cancel: () => void;
}

/** Concatenate the text blocks of an assistant event into one string. */
function assistantText(event: Extract<AgentEvent, { type: "agent_assistant" }>): string {
  return event.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Run `agent` to completion against a one-shot prompt and resolve with its
 * accumulated final assistant text. The caller is responsible for having
 * stamped any environment (e.g. `SHIPIT_AGENT_DEPTH`) before invoking, and for
 * disposing of the adapter reference afterward.
 */
export function runAgentToCompletion(
  agent: AgentProcess,
  opts: SubAgentRunOptions,
  startedAtMs: number,
): SubAgentRunHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS;

  // For Claude one-shot, each `agent_assistant` event carries a FULL message, so
  // the last one is the final answer. For Codex, deltas stream into individual
  // events and the authoritative final text arrives once with `isStreamCompletion`.
  // Prefer the stream-completion text; fall back to the last full message.
  let streamCompletionText: string | null = null;
  let lastFullText = "";
  let costUsd = 0;
  let reportedDurationMs: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreateTokens: number | undefined;
  let contextTokens: number | undefined;
  let rateLimits: SubAgentRunResult["rateLimits"] | undefined;
  let resultStatus: "success" | "error" | undefined;
  let resultError: string | undefined;

  let settled = false;
  let cancelled = false;
  let timedOut = false;

  return {
    cancel: () => {
      cancelled = true;
      try { agent.kill(); } catch { /* best-effort */ }
    },
    promise: new Promise<SubAgentRunResult>((resolve) => {
      const finish = (statusOverride?: SubAgentRunStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        let text = (streamCompletionText ?? lastFullText) || "";
        let truncated = false;
        if (text.length > maxOutputChars) {
          text = text.slice(0, maxOutputChars);
          truncated = true;
        }
        const status: SubAgentRunStatus =
          statusOverride ??
          (timedOut ? "timeout" : cancelled ? "cancelled" : resultStatus === "error" ? "error" : "success");
        if (timedOut) truncated = true;
        resolve({
          status,
          text,
          truncated,
          durationMs: reportedDurationMs ?? Math.max(0, Date.now() - startedAtMs),
          costUsd,
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheCreateTokens !== undefined ? { cacheCreateTokens } : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(rateLimits !== undefined ? { rateLimits } : {}),
          ...(resultError !== undefined ? { error: resultError } : {}),
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try { agent.kill(); } catch { /* best-effort */ }
        // Give the process a tick to emit `done`; resolve directly if it doesn't.
        finish("timeout");
      }, timeoutMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }

      agent.on("event", (event: AgentEvent) => {
        if (event.type === "agent_assistant") {
          if (event.parentToolUseId) return; // ignore nested sub-agent (Task tool) output
          const text = assistantText(event);
          if (event.isStreamCompletion) {
            streamCompletionText = text;
          } else if (text.length > 0) {
            lastFullText = text;
          }
        } else if (event.type === "agent_result") {
          if (event.cost?.totalUsd) costUsd = event.cost.totalUsd;
          if (typeof event.durationMs === "number") reportedDurationMs = event.durationMs;
          if (event.tokens) {
            inputTokens = event.tokens.input;
            outputTokens = event.tokens.output;
            if (event.tokens.cacheRead !== undefined) cacheReadTokens = event.tokens.cacheRead;
            if (event.tokens.cacheWrite !== undefined) cacheCreateTokens = event.tokens.cacheWrite;
          }
          if (typeof event.contextTokens === "number") contextTokens = event.contextTokens;
          resultStatus = event.status;
          if (event.error) resultError = event.error;
        } else if (event.type === "agent_rate_limits") {
          // Last-one-wins: the latest snapshot is the freshest quota reading.
          rateLimits = { session: event.session, weekly: event.weekly };
        }
      });

      agent.on("done", () => finish());
      agent.on("error", (err: Error) => {
        resultStatus = "error";
        resultError = err.message;
        finish("error");
      });
    }),
  };
}

/** Build the minimal run params for a one-shot sub-agent spawn. */
export function buildSubAgentRunParams(opts: SubAgentRunOptions): AgentRunParams {
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
  };
}
