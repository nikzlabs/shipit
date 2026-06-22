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
import { isEncrypted, type SecretCipher } from "./secret-cipher.js";

interface SecretRow {
  repo_url: string;
  key: string;
  value: string;
}

export class SecretStore {
  private db;
  private cipher?: SecretCipher;

  /**
   * @param cipher At-rest encryption (docs/220). When provided, values are
   *   encrypted on write and transparently decrypted on read (legacy plaintext
   *   rows read through unchanged and re-encrypt on the next save). When
   *   omitted, the store behaves exactly as before (plaintext) — this is how
   *   the many `new SecretStore(db)` test call sites keep working; production
   *   injects a cipher from app-di.
   */
  constructor(dbManager: DatabaseManager, cipher?: SecretCipher) {
    this.db = dbManager.db;
    this.cipher = cipher;
    this.verifyAndMigrate();
  }

  /**
   * Boot-time at-rest pass. Runs whether or not a cipher is configured:
   *
   * - **No cipher but encrypted rows exist** ⇒ throw. Without this, encryption
   *   being turned off (or the key going missing) would make `loadSecrets`
   *   hand ciphertext to services as if it were the secret value — a silent,
   *   confusing failure. Fail closed: demand the key (or a deliberate
   *   decrypt-export) before running encryption-off over encrypted data.
   * - **Cipher present** ⇒ decrypt-validate every already-encrypted row so a
   *   wrong/rotated key fails at construction (matching the failure-modes
   *   table — not lazily on the first session's `loadSecrets`), and re-encrypt
   *   any legacy plaintext rows in a single transaction.
   *
   * Idempotent and cheap — the secrets table is tiny and, after the first
   * boot, every row is already encrypted so the write side is a no-op.
   */
  private verifyAndMigrate(): void {
    const rows = this.db
      .prepare("SELECT rowid AS rowid, value FROM secrets")
      .all() as { rowid: number; value: string }[];

    if (!this.cipher) {
      if (rows.some((r) => isEncrypted(r.value))) {
        throw new Error(
          "[secret-store] Found encrypted secrets but no encryption key is " +
            "configured. Provide SHIPIT_SECRET_KEY / restore the key file, or run " +
            "a deliberate decrypt-export before disabling encryption.",
        );
      }
      return;
    }

    const plaintext: { rowid: number; value: string }[] = [];
    for (const r of rows) {
      if (isEncrypted(r.value)) {
        // Throws on a wrong/rotated key or tampered value — fail closed at boot.
        this.cipher.decrypt(r.value);
      } else {
        plaintext.push(r);
      }
    }
    if (plaintext.length === 0) return;
    const update = this.db.prepare("UPDATE secrets SET value = ? WHERE rowid = ?");
    const run = this.db.transaction(() => {
      for (const r of plaintext) {
        update.run(this.cipher!.encrypt(r.value), r.rowid);
      }
    });
    run();
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
        insert.run(repoUrl, key, this.cipher ? this.cipher.encrypt(value) : value);
      }
    });
    save();
  }

  /**
   * Load the *names* of secrets set for a repo — never their values. This is
   * the only shape safe to send to the browser: the settings UI needs to know
   * which keys have a stored value (to render "saved" state and custom rows),
   * but the plaintext values must never leave the orchestrator. See
   * `GET /api/secrets`.
   */
  loadSecretNames(repoUrl: string): string[] {
    const rows = this.db.prepare(
      "SELECT key FROM secrets WHERE repo_url = ?",
    ).all(repoUrl) as Pick<SecretRow, "key">[];
    return rows.map((row) => row.key);
  }

  /**
   * Load all secrets for a repo. Returns an empty object if none exist.
   *
   * SERVER-SIDE ONLY: this returns plaintext values for env-file resolution
   * (`service-manager-setup.ts`). Never return the result of this method over
   * an HTTP response to the browser — use `loadSecretNames` for that.
   */
  loadSecrets(repoUrl: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT key, value FROM secrets WHERE repo_url = ?",
    ).all(repoUrl) as SecretRow[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      // Transparent decrypt: a legacy plaintext row (no ENC_PREFIX) reads
      // through verbatim; an encrypted row is decrypted (throws on a wrong key
      // / tampered value rather than returning garbage — fail closed).
      result[row.key] = this.cipher ? this.cipher.decrypt(row.value) : row.value;
    }
    return result;
  }

  /** Delete all secrets for a repo. */
  deleteSecrets(repoUrl: string): void {
    this.db.prepare("DELETE FROM secrets WHERE repo_url = ?").run(repoUrl);
  }
}
