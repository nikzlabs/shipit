import type { AgentProcess, AgentRunParams, AgentEvent, AgentId, ServiceRouting } from "./types.js";

export const DEFAULT_SUB_AGENT_TIMEOUT_MS = parseTimeoutEnv(
  process.env.SHIPIT_SUB_AGENT_TIMEOUT_MS,
  30 * 60_000,
);

// The worker timer dies with its container; bound the transport independently.
export const SUB_AGENT_TRANSPORT_TIMEOUT_MS = DEFAULT_SUB_AGENT_TIMEOUT_MS + 5 * 60_000;

function parseTimeoutEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS = 32_000;

export interface SubAgentRunOptions {
  prompt: string;
  cwd: string;
  model?: string;
  /** Isolate spawn credentials so provisioning cannot overwrite the primary's login. */
  homeDir?: string;
  serviceRouting?: ServiceRouting;
  reasoningEffort?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export type SubAgentRunStatus = "success" | "error" | "timeout" | "cancelled";

export interface SubAgentRunResult {
  status: SubAgentRunStatus;
  text: string;
  truncated: boolean;
  durationMs: number;
  costUsd: number;
  /** Distinguishes a reported zero from absent cost telemetry. */
  costReported?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  contextTokens?: number;
  rateLimits?: {
    session: { usedPct: number | null; resetAt: string } | null;
    weekly: { usedPct: number | null; resetAt: string } | null;
  };
  error?: string;
}

export interface SubAgentSpawnRequest {
  agentId: AgentId;
  prompt: string;
  spawnId: string;
  /** Caller's depth; the worker stamps depth + 1. */
  depth: number;
  model: string;
  serviceRouting?: ServiceRouting;
  homeDir?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface SubAgentRunHandle {
  promise: Promise<SubAgentRunResult>;
  cancel: () => void;
}

function assistantText(event: Extract<AgentEvent, { type: "agent_assistant" }>): string {
  return event.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Caller stamps the environment before starting and disposes of the adapter afterward.
export function runAgentToCompletion(
  agent: AgentProcess,
  opts: SubAgentRunOptions,
  startedAtMs: number,
): SubAgentRunHandle {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_SUB_AGENT_MAX_OUTPUT_CHARS;

  // Streaming adapters can complete several messages; preserve all of them.
  // Non-streaming adapters supply full messages, with the last being the answer.
  const completedMessages: string[] = [];
  let lastFullText = "";
  let costUsd = 0;
  let costReported = false;
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

        let text = (completedMessages.length > 0 ? completedMessages.join("\n\n") : lastFullText) || "";
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
          costReported,
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
        finish("timeout");
      }, timeoutMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref?: () => void }).unref?.();
      }

      agent.on("event", (event: AgentEvent) => {
        if (event.type === "agent_assistant") {
          if (event.parentToolUseId) return;
          const text = assistantText(event);
          if (event.isStreamCompletion) {
            if (text.length > 0 && completedMessages[completedMessages.length - 1] !== text) {
              completedMessages.push(text);
            }
          } else if (text.length > 0) {
            lastFullText = text;
          }
        } else if (event.type === "agent_result") {
          if (event.cost?.totalUsd !== undefined) {
            costUsd = event.cost.totalUsd;
            costReported = true;
          }
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
          rateLimits = { session: event.session, weekly: event.weekly };
        }
      });

      // A crash without agent_result is a failure even if it emitted some text.
      agent.on("done", (exitCode?: number | null) => {
        if (
          resultStatus === undefined &&
          !cancelled &&
          !timedOut &&
          typeof exitCode === "number" &&
          exitCode !== 0
        ) {
          resultStatus = "error";
          resultError ??= `The agent process exited with code ${exitCode} before reporting a result.`;
          finish("error");
          return;
        }
        finish();
      });
      agent.on("error", (err: Error) => {
        resultStatus = "error";
        resultError = err.message;
        finish("error");
      });
    }),
  };
}

export function buildSubAgentRunParams(opts: SubAgentRunOptions): AgentRunParams {
  return {
    prompt: opts.prompt,
    cwd: opts.cwd,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.serviceRouting !== undefined ? { serviceRouting: opts.serviceRouting } : {}),
    ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}
