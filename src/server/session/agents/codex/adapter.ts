import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../../../shared/kill-child.js";
import type {
  AgentId,
  AgentCapabilities,
  AgentMcpWriteContext,
  AgentMcpWriteResult,
  AgentProcess,
  AgentProcessEvents,
  AgentRunParams,
  PermissionRequester,
} from "../agent-process.js";
import { resolveMcpServer } from "../../mcp-resolve.js";
import { getErrorMessage } from "../../../shared/utils.js";
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_COMMAND,
} from "../playwright-mcp.js";
import { CODEX_MODELS, CODEX_TOOL_NAMES } from "../../../shared/agent-registry.js";
import { codexProviderArgs } from "./spawn-shaping.js";
import type { AgentHomeResolver } from "../../../shared/agent-home.js";
import { codexHome, resolveAgentHome } from "../../../shared/agent-home.js";
import { CodexRateLimits } from "./codex-rate-limits.js";
import { CodexEventHandler } from "./codex-event-handler.js";
import { ensureCodexProjectTrusted } from "./project-trust.js";

export { unwrapShellCommand, buildCodexPermissionInput } from "./codex-tool-normalizer.js";

/**
 * Keep Codex's own sandbox out of the way — the session container IS the
 * sandbox (CLAUDE.md §5). Until now the only thing saying so was
 * `sandboxPolicy: { type: "dangerFullAccess" }` on each `turn/start`, and when
 * codex-cli 0.153.2 fell back past that single point of failure, every tool
 * call in the session died on `bwrap: No permissions to create new namespace`.
 * Bubblewrap can NEVER work here: containers run `CapDrop: ALL` plus five
 * narrow adds (`container-lifecycle.ts`), so the kernel refuses the user
 * namespace.
 *
 * Measured against the pinned 0.153.2, where bubblewrap is the DEFAULT sandbox
 * and Landlock the legacy fallback (the vendored helper's own `--help`):
 *
 *  - `sandbox_mode` is the primary defence. `codex debug prompt-input` flips
 *    from `<permission_profile type="managed"><file_system type="restricted">`
 *    to `type="disabled"`/`unrestricted`, and a disabled profile runs no
 *    sandbox helper at all. `approval_policy` is its required pair — the CLI
 *    refuses `never` while danger-full-access is disallowed.
 *  - `features.use_legacy_landlock` is the defence in depth. NOTHING ShipIt
 *    writes can overrule a managed-policy veto (`/etc/codex/requirements.toml`
 *    or enterprise policy — outside ShipIt, changeable with no ShipIt deploy),
 *    and this does not try to: it opts the fallback sandbox into Landlock,
 *    which needs no capabilities, where bubblewrap cannot start at all.
 *
 * **What is measured stops there.** That the key parses and that the profile
 * flips are both measured; that a vetoed turn then runs its commands under
 * Landlock rather than failing is NOT — reproducing it needs a policy file at
 * a path a session container cannot write (`$CODEX_HOME/requirements.toml` is
 * ignored outright by 0.153.2: invalid TOML there raises no error). Treat the
 * fallback as the best available mitigation, not as a guarantee; the primary
 * defence is `sandbox_mode`, where a disabled profile runs no helper at all.
 *
 * `-c`, not a `config.toml` block like `project-trust.ts`: trust needs the file
 * because its override was measured not to take, and these keys were measured
 * to take (`-c features.use_legacy_landlock="notabool"` fails the spawn with
 * `invalid type: string "notabool", expected a boolean`). Merging into TOML the
 * user may also own risks a duplicate key, which makes Codex fail to START —
 * a worse failure than the one being fixed.
 */
export const CODEX_SANDBOX_ARGS: readonly string[] = [
  "-c", `sandbox_mode="danger-full-access"`,
  "-c", `approval_policy="never"`,
  "-c", "features.use_legacy_landlock=true",
];

/**
 * Turn off Codex's native goal mode (`goals`, stable and on by default since
 * 0.133.0) until ShipIt renders and clears goals — docs/154-native-goal-command.
 * ShipIt shows no goal and has no `/goal clear`, yet the model can create one
 * itself, and every `thread/resume` restarts it: a session got stuck on a goal
 * the user could neither see nor clear. Delete this when docs/154 lands.
 *
 * Measured against the pinned 0.154.0: `codex features list` flips `goals` from
 * `true` to `false`; `-c features.goals="notabool"` fails the `app-server`
 * spawn with `invalid type: string "notabool", expected a boolean`;
 * `thread/goal/get` answers `goals feature is disabled`; `create_goal` /
 * `update_goal` / `get_goal` leave the model request; and resuming a thread
 * with an active goal no longer starts a continuation turn by itself. What
 * stays is the goal text already in that thread's history — no config removes it.
 */
export const CODEX_GOALS_OFF_ARGS: readonly string[] = [
  "-c", "features.goals=false",
];

interface JsonRpcRequest {
  method: string;
  id: number;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcServerNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcOutboundResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type JsonRpcInbound = JsonRpcResponse | JsonRpcServerNotification | JsonRpcServerRequest;

function codexAuthFile(configDir?: string): string {
  return path.join(configDir ?? codexHome(), "auth.json");
}

export function hasCodexFileAuth(configDir?: string): boolean {
  try {
    const file = codexAuthFile(configDir);
    if (!existsSync(file)) return false;
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export class CodexAdapter
  extends EventEmitter<AgentProcessEvents>
  implements AgentProcess
{
  private readonly resolveHome: AgentHomeResolver | undefined;

  constructor(
    private readonly hasFileAuth: (configDir?: string) => boolean = hasCodexFileAuth,
    opts?: { resolveHome?: AgentHomeResolver },
  ) {
    super();
    this.resolveHome = opts?.resolveHome;
    this.rateLimits = new CodexRateLimits();
    this.eventHandler = new CodexEventHandler(
      {
        emitEvent: (event) => { this.emit("event", event); },
        emitLog: (source, text) => { this.emit("log", source, text); },
        sendRequest: (method, params) => this.sendRequest(method, params),
        sendResponse: (id, result) => { this.sendResponse(id, result); },
        sendErrorResponse: (id, code, message) => { this.sendErrorResponse(id, code, message); },
        sendNotification: (method, params) => { this.sendNotification(method, params); },
        kill: () => { this.kill(); },
      },
      this.rateLimits,
      [...CODEX_TOOL_NAMES],
    );
  }

  readonly agentId: AgentId = "codex";

  readonly capabilities: AgentCapabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: false,
    supportedPermissionModes: [],
    toolNames: [...CODEX_TOOL_NAMES],
    models: CODEX_MODELS,
    supportsReview: true,
    supportsSteering: true,
    supportsCompaction: true,
    skillsDirName: ".codex",
    skillInvocationPrefix: "$",
  };

  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;

  private readonly eventHandler: CodexEventHandler;

  private readonly rateLimits: CodexRateLimits;

  private pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  // Child runs override the account home; resident MCP setup uses the resolver.
  private spawnHomeOverride: string | undefined;

  private codexConfigDir(): string {
    const home = this.spawnHomeOverride ?? this.resolveHome?.();
    return home ? path.join(home, ".codex") : codexHome();
  }

  setPermissionRequester(requester: PermissionRequester): void {
    this.eventHandler.setPermissionRequester(requester);
  }

  run(params: AgentRunParams): void {
    this.spawnHomeOverride = params.homeDir;
    this.eventHandler.beginTurn(params.cwd);

    try {
      execFileSync("which", ["codex"], { stdio: "ignore" });
    } catch {
      this.emit("error", new Error(
        "Codex CLI is not installed. Install it with: npm install -g @openai/codex"
      ));
      return;
    }

    const cwd = params.cwd;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };

    // Always set both homes: local mode can inherit an inaccessible /root.
    // This root must match MCP setup and the account warm-up gate.
    const scopedHome = this.spawnHomeOverride ?? this.resolveHome?.();
    env.HOME = resolveAgentHome(scopedHome);
    env.CODEX_HOME = this.codexConfigDir();

    // Routed services use their own credentials. Subscription auth takes
    // precedence over API billing; a scoped account must never fall back to it.
    const routing = params.serviceRouting;
    const providerArgs = codexProviderArgs(routing);
    const shaped = routing !== undefined && providerArgs.length > 0;
    if (shaped && routing) {
      const secret = routing.credentialSourceEnv ? env[routing.credentialSourceEnv] : undefined;
      if (routing.credentialTarget.kind === "env") {
        if (secret) env[routing.credentialTarget.name] = secret;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is a catalogue-declared variable name, not caller input.
        else delete env[routing.credentialTarget.name];
      }
      if (!secret) {
        this.emit("auth_required");
        return;
      }
      this.emit(
        "log",
        "codex",
        `service routing: ${routing.serviceId}/${routing.billingMode} -> ${routing.baseUrl}`,
      );
    } else if (routing) {
      this.emit("error", new Error(
        `Codex cannot be pointed at ${routing.serviceId} over ${routing.style}.`,
      ));
      return;
    }

    const hasFileAuth = !shaped && this.hasFileAuth(this.codexConfigDir());
    const hasEnvAuth = !shaped && !scopedHome && !!env.OPENAI_API_KEY;

    if (!shaped && !hasFileAuth && !hasEnvAuth) {
      this.emit("auth_required");
      return;
    }

    if (hasFileAuth) {
      delete env.OPENAI_API_KEY;
      this.emit("log", "codex", "using ChatGPT subscription (~/.codex/auth.json)");
    } else if (!shaped) {
      this.emit("log", "codex", "using OPENAI_API_KEY (Platform API billing)");
    }

    // Global config overrides must precede the subcommand.
    const args = [
      ...CODEX_SANDBOX_ARGS,
      ...CODEX_GOALS_OFF_ARGS,
      ...(params.reasoningEffort ? ["-c", `model_reasoning_effort=${params.reasoningEffort}`] : []),
      ...providerArgs,
      "app-server",
    ];

    // Project trust must be in the file before startup; a -c override is ignored.
    ensureCodexProjectTrusted(env.CODEX_HOME, cwd);

    this.emit("log", "codex", `spawning: codex ${args.join(" ")} | cwd: ${cwd}`);

    try {
      this.proc = spawn("codex", args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.buffer = "";

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.drainLines();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        this.emit("log", "codex-stderr", text);
        const lc = text.toLowerCase();
        if (
          lc.includes("unauthorized") ||
          lc.includes("invalid api key") ||
          lc.includes("authentication") ||
          lc.includes("api key")
        ) {
          this.emit("auth_required");
        }
      }
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("close", (code) => {
      this.drainLines(true);
      this.emit("done", code ?? 1);
      this.proc = null;
    });

    this.eventHandler.initializeAndRun(params).catch((err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  readonly isStreaming = false;

  writeStdin(data: string): void {
    // turn/steer notifications are silently dropped; use a request with the active turn ID.
    const threadId = this.eventHandler.getThreadId();
    const currentTurnId = this.eventHandler.getCurrentTurnId();
    if (this.proc && threadId && currentTurnId) {
      const steerText = data.trim();
      void (async () => {
        try {
          await this.sendRequest("turn/steer", {
            threadId,
            expectedTurnId: currentTurnId,
            input: [{ type: "text", text: steerText }],
          });
          // Acknowledge acceptance so the orchestrator does not queue the steer again.
          this.emit("event", { type: "agent_user_replay", text: steerText });
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          this.emit("log", "codex", `turn/steer rejected: ${reason}`);
          this.emit("event", { type: "agent_steer_rejected", text: steerText });
        }
      })();
    }
  }

  sendUserMessage(text: string, _opts?: { images?: unknown[] }): void {
    this.writeStdin(text);
  }

  // Between turns, compaction needs a new run({ compact: true }).
  compact(_instructions?: string): void {
    // The RPC has no field for custom compaction instructions.
    const threadId = this.eventHandler.getThreadId();
    if (this.proc && threadId) {
      this.eventHandler.markCompactionRequested();
      this.sendRequest("thread/compact/start", { threadId }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.emit("log", "codex", `thread/compact/start rejected: ${reason}`);
      });
      return;
    }
    console.warn(
      "[codex-adapter] compact() called with no live thread — the orchestrator should have spawned a compaction run instead",
    );
  }

  interrupt(): void {
    // Preserve a turn boundary for queued answers; kill if interruption fails.
    const threadId = this.eventHandler.getThreadId();
    const currentTurnId = this.eventHandler.getCurrentTurnId();
    if (this.proc && threadId && currentTurnId) {
      this.sendRequest("turn/interrupt", {
        threadId,
        turnId: currentTurnId,
      }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.emit("log", "codex", `turn/interrupt rejected, killing: ${reason}`);
        this.kill();
      });
      return;
    }
    this.kill();
  }

  kill(): void {
    if (this.proc) {
      killProcessTree(this.proc, "SIGTERM", { label: "codex" });
      this.proc = null;
    }
    this.pendingRequests.forEach(({ reject }) => reject(new Error("Process killed")));
    this.pendingRequests.clear();
  }

  // Config is read at startup. Keep secrets in runtimeEnv, except argv values:
  // Codex has no argv environment indirection.
  writeMcpConfig(ctx: AgentMcpWriteContext): AgentMcpWriteResult {
    const codexConfigDir = this.codexConfigDir();
    const configPath = path.join(codexConfigDir, "config.toml");
    const runtimeEnv: Record<string, string> = {};
    const lines: string[] = [
      CODEX_MCP_BEGIN,
      "# ShipIt-managed MCP servers. This block is regenerated before each Codex turn.",
    ];

    // Codex forwards only allowlisted environment variables to MCP children.
    lines.push(
      "",
      "[mcp_servers.playwright]",
      `command = ${tomlString(PLAYWRIGHT_MCP_COMMAND)}`,
      `args = ${tomlArray([...PLAYWRIGHT_MCP_ARGS])}`,
    );
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (browsersPath) {
      runtimeEnv.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
      lines.push(`env_vars = ${tomlArray(["PLAYWRIGHT_BROWSERS_PATH"])}`);
    }

    if (ctx.shipitBridge) {
      runtimeEnv.SHIPIT_MCP_TOOLS = "present,voice,ask,bug,propose_actions";
      lines.push(
        "",
        "[mcp_servers.shipit]",
        `command = ${tomlString(ctx.shipitBridge.tsxBin)}`,
        `args = ${tomlArray([ctx.shipitBridge.bridgePath])}`,
        `env_vars = ${tomlArray(["SHIPIT_MCP_TOOLS"])}`,
      );
    }

    for (const server of ctx.servers) {
      const { resolved, missing } = resolveMcpServer(server);
      if (!resolved) {
        const reason = `missing secret: ${missing.join(", ")}`;
        console.warn(`[mcp] dropping server "${server.name}": ${reason}`);
        ctx.onServerFailed(server.name, reason);
        continue;
      }

      lines.push("", `[mcp_servers.${server.name}]`);
      if (server.type === "stdio") {
        const command = resolved.command;
        if (typeof command === "string") {
          lines.push(`command = ${tomlString(command)}`);
        }
        const args = resolved.args;
        if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
          lines.push(`args = ${tomlArray(args)}`);
        }
        const env = resolved.env;
        if (env && typeof env === "object" && !Array.isArray(env)) {
          const envKeys: string[] = [];
          for (const [key, value] of Object.entries(env)) {
            if (typeof value !== "string") continue;
            runtimeEnv[key] = value;
            envKeys.push(key);
          }
          if (envKeys.length > 0) {
            lines.push(`env_vars = ${tomlArray(envKeys)}`);
          }
        }
      } else {
        const url = resolved.url;
        if (typeof url === "string") {
          lines.push(`url = ${tomlString(url)}`);
        }
        const headers = resolved.headers;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          const envHeaders: Record<string, string> = {};
          let i = 0;
          for (const [header, value] of Object.entries(headers)) {
            if (typeof value !== "string") continue;
            if (header.toLowerCase() === "authorization") {
              const bearerToken = parseBearerToken(value);
              if (bearerToken) {
                const envKey = `SHIPIT_MCP_${server.name.toUpperCase()}_BEARER_TOKEN`;
                runtimeEnv[envKey] = bearerToken;
                lines.push(`bearer_token_env_var = ${tomlString(envKey)}`);
                continue;
              }
            }
            const envKey = `SHIPIT_MCP_${server.name.toUpperCase()}_HTTP_HEADER_${i++}`;
            runtimeEnv[envKey] = value;
            envHeaders[header] = envKey;
          }
          if (Object.keys(envHeaders).length > 0) {
            lines.push(`env_http_headers = ${tomlInlineStringMap(envHeaders)}`);
          }
        }
      }
    }

    lines.push("", CODEX_MCP_END, "");

    try {
      let existing = "";
      try {
        existing = readFileSync(configPath, "utf-8");
      } catch { /* no config yet */ }
      mkdirSync(codexConfigDir, { recursive: true });
      writeFileSync(configPath, replaceManagedCodexMcpBlock(existing, lines.join("\n")));
    } catch (err) {
      console.warn(`[mcp] failed to register codex MCP config: ${getErrorMessage(err)}`);
    }

    return { runtimeEnv };
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = { method, id };
    if (params) msg.params = params;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeJsonRpc(msg);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { method };
    if (params) msg.params = params;
    this.writeJsonRpc(msg);
  }

  private sendResponse(id: number, result: unknown): void {
    this.writeJsonRpc({ id, result });
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    this.writeJsonRpc({ id, error: { code, message } });
  }

  private writeJsonRpc(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcOutboundResponse): void {
    if (!this.proc?.stdin?.writable) return;
    const line = `${JSON.stringify(msg)  }\n`;
    this.proc.stdin.write(line);
  }

  private drainLines(flush = false): void {
    const lines = this.buffer.split("\n");
    if (!flush) {
      this.buffer = lines.pop() ?? "";
    } else {
      this.buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcInbound;
        this.handleMessage(msg);
      } catch {
        this.emit("log", "codex-stdout", trimmed);
      }
    }
  }

  private handleMessage(msg: JsonRpcInbound): void {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    const hasMethod =
      "method" in msg && typeof (msg as { method?: unknown }).method === "string";

    // Requests also have IDs. Handle them first or approvals wait forever.
    if (hasId && hasMethod) {
      this.eventHandler.handleServerRequest(msg);
      return;
    }

    if (hasId) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${this.rateLimits.normalizeJsonRpcError(resp.error.message)}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    this.eventHandler.handleNotification(msg as JsonRpcServerNotification);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

function tomlInlineStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function parseBearerToken(value: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

const CODEX_MCP_BEGIN = "# <shipit-managed-mcp>";
const CODEX_MCP_END = "# </shipit-managed-mcp>";

function replaceManagedCodexMcpBlock(existing: string, block: string): string {
  const start = existing.indexOf(CODEX_MCP_BEGIN);
  const end = existing.indexOf(CODEX_MCP_END);
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + CODEX_MCP_END.length;
    return `${existing.slice(0, start).trimEnd()}\n\n${normalizedBlock}${existing.slice(afterEnd).trimStart()}`;
  }
  return `${existing.trimEnd()}${existing.trimEnd() ? "\n\n" : ""}${normalizedBlock}`;
}
