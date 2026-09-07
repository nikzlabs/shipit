import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureManagedOpenCodeData,
  openCodeAccessToken,
  openCodeAccountFile,
  writeOpenCodeAccount,
  readOpenCodeAccount,
  removeOpenCodeAccount,
} from "./opencode-account.js";

const roots: string[] = [];
const home = () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-account-"));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0))
    {fs.rmSync(p, { recursive: true, force: true });}
});
function auth(
  account = "account-a",
  expires = Math.floor(Date.now() / 1000) + 3600,
) {
  return {
    tokens: {
      access_token: `e30.${Buffer.from(JSON.stringify({ exp: expires, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test`,
      account_id: account,
      refresh_token: "must-never-be-copied",
    },
  };
}

describe("OpenCode managed ChatGPT account", () => {
  it("delivers access only, using the XDG path and private file permissions", () => {
    const root = home();
    const data = ensureManagedOpenCodeData(root);
    const token = openCodeAccessToken(auth());
    writeOpenCodeAccount(data, token);
    expect(readOpenCodeAccount(data)).toEqual(token);
    expect(fs.readFileSync(openCodeAccountFile(data), "utf8")).not.toContain(
      "must-never-be-copied",
    );
    expect(fs.statSync(openCodeAccountFile(data)).mode & 0o777).toBe(0o600);
    expect(
      fs.existsSync(path.join(root, ".local/share/opencode/auth.json")),
    ).toBe(false);
  });

  it("rejects expired, missing, malformed and mismatched identities", () => {
    expect(() => openCodeAccessToken(auth("a", 1))).toThrow();
    expect(() => openCodeAccessToken({})).toThrow();
    const wrong = auth();
    wrong.tokens.account_id = "b";
    expect(() => openCodeAccessToken(wrong)).toThrow(/identity/);
    expect(() =>
      openCodeAccessToken({ tokens: { access_token: "not-a-jwt" } }),
    ).toThrow(/unreadable/);
  });

  it("migrates a former global local-runtime home into a private session home", () => {
    const previous = home();
    const current = home();
    fs.mkdirSync(path.join(previous, ".local/share/opencode"), {
      recursive: true,
    });
    const db = new Database(
      path.join(previous, ".local/share/opencode/opencode.db"),
    );
    db.exec(
      "CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('old-local-session')",
    );
    db.close();
    const data = ensureManagedOpenCodeData(current, previous);
    const migrated = new Database(path.join(data, "opencode/opencode.db"));
    try {
      expect(migrated.prepare("SELECT id FROM session").get()).toEqual({
        id: "old-local-session",
      });
    } finally {
      migrated.close();
    }
  });

  it("migrates a consistent SQLite snapshot once and keeps terminal auth separate", () => {
    const root = home();
    const old = path.join(root, ".local/share/opencode");
    fs.mkdirSync(old, { recursive: true });
    const db = new Database(path.join(old, "opencode.db"));
    try {
      db.pragma("journal_mode=WAL");
      db.exec(
        "CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('resume-me')",
      );
      fs.writeFileSync(
        path.join(old, "auth.json"),
        JSON.stringify({ openai: { refresh: "terminal-token" } }),
      );
      const data = ensureManagedOpenCodeData(root);
      const copy = new Database(path.join(data, "opencode/opencode.db"));
      try {
        expect(copy.prepare("SELECT id FROM session").get()).toEqual({
          id: "resume-me",
        });
      } finally {
        copy.close();
      }
      expect(fs.existsSync(openCodeAccountFile(data))).toBe(false);
      writeOpenCodeAccount(data, openCodeAccessToken(auth()));
      removeOpenCodeAccount(data);
      expect(fs.existsSync(path.join(data, "opencode/opencode.db"))).toBe(true);
      expect(fs.readFileSync(path.join(old, "auth.json"), "utf8")).toContain(
        "terminal-token",
      );
      db.exec("INSERT INTO session VALUES ('later-terminal-work')");
      expect(ensureManagedOpenCodeData(root)).toBe(data);
      const again = new Database(path.join(data, "opencode/opencode.db"));
      try {
        expect(
          again.prepare("SELECT COUNT(*) AS n FROM session").get(),
        ).toEqual({ n: 1 });
      } finally {
        again.close();
      }
    } finally {
      db.close();
    }
  });
});
