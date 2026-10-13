import type { AgentProcess, AgentRunParams, AgentEvent, AgentId, AgentRequestUsage, ServiceRouting } from "./types.js";
import { redactCredentials } from "./credential-redaction.js";
import { createRedactedTail } from "./redacted-tail.js";

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

/** Small enough for a consult card and one log line. */
export const SUB_AGENT_STDERR_TAIL_MAX_CHARS = 300;
export const SUB_AGENT_FAILURE_MESSAGE_MAX_CHARS = 300;

const AUTH_REQUIRED_REASON = "The agent CLI reported that its credential is missing or was refused.";

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
  /** Empty the harness's tool set for a one-shot run (docs/299). */
  toolsOff?: boolean;
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
  /** Each model call, where the harness lists them (docs/329-tiered-model-pricing). */
  requests?: AgentRequestUsage[];
  rateLimits?: {
    session: { usedPct: number | null; resetAt: string } | null;
    weekly: { usedPct: number | null; resetAt: string } | null;
  };
  error?: string;
  /** Present when the harness process reported one. */
  exitCode?: number;
  /** Redacted, bounded end of the harness's stderr; only on a run that failed or timed out. */
  stderrTail?: string;
  /** Present when `text` was cut at this size. A timed-out run is `truncated` also with no cut. */
  outputLimitChars?: number;
}

// Redact before a cut: a cut can leave a part of a secret that no pattern knows.
function redactedLine(text: string): string {
  return redactCredentials(text).text.replace(/\s+/g, " ").trim();
}

function endOf(line: string, maxChars: number): string {
  return line.length > maxChars ? `…${line.slice(-maxChars)}` : line;
}

function formatTimeLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.ceil(ms / 1_000)} s`;
}

/** One line. It redacts and bounds its input again, because a result can come from a worker. */
export function describeSubAgentFailure(
  run: Pick<SubAgentRunResult, "status" | "error" | "exitCode" | "stderrTail">,
): string | undefined {
  if (run.status !== "error" && run.status !== "timeout") return undefined;
  const given = redactedLine(run.error ?? "");
  const message = given.length > SUB_AGENT_FAILURE_MESSAGE_MAX_CHARS
    ? `${given.slice(0, SUB_AGENT_FAILURE_MESSAGE_MAX_CHARS)}…`
    : given;
  const fallback = run.status === "timeout"
    ? "The run reached its time limit."
    : "The agent reported a failure and gave no reason.";
  const stderr = endOf(redactedLine(run.stderrTail ?? ""), SUB_AGENT_STDERR_TAIL_MAX_CHARS);
  return [
    !message ? fallback : /[.!?…]$/.test(message) ? message : `${message}.`,
    ...(typeof run.exitCode === "number" ? [`Exit code ${run.exitCode}.`] : []),
    ...(stderr ? [`Last stderr: ${stderr}`] : []),
  ].join(" ");
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
  toolsOff?: boolean;
}

export interface SubAgentRunHandle {
  promise: Promise<SubAgentRunResult>;
  cancel: () => void;
  /**
   * Call `agent.run()` in this. An adapter that finds no credential emits `auth_required` in
   * that call and starts no process, so the run must end there: no `done` follows.
   */
  start: (run: () => void) => void;
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
  let requests: AgentRequestUsage[] | undefined;
  let rateLimits: SubAgentRunResult["rateLimits"] | undefined;
  let resultStatus: "success" | "error" | undefined;
  let resultError: string | undefined;
  let exitCode: number | undefined;
  let authRequired = false;
  const stderr = createRedactedTail();

  let adapterStarting = false;

  let settled = false;
  let cancelled = false;
  let timedOut = false;

  return {
    cancel: () => {
      cancelled = true;
      try { agent.kill(); } catch { /* best-effort */ }
    },
    start: (run) => {
      adapterStarting = true;
      try {
        run();
      } finally {
        adapterStarting = false;
      }
    },
    promise: new Promise<SubAgentRunResult>((resolve) => {
      const finish = (statusOverride?: SubAgentRunStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        let text = (completedMessages.length > 0 ? completedMessages.join("\n\n") : lastFullText) || "";
        let truncated = false;
        let outputLimitChars: number | undefined;
        if (text.length > maxOutputChars) {
          text = text.slice(0, maxOutputChars);
          truncated = true;
          outputLimitChars = maxOutputChars;
        }
        const status: SubAgentRunStatus =
          statusOverride ??
          (timedOut ? "timeout" : cancelled ? "cancelled" : resultStatus === "error" ? "error" : "success");
        if (timedOut) truncated = true;
        const stderrTail = status === "error" || status === "timeout"
          ? stderr.read(SUB_AGENT_STDERR_TAIL_MAX_CHARS)
          : "";
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
          ...(requests !== undefined ? { requests } : {}),
          ...(rateLimits !== undefined ? { rateLimits } : {}),
          ...(resultError !== undefined ? { error: resultError } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(stderrTail ? { stderrTail } : {}),
          ...(outputLimitChars !== undefined ? { outputLimitChars } : {}),
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        resultError = `The run did not finish within its time limit (${formatTimeLimit(timeoutMs)}), and ShipIt stopped it.`;
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
          if (event.requests) requests = event.requests;
          resultStatus = event.status;
          if (event.error) resultError = event.error;
        } else if (event.type === "agent_rate_limits") {
          rateLimits = { session: event.session, weekly: event.weekly };
        }
      });

      agent.on("log", (source: string, text: string) => {
        if (source.endsWith("stderr")) stderr.add(text);
      });

      // From a live process this does not end the run: the Codex adapter emits it for a stderr
      // line with "api key" in it, and the account failover reads the result that can follow.
      agent.on("auth_required", () => {
        authRequired = true;
        if (!adapterStarting) return;
        if (!cancelled) resultError ??= AUTH_REQUIRED_REASON;
        finish(cancelled ? "cancelled" : "error");
      });

      // A crash without agent_result is a failure even if it emitted some text. So is an exit
      // after auth_required: the Claude adapter does not pass on the result of an auth failure.
      agent.on("done", (code?: number | null) => {
        if (typeof code === "number") exitCode = code;
        if (
          resultStatus === undefined &&
          !cancelled &&
          !timedOut &&
          (authRequired || (typeof code === "number" && code !== 0))
        ) {
          resultStatus = "error";
          resultError ??= authRequired
            ? AUTH_REQUIRED_REASON
            : "The agent process exited before it reported a result.";
          finish("error");
          return;
        }
        finish();
      });
      agent.on("error", (err: Error) => {
        resultStatus = "error";
        resultError = err.message;
        // The Claude and OpenCode adapters emit `done`, with the exit code, directly after this.
        queueMicrotask(() => finish("error"));
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
    ...(opts.toolsOff !== undefined ? { toolsOff: opts.toolsOff } : {}),
  };
}
