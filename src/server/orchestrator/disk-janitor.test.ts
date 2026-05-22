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

  it("sweeps orphan session networks whose session is no longer tracked", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Active session — its networks (agent bridge + compose) MUST be
    // preserved even when dangling: that's the idle-evicted state.
    const liveSessionId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    const liveSessionPrefix = liveSessionId.slice(0, 12); // "abc123def456"
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveSessionId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const lsRequests: string[][] = [];
    const rmRequests: string[] = [];
    // Listing includes:
    //   - the live session's agent + compose networks (PRESERVE)
    //   - an orphan agent network + orphan compose network (REMOVE)
    //   - a user-named network that doesn't match the strict regex (PRESERVE)
    //   - the default `bridge` network (PRESERVE — no prefix)
    const dockerListing = [
      `shipit-session-${liveSessionPrefix}`,                       // agent — live
      `shipit-session-${liveSessionId}`,                           // compose — live
      "shipit-session-fed987654321",                               // agent — orphan
      "shipit-session-deadbeef0000-1111-2222-3333-444444444444",   // compose — orphan
      "shipit-session-foo",                                        // wrong shape
      "bridge",                                                    // default network
    ].join("\n");

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "network" && args[1] === "ls") {
        lsRequests.push(args);
        return Promise.resolve(dockerListing);
      }
      if (args[0] === "network" && args[1] === "rm") {
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
    // `name=shipit-session-` scoping filter.
    expect(lsRequests).toHaveLength(1);
    expect(lsRequests[0]).toContain("--filter");
    expect(lsRequests[0]).toContain("dangling=true");
    expect(lsRequests[0]).toContain("name=shipit-session-");

    // Only the two orphan networks get rm'd — both the agent-style and
    // compose-style names. The live session's networks, the user-named
    // oddball, and the default `bridge` all stay.
    expect(rmRequests.sort()).toEqual([
      "shipit-session-deadbeef0000-1111-2222-3333-444444444444",
      "shipit-session-fed987654321",
    ]);
    expect(result.orphanNetworksRemoved).toBe(2);
  });

  it("preserves networks for idle-evicted (still-tracked) sessions", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(sessionId, "Idle-Evicted", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const rmRequests: string[] = [];
    const dockerListing = [
      `shipit-session-${sessionId.slice(0, 12)}`,
      `shipit-session-${sessionId}`,
    ].join("\n");

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "network" && args[1] === "ls") return Promise.resolve(dockerListing);
      if (args[0] === "network" && args[1] === "rm") {
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
    expect(result.orphanNetworksRemoved).toBe(0);
  });

  it("orphan network sweep ignores rm failures (network reattached / already gone)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "network" && args[1] === "ls") {
        return Promise.resolve("shipit-session-abc123def456");
      }
      if (args[0] === "network" && args[1] === "rm") {
        return Promise.reject(new Error("network has active endpoints"));
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    expect(result.orphanNetworksRemoved).toBe(0);
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

  it("prunes stale nm-store snapshots by mtime under tracked repos (docs/148)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    const nmRoot = path.join(tmpDir, "dep-cache", liveHash, "nm-store");
    fs.mkdirSync(nmRoot, { recursive: true });

    // Fresh storeKey — within retention.
    const freshDir = path.join(nmRoot, "fresh-store-key");
    fs.mkdirSync(freshDir, { recursive: true });

    // Stale storeKey — mtime backdated past the cutoff.
    const staleDir = path.join(nmRoot, "stale-store-key");
    fs.mkdirSync(staleDir, { recursive: true });
    const backdated = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(staleDir, backdated, backdated);

    // In-progress populate temp dir — should be preserved regardless of age.
    const tmpPopulate = path.join(nmRoot, ".tmp-deadbeef-store-key");
    fs.mkdirSync(tmpPopulate, { recursive: true });
    fs.utimesSync(tmpPopulate, backdated, backdated);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      nmStoreDays: 14,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.nmStoresRemoved).toBe(1);
    expect(fs.existsSync(freshDir)).toBe(true);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(tmpPopulate)).toBe(true);
  });

  it("nm-store pruning is disabled when nmStoreDays <= 0", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    const staleDir = path.join(tmpDir, "dep-cache", liveHash, "nm-store", "ancient");
    fs.mkdirSync(staleDir, { recursive: true });
    const backdated = new Date(Date.now() - 365 * 86_400_000);
    fs.utimesSync(staleDir, backdated, backdated);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      nmStoreDays: 0,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.nmStoresRemoved).toBe(0);
    expect(fs.existsSync(staleDir)).toBe(true);
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

  // ---- Orphan merged-PR branch sweep ----

  /**
   * Build a stub GitHubAuthManager-shaped object good enough for the sweep.
   * `branches` is a per-repo lookup keyed by `owner/repo`. Each entry's
   * `states` are the (synthetic) PR states associated with that branch
   * from GitHub's side — we explode them into either the refs response or
   * the pullRequests response depending on which query is being asked.
   *
   * The real `fetchShipitBranchesWithPrStates` issues two paginated
   * queries — one for `refs(refPrefix: …)`, one for
   * `pullRequests(states: [OPEN, MERGED])`. The stub dispatches on
   * substring of the query string. CLOSED PR states are filtered out of
   * the PR response (mirroring production: `states: [OPEN, MERGED]`),
   * which yields the same outcome as the previous stub since the sweep
   * treats CLOSED-only and no-PR identically.
   */
  function buildGitHubStub(
    branches: Record<string, { name: string; states: string[] }[]>,
    opts: { authenticated?: boolean } = {},
  ) {
    return {
      authenticated: opts.authenticated ?? true,

      async graphqlQuery(query: string, vars?: Record<string, unknown>) {
        const owner = vars?.owner as string;
        const repo = vars?.repo as string;
        const key = `${owner}/${repo}`;
        const repoBranches = branches[key] ?? [];

        if (query.includes("pullRequests(states:")) {
          const nodes = repoBranches.flatMap((b) =>
            b.states
              .filter((s) => s === "OPEN" || s === "MERGED")
              .map((state) => ({ state, headRefName: `shipit/${b.name}` })),
          );
          return {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes,
                },
              },
            },
          };
        }

        // Default: refs enumeration.
        return {
          data: {
            repository: {
              refs: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: repoBranches.map((b) => ({ name: b.name })),
              },
            },
          },
        };
      },
    } as unknown as Parameters<typeof runDiskJanitor>[0]["githubAuthManager"];
  }

  /**
   * Build a stub RepoGit factory that captures `setRemoteUrl` + `deleteBranch`
   * calls for assertions. Each created instance shares the underlying `calls`
   * array so we can see what happened across the whole sweep.
   */
  function buildRepoGitFactory(opts: { deleteFails?: boolean } = {}) {
    const deleted: string[] = [];
    const setRemoteUrlCalls: string[] = [];
    const factory = (_dir: string) => ({
      deleteBranch: (branch: string) => {
        if (opts.deleteFails) return Promise.reject(new Error("push denied"));
        deleted.push(branch);
        return Promise.resolve();
      },
      setRemoteUrl: (url: string) => {
        setRemoteUrlCalls.push(url);
        return Promise.resolve();
      },
    } as unknown as ReturnType<NonNullable<Parameters<typeof runDiskJanitor>[0]["createRepoGit"]>>);
    return { factory, deleted, setRemoteUrlCalls };
  }

  it("deletes merged-PR branches that no live session points at", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);

    // One live session pointing at shipit/active-feature — must be preserved
    // even though its PR is merged (defensive: a session might intentionally
    // re-push to the same branch).
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, branch, archived) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ).run(
      "11111111-1111-1111-1111-111111111111", "Live", "2026-05-12", "2026-05-12",
      repoUrl, "shipit/active-feature",
    );

    // Bare cache exists on disk so `sweepOrphanMergedBranches` doesn't bail.
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub({
      "example/repo": [
        { name: "active-feature", states: ["MERGED"] },  // PRESERVED — live session
        { name: "old-merged", states: ["MERGED"] },      // DELETE
        { name: "still-open", states: ["OPEN"] },        // PRESERVED — open PR
        { name: "open-and-merged", states: ["OPEN", "MERGED"] }, // PRESERVED — open wins
        { name: "closed-no-merge", states: ["CLOSED"] }, // PRESERVED — closed != merged
        { name: "no-pr", states: [] },                   // PRESERVED — no PR at all
      ],
    });

    const { factory, deleted, setRemoteUrlCalls } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual(["shipit/old-merged"]);
    expect(result.orphanBranchesRemoved).toBe(1);
    // Credentials refreshed exactly once for this repo (lazy: only when we
    // actually have a deletion to perform).
    expect(setRemoteUrlCalls).toEqual([repoUrl]);
  });

  it("no-ops when GitHub auth is unauthenticated", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    repoStore.add("https://github.com/example/repo.git");

    const githubAuthManager = buildGitHubStub(
      { "example/repo": [{ name: "old-merged", states: ["MERGED"] }] },
      { authenticated: false },
    );
    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual([]);
    expect(result.orphanBranchesRemoved).toBe(0);
  });

  it("skips repos whose bare cache directory does not exist", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/missing-cache.git";
    repoStore.add(repoUrl);
    // Intentionally do NOT create the cache directory.

    const githubAuthManager = buildGitHubStub({
      "example/missing-cache": [
        { name: "old-merged-1", states: ["MERGED"] },
        { name: "old-merged-2", states: ["MERGED"] },
      ],
    });
    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual([]);
    expect(result.orphanBranchesRemoved).toBe(0);
  });

  it("skips non-GitHub repo URLs", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://gitlab.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    let queries = 0;
    const githubAuthManager = {
      authenticated: true,
      async graphqlQuery() { queries += 1; return null; },
    } as unknown as Parameters<typeof runDiskJanitor>[0]["githubAuthManager"];

    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(queries).toBe(0);
    expect(deleted).toEqual([]);
    expect(result.orphanBranchesRemoved).toBe(0);
  });

  it("disabled when sweepOrphanBranches is false", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub({
      "example/repo": [{ name: "old-merged", states: ["MERGED"] }],
    });
    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
      sweepOrphanBranches: false,
    });

    expect(deleted).toEqual([]);
    expect(result.orphanBranchesRemoved).toBe(0);
  });

  it("swallows per-branch delete failures and continues with the next branch", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub({
      "example/repo": [
        { name: "merged-1", states: ["MERGED"] },
        { name: "merged-2", states: ["MERGED"] },
      ],
    });
    const { factory } = buildRepoGitFactory({ deleteFails: true });

    // Should not throw. Result count is 0 because every delete failed.
    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(result.orphanBranchesRemoved).toBe(0);
  });

  it("excludes archived sessions from the live-branch set (unarchive regenerates branch)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    // Archived session that USED to point at shipit/orphan-branch. Its old
    // branch is now orphaned — unarchiveSession would generate a fresh branch
    // anyway, so deletion is safe.
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, branch, archived) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).run(
      "22222222-2222-2222-2222-222222222222", "Archived", "2026-05-12", "2026-05-12",
      repoUrl, "shipit/orphan-branch",
    );

    const githubAuthManager = buildGitHubStub({
      "example/repo": [{ name: "orphan-branch", states: ["MERGED"] }],
    });
    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual(["shipit/orphan-branch"]);
    expect(result.orphanBranchesRemoved).toBe(1);
  });

  it("joins refs by PR head ref (regression: associatedPullRequests returned empty)", async () => {
    // Regression for the bug observed on the real ShipIt repo: 186
    // `shipit/*` branches existed, 181 had MERGED PRs, but the previous
    // `Ref.associatedPullRequests` sub-selection returned empty PR lists
    // for all of them, so the sweep deleted 0. The fix is to enumerate
    // PRs from the `pullRequests(states: [OPEN, MERGED])` side and join
    // by `headRefName` instead.
    //
    // This test stubs the two queries directly (not via buildGitHubStub)
    // and proves that a refs query returning a branch *without* PR data
    // attached is correctly joined to a separate pullRequests query that
    // does return the MERGED PR for that head ref.
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = {
      authenticated: true,
      async graphqlQuery(query: string) {
        if (query.includes("pullRequests(states:")) {
          return {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { state: "MERGED", headRefName: "shipit/old-merged" },
                  ],
                },
              },
            },
          };
        }
        // Refs query — no PR data attached, mirroring how the broken
        // server-side response looked for the historical backlog.
        return {
          data: {
            repository: {
              refs: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: "old-merged" }],
              },
            },
          },
        };
      },
    } as unknown as Parameters<typeof runDiskJanitor>[0]["githubAuthManager"];

    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual(["shipit/old-merged"]);
    expect(result.orphanBranchesRemoved).toBe(1);
  });

  it("paginates the pullRequests query across pages", async () => {
    // A two-page pullRequests response is correctly joined to the refs
    // query — important because real repos with many PRs will exceed the
    // 100-per-page limit.
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    let prPage = 0;
    const githubAuthManager = {
      authenticated: true,
      async graphqlQuery(query: string) {
        if (query.includes("pullRequests(states:")) {
          prPage += 1;
          if (prPage === 1) {
            return {
              data: {
                repository: {
                  pullRequests: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                    nodes: [{ state: "MERGED", headRefName: "shipit/branch-a" }],
                  },
                },
              },
            };
          }
          return {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ state: "MERGED", headRefName: "shipit/branch-b" }],
                },
              },
            },
          };
        }
        return {
          data: {
            repository: {
              refs: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ name: "branch-a" }, { name: "branch-b" }],
              },
            },
          },
        };
      },
    } as unknown as Parameters<typeof runDiskJanitor>[0]["githubAuthManager"];

    const { factory, deleted } = buildRepoGitFactory();

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted.sort()).toEqual(["shipit/branch-a", "shipit/branch-b"]);
    expect(result.orphanBranchesRemoved).toBe(2);
    expect(prPage).toBe(2);
  });

  it("sweeps per-session credential dirs for archived / untracked sessions only", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveId = "live000000000000";
    const archivedId = "arch000000000000";
    const goneId = "gone000000000000";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(archivedId, "Archived", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    // Lay down per-session credential dirs for all three.
    const credentialsDir = path.join(tmpDir, "credentials");
    for (const id of [liveId, archivedId, goneId]) {
      const dir = path.join(credentialsDir, "sessions", id);
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), "{}");
    }

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      credentialsDir,
      runDocker: () => Promise.resolve(""),
    });

    // Live (tracked + not archived) is preserved; archived and untracked are reaped.
    expect(fs.existsSync(path.join(credentialsDir, "sessions", liveId))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir, "sessions", archivedId))).toBe(false);
    expect(fs.existsSync(path.join(credentialsDir, "sessions", goneId))).toBe(false);
    expect(result.credentialDirsRemoved).toBe(2);
  });

  it("credential-dir sweep is a no-op when credentialsDir is omitted", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.credentialDirsRemoved).toBe(0);
  });
});
