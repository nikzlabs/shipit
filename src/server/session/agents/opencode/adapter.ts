import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
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
import { opencodeModelArg, opencodeProviderConfig, isOpenCodeAccountRouting, opencodeAccountConfig, prepareOpenCodeAccountEnv } from "../../../shared/opencode-spawn-shaping.js";
import { parseOpencodeLine, OpencodeTurnAccumulator, type OpencodeEvent, type OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { normalizeOpencodeToolCall, normalizeOpencodeToolResult } from "./opencode-tool-normalizer.js";
import { compactOpencodeSession } from "./compaction.js";

import { ensureManagedOpenCodeData, readOpenCodeAccount, removeOpenCodeAccount } from "../../../shared/opencode-account.js";

const OPENCODE_REASONING = HARNESSES.find((h) => h.id === "opencode")?.capabilities.reasoning;

const ERROR_EXIT_GRACE_MS = 2_000;

// MCP children can prevent exit after the final step.
const STOP_EXIT_GRACE_MS = 5_000;

// One quiet operation can include a supported 30-minute review wait.
const STALL_DEADLINE_MS = 45 * 60_000;

const OPENCODE_LOG_SUBDIR = "log";

export class OpencodeAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "opencode";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...OPENCODE_TOOL_NAMES],
    models: [],
    ...(OPENCODE_REASONING ? { reasoning: OPENCODE_REASONING } : {}),
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: true,
    skillsDirName: ".opencode",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  // Separately interruptible server; it must not enter the turn CLI's exit machinery.
  private compactionProc: ChildProcess | null = null;
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
  private lastActivityAt = 0;
  private stallReason: string | null = null;
  private logDir: string | null = null;
  private stdinFailure: NodeJS.ErrnoException | null = null;
  private pendingMcpServers: Record<string, unknown> = {};
  private _isStreaming = false;
  private usingChatGPT = false;

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
    this.usingChatGPT = isOpenCodeAccountRouting(params.serviceRouting);
    this.emittedInit = false;
    this.stallReason = null;
    this.resumeSessionId = params.sessionId;

    const args = ["run", "--format", "json", "--auto"];
    if (params.sessionId) {
      args.push("--session", params.sessionId);
    }

    const config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };

    if (isOpenCodeAccountRouting(params.serviceRouting) && params.model) {
      Object.assign(config, opencodeAccountConfig(params.model));
      args.push("--model", `openai/${params.model}`);
    } else if (params.serviceRouting && params.model) {
      const provider = opencodeProviderConfig(params.serviceRouting, params.model);
      if (!provider) {
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
      args.push("--model", params.model);
    }

    if (params.reasoningEffort) {
      // The catalogue validates variants; OpenCode silently ignores unknown ones.
      args.push("--variant", params.reasoningEffort);
    }

    if (Object.keys(this.pendingMcpServers).length > 0) {
      config.mcp = this.pendingMcpServers;
    }

    if (params.systemPrompt) {
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

    const scopedHome = params.homeDir ?? this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    // Local mode has no entrypoint to prepare a dangling data-directory symlink.
    ensureOpencodeDataDir(home);
    let dataHome: string;
    try {
      dataHome = ensureManagedOpenCodeData(home);
      if (isOpenCodeAccountRouting(params.serviceRouting)) readOpenCodeAccount(dataHome, params.serviceRouting.credentialTarget.accountId);
      else removeOpenCodeAccount(dataHome);
    } catch (error) {
      this.cleanupTurnFiles();
      if (this.usingChatGPT) this.emit("auth_required");
      else this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const dataDir = path.join(dataHome, "opencode");
    this.logDir = dataDir ? path.join(dataDir, OPENCODE_LOG_SUBDIR) : null;
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_DATA_HOME: dataHome,
      // Bun can prefer inherited PWD over the actual cwd.
      PWD: params.cwd,
      OPENCODE_CONFIG: this.configPath,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    };
    // Scrub before delivery: auto-detected provider keys can redirect billing.
    scrubHarnessEnvCredentials(spawnEnv, "opencode");
    if (isOpenCodeAccountRouting(params.serviceRouting)) {
      spawnEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeAccountConfig(params.model!));
      prepareOpenCodeAccountEnv(spawnEnv);
    } else if (params.serviceRouting) {
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

    if (params.compact) {
      this.runCompaction(params, spawnEnv);
      return;
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
      // Prefer the CLI's explanation if it later produces a stream.
      console.warn(`[opencode] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
      this.stdinFailure = err;
    });

    this.proc.on("close", (exitCode, signal) => {
      this.clearErrorKillTimer();
      this.drainLines(true);
      this.drainStderrLines(true);
      this.cleanupTurnFiles();
      if (this.stdinFailure && !this.sawAnyEvent()) {
        this.emit("error", this.stdinFailure);
      } else {
        this.emitSynthesizedResult(exitCode, signal);
      }
      this.stdinFailure = null;
      this.emit("done", exitCode ?? 0);
      this.proc = null;
    });

    // Stdin avoids Linux's 128 KiB per-argument limit.
    this.proc.stdin?.write(params.prompt);
    this.proc.stdin?.end();
  }

  // CLI 1.18.18 buffers events until exit and can hang on an unfinished response.
  // Log mtimes postpone the deadline at operation boundaries, not within long calls.
  // The log is shared per home, so another spawn can also postpone this deadline.
  private armWatchdog(): void {
    this.lastActivityAt = Date.now();
    this.scheduleStallCheck(STALL_DEADLINE_MS);
  }

  private scheduleStallCheck(delay: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.onStallDeadline(), delay);
  }

  private onStallDeadline(): void {
    this.watchdog = null;
    const proc = this.proc;
    if (!proc) return;

    const lastSign = Math.max(this.lastActivityAt, this.readLogHeartbeat() ?? 0);
    const idleFor = Date.now() - lastSign;
    if (idleFor < STALL_DEADLINE_MS) {
      this.scheduleStallCheck(STALL_DEADLINE_MS - idleFor);
      return;
    }

    const minutes = Math.round(STALL_DEADLINE_MS / 60_000);
    this.stallReason =
      `The OpenCode CLI produced no output and showed no activity for ${minutes} minutes, ` +
      "so ShipIt ended the turn rather than waiting indefinitely. The usual cause is a " +
      "request to the model service that was accepted and never answered — the CLI has no " +
      "request timeout of its own. Check what the turn had already done before retrying it.";
    console.warn(`[opencode] stall deadline (${minutes}m) reached — ending the turn`);
    this.emit("log", "server", this.stallReason);
    killProcessTree(proc, "SIGTERM", { label: "opencode-stall" });
  }

  private readLogHeartbeat(): number | null {
    if (!this.logDir) return null;
    try {
      let newest = 0;
      for (const entry of fs.readdirSync(this.logDir)) {
        const { mtimeMs } = fs.statSync(path.join(this.logDir, entry));
        if (mtimeMs > newest) newest = mtimeMs;
      }
      return newest > 0 ? newest : null;
    } catch {
      return null;
    }
  }

  private sawAnyEvent(): boolean {
    const acc = this.accumulator;
    return acc.sessionId !== undefined || acc.sawStepFinish || acc.finalText.length > 0;
  }

  // OpenCode has no terminal result event. User interrupts stay silent;
  // adapter-initiated kills still settle the turn with its result.
  private emitSynthesizedResult(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const acc = this.accumulator;
    const stalled = this.stallReason !== null && !acc.sawFinalStop;
    if (
      signal !== null &&
      signal !== undefined &&
      !acc.sawFinalStop &&
      acc.errorMessage === undefined &&
      !stalled
    ) {
      return;
    }
    if (exitCode === 0 && !this.sawAnyEvent() && !stalled) {
      console.warn("[opencode] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    const errored =
      acc.errorMessage !== undefined ||
      stalled ||
      (exitCode !== null && exitCode !== 0 && !acc.sawFinalStop);
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
              this.stallReason ??
              `OpenCode exited with code ${String(exitCode)}${acc.sawStepFinish ? "" : " before finishing a step"}`,
          }
        : {}),
    });
  }

  // Every path must emit one result; no turn CLI exit handler will settle compaction.
  private runCompaction(params: AgentRunParams, spawnEnv: Record<string, string>): void {
    const sessionId = params.sessionId;
    let settled = false;
    const settle = (error?: string): void => {
      if (settled) return;
      settled = true;
      this.compactionProc = null;
      this.cleanupTurnFiles();
      this.emit("event", {
        type: "agent_result",
        status: error ? "error" : "success",
        sessionId: sessionId ?? "",
        ...(error ? { error } : {}),
      });
    };

    if (!sessionId) {
      settle("Cannot compact: this session has not run a turn yet.");
      return;
    }
    if (!params.model) {
      settle("Cannot compact: no model is selected for this session.");
      return;
    }

    this.emit("event", { type: "agent_compaction_started", trigger: "manual" });

    void (async () => {
      try {
        await compactOpencodeSession({
          sessionId,
          modelId: params.model!,
          providerId: isOpenCodeAccountRouting(params.serviceRouting) ? "openai" : "shipit",
          cwd: params.cwd,
          env: spawnEnv,
          spawnFn: this.spawnFn,
          onLog: (message) => this.emit("log", "opencode", message),
          onServerSpawned: (proc) => {
            this.compactionProc = proc;
          },
        });
        this.emit("event", { type: "agent_compacted", trigger: "manual" });
        settle();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[opencode] compaction failed: ${reason}`);
        settle(`Compaction failed: ${reason}`);
      }
    })();
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
      clearTimeout(this.stopKillTimer);
      this.stopKillTimer = null;
    }
    if (event.type === "step_finish" && this.accumulator.sawFinalStop && !this.stopKillTimer && this.proc) {
      this.stopKillTimer = setTimeout(() => {
        this.stopKillTimer = null;
        if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode" });
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
      if (this.usingChatGPT && (event.error?.data?.statusCode === 401 || /^Token refresh failed: (400|401|403)$/.test(event.error?.data?.message ?? ""))) {
        this.emit("auth_required");
      }
      this.emit("log", "server", `OpenCode error: ${this.accumulator.errorMessage ?? "unknown"}`);
      if (!this.errorKillTimer && this.proc) {
        this.errorKillTimer = setTimeout(() => {
          this.errorKillTimer = null;
          if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode-error" });
        }, ERROR_EXIT_GRACE_MS);
      }
    }
  }

  private mapEvent(event: OpencodeEvent): AgentEvent[] {
    switch (event.type) {
      case "text": {
        const part = event.part as { text?: string } | undefined;
        if (typeof part?.text !== "string" || part.text.length === 0) return [];
        const block: AgentContentBlock = { type: "text", text: part.text };
        return [{ type: "agent_assistant", content: [block] }];
      }
      case "tool_use": {
        // This wire has no start event; emit both halves to preserve message groups.
        const part = event.part as OpencodeToolPart & { id?: string };
        const callId = part.callID ?? part.id ?? `opencode-call-${Date.now()}`;
        const rawInput =
          typeof part.state?.input === "object" && part.state.input !== null
            ? (part.state.input as Record<string, unknown>)
            : {};
        const { name, input } = normalizeOpencodeToolCall(part.tool ?? "unknown", rawInput);
        const isError = part.state?.status === "error";
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
      default:
        return [];
    }
  }

  // Mid-turn compaction would race message writes. Use a separate compaction run.
  compact(_instructions?: string): void {
    console.warn(
      "[opencode-adapter] compact() called mid-turn — OpenCode has no resident process to compact (the orchestrator should have spawned a compaction run instead)",
    );
  }

  sendUserMessage(text: string): void {
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
    const compacting = this.compactionProc;
    if (compacting) killProcessTree(compacting, "SIGTERM", { label: "opencode-compaction" });

    const proc = this.proc;
    if (!proc) return;
    // Disarm first so the user's interrupt cannot become an adapter stall failure.
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    killChild(proc, "SIGINT");
    // SIGINT may not stop retries. Escalate only against the captured process.
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killProcessTree(proc, "SIGTERM", { label: "opencode-interrupt" });
    }, 5_000);
  }

  kill(): void {
    this.clearErrorKillTimer();
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode" });
    if (this.compactionProc) killProcessTree(this.compactionProc, "SIGTERM", { label: "opencode-compaction" });
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

  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, unknown> = {
      playwright: {
        type: "local",
        command: [PLAYWRIGHT_MCP_COMMAND, ...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
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
