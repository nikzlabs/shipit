import path from "node:path";
import fs from "node:fs";
import type { DeploymentRecord } from "../shared/types.js";

/** Stored credentials for a deploy target. Generic bag of key-value pairs. */
export interface DeployCredentials {
  targetId: string;
  credentials: Record<string, string>;
  projectName?: string;
}

export class DeploymentStore {
  private baseDir: string;

  constructor(workspaceDir: string) {
    this.baseDir = path.join(workspaceDir, ".shipit-deploy");
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private configDir(sessionId: string): string {
    return path.join(this.baseDir, "configs", this.sanitizeId(sessionId));
  }

  private configPath(sessionId: string, targetId: string): string {
    return path.join(this.configDir(sessionId), `${this.sanitizeId(targetId)}.json`);
  }

  private historyPath(sessionId: string): string {
    return path.join(this.baseDir, "history", `${this.sanitizeId(sessionId)}.json`);
  }

  /** Save credentials for a target. */
  saveConfig(sessionId: string, config: DeployCredentials): void {
    const dir = this.configDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.configPath(sessionId, config.targetId),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  /** Load credentials for a target. Returns null if not configured. */
  loadConfig(sessionId: string, targetId: string): DeployCredentials | null {
    const filePath = this.configPath(sessionId, targetId);
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as DeployCredentials;
    } catch {
      return null;
    }
  }

  /** Delete credentials for a target (disconnect). */
  deleteConfig(sessionId: string, targetId: string): void {
    const filePath = this.configPath(sessionId, targetId);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ok if missing
    }
  }

  /** List which targets have credentials configured for a session. */
  listConfiguredTargets(sessionId: string): string[] {
    const dir = this.configDir(sessionId);
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  /** Record a completed deployment. */
  recordDeployment(sessionId: string, record: DeploymentRecord): void {
    const filePath = this.historyPath(sessionId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    let history: DeploymentRecord[] = [];
    try {
      history = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      // empty or missing
    }

    history.push(record);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf-8");
  }

  /** Get deployment history for a session. */
  getHistory(sessionId: string): DeploymentRecord[] {
    try {
      const data = fs.readFileSync(this.historyPath(sessionId), "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /** Delete all deployment data for a session (called on session delete). */
  deleteSession(sessionId: string): void {
    // Remove config directory
    try {
      fs.rmSync(this.configDir(sessionId), { recursive: true, force: true });
    } catch {
      // ok
    }
    // Remove history file
    try {
      fs.unlinkSync(this.historyPath(sessionId));
    } catch {
      // ok
    }
  }
}
