import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import simpleGit from "simple-git";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { SessionManager, IDLE_LIGHT_MS, IDLE_EVICT_MS, IDLE_EVICT_MERGED_MS } from "./sessions.js";
import { escalateDiskTiers, resolveDiskWatermarks, type TierEscalationDeps } from "./disk-janitor.js";
import type { SessionRunnerRegistry } from "./session-runner.js";

// docs/161 Part 2 — disk-tier escalation ladder.
describe("escalateDiskTiers", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager | null = null;
  let underlyingDb: Database.Database | null = null;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "disk-tier-"));
    dbManager = new DatabaseManager(path.join(tmpDir, "test.db"));
    underlyingDb = dbManager.db;
  }

  afterEach(() => {
    dbManager?.close();
    dbManager = null;
    underlyingDb = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const NOW = Date.parse("2026-05-31T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

  function insertSession(row: {
    id: string;
    lastUsedAt: string;
    diskTier?: "hot" | "light" | "evicted";
    workspaceDir?: string;
    remoteUrl?: string;
    branch?: string;
    lastViewedAt?: string;
    mergedAt?: string;
  }) {
    underlyingDb!.prepare(
      `INSERT INTO sessions
         (id, title, created_at, last_used_at, last_viewed_at, workspace_dir, remote_url, branch, disk_tier, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.id,
      row.lastUsedAt,
      row.lastUsedAt,
      row.lastViewedAt ?? null,
      row.workspaceDir ?? null,
      row.remoteUrl ?? "https://github.com/example/repo.git",
      row.branch ?? "shipit/feature",
      row.diskTier ?? "hot",
      row.mergedAt ?? null,
    );
  }

  /** Minimal runner-registry fake: only `get`/`dispose` are exercised. */
  function fakeRegistry(
    runners: Record<string, { running?: boolean; viewerCount?: number }> = {},
  ): { registry: SessionRunnerRegistry; disposed: string[] } {
    const disposed: string[] = [];
    const registry = {
      get: (id: string) =>
        runners[id]
          ? { running: runners[id].running ?? false, viewerCount: runners[id].viewerCount ?? 0 }
          : undefined,
      dispose: (id: string) => { disposed.push(id); },
    } as unknown as SessionRunnerRegistry;
    return { registry, disposed };
  }

  const stubContainerManager = { destroy: () => Promise.resolve() };

  function baseDeps(sm: SessionManager, registry: SessionRunnerRegistry): TierEscalationDeps {
    return {
      sessionManager: sm,
      runnerRegistry: registry,
      serviceManagers: new Map(),
      containerManager: stubContainerManager,
      pruneVolumes: () => Promise.resolve(),
      now: () => NOW,
    };
  }

  async function initRepo(dir: string, opts: { dirty?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const g = simpleGit(dir);
    await g.init(["--initial-branch=main"]);
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    await g.add(".");
    await g.commit("init");
    if (opts.dirty) fs.writeFileSync(path.join(dir, "b.txt"), "uncommitted");
  }

  it("escalates hot → light after IDLE_LIGHT, preserving the checkout", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-old");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    insertSession({
      id: "old-hot",
      lastUsedAt: daysAgo(IDLE_LIGHT_MS / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(1);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("old-hot")?.diskTier).toBe("light");
    expect(disposed).toContain("old-hot");
    // light NEVER wipes the checkout.
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);
  });

  it("does NOT escalate a hot session younger than IDLE_LIGHT", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "fresh", lastUsedAt: hoursAgo(2), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("fresh")?.diskTier).toBe("hot");
  });

  it("uses max(lastUsedAt, lastViewedAt) — a recent view keeps a session warm", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({
      id: "viewed",
      lastUsedAt: daysAgo(30), // turn activity is ancient…
      lastViewedAt: hoursAgo(2), // …but it was opened 2h ago
      diskTier: "hot",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("viewed")?.diskTier).toBe("hot");
  });

  it("guards: never escalates a running session", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "busy", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry({ busy: { running: true } });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("busy")?.diskTier).toBe("hot");
  });

  it("guards: never escalates a session with an attached viewer", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "open", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry({ open: { viewerCount: 1 } });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("open")?.diskTier).toBe("hot");
  });

  it("excludes the just-started session", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "just-started", lastUsedAt: daysAgo(99), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry), "just-started");

    expect(result.toLight).toBe(0);
    expect(sm.get("just-started")?.diskTier).toBe("hot");
  });

  it("escalates light → evicted after IDLE_EVICT when the tree is clean", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-clean");
    await initRepo(wsDir);
    insertSession({
      id: "old-light",
      lastUsedAt: daysAgo(IDLE_EVICT_MS / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(sm.get("old-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("blocks light → evicted when a dirty tree can't be pushed (keeps at light)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-dirty");
    await initRepo(wsDir, { dirty: true }); // no `origin` remote → push fails
    insertSession({
      id: "dirty-light",
      lastUsedAt: daysAgo(IDLE_EVICT_MS / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByPush).toBe(1);
    // Stays at light, checkout preserved — the local commit survives on disk.
    expect(sm.get("dirty-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("disk-pressure: escalates LRU hot → light regardless of age until high mark", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    // Two fresh (below IDLE_LIGHT) hot sessions — age alone wouldn't touch them.
    const wsA = path.join(tmpDir, "ws-a");
    const wsB = path.join(tmpDir, "ws-b");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    insertSession({ id: "lru-old", lastUsedAt: hoursAgo(3), diskTier: "hot", workspaceDir: wsA });
    insertSession({ id: "lru-new", lastUsedAt: hoursAgo(1), diskTier: "hot", workspaceDir: wsB });

    // Free disk starts below low; after one escalation it crosses high.
    let free = 100;
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      diskFreeLow: 1000,
      diskFreeHigh: 5000,
      getFreeDiskBytes: () => {
        const cur = free;
        free = 9999; // next probe reports recovered space
        return Promise.resolve(cur);
      },
    });

    // Only the least-recently-used one is escalated before free recovers.
    expect(result.toLight).toBe(1);
    expect(sm.get("lru-old")?.diskTier).toBe("light");
    expect(sm.get("lru-new")?.diskTier).toBe("hot");
  });

  it("disk-pressure no-ops when free space is above the low-water mark", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "fresh", lastUsedAt: hoursAgo(2), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      diskFreeLow: 1000,
      diskFreeHigh: 5000,
      getFreeDiskBytes: () => Promise.resolve(8000),
    });

    expect(result.toLight).toBe(0);
    expect(sm.get("fresh")?.diskTier).toBe("hot");
  });

  // docs/161 — merge-aware eviction: a merged PR is a stronger "done" signal
  // than idle age, so merged sessions evict on the short IDLE_EVICT_MERGED_MS
  // clock (2d) while unmerged WIP stays on the gentle IDLE_EVICT_MS clock (14d).
  const mergedThresholdDays = IDLE_EVICT_MERGED_MS / 86_400_000;

  it("merge-aware: a merged session past the merged threshold evicts", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-merged");
    await initRepo(wsDir);
    insertSession({
      id: "merged-light",
      // Older than the 2d merged threshold but younger than the 14d default.
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      mergedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(sm.get("merged-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("merge-aware: an unmerged session of the same age is NOT evicted", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unmerged");
    await initRepo(wsDir);
    insertSession({
      id: "unmerged-light",
      // Past the merged threshold but well below the 14d unmerged clock.
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("unmerged-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("merge-aware: a merged session with a recent view is protected (idle age = max(used, viewed))", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-merged-viewed");
    await initRepo(wsDir);
    insertSession({
      id: "merged-viewed",
      lastUsedAt: daysAgo(30), // turn activity ancient
      mergedAt: daysAgo(30),
      lastViewedAt: hoursAgo(2), // …but reopened to look at 2h ago
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("merged-viewed")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("merge-aware: a merged, still-dirty session is committed + pushed before wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    // Bare remote that origin/main can be pushed to.
    const remoteDir = path.join(tmpDir, "remote.git");
    await simpleGit().init(["--bare", "--initial-branch=main", remoteDir]);

    const wsDir = path.join(tmpDir, "ws-merged-dirty");
    fs.mkdirSync(wsDir, { recursive: true });
    const g = simpleGit(wsDir);
    await g.init(["--initial-branch=main"]);
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");
    await g.addRemote("origin", remoteDir);
    fs.writeFileSync(path.join(wsDir, "a.txt"), "hello");
    await g.add(".");
    await g.commit("init");
    await g.push("origin", "main", ["--set-upstream"]);
    // Uncommitted edit at eviction time — must be committed + pushed, not lost.
    fs.writeFileSync(path.join(wsDir, "b.txt"), "uncommitted work");

    insertSession({
      id: "merged-dirty",
      lastUsedAt: daysAgo(mergedThresholdDays + 1),
      mergedAt: daysAgo(mergedThresholdDays + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(fs.existsSync(wsDir)).toBe(false);
    // The dirty edit reached the remote before the wipe (reclaim-only, no loss).
    const files = (await simpleGit(remoteDir).raw(["ls-tree", "--name-only", "main"]))
      .split("\n").filter(Boolean);
    expect(files).toContain("b.txt");
  });

  it("ignores already-evicted sessions", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "gone", lastUsedAt: daysAgo(99), diskTier: "evicted" });

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(disposed).not.toContain("gone");
  });
});

// docs/161 — portable disk-pressure watermarks: fraction-of-disk *_PCT vars
// derive byte thresholds from the host's total disk size, while explicit
// *_BYTES vars still win for backward compat.
describe("resolveDiskWatermarks", () => {
  const TOTAL = 1_000_000_000; // 1 GB host

  it("explicit *_BYTES win over *_PCT", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowBytes: 111,
      highBytes: 222,
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(111);
    expect(diskFreeHigh).toBe(222);
  });

  it("derives from *_PCT × total when bytes are absent", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(100_000_000);
    expect(diskFreeHigh).toBe(200_000_000);
  });

  it("resolves each watermark independently (bytes for one, pct for the other)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowBytes: 50,
      highPct: 0.2,
      totalBytes: TOTAL,
    });
    expect(diskFreeLow).toBe(50);
    expect(diskFreeHigh).toBe(200_000_000);
  });

  it("neither set → both undefined (override stays disabled)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({ totalBytes: TOTAL });
    expect(diskFreeLow).toBeUndefined();
    expect(diskFreeHigh).toBeUndefined();
  });

  it("*_PCT with unknown total → undefined (can't derive without statfs)", () => {
    const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
      lowPct: 0.1,
      highPct: 0.2,
      totalBytes: null,
    });
    expect(diskFreeLow).toBeUndefined();
    expect(diskFreeHigh).toBeUndefined();
  });
});
