import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import { OPENCODE2_TOOL_NAMES } from "../../../shared/agent-registry.js";
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
import { OPENCODE2_ROOT, opencode2Roots } from "../../../shared/opencode-harness.js";
import { readOpenCodeAccount } from "../../../shared/opencode-account.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import {
  isOpenCodeAccountRouting,
  opencode2ModelArg,
  opencodeAccountConfig,
  opencodeProviderConfig,
} from "../../../shared/opencode-spawn-shaping.js";
import { SHIPIT_PROVIDER_ID } from "../../../shared/spawn-routing.js";
import { parseOpencodeLine, OpencodeTurnAccumulator, type OpencodeEvent, type OpencodeToolPart } from "../../../shared/opencode-stream.js";
import { shipitToolSpec } from "../../mcp-tool-spec.js";
import { writeOpencodeTurnFiles, type OpencodeTurnFiles } from "../opencode/turn-files.js";
import { OpenCodeSubscriptionLimits } from "../opencode/subscription-limits.js";
import { normalizeOpencode2ToolCall, normalizeOpencode2ToolResult } from "./opencode2-tool-normalizer.js";
import {
  OPENCODE2_BIN,
  basicAuthorization,
  compactOpencode2Session,
  newServerPassword,
  readTurnSteps,
  spawnOpencode2Server,
  waitForMcpServers,
  waitForServerUrl,
  type FetchFn,
  type Opencode2Server,
} from "./server.js";
import { Opencode2Account, type Opencode2AccountTarget } from "./account.js";

const HARNESS = HARNESSES.find((h) => h.id === "opencode2");

const ERROR_EXIT_GRACE_MS = 2_000;
const INTERRUPT_ESCALATE_MS = 5_000;
// One quiet operation can include a supported 30-minute review wait.
const STALL_DEADLINE_MS = 45 * 60_000;
const ACCOUNT_RESYNC_DEBOUNCE_MS = 200;

// `question` and `websearch` need an interactive answer that `run` cancels; Code Mode's
// `execute` would hide edits from the transcript, and every MCP server sets codemode off.
const TURN_TOOLS: Readonly<Record<string, boolean>> = { question: false, websearch: false, execute: false };
const TOOLS_OFF: Readonly<Record<string, boolean>> = { "*": false };

interface TurnPlan {
  args: string[];
  env: Record<string, string>;
  files: OpencodeTurnFiles;
  dataRoot: string;
  account: Opencode2AccountTarget | undefined;
  mcpServerNames: string[];
}

export class Opencode2Adapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "opencode2";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...OPENCODE2_TOOL_NAMES],
    models: [],
    ...(HARNESS?.capabilities.reasoning ? { reasoning: HARNESS.capabilities.reasoning } : {}),
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: true,
    skillsDirName: ".opencode",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private readonly fetchFn: FetchFn;
  private active = false;
  private server: ChildProcess | null = null;
  private proc: ChildProcess | null = null;
  private serverHandle: Opencode2Server | null = null;
  private stopped = false;
  private buffer = "";
  private stderrBuffer = "";
  private accumulator = new OpencodeTurnAccumulator();
  private emittedInit = false;
  private resumeSessionId: string | undefined;
  private errorKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private stallReason: string | null = null;
  private logDir: string | null = null;
  private stdinFailure: NodeJS.ErrnoException | null = null;
  private pendingMcpServers: Record<string, unknown> = {};
  private usingChatGPT = false;
  private subscriptionLimits: OpenCodeSubscriptionLimits | undefined;
  private accountWatcher: fs.FSWatcher | null = null;
  private accountResyncTimer: NodeJS.Timeout | null = null;

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
    fetchFn?: FetchFn;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    if (this.active || this.subscriptionLimits) {
      this.emit("error", new Error("OpenCode 2 adapter: run() called while a turn is in flight"));
      return;
    }
    this.accumulator = new OpencodeTurnAccumulator();
    this.usingChatGPT = isOpenCodeAccountRouting(params.serviceRouting);
    this.emittedInit = false;
    this.stallReason = null;
    this.stopped = false;
    this.stdinFailure = null;
    this.resumeSessionId = params.sessionId;
    const plan = this.prepare(params);
    if (!plan) return;
    this.active = true;
    void this.execute(params, plan);
  }

  private prepare(params: AgentRunParams): TurnPlan | null {
    const args = ["run", "--format", "json", "--auto"];
    if (params.sessionId) args.push("--session", params.sessionId);

    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      tools: { ...(params.toolsOff ? TOOLS_OFF : TURN_TOOLS) },
    };
    const variant = params.reasoningEffort;
    if (isOpenCodeAccountRouting(params.serviceRouting) && params.model) {
      Object.assign(config, opencodeAccountConfig(params.model, "opencode2"));
      args.push("--model", opencode2ModelArg("openai", params.model, variant));
    } else if (params.serviceRouting && params.model) {
      const provider = opencodeProviderConfig(params.serviceRouting, params.model, "opencode2");
      if (!provider) {
        this.emit(
          "error",
          new Error(`OpenCode 2 cannot run ${params.serviceRouting.serviceId} over style ${params.serviceRouting.style}`),
        );
        return null;
      }
      config.provider = provider;
      args.push("--model", opencode2ModelArg(SHIPIT_PROVIDER_ID, params.model, variant));
    } else if (params.model) {
      args.push("--model", `${params.model}${variant ? `#${variant}` : ""}`);
    }
    const mcpServerNames = params.toolsOff ? [] : Object.keys(this.pendingMcpServers);
    if (mcpServerNames.length > 0) config.mcp = { servers: this.pendingMcpServers };

    const home = resolveAgentHome(params.homeDir ?? this.resolveHome?.());
    const roots = opencode2Roots(home);
    let account: Opencode2AccountTarget | undefined;
    try {
      // Local mode has no entrypoint to prepare a dangling credential-root symlink.
      ensureOpencodeDataDir(home, OPENCODE2_ROOT);
      for (const dir of [roots.data, roots.state, roots.config]) fs.mkdirSync(dir, { recursive: true });
      if (isOpenCodeAccountRouting(params.serviceRouting)) {
        account = { accountHome: roots.account, accountId: params.serviceRouting.credentialTarget.accountId };
        readOpenCodeAccount(account.accountHome, account.accountId);
      }
    } catch (error) {
      if (this.usingChatGPT) this.emit("auth_required");
      else this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return null;
    }
    this.logDir = path.join(roots.data, "opencode", "log");

    const password = newServerPassword();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // Bun can prefer inherited PWD over the actual cwd.
      PWD: params.cwd,
      // Own data, state and config roots: pointed at v1's, OpenCode 2 migrates them (req 2).
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      OPENCODE_CONFIG_DIR: roots.config,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
    };
    // Scrub before delivery: auto-detected provider keys can redirect billing.
    scrubHarnessEnvCredentials(env, "opencode2");
    if (isOpenCodeAccountRouting(params.serviceRouting)) {
      for (const name of Object.keys(env)) {
        if (name.startsWith("SHIPIT_CREDENTIAL_") || name.startsWith("OPENAI_")) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- provider-auth denylist.
          delete env[name];
        }
      }
    } else if (params.serviceRouting) {
      const routing = params.serviceRouting;
      const secret = process.env[routing.credentialSourceEnv];
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[opencode2] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.emit("auth_required");
        return null;
      }
      env[routing.credentialTarget.name] = secret;
      console.log(`[opencode2] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`);
    }

    let files: OpencodeTurnFiles;
    try {
      files = writeOpencodeTurnFiles(config, { home, cwd: params.cwd, systemPrompt: params.systemPrompt });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return null;
    }
    env.OPENCODE_CONFIG = files.configPath;
    if (account && (!params.compact || (params.sessionId && params.model))) {
      this.subscriptionLimits = new OpenCodeSubscriptionLimits({
        dataHome: account.accountHome,
        routeId: account.accountId,
        onLimits: (event) => this.emit("event", event),
        onFailure: (message) => this.emit("log", "server", message),
      });
      this.subscriptionLimits.start();
    }
    return { args, env, files, dataRoot: roots.data, account, mcpServerNames };
  }

  // Exactly one `done` per run(); a stopped turn emits no result unless it already finished.
  private async execute(params: AgentRunParams, plan: TurnPlan): Promise<void> {
    let exitCode = 1;
    let account: Opencode2Account | undefined;
    try {
      const server = spawnOpencode2Server(this.spawnFn, params.cwd, plan.env);
      this.server = server;
      server.on("error", () => { /* surfaced by waitForServerUrl */ });
      this.armWatchdog();
      const url = await waitForServerUrl(server);
      if (this.stopped) return;
      const handle: Opencode2Server = { url, authorization: basicAuthorization(plan.env.OPENCODE_PASSWORD) };
      this.serverHandle = handle;
      account = new Opencode2Account({
        dataRoot: plan.dataRoot,
        serverUrl: url,
        env: plan.env,
        cwd: params.cwd,
        spawnFn: this.spawnFn,
        onLog: (message) => this.emit("log", "server", message),
      });
      if (plan.account) {
        try {
          await account.sync(plan.account);
        } catch {
          if (this.stopped) return;
          this.emit("auth_required");
          this.emitResult({ error: "ChatGPT credentials for OpenCode 2 are unavailable or expired." });
          return;
        }
        this.watchAccount(account, plan.account);
      } else {
        await account.clear().catch(() => {
          this.emit("log", "server", "A ChatGPT credential could not be removed from OpenCode 2.");
        });
      }
      if (this.stopped) return;

      if (params.compact) {
        exitCode = await this.runCompaction(params, handle);
        return;
      }

      const { statuses, settled } = await waitForMcpServers(handle, params.cwd, plan.mcpServerNames, this.fetchFn, {
        isCancelled: () => this.stopped,
      });
      if (statuses.length > 0) this.emit("mcp_status", statuses);
      if (!settled) console.warn("[opencode2] MCP servers did not settle; sending the turn anyway");
      if (this.stopped) return;

      exitCode = await this.runClient(params, plan, handle);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[opencode2] turn failed: ${reason}`);
      if (!this.stopped) this.emitResult({ error: `OpenCode 2 could not run the turn: ${reason}` });
    } finally {
      account?.close();
      this.teardown(plan);
      this.finishSubscriptionLimits(() => {
        this.active = false;
        this.emit("done", exitCode);
      });
    }
  }

  private runClient(params: AgentRunParams, plan: TurnPlan, handle: Opencode2Server): Promise<number> {
    const args = [...plan.args, "--server", handle.url];
    console.log(
      "[opencode2] spawning:", OPENCODE2_BIN, plan.args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );
    const proc = this.spawnFn(OPENCODE2_BIN, args, { cwd: params.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.buffer = "";
    this.stderrBuffer = "";
    this.armWatchdog();
    return new Promise<number>((resolve) => {
      proc.stdout?.on("data", (chunk: Buffer) => {
        this.armWatchdog();
        this.buffer += chunk.toString("utf-8");
        this.drainLines();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        this.armWatchdog();
        this.stderrBuffer += chunk.toString("utf-8");
        this.drainStderrLines();
      });
      proc.on("error", (err) => {
        this.emit("error", err);
      });
      proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        console.warn(`[opencode2] stdin error (${err.code ?? "unknown"}): the prompt did not reach the CLI`);
        this.stdinFailure = err;
      });
      proc.on("close", (exitCode, signal) => {
        this.clearTimers();
        this.drainLines(true);
        this.drainStderrLines(true);
        this.proc = null;
        void this.settleClient(exitCode, signal, handle).finally(() => resolve(exitCode ?? 0));
      });
      // Stdin avoids Linux's 128 KiB per-argument limit; `run` blocks until it closes.
      proc.stdin?.write(params.prompt);
      proc.stdin?.end();
    });
  }

  private async settleClient(exitCode: number | null, signal: NodeJS.Signals | null, handle: Opencode2Server): Promise<void> {
    const sessionId = this.accumulator.sessionId ?? this.resumeSessionId;
    if (sessionId && this.sawAnyEvent()) {
      try {
        const steps = await readTurnSteps(handle, sessionId, this.fetchFn);
        if (steps.length > 0) this.accumulator.replaceSteps(steps);
      } catch (err) {
        console.warn(`[opencode2] could not read the turn's usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.stdinFailure && !this.sawAnyEvent()) {
      this.emit("error", this.stdinFailure);
      return;
    }
    this.emitSynthesizedResult(exitCode, signal);
  }

  private async runCompaction(params: AgentRunParams, handle: Opencode2Server): Promise<number> {
    const sessionId = params.sessionId;
    if (!sessionId) {
      this.emitResult({ error: "Cannot compact: this session has not run a turn yet." });
      return 1;
    }
    if (!params.model) {
      this.emitResult({ error: "Cannot compact: no model is selected for this session." });
      return 1;
    }
    this.emit("event", { type: "agent_compaction_started", trigger: "manual" });
    try {
      const providerID = isOpenCodeAccountRouting(params.serviceRouting) ? "openai" : SHIPIT_PROVIDER_ID;
      await compactOpencode2Session(handle, sessionId, { providerID, id: params.model }, this.fetchFn, {
        isCancelled: () => this.stopped,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[opencode2] compaction failed: ${reason}`);
      if (!this.stopped) this.emitResult({ sessionId, error: `Compaction failed: ${reason}` });
      return 1;
    }
    if (this.stopped) return 1;
    this.emit("event", { type: "agent_compacted", trigger: "manual" });
    this.emitResult({ sessionId });
    return 0;
  }

  private emitResult(opts: { sessionId?: string; error?: string }): void {
    this.emit("event", {
      type: "agent_result",
      status: opts.error ? "error" : "success",
      sessionId: opts.sessionId ?? this.accumulator.sessionId ?? this.resumeSessionId ?? "",
      ...(opts.error ? { error: opts.error } : {}),
    });
  }

  private watchAccount(account: Opencode2Account, target: Opencode2AccountTarget): void {
    try {
      this.accountWatcher = fs.watch(target.accountHome, { recursive: true, persistent: false }, () => {
        if (this.accountResyncTimer) clearTimeout(this.accountResyncTimer);
        this.accountResyncTimer = setTimeout(() => {
          this.accountResyncTimer = null;
          // A failed resync means the projection was revoked or expired; drop the stale credential.
          account.sync(target).catch(() => account.clear()).catch(() => {
            this.emit("log", "server", "OpenCode 2 could not apply a renewed ChatGPT credential.");
          });
        }, ACCOUNT_RESYNC_DEBOUNCE_MS);
      });
      this.accountWatcher.on("error", () => { this.accountWatcher?.close(); this.accountWatcher = null; });
    } catch {
      this.emit("log", "server", "OpenCode 2 cannot follow ChatGPT renewals during this turn.");
    }
  }

  private teardown(plan: TurnPlan): void {
    this.clearTimers();
    this.accountWatcher?.close();
    this.accountWatcher = null;
    if (this.accountResyncTimer) clearTimeout(this.accountResyncTimer);
    this.accountResyncTimer = null;
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode2" });
    // The server's MCP children go with its tree (docs/289).
    if (this.server) killProcessTree(this.server, "SIGTERM", { label: "opencode2-server" });
    this.server = null;
    this.serverHandle = null;
    plan.files.cleanup();
  }

  // CLI output can stop for minutes inside one model call; log mtimes mark operation boundaries.
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
    if (!this.active) return;
    const lastSign = Math.max(this.lastActivityAt, this.readLogHeartbeat() ?? 0);
    const idleFor = Date.now() - lastSign;
    if (idleFor < STALL_DEADLINE_MS) {
      this.scheduleStallCheck(STALL_DEADLINE_MS - idleFor);
      return;
    }
    const minutes = Math.round(STALL_DEADLINE_MS / 60_000);
    this.stallReason =
      `The OpenCode 2 CLI produced no output and showed no activity for ${minutes} minutes, ` +
      "so ShipIt ended the turn rather than waiting indefinitely. The usual cause is a " +
      "request to the model service that was accepted and never answered. Check what the " +
      "turn had already done before retrying it.";
    console.warn(`[opencode2] stall deadline (${minutes}m) reached — ending the turn`);
    this.emit("log", "server", this.stallReason);
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode2-stall" });
    else if (this.server) killProcessTree(this.server, "SIGTERM", { label: "opencode2-stall" });
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

  // The stream has no terminal event and omits the last step_finish, so exit decides.
  // A user stop reports nothing; the adapter's own error and stall kills still report.
  private emitSynthesizedResult(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const acc = this.accumulator;
    const stalled = this.stallReason !== null;
    if (this.stopped) return;
    if (signal !== null && acc.errorMessage === undefined && !stalled) return;
    if (exitCode === 0 && !this.sawAnyEvent() && !stalled) {
      console.warn("[opencode2] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    const errored = acc.errorMessage !== undefined || stalled || (exitCode !== null && exitCode !== 0);
    const tokens =
      acc.input > 0 || acc.output > 0
        ? { input: acc.input, output: acc.output, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite }
        : undefined;
    this.emit("event", {
      type: "agent_result",
      status: errored ? "error" : "success",
      sessionId: acc.sessionId ?? this.resumeSessionId ?? "",
      ...(acc.costUsd > 0 ? { cost: { totalUsd: acc.costUsd } } : {}),
      ...(tokens ? { tokens } : {}),
      ...(acc.contextTokens !== undefined ? { contextTokens: acc.contextTokens } : {}),
      ...(acc.requests.length > 0 ? { requests: acc.requests } : {}),
      ...(errored
        ? {
            error:
              acc.errorMessage ??
              this.stallReason ??
              `OpenCode 2 exited with code ${String(exitCode)}${this.sawAnyEvent() ? "" : " before producing any output"}`,
          }
        : {}),
    });
  }

  private finishSubscriptionLimits(settle: () => void): void {
    const limits = this.subscriptionLimits;
    if (limits) {
      void limits.finish().finally(() => {
        if (this.subscriptionLimits === limits) this.subscriptionLimits = undefined;
        settle();
      }).catch(() => { console.warn("[opencode2] turn settlement failed"); });
    } else settle();
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseOpencodeLine(line);
      if (event) this.handleEvent(event);
    }
  }

  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.warn("[opencode2] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(event: OpencodeEvent): void {
    this.accumulator.observe(event);
    if (!this.emittedInit && typeof event.sessionID === "string") {
      this.emittedInit = true;
      this.emit("event", {
        type: "agent_init",
        agentId: "opencode2",
        sessionId: event.sessionID,
        tools: [...OPENCODE2_TOOL_NAMES],
      });
    }
    for (const mapped of this.mapEvent(event)) this.emit("event", mapped);

    if (event.type === "error") {
      if (this.usingChatGPT && (event.error?.status === 401 || event.error?.type === "provider.auth")) {
        this.emit("auth_required");
      }
      this.emit("log", "server", `OpenCode 2 error: ${this.accumulator.errorMessage ?? "unknown"}`);
      // 2.1.1 exits right after an error line; the grace only bounds a future hang.
      if (!this.errorKillTimer && this.proc) {
        this.errorKillTimer = setTimeout(() => {
          this.errorKillTimer = null;
          if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode2-error" });
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
        // 2.x dropped `callID`: `part.id` carries the provider's call id.
        const part = event.part as OpencodeToolPart & { id?: string };
        const callId = part.callID ?? part.id ?? `opencode2-call-${Date.now()}`;
        const rawInput =
          typeof part.state?.input === "object" && part.state.input !== null
            ? (part.state.input as Record<string, unknown>)
            : {};
        const { name, input } = normalizeOpencode2ToolCall(part.tool ?? "unknown", rawInput);
        const isError = part.state?.status === "error";
        const output = normalizeOpencode2ToolResult(part.tool ?? "unknown", part.state?.output ?? "");
        return [
          { type: "agent_assistant", content: [{ type: "tool_use", id: callId, name, input }] },
          {
            type: "agent_tool_result",
            content: [{ type: "tool_result", tool_use_id: callId, content: output, ...(isError ? { is_error: true } : {}) }],
          },
        ];
      }
      default:
        return [];
    }
  }

  compact(_instructions?: string): void {
    console.warn(
      "[opencode2-adapter] compact() called mid-turn — OpenCode 2 has no resident process to compact (the orchestrator should have spawned a compaction run instead)",
    );
  }

  sendUserMessage(text: string): void {
    console.warn(
      `[opencode2-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit("error", new Error("OpenCode 2 does not support live steering; the message was not delivered."));
  }

  writeStdin(data: string): void {
    console.warn(`[opencode2] writeStdin: the turn's stdin is closed — ${data.length} bytes dropped`);
  }

  interrupt(): void {
    this.subscriptionLimits?.stop();
    if (!this.active) return;
    this.stopped = true;
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const proc = this.proc;
    const server = this.server;
    if (!proc) {
      // Still starting: stopping the server ends every startup wait.
      if (server) killProcessTree(server, "SIGTERM", { label: "opencode2-interrupt" });
      return;
    }
    killChild(proc, "SIGINT");
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killProcessTree(proc, "SIGTERM", { label: "opencode2-interrupt" });
      if (this.server === server && server) killProcessTree(server, "SIGTERM", { label: "opencode2-interrupt" });
    }, INTERRUPT_ESCALATE_MS);
  }

  kill(): void {
    this.subscriptionLimits?.stop();
    this.stopped = true;
    this.clearTimers();
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "opencode2" });
    if (this.server) killProcessTree(this.server, "SIGTERM", { label: "opencode2-server" });
  }

  private clearTimers(): void {
    for (const timer of [this.errorKillTimer, this.interruptKillTimer, this.watchdog]) {
      if (timer) clearTimeout(timer);
    }
    this.errorKillTimer = null;
    this.interruptKillTimer = null;
    this.watchdog = null;
  }

  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    // Code Mode is off for every server: `execute` is disabled, so its tools must be direct.
    const servers: Record<string, unknown> = {
      playwright: {
        type: "local",
        command: [PLAYWRIGHT_MCP_COMMAND, ...PLAYWRIGHT_MCP_ARGS],
        codemode: false,
      },
    };
    if (ctx.shipitBridge) {
      servers.shipit = {
        type: "local",
        command: [ctx.shipitBridge.tsxBin, ctx.shipitBridge.bridgePath],
        codemode: false,
        environment: { SHIPIT_MCP_TOOLS: shipitToolSpec("present,voice,bug,ask,propose_actions,propose_repo_session,propose_session_message", ctx) },
      };
    }
    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (resolved) {
        const r = resolved as { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
        servers[server.name] = r.url
          ? { type: "remote", url: r.url, codemode: false, ...(r.headers ? { headers: r.headers } : {}) }
          : {
              type: "local",
              command: [r.command ?? "", ...(r.args ?? [])],
              codemode: false,
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
