/**
 * docs/262 req 19 — the boot sweep that removes remote credentials an EARLIER
 * build stored. Strip-on-write covers every row written from now on; these
 * cover the rows and checkouts an existing installation already has, which is
 * the half a strip-on-add alone can never reach.
 *
 * Fixture note: the password is deliberately short and generic — `secret-scan.ts`
 * flags `<user>:<8+ chars>@` in a URL, so a realistic-looking PAT here would trip
 * the scanner on every commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { DatabaseManager } from "../shared/database.js";
import { RepoStore } from "./repo-store.js";
import { SessionManager } from "./sessions.js";
import { runRemoteCredentialScrub } from "./startup-tasks.js";

const CREDENTIALED = "https://x-access-token:pw@github.com/o/r.git";
const CLEAN = "https://github.com/o/r.git";

let dbManager: DatabaseManager;
let repoStore: RepoStore;
let sessionManager: SessionManager;
let tmpDir: string;

/** A real checkout whose origin carries a credential, as an older build left it. */
function makeCredentialedCheckout(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", CREDENTIALED], { stdio: "ignore" });
  return dir;
}

/** Write a row the way an older build did — bypassing today's stripping writers. */
function seedLegacyRows(sessionId: string, workspaceDir?: string): void {
  dbManager.db.prepare(
    "INSERT INTO repos (url, added_at, last_used_at, status) VALUES (?, '2026-01-01', '2026-01-01', 'ready')",
  ).run(CREDENTIALED);
  sessionManager.track(sessionId, "legacy", workspaceDir);
  dbManager.db.prepare("UPDATE sessions SET remote_url = ? WHERE id = ?").run(CREDENTIALED, sessionId);
}

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  repoStore = new RepoStore(dbManager);
  sessionManager = new SessionManager(dbManager);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-scrub-"));
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runRemoteCredentialScrub", () => {
  it("rewrites the repo row, the session row and the checkout's own config", async () => {
    const workspaceDir = makeCredentialedCheckout("ws");
    seedLegacyRows("s1", workspaceDir);

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(result).toEqual({ repoRows: 1, sessionRows: 1, workspaces: 1 });
    expect(repoStore.list().map((r) => r.url)).toEqual([CLEAN]);
    expect(sessionManager.get("s1")?.remoteUrl).toBe(CLEAN);
    // The one copy plugin code can read: `/project/.git/config` in the session.
    const config = fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8");
    expect(config).not.toContain("pw@");
    expect(
      execFileSync("git", ["-C", workspaceDir, "remote", "get-url", "origin"], { encoding: "utf-8" }).trim(),
    ).toBe(CLEAN);
  });

  it("drops the credentialed row when the clean URL is already a row", async () => {
    // The same repository added twice — once with a credential, once without.
    // Renaming in place would collide on the primary key, so the duplicate goes.
    repoStore.add(CLEAN);
    dbManager.db.prepare(
      "INSERT INTO repos (url, added_at, last_used_at, status) VALUES (?, '2026-01-01', '2026-01-01', 'ready')",
    ).run(CREDENTIALED);
    repoStore.setTrusted(CREDENTIALED, true);

    await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(repoStore.list().map((r) => r.url)).toEqual([CLEAN]);
    // Trust is matched by canonical key, so it survives whichever row remains.
    expect(repoStore.isTrusted(CLEAN)).toBe(true);
  });

  it("is a no-op on a clean installation and does not spawn git for it", async () => {
    const dir = path.join(tmpDir, "clean");
    fs.mkdirSync(dir, { recursive: true });
    execSync("git init -b main", { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-C", dir, "remote", "add", "origin", CLEAN], { stdio: "ignore" });
    repoStore.add(CLEAN);
    sessionManager.track("s1", "clean", dir);
    sessionManager.setRemoteUrl("s1", CLEAN);

    expect(await runRemoteCredentialScrub({ repoStore, sessionManager }))
      .toEqual({ repoRows: 0, sessionRows: 0, workspaces: 0 });
    expect(repoStore.list().map((r) => r.url)).toEqual([CLEAN]);
  });

  it("survives a session whose checkout is gone and still fixes the rest", async () => {
    // Archived / disk-evicted sessions keep their row and lose their tree.
    seedLegacyRows("s1", path.join(tmpDir, "reclaimed"));

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(result.workspaces).toBe(0);
    expect(result.repoRows).toBe(1);
    expect(sessionManager.get("s1")?.remoteUrl).toBe(CLEAN);
  });
});
