import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import { ANTIGRAVITY_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
import { ANTIGRAVITY_PERMISSION_MODES } from "../../../shared/types/agent-types.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentContentBlock,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
} from "../agent-process.js";
import { resolveAgentHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import {
  antigravityCliModelId,
  hasAntigravityAccountToken,
  makeAntigravitySpawnHome,
  syncAntigravityModelProvider,
  type AntigravitySpawnHome,
} from "../../../shared/antigravity-home.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { normalizeAntigravityToolCall } from "./antigravity-tool-normalizer.js";
import {
  AntigravityUsageAccumulator,
  antigravityStderrErrorText,
  parseAntigravityLine,
  type AntigravityEvent,
  type AntigravityStepUpdate,
} from "../../../shared/antigravity-stream.js";

const CAPS = HARNESSES.find((h) => h.id === "antigravity")?.capabilities;
const REASONING = CAPS?.reasoning;

/** The CLI's own default is 5 minutes; a ShipIt turn routinely outlives that. */
const PRINT_TIMEOUT = "180m";

/**
 * `--effort` is REQUIRED whenever `--model` names a base id (probed on 1.2.2:
 * "--model gemini-3.8-flash requires --effort"). `high` is the one level every
 * offered model accepts, and it matches REVIEWER_DEFAULT_EFFORT so the two
 * cannot disagree.
 */
const DEFAULT_EFFORT = "high";

/** Read at spawn and handed to the model, because the CLI reads none of them itself. */
const REPO_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

const RESULT_EXIT_GRACE_MS = 5_000;

type McpServerEntry = Record<string, unknown>;

export class AntigravityAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "antigravity";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: ANTIGRAVITY_PERMISSION_MODES,
    toolNames: [...ANTIGRAVITY_TOOL_NAMES],
    models: [],
    ...(REASONING ? { reasoning: REASONING } : {}),
    // not-wired — the docs/266 item-15 depth-0 probe has NOT run: it needs a
    // live session on this harness, and no credential that can fund a review
    // turn was available. Everything the flow needs is in `init.tools`
    // (`run_command` + `command_status`, `invoke_subagent`, `view_file`), so
    // this is expected to flip to true; planning#543 tracks the probe. A
    // `false` hides the file-viewer button and leaves `/review` working.
    supportsReview: false,
    supportsSteering: false,
    supportsCompaction: false,
    supportsGoals: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  readonly isStreaming = false;

  private readonly resolveHome: AgentHomeResolver | undefined;
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private stderrAll = "";
  private spawnHome: AntigravitySpawnHome | null = null;
  private pendingMcpServers: Record<string, McpServerEntry> = {};
  private usage = new AntigravityUsageAccumulator();
  private turnSessionId = "";
  private sawResult = false;
  private resultDurationMs: number | undefined;
  private resultKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  /** A tool step reports twice (ACTIVE then DONE); the id correlates the pair. */
  private stepToolUseIds = new Map<number, string>();

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("Antigravity adapter: run() called while a turn is in flight"));
      return;
    }
    this.usage = new AntigravityUsageAccumulator();
    this.stepToolUseIds.clear();
    this.sawResult = false;
    this.resultDurationMs = undefined;
    this.buffer = "";
    this.stderrBuffer = "";
    this.stderrAll = "";
    this.turnSessionId = params.sessionId ?? "";

    if (params.compact) {
      // Probed on 1.2.2: /compact reaches the model as plain user text.
      this.emit("error", new Error("Antigravity has no compaction; the request was not sent."));
      return;
    }

    const credentialHome = resolveAgentHome(params.homeDir ?? this.resolveHome?.());
    const hasAccount = hasAntigravityAccountToken(credentialHome);

    const spawnEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    // Scrub first, then deliver: an ambient key must not out-prefer the account.
    scrubHarnessEnvCredentials(spawnEnv, "antigravity");
    let usingKey = false;
    const routing = params.serviceRouting;
    if (routing && !hasAccount) {
      const secret = routing.credentialSourceEnv ? process.env[routing.credentialSourceEnv] : undefined;
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[antigravity] no credential in the environment for ${routing.serviceId}`
          + `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      spawnEnv.GOOGLE_GEMINI_BASE_URL = routing.baseUrl;
      usingKey = true;
      console.log(`[antigravity] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`);
    } else if (hasAccount) {
      console.log("[antigravity] Google account token on disk — env credentials scrubbed so it cannot be out-preferred");
    } else if (process.env.GEMINI_API_KEY) {
      // Unrouted key-only runs (local mode, a bare container) still need the key.
      spawnEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      usingKey = true;
    }

    syncAntigravityModelProvider(credentialHome, usingKey);

    const home = makeAntigravitySpawnHome({
      credentialHome,
      plugin: {
        ...(this.pluginRules(params) ? { rules: this.pluginRules(params) } : {}),
        skillDirs: this.repoSkillDirs(params.cwd),
        mcpServers: this.pendingMcpServers,
      },
    });
    if (!home) {
      this.emit("error", new Error("Antigravity: could not create this turn's home. The turn was not started."));
      return;
    }
    this.spawnHome = home;
    spawnEnv.HOME = home.home;

    const args = [
      "--print=",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // req 8 — full-auto only at launch.
      "--dangerously-skip-permissions",
      "--print-timeout", PRINT_TIMEOUT,
    ];
    if (params.model) {
      args.push("--model", antigravityCliModelId(params.model));
      args.push("--effort", params.reasoningEffort ?? DEFAULT_EFFORT);
    }
    if (params.sessionId) args.push("--conversation", params.sessionId);

    console.log(
      "[antigravity] spawning:", args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn("antigravity", args, {
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

    // The prompt rides stdin, never argv: argv caps a single argument at 128 KiB.
    try {
      this.proc.stdin?.write(`${JSON.stringify({ event: "user", message: { content: params.prompt } })}\n`);
      this.proc.stdin?.end();
    } catch (err) {
      console.warn(`[antigravity] could not write the prompt to stdin: ${String(err)}`);
    }

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      this.stderrAll += text;
      this.stderrBuffer += text;
      this.drainStderrLines();
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("close", (exitCode) => {
      this.clearTimers();
      this.drainLines(true);
      this.drainStderrLines(true);
      // The result envelope is buffered and the single terminal event is emitted
      // here, because only this point knows the exit code (docs/301 outcome rule).
      this.emitTerminalResult(exitCode);
      this.cleanupTurnFiles();
      this.proc = null;
      this.emit("done", exitCode ?? 0);
    });
  }

  /**
   * The CLI reads no workspace AGENTS.md / CLAUDE.md / GEMINI.md in print mode
   * (probed on 1.2.2), and ShipIt's instruction builder does not include them
   * for any harness — so the plugin rule carries both ShipIt's system prompt and
   * the repository's own instructions, under a heading naming the file.
   */
  private pluginRules(params: AgentRunParams): string | undefined {
    const parts: string[] = [];
    if (params.systemPrompt) parts.push(params.systemPrompt);
    for (const name of REPO_INSTRUCTION_FILES) {
      let body: string;
      try {
        body = fs.readFileSync(path.join(params.cwd, name), "utf8");
      } catch {
        continue;
      }
      if (body.trim().length === 0) continue;
      parts.push(`# ${name} (this repository's own instructions)\n\n${body}`);
      break;
    }
    return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
  }

  /** docs/209 disclosure: the CLI follows symlinked skill directories (probed). */
  private repoSkillDirs(cwd: string): string[] {
    const root = path.join(cwd, ".claude", "skills");
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => path.join(root, e.name));
    } catch {
      return [];
    }
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    this.buffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseAntigravityLine(line);
      if (event) this.handleEvent(event);
    }
  }

  private drainStderrLines(flush = false): void {
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.warn("[antigravity] stderr:", trimmed.slice(0, 200));
      this.emit("log", "stderr", trimmed);
    }
  }

  private handleEvent(raw: AntigravityEvent): void {
    if (raw.event === "init") {
      const id = raw.conversation_id ?? this.turnSessionId;
      if (id) this.turnSessionId = id;
      this.emit("event", {
        type: "agent_init",
        agentId: "antigravity",
        sessionId: this.turnSessionId,
        ...(raw.init?.model ? { model: raw.init.model } : {}),
        ...(raw.init?.tools ? { tools: raw.init.tools } : {}),
        ...(raw.init?.permission_mode ? { permissionMode: raw.init.permission_mode } : {}),
      });
      return;
    }
    if (raw.event === "step_update") {
      if (raw.step_update) this.handleStep(raw.step_update);
      return;
    }
    // `result.status` and `result.error` describe the CONVERSATION, not this
    // turn: a recovered 503 reports ERROR with a complete answer, and a resumed
    // turn repeats the PREVIOUS turn's error. Only the duration is turn-local.
    this.sawResult = true;
    const seconds = raw.result?.duration_seconds;
    if (typeof seconds === "number") this.resultDurationMs = Math.round(seconds * 1000);
    if (!this.resultKillTimer && this.proc) {
      // MCP children can hold the process open past the result.
      this.resultKillTimer = setTimeout(() => {
        this.resultKillTimer = null;
        if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "antigravity" });
      }, RESULT_EXIT_GRACE_MS);
    }
  }

  private handleStep(step: AntigravityStepUpdate): void {
    this.usage.observe(step);
    switch (step.step_type) {
      case "agent_response": {
        if (step.text_delta) {
          this.emit("event", { type: "agent_assistant", content: [{ type: "text", text: step.text_delta }] });
        }
        break;
      }
      case "tool": {
        this.handleToolStep(step);
        break;
      }
      // An error_message step carries no text in any capture, and a mid-turn
      // error the CLI recovered from leaves nothing on stderr — so nothing is
      // invented for it; the exit code decides the turn's outcome at close.
      // A resumed print turn's system_message is Google's "subagents stopped
      // due to server restart" notice, which describes the spawn, not the turn.
      default:
        break;
    }
  }

  private handleToolStep(step: AntigravityStepUpdate): void {
    const index = step.step_index ?? -1;
    const rawName = step.tool_info?.name ?? step.tool_name;
    if (!rawName) return;
    if (step.state === "DONE") {
      const id = this.stepToolUseIds.get(index);
      this.stepToolUseIds.delete(index);
      if (!id) return;
      this.emit("event", {
        type: "agent_tool_result",
        content: [{ type: "tool_result", tool_use_id: id, content: step.tool_info?.output ?? "" }],
      });
      return;
    }
    if (this.stepToolUseIds.has(index)) return;
    const id = `antigravity-${String(index)}-${randomUUID().slice(0, 8)}`;
    this.stepToolUseIds.set(index, id);
    const { name, input } = normalizeAntigravityToolCall(rawName, step.tool_info?.parameters ?? {});
    const block: AgentContentBlock = { type: "tool_use", id, name, input };
    this.emit("event", { type: "agent_assistant", content: [block] });
  }

  /**
   * docs/301's outcome rule, applied once: the turn succeeded only when the
   * process exited 0 AND a `result` envelope arrived. A truncated stream is an
   * error turn by construction, whatever text preceded it — partial output never
   * implies success. The error text is this process's own stderr `error:` line.
   */
  private emitTerminalResult(exitCode: number | null): void {
    // A signalled death is an interrupt, not a completed turn.
    if (exitCode === null) return;
    const ok = exitCode === 0 && this.sawResult;
    const tokens = this.usage.tokens;
    const contextTokens = this.usage.contextTokens;
    const stderrText = antigravityStderrErrorText(this.stderrAll);
    this.emit("event", {
      type: "agent_result",
      status: ok ? "success" : "error",
      sessionId: this.turnSessionId,
      ...(tokens
        ? { tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead } }
        : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(this.resultDurationMs !== undefined ? { durationMs: this.resultDurationMs } : {}),
      ...(ok
        ? {}
        : {
            error: stderrText
              ?? (this.sawResult
                ? `Antigravity exited with code ${String(exitCode)}`
                : "Antigravity ended without a result event"),
          }),
    });
  }

  private clearTimers(): void {
    for (const t of [this.resultKillTimer, this.interruptKillTimer]) if (t) clearTimeout(t);
    this.resultKillTimer = null;
    this.interruptKillTimer = null;
  }

  private cleanupTurnFiles(): void {
    this.spawnHome?.cleanup();
    this.spawnHome = null;
  }

  sendUserMessage(text: string): void {
    console.warn(
      `[antigravity] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit("error", new Error("Antigravity does not support live steering; the message was not delivered."));
  }

  writeStdin(data: string): void {
    console.warn(`[antigravity] writeStdin: stdin closes with the prompt — ${String(data.length)} bytes dropped`);
  }

  interrupt(): void {
    const proc = this.proc;
    if (!proc) return;
    killChild(proc, "SIGINT");
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killProcessTree(proc, "SIGTERM", { label: "antigravity-interrupt" });
    }, 5_000);
  }

  kill(): void {
    this.clearTimers();
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "antigravity" });
    this.cleanupTurnFiles();
  }

  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, McpServerEntry> = {
      playwright: { command: PLAYWRIGHT_MCP_COMMAND, args: [...PLAYWRIGHT_MCP_ARGS] },
    };

    if (ctx.shipitBridge) {
      servers.shipit = {
        command: ctx.shipitBridge.tsxBin,
        args: [ctx.shipitBridge.bridgePath],
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
        servers[server.name] = r.url
          ? { serverUrl: r.url, ...(r.headers ? { headers: r.headers } : {}) }
          : { command: r.command ?? "", args: r.args ?? [], ...(r.env ? { env: r.env } : {}) };
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
