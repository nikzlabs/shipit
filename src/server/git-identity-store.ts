import fs from "node:fs";
import path from "node:path";

interface GitIdentity {
  name: string;
  email: string;
}

const DEFAULT_WORKSPACE_DIR = "/workspace";

/**
 * Persists git identity (name/email) at the workspace level so it can be
 * automatically applied to every new session without re-prompting.
 *
 * Storage file: `{workspaceDir}/.shipit/git-identity.json`
 */
export class GitIdentityStore {
  private filePath: string;
  private identity: GitIdentity | null = null;

  constructor(workspaceDir?: string) {
    const dir = path.join(workspaceDir ?? DEFAULT_WORKSPACE_DIR, ".shipit");
    this.filePath = path.join(dir, "git-identity.json");
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed.name === "string" &&
        parsed.name.trim() &&
        typeof parsed.email === "string" &&
        parsed.email.trim()
      ) {
        this.identity = { name: parsed.name, email: parsed.email };
      }
    } catch {
      this.identity = null;
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.identity, null, 2));
    } catch (err) {
      console.error(
        "[git-identity] Failed to save:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Get stored identity, or null if not set. */
  get(): GitIdentity | null {
    return this.identity;
  }

  /** Store git identity globally. */
  set(name: string, email: string): void {
    this.identity = { name, email };
    this.save();
  }

  /** Check if an identity has been stored. */
  hasIdentity(): boolean {
    return this.identity !== null;
  }
}
