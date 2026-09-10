import type { DatabaseManager } from "../shared/database.js";
import { isEncrypted, type SecretCipher } from "./secret-cipher.js";
import { hasUrlCredentials, stripRemoteUrlCredentials } from "./git-utils.js";

interface SecretRow {
  repo_url: string;
  key: string;
  value: string;
}

export class SecretStore {
  private db;
  private cipher?: SecretCipher;

  constructor(dbManager: DatabaseManager, cipher?: SecretCipher) {
    this.db = dbManager.db;
    this.cipher = cipher;
    this.verifyAndMigrate();
  }

  // Validate at boot so missing or incorrect keys cannot reach services as secret values.
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

  loadSecretNames(repoUrl: string): string[] {
    const rows = this.db.prepare(
      "SELECT key FROM secrets WHERE repo_url = ?",
    ).all(repoUrl) as Pick<SecretRow, "key">[];
    return rows.map((row) => row.key);
  }

  // Server-side plaintext only; browser responses must use loadSecretNames.
  loadSecrets(repoUrl: string): Record<string, string> {
    const rows = this.db.prepare(
      "SELECT key, value FROM secrets WHERE repo_url = ?",
    ).all(repoUrl) as SecretRow[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = this.cipher ? this.cipher.decrypt(row.value) : row.value;
    }
    return result;
  }

  deleteSecrets(repoUrl: string): void {
    this.db.prepare("DELETE FROM secrets WHERE repo_url = ?").run(repoUrl);
  }

  // Keep the clean URL's value on collisions; move stored ciphertext without re-encryption.
  scrubCredentialedRepoUrls(): number {
    const urls = (this.db.prepare("SELECT DISTINCT repo_url FROM secrets").all() as Pick<SecretRow, "repo_url">[])
      .map((r) => r.repo_url)
      .filter((url) => hasUrlCredentials(url));
    if (urls.length === 0) return 0;
    let moved = 0;
    const tx = this.db.transaction(() => {
      for (const url of urls) {
        const clean = stripRemoteUrlCredentials(url);
        const rows = this.db.prepare("SELECT * FROM secrets WHERE repo_url = ?").all(url) as SecretRow[];
        for (const row of rows) {
          const taken = this.db.prepare(
            "SELECT 1 FROM secrets WHERE repo_url = ? AND key = ? LIMIT 1",
          ).get(clean, row.key);
          if (!taken) {
            this.db.prepare(
              "INSERT INTO secrets (repo_url, key, value) VALUES (?, ?, ?)",
            ).run(clean, row.key, row.value);
            moved++;
          }
        }
        this.db.prepare("DELETE FROM secrets WHERE repo_url = ?").run(url);
      }
    });
    tx();
    return moved;
  }
}
