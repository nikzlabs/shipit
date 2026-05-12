import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { runDiskJanitor } from "./disk-janitor.js";
import { repoUrlToHash } from "./git-utils.js";

describe("runDiskJanitor", () => {
  let tmpDir: string;
  let dbPath: string;
  let underlyingDb: Database.Database | null = null;
  let dbManager: DatabaseManager | null = null;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-janitor-"));
    dbPath = path.join(tmpDir, "test.db");
    dbManager = new DatabaseManager(dbPath);
    underlyingDb = dbManager.db;
  }

  afterEach(() => {
    dbManager?.close();
    underlyingDb = null;
    dbManager = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call builder/image prune (deploy.sh owns those)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const calls: string[][] = [];
    const runDocker = (args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve("");
    };

    await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    const subcommands = calls.map((args) => `${args[0]} ${args[1]}`);
    expect(subcommands).not.toContain("builder prune");
    expect(subcommands).not.toContain("image prune");
  });

  it("sweeps orphan session volumes whose session is no longer tracked", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Build one active session in the DB. Its compose volumes (matching
    // the `shipit-<sid12>_` prefix) MUST be preserved even though they're
    // dangling — that's the idle-evicted state, ready for warm resume.
    const liveSessionId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    const liveSessionPrefix = liveSessionId.slice(0, 12); // "abc123def456"
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveSessionId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const lsRequests: string[][] = [];
    const rmRequests: string[] = [];
    // Listing includes:
    //   - one volume for the live session (must be PRESERVED)
    //   - three volumes for sessions that no longer exist in DB (REMOVE)
    //   - one user-named volume that doesn't match the strict regex (PRESERVE)
    //   - the orchestrator's `shipit_workspace` (PRESERVE — underscore prefix)
    const dockerListing = [
      `shipit-${liveSessionPrefix}_node_modules`,
      "shipit-fed987654321_dist",
      "shipit-aaaa11112222_build",
      "shipit-deadbeef0000_cache",
      "shipit-foo-bar",         // wrong shape — no `_` after 12-hex
      "shipit_workspace",        // orchestrator volume, different prefix
    ].join("\n");

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") {
        lsRequests.push(args);
        return Promise.resolve(dockerListing);
      }
      if (args[0] === "volume" && args[1] === "rm") {
        rmRequests.push(args[2]);
        return Promise.resolve("");
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    // The `ls` call must include the dangling=true safety filter and the
    // `name=shipit-` scoping filter.
    expect(lsRequests).toHaveLength(1);
    expect(lsRequests[0]).toContain("--filter");
    expect(lsRequests[0]).toContain("dangling=true");
    expect(lsRequests[0]).toContain("name=shipit-");

    // Only the three orphan-session volumes get rm'd. The live session's
    // volume, the user-named oddball, and the orchestrator volume all stay.
    expect(rmRequests.sort()).toEqual([
      "shipit-aaaa11112222_build",
      "shipit-deadbeef0000_cache",
      "shipit-fed987654321_dist",
    ]);
    expect(result.orphanVolumesRemoved).toBe(3);
    expect(rmRequests).not.toContain(`shipit-${liveSessionPrefix}_node_modules`);
  });

  it("preserves volumes for idle-evicted (still-tracked) sessions", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Active session — represents an idle-evicted session whose container
    // was stopped but whose row stays in the DB.
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(sessionId, "Idle-Evicted", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const rmRequests: string[] = [];
    const dockerListing = `shipit-${sessionId.slice(0, 12)}_node_modules`;

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") return Promise.resolve(dockerListing);
      if (args[0] === "volume" && args[1] === "rm") {
        rmRequests.push(args[2]);
        return Promise.resolve("");
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    expect(rmRequests).toEqual([]);
    expect(result.orphanVolumesRemoved).toBe(0);
  });

  it("orphan volume sweep ignores rm failures (volume reattached / already gone)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") {
        return Promise.resolve("shipit-abc123def456_node_modules");
      }
      if (args[0] === "volume" && args[1] === "rm") {
        return Promise.reject(new Error("volume is in use"));
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    expect(result.orphanVolumesRemoved).toBe(0);
  });

  it("sweeps archived workspaces older than archivedWorkspaceDays", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Build two archived sessions: one old (40 days), one recent (5 days).
    const oldDir = path.join(tmpDir, "sessions", "old-session", "workspace");
    const recentDir = path.join(tmpDir, "sessions", "recent-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(recentDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "file"), "content");
    fs.writeFileSync(path.join(recentDir, "file"), "content");

    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const remote = "https://github.com/example/repo.git";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run("old-session", "Old", old, old, oldDir, remote);
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run("recent-session", "Recent", recent, recent, recentDir, remote);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      archivedWorkspaceDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("archive sweep is disabled by default (archivedWorkspaceDays = 0)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const oldDir = path.join(tmpDir, "sessions", "old-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString();
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run("old-session", "Old", old, old, oldDir, "https://github.com/example/repo.git");

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(0);
    expect(fs.existsSync(oldDir)).toBe(true);
  });

  it("skips archived sessions without a remoteUrl (defensive)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const oldDir = path.join(tmpDir, "sessions", "standalone-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    // No remote_url — should be skipped even though it's older than the threshold.
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, archived) VALUES (?, ?, ?, ?, ?, 1)",
    ).run("standalone-session", "Standalone", old, old, oldDir);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      archivedWorkspaceDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(0);
    expect(fs.existsSync(oldDir)).toBe(true);
  });

  it("sweeps unreferenced repo/dep cache directories", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    const staleHash = repoUrlToHash("https://github.com/example/stale.git");

    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    for (const sub of ["repo-cache", "dep-cache"]) {
      fs.mkdirSync(path.join(tmpDir, sub, liveHash), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, sub, staleHash), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, sub, liveHash, "marker"), "");
      fs.writeFileSync(path.join(tmpDir, sub, staleHash, "marker"), "");
    }

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.cachesRemoved).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "repo-cache", liveHash))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "dep-cache", liveHash))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "repo-cache", staleHash))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "dep-cache", staleHash))).toBe(false);
  });

  it("continues with workspace + cache sweeps when the volume sweep fails", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Stage an old archived workspace so the workspace sweep has something
    // to do; if the volume sweep failure short-circuited the run we'd see
    // workspacesRemoved=0 below.
    const oldDir = path.join(tmpDir, "sessions", "old-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run("old-session", "Old", old, old, oldDir, "https://github.com/example/repo.git");

    const runDocker = (): Promise<string> => Promise.reject(new Error("volume boom"));
    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      archivedWorkspaceDays: 30,
      runDocker,
    });

    expect(result.orphanVolumesRemoved).toBe(0);
    expect(result.workspacesRemoved).toBe(1);
  });
});
