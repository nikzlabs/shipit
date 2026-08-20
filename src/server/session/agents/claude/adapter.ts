/**
 * ClaudeAdapter — wraps ClaudeProcess (one-shot) or StreamingClaudeProcess
 * (persistent, streaming) to implement the AgentProcess interface.
 *
 * When params.useStreaming is true (live steering enabled), run() creates a
 * StreamingClaudeProcess that keeps the process alive across turns. Otherwise
 * it creates the one-shot ClaudeProcess. (docs/140)
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { ClaudeProcess, StreamingClaudeProcess } from "./process.js";
import type {
  ClaudeEvent,
  ClaudeMcpServerInit,
  ClaudeUsageIteration,
  PermissionMode,
} from "../../../shared/types.js";
import { CLAUDE_PERMISSION_MODES } from "../../../shared/types.js";
import { CLAUDE_MODELS, CLAUDE_TOOL_NAMES } from "../../../shared/agent-registry.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "../agent-process.js";
import type { AgentHomeResolver } from "../../../shared/agent-home.js";
import type { McpServerStatus } from "../../../shared/types/mcp-types.js";
import type { SubscriptionLimitsWindow } from "../../../shared/types/usage-limits-types.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
} from "../playwright-mcp.js";

/**
 * docs/140 — concatenate the text blocks of a replayed user message back into
 * the string the CLI received. `sendUserMessage` always frames a steer as a
 * single `{type:"text"}` block, and `--replay-user-messages` echoes that block
 * verbatim (JSON round-trip, no normalization), so the joined text equals the
 * assembled prompt the orchestrator sent — which is what the ack matcher keys
 * on. Non-text blocks are ignored.
 */
function textFromUserContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

export class ClaudeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "claude";

  /**
   * Latest five_hour / seven_day windows accumulated from the CLI's
   * stream-json `rate_limit_event` messages. The CLI emits ONE window per
   * event (carrying `rateLimitType`), so we accumulate both locally and
   * emit a combined `agent_rate_limits` AgentEvent whenever either changes
   * — same shape Codex emits, single contract on the orchestrator side.
   * Anthropic-side: this data comes from `anthropic-ratelimit-unified-*`
   * response headers, so it's effectively free and bypasses the broken
   * `/api/oauth/usage` polling endpoint.
   */
  private rateLimitSession: SubscriptionLimitsWindow | null = null;
  private rateLimitWeekly: SubscriptionLimitsWindow | null = null;

  /**
   * Context occupancy from the latest top-level API call in this turn — the
   * fallback for Claude-compatible providers that omit
   * `result.usage.iterations`.
   *
   * Two events feed it, because no single one covers every provider:
   *
   *  - the `assistant` event's `message.usage` (DeepSeek populates it), and
   *  - the `message_delta` SSE frame under `--include-partial-messages`
   *    (Z.ai/GLM reports usage ONLY there — its assistant events are zeroed).
   *
   * Both describe the same thing, the prompt size of one model call, so the
   * later one simply wins. The real wire order within a call is `assistant`
   * first, then the closing `message_delta`, so the winner is the delta — the
   * protocol's FINAL figure for that call, which is the one to prefer. That
   * ordering is measured, not assumed, and so is the agreement: on DeepSeek
   * with the flag both sources read exactly 168 + 25,216 on the last call
   * (2026-08-17). Zero and output-only readings are ignored rather than
   * written, so a provider that zeroes one source cannot empty a reading the
   * other supplied — which is the whole GLM case.
   */
  private latestCallContextTokens: number | undefined;

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: CLAUDE_PERMISSION_MODES,
    toolNames: [...CLAUDE_TOOL_NAMES],
    models: CLAUDE_MODELS,
    // docs/266 item 15 — the chat-native review flow needs a shell tool and a
    // subagent primitive; since docs/220 it needs no MCP surface. Claude Code
    // has Bash and Task.
    supportsReview: true,
    supportsSteering: true,
    // docs/178 — the CLI exposes `/compact` and emits `system/compact_boundary`
    // stream events we map to normalized compaction signals.
    supportsCompaction: true,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  private inner: ClaudeProcess | StreamingClaudeProcess;
  private _isStreaming = false;
  /**
   * docs/193 — the `--permission-prompt-tool` value to pass at spawn, set in
   * `writeMcpConfig` when the permission bridge is present. Routes the CLI's
   * built-in sensitive-file gate to ShipIt's approve/deny card instead of a
   * headless auto-deny. Undefined → flag omitted (gate auto-denies, the
   * pre-fix behavior — only when the bridge files are missing).
   */
  private _permissionPromptTool: string | undefined;

  /**
   * docs/150 — the local-mode agent factory passes `resolveHome` so the CLI
   * spawns with HOME at the provider account this session was routed to. Held
   * on the adapter (not only on `inner`) because the streaming swap in `run()`
   * constructs a second process, which needs the same override.
   */
  private readonly resolveHome: AgentHomeResolver | undefined;

  constructor(inner?: ClaudeProcess, opts?: { resolveHome?: AgentHomeResolver }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.inner = inner ?? new ClaudeProcess(this.resolveHome);
    this.wireEvents(this.inner);
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /** Forward and translate events from the inner process. */
  private wireEvents(proc: ClaudeProcess | StreamingClaudeProcess): void {
    proc.on("event", (raw: ClaudeEvent) => {
      // docs/088: surface MCP connection status from init event
      if (raw.type === "system" && raw.subtype === "init" && raw.mcp_servers) {
        const statuses = raw.mcp_servers.map(mapCliMcpStatus);
        if (statuses.length > 0) {
          this.emit("mcp_status", statuses);
        }
      }

      const mapped = this.mapEvent(raw);
      if (mapped) {
        this.emit("event", mapped);
      }
    });

    proc.on("done", (code: number) => {
      this.emit("done", code);
    });

    proc.on("error", (err: Error) => {
      this.emit("error", err);
    });

    proc.on("auth_required", () => {
      this.emit("auth_required");
    });

    proc.on("log", (source: string, text: string) => {
      this.emit("log", source, text);
    });
  }

  /**
   * Record one model call's prompt size from whichever event carried it.
   * See {@link latestCallContextTokens} for why there are two sources.
   */
  private recordCallContext(usage: ClaudeUsageIteration | undefined): void {
    if (!usage) return;
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    // An output-only, zeroed or empty usage object has no context reading. Do
    // not turn it into an authoritative zero that empties the dial.
    if (contextTokens > 0) this.latestCallContextTokens = contextTokens;
  }

  /** Convert a raw ClaudeEvent into the normalized AgentEvent schema. */
  private mapEvent(raw: ClaudeEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        // The CLI's `system` events are discriminated by `subtype`. Only `init`
        // is the session handshake; `status`/`compact_boundary` carry the
        // docs/178 compaction signals. Before docs/178 this case mapped EVERY
        // system event to `agent_init` (the type only declared `subtype:"init"`),
        // so a `status`/`compact_boundary` event was silently turned into a bogus
        // init with an undefined sessionId — discriminating fixes that.
        switch (raw.subtype) {
          case "init":
            return {
              type: "agent_init",
              agentId: "claude",
              sessionId: raw.session_id,
              model: raw.model,
              tools: raw.tools,
              // docs/138 — authoritative guarded-mode availability signal.
              permissionMode: raw.permissionMode,
            };
          case "status":
            // docs/178 — the CLI reports `status:"compacting"` while it
            // summarizes context. Surface it as a transient progress signal;
            // ignore every other status (e.g. the docs/138 `"default"` noise).
            if (raw.status === "compacting") {
              return { type: "agent_compaction_started", trigger: "auto" };
            }
            return null;
          case "compact_boundary": {
            // docs/178 — compaction finished. Map the CLI's `compact_metadata`
            // into the normalized card fields (all best-effort / optional).
            const meta = raw.compact_metadata;
            const event: AgentEvent = { type: "agent_compacted" };
            if (meta?.trigger) event.trigger = meta.trigger;
            if (typeof meta?.pre_tokens === "number") event.preTokens = meta.pre_tokens;
            if (typeof meta?.post_tokens === "number") event.postTokens = meta.post_tokens;
            if (typeof meta?.duration_ms === "number") event.durationMs = meta.duration_ms;
            return event;
          }
          case "background_tasks_changed":
            // docs/235 — the LEVEL signal. `tasks` is the complete current list
            // (empty = drained), so this one event fully re-states the runner's
            // background-task state. Normalized to agent-neutral field names so
            // a future backend with the same concept maps onto it.
            return {
              type: "agent_background_tasks",
              tasks: (raw.tasks ?? []).map((t) => ({
                id: t.task_id,
                type: t.task_type,
                description: t.description,
              })),
            };
          case "task_notification":
            // docs/235 — the EDGE signal: a background task finished and the CLI
            // is waking itself. On the wire this is immediately followed by a
            // fresh `init` and eventually a `result`, with no user message in
            // between — i.e. a turn the orchestrator never started.
            //
            // `tool_use_id` and `usage` are carried, not dropped: for a
            // backgrounded subagent this event is the ONLY completion signal on
            // the wire (no second `tool_result` ever arrives for the Task), so
            // the id is what lets the orchestrator retire that card and the
            // summary is the report itself. docs/109 reqs 10–11.
            return {
              type: "agent_self_wake",
              taskId: raw.task_id,
              summary: raw.summary,
              status: raw.status,
              ...(raw.tool_use_id ? { toolUseId: raw.tool_use_id } : {}),
              ...(raw.usage
                ? {
                    usage: {
                      ...(typeof raw.usage.total_tokens === "number" ? { totalTokens: raw.usage.total_tokens } : {}),
                      ...(typeof raw.usage.tool_uses === "number" ? { toolUses: raw.usage.tool_uses } : {}),
                      ...(typeof raw.usage.duration_ms === "number" ? { durationMs: raw.usage.duration_ms } : {}),
                    },
                  }
                : {}),
            };
          case "task_started":
          case "task_updated":
            // docs/235 — deliberately dropped. Both are per-task deltas whose
            // effect is already covered by the authoritative
            // `background_tasks_changed` list that accompanies them; mapping
            // them too would mean maintaining a second, weaker view of the same
            // state.
            return null;
          case "task_progress":
            // Deliberately dropped, same reasoning as task_started/task_updated:
            // a per-task liveness ping ({task_id, tool_use_id, description,
            // usage, last_tool_name}) for a running background task, superseded
            // by the `background_tasks_changed` list and the task_notification
            // completion edge. Nothing in the transcript draws per-tick
            // subagent progress today.
            return null;
          case "thinking_tokens":
            // Deliberately dropped. A per-tick thinking-token estimate
            // ({estimated_tokens, estimated_tokens_delta}) — the most frequent
            // event in a real stream (50+ per turn). Authoritative token usage
            // arrives once, on `result`; mapping these would stream a second,
            // estimated counter nothing consumes.
            return null;
          default:
            return null;
        }

      case "stream_event":
        // Raw SSE passthrough (`--include-partial-messages`, service-routed
        // spawns only). Nothing here reaches the orchestrator — the CLI's own
        // `assistant` events already carry the content — but `message_delta`
        // is the only place some providers state a call's token usage.
        // The `parent_tool_use_id` guard is defensive: the CLI's schema carries
        // the field on these frames, but every frame observed under the flag —
        // including on a turn that ran a subagent — had it null, so subagent
        // calls appear not to be re-emitted at all.
        if (!raw.parent_tool_use_id && raw.event?.type === "message_delta") {
          this.recordCallContext(raw.event.usage);
        }
        return null;

      case "assistant":
        if (!raw.parent_tool_use_id) this.recordCallContext(raw.message.usage);
        return {
          type: "agent_assistant",
          content: raw.message.content,
          // Preserve parent_tool_use_id from nested subagent events so the
          // client can render the subagent's work under its parent Task tool
          // (109 — subagent transparency).
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "user":
        // docs/140 — surface the replay echo (--replay-user-messages) as a
        // delivery ACK rather than dropping it. The echo means the CLI accepted
        // this user message into a turn; the orchestrator matches it against the
        // steer it sent so an un-echoed steer (one that fell into the turn-end
        // gap) can be re-queued instead of silently lost. It is still NOT
        // rendered as chat — agent-listeners consumes `agent_user_replay` for
        // ack tracking and returns before the chat accumulator, so the inline
        // bubble that `message_steered` already rendered is not duplicated.
        if (raw.isReplay) {
          return { type: "agent_user_replay", text: textFromUserContent(raw.message.content) };
        }
        return {
          type: "agent_tool_result",
          content: raw.message.content,
          parentToolUseId: raw.parent_tool_use_id,
        };

      case "result": {
        const u = raw.usage;
        // Real per-turn context occupancy = the LAST iteration's input +
        // cache_read + cache_create. The top-level `usage.*_input_tokens`
        // values are sums across every API call in the turn, so using them
        // directly multiplies context size by the iteration count.
        let contextTokens: number | undefined;
        const lastIter = u?.iterations?.length
          ? u.iterations[u.iterations.length - 1]
          : undefined;
        if (lastIter) {
          contextTokens =
            (lastIter.input_tokens ?? 0) +
            (lastIter.cache_read_input_tokens ?? 0) +
            (lastIter.cache_creation_input_tokens ?? 0);
        } else {
          // DeepSeek, GLM and other Claude-compatible providers omit the
          // result-level iteration list (GLM sends `iterations: []`), so the
          // last top-level API call seen in the stream is the final prompt
          // size. Do not fall back to the result totals: those are sums across
          // calls and overstate context by roughly the call count — that is
          // exactly how a GLM turn reported 2.1M against a 1M window.
          contextTokens = this.latestCallContextTokens;
        }
        this.latestCallContextTokens = undefined;
        // Authoritative context window comes from `modelUsage.<model>.contextWindow`
        // (e.g. Opus 4.7 reports 1_000_000). Falls back to the static map on
        // the receiving end when undefined.
        const modelUsage = raw.modelUsage;
        let contextWindow: number | undefined;
        if (modelUsage) {
          // Prefer the largest reported window across models touched in the
          // turn (handles model switches mid-turn — keep the more permissive).
          for (const m of Object.values(modelUsage)) {
            if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
              contextWindow = m.contextWindow;
            }
          }
        }
        // The CLI's `subtype` is not a success/failure flag: an API-error turn
        // ends `subtype: "success"` with `is_error: true`, and the only
        // non-success subtypes are `error_during_execution` (an interrupt) and
        // `error_max_turns`. `"error"` — what this used to test for — is a
        // value the real CLI never emits, so `error` here was ALWAYS undefined
        // and everything gated on it was dead in production: the docs/182
        // turn-errored flag and the docs/150-multiple-provider-subscriptions req 7 quota-exhaustion stamp that
        // makes the next turn fail over to another account. Normalize both
        // signals into the adapter-neutral success/error status instead.
        const errored = raw.is_error === true || raw.subtype !== "success";
        return {
          type: "agent_result",
          status: errored ? "error" : "success",
          sessionId: raw.session_id,
          cost: raw.total_cost_usd !== null && raw.total_cost_usd !== undefined
            ? { totalUsd: raw.total_cost_usd }
            : undefined,
          tokens: u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
            ? {
                input: u.input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens,
                cacheWrite: u.cache_creation_input_tokens,
              }
            : undefined,
          contextTokens,
          contextWindow,
          durationMs: raw.duration_ms,
          error: errored ? raw.result : undefined,
          // docs/138 — normalize the CLI's snake_case classifier denials into
          // the camelCase shape the orchestrator consumes for inline surfacing.
          permissionDenials: raw.permission_denials?.length
            ? raw.permission_denials.map((d) => ({
                toolName: d.tool_name,
                toolUseId: d.tool_use_id,
                toolInput: d.tool_input,
              }))
            : undefined,
        };
      }

      case "rate_limit_event": {
        const info = raw.rate_limit_info;
        const type = info?.rateLimitType;
        // We only track the headline windows. seven_day_opus / seven_day_sonnet
        // / overage carry sub-quotas the badge UI doesn't render.
        if (type !== "five_hour" && type !== "seven_day") return null;
        const window = parseRateLimitWindow(info);
        if (!window) return null;
        if (type === "five_hour") {
          this.rateLimitSession = window;
        } else {
          this.rateLimitWeekly = window;
        }
        return {
          type: "agent_rate_limits",
          session: this.rateLimitSession,
          weekly: this.rateLimitWeekly,
        };
      }

      default:
        return null;
    }
  }

  run(params: AgentRunParams): void {
    // A resident streaming adapter serves many turns. Clear any reading left
    // by an abnormal prior turn that ended without a result event before the
    // next turn starts, or a result with no assistant usage could reuse it.
    this.latestCallContextTokens = undefined;
    if (params.useStreaming) {
      if (this._isStreaming) {
        // Persistent streaming process is already alive — send the next turn
        // via message injection instead of spawning a new process. (docs/140)
        this.sendUserMessage(params.prompt);
        return;
      }
      // First turn with streaming: swap in a StreamingClaudeProcess.
      const streaming = new StreamingClaudeProcess(this.resolveHome);
      // Remove previous inner process listeners before replacing
      this.inner.removeAllListeners();
      this.inner = streaming;
      this._isStreaming = true;
      this.wireEvents(streaming);
    }

    this.inner.run({
      prompt: params.prompt,
      sessionId: params.sessionId,
      systemPrompt: params.systemPrompt,
      images: params.images,
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      mcpConfigPath: params.mcpConfigPath,
      // docs/088 — names of enabled user MCP servers drive the tool allowlist.
      mcpServerNames: params.mcpServers
        ?.filter((s) => s.enabled)
        .map((s) => s.name),
      model: params.model,
      // docs/252 phase 3 — base URL + credential for the selected model's service.
      serviceRouting: params.serviceRouting,
      reasoningEffort: params.reasoningEffort,
      settingsPath: params.settingsPath,
      autoCreatePr: params.autoCreatePr,
      // docs/211 — sets SHIPIT_SANDBOX=1 so the branch-block hook self-gates off.
      sandbox: params.sandbox,
      // planning#267 — sets SHIPIT_GUARD_DESTRUCTIVE_GIT=1 so the same hook blocks
      // hand-rolled destructive git while the session sits on a merged branch.
      guardDestructiveGit: params.guardDestructiveGit,
      // docs/193 — set when writeMcpConfig registered the permission bridge.
      permissionPromptTool: this._permissionPromptTool,
    });
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    // Persistent streaming turns enter through this method, not run(). Clear
    // a reading left by an abnormal prior turn before accepting new input.
    this.latestCallContextTokens = undefined;
    if (this.inner instanceof StreamingClaudeProcess) {
      console.log(
        `[claude-adapter] sendUserMessage → streaming (bytes=${text.length}, text=${JSON.stringify(text.slice(0, 80))})`,
      );
      this.inner.sendUserMessage(text);
      return;
    }
    // docs/140 — the orchestrator's steering gate (`runner.isStreamingActive`)
    // should have routed around this branch when the resident process is a
    // one-shot ClaudeProcess. If we got here, the gate disagrees with the
    // adapter — silent no-op would make the user's message disappear with no
    // feedback. Log loudly, emit a server-facing log (so the Logs panel shows
    // a clear failure), and emit an `error` so wireAgentListeners surfaces
    // it in chat. The runner's error-path teardown is acceptable because the
    // alternative — silently swallowing the steer — was the bug the user kept
    // hitting.
    console.warn(
      `[claude-adapter] sendUserMessage called on non-streaming inner — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "log",
      "server",
      "Live steering failed: the agent process is not in streaming mode. The message was not delivered to the CLI.",
    );
    this.emit(
      "error",
      new Error(
        "Live steering could not deliver the message: the agent process is not streaming. Try sending again after the current turn finishes, or toggle live steering off.",
      ),
    );
  }

  writeStdin(data: string): void {
    this.inner.writeStdin(data);
  }

  interrupt(): void {
    this.inner.interrupt();
  }

  kill(): void {
    this.inner.kill();
  }

  /**
   * Change permission mode on the resident process. Only meaningful for the
   * persistent streaming process — the one-shot path re-applies the mode
   * at every spawn, so there's nothing to do here. ShipIt → CLI mapping
   * matches what `ClaudeProcess` / `StreamingClaudeProcess` push as
   * `--permission-mode` at spawn: `plan` → `"plan"`, `guarded` → `"auto"`
   * (the CLI's classifier-gated mode), `auto` / undefined → `"default"`
   * (the no-flag default the CLI reports in its init event).
   */
  setPermissionMode(mode: PermissionMode | undefined): void {
    if (!(this.inner instanceof StreamingClaudeProcess)) return;
    const cliMode =
      mode === "plan" ? "plan" : mode === "guarded" ? "auto" : "default";
    this.inner.setPermissionMode(cliMode);
  }

  /**
   * docs/178 — trigger a context compaction on the resident process by sending
   * the CLI's `/compact` slash command as a user message. Only meaningful on the
   * persistent streaming process (where a message can be injected mid/between
   * turn without a respawn) — the one-shot path has no resident process to
   * talk to between turns, so the orchestrator routes that case through
   * `run({ compact: true })` (a fresh `claude -p "/compact" --resume` turn)
   * instead and never calls this. When called on a non-streaming inner we log
   * and no-op rather than silently dropping (mirrors `sendUserMessage`).
   */
  compact(instructions?: string): void {
    if (this.inner instanceof StreamingClaudeProcess) {
      // docs/178 §4 — Claude's CLI honors custom-compaction args after the
      // slash command (`/compact <instructions>`); pass them through.
      const trimmed = instructions?.trim();
      this.inner.sendUserMessage(trimmed ? `/compact ${trimmed}` : "/compact");
      return;
    }
    console.warn(
      "[claude-adapter] compact() called on non-streaming inner — no resident process to compact (the orchestrator should have spawned a /compact turn instead)",
    );
  }

  /**
   * Write a per-turn JSON config file (`--mcp-config`) bundling the built-in
   * Playwright server, the internal review bridge (docs/125, when present),
   * and any user-configured MCP servers (docs/088 — `$secret:` placeholders
   * resolved against `process.env`). Each missing-secret server is reported
   * back to the worker so it can broadcast an `mcp_server_status` SSE event.
   *
   * NOTE on cwd: `--output-dir` only governs auto-generated filenames. When
   * the agent passes a `filename` to `browser_take_screenshot` (or any tool
   * with a suggestedFilename), `@playwright/mcp` resolves it relative to its
   * own `process.cwd()` via `workspaceFile()` — NOT relative to
   * `--output-dir`. If we let the server inherit the workspace as cwd,
   * screenshots like `shot.png` land in `/workspace/` and get auto-committed.
   * We work around this by launching the server through `sh -c` with an
   * explicit `cd` into the output dir so suggested filenames also stay out
   * of the repo. See coreBundle.js:`workspaceFile()` and
   * `resolveClientFilename()`.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const configPath = `/tmp/mcp-config-${Date.now()}.json`;
    // Built-in Playwright (browser) server — see playwright-mcp.ts for the
    // rationale behind the `sh -c` launch and the `--browser chromium` flag.
    const mcpServers: Record<string, unknown> = {
      playwright: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
      },
    };

    // planning#130 / docs/199 — ONE consolidated stdio bridge serves all of ShipIt's
    // internal tools under the single `shipit` server, instead of five separate
    // processes. The bridge (`mcp-shipit-bridge`) is launched via
    // node/tsx-by-absolute-path (mirroring the `gh`/`shipit` shim install — bare
    // `tsx` fails to resolve when the agent's cwd is a user repo without a tsx
    // dep) and the `SHIPIT_MCP_TOOLS` env selects which tools to expose. Claude
    // gets review (docs/125), present (docs/093), voice (docs/163), bug
    // (docs/164), and permission (docs/193) — NOT ask (it has a native
    // AskUserQuestion). Skipped if the bridge isn't present (stripped-down test
    // image) so agent start never fails on it.
    if (ctx.shipitBridge) {
      mcpServers.shipit = {
        command: ctx.shipitBridge.tsxBin,
        args: [ctx.shipitBridge.bridgePath],
        env: { SHIPIT_MCP_TOOLS: "present,voice,bug,permission,propose_actions" },
      };
      // The permission tool is the CLI's `--permission-prompt-tool` (set below
      // at run time): instead of auto-denying a gated sensitive-file edit in
      // headless mode, the CLI calls it, which surfaces an approve/deny card and
      // blocks on the answer. Never model-callable (kept out of allowed-tools).
      this._permissionPromptTool = "mcp__shipit__permission_prompt";
    } else {
      this._permissionPromptTool = undefined;
    }

    // docs/088: merge user-configured MCP servers. Configs arrive UNRESOLVED
    // — `$secret:` placeholders are substituted here against the worker's own
    // process.env (populated by 087's agent-env pipeline). A server that
    // references a missing secret is dropped and reported over SSE; it never
    // blocks agent start.
    //
    // We only emit `mcp_server_status` here for the *failure* case (missing
    // secret) — that's a definitive "this server is not going to start"
    // signal we know before the CLI runs. The matching `loaded` signal is
    // emitted later when the Claude CLI's init event reports the server as
    // `connected`; see `mcp_status` channel and `wireAgentEvents()` in the
    // worker. Emitting `loaded` here would be misleading: it would mean "we
    // sent the config" rather than "the connection succeeded."
    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        mcpServers[server.name] = resolved;
      } else {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
      }
    }

    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
    return {
      mcpConfigPath: configPath,
      cleanup: () => {
        try { fs.unlinkSync(configPath); } catch { /* ignore */ }
      },
    };
  }
}

/**
 * Translate a Claude CLI `mcp_servers[]` entry into ShipIt's
 * `McpServerStatus`. Observed CLI statuses: `"connected"`, `"failed"`,
 * `"needs-auth"`. Anything else is treated as a failure with the raw status
 * preserved in `reason` so we don't silently swallow a new CLI signal.
 *
 * `needs-auth` is mapped to `failed` (not a dedicated state) for Phase 1 —
 * the existing `McpServerState` union has no `needs-auth` value, and the
 * UI's red badge with the reason text conveys the right action ("connect via
 * the provider"). Phase 2's OAuth flow is what removes this gap properly.
 */
/**
 * Normalize the Claude CLI's `rate_limit_info` payload (one window) into the
 * shared `SubscriptionLimitsWindow` shape. `resetsAt` is Unix epoch seconds.
 *
 * **`utilization` is a 0–1 FRACTION here, not a percentage.** The CLI forwards
 * the upstream `anthropic-ratelimit-unified-{5h,7d}-utilization` response
 * header verbatim, and that header is a fraction. Verified against one account
 * at one moment: the headers read `0.06` / `0.66` while `/api/oauth/usage`
 * reported `6.0` / `67.0` for the same two windows. So we scale by 100 — the
 * opposite convention from `ClaudeLimitsProvider`'s `/api/oauth/usage` parse,
 * which is already 0–100 and must NOT be scaled. Reading this one as a
 * percentage is what made a real 92% session render as "5h 1%".
 *
 * `resetsAt` is required — without a reset time there's nothing to render. But
 * `utilization` is optional: Claude CLI 2.1.140 only includes it once a
 * warning threshold trips (anthropics/claude-code#50518), so at normal low
 * usage we get `{rateLimitType, resetsAt}` and nothing else. In that case we
 * return `usedPct: null` so the badge can render as countdown-only and
 * upgrade to a full meter the moment a later event carries a number.
 *
 * Returns null only when `resetsAt` is unusable.
 */
function parseRateLimitWindow(
  info: { utilization?: number; resetsAt?: number } | undefined,
): SubscriptionLimitsWindow | null {
  if (!info) return null;
  const { utilization, resetsAt } = info;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  // resetsAt is epoch seconds; tolerate a ms value defensively.
  const ms = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
  const resetAt = new Date(ms).toISOString();
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return { usedPct: null, resetAt };
  }
  // A fraction can't exceed 1 for a capped window, so a value above 1 means the
  // upstream scale changed to 0–100 — pass it through rather than multiplying a
  // real 42% into a pinned-at-100% false alarm.
  const pct = utilization > 1 ? utilization : utilization * 100;
  const usedPct = Math.min(100, Math.max(0, pct));
  return { usedPct, resetAt };
}

export function mapCliMcpStatus(entry: ClaudeMcpServerInit): McpServerStatus {
  switch (entry.status) {
    case "connected":
      return { name: entry.name, state: "loaded" };
    case "needs-auth":
      return {
        name: entry.name,
        state: "failed",
        reason: "authentication required",
      };
    case "failed":
      return { name: entry.name, state: "failed", reason: "connection failed" };
    default:
      return {
        name: entry.name,
        state: "failed",
        reason: `unknown status: ${entry.status}`,
      };
  }
}
