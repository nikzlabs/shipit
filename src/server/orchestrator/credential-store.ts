import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils.js";
import type { McpServerConfig } from "../shared/types/mcp-types.js";

interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  /**
   * Account-level MCP server configs keyed by name (docs/088). Values use
   * `$secret:` placeholders — the raw secret values live in `agentEnv` under
   * the `mcp__<server>__<KEY>` namespace, not here.
   */
  mcpServers?: Record<string, McpServerConfig>;
}

const DEFAULT_CREDENTIALS_DIR = "/credentials";
const FILENAME = "shipit-credentials.json";

/**
 * Unified credential store that persists user credentials to a single JSON file.
 * Lives in the credentials volume so it survives workspace resets and container restarts.
 *
 * Storage file: `{credentialsDir}/shipit-credentials.json`
 */
export class CredentialStore {
  private filePath: string;
  private data: CredentialData = {};

  constructor(credentialsDir?: string) {
    this.filePath = path.join(credentialsDir ?? DEFAULT_CREDENTIALS_DIR, FILENAME);
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        this.data = parsed as CredentialData;
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error("[credential-store] Failed to save:", getErrorMessage(err));
    }
  }

  // ---- Agent environment variables ----

  getAgentEnv(key: string): string | undefined {
    return this.data.agentEnv?.[key];
  }

  /** Get all stored agent env vars. */
  getAllAgentEnv(): Record<string, string> {
    return { ...this.data.agentEnv };
  }

  setAgentEnv(key: string, value: string): void {
    this.data.agentEnv ??= {};
    this.data.agentEnv[key] = value;
    this.save();
  }

  // ---- MCP servers (docs/088-mcp-integration) ----

  /** Get a single MCP server config by name. */
  getMcpServer(name: string): McpServerConfig | undefined {
    return this.data.mcpServers?.[name];
  }

  /** Get all MCP server configs keyed by name. */
  getAllMcpServers(): Record<string, McpServerConfig> {
    return { ...this.data.mcpServers };
  }

  /** Add or replace an MCP server config. Enforces `config.name === name`. */
  setMcpServer(name: string, config: McpServerConfig): void {
    this.data.mcpServers ??= {};
    this.data.mcpServers[name] = { ...config, name };
    this.save();
  }

  /** Remove an MCP server config. Does NOT clear its `mcp__*` secrets. */
  deleteMcpServer(name: string): void {
    if (this.data.mcpServers) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by user-provided server name
      delete this.data.mcpServers[name];
      this.save();
    }
  }

  /**
   * Set the secret value behind a server's `$secret:` reference. `key` must be
   * in the `mcp__*` namespace — these are always agent-bound.
   */
  setMcpSecret(key: string, value: string): void {
    if (!key.startsWith("mcp__")) {
      throw new Error(`MCP secret key must start with "mcp__": ${key}`);
    }
    this.setAgentEnv(key, value);
  }

  /** Clear a single `mcp__*` secret value. */
  deleteMcpSecret(key: string): void {
    if (this.data.agentEnv && key in this.data.agentEnv) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by mcp__* secret name
      delete this.data.agentEnv[key];
      this.save();
    }
  }

  /** Clear every `mcp__<server>__*` secret for a given server name. */
  deleteMcpSecretsForServer(serverName: string): void {
    if (!this.data.agentEnv) return;
    const prefix = `mcp__${serverName}__`;
    let changed = false;
    for (const key of Object.keys(this.data.agentEnv)) {
      if (key.startsWith(prefix)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by mcp__* secret name
        delete this.data.agentEnv[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // ---- GitHub token ----

  getGithubToken(): string | null {
    const token = this.data.githubToken;
    if (typeof token === "string" && token.trim()) {
      return token;
    }
    return null;
  }

  setGithubToken(token: string): void {
    this.data.githubToken = token;
    this.save();
  }

  clearGithubToken(): void {
    delete this.data.githubToken;
    this.save();
  }

  // ---- Max idle containers ----

  getMaxIdleContainers(): number {
    return this.data.maxIdleContainers ?? 5;
  }

  setMaxIdleContainers(n: number): void {
    this.data.maxIdleContainers = n;
    this.save();
  }

  // ---- Agent system instructions ----

  getAgentSystemInstructionsEnabled(): boolean {
    return this.data.agentSystemInstructionsEnabled ?? true;
  }

  setAgentSystemInstructionsEnabled(enabled: boolean): void {
    this.data.agentSystemInstructionsEnabled = enabled;
    this.save();
  }

  // ---- Auto-create PR ----

  getAutoCreatePr(): boolean {
    return this.data.autoCreatePr ?? false;
  }

  setAutoCreatePr(enabled: boolean): void {
    this.data.autoCreatePr = enabled;
    this.save();
  }

  // ---- Utility ----

  /** Clear all stored credentials. */
  clear(): void {
    this.data = {};
    this.save();
  }
}
