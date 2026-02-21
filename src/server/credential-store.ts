import fs from "node:fs";
import path from "node:path";

interface GitIdentity {
  name: string;
  email: string;
}

interface CredentialData {
  gitIdentity?: GitIdentity;
  agentEnv?: Record<string, string>;
  githubToken?: string;
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
      const parsed = JSON.parse(raw);
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
      console.error(
        "[credential-store] Failed to save:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---- Git identity ----

  getGitIdentity(): GitIdentity | null {
    const id = this.data.gitIdentity;
    if (id && typeof id.name === "string" && id.name.trim() && typeof id.email === "string" && id.email.trim()) {
      return id;
    }
    return null;
  }

  setGitIdentity(name: string, email: string): void {
    this.data.gitIdentity = { name, email };
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
    if (!this.data.agentEnv) {
      this.data.agentEnv = {};
    }
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

  // ---- Utility ----

  /** Clear all stored credentials. */
  clear(): void {
    this.data = {};
    this.save();
  }
}
