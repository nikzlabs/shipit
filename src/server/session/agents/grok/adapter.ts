/**
 * GrokAdapter — spawn-per-turn `grok -p` implementing AgentProcess
 * (docs/274-grok-build-harness). Claude-shaped: NDJSON on stdout, one process
 * per turn.
 *
 * The wire is the reason this adapter is small. Grok Build's
 * `--output-format streaming-messages-json` is Claude Code's `stream-json`
 * **near verbatim** — `system`/`init`, `assistant`/`user` envelopes holding
 * Anthropic Messages objects, a terminal `result` with `total_cost_usd` and
 * `usage` — so the event mapping mirrors `claude/adapter.ts` rather than
 * inventing a vocabulary. Every fact below was verified against CLI 1.0.1 in a
 * container on 2026-08-18; the captures that prove them are replayed byte-for-
 * byte by `adapter.test.ts`.
 *
 * Three places it is NOT Claude, each load-bearing:
 *
 *  - **The prompt goes in a FILE** (`--prompt-file`), not on argv and not on
 *    stdin. `-p <PROMPT>` is argv, which has a 128 KiB per-argument ceiling on
 *    Linux that assembled prompts exceed; `--prompt-file` is first-party and
 *    was verified to run a full turn.
 *  - **The session id is PRE-ASSIGNED** (`-s <uuid>`), not parsed out of the
 *    stream. Verified: a new conversation adopts the caller's UUID and both the
 *    init and result events carry it back, so ShipIt never has to race the
 *    first event to learn what to resume.
 *  - **MCP config has exactly one delivery path: `$GROK_HOME/config.toml`.**
 *    There is no `--mcp-config` flag and no config-pointing env var — probed
 *    directly: `GROK_CONFIG` and `GROK_CONFIG_PATH` are both inert (the init
 *    event reported `mcp_servers: []` under each), and neither name appears in
 *    the binary. Writing the file into the config root works
 *    (`mcp_servers: [{name: "probe", status: "connected"}]`), so that is what
 *    this adapter does — and it rewrites only that ONE file, because
 *    `auth.json` and `sessions/` are its neighbours.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild } from "../../../shared/kill-child.js";
import { GROK_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
import { GROK_PERMISSION_MODES } from "../../../shared/types/agent-types.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentEvent,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  McpServerStatus,
} from "../agent-process.js";
import { resolveAgentHome, grokHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { parseGrokLine, type GrokEvent } from "./stream.js";
import { renderGrokConfigToml, type GrokMcpServer } from "./config-toml.js";

const GROK_REASONING = HARNESSES.find((h) => h.id === "grok")?.capabilities.reasoning;

/**
 * Harness-compatibility toggles, set explicitly on every spawn (docs/274).
 *
 * `grok inspect` shows Grok reading OTHER agents' project files by default —
 * Claude's and Cursor's skills, rules, agents, MCP servers, hooks and sessions,
 * plus Codex sessions — each behind a `GROK_<VENDOR>_<AREA>_ENABLED` toggle.
 * Left alone, a ShipIt turn would pick up `.claude/settings.json`, `.mcp.json`
 * and hook definitions behind ShipIt's back, on a repo ShipIt configured for a
 * different harness.
 *
 * So every toggle is stated rather than defaulted, and the two left ON are the
 * two ShipIt WANTS: `.claude/skills` disclosure (verified live — Grok surfaces
 * both `.grok/skills` and `.claude/skills`, which is why no symlink is needed)
 * and Claude rules (`CLAUDE.md`, alongside the `AGENTS.md` it reads natively).
 * Everything that could execute code or redirect a tool is off.
 */
const COMPAT_TOGGLES: Record<string, string> = {
  GROK_CLAUDE_SKILLS_ENABLED: "1",
  GROK_CLAUDE_RULES_ENABLED: "1",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_SESSIONS_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_SESSIONS_ENABLED: "0",
  GROK_CODEX_SESSIONS_ENABLED: "0",
};

/**
 * How long the process gets to exit on its own after the terminal `result`
 * before the adapter kills it.
 *
 * Grok exits promptly by itself in every observed run. This is the OpenCode
 * lesson applied pre-emptively rather than a defect being worked around: MCP
 * children can hold a CLI's event loop open indefinitely, and a turn that has
 * already delivered its result must not be what keeps the session busy.
 */
const RESULT_EXIT_GRACE_MS = 5_000;

export class GrokAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "grok";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    // Mirrors the catalogue row (docs/274): image INPUT unobserved, so false.
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: GROK_PERMISSION_MODES,
    toolNames: [...GROK_TOOL_NAMES],
    // Which models exist is a property of the service join, not the CLI
    // (docs/252); the registry resolves them. Nothing reads this field off a
    // live adapter (ProxyAgentProcess hardcodes its own stub).
    models: [],
    ...(GROK_REASONING ? { reasoning: GROK_REASONING } : {}),
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".grok",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  /** Injectable for tests — replays captured streams without a real CLI. */
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private promptPath: string | null = null;
  private systemPromptPath: string | null = null;
  /** The config.toml this adapter wrote, and what (if anything) was there before. */
  private configPath: string | null = null;
  private configBackup: string | null = null;
  private resultKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** The id this turn runs under — pre-assigned, so it is known before the CLI starts. */
  private turnSessionId = "";
  private sawResult = false;
  private sawAnyEvent = false;
  private latestCallContextTokens: number | undefined;
  /** Resolved MCP servers, captured by writeMcpConfig for run() to render. */
  private pendingMcpServers: Record<string, GrokMcpServer> = {};

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  /**
   * One process per turn, no resident stream. `startsOwnTurns` is false for the
   * same reason: this CLI cannot begin a turn ShipIt did not ask for.
   */
  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("Grok adapter: run() called while a turn is in flight"));
      return;
    }
    this.sawResult = false;
    this.sawAnyEvent = false;
    this.latestCallContextTokens = undefined;

    // Pre-assign rather than parse (verified live): `-s <uuid>` on a new
    // conversation is adopted verbatim and echoed on both init and result, so
    // the id ShipIt will resume with is known before the CLI has spoken. `-r`
    // takes over once there is one to resume.
    this.turnSessionId = params.sessionId ?? randomUUID();

    const args = [
      "--output-format", "streaming-messages-json",
      "--no-auto-update",
      "--cwd", params.cwd,
    ];
    args.push(params.sessionId ? "-r" : "-s", this.turnSessionId);

    // ShipIt's three permission modes onto Grok's wider native set. `auto` is
    // `--always-approve` (the container IS the sandbox); `guarded` is Grok's
    // own classifier-gated `auto`, which collides by name with ShipIt's — the
    // one place the two vocabularies use the same word for different things.
    switch (params.permissionMode) {
      case "plan":
        args.push("--permission-mode", "plan");
        break;
      case "guarded":
        args.push("--permission-mode", "auto");
        break;
      default:
        args.push("--always-approve");
        break;
    }

    if (params.model) args.push("-m", params.model);

    // No `--reasoning-effort`, deliberately, and not an oversight: in API-key
    // mode the CLI accepts the flag and drops it before the wire (recorder-
    // verified on two models — no effort field reaches the request body). The
    // catalogue row declares no levels for the same reason, so nothing should
    // reach this adapter with one; passing it anyway would advertise a control
    // ShipIt cannot deliver. Re-probe under planning#435 with a subscription.

    if (params.systemPrompt) {
      // `--rules <FILE>` APPENDS to the CLI's own system prompt;
      // `--system-prompt-override` would replace it, discarding Grok's own tool
      // instructions along with it. ShipIt's prompt is standing instructions,
      // not a replacement for the harness's operating manual.
      this.systemPromptPath = `/tmp/grok-system-prompt-${Date.now()}.md`;
      try {
        fs.writeFileSync(this.systemPromptPath, params.systemPrompt);
        args.push("--rules", this.systemPromptPath);
      } catch (err) {
        this.systemPromptPath = null;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    // Env discipline — the order is load-bearing and is claude/process.ts's:
    // HOME first, then the credential scrub, then service delivery, because the
    // scrub deletes the very variable the delivery writes.
    const scopedHome = this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    const configRoot = grokHome(home);
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // Stated explicitly rather than left to derive from HOME: this is the
      // directory holding auth.json, sessions/ and the config.toml written
      // below, and a silent disagreement between the two reads as an auth
      // failure rather than as a path error.
      GROK_HOME: configRoot,
      // The pinned binary must never self-replace (dependency policy). Belt
      // and braces with `--no-auto-update` above: the flag covers this
      // invocation, the env var covers anything it spawns.
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      DISABLE_TELEMETRY: "1",
      GROK_ERROR_REPORTING: "0",
      DISABLE_ERROR_REPORTING: "1",
      // Tags xAI's OAuth flow with the integrating product, the way T3 Code
      // sends `t3code` (docs/274, prior art). Inert on the key-billed path
      // ShipIt launches with; set now so the subscription work of planning#435
      // is not attributed to nobody.
      GROK_OAUTH2_REFERRER: "shipit",
      ...COMPAT_TOGGLES,
    };
    // Grok prefers `XAI_API_KEY` over its on-disk login, and `GROK_AUTH` /
    // `GROK_AUTH_PATH` redirect it at a different token store entirely — any
    // one of them inherited from the worker would silently bill the wrong
    // account. Scrub them all, then deliver exactly one.
    scrubHarnessEnvCredentials(spawnEnv, "grok");
    if (params.serviceRouting) {
      const routing = params.serviceRouting;
      const secret = process.env[routing.credentialSourceEnv];
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[grok] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      spawnEnv.GROK_XAI_API_BASE_URL = routing.baseUrl;
      console.log(
        `[grok] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    }

    // The prompt is a file, not argv (see the header). Written before the
    // config so a failure here leaves no config.toml behind to restore.
    this.promptPath = `/tmp/grok-prompt-${Date.now()}.txt`;
    try {
      fs.writeFileSync(this.promptPath, params.prompt);
    } catch (err) {
      this.promptPath = null;
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    args.push("--prompt-file", this.promptPath);

    this.writeConfigToml(configRoot);

    console.log(
      "[grok] spawning:", "grok", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn("grok", args, {
        cwd: params.cwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.armWatchdog();

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.armWatchdog();
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.armWatchdog();
      this.stderrBuffer += chunk.toString("utf-8");
      this.drainStderrLines();
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("close", (exitCode) => {
      this.clearTimers();
      this.drainLines(true);
      this.drainStderrLines(true);
      this.cleanupTurnFiles();
      if (!this.sawResult) this.emitSynthesizedResult(exitCode);
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });
  }

  /**
   * Warn-only inactivity watchdog (Claude parity — `claude/process.ts`).
   *
   * It deliberately does NOT kill, and Grok gives it a specific job: on an
   * upstream 5xx the CLI retries internally and emits NOTHING to stdout while
   * it does (observed against the recorder). A silent minute is therefore a
   * real state the CLI reaches on its own, not necessarily a hang — so this
   * narrates and leaves the decision to the user, whose interrupt is the
   * escape hatch.
   */
  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      console.warn("[grok] no output for 60s — the CLI may be retrying upstream (it is silent while it does)");
      this.emit("log", "server", "Warning: no output from the Grok CLI for 60 seconds. It may be retrying an upstream error; interrupting the turn is safe.");
    }, 60_000);
  }

  /**
   * Write the per-turn `config.toml` into the config root, preserving whatever
   * was there so the turn does not permanently own a file it shares with the
   * user's own settings.
   *
   * This file is the ONLY MCP delivery path (see the header). Failure is
   * warned and not fatal: a turn with no MCP servers is a degraded turn, while
   * a turn refused for a config write is no turn at all.
   */
  private writeConfigToml(configRoot: string): void {
    const target = path.join(configRoot, "config.toml");
    try {
      fs.mkdirSync(configRoot, { recursive: true });
      this.configBackup = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
      fs.writeFileSync(target, renderGrokConfigToml(this.pendingMcpServers));
      this.configPath = target;
    } catch (err) {
      console.warn(`[grok] could not write ${target}: ${String(err)} — the turn runs without MCP servers`);
      this.configPath = null;
      this.configBackup = null;
    }
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseGrokLine(line);
      if (!event) continue;
      this.handleEvent(event);
    }
    if (flush && this.buffer) this.buffer = "";
  }

  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.warn("[grok] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(raw: GrokEvent): void {
    this.sawAnyEvent = true;

    // docs/088 parity — the init event carries per-server MCP status, which is
    // what makes a dropped server visible instead of merely absent.
    if (raw.type === "system" && raw.subtype === "init" && raw.mcp_servers) {
      const statuses: McpServerStatus[] = raw.mcp_servers.map((s) =>
        s.status === "connected"
          ? { name: s.name, state: "loaded" }
          : { name: s.name, state: "failed", reason: `status: ${s.status}` },
      );
      if (statuses.length > 0) this.emit("mcp_status", statuses);
    }

    const mapped = this.mapEvent(raw);
    if (mapped) this.emit("event", mapped);

    if (raw.type === "result") {
      this.sawResult = true;
      // The turn is over as far as ShipIt is concerned. Grok exits on its own
      // promptly, so this timer normally never fires; it exists so an MCP
      // child holding the event loop open cannot keep the session busy.
      if (!this.resultKillTimer && this.proc) {
        this.resultKillTimer = setTimeout(() => {
          this.resultKillTimer = null;
          if (this.proc) killChild(this.proc, "SIGTERM");
        }, RESULT_EXIT_GRACE_MS);
      }
    }
  }

  /**
   * Record one model call's prompt size.
   *
   * Same rule as the Claude adapter's: real context occupancy is the LAST
   * call's `input + cache_read + cache_creation`, because the result event's
   * totals are sums across every call in the turn and would report a multiple
   * of the true prompt size. Grok's result carries no per-iteration list at
   * all, so this running value is the ONLY source — dropping it would leave
   * the context dial empty on every turn.
   */
  private recordCallContext(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void {
    if (!usage) return;
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    // An output-only or zeroed usage object has no context reading. Do not turn
    // it into an authoritative zero that empties the dial.
    if (contextTokens > 0) this.latestCallContextTokens = contextTokens;
  }

  /** Convert one raw Grok event into the normalized AgentEvent schema. */
  private mapEvent(raw: GrokEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        if (raw.subtype !== "init") return null;
        return {
          type: "agent_init",
          agentId: "grok",
          sessionId: raw.session_id ?? this.turnSessionId,
          ...(raw.model ? { model: raw.model } : {}),
          ...(raw.tools ? { tools: raw.tools } : {}),
        };

      case "assistant":
        // `parent_tool_use_id` is carried for parity with Claude's subagent
        // transparency, but it was NULL on every event of every capture,
        // including turns that ran `spawn_subagent` — Grok does not stream a
        // subagent's internals headlessly, only the spawn's tool_result. So
        // the transcript shows a subagent's report, never its work, and that
        // is the CLI's behaviour rather than a mapping gap.
        if (!raw.parent_tool_use_id) this.recordCallContext(raw.message?.usage);
        return {
          type: "agent_assistant",
          content: raw.message?.content ?? [],
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "user":
        // Grok has no `--replay-user-messages` equivalent, so unlike Claude
        // every `user` event on this wire is a tool result rather than a steer
        // echo. There is no `isReplay` branch because there is nothing that
        // would set it.
        return {
          type: "agent_tool_result",
          content: raw.message?.content ?? [],
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "result": {
        const u = raw.usage;
        // Token semantics are DISJOINT — verified arithmetically on a real
        // terminal event (29623 + 88128 + 0 + 857 + 0 = 118608 = the total), so
        // unlike Codex this backend needs no `<id>-token-usage.ts` normalizer
        // and these figures can be summed as they stand.
        const contextTokens = this.latestCallContextTokens;
        this.latestCallContextTokens = undefined;
        // Authoritative window from `modelUsage.<model>.contextWindow`; prefer
        // the largest across models touched in the turn, matching Claude.
        let contextWindow: number | undefined;
        for (const m of Object.values(raw.modelUsage ?? {})) {
          if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
            contextWindow = m.contextWindow;
          }
        }
        // `subtype` is not the success flag — the same trap Claude's adapter
        // documents. An API-error turn ends `subtype: "success"` with
        // `is_error: true`, so both signals decide it.
        const errored = raw.is_error === true || (raw.subtype !== undefined && raw.subtype !== "success");
        return {
          type: "agent_result",
          status: errored ? "error" : "success",
          sessionId: raw.session_id ?? this.turnSessionId,
          ...(typeof raw.total_cost_usd === "number" ? { cost: { totalUsd: raw.total_cost_usd } } : {}),
          ...(u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
            ? {
                tokens: {
                  input: u.input_tokens ?? 0,
                  output: u.output_tokens ?? 0,
                  ...(u.cache_read_input_tokens !== undefined ? { cacheRead: u.cache_read_input_tokens } : {}),
                  ...(u.cache_creation_input_tokens !== undefined ? { cacheWrite: u.cache_creation_input_tokens } : {}),
                },
              }
            : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(typeof raw.duration_ms === "number" ? { durationMs: raw.duration_ms } : {}),
          ...(errored ? { error: raw.result ?? `Grok ended the turn with subtype "${raw.subtype ?? "unknown"}"` } : {}),
        };
      }

      case "error":
        // The unauthenticated / fatal shape: `{"type":"error","message":…}` on
        // stdout followed by exit 1 (verified on an unauthenticated run). No
        // result ever follows, so the close handler synthesizes one from this.
        this.emit("log", "server", `Grok error: ${raw.message_text ?? "unknown"}`);
        return null;

      default:
        return null;
    }
  }

  /**
   * The result for a turn that ended without one — a crash, a fatal `error`
   * event, or a kill.
   *
   * A SIGNAL death emits nothing, matching the Claude one-shot contract, so a
   * user interrupt settles as *interrupted* rather than as a completed empty
   * turn. `close` passes the exit code alone; a killed process reports a null
   * code, which is exactly the case that must stay silent.
   */
  private emitSynthesizedResult(exitCode: number | null): void {
    if (exitCode === null) return;
    if (exitCode === 0 && !this.sawAnyEvent) {
      // Exit 0 having said nothing: not a success and not obviously an error —
      // no result, like Claude's silent zero-output turn. The orchestrator's
      // abnormal-exit path owns it.
      console.warn("[grok] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    if (exitCode === 0) return;
    this.emit("event", {
      type: "agent_result",
      status: "error",
      sessionId: this.turnSessionId,
      error: `Grok exited with code ${String(exitCode)} before producing a result`,
    });
  }

  sendUserMessage(text: string): void {
    // supportsSteering is false; the orchestrator's steering gate should never
    // route here. Mirror the Claude adapter's loud-failure contract rather than
    // silently dropping the user's message.
    console.warn(
      `[grok-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "error",
      new Error("Grok Build does not support live steering; the message was not delivered."),
    );
  }

  writeStdin(data: string): void {
    // stdin is `ignore` at spawn — the prompt travels by file, so there is no
    // channel to write to and pretending otherwise would drop bytes silently.
    console.warn(`[grok] writeStdin: this adapter spawns with no stdin — ${data.length} bytes dropped`);
  }

  interrupt(): void {
    // Captured at entry (CLAUDE.md: never read `this.proc` inside an async
    // callback) — this adapter instance is reused across turns, so a stale
    // escalation would otherwise SIGTERM the NEXT turn's process.
    const proc = this.proc;
    if (!proc) return;
    killChild(proc, "SIGINT");
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killChild(proc, "SIGTERM");
    }, 5_000);
  }

  kill(): void {
    this.clearTimers();
    if (this.proc) killChild(this.proc, "SIGTERM");
    this.cleanupTurnFiles();
  }

  private clearTimers(): void {
    for (const t of [this.resultKillTimer, this.interruptKillTimer, this.watchdog]) {
      if (t) clearTimeout(t);
    }
    this.resultKillTimer = null;
    this.interruptKillTimer = null;
    this.watchdog = null;
  }

  private cleanupTurnFiles(): void {
    for (const p of [this.promptPath, this.systemPromptPath]) {
      if (p) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    this.promptPath = null;
    this.systemPromptPath = null;
    // Restore rather than delete: this file is shared with whatever the user's
    // own config root held, and a turn that removed it would silently take
    // their settings with it.
    if (this.configPath) {
      try {
        if (this.configBackup === null) fs.unlinkSync(this.configPath);
        else fs.writeFileSync(this.configPath, this.configBackup);
      } catch {
        /* ignore */
      }
    }
    this.configPath = null;
    this.configBackup = null;
  }

  /**
   * Capture the MCP server set for the per-turn `config.toml` that `run()`
   * writes. There is no separate config path to hand back to the worker, so
   * the result carries only the cleanup.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, GrokMcpServer> = {
      playwright: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
      // The consolidated shipit bridge (planning#130 / docs/199). Tool subset
      // is this adapter's own: no `permission` tool, because headless Grok runs
      // `--always-approve` and there is no `--permission-prompt-tool` to route
      // a gate through; `ask` included even though Grok has a native
      // `ask_user_question`, because the native one is the CLI's own surface
      // and ShipIt's card is the one the transcript renders.
      servers.shipit = {
        command: ctx.shipitBridge.tsxBin,
        args: [ctx.shipitBridge.bridgePath],
        enabled: true,
        env: { SHIPIT_MCP_TOOLS: "present,voice,bug,ask,propose_actions" },
      };
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        const r = resolved as {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          headers?: Record<string, string>;
        };
        // ShipIt's stored shape is Claude-style ({command, args, env} or
        // {url, headers}); Grok's TOML wants the same fields with `transport`
        // naming the remote kinds (shape read off a real `grok mcp add` run).
        servers[server.name] = r.url
          ? {
              transport: "http",
              url: r.url,
              enabled: true,
              ...(r.headers ? { headers: r.headers } : {}),
            }
          : {
              command: r.command ?? "",
              args: r.args ?? [],
              enabled: true,
              ...(r.env ? { env: r.env } : {}),
            };
      } else {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
      }
    }

    this.pendingMcpServers = servers;
    return {
      cleanup: () => {
        this.pendingMcpServers = {};
      },
    };
  }
}
