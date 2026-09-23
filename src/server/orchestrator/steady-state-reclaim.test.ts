import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { runSteadyStateReclaim } from "./steady-state-reclaim.js";
import { repoUrlToHash } from "./git-utils.js";
import { liveOverlayScopeHashes, overlayRuntimeKey, sessionPnpmStoreDir } from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";
import { withScopeLock } from "./overlay-base.js";
import {
  claimOverlayBaseGeneration,
  clearOverlayBaseClaims,
  releaseOverlayBaseClaims,
} from "./overlay-base-claims.js";

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

function overlayVolName(i: number): string {
  return `shipit-${i.toString(16).padStart(12, "0")}_overlay-dba27c31`;
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
    clearOverlayBaseClaims();
    vi.restoreAllMocks();
  });

  it("keeps a plugin repository's caches, which no repo store can vouch for", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);
    const pluginBare = repoUrlToHash("https://github.com/Acme/Tools.git");
    const orphan = repoUrlToHash("https://github.com/example/gone.git");
    for (const sub of ["repo-cache", "dep-cache"]) {
      fs.mkdirSync(path.join(tmpDir, sub, pluginBare), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, sub, orphan), { recursive: true });
    }

    const result = await runSteadyStateReclaim({
      repoStore,
      stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
      livePluginStoreArtifacts: async () =>
        ({ scopeHashes: new Set<string>(), cacheHashes: new Set([pluginBare]) }),
    });

    expect(result.cachesRemoved).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "repo-cache", pluginBare))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "dep-cache", pluginBare))).toBe(true);
  });

  it("skips both sweeps when plugin liveness cannot be resolved", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);
    const orphan = repoUrlToHash("https://github.com/example/gone.git");
    fs.mkdirSync(path.join(tmpDir, "dep-cache", orphan), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "overlay-base", "a".repeat(16), "g1"), { recursive: true });

    const result = await runSteadyStateReclaim({
      repoStore,
      stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
      liveOverlayScopeHashes: () => new Set<string>(),
      livePluginStoreArtifacts: async () => { throw new Error("state dir unreadable"); },
    });

    expect(result.cachesRemoved).toBe(0);
    expect(result.overlayBasesRemoved).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "dep-cache", orphan))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "overlay-base", "a".repeat(16)))).toBe(true);
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
    const resumable = mk("aaaaaaaaaaaaaaaa", 99);
    const orphanOld = mk("bbbbbbbbbbbbbbbb", 99);
    const orphanYoung = mk("cccccccccccccccc", 1);
    const runningMount = mk("dddddddddddddddd", 99);
    fs.writeFileSync(path.join(root, "stray.txt"), "x");

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () => new Set(["aaaaaaaaaaaaaaaa"]),
      runDocker: liveMountDocker([path.join(runningMount, "g4")]),
    });

    expect(fs.existsSync(resumable)).toBe(true);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanYoung)).toBe(false);
    expect(fs.existsSync(runningMount)).toBe(true);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(true);
    expect(result.overlayBasesRemoved).toBe(2);
  });

  // docs/276 section 5: the per-runtime shared store is retired, so EVERY tree under
  // <stateDir>/pnpm-store is dead — no hash is exempt any more.
  it("pnpm-store sweep reaps every aged-out retired store, exempting no hash", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const root = path.join(tmpDir, "pnpm-store");
    fs.mkdirSync(root, { recursive: true });
    const mk = (hash: string, ageDays: number) => {
      const d = path.join(root, hash);
      const files = path.join(d, "v11", "files", "ab");
      fs.mkdirSync(files, { recursive: true });
      const t = Date.now() / 1000 - ageDays * 86_400;
      for (const p of [files, path.join(d, "v11", "files"), path.join(d, "v11"), d]) {
        fs.utimesSync(p, t, t);
      }
      return d;
    };
    const formerlyLive = mk("aaaaaaaaaaaaaaaa", 99);
    const staleStore = mk("bbbbbbbbbbbbbbbb", 99);
    const youngStore = mk("cccccccccccccccc", 1);
    fs.writeFileSync(path.join(root, "stray.txt"), "x");

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(formerlyLive)).toBe(false);
    expect(fs.existsSync(staleStore)).toBe(false);
    // A container created before the upgrade may still mount a recently-touched store.
    expect(fs.existsSync(youngStore)).toBe(true);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(true);
    expect(result.pnpmStoresRemoved).toBe(2);
  });

  /**
   * The store root's mtime is not an activity signal — pnpm writes under `v11/files/<xx>/`, which
   * never touches the ancestor. Ageing on the root alone would reap the store of a surviving
   * pre-upgrade container that is still filling it.
   */
  it("keeps a retired store whose deep contents were written recently", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const root = path.join(tmpDir, "pnpm-store");
    const store = path.join(root, "aaaaaaaaaaaaaaaa");
    const files = path.join(store, "v11", "files", "ab");
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, "cdef"), "x");
    // Every ancestor looks long dead; only the leaf directory is fresh.
    const old = Date.now() / 1000 - 99 * 86_400;
    for (const d of [root, store, path.join(store, "v11"), path.join(store, "v11", "files")]) {
      fs.utimesSync(d, old, old);
    }

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(store)).toBe(true);
    expect(result.pnpmStoresRemoved).toBe(0);
  });

  it("leaves a session's own private pnpm store alone", async () => {
    setup();
    const repoStore = new RepoStore(dbManager!);

    const store = sessionPnpmStoreDir(tmpDir, "sess-1");
    fs.mkdirSync(store, { recursive: true });
    const old = Date.now() / 1000 - 99 * 86_400;
    fs.utimesSync(store, old, old);

    const result = await runSteadyStateReclaim({
      repoStore, stateDir: tmpDir,
      cacheDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(store)).toBe(true);
    expect(result.pnpmStoresRemoved).toBe(0);
  });

  it("reaps superseded generations inside a LIVE scope via the live-mount check, keeping g0 + current + pinned", async () => {
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
    const g0 = mkGen("g0", 99);
    const g1 = mkGen("g1", 99);
    const g2 = mkGen("g2", 99);
    const g3 = mkGen("g3", 99);
    const g4 = mkGen("g4", 0.0001);
    const tmpOld = mkGen(".tmp-g9-ab12", 99);
    const tmpYoung = mkGen(".tmp-g9-cd34", 0);
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

  describe("live-mount probe failures (planning#439)", () => {
    function incidentFixture() {
      const liveHash = "8769b50c2dd9cea5";
      const warmHash = "45dab20e664868ce";
      const mkGen = (hash: string, gen: number) => {
        const d = path.join(tmpDir, "overlay-base", hash, `g${gen}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "marker"), "x");
        return d;
      };
      const pinned = [269, 270, 271, 272].map((g) => mkGen(liveHash, g));
      const current = mkGen(liveHash, 273);
      const warmGen = mkGen(warmHash, 1);
      const metaDir = path.join(tmpDir, "overlay-base-meta");
      fs.mkdirSync(metaDir, { recursive: true });
      const pointer = (hash: string, generation: number, baseDir: string) => {
        fs.writeFileSync(
          path.join(metaDir, `${hash}.json`),
          JSON.stringify({
            scopeHash: hash, commit: "c".repeat(40), depth: 2, generation, baseDir,
            updatedAt: "2026-08-18T14:04:03Z",
          }),
        );
      };
      pointer(liveHash, 273, current);
      pointer(warmHash, 1, warmGen);
      return { liveHash, warmHash, pinned, current, warmGen };
    }

    it("sweeps NOTHING when the live-mount reading cannot be completed", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = incidentFixture();
      const orphan = path.join(tmpDir, "overlay-base", "cccccccccccccccc");
      fs.mkdirSync(orphan, { recursive: true });

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.liveHash]),
        runDocker: (args) =>
          args[0] === "ps"
            ? Promise.resolve("live0\n")
            : Promise.reject(new Error("docker container exited 1: shipit_workspace")),
      });

      expect(result.overlayBasesRemoved).toBe(0);
      for (const gen of fx.pinned) expect(fs.existsSync(gen)).toBe(true);
      expect(fs.existsSync(fx.current)).toBe(true);
      expect(fs.existsSync(fx.warmGen)).toBe(true);
      expect(fs.existsSync(orphan)).toBe(true);
    });

    it("keeps reclaiming when a container merely VANISHED between ps and inspect", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = incidentFixture();
      const vol = overlayVolName(0);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.liveHash, fx.warmHash]),
        runDocker: (args) => {
          if (args[0] === "ps") return Promise.resolve("live0\nexited1\n");
          if (args[0] === "container" && args[1] === "inspect") {
            const ids = args.slice(4);
            // Docker fails the batch if any requested container has vanished.
            if (ids.includes("exited1")) {
              return Promise.reject(new Error(
                `docker container exited 1: ${vol}\nError: No such container: exited1`,
              ));
            }
            return Promise.resolve(`${vol}\n`);
          }
          if (args[0] === "volume" && args[1] === "inspect") {
            return Promise.resolve(
              `lowerdir=${fx.pinned[3]},upperdir=/x/overlay/upper,workdir=/x/overlay/work\n`,
            );
          }
          return Promise.resolve("");
        },
      });

      expect(fs.existsSync(fx.pinned[3])).toBe(true);
      expect(fs.existsSync(fx.pinned[0])).toBe(false);
      expect(fs.existsSync(fx.current)).toBe(true);
      expect(result.overlayBasesRemoved).toBe(3);
    });

    it("tolerates a vanished VOLUME the same way, and still fails closed on any other error", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = incidentFixture();
      const [live, gone] = [overlayVolName(0), overlayVolName(1)];

      const runDocker = (volumeFailure: Error) => (args: string[]): Promise<string> => {
        if (args[0] === "ps") return Promise.resolve("live0\nlive1\n");
        if (args[0] === "container" && args[1] === "inspect") {
          return Promise.resolve(`${live}\n${gone}\n`);
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          const names = args.slice(4);
          if (names.includes(gone)) return Promise.reject(volumeFailure);
          return Promise.resolve(
            `lowerdir=${fx.pinned[3]},upperdir=/x/overlay/upper,workdir=/x/overlay/work\n`,
          );
        }
        return Promise.resolve("");
      };
      const deps = {
        repoStore, stateDir: tmpDir, cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.liveHash, fx.warmHash]),
      };

      const unexplained = await runSteadyStateReclaim({
        ...deps, runDocker: runDocker(new Error("Cannot connect to the Docker daemon")),
      });
      expect(unexplained.overlayBasesRemoved).toBe(0);
      for (const gen of fx.pinned) expect(fs.existsSync(gen)).toBe(true);

      const vanished = await runSteadyStateReclaim({
        ...deps, runDocker: runDocker(new Error(`Error: No such volume: ${gone}`)),
      });
      expect(vanished.overlayBasesRemoved).toBe(3);
      expect(fs.existsSync(fx.pinned[3])).toBe(true);
    });

    it("counts WARM-pool sessions as live — the union must come from listAllIncludingWarm", async () => {
      setup();
      const sessionManager = new SessionManager(dbManager!);
      const repoStore = new RepoStore(dbManager!);

      const remoteUrl = "https://github.com/nicolasalt/tanks.git";
      underlyingDb!.prepare(
        "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, warm)"
        + " VALUES (?, ?, ?, ?, ?, 0, 1)",
      ).run("dc4a9d74-a9b4-4741-8e20-9381a991b4f7", "Warm", "2026-08-18", "2026-08-18", remoteUrl);

      const env = { OVERLAY_DEP_STORE: "1", SESSION_WORKER_IMAGE_ID: "img-9" } as NodeJS.ProcessEnv;
      const depDirs = ["node_modules"];
      const warmHash = overlayScopeHash(remoteUrl, overlayRuntimeKey(env), depDirs[0]);
      const warmBase = path.join(tmpDir, "overlay-base", warmHash);
      fs.mkdirSync(warmBase, { recursive: true });

      expect(
        liveOverlayScopeHashes(sessionManager.listAll(), () => depDirs, env).has(warmHash),
      ).toBe(false);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () =>
          liveOverlayScopeHashes(sessionManager.listAllIncludingWarm(), () => depDirs, env),
        runDocker: () => Promise.resolve(""),
      });

      expect(fs.existsSync(warmBase)).toBe(true);
      expect(result.overlayBasesRemoved).toBe(0);
    });
  });

  describe("in-flight base-generation claims (planning#440)", () => {
    const CREATING = "claim-token-of-one-create-attempt";

    function creatingFixture() {
      const hash = "1f2e3d4c5b6a7988";
      const mkGen = (gen: number) => {
        const d = path.join(tmpDir, "overlay-base", hash, `g${gen}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "marker"), "x");
        return d;
      };
      const claimed = mkGen(7);
      const superseded = mkGen(6);
      const current = mkGen(8);
      const metaDir = path.join(tmpDir, "overlay-base-meta");
      fs.mkdirSync(metaDir, { recursive: true });
      fs.writeFileSync(
        path.join(metaDir, `${hash}.json`),
        JSON.stringify({
          scopeHash: hash, commit: "d".repeat(40), depth: 2, generation: 8,
          baseDir: current, updatedAt: "2026-08-19T10:00:00Z",
        }),
      );
      return { hash, claimed, superseded, current };
    }

    it("keeps a generation a container being CREATED will mount, and still reaps its unclaimed sibling", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      claimOverlayBaseGeneration(fx.hash, 7, CREATING);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.hash]),
        runDocker: () => Promise.resolve(""),
      });

      expect(fs.existsSync(fx.claimed)).toBe(true);
      expect(fs.existsSync(fx.current)).toBe(true);
      expect(fs.existsSync(fx.superseded)).toBe(false);
      expect(result.overlayBasesRemoved).toBe(1);
    });

    it("keeps the whole scope dir alive on the claim alone, when nothing else vouches for it", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      claimOverlayBaseGeneration(fx.hash, 7, CREATING);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set<string>(),
        runDocker: () => Promise.resolve(""),
      });

      expect(fs.existsSync(path.join(tmpDir, "overlay-base", fx.hash))).toBe(true);
      expect(fs.existsSync(fx.claimed)).toBe(true);
      expect(fs.existsSync(fx.superseded)).toBe(false);
      expect(result.overlayBasesRemoved).toBe(1);
    });

    it("stops protecting once the session releases, so a finished create cannot pin a base forever", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      claimOverlayBaseGeneration(fx.hash, 7, CREATING);
      releaseOverlayBaseClaims(CREATING);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.hash]),
        runDocker: () => Promise.resolve(""),
      });

      expect(fs.existsSync(fx.claimed)).toBe(false);
      expect(fs.existsSync(fx.superseded)).toBe(false);
      expect(fs.existsSync(fx.current)).toBe(true);
      expect(result.overlayBasesRemoved).toBe(2);
    });

    it("never widens the sweep: an unreadable live-mount reading still skips the pass", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      claimOverlayBaseGeneration(fx.hash, 7, CREATING);

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.hash]),
        runDocker: (args) =>
          args[0] === "ps"
            ? Promise.reject(new Error("Cannot connect to the Docker daemon"))
            : Promise.resolve(""),
      });

      expect(result.overlayBasesRemoved).toBe(0);
      expect(fs.existsSync(fx.superseded)).toBe(true);
    });

    /**
     * A claim's WHOLE lifetime can fall between the pass-wide Docker sample and the per-scope claim
     * read: claim, mount, release. Neither reading holds it, and the generation a running container
     * is on is deleted underneath it. The cover is a Docker re-check taken AFTER the per-scope claim
     * read — under the scope lock nothing more can be claimed, so a generation not claimed there had
     * a visible container before its release, and the re-check sees it
     * (docs/276-shared-package-cache-integrity section 5; review, 2026-09-21).
     */
    it("re-checks Docker after the per-scope claim read, covering a claim released mid-pass", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      claimOverlayBaseGeneration(fx.hash, 7, CREATING);

      // The claim's whole lifetime happens between the two readings, and — as in production — the
      // release comes only after the container is visible.
      let visible = false;
      const withMount = liveMountDocker([fx.claimed]);
      const withoutMount = liveMountDocker([]);
      const runDocker = (args: string[]): Promise<string> => {
        const out = visible ? withMount(args) : withoutMount(args);
        if (args[0] === "ps" && !visible) {
          visible = true;
          releaseOverlayBaseClaims(CREATING);
        }
        return out;
      };

      const result = await runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.hash]),
        runDocker,
      });

      expect(fs.existsSync(fx.claimed)).toBe(true);
      expect(fs.existsSync(fx.superseded)).toBe(false);
      expect(result.overlayBasesRemoved).toBe(1);
    });

    it("runs the sweep under the scope's own lock, so a publish cannot interleave", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const fx = creatingFixture();

      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const lockTaken = withScopeLock(fx.hash, () => held);
      await Promise.resolve();

      const sweep = runSteadyStateReclaim({
        repoStore, stateDir: tmpDir,
        cacheDays: 30,
        liveOverlayScopeHashes: () => new Set([fx.hash]),
        runDocker: () => Promise.resolve(""),
      });
      // Real timers, not microtasks: the sweep paces its deletes through setTimeout, so a
      // microtask drain would never reach one and the cell would pass with no lock at all.
      await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(fx.superseded)).toBe(true);

      release();
      await lockTaken;
      // Nothing claims here, so both non-current generations go — once the lock is free.
      expect((await sweep).overlayBasesRemoved).toBe(2);
      expect(fs.existsSync(fx.superseded)).toBe(false);
      expect(fs.existsSync(fx.current)).toBe(true);
    });
  });

  it("retains EVERY per-(session, dep-dir) base in the live-set; reaps only unreferenced ones", async () => {
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
    const liveBases = depDirs.map((d) => mkBase(overlayScopeHash(remoteUrl, runtimeKey, d), 99));
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

  describe("cache-side LFS object sweep (docs/232)", () => {
    // Prevent the whole-cache sweep from removing fixtures before the LFS sweep.
    function liveRepoHash(repoStore: RepoStore, url: string): string {
      repoStore.add(url);
      repoStore.setReady(url);
      return repoUrlToHash(url);
    }

    function writeCacheLfsObject(hash: string, oid: string, ageDays: number, body = "asset-bytes"): string {
      const p = path.join(tmpDir, "repo-cache", hash, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
      const t = Date.now() / 1000 - ageDays * 86_400;
      fs.utimesSync(p, t, t);
      return p;
    }

    it("unlinks an old object no clone links, and reports the bytes freed", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const hash = liveRepoHash(repoStore, "https://github.com/example/assets.git");
      const stale = writeCacheLfsObject(hash, "aabbccddeeff0011", 30, "0123456789");

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 14 });

      expect(fs.existsSync(stale)).toBe(false);
      expect(result.lfsObjectsRemoved).toBe(1);
      expect(result.lfsBytesFreed).toBe(10);
    });

    it("keeps an object a session clone still hardlinks, however old it is", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const hash = liveRepoHash(repoStore, "https://github.com/example/assets.git");
      const cacheObj = writeCacheLfsObject(hash, "1122334455667788", 999);
      const cloneObj = path.join(tmpDir, "sessions", "s1", ".git", "lfs", "objects", "11", "22", "1122334455667788");
      fs.mkdirSync(path.dirname(cloneObj), { recursive: true });
      fs.linkSync(cacheObj, cloneObj);

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 1 });

      expect(fs.existsSync(cacheObj)).toBe(true);
      expect(fs.readFileSync(cloneObj, "utf8")).toBe("asset-bytes");
      expect(result.lfsObjectsRemoved).toBe(0);
    });

    it("keeps a recently-touched object even with no clone linking it", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const hash = liveRepoHash(repoStore, "https://github.com/example/assets.git");
      const fresh = writeCacheLfsObject(hash, "cafebabecafebabe", 2);

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 14 });

      expect(fs.existsSync(fresh)).toBe(true);
      expect(result.lfsObjectsRemoved).toBe(0);
    });

    it("removes fanout dirs it empties but keeps ones with survivors", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const hash = liveRepoHash(repoStore, "https://github.com/example/assets.git");
      writeCacheLfsObject(hash, "abcd000000000001", 30);
      writeCacheLfsObject(hash, "abef000000000002", 1);
      const objectsRoot = path.join(tmpDir, "repo-cache", hash, "lfs", "objects");

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 14 });

      expect(result.lfsObjectsRemoved).toBe(1);
      expect(fs.existsSync(path.join(objectsRoot, "ab", "cd"))).toBe(false);
      expect(fs.existsSync(path.join(objectsRoot, "ab", "ef"))).toBe(true);
    });

    it("sweeps every repo cache on the host", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const a = writeCacheLfsObject(liveRepoHash(repoStore, "https://github.com/example/a.git"), "aa00000000000001", 30);
      const b = writeCacheLfsObject(liveRepoHash(repoStore, "https://github.com/example/b.git"), "bb00000000000002", 30);

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 14 });

      expect(fs.existsSync(a)).toBe(false);
      expect(fs.existsSync(b)).toBe(false);
      expect(result.lfsObjectsRemoved).toBe(2);
    });

    it("is a no-op on a host whose caches have no LFS store", async () => {
      setup();
      const repoStore = new RepoStore(dbManager!);
      const hash = liveRepoHash(repoStore, "https://github.com/example/plain.git");
      fs.mkdirSync(path.join(tmpDir, "repo-cache", hash, "objects"), { recursive: true });

      const result = await runSteadyStateReclaim({ repoStore, stateDir: tmpDir, lfsObjectDays: 14 });

      expect(result).toMatchObject({ lfsObjectsRemoved: 0, lfsBytesFreed: 0 });
    });
  });
});
