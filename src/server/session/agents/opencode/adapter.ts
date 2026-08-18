/**
 * OpencodeAdapter — spawn-per-turn `opencode run` implementing AgentProcess
 * (docs/268-opencode-harness). Claude-shaped: JSONL on stdout, prompt on stdin
 * then EOF, one process per turn.
 *
 * What makes this adapter different from the other two is the terminal
 * contract (req 4): OpenCode has **no terminal result event**, its stdout is
 * block-buffered (events can be lost on kill), and after a fatal API error the
 * CLI emits `{"type":"error"}` and then hangs forever. So:
 *
 *  - `agent_result` is synthesized from **process exit**, never from a stream
 *    event, out of the `OpencodeTurnAccumulator`'s running state;
 *  - an `error` event marks the turn failed AND schedules a kill — waiting for
 *    a self-exit that never comes would strand the turn;
 *  - a turn whose final `step_finish` was dropped still resolves correctly,
 *    which the adapter test locks with a truncated real capture.
 *
 * All wire facts verified against CLI 1.18.15 (docs/268 plan.md, Phase 0).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild } from "../../../shared/kill-child.js";
import { OPENCODE_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentContentBlock,
  AgentEvent,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "../agent-process.js";
import { resolveAgentHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import { ensureOpencodeDataDir } from "../../../shared/opencode-data-dir.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { opencodeModelArg, opencodeProviderConfig } from "../../../shared/opencode-spawn-shaping.js";
import { parseOpencodeLine, OpencodeTurnAccumulator, type OpencodeEvent, type OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { normalizeOpencodeToolCall, normalizeOpencodeToolResult } from "./opencode-tool-normalizer.js";

const OPENCODE_REASONING = HARNESSES.find((h) => h.id === "opencode")?.capabilities.reasoning;

/**
 * How long after a fatal `error` event the process gets before it is killed.
 * Nonzero only to let a straggling flush land; the CLI does not exit on its
 * own after a fatal error (verified — it hangs indefinitely).
 */
const ERROR_EXIT_GRACE_MS = 2_000;

/**
 * How long after the turn's final `step_finish` the process gets to exit on
 * its own before the adapter kills it. Without MCP servers the CLI exits
 * promptly; with them it never exits at all (verified live — the MCP children
 * keep the Bun event loop alive), and every production turn has MCP servers.
 */
const STOP_EXIT_GRACE_MS = 5_000;

export class OpencodeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "opencode";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    // Mirrors the catalogue row (docs/268): unobserved, so declared false.
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...OPENCODE_TOOL_NAMES],
    // Which models exist is a property of the service join, not the CLI
    // (docs/252); the registry resolves them. Nothing reads this field off a
    // live adapter (ProxyAgentProcess hardcodes its own stub).
    models: [],
    ...(OPENCODE_REASONING ? { reasoning: OPENCODE_REASONING } : {}),
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".opencode",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  /** Injectable for tests — replays captured streams without a real CLI. */
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private accumulator = new OpencodeTurnAccumulator();
  private emittedInit = false;
  private resumeSessionId: string | undefined;
  private configPath: string | null = null;
  private systemPromptPath: string | null = null;
  private errorKillTimer: NodeJS.Timeout | null = null;
  private stopKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stdinFailure: NodeJS.ErrnoException | null = null;
  /** Resolved user MCP servers, captured by writeMcpConfig for run() to merge. */
  private pendingMcpServers: Record<string, unknown> = {};
  private _isStreaming = false;

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("OpenCode adapter: run() called while a turn is in flight"));
      return;
    }
    this.accumulator = new OpencodeTurnAccumulator();
    this.emittedInit = false;
    this.resumeSessionId = params.sessionId;

    const args = ["run", "--format", "json", "--auto"];
    if (params.sessionId) {
      args.push("--session", params.sessionId);
    }

    // Per-spawn config: ShipIt's provider block (+ variants), the MCP servers
    // writeMcpConfig captured, and the system-prompt file as an instruction.
    // Delivered via OPENCODE_CONFIG, which merges AFTER global/project config
    // (verified), so a user repo's own opencode.json stays honored underneath.
    const config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };

    if (params.serviceRouting && params.model) {
      const provider = opencodeProviderConfig(params.serviceRouting, params.model);
      if (!provider) {
        // A style this harness cannot speak, or a non-env credential target —
        // the catalogue join should have prevented both. Refuse rather than
        // spawn a turn that would route to the wrong place (same backstop rule
        // as codexProviderArgs).
        this.emit(
          "error",
          new Error(
            `OpenCode cannot run ${params.serviceRouting.serviceId} over style ${params.serviceRouting.style}`,
          ),
        );
        return;
      }
      config.provider = provider;
      args.push("--model", opencodeModelArg(params.model));
    } else if (params.model) {
      // No routing — pass the model through verbatim (a `provider/model` id
      // reaching OpenCode's own registry). Not a path ShipIt's catalogue
      // produces today: OpenCode has no native service and every key-mode join
      // carries routing. Kept because dropping the model silently would be
      // worse than forwarding it.
      args.push("--model", params.model);
    }

    if (params.reasoningEffort) {
      // Validated by the catalogue's declared option list, NOT by the CLI —
      // OpenCode silently ignores an unknown variant (verified).
      args.push("--variant", params.reasoningEffort);
    }

    if (Object.keys(this.pendingMcpServers).length > 0) {
      config.mcp = this.pendingMcpServers;
    }

    if (params.systemPrompt) {
      // OpenCode has no system-prompt flag; the config `instructions` array
      // injects a file's content as standing instructions alongside AGENTS.md.
      this.systemPromptPath = `/tmp/opencode-system-prompt-${Date.now()}.md`;
      fs.writeFileSync(this.systemPromptPath, params.systemPrompt);
      config.instructions = [this.systemPromptPath];
    }

    this.configPath = `/tmp/opencode-config-${Date.now()}.json`;
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Env discipline (order is load-bearing, same as claude/process.ts): HOME
    // first, then the credential scrub, then service delivery — the scrub
    // deletes the very variable the delivery writes.
    const scopedHome = this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    // `$HOME/.local/share/opencode` is a symlink into the credentials tree in
    // every image, and OpenCode's bootstrap mkdir dies EEXIST on it while the
    // target is missing — a dangling symlink IS an existing directory entry, so
    // no privilege level gets past it. In a container the entrypoint has already
    // made it at boot and this is a directory read; local/dogfood mode has no
    // entrypoint, and the sub-agent and PR-description spawns there do not go
    // through the link-clearing that the pinned agent's own turn does.
    ensureOpencodeDataDir(home);
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // The CLI resolves its project directory from $PWD when the variable is
      // present (Bun honors it over the real cwd), and a worker's own PWD
      // points at the worker, not the workspace — verified live: the turn's
      // writes landed in the parent process's directory. Pin it to the spawn
      // cwd so the two cannot disagree.
      PWD: params.cwd,
      OPENCODE_CONFIG: this.configPath,
      // The pinned binary must never self-replace (dependency policy), and a
      // container must not reach for models.dev, LSP downloads, or the share
      // service — routing is fully explicit in the provider block above.
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    };
    // OpenCode auto-detects every well-known provider key env var, any of
    // which would out-prefer the provider block's explicit credential and
    // silently re-route billing. Scrub them all, then deliver exactly one.
    scrubHarnessEnvCredentials(spawnEnv, "opencode");
    if (params.serviceRouting) {
      const routing = params.serviceRouting;
      const secret = process.env[routing.credentialSourceEnv];
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[opencode] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      console.log(
        `[opencode] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    }

    console.log(
      "[opencode] spawning:", "opencode", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn("opencode", args, {
        cwd: params.cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.proc = null;
      return;
    }

    this.buffer = "";
    this.stderrBuffer = "";
    this.stdinFailure = null;
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

    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // Held, not emitted (Claude's contract): the CLI may still produce a
      // stream that explains itself; only a turn that produced NOTHING gets
      // torn down with this as the reason at close.
      console.warn(`[opencode] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
      this.stdinFailure = err;
    });

    this.proc.on("close", (exitCode, signal) => {
      this.clearErrorKillTimer();
      // Flush whatever the block-buffered stdout managed to deliver.
      this.drainLines(true);
      this.drainStderrLines(true);
      this.cleanupTurnFiles();
      if (this.stdinFailure && !this.sawAnyEvent()) {
        // The prompt provably never landed and the CLI said nothing — the one
        // case that must not read as an empty success (Claude's rule).
        this.emit("error", this.stdinFailure);
      } else {
        this.emitSynthesizedResult(exitCode, signal);
      }
      this.stdinFailure = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // The prompt goes over stdin (verified: `opencode run` with no positional
    // message reads it) — argv has a 128 KiB per-argument ceiling on Linux and
    // assembled prompts can exceed it.
    this.proc.stdin?.write(params.prompt);
    this.proc.stdin?.end();
  }

  /**
   * Warn-only inactivity watchdog (Claude parity — `claude/process.ts`). It
   * deliberately does NOT kill: OpenCode emits tool events only at completion,
   * so a long-running bash tool call is legitimately silent for minutes. The
   * residual risk it narrates — a dropped final `step_finish` while MCP
   * children hold the process open — is terminated by the user's interrupt,
   * which (signal-aware synthesis above) settles as interrupted.
   */
  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      console.warn("[opencode] no output for 60s — the CLI may be stuck (retry loop, or a lost final event with MCP servers holding it open)");
      this.emit("log", "server", "Warning: no output from the OpenCode CLI for 60 seconds. It may be stuck; interrupting the turn is safe.");
    }, 60_000);
  }

  /** Whether the stream produced anything at all this turn. */
  private sawAnyEvent(): boolean {
    const acc = this.accumulator;
    return acc.sessionId !== undefined || acc.sawStepFinish || acc.finalText.length > 0;
  }

  /**
   * The synthesized terminal result (req 4) — the ONLY producer of
   * agent_result. Signal-aware: a SIGNAL death without a completed turn emits
   * NO result at all, matching the Claude one-shot contract, so a user
   * interrupt settles as *interrupted* (`runner.wasInterrupted`) rather than
   * as a completed empty turn. The two deliberate self-kills — the post-error
   * kill (errorMessage set) and the post-final-step stop-kill (sawFinalStop) —
   * still resolve, as error and success respectively.
   */
  private emitSynthesizedResult(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const acc = this.accumulator;
    if (signal !== null && signal !== undefined && !acc.sawFinalStop && acc.errorMessage === undefined) return;
    if (exitCode === 0 && !this.sawAnyEvent()) {
      // Exit 0 having said nothing: not a success, and not obviously an error
      // either — no result, like Claude's silent zero-output turn; the
      // orchestrator's abnormal-exit path owns it.
      console.warn("[opencode] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    const errored = acc.errorMessage !== undefined || (exitCode !== null && exitCode !== 0 && !acc.sawFinalStop);
    const tokens =
      acc.input > 0 || acc.output > 0
        ? {
            input: acc.input,
            output: acc.output,
            cacheRead: acc.cacheRead,
            cacheWrite: acc.cacheWrite,
          }
        : undefined;
    this.emit("event", {
      type: "agent_result",
      status: errored ? "error" : "success",
      sessionId: acc.sessionId ?? this.resumeSessionId ?? "",
      ...(acc.costUsd > 0 ? { cost: { totalUsd: acc.costUsd } } : {}),
      ...(tokens ? { tokens } : {}),
      ...(acc.contextTokens !== undefined ? { contextTokens: acc.contextTokens } : {}),
      ...(errored
        ? {
            error:
              acc.errorMessage ??
              `OpenCode exited with code ${String(exitCode)}${acc.sawStepFinish ? "" : " before finishing a step"}`,
          }
        : {}),
    });
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseOpencodeLine(line);
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
      console.warn("[opencode] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(event: OpencodeEvent): void {
    this.accumulator.observe(event);

    if (event.type === "step_start" && this.stopKillTimer) {
      // A new step after a non-tool-calls finish — the "final" guess was
      // wrong; let the turn continue.
      clearTimeout(this.stopKillTimer);
      this.stopKillTimer = null;
    }
    if (event.type === "step_finish" && this.accumulator.sawFinalStop && !this.stopKillTimer && this.proc) {
      // The turn's final step completed. The CLI exits promptly on its own
      // when no MCP servers are configured — but with them it NEVER does
      // (see STOP_EXIT_GRACE_MS), so the adapter owns termination. The close
      // handler synthesizes the (successful) result either way.
      this.stopKillTimer = setTimeout(() => {
        this.stopKillTimer = null;
        if (this.proc) killChild(this.proc, "SIGTERM");
      }, STOP_EXIT_GRACE_MS);
    }
    if (!this.emittedInit && typeof event.sessionID === "string") {
      this.emittedInit = true;
      this.emit("event", {
        type: "agent_init",
        agentId: "opencode",
        sessionId: event.sessionID,
        tools: [...OPENCODE_TOOL_NAMES],
      });
    }

    const mapped = this.mapEvent(event);
    for (const e of mapped) this.emit("event", e);

    if (event.type === "error") {
      // The CLI does not exit after a fatal error (verified — it hangs), so
      // the adapter owns termination: give a straggling flush a moment, then
      // kill. The close handler synthesizes the failed result.
      this.emit("log", "server", `OpenCode error: ${this.accumulator.errorMessage ?? "unknown"}`);
      if (!this.errorKillTimer && this.proc) {
        this.errorKillTimer = setTimeout(() => {
          this.errorKillTimer = null;
          if (this.proc) killChild(this.proc, "SIGTERM");
        }, ERROR_EXIT_GRACE_MS);
      }
    }
  }

  /** Map one OpenCode event to zero or more normalized AgentEvents. */
  private mapEvent(event: OpencodeEvent): AgentEvent[] {
    switch (event.type) {
      case "text": {
        const part = event.part as { text?: string } | undefined;
        if (typeof part?.text !== "string" || part.text.length === 0) return [];
        const block: AgentContentBlock = { type: "text", text: part.text };
        return [{ type: "agent_assistant", content: [block] }];
      }
      case "tool_use": {
        // One completed event carries the whole call (no started event on this
        // wire): surface the tool_use and its result back-to-back so the
        // message-group boundary contract (tool results split groups) holds.
        const part = event.part as OpencodeToolPart & { id?: string };
        const callId = part.callID ?? part.id ?? `opencode-call-${Date.now()}`;
        const rawInput =
          typeof part.state?.input === "object" && part.state.input !== null
            ? (part.state.input as Record<string, unknown>)
            : {};
        // Lowercase wire names miss every recognition registry (planning#432) —
        // translate to the transcript vocabulary before anything persists.
        const { name, input } = normalizeOpencodeToolCall(part.tool ?? "unknown", rawInput);
        const isError = part.state?.status === "error";
        // The task wrapper would be swallowed whole by the client's skipHtml
        // markdown (planning#434) — unwrap before anything persists.
        const output = normalizeOpencodeToolResult(part.tool ?? "unknown", part.state?.output ?? "");
        return [
          {
            type: "agent_assistant",
            content: [{ type: "tool_use", id: callId, name, input }],
          },
          {
            type: "agent_tool_result",
            content: [
              {
                type: "tool_result",
                tool_use_id: callId,
                content: output,
                ...(isError ? { is_error: true } : {}),
              },
            ],
          },
        ];
      }
      // step_start / step_finish / error carry no renderable content — the
      // accumulator already recorded what the synthesized result needs.
      default:
        return [];
    }
  }

  sendUserMessage(text: string): void {
    // supportsSteering is false; the orchestrator's steering gate should never
    // route here. Mirror the Claude adapter's loud-failure contract rather
    // than silently dropping the user's message.
    console.warn(
      `[opencode-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "error",
      new Error("OpenCode does not support live steering; the message was not delivered."),
    );
  }

  writeStdin(data: string): void {
    if (!this.proc?.stdin?.writable) {
      console.warn(`[opencode] writeStdin: stdin not writable — ${data.length} bytes dropped`);
      return;
    }
    this.proc.stdin.write(data);
  }

  interrupt(): void {
    // Capture at entry (CLAUDE.md: never read `this.proc` inside an async
    // callback) — this adapter instance is reused across turns, so a stale
    // escalation would otherwise SIGTERM the NEXT turn's process.
    const proc = this.proc;
    if (!proc) return;
    killChild(proc, "SIGINT");
    // The CLI is known to survive SIGINT while stuck in a retry loop; escalate.
    // Held on the adapter and cleared at close so it dies with the turn.
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killChild(proc, "SIGTERM");
    }, 5_000);
  }

  kill(): void {
    this.clearErrorKillTimer();
    if (this.proc) killChild(this.proc, "SIGTERM");
    this.cleanupTurnFiles();
  }

  private clearErrorKillTimer(): void {
    if (this.errorKillTimer) {
      clearTimeout(this.errorKillTimer);
      this.errorKillTimer = null;
    }
    if (this.stopKillTimer) {
      clearTimeout(this.stopKillTimer);
      this.stopKillTimer = null;
    }
    if (this.interruptKillTimer) {
      clearTimeout(this.interruptKillTimer);
      this.interruptKillTimer = null;
    }
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private cleanupTurnFiles(): void {
    for (const p of [this.configPath, this.systemPromptPath]) {
      if (p) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    this.configPath = null;
    this.systemPromptPath = null;
  }

  /**
   * Capture the MCP server set for the per-turn config file `run()` writes.
   * OpenCode reads MCP servers from its own config (`mcp` key), so there is no
   * separate `--mcp-config` path; everything lands in the OPENCODE_CONFIG file
   * and cleanup happens with the turn's other files.
   */
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, unknown> = {
      playwright: {
        type: "local",
        command: [PLAYWRIGHT_MCP_COMMAND, ...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
      // The consolidated shipit bridge (planning#130/docs/199). Tool subset is
      // this adapter's own: present/voice/bug/propose_actions/ask — ask
      // included because OpenCode has no native AskUserQuestion tool; no
      // permission tool because there is no --permission-prompt-tool
      // equivalent to route a gate through (runs are --auto).
      servers.shipit = {
        type: "local",
        command: [ctx.shipitBridge.tsxBin, ctx.shipitBridge.bridgePath],
        enabled: true,
        environment: { SHIPIT_MCP_TOOLS: "present,voice,bug,ask,propose_actions" },
      };
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        // ShipIt's stored shape is Claude-style ({command, args, env} or
        // {url, headers}); OpenCode wants {type, command[], environment} /
        // {type: "remote", url, headers}.
        const r = resolved as { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
        servers[server.name] = r.url
          ? {
              type: "remote",
              url: r.url,
              enabled: true,
              ...(r.headers ? { headers: r.headers } : {}),
            }
          : {
              type: "local",
              command: [r.command ?? "", ...(r.args ?? [])],
              enabled: true,
              ...(r.env ? { environment: r.env } : {}),
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
