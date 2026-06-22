import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { runSteadyStateReclaim } from "./steady-state-reclaim.js";
import { repoUrlToHash } from "./git-utils.js";
import { liveOverlayScopeHashes, overlayRuntimeKey, pnpmStoreHash } from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";

/**
 * Build a `runDocker` stub that simulates a RUNNING session-worker container
 * pinning each given `overlay-base/<hash>/g<N>` lowerdir as a live overlay mount
 * (SHI-193 live-mount check). Any docker call the overlay sweep makes
 * (`ps -q` → `container inspect` → `volume inspect`) is answered; everything else
 * returns empty.
 */
function liveMountDocker(genLowerdirs: string[]): (args: string[]) => Promise<string> {
  const vols = genLowerdirs.map((_, i) => `shipit-${i.toString(16).padStart(12, "0")}_overlay-0000000${i}`);
  return (args: string[]): Promise<string> => {
    if (args[0] === "ps") return Promise.resolve(genLowerdirs.length ? "container0\n" : "");
    if (args[0] === "container" && args[1] === "inspect") return Promise.resolve(`${vols.join("\n")}\n`);
    if (args[0] === "volume" && args[1] === "inspect") {
      return Promise.resolve(
        genLowerdirs.map((ld) => `lowerdir=${ld},upperdir=/x/overlay/upper,workdir=/x/overlay/work`).join("\n"),
      );
    }
    return Promise.resolve("");
  };
}

describe("runSteadyStateReclaim", () => {
  let tmpDir: string;
  let dbPath: string;
  let underlyingDb: Database.Database | null = null;
  let dbManager: DatabaseManager | null = null;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "steady-state-reclaim-"));
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

  it("sweeps unreferenced repo/dep cache directories", async () => {
    setup();
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

    const result = await runSteadyStateReclaim({
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

  it("sweeps unreferenced repo-memory dirs but keeps live ones (docs/155)", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    const staleHash = repoUrlToHash("https://github.com/example/stale.git");
    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    const credentialsDir = path.join(tmpDir, "credentials");
    for (const hash of [liveHash, staleHash]) {
      const dir = path.join(credentialsDir, "repo-memory", hash);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "MEMORY.md"), "");
    }

    const result = await runSteadyStateReclaim({
      repoStore,
      stateDir: tmpDir,
      credentialsDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.repoMemoryDirsRemoved).toBe(1);
    expect(fs.existsSync(path.join(credentialsDir, "repo-memory", liveHash))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir, "repo-memory", staleHash))).toBe(false);
  });

  it("repo-memory sweep is a no-op when credentialsDir is omitted", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const result = await runSteadyStateReclaim({
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.repoMemoryDirsRemoved).toBe(0);
  });

  it("overlay-base sweep is skipped when liveOverlayScopeHashes is not provided", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    // Seed a stale overlay-base dir; without a live-scope-hash source the sweep
    // must NOT touch it (we can't confirm it isn't a live lowerdir).
    const baseDir = path.join(tmpDir, "overlay-base", "0123456789abcdef");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "marker"), "x");
    const old = Date.now() / 1000 - 99 * 86_400;
    fs.utimesSync(baseDir, old, old);

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(baseDir)).toBe(true);
    expect(result.overlayBasesRemoved).toBe(0);
  });

  it("overlay-base sweep reclaims obsolete bases immediately via the live-mount check (no age gate)", async () => {
    // SHI-193: a scope is reclaimable the moment it has zero live mounts — age is
    // not a factor. "Live" = the resumable-session union OR a generation pinned by
    // a running container right now.
    setup();
    const repoStore = new RepoStore(dbManager!);

    const root = path.join(tmpDir, "overlay-base");
    fs.mkdirSync(root, { recursive: true });
    const mk = (hash: string, ageDays: number) => {
      const d = path.join(root, hash);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "marker"), "x");
      const t = Date.now() / 1000 - ageDays * 86_400;
      fs.utimesSync(d, t, t);
      return d;
    };
    const resumable = mk("aaaaaaaaaaaaaaaa", 99);   // in resumable union → keep despite age
    const orphanOld = mk("bbbbbbbbbbbbbbbb", 99);   // no live mount, old → REMOVE
    const orphanYoung = mk("cccccccccccccccc", 1);  // no live mount, YOUNG → REMOVE (age no longer protects)
    const runningMount = mk("dddddddddddddddd", 99); // pinned by a running container → keep
    // A stray file (not a dir) must be ignored.
    fs.writeFileSync(path.join(root, "stray.txt"), "x");

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () => new Set(["aaaaaaaaaaaaaaaa"]),
      // A running container mounts dddd…/g4 as its lowerdir — even though that
      // scope is not in the resumable union (e.g. an old-image container still
      // running mid-turn), the mount check keeps it.
      runDocker: liveMountDocker([path.join(runningMount, "g4")]),
    });

    expect(fs.existsSync(resumable)).toBe(true);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanYoung)).toBe(false);
    expect(fs.existsSync(runningMount)).toBe(true);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(true);
    expect(result.overlayBasesRemoved).toBe(2);
  });

  // docs/197 Part 2 — pnpm shared-store sweep.
  it("pnpm-store sweep is skipped when pnpmStoreRuntimeHash is not provided", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const storeDir = path.join(tmpDir, "pnpm-store", "0123456789abcdef");
    fs.mkdirSync(storeDir, { recursive: true });
    const old = Date.now() / 1000 - 99 * 86_400;
    fs.utimesSync(storeDir, old, old);

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(storeDir)).toBe(true);
    expect(result.pnpmStoresRemoved).toBe(0);
  });

  it("pnpm-store sweep keeps the live store, reaps a stale-runtime store, keeps a young one", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const root = path.join(tmpDir, "pnpm-store");
    fs.mkdirSync(root, { recursive: true });
    const mk = (hash: string, ageDays: number) => {
      const d = path.join(root, hash);
      fs.mkdirSync(d, { recursive: true });
      const t = Date.now() / 1000 - ageDays * 86_400;
      fs.utimesSync(d, t, t);
      return d;
    };
    const liveHash = pnpmStoreHash(overlayRuntimeKey());
    const liveStore = mk(liveHash, 99);                 // current runtime → keep despite age
    const staleStore = mk("bbbbbbbbbbbbbbbb", 99);      // old, non-current → REMOVE
    const youngStore = mk("cccccccccccccccc", 1);       // non-current but young → keep
    fs.writeFileSync(path.join(root, "stray.txt"), "x"); // non-dir → ignored

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      pnpmStoreRuntimeHash: () => liveHash,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(liveStore)).toBe(true);
    expect(fs.existsSync(staleStore)).toBe(false);
    expect(fs.existsSync(youngStore)).toBe(true);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(true);
    expect(result.pnpmStoresRemoved).toBe(1);
  });

  it("pnpm-store sweep reaps ALL stale stores when the feature is off (null live hash)", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const root = path.join(tmpDir, "pnpm-store");
    fs.mkdirSync(root, { recursive: true });
    const old = Date.now() / 1000 - 99 * 86_400;
    for (const h of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) {
      const d = path.join(root, h);
      fs.mkdirSync(d, { recursive: true });
      fs.utimesSync(d, old, old);
    }

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      pnpmStoreRuntimeHash: () => null, // feature off → nothing is live
      runDocker: () => Promise.resolve(""),
    });

    expect(result.pnpmStoresRemoved).toBe(2);
  });

  it("reaps superseded generations inside a LIVE scope via the live-mount check, keeping g0 + current + pinned", async () => {
    // SHI-193: a live scope dir is never removed, but superseded `g<N>` children
    // are reaped the moment nothing pins them — age is not a factor. Kept: `g0`
    // (cold-start lowerdir), the pointer's current generation, and any generation
    // a running container still mounts. A crash-orphaned `.tmp-*` gets a short
    // grace window (it's never mounted, but an in-flight publish may be writing it).
    setup();
    const repoStore = new RepoStore(dbManager!);

    const hash = "aaaaaaaaaaaaaaaa";
    const scopeDir = path.join(tmpDir, "overlay-base", hash);
    const mkGen = (name: string, ageDays: number) => {
      const d = path.join(scopeDir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "marker"), "x");
      const t = Date.now() / 1000 - ageDays * 86_400;
      fs.utimesSync(d, t, t);
      return d;
    };
    const g0 = mkGen("g0", 99);            // cold-start lowerdir → always kept
    const g1 = mkGen("g1", 99);            // superseded, unmounted, old → REMOVE
    const g2 = mkGen("g2", 99);            // superseded but PINNED by a running container → keep
    const g3 = mkGen("g3", 99);            // current per pointer → keep
    const g4 = mkGen("g4", 0.0001);        // superseded, unmounted, YOUNG → REMOVE (age no longer protects)
    const tmpOld = mkGen(".tmp-g9-ab12", 99);   // crash orphan, past grace → REMOVE
    const tmpYoung = mkGen(".tmp-g9-cd34", 0);   // crash orphan, within grace → keep
    // Pointer names g3 as current.
    const metaDir = path.join(tmpDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, `${hash}.json`),
      JSON.stringify({ scopeHash: hash, commit: "c".repeat(40), depth: 2, generation: 3, baseDir: g3, updatedAt: "2026-06-01T00:00:00Z" }),
    );

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () => new Set([hash]),
      // A running container pins g2 as its lowerdir.
      runDocker: liveMountDocker([g2]),
    });

    expect(fs.existsSync(g0)).toBe(true);
    expect(fs.existsSync(g1)).toBe(false);
    expect(fs.existsSync(g2)).toBe(true);
    expect(fs.existsSync(g3)).toBe(true);
    expect(fs.existsSync(g4)).toBe(false);
    expect(fs.existsSync(tmpOld)).toBe(false);
    expect(fs.existsSync(tmpYoung)).toBe(true);
    expect(fs.existsSync(scopeDir)).toBe(true);
    expect(result.overlayBasesRemoved).toBe(3);
  });

  it("retains EVERY per-(session, dep-dir) base in the live-set; reaps only unreferenced ones", async () => {
    // End-to-end: a live session with N declared dep dirs contributes N scope
    // hashes to the live-set (via the real `liveOverlayScopeHashes`), and the
    // overlay-base sweep must keep ALL of them while still reaping a stale base
    // that belongs to no live (session, dep-dir).
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const remoteUrl = "https://github.com/example/repo.git";
    const liveId = "feed1234beef-aaaa-bbbb-cccc-dddddddddddd";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", remoteUrl);

    const env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img-6" } as NodeJS.ProcessEnv;
    const depDirs = ["node_modules", "packages/api/node_modules"];
    const runtimeKey = overlayRuntimeKey(env);

    const root = path.join(tmpDir, "overlay-base");
    fs.mkdirSync(root, { recursive: true });
    const mkBase = (hash: string, ageDays: number): string => {
      const d = path.join(root, hash);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "marker"), "x");
      const t = Date.now() / 1000 - ageDays * 86_400;
      fs.utimesSync(d, t, t);
      return d;
    };
    // One stale base per (live session × dep dir) — all must survive despite age.
    const liveBases = depDirs.map((d) => mkBase(overlayScopeHash(remoteUrl, runtimeKey, d), 99));
    // A stale base for a dep dir no live session declares — must be reaped.
    const orphanBase = mkBase(overlayScopeHash(remoteUrl, runtimeKey, "vendor/bundle"), 99);

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () =>
        liveOverlayScopeHashes(sessionManager.listAll(), () => depDirs, env),
      runDocker: () => Promise.resolve(""),
    });

    for (const b of liveBases) expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(orphanBase)).toBe(false);
    expect(result.overlayBasesRemoved).toBe(1);
  });
});
