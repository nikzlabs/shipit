/**
 * SecretStore — per-repo secrets stored in SQLite.
 *
 * Secrets are key-value pairs (environment variables) associated with a repo
 * URL. The orchestrator resolves them against `x-shipit-secrets` declarations
 * in the user's docker-compose.yml and writes per-service env files
 * (`.shipit/.env.<service>`) referenced by the compose override via
 * `env_file:`. See feature 087 for the full pipeline.
 *
 * Follows the same structural pattern as DeploymentStore: SQLite via
 * DatabaseManager, class wrapping prepared statements.
 */

import type { DatabaseManager } from "../shared/database.js";

interface SecretRow {
  repo_url: string;
  key: string;
  value: string;
}

export class SecretStore {
  private db;

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.db;
  }

  /**
   * Replace all secrets for a repo. Deletes existing rows and inserts the
   * new set atomically. This ensures deleted keys don't linger.
   */
  saveSecrets(repoUrl: string, secrets: Record<string, string>): void {
    const save = this.db.transaction(() => {
      this.db.prepare("DELETE FROM secrets WHERE repo_url = ?").run(repoUrl);
      const insert = this.db.prepare(
        "INSERT INTO secrets (repo_url, key, value) VALUES (?, ?, ?)",
      );
      for (const [key, value] of Object.entries(secrets)) {
        insert.run(repoUrl, key, value);
      }
    });
    save();
  }

  /** Load all secrets for a repo. Returns an empty object if none exist. */
  loadSecrets(repoUrl: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT key, value FROM secrets WHERE repo_url = ?",
    ).all(repoUrl) as SecretRow[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /** Delete all secrets for a repo. */
  deleteSecrets(repoUrl: string): void {
    this.db.prepare("DELETE FROM secrets WHERE repo_url = ?").run(repoUrl);
  }
}
