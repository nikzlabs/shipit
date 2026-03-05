import type { DeploymentRecord } from "../shared/types.js";
import type { DatabaseManager } from "../shared/database.js";

/** Stored credentials for a deploy target. Generic bag of key-value pairs. */
export interface DeployCredentials {
  targetId: string;
  credentials: Record<string, string>;
  projectName?: string;
}

interface ConfigRow {
  session_id: string;
  target_id: string;
  credentials: string;
  project_name: string | null;
}

interface HistoryRow {
  id: string;
  session_id: string;
  target_id: string;
  environment: string;
  url: string;
  commit_hash: string;
  commit_message: string;
  timestamp: string;
  duration_ms: number;
  status: string;
  error: string | null;
}

export class DeploymentStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  /** Save credentials for a target. */
  saveConfig(sessionId: string, config: DeployCredentials): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO deploy_configs (session_id, target_id, credentials, project_name)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, config.targetId, JSON.stringify(config.credentials), config.projectName ?? null);
  }

  /** Load credentials for a target. Returns null if not configured. */
  loadConfig(sessionId: string, targetId: string): DeployCredentials | null {
    const row = this.db.prepare(
      "SELECT * FROM deploy_configs WHERE session_id = ? AND target_id = ?",
    ).get(sessionId, targetId) as ConfigRow | undefined;

    if (!row) return null;

    return {
      targetId: row.target_id,
      credentials: JSON.parse(row.credentials) as Record<string, string>,
      projectName: row.project_name ?? undefined,
    };
  }

  /** Delete credentials for a target (disconnect). */
  deleteConfig(sessionId: string, targetId: string): void {
    this.db.prepare(
      "DELETE FROM deploy_configs WHERE session_id = ? AND target_id = ?",
    ).run(sessionId, targetId);
  }

  /** List which targets have credentials configured for a session. */
  listConfiguredTargets(sessionId: string): string[] {
    const rows = this.db.prepare(
      "SELECT target_id FROM deploy_configs WHERE session_id = ?",
    ).all(sessionId) as { target_id: string }[];
    return rows.map((r) => r.target_id);
  }

  /** Record a completed deployment. */
  recordDeployment(sessionId: string, record: DeploymentRecord): void {
    this.db.prepare(`
      INSERT INTO deploy_history (id, session_id, target_id, environment, url, commit_hash, commit_message, timestamp, duration_ms, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      sessionId,
      record.targetId,
      record.environment,
      record.url,
      record.commitHash ?? "",
      record.commitMessage ?? "",
      record.timestamp,
      record.durationMs,
      record.status,
      record.error ?? null,
    );
  }

  /** Get deployment history for a session. */
  getHistory(sessionId: string): DeploymentRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM deploy_history WHERE session_id = ? ORDER BY timestamp DESC",
    ).all(sessionId) as HistoryRow[];

    return rows.map((r) => {
      const record: DeploymentRecord = {
        id: r.id,
        targetId: r.target_id,
        environment: r.environment as DeploymentRecord["environment"],
        url: r.url,
        timestamp: r.timestamp,
        durationMs: r.duration_ms,
        status: r.status as DeploymentRecord["status"],
      };
      if (r.commit_hash) record.commitHash = r.commit_hash;
      if (r.commit_message) record.commitMessage = r.commit_message;
      if (r.error) record.error = r.error;
      return record;
    });
  }

  /** Delete all deployment data for a session. */
  deleteSession(sessionId: string): void {
    const del = this.db.transaction(() => {
      this.db.prepare("DELETE FROM deploy_configs WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM deploy_history WHERE session_id = ?").run(sessionId);
    });
    del();
  }
}
