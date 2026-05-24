import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils.js";
import type {
  McpServerConfig,
  OAuthTokens,
  McpOAuthRegisteredClient,
} from "../shared/types/mcp-types.js";
import type { AgentId, ProviderAccount } from "../shared/types.js";

interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
  /**
   * When true, mid-turn messages are steered to the running agent instead of
   * queued. Capability-gated: only active when the agent also sets
   * supportsSteering: true. (docs/140)
   */
  liveSteering?: boolean;
  /**
   * Account-level MCP server configs keyed by name (docs/088). Values use
   * `$secret:` placeholders — the raw secret values live in `agentEnv` under
   * the `mcp__<server>__<KEY>` namespace, not here.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * MCP OAuth tokens (docs/088 Phase 2) keyed by provider source id
   * (e.g. `"linear_oauth"`). Tokens are written here after a successful
   * OAuth exchange; the resolver in `platform-credentials.ts` reads them on
   * every `syncSecrets()` pass and refreshes lazily when expired. Per
   * provider registry, the source id is uppercased into the env var name
   * the worker substitutes for `$platform:<id>` placeholders
   * (`linear_oauth` → `MCP_PLATFORM_LINEAR_OAUTH`).
   */
  mcpOAuth?: Record<string, OAuthTokens>;
  /**
   * Dynamically-registered OAuth clients (RFC 7591, docs/139) keyed by
   * provider source id. Kept separate from `mcpOAuth` so a registered client
   * can exist before the first token without falsely reporting "connected"
   * in `listMcpOAuthProviders`. Reused on every connect so we register once
   * per account/provider.
   */
  mcpOAuthClients?: Record<string, McpOAuthRegisteredClient>;
  providerAccounts?: Partial<Record<AgentId, ProviderAccount[]>>;
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

  // ---- Provider accounts (docs/150) ----

  listProviderAccounts(provider?: AgentId): ProviderAccount[] {
    if (provider) {
      return [...(this.data.providerAccounts?.[provider] ?? [])].map((a) => ({ ...a }));
    }
    return (["claude", "codex"] as AgentId[]).flatMap((id) => this.listProviderAccounts(id));
  }

  getProviderAccount(provider: AgentId, accountId: string): ProviderAccount | undefined {
    const found = this.data.providerAccounts?.[provider]?.find((a) => a.id === accountId);
    return found ? { ...found } : undefined;
  }

  getPrimaryProviderAccount(provider: AgentId): ProviderAccount | undefined {
    const accounts = this.data.providerAccounts?.[provider] ?? [];
    const found = accounts.find((a) => a.isPrimary) ?? accounts[0];
    return found ? { ...found } : undefined;
  }

  upsertProviderAccount(account: ProviderAccount): void {
    this.data.providerAccounts ??= {};
    const accounts = [...(this.data.providerAccounts[account.provider] ?? [])];
    const idx = accounts.findIndex((a) => a.id === account.id);
    const next = { ...account, updatedAt: Date.now() };
    if (next.isPrimary) {
      for (const existing of accounts) existing.isPrimary = false;
    }
    if (idx >= 0) accounts[idx] = next;
    else accounts.push(next);
    if (!accounts.some((a) => a.isPrimary) && accounts[0]) {
      accounts[0] = { ...accounts[0], isPrimary: true, updatedAt: Date.now() };
    }
    this.data.providerAccounts[account.provider] = accounts;
    this.save();
  }

  deleteProviderAccount(provider: AgentId, accountId: string): void {
    const accounts = this.data.providerAccounts?.[provider];
    if (!accounts) return;
    const next = accounts.filter((a) => a.id !== accountId);
    if (next.length > 0 && !next.some((a) => a.isPrimary)) {
      next[0] = { ...next[0], isPrimary: true, updatedAt: Date.now() };
    }
    this.data.providerAccounts![provider] = next;
    this.save();
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

  // ---- MCP OAuth tokens (docs/088 Phase 2) ----

  /**
   * Get the persisted OAuth tokens for a provider source id. The returned
   * object is a defensive copy so callers can mutate freely without
   * affecting the in-memory store.
   */
  getMcpOAuthTokens(source: string): OAuthTokens | undefined {
    const t = this.data.mcpOAuth?.[source];
    return t ? { ...t } : undefined;
  }

  /** Get all persisted MCP OAuth token entries as a fresh map copy. */
  getAllMcpOAuthTokens(): Record<string, OAuthTokens> {
    const out: Record<string, OAuthTokens> = {};
    for (const [k, v] of Object.entries(this.data.mcpOAuth ?? {})) {
      out[k] = { ...v };
    }
    return out;
  }

  /**
   * Persist OAuth tokens for a provider. Called after a successful exchange
   * or refresh. Stamps `obtainedAt` if the caller didn't provide one so the
   * UI can show "Connected 3 days ago".
   */
  setMcpOAuthTokens(source: string, tokens: OAuthTokens): void {
    this.data.mcpOAuth ??= {};
    this.data.mcpOAuth[source] = {
      ...tokens,
      obtainedAt: tokens.obtainedAt ?? new Date().toISOString(),
    };
    this.save();
  }

  /** Remove tokens for a single source ("disconnect"). */
  deleteMcpOAuthTokens(source: string): void {
    if (this.data.mcpOAuth && source in this.data.mcpOAuth) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuth[source];
      this.save();
    }
  }

  // ---- MCP OAuth registered clients (docs/139 — RFC 7591 DCR) ----

  /**
   * Get the dynamically-registered OAuth client for a provider source id.
   * Returned as a defensive copy. `undefined` when no client is registered
   * yet (first connect performs registration).
   */
  getMcpOAuthClient(source: string): McpOAuthRegisteredClient | undefined {
    const c = this.data.mcpOAuthClients?.[source];
    return c ? { ...c } : undefined;
  }

  /**
   * Persist a registered OAuth client for a provider. Called after a
   * successful RFC 7591 registration so subsequent connects reuse the same
   * `client_id`.
   */
  setMcpOAuthClient(source: string, client: McpOAuthRegisteredClient): void {
    this.data.mcpOAuthClients ??= {};
    this.data.mcpOAuthClients[source] = { ...client };
    this.save();
  }

  /**
   * Remove a registered client. Not called on "disconnect" (we keep the
   * client so reconnect skips re-registration); reserved for a future
   * "forget this provider entirely" affordance.
   */
  deleteMcpOAuthClient(source: string): void {
    if (this.data.mcpOAuthClients && source in this.data.mcpOAuthClients) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- keyed by provider source id
      delete this.data.mcpOAuthClients[source];
      this.save();
    }
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

  // ---- Live steering ----

  getLiveSteering(): boolean {
    return this.data.liveSteering ?? false;
  }

  setLiveSteering(enabled: boolean): void {
    this.data.liveSteering = enabled;
    this.save();
  }

  // ---- Utility ----

  /** Clear all stored credentials. */
  clear(): void {
    this.data = {};
    this.save();
  }
}
