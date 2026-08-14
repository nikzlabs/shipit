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
import { createHash } from "node:crypto";
import { DatabaseManager } from "../shared/database.js";
import { RepoStore } from "./repo-store.js";
import { SecretStore } from "./secret-store.js";
import { SessionManager } from "./sessions.js";
import { runRemoteCredentialScrub } from "./startup-tasks.js";
import { repoUrlToHash } from "./git-utils.js";

/** How an older build named a per-repo directory: sha256 of the URL as typed. */
function legacyHash(repoUrl: string): string {
  return createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
}

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

    expect(result).toMatchObject({ repoRows: 1, sessionRows: 1, workspaces: 1 });
    expect(repoStore.list().map((r) => r.url)).toEqual([CLEAN]);
    expect(sessionManager.get("s1")?.remoteUrl).toBe(CLEAN);
    // The one copy plugin code can read: `/project/.git/config` in the session.
    const config = fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8");
    expect(config).not.toContain("pw@");
    expect(
      execFileSync("git", ["-C", workspaceDir, "remote", "get-url", "origin"], { encoding: "utf-8" }).trim(),
    ).toBe(CLEAN);
  });

  // The realistic legacy order, which an earlier version of this sweep got
  // wrong: the credentialed row is the one the user trusted and cloned, and the
  // clean row is a later, untouched shell. Deleting the credentialed row
  // silently un-trusted the repository and dropped its readiness and metadata.
  it("merges rather than deletes when the clean URL is already a row", async () => {
    dbManager.db.prepare(
      `INSERT INTO repos (url, added_at, last_used_at, status, trusted, default_branch, warm_session_id)
       VALUES (?, '2026-01-01', '2026-01-01', 'ready', 1, 'trunk', 'warm-9')`,
    ).run(CREDENTIALED);
    // Added later, straight from the clean URL: untrusted, still cloning.
    repoStore.add(CLEAN);

    await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(repoStore.list().map((r) => r.url)).toEqual([CLEAN]);
    const survivor = repoStore.get(CLEAN)!;
    expect(repoStore.isTrusted(CLEAN)).toBe(true);
    expect(survivor.status).toBe("ready");
    expect(survivor.defaultBranch).toBe("trunk");
    expect(survivor.warmSessionId).toBe("warm-9");
  });

  // `listAll` filters `warm = 0`. A warm row is a real checkout that the next
  // claim hands to a user, so skipping it left the token in the workspace most
  // likely to be handed out next.
  it("scrubs warm sessions, which are not in listAll", async () => {
    const workspaceDir = makeCredentialedCheckout("warm-ws");
    sessionManager.track("warm-1", "Warm session", workspaceDir);
    sessionManager.setWarm("warm-1", true);
    dbManager.db.prepare("UPDATE sessions SET remote_url = ? WHERE id = ?").run(CREDENTIALED, "warm-1");

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(result.sessionRows).toBe(1);
    expect(result.workspaces).toBe(1);
    expect(sessionManager.get("warm-1")?.remoteUrl).toBe(CLEAN);
    expect(fs.readFileSync(path.join(workspaceDir, ".git", "config"), "utf-8")).not.toContain("pw@");
  });

  // A distinct `pushurl` is a second URL in the same config, and a fetch-only
  // rewrite left it credentialed.
  it("rewrites a credentialed push URL, and adds no pushurl where there was none", async () => {
    const dir = path.join(tmpDir, "pushurl-ws");
    fs.mkdirSync(dir, { recursive: true });
    execSync("git init -b main", { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-C", dir, "remote", "add", "origin", CLEAN], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "remote", "set-url", "--push", "origin", CREDENTIALED], { stdio: "ignore" });
    sessionManager.track("s1", "legacy", dir);

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager });

    expect(result.workspaces).toBe(1);
    expect(fs.readFileSync(path.join(dir, ".git", "config"), "utf-8")).not.toContain("pw@");
    expect(
      execFileSync("git", ["-C", dir, "remote", "get-url", "--push", "origin"], { encoding: "utf-8" }).trim(),
    ).toBe(CLEAN);

    // And a remote with no distinct push URL keeps a config with a single `url`.
    const plain = makeCredentialedCheckout("plain-ws");
    sessionManager.track("s2", "legacy", plain);
    await runRemoteCredentialScrub({ repoStore, sessionManager });
    expect(fs.readFileSync(path.join(plain, ".git", "config"), "utf-8")).not.toContain("pushurl");
  });

  // The URL is the secret store's key, so scrubbing it without re-keying leaves
  // the user's saved values on disk under a key nothing looks up — and the
  // credentialed key is itself a stored credential.
  it("re-keys stored secrets onto the clean URL", async () => {
    const secretStore = new SecretStore(dbManager);
    dbManager.db.prepare("INSERT INTO secrets (repo_url, key, value) VALUES (?, 'API_KEY', 'v1')")
      .run(CREDENTIALED);
    dbManager.db.prepare("INSERT INTO secrets (repo_url, key, value) VALUES (?, 'OTHER', 'v2')")
      .run(CREDENTIALED);
    // A key the user has since re-entered under the clean URL wins.
    secretStore.saveSecrets(CLEAN, { API_KEY: "current" });

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager, secretStore });

    expect(result.secrets).toBe(1); // OTHER moved; API_KEY was already there.
    expect(secretStore.loadSecrets(CLEAN)).toEqual({ API_KEY: "current", OTHER: "v2" });
    expect(secretStore.loadSecretNames(CREDENTIALED)).toEqual([]);
    expect(
      dbManager.db.prepare("SELECT COUNT(*) as n FROM secrets WHERE repo_url LIKE '%pw@%'").get(),
    ).toEqual({ n: 0 });
  });

  // Every per-repo directory is named after a hash of the URL, so a rewritten
  // URL renames them all. Left behind, the bare cache re-clones (slow but
  // self-healing) and the agent's accumulated memory for the repo silently
  // reads as empty.
  it("carries the directories keyed by the old URL across, and scrubs the cache's own origin", async () => {
    const cacheRoot = path.join(tmpDir, "repo-cache");
    const dirFor = (hash: string): string => path.join(cacheRoot, hash);
    // An older build named the directory after the credentialed URL and cloned
    // it WITH the credential in its origin. `repoUrlToHash` no longer produces
    // that name, which is exactly why the sweep keeps its own copy of the old
    // rule — this fixture asserts the two agree.
    const oldCache = dirFor(legacyHash(CREDENTIALED));
    fs.mkdirSync(oldCache, { recursive: true });
    execSync("git init --bare", { cwd: oldCache, stdio: "ignore" });
    execFileSync("git", ["-C", oldCache, "remote", "add", "origin", CREDENTIALED], { stdio: "ignore" });
    seedLegacyRows("s1");

    const result = await runRemoteCredentialScrub({
      repoStore, sessionManager, repoKeyedDirs: [dirFor],
    });

    expect(result.dirs).toBe(1);
    expect(fs.existsSync(oldCache)).toBe(false);
    const newCache = dirFor(repoUrlToHash(CLEAN));
    expect(fs.existsSync(newCache)).toBe(true);
    expect(fs.readFileSync(path.join(newCache, "config"), "utf-8")).not.toContain("pw@");
  });

  it("leaves a per-repo directory alone when the clean URL already has one", async () => {
    const root = path.join(tmpDir, "dirs");
    const dirFor = (hash: string): string => path.join(root, hash);
    const oldDir = dirFor(legacyHash(CREDENTIALED));
    const newDir = dirFor(repoUrlToHash(CLEAN));
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, "marker"), "keep me");
    seedLegacyRows("s1");

    const result = await runRemoteCredentialScrub({ repoStore, sessionManager, repoKeyedDirs: [dirFor] });

    expect(result.dirs).toBe(0);
    expect(fs.existsSync(oldDir)).toBe(true);
    expect(fs.readFileSync(path.join(newDir, "marker"), "utf-8")).toBe("keep me");
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
      .toEqual({ repoRows: 0, sessionRows: 0, workspaces: 0, secrets: 0, dirs: 0 });
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
