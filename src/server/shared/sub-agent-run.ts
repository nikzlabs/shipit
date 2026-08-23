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

import type { AgentProcess, AgentRunParams, AgentEvent, AgentId, ServiceRouting } from "./types.js";

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

/**
 * planning#280 — backstop bound on the orchestrator→worker `/agent/spawn` leg.
 *
 * That leg used to be sent with `{ timeoutMs: 0 }` on the theory that the
 * worker's own wall-clock cap ({@link DEFAULT_SUB_AGENT_TIMEOUT_MS}) always
 * bounds the run and a primary-turn interrupt always cancels it. Neither holds
 * when the container is destroyed underneath the request (a Restart agent, an
 * idle teardown) or the socket goes half-open: the worker's timer dies with the
 * worker, so `runSubAgent` stays pending forever — no card, no error, nothing
 * in `shipit agent result`.
 *
 * The worker cap stays authoritative; this only fires when the worker never
 * answers at all, hence the generous margin. Both sides read the same
 * `SHIPIT_SUB_AGENT_TIMEOUT_MS`, but they are different containers with
 * possibly different env, so the margin also absorbs a modest mismatch.
 */
export const SUB_AGENT_TRANSPORT_TIMEOUT_MS = DEFAULT_SUB_AGENT_TIMEOUT_MS + 5 * 60_000;

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
  /**
   * Isolated HOME for this spawn's CLI (container-side path). Set for a
   * SAME-harness spawn so its credentials live in a per-spawn root instead of
   * the session subtree the live primary CLI reads — a cross-provider
   * provision there swaps the primary's credential file mid-turn and 401s it
   * (see `provisionSubAgentSpawnHome`). Absent ⇒ the CLI runs under the
   * process-global home exactly as before.
   */
  homeDir?: string;
  /**
   * docs/252 phase 3 — base URL + credential for the selected model's service.
   * A consult is a `(service, billing mode, model)` selection like any other
   * (the invoked agent's own sub-agent defaults), so it needs the same shaping
   * a primary turn does — otherwise a consult on a custom service would run
   * against the harness's own vendor.
   */
  serviceRouting?: ServiceRouting;
  /**
   * Reasoning effort for the sub-agent.
   *
   * docs/261 — no longer "the invoked agent's global default": there is no such
   * default any more. The level comes from the spawn's own target — the
   * reviewer's, for a role; the caller's `--effort`, for an explicit call — so
   * `runSubAgent` always sets it. Still optional on the type because the other
   * caller of this shape (non-turn work) has its own answer.
   */
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
   * docs/252 phase 3 — true when the harness reported a dollar figure. Distinct
   * from `costUsd > 0`: a harness that reports nothing (Codex) leaves this
   * false, and the cost rule must price such a turn from the catalogue's rates
   * rather than record it as free.
   */
  costReported?: boolean;
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
  /**
   * docs/261 req 7 — REQUIRED. Both callers resolve a model before they get
   * here (a one-shot spawn from its target, non-turn work from its own
   * resolution), and an absent one means "let the CLI pick", which is the
   * blank-filling this feature removes. Optional here was the type-level version
   * of the same hole: a propagation slip would have re-created it silently
   * instead of failing.
   */
  model: string;
  /** docs/252 phase 3 — base URL + credential for the sub-agent model's service. */
  serviceRouting?: ServiceRouting;
  /** Isolated per-spawn HOME (container path) for a same-harness spawn — see {@link SubAgentRunOptions.homeDir}. */
  homeDir?: string;
  /**
   * Reasoning effort for the sub-agent.
   *
   * docs/261 — no longer "the invoked agent's global default": there is no such
   * default any more. The level comes from the spawn's own target — the
   * reviewer's, for a role; the caller's `--effort`, for an explicit call — so
   * `runSubAgent` always sets it. Still optional on the type because the other
   * caller of this shape (non-turn work) has its own answer.
   */
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
  // events and each COMPLETED message is re-emitted once with
  // `isStreamCompletion`. Prefer the stream-completion texts; fall back to the
  // last full message.
  //
  // planning#247 — a delta-streaming run can complete MORE THAN ONE message in a
  // single turn (Codex routinely emits a long report and then a shorter wrap-up,
  // and any preamble message is its own `agentMessage` item). Keeping only the
  // last one silently handed the caller the tail of the answer — an artifact
  // that reads complete but isn't. So collect every completed message in order
  // and join them: the caller and the consult card both get the sub-agent's
  // WHOLE assistant output, never a suffix of it.
  const completedMessages: string[] = [];
  let lastFullText = "";
  let costUsd = 0;
  // docs/252 phase 3 — whether the harness reported a dollar figure AT ALL,
  // which `costUsd` alone cannot say: it starts at 0 and Codex reports nothing,
  // so "reported nothing" and "cost nothing" are the same value. Reading the
  // zero as a real figure is what recorded every metered OpenAI consult as free,
  // in the one column req 16 exists to make honest.
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
            // One entry per completed message. Deduped against the previous
            // entry so an adapter that re-emits the same completion twice can't
            // double it up.
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
          // Last-one-wins: the latest snapshot is the freshest quota reading.
          rateLimits = { session: event.session, weekly: event.weekly };
        }
      });

      /**
       * A run that exited non-zero without ever reporting a result is a
       * failure, not a success.
       *
       * `status` used to default to "success" for anything short of an explicit
       * `agent_result` error or an adapter `error` event — so a CLI that never
       * started (an E2BIG argv overflow: exec failed, zero events,
       * non-zero exit) came back `status: "success"`, `text: ""`,
       * `durationMs: 6`. The caller read that as "the reviewer found nothing",
       * said so, and retried into the identical wall; nothing in the chain ever
       * reported an error, and the account-failover loop above never ran because
       * there was no failure to fail over from.
       *
       * The absence of an `agent_result` is the load-bearing condition, not the
       * absence of text. A backend emits its result at turn end, so a run that
       * has none never reached one — and a crash mid-turn routinely leaves
       * *some* assistant text behind ("Let me inspect the files…", then a tool
       * loop, then exit 1). Requiring empty text would call that a success and
       * hand the caller a preamble as if it were the answer, which is the same
       * defect one layer along. Whatever text did arrive is still returned; the
       * status is what changes.
       *
       * The other conditions each exclude a real case:
       *   - `agent_result` present — the backend reported its own status and
       *     owns the verdict, including a non-zero exit after a good turn;
       *   - not cancelled or timed out — those have their own status, and both
       *     kill the process, which is itself a non-zero exit.
       */
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

/** Build the minimal run params for a one-shot sub-agent spawn. */
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
