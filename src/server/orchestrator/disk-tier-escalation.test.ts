import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import simpleGit from "simple-git";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { GitManager } from "../shared/git.js";
import { SessionManager, DEFAULT_DISK_LADDER, assertDiskLadderOrdering } from "./sessions.js";
import { escalateDiskTiers, type TierEscalationDeps } from "./tier-escalation.js";
import { resolveDiskWatermarks } from "./disk-utils.js";
import type { SessionRunnerRegistry } from "./session-runner.js";

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

  function fakeRegistry(
    runners: Record<string, {
      running?: boolean;
      viewerCount?: number;
      backgroundTaskCount?: number;
      postTurnWorkInFlight?: boolean;
    }> = {},
  ): { registry: SessionRunnerRegistry; disposed: string[] } {
    const disposed: string[] = [];
    const state = new Map<string, { disposed: boolean }>();
    const registry = {
      get: (id: string) => {
        const r = runners[id];
        if (!r) return undefined;
        const running = r.running ?? false;
        const backgroundTaskCount = r.backgroundTaskCount ?? 0;
        const postTurnWorkInFlight = r.postTurnWorkInFlight ?? false;
        let slot = state.get(id);
        if (!slot) { slot = { disposed: false }; state.set(id, slot); }
        return {
          running,
          viewerCount: r.viewerCount ?? 0,
          backgroundTaskCount,
          postTurnWorkInFlight,
          agentBusy: running || backgroundTaskCount > 0 || postTurnWorkInFlight,
          get disposed() { return slot.disposed; },
        };
      },
      dispose: (id: string) => {
        disposed.push(id);
        const r = runners[id];
        if (!r) return;
        let slot = state.get(id);
        if (!slot) { slot = { disposed: false }; state.set(id, slot); }
        if (r.running || r.postTurnWorkInFlight) return;
        slot.disposed = true;
      },
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

  async function initRepo(dir: string, opts: { dirty?: boolean; noRemote?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const g = simpleGit(dir);
    await g.init(["--initial-branch=main"]);
    await g.addConfig("user.email", "test@example.com");
    await g.addConfig("user.name", "Test");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    await g.add(".");
    await g.commit("init");
    if (!opts.noRemote) {
      const remoteDir = `${dir}-remote.git`;
      await simpleGit().init(["--bare", "--initial-branch=main", remoteDir]);
      await g.addRemote("origin", remoteDir);
      await g.push("origin", "main", ["--set-upstream"]);
    }
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
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(1);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("old-hot")?.diskTier).toBe("light");
    expect(disposed).toContain("old-hot");
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);
  });

  it("docs/235: never descends a session holding outstanding background tasks", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-bg");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "bg-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry, disposed } = fakeRegistry({
      "bg-old": { running: false, backgroundTaskCount: 1 },
    });
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(sm.get("bg-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("bg-old");
  });

  it("docs/110: NEVER descends a pinned session, even when ancient and idle", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-pinned");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    insertSession({
      id: "pinned-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 5),
      diskTier: "hot",
      workspaceDir: wsDir,
    });
    sm.setPinned("pinned-old", "2026-05-01T00:00:00.000Z");

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("pinned-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("pinned-old");
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);

    sm.setPinned("pinned-old", null);
    const after = await escalateDiskTiers(baseDeps(sm, registry));
    expect(after.toLight + after.toEvicted).toBeGreaterThan(0);
    expect(sm.get("pinned-old")?.diskTier).not.toBe("hot");
  });

  it("docs/241: NEVER descends a session with an always-on preview reservation", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-reserved");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "keep.txt"), "x");
    insertSession({
      id: "reserved-old",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 5),
      diskTier: "hot",
      workspaceDir: wsDir,
    });
    sm.setKeepPreviewRunning("reserved-old", true);

    const { registry, disposed } = fakeRegistry();
    const result = await escalateDiskTiers(baseDeps(sm, registry));

    expect(result.toLight).toBe(0);
    expect(result.toEvicted).toBe(0);
    expect(sm.get("reserved-old")?.diskTier).toBe("hot");
    expect(disposed).not.toContain("reserved-old");
    expect(fs.existsSync(path.join(wsDir, "keep.txt"))).toBe(true);

    sm.setKeepPreviewRunning("reserved-old", false);
    const after = await escalateDiskTiers(baseDeps(sm, registry));
    expect(after.toLight + after.toEvicted).toBeGreaterThan(0);
    expect(sm.get("reserved-old")?.diskTier).not.toBe("hot");
  });

  it("does not destroy the container when the runner declines disposal mid-pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-toctou");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "toctou",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    let busy = false;
    const disposed: string[] = [];
    const registry = {
      get: () => ({
        running: false,
        viewerCount: 0,
        backgroundTaskCount: 0,
        get agentBusy() { const answer = busy; busy = true; return answer; },
        get disposed() { return false; },
      }),
      dispose: (id: string) => { disposed.push(id); },
    } as unknown as SessionRunnerRegistry;

    const destroyed: string[] = [];
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      containerManager: { destroy: (id: string) => { destroyed.push(id); return Promise.resolve(); } },
    } as TierEscalationDeps);

    expect(disposed).toContain("toctou");
    expect(destroyed).toEqual([]);
    expect(result.toLight).toBe(0);
    expect(sm.get("toctou")?.diskTier).toBe("hot");
  });

  it("paces age-based descents when paceMs is set", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-pace");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "old-hot",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const { registry } = fakeRegistry();
    const paceMs = 30;
    const startedAt = Date.now();
    const result = await escalateDiskTiers({ ...baseDeps(sm, registry), paceMs });
    const elapsed = Date.now() - startedAt;

    expect(result.toLight).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(paceMs - 5);
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
      lastUsedAt: daysAgo(30),
      lastViewedAt: hoursAgo(2),
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
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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

  it("docs/290: light → evicted stops a stack that is NOT in serviceManagers, before the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-surviving-stack");
    await initRepo(wsDir);
    insertSession({
      id: "stack-survivor",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const order: string[] = [];
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      serviceManagers: new Map(),
      createGitManager: (dir) => new GitManager(dir),
      stopComposeStack: (sid) => {
        order.push(`stop:${sid}`);
        expect(fs.existsSync(wsDir)).toBe(true);
        return Promise.resolve();
      },
    });

    expect(order).toEqual(["stop:stack-survivor"]);
    expect(result.toEvicted).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("docs/290: refuses to wipe when the compose stack could not be stopped", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-stack-stuck");
    await initRepo(wsDir);
    insertSession({
      id: "stack-stuck",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      stopComposeStack: () => Promise.reject(new Error("daemon unreachable")),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("stack-stuck")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("docs/290: refuses to wipe a session that became active DURING the teardown", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-active-during-teardown");
    await initRepo(wsDir);
    insertSession({
      id: "late-active",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    let attached = false;
    const registry = {
      get: () => (attached ? { running: false, viewerCount: 1, agentBusy: false, disposed: true } : undefined),
      dispose: () => {},
    } as unknown as SessionRunnerRegistry;

    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      stopComposeStack: () => { attached = true; return Promise.resolve(); },
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("late-active")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("docs/290: hot → light tears down a stack with no manager and no runner", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-light-stack");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "light-stack",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const stopped: string[] = [];
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      stopComposeStack: (sid) => { stopped.push(sid); return Promise.resolve(); },
    });

    expect(result.toLight).toBe(1);
    expect(stopped).toEqual(["light-stack"]);
  });

  it("docs/290: drops the manager from the map once its stack is stopped", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-drop-mgr");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "drop-mgr",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.lightAfterMs / 86_400_000 + 1),
      diskTier: "hot",
      workspaceDir: wsDir,
    });

    const stopOpts: unknown[] = [];
    const serviceManagers = new Map<string, { stop: (o?: unknown) => Promise<void> }>([
      ["drop-mgr", { stop: (o?: unknown) => { stopOpts.push(o); return Promise.resolve(); } }],
    ]);
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      serviceManagers,
    } as unknown as TierEscalationDeps);

    expect(result.toLight).toBe(1);
    expect(stopOpts).toEqual([{ removeVolumes: true }]);
    expect(serviceManagers.has("drop-mgr")).toBe(false);
  });

  it("light → evicted wipes workspace/ but spares the sibling scratch/ (docs/217)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-evict-scratch");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    const scratchFile = path.join(sessionRoot, "scratch", "kept.txt");
    fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
    fs.writeFileSync(scratchFile, "survives eviction");
    insertSession({
      id: "evict-scratch",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(fs.existsSync(wsDir)).toBe(false);
    expect(fs.existsSync(scratchFile)).toBe(true);
  });

  it("light → evicted wipes workspace/ AND overlay/ but spares uploads/ (planning#194)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-evict-overlay");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    const overlayUpper = path.join(sessionRoot, "overlay", "deadbeef", "upper", "dep");
    fs.mkdirSync(path.dirname(overlayUpper), { recursive: true });
    fs.writeFileSync(overlayUpper, "install delta");
    const uploadFile = path.join(sessionRoot, "uploads", "photo.png");
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, "user upload");
    insertSession({
      id: "evict-overlay",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(fs.existsSync(wsDir)).toBe(false);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
    expect(fs.existsSync(uploadFile)).toBe(true);
  });

  it("still evicts a USER-ARCHIVED session left at light (the retry archiving relies on)", async () => {
    // Archiving a session whose commits are on no remote keeps the checkout and leaves
    // the tier at 'light' instead of 'evicted', precisely so this pass comes back for
    // it. If archived rows dropped out of the candidate set, that checkout would be
    // kept forever and the promise of a background retry would be empty.
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-archived");
    await initRepo(wsDir, {});
    insertSession({
      id: "archived-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });
    underlyingDb!.prepare("UPDATE sessions SET user_archived = 1, archived = 1 WHERE id = ?")
      .run("archived-light");

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("blocks light → evicted when a dirty tree can't be pushed (keeps at light)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-dirty");
    await initRepo(wsDir, { dirty: true, noRemote: true });
    insertSession({
      id: "dirty-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(sm.get("dirty-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  function fakeChatHistory() {
    const appended: { sessionId: string; text: string }[] = [];
    return {
      appended,
      chatHistory: {
        append: (sessionId: string, message: { text?: string }) => {
          appended.push({ sessionId, text: message.text ?? "" });
        },
      },
    };
  }

  // Assemble the fixture at runtime so it does not trigger the repository's secret scanner.
  const FIXTURE_AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  for (const kind of ["ops", "sandbox"] as const) {
    for (const shape of ["dirty, no origin", "clean, pushed to an origin"] as const) {
      it(`never evicts a ${kind} session (${shape}) and makes no commit`, async () => {
        setup();
        const sm = new SessionManager(dbManager!);
        const clean = shape === "clean, pushed to an origin";
        const wsDir = path.join(tmpDir, `ws-${kind}-${clean ? "clean" : "dirty"}`);
        await initRepo(wsDir, { dirty: !clean, noRemote: !clean });
        insertSession({
          id: `${kind}-light`,
          lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
          diskTier: "light",
          workspaceDir: wsDir,
          branch: "main",
        });
        sm.setKind(`${kind}-light`, kind);

        const { registry } = fakeRegistry();
        const { appended, chatHistory } = fakeChatHistory();
        const before = (await new GitManager(wsDir).log()).length;
        const result = await escalateDiskTiers({
          ...baseDeps(sm, registry),
          createGitManager: (dir) => new GitManager(dir),
          chatHistory,
          notifiedEvictBlocked: new Set<string>(),
        });

        expect(result.toEvicted).toBe(0);
        expect(sm.get(`${kind}-light`)?.diskTier).toBe("light");
        expect(fs.existsSync(wsDir)).toBe(true);
        expect((await new GitManager(wsDir).log()).length).toBe(before);
        expect(await new GitManager(wsDir).isClean()).toBe(clean);
        if (!clean) expect(fs.existsSync(path.join(wsDir, "b.txt"))).toBe(true);
        expect(appended).toHaveLength(0);
      });
    }
  }

  it("still evicts an ordinary session with the same clean, pushed shape", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-ordinary-clean");
    await initRepo(wsDir);
    insertSession({
      id: "ordinary-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(sm.get("ordinary-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
  });

  it("planning#296: a secret-refused auto-commit blocks the wipe (keeps the checkout)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "sess-secret");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    fs.writeFileSync(path.join(wsDir, "notes.md"), "a week of uncommitted work");
    fs.writeFileSync(path.join(wsDir, ".env"), `AWS_ACCESS_KEY_ID=${FIXTURE_AWS_KEY}\n`);
    const overlayUpper = path.join(sessionRoot, "overlay", "deadbeef", "upper", "dep");
    fs.mkdirSync(path.dirname(overlayUpper), { recursive: true });
    fs.writeFileSync(overlayUpper, "install delta");
    const uploadFile = path.join(sessionRoot, "uploads", "photo.png");
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, "user upload");
    insertSession({
      id: "secret-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(result.evictBlockedByPush).toBe(0);
    expect(sm.get("secret-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "notes.md"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, ".env"))).toBe(true);
    expect(fs.existsSync(uploadFile)).toBe(true);
    const log = await simpleGit(wsDir).log();
    expect(log.all.length).toBe(1);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.sessionId).toBe("secret-light");
    expect(appended[0]!.text).toContain("Disk cleanup paused");
    expect(appended[0]!.text).toContain("AWS access key ID");
    expect(appended[0]!.text).toContain(".env");
    expect(appended[0]!.text).not.toContain(FIXTURE_AWS_KEY);
  });

  it("planning#296: an unresolved merge state blocks the wipe (keeps the checkout)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-conflict");
    await initRepo(wsDir);
    const g = simpleGit(wsDir);
    await g.checkoutLocalBranch("other");
    fs.writeFileSync(path.join(wsDir, "a.txt"), "theirs");
    await g.add(".");
    await g.commit("theirs");
    await g.checkout("main");
    fs.writeFileSync(path.join(wsDir, "a.txt"), "mine");
    await g.add(".");
    await g.commit("mine");
    await g.merge(["other"]).catch(() => { /* expected conflict */ });
    insertSession({
      id: "conflict-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(sm.get("conflict-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(appended[0]!.text).toContain("unresolved merge state");
  });

  it("planning#296: still evicts when the null hash meant 'nothing to commit'", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-race");
    await initRepo(wsDir);
    insertSession({
      id: "race-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    let cleanCalls = 0;
    const stubGit = {
      isClean: () => Promise.resolve(cleanCalls > 0),
      inspectWorkingTree: () => Promise.resolve({ clean: cleanCalls++ > 0, unreadable: null }),
      autoCommit: () => Promise.resolve({
        commitHash: null, conflictedFiles: [], rebaseInProgress: false, secretFindings: [], unreadable: null,
      }),
      isRebaseInProgress: () => Promise.resolve(false),
      isMergeOrSequencerInProgress: () => Promise.resolve(false),
      currentBranchOrNull: () => Promise.resolve("main"),
      getHeadHash: () => Promise.resolve("abc"),
      getRefHash: () => Promise.resolve("abc"),
      isAncestor: () => Promise.resolve(true),
      push: () => Promise.resolve(""),
    } as unknown as GitManager;

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: () => stubGit,
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(1);
    expect(result.evictBlockedByDirty).toBe(0);
    expect(sm.get("race-light")?.diskTier).toBe("evicted");
    expect(fs.existsSync(wsDir)).toBe(false);
    expect(appended).toHaveLength(0);
  });

  // Uses permissions on a self-owned directory; foreign ownership is not exercised.
  it("planning#407: an unreadable directory hiding the ONLY changes blocks the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unreadable");
    await initRepo(wsDir);
    const dataDir = path.join(wsDir, "pgdata");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "14\n");
    const g = simpleGit(wsDir);
    await g.add(".");
    await g.commit("data");
    await g.push("origin", "main");
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "15\n");
    fs.chmodSync(dataDir, 0o000);
    insertSession({
      id: "unreadable-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    try {
      const { registry } = fakeRegistry();
      const { appended, chatHistory } = fakeChatHistory();
      const result = await escalateDiskTiers({
        ...baseDeps(sm, registry),
        createGitManager: (dir) => new GitManager(dir),
        chatHistory,
        notifiedEvictBlocked: new Set<string>(),
      });

      expect(result.toEvicted).toBe(0);
      expect(result.evictBlockedByDirty).toBe(1);
      expect(sm.get("unreadable-light")?.diskTier).toBe("light");
      expect(fs.existsSync(dataDir)).toBe(true);
      expect(appended[0]!.text).toContain("pgdata/");
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
  });

  it("planning#407: blocks even when the readable half of the tree committed fine", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unreadable-mixed");
    await initRepo(wsDir);
    const dataDir = path.join(wsDir, "pgdata");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "14\n");
    fs.chmodSync(dataDir, 0o000);
    fs.writeFileSync(path.join(wsDir, "a.txt"), "agent edit");
    insertSession({
      id: "mixed-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    try {
      const { registry } = fakeRegistry();
      const { appended, chatHistory } = fakeChatHistory();
      const result = await escalateDiskTiers({
        ...baseDeps(sm, registry),
        createGitManager: (dir) => new GitManager(dir),
        chatHistory,
        notifiedEvictBlocked: new Set<string>(),
      });

      expect(result.evictBlockedByDirty).toBe(1);
      expect(fs.existsSync(wsDir)).toBe(true);
      expect(await new GitManager(wsDir).isClean()).toBe(true);
      expect(appended[0]!.text).toContain("pgdata/");
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
  });

  it("planning#296: a commit that failed to push is not wiped by the NEXT pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-unpushed");
    await initRepo(wsDir, { dirty: true, noRemote: true });
    insertSession({
      id: "unpushed-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = { ...baseDeps(sm, registry), createGitManager: (dir: string) => new GitManager(dir) };

    const first = await escalateDiskTiers(deps);
    expect(first.evictBlockedByPush).toBe(1);
    expect(await new GitManager(wsDir).isClean()).toBe(true);

    const second = await escalateDiskTiers(deps);

    expect(second.toEvicted).toBe(0);
    expect(second.evictBlockedByPush).toBe(1);
    expect(sm.get("unpushed-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "b.txt"))).toBe(true);
  });

  it("planning#296: a CLEAN checkout with a rebase in progress blocks the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-rebasing");
    await initRepo(wsDir);
    expect(await new GitManager(wsDir).isClean()).toBe(true);
    fs.mkdirSync(path.join(wsDir, ".git", "rebase-merge"), { recursive: true });
    insertSession({
      id: "rebasing-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    });

    expect(result.toEvicted).toBe(0);
    expect(result.evictBlockedByDirty).toBe(1);
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(appended[0]!.text).toContain("rebase is in progress");
  });

  it("planning#296: never evicts a session whose work has no remote to live on", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-standalone");
    await initRepo(wsDir, { noRemote: true });
    insertSession({
      id: "standalone-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
  });

  it("planning#296: a detached HEAD is never evicted (its commits belong to no branch)", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-detached");
    await initRepo(wsDir);
    const g = simpleGit(wsDir);
    await g.checkout(["--detach"]);
    fs.writeFileSync(path.join(wsDir, "detached-work.txt"), "only on this commit");
    await g.add(".");
    await g.commit("work on a detached HEAD");
    expect(await new GitManager(wsDir).isClean()).toBe(true);
    insertSession({
      id: "detached-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(fs.existsSync(path.join(wsDir, "detached-work.txt"))).toBe(true);
  });

  it("planning#296: does not wipe a session that became active during remediation", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-activated");
    await initRepo(wsDir);
    insertSession({
      id: "activated-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    let lookups = 0;
    const registry = {
      get: () => (lookups++ === 0
        ? undefined
        : { running: false, agentBusy: false, viewerCount: 1 }),
      dispose: () => {},
    } as unknown as SessionRunnerRegistry;

    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("activated-light")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("planning#296: records an already-missing workspace as evicted (restorable), not stuck at light", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-vanished", "workspace");
    insertSession({
      id: "vanished-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(sm.get("vanished-light")?.diskTier).toBe("evicted");
  });

  it("evicts an empty remnant directory that is no longer a git repository", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-remnant");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "remnant-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(sm.get("remnant-light")?.diskTier).toBe("evicted");
  });

  it("never wipes a non-repo workspace that still holds files — it blocks instead", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const sessionRoot = path.join(tmpDir, "ws-derepoed");
    const wsDir = path.join(sessionRoot, "workspace");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, "only-copy.txt"), "never pushed anywhere");
    const overlayDir = path.join(sessionRoot, "overlay");
    fs.mkdirSync(overlayDir, { recursive: true });
    insertSession({
      id: "derepoed-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked: new Set<string>(),
    };

    const first = await escalateDiskTiers(deps);
    const second = await escalateDiskTiers(deps);

    expect(first.toEvicted).toBe(0);
    expect(first.evictBlockedByPush).toBe(1);
    expect(second.evictBlockedByPush).toBe(1);
    expect(sm.get("derepoed-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "only-copy.txt"))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
    expect(fs.existsSync(overlayDir)).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toContain("no longer a git repository");
  });

  it("refuses to evict an empty remnant when there is no remote to restore from", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-remnant-noremote");
    fs.mkdirSync(wsDir, { recursive: true });
    insertSession({
      id: "remnant-noremote",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
      remoteUrl: "",
    });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      createGitManager: (dir) => new GitManager(dir),
    });

    expect(result.toEvicted).toBe(0);
    expect(sm.get("remnant-noremote")?.diskTier).toBe("light");
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it("treats a `.git` FILE as a repository — the careful path, never the wipe", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-gitfile");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, ".git"), "gitdir: /elsewhere/.git/worktrees/w\n");
    insertSession({
      id: "gitfile-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
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
    expect(result.evictBlockedByPush).toBe(0);
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);
  });

  it("reports a repeating git failure once, not once per pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-corrupt");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, ".git"), "not a gitfile\n");
    insertSession({
      id: "corrupt-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      evictStuckLog: new Map<string, string>(),
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      warnings = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((w) => w.includes("git check failed"))).toHaveLength(1);
    expect(sm.get("corrupt-light")?.diskTier).toBe("light");
    expect(fs.existsSync(path.join(wsDir, "a.txt"))).toBe(true);

    expect(deps.evictStuckLog.size).toBe(1);
    sm.setDiskTier("corrupt-light", "evicted");
    await escalateDiskTiers(deps);
    expect(deps.evictStuckLog.size).toBe(0);
  });

  it("reports a DIFFERENT git failure even while an earlier one is throttled", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-changing");
    await initRepo(wsDir);
    fs.rmSync(path.join(wsDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(wsDir, ".git"), "not a gitfile\n");
    insertSession({
      id: "changing-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      evictStuckLog: new Map<string, string>(),
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[];
    try {
      await escalateDiskTiers(deps);
      await escalateDiskTiers(deps);
      fs.writeFileSync(path.join(wsDir, ".git"), "gitdir: /nonexistent/git/dir\n");
      await escalateDiskTiers(deps);
      warnings = warn.mock.calls.map((c) => String(c[0]));
    } finally {
      warn.mockRestore();
    }

    expect(warnings.filter((w) => w.includes("git check failed"))).toHaveLength(2);
  });

  it("planning#296: warns once per session, not once per escalation pass", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-secret-repeat");
    await initRepo(wsDir);
    fs.writeFileSync(path.join(wsDir, ".env"), `AWS_ACCESS_KEY_ID=${FIXTURE_AWS_KEY}\n`);
    insertSession({
      id: "repeat-light",
      lastUsedAt: daysAgo(DEFAULT_DISK_LADDER.evictUnmergedAfterMs / 86_400_000 + 1),
      diskTier: "light",
      workspaceDir: wsDir,
      branch: "main",
    });

    const { registry } = fakeRegistry();
    const { appended, chatHistory } = fakeChatHistory();
    const notifiedEvictBlocked = new Set<string>();
    const deps = {
      ...baseDeps(sm, registry),
      createGitManager: (dir: string) => new GitManager(dir),
      chatHistory,
      notifiedEvictBlocked,
    };

    const first = await escalateDiskTiers(deps);
    const second = await escalateDiskTiers(deps);

    expect(first.evictBlockedByDirty).toBe(1);
    expect(second.evictBlockedByDirty).toBe(1);
    expect(appended).toHaveLength(1);
  });

  it("disk-pressure: escalates LRU hot → light regardless of age until high mark", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsA = path.join(tmpDir, "ws-a");
    const wsB = path.join(tmpDir, "ws-b");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    insertSession({ id: "lru-old", lastUsedAt: hoursAgo(3), diskTier: "hot", workspaceDir: wsA });
    insertSession({ id: "lru-new", lastUsedAt: hoursAgo(1), diskTier: "hot", workspaceDir: wsB });

    let free = 100;
    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      diskFreeLow: 1000,
      diskFreeHigh: 5000,
      getFreeDiskBytes: () => {
        const cur = free;
        free = 9999;
        return Promise.resolve(cur);
      },
    });

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

  const mergedThresholdDays = DEFAULT_DISK_LADDER.evictMergedAfterMs / 86_400_000;

  it("merge-aware: a merged session past the merged threshold evicts", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    const wsDir = path.join(tmpDir, "ws-merged");
    await initRepo(wsDir);
    insertSession({
      id: "merged-light",
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
      lastUsedAt: daysAgo(30),
      mergedAt: daysAgo(30),
      lastViewedAt: hoursAgo(2),
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

  it("honors a custom ladder threshold", async () => {
    setup();
    const sm = new SessionManager(dbManager!);
    insertSession({ id: "young", lastUsedAt: hoursAgo(12), diskTier: "hot" });

    const { registry } = fakeRegistry();
    const result = await escalateDiskTiers({
      ...baseDeps(sm, registry),
      ladder: { ...DEFAULT_DISK_LADDER, lightAfterMs: 6 * 3_600_000 },
    });

    expect(result.toLight).toBe(1);
    expect(sm.get("young")?.diskTier).toBe("light");
  });
});

describe("assertDiskLadderOrdering", () => {
  it("accepts the default ladder", () => {
    expect(() => assertDiskLadderOrdering(DEFAULT_DISK_LADDER)).not.toThrow();
  });

  it("accepts equal thresholds (non-strict ordering)", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 1000, evictMergedAfterMs: 1000, evictUnmergedAfterMs: 1000,
    })).not.toThrow();
  });

  it("rejects a merged clock below the light clock", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 24 * 3_600_000,
      evictMergedAfterMs: 1 * 3_600_000,
      evictUnmergedAfterMs: 14 * 86_400_000,
    })).toThrow(/lightAfterMs ≤ evictMergedAfterMs/);
  });

  it("rejects an unmerged clock below the merged clock", () => {
    expect(() => assertDiskLadderOrdering({
      lightAfterMs: 24 * 3_600_000,
      evictMergedAfterMs: 14 * 86_400_000,
      evictUnmergedAfterMs: 2 * 86_400_000,
    })).toThrow(/evictMergedAfterMs ≤ evictUnmergedAfterMs/);
  });
});

describe("resolveDiskWatermarks", () => {
  const TOTAL = 1_000_000_000;

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
