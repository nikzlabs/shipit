import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { killChild, killProcessTree } from "../../../shared/kill-child.js";
import { GROK_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { HARNESSES } from "../../../shared/catalogue/harnesses.js";
import { GROK_PERMISSION_MODES } from "../../../shared/types/agent-types.js";
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
  McpServerStatus,
} from "../agent-process.js";
import { resolveAgentHome, grokHome, type AgentHomeResolver } from "../../../shared/agent-home.js";
import { STRANDED_CREDENTIAL_MARKER } from "../../../shared/fs-constants.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { PLAYWRIGHT_MCP_ARGS, PLAYWRIGHT_MCP_COMMAND } from "../playwright-mcp.js";
import { grokResultErrorText, parseGrokLine, type GrokEvent } from "./stream.js";
import { normalizeGrokToolCall, normalizeGrokToolResult } from "./grok-tool-normalizer.js";
import { renderGrokConfigToml, type GrokMcpServer } from "./config-toml.js";

const GROK_REASONING = HARNESSES.find((h) => h.id === "grok")?.capabilities.reasoning;

const NPM_BIN_DIR = /(^|[\\/])node_modules[\\/]\.bin[\\/]?$/;

// Skip npm launchers: they unpack ~157 MB into each temporary GROK_HOME.
export function resolveGrokBinary(pathEnv = process.env.PATH ?? ""): string {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || NPM_BIN_DIR.test(dir)) continue;
    const candidate = path.join(dir, "grok");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — keep looking.
    }
  }
  console.warn(
    "[grok] no grok binary on PATH outside node_modules/.bin — falling back to the bare name, "
      + "which may resolve to the npm launcher (a 157MB bootstrap into this turn's GROK_HOME)",
  );
  return "grok";
}

// Import shared rules and skills, but not other harnesses' executable configuration.
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

const RESULT_EXIT_GRACE_MS = 5_000;

const SPAWN_AUTH_WATCH_MS = 1_000;

function grokAuthExpiryMs(file: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const rec of Object.values(parsed as Record<string, unknown>)) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const raw = (rec as Record<string, unknown>).expires_at;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const t = Date.parse(raw);
      if (Number.isFinite(t) && t > 0) return t;
    }
  } catch {
    // missing / unreadable / not JSON
  }
  return null;
}

function atomicCopyFile(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o600);
  try {
    fs.renameSync(tmp, dst);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export class GrokAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  readonly agentId: AgentId = "grok";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: false,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: GROK_PERMISSION_MODES,
    toolNames: [...GROK_TOOL_NAMES],
    models: [],
    ...(GROK_REASONING ? { reasoning: GROK_REASONING } : {}),
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: true,
    skillsDirName: ".grok",
    skillInvocationPrefix: "/",
  };

  private readonly resolveHome: AgentHomeResolver | undefined;
  private readonly spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private stderrBuffer = "";
  private promptPath: string | null = null;
  private systemPromptPath: string | null = null;
  // Grok reports "auto" even for requested compaction; label it by correlation.
  private compactionRequested = false;
  private spawnHome: string | null = null;
  private spawnAuthDest: string | null = null;
  private spawnAuthWatch: { path: string; listener: () => void } | null = null;
  // Set only when the durable auth file was linked successfully.
  private spawnHomeHasAuth = false;
  private resultKillTimer: NodeJS.Timeout | null = null;
  private interruptKillTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private turnSessionId = "";
  private sawResult = false;
  private sawAnyEvent = false;
  // Fatal errors have no result event; preserve their quota wording for close.
  private fatalErrorText: string | null = null;
  private latestCallContextTokens: number | undefined;
  // Results carry only IDs; normalization needs the call's raw tool name.
  private turnCallNames = new Map<string, string>();
  private pendingMcpServers: Record<string, GrokMcpServer> = {};

  constructor(opts?: {
    resolveHome?: AgentHomeResolver;
    spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  }) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.spawnFn = opts?.spawnFn ?? nodeSpawn;
  }

  readonly isStreaming = false;

  run(params: AgentRunParams): void {
    if (this.proc) {
      this.emit("error", new Error("Grok adapter: run() called while a turn is in flight"));
      return;
    }
    this.sawResult = false;
    this.sawAnyEvent = false;
    this.fatalErrorText = null;
    this.latestCallContextTokens = undefined;
    this.turnCallNames.clear();
    this.compactionRequested = params.compact === true;
    if (this.compactionRequested) {
      // Grok emits no compaction progress event.
      this.emit("event", { type: "agent_compaction_started", trigger: "manual" });
    }

    this.turnSessionId = params.sessionId ?? randomUUID();

    const args = [
      "--output-format", "streaming-messages-json",
      "--no-auto-update",
      // Required each spawn to load project hooks, MCP/LSP servers and permission rules.
      "--trust",
      "--cwd", params.cwd,
    ];
    args.push(params.sessionId ? "-r" : "-s", this.turnSessionId);

    // Grok's classifier mode "auto" is ShipIt's "guarded".
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

    if (params.reasoningEffort) args.push("--reasoning-effort", params.reasoningEffort);

    if (params.systemPrompt) {
      // --rules appends; --system-prompt-override discards Grok's tool instructions.
      this.systemPromptPath = `/tmp/grok-system-prompt-${randomUUID()}.md`;
      try {
        fs.writeFileSync(this.systemPromptPath, params.systemPrompt);
        args.push("--rules", this.systemPromptPath);
      } catch (err) {
        this.systemPromptPath = null;
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    const scopedHome = params.homeDir ?? this.resolveHome?.();
    const home = resolveAgentHome(scopedHome);
    const configRoot = this.makeSpawnHome(grokHome(home));
    if (configRoot === null) {
      this.cleanupTurnFiles();
      this.emit(
        "error",
        new Error(
          `Grok: could not create a config root for this turn under ${os.tmpdir()}. The turn was not started.`,
        ),
      );
      return;
    }
    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      GROK_HOME: configRoot,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      DISABLE_TELEMETRY: "1",
      GROK_ERROR_REPORTING: "0",
      DISABLE_ERROR_REPORTING: "1",
      GROK_OAUTH2_REFERRER: "shipit",
      ...COMPAT_TOGGLES,
    };
    // Scrub before delivery. Unrouted runs without file auth need the ambient key.
    if (params.serviceRouting) {
      scrubHarnessEnvCredentials(spawnEnv, "grok");
      const routing = params.serviceRouting;
      const secret = routing.credentialSourceEnv ? process.env[routing.credentialSourceEnv] : undefined;
      if (!secret || routing.credentialTarget.kind !== "env") {
        console.warn(
          `[grok] no credential in the environment for ${routing.serviceId}` +
            `/${routing.billingMode} (expected ${routing.credentialSourceEnv})`,
        );
        this.cleanupTurnFiles();
        this.emit("auth_required");
        return;
      }
      spawnEnv[routing.credentialTarget.name] = secret;
      spawnEnv.GROK_XAI_API_BASE_URL = routing.baseUrl;
      console.log(
        `[grok] service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    } else if (this.spawnHomeHasAuth) {
      // Environment credentials override file auth. Gate on the file, since
      // container accounts have no scoped resolver.
      scrubHarnessEnvCredentials(spawnEnv, "grok");
      console.log("[grok] subscription login on disk — env credentials scrubbed so it cannot be out-preferred");
    }

    // A file avoids Linux's 128 KiB per-argument limit.
    this.promptPath = `/tmp/grok-prompt-${randomUUID()}.txt`;
    try {
      fs.writeFileSync(this.promptPath, params.prompt);
    } catch (err) {
      this.promptPath = null;
      this.cleanupTurnFiles();
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    args.push("--prompt-file", this.promptPath);

    const binary = resolveGrokBinary();

    console.log(
      "[grok] spawning:", binary, args.join(" ").slice(0, 200),
      `| promptBytes=${Buffer.byteLength(params.prompt)} | cwd:`, params.cwd,
    );

    try {
      this.proc = this.spawnFn(binary, args, {
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

  // Warn only: Grok retries upstream errors without emitting output.
  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      console.warn("[grok] no output for 60s — the CLI may be retrying upstream (it is silent while it does)");
      this.emit("log", "server", "Warning: no output from the Grok CLI for 60 seconds. It may be retrying an upstream error; interrupting the turn is safe.");
    }, 60_000);
  }

  // MCP config has no alternate path. Isolate concurrent spawns' config.toml,
  // linking durable sessions and auth back. Never fall back to a broken realRoot.
  private makeSpawnHome(realRoot: string): string | null {
    this.spawnHomeHasAuth = false;
    this.unwatchSpawnAuth();
    this.spawnAuthDest = null;
    let spawnHome: string;
    try {
      spawnHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
    } catch (err) {
      console.error(`[grok] could not create a per-spawn config root under ${os.tmpdir()}: ${String(err)}`);
      this.spawnHome = null;
      return null;
    }
    this.spawnHome = spawnHome;

    try {
      fs.mkdirSync(realRoot, { recursive: true });
      const sessions = path.join(realRoot, "sessions");
      fs.mkdirSync(sessions, { recursive: true });
      fs.symlinkSync(sessions, path.join(spawnHome, "sessions"));
      const auth = path.join(realRoot, "auth.json");
      if (fs.existsSync(auth)) {
        fs.symlinkSync(auth, path.join(spawnHome, "auth.json"));
        this.spawnHomeHasAuth = true;
        this.spawnAuthDest = auth;
        this.watchSpawnAuth(path.join(spawnHome, "auth.json"));
      }
    } catch (err) {
      console.warn(
        `[grok] the shared config root ${realRoot} is unusable (${String(err)}) — running this turn on a `
          + "self-contained root instead. Cross-turn resume and any auth.json there are unavailable until it is repaired.",
      );
      if (process.env.XAI_API_KEY) {
        console.warn(
          "[grok] …and XAI_API_KEY is present, so a subscription-pinned turn would authenticate with "
            + "the METERED KEY instead. Repair the config root before trusting this turn's attribution.",
        );
      }
      this.emit(
        "log",
        "server",
        `Warning: Grok's config root (${realRoot}) could not be prepared, so this turn runs on a temporary one. `
          + "Conversation resume is unavailable until it is repaired.",
      );
      try {
        fs.mkdirSync(path.join(spawnHome, "sessions"), { recursive: true });
      } catch {
        // The CLI makes its own under a writable GROK_HOME; nothing more to do.
      }
    }

    try {
      fs.writeFileSync(path.join(spawnHome, "config.toml"), renderGrokConfigToml(this.pendingMcpServers));
    } catch (err) {
      console.warn(`[grok] could not write this turn's config.toml: ${String(err)} — the turn runs without MCP servers`);
    }
    return spawnHome;
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
      // MCP children can prevent exit after the result.
      if (!this.resultKillTimer && this.proc) {
        this.resultKillTimer = setTimeout(() => {
          this.resultKillTimer = null;
          if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "grok" });
        }, RESULT_EXIT_GRACE_MS);
      }
    }
  }

  // Context occupancy uses the last call; terminal usage sums all calls.
  private recordCallContext(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): void {
    if (!usage) return;
    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    if (contextTokens > 0) this.latestCallContextTokens = contextTokens;
  }

  private normalizeToolCalls(content: AgentContentBlock[]): AgentContentBlock[] {
    return content.map((block) => {
      if (block?.type !== "tool_use" || typeof block.name !== "string") return block;
      this.turnCallNames.set(block.id, block.name);
      const { name, input } = normalizeGrokToolCall(
        block.name,
        typeof block.input === "object" && block.input !== null ? block.input : {},
      );
      return { ...block, name, input };
    });
  }

  private normalizeToolResults(content: AgentContentBlock[]): AgentContentBlock[] {
    return content.map((block) => {
      // The wire carries tool_result blocks outside AgentContentBlock's union.
      const result = block as unknown as { type?: string; tool_use_id?: string; content?: unknown };
      if (result?.type !== "tool_result" || typeof result.content !== "string") return block;
      const rawName = result.tool_use_id ? this.turnCallNames.get(result.tool_use_id) : undefined;
      if (!rawName) return block;
      const normalized = normalizeGrokToolResult(rawName, result.content);
      if (normalized === result.content) return block;
      return { ...block, content: normalized } as unknown as AgentContentBlock;
    });
  }

  private mapEvent(raw: GrokEvent): AgentEvent | null {
    switch (raw.type) {
      case "system":
        if (raw.subtype === "compact_boundary") {
          const pre = raw.compact_metadata?.pre_tokens;
          return {
            type: "agent_compacted",
            trigger: this.compactionRequested ? "manual" : "auto",
            ...(typeof pre === "number" ? { preTokens: pre } : {}),
          };
        }
        if (raw.subtype !== "init") return null;
        return {
          type: "agent_init",
          agentId: "grok",
          sessionId: raw.session_id ?? this.turnSessionId,
          ...(raw.model ? { model: raw.model } : {}),
          ...(raw.tools ? { tools: raw.tools } : {}),
        };

      case "assistant":
        if (!raw.parent_tool_use_id) this.recordCallContext(raw.message?.usage);
        return {
          type: "agent_assistant",
          content: this.normalizeToolCalls(raw.message?.content ?? []),
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "user":
        // Grok's user events contain tool results, never steer echoes.
        return {
          type: "agent_tool_result",
          content: this.normalizeToolResults(raw.message?.content ?? []),
          ...(raw.parent_tool_use_id ? { parentToolUseId: raw.parent_tool_use_id } : {}),
        };

      case "result": {
        const u = raw.usage;
        // Grok's input and cache token counts are disjoint.
        const contextTokens = this.latestCallContextTokens;
        this.latestCallContextTokens = undefined;
        let contextWindow: number | undefined;
        for (const m of Object.values(raw.modelUsage ?? {})) {
          if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
            contextWindow = m.contextWindow;
          }
        }
        // API errors can carry subtype="success" with is_error=true.
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
          ...(errored ? { error: grokResultErrorText(raw) } : {}),
        };
      }

      case "error":
        if (raw.message_text) this.fatalErrorText = raw.message_text;
        this.emit("log", "server", `Grok error: ${raw.message_text ?? "unknown"}`);
        return null;

      default:
        return null;
    }
  }

  // Signal deaths stay silent so interrupts do not appear as completed turns.
  private emitSynthesizedResult(exitCode: number | null): void {
    if (exitCode === null) return;
    if (exitCode === 0 && !this.sawAnyEvent) {
      console.warn("[grok] process exited 0 with no stream events — no result to synthesize");
      return;
    }
    if (exitCode === 0) return;
    this.emit("event", {
      type: "agent_result",
      status: "error",
      sessionId: this.turnSessionId,
      error:
        this.fatalErrorText
        ?? `Grok exited with code ${String(exitCode)} before producing a result`,
    });
  }

  // Compaction requires a new /compact run; a mid-turn request must not abort this turn.
  compact(_instructions?: string): void {
    console.warn(
      "[grok-adapter] compact() called mid-turn — Grok has no resident process to compact (the orchestrator should have spawned a /compact run instead)",
    );
  }

  sendUserMessage(text: string): void {
    console.warn(
      `[grok-adapter] sendUserMessage called on a one-shot adapter — message DROPPED (text=${JSON.stringify(text.slice(0, 80))})`,
    );
    this.emit(
      "error",
      new Error("Grok Build does not support live steering; the message was not delivered."),
    );
  }

  writeStdin(data: string): void {
    console.warn(`[grok] writeStdin: this adapter spawns with no stdin — ${data.length} bytes dropped`);
  }

  interrupt(): void {
    // Capture the process so a delayed escalation cannot kill the next turn.
    const proc = this.proc;
    if (!proc) return;
    killChild(proc, "SIGINT");
    if (this.interruptKillTimer) clearTimeout(this.interruptKillTimer);
    this.interruptKillTimer = setTimeout(() => {
      this.interruptKillTimer = null;
      if (this.proc === proc) killProcessTree(proc, "SIGTERM", { label: "grok-interrupt" });
    }, 5_000);
  }

  kill(): void {
    this.clearTimers();
    if (this.proc) killProcessTree(this.proc, "SIGTERM", { label: "grok" });
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

  // watchFile detects replacement by rename; fs.watch follows the old inode.
  private watchSpawnAuth(spawnAuth: string): void {
    this.unwatchSpawnAuth();
    const listener = (): void => {
      this.publishSpawnAuthBack();
    };
    this.spawnAuthWatch = { path: spawnAuth, listener };
    fs.watchFile(spawnAuth, { interval: SPAWN_AUTH_WATCH_MS, persistent: false }, listener);
    // Publish now to cover writes before watchFile's asynchronous baseline stat.
    this.publishSpawnAuthBack();
  }

  private unwatchSpawnAuth(): void {
    const watch = this.spawnAuthWatch;
    if (!watch) return;
    this.spawnAuthWatch = null;
    try {
      fs.unwatchFile(watch.path, watch.listener);
    } catch {
      // Best-effort — an unwatch failure leaves at most one stat poller.
    }
  }

  // Refresh replaces the auth symlink with a file. "strand" requires quarantine
  // before cleanup, since that file can hold the only live token.
  private publishSpawnAuthBack(): "done" | "strand" {
    const spawnHome = this.spawnHome;
    const dest = this.spawnAuthDest;
    if (!spawnHome || !dest) return "done";
    const spawnAuth = path.join(spawnHome, "auth.json");
    try {
      const st = fs.lstatSync(spawnAuth);
      if (st.isSymbolicLink() || !st.isFile()) return "done";
    } catch {
      return "done";
    }
    const spawnAt = grokAuthExpiryMs(spawnAuth);
    if (spawnAt === null) {
      console.warn(
        "[grok] CLI replaced GROK_HOME/auth.json but the copy is unreadable as a token; "
          + "not publishing over the shared root — quarantining the rotation so cleanup cannot delete it",
      );
      return "strand";
    }
    if (fs.existsSync(dest)) {
      const destAt = grokAuthExpiryMs(dest);
      if (destAt === null) {
        console.warn(
          "[grok] shared-root auth.json is unreadable as a token; refusing to overwrite it "
            + "with the throwaway copy — quarantining the rotation so cleanup cannot delete it",
        );
        return "strand";
      }
      if (spawnAt <= destAt) return "done";
    }
    try {
      atomicCopyFile(spawnAuth, dest);
      console.log("[grok] published CLI-rotated auth.json from throwaway GROK_HOME back to the shared root");
      return "done";
    } catch (err) {
      console.warn(
        `[grok] failed to publish rotated auth.json back to ${dest}: ${err instanceof Error ? err.message : String(err)}`
          + " — quarantining the rotation so cleanup cannot delete it",
      );
      return "strand";
    }
  }

  // The orchestrator recognizes this marker and rescues files before deleting child homes.
  private quarantineSpawnAuth(): void {
    const spawnHome = this.spawnHome;
    const dest = this.spawnAuthDest;
    if (!spawnHome || !dest) return;
    const spawnAuth = path.join(spawnHome, "auth.json");
    const quarantined = `${dest}${STRANDED_CREDENTIAL_MARKER}${Date.now()}`;
    try {
      atomicCopyFile(spawnAuth, quarantined);
      console.warn(`[grok] quarantined unpublishable auth.json at ${quarantined}`);
    } catch (err) {
      console.warn(
        `[grok] failed to quarantine ${spawnAuth} to ${quarantined}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    this.unwatchSpawnAuth();
    if (this.publishSpawnAuthBack() === "strand") this.quarantineSpawnAuth();
    this.spawnAuthDest = null;
    if (this.spawnHome) {
      try {
        fs.rmSync(this.spawnHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.spawnHome = null;
  }

  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const servers: Record<string, GrokMcpServer> = {
      playwright: {
        command: PLAYWRIGHT_MCP_COMMAND,
        args: [...PLAYWRIGHT_MCP_ARGS],
        enabled: true,
      },
    };

    if (ctx.shipitBridge) {
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
