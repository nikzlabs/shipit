import fs from "node:fs";
import path from "node:path";
import { getErrorMessage } from "../shared/utils.js";

export type UtilityModelProvider = "openai-compatible" | "anthropic" | "claude-cli";

export interface UtilityModelConfig {
  provider: UtilityModelProvider;
  /** API key for hosted providers. Not required (and ignored) for `claude-cli`,
   *  which uses the OAuth credentials of the locally installed Claude Code CLI. */
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

interface CredentialData {
  agentEnv?: Record<string, string>;
  githubToken?: string;
  utilityModel?: UtilityModelConfig;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;
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

  // ---- Utility model ----

  getUtilityModel(): UtilityModelConfig | null {
    const m = this.data.utilityModel;
    if (!m) return null;
    // claude-cli uses the local Claude Code CLI's OAuth — no API key needed.
    if (m.provider === "claude-cli") return m;
    if (typeof m.apiKey === "string" && m.apiKey.trim()) return m;
    return null;
  }

  setUtilityModel(config: UtilityModelConfig): void {
    this.data.utilityModel = config;
    this.save();
  }

  clearUtilityModel(): void {
    delete this.data.utilityModel;
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
