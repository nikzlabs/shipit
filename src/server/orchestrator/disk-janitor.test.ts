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
import { liveOverlayScopeHashes, overlayRuntimeKey } from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";

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

  it("paces between destructive removals when paceMs is set (still removes all)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Three orphan volumes (no live sessions) → three rm calls, each preceded
    // by a `sleep(paceMs)`. We capture the wall-clock of each rm and assert the
    // gaps are >= paceMs: setTimeout never fires *early*, so this lower bound is
    // not flaky (scheduling jitter only ever adds delay).
    const paceMs = 25;
    const rmAt: number[] = [];
    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") {
        return Promise.resolve(
          ["shipit-aaaa11112222_a", "shipit-bbbb33334444_b", "shipit-cccc55556666_c"].join("\n"),
        );
      }
      if (args[0] === "volume" && args[1] === "rm") {
        rmAt.push(Date.now());
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
      paceMs,
    });

    expect(result.orphanVolumesRemoved).toBe(3);
    expect(rmAt).toHaveLength(3);
    for (let i = 1; i < rmAt.length; i += 1) {
      // Allow a tiny scheduling epsilon below the nominal pace.
      expect(rmAt[i] - rmAt[i - 1]).toBeGreaterThanOrEqual(paceMs - 5);
    }
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
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("old-session", "Old", old, old, oldDir, remote);
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
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
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
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

    const oldDir = path.join(tmpDir, "sessions", "no-remote-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    // No remote_url — should be skipped even though it's older than the threshold.
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("no-remote-session", "No remote", old, old, oldDir);

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

  it("reclaims the dead nm-store subtree wholesale under tracked repos (docs/183)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    const nmRoot = path.join(tmpDir, "dep-cache", liveHash, "nm-store");
    // Several leftover storeKey dirs of varying age — all dead, all removed.
    fs.mkdirSync(path.join(nmRoot, "fresh-store-key"), { recursive: true });
    const staleDir = path.join(nmRoot, "stale-store-key");
    fs.mkdirSync(staleDir, { recursive: true });
    const backdated = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(staleDir, backdated, backdated);
    fs.mkdirSync(path.join(nmRoot, ".tmp-deadbeef-store-key"), { recursive: true });

    // The rest of the dep-cache (download cache) for the live repo must survive.
    const depCacheKept = path.join(tmpDir, "dep-cache", liveHash, "_cacache");
    fs.mkdirSync(depCacheKept, { recursive: true });

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    // The whole nm-store dir is gone (one dir removed), the download cache stays.
    expect(result.nmStoresRemoved).toBe(1);
    expect(fs.existsSync(nmRoot)).toBe(false);
    expect(fs.existsSync(depCacheKept)).toBe(true);
  });

  it("nm-store sweep is a no-op when there is no nm-store dir", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveRepo = "https://github.com/example/live.git";
    const liveHash = repoUrlToHash(liveRepo);
    repoStore.add(liveRepo);
    repoStore.setReady(liveRepo);

    // Live repo with a download cache but no nm-store subtree.
    fs.mkdirSync(path.join(tmpDir, "dep-cache", liveHash, "_cacache"), { recursive: true });

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.nmStoresRemoved).toBe(0);
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
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
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
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, branch, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
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

  it("preserves the branch of a hot merged session even when it fell out of the sidebar (docs/161)", async () => {
    // Regression for the docs/161 decoupling: a merged session that dropped out
    // of `list()` (the per-repo top-N view cap) is still `hot` on disk and
    // resumable, so its branch MUST NOT be treated as orphaned. The sweep keys
    // off `listAll()` minus evicted, not `list()`.
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    // Merged, hot (default disk_tier), NOT user-archived. Points at a branch
    // whose PR is merged — the old `list()`-based sweep would have deleted it.
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, branch, merged_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    ).run(
      "33333333-3333-3333-3333-333333333333", "Hot merged", "2026-05-12", "2026-05-12",
      repoUrl, "shipit/hot-merged", "2026-05-12 00:00:00",
    );

    const githubAuthManager = buildGitHubStub({
      "example/repo": [{ name: "hot-merged", states: ["MERGED"] }],
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
    // archivedId must be disk-evicted: the credential sweep keys off
    // listArchived() = disk_tier 'evicted'.
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 1, 1, 'evicted')",
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

  // -------------------------------------------------------------------------
  // docs/183 Phase 2/3 — overlay resources
  // -------------------------------------------------------------------------

  it("reclaims an orphan `shipit-<id>_overlay` volume (existing orphan-volume sweep)", async () => {
    // The overlay volume name deliberately matches the `^shipit-([a-f0-9-]{12})_`
    // pattern, so no new sweep is needed — the existing one reclaims it once no
    // live session owns the prefix. This locks that contract.
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const rmRequests: string[] = [];
    const dockerListing = [
      `shipit-${liveId.slice(0, 12)}_overlay`, // live session — PRESERVE
      "shipit-deadbeef0000_overlay",            // orphan — REMOVE
    ].join("\n");

    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") return Promise.resolve(dockerListing);
      if (args[0] === "volume" && args[1] === "rm") { rmRequests.push(args[2]); return Promise.resolve(""); }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({ sessionManager, repoStore, stateDir: tmpDir, runDocker });

    expect(rmRequests).toEqual(["shipit-deadbeef0000_overlay"]);
    expect(rmRequests).not.toContain(`shipit-${liveId.slice(0, 12)}_overlay`);
    expect(result.orphanVolumesRemoved).toBe(1);
  });

  it("overlay-base sweep is skipped when liveOverlayScopeHashes is not provided", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    // Seed a stale overlay-base dir; without a live-scope-hash source the sweep
    // must NOT touch it (we can't confirm it isn't a live lowerdir).
    const baseDir = path.join(tmpDir, "overlay-base", "0123456789abcdef");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "marker"), "x");
    const old = Date.now() / 1000 - 99 * 86_400;
    fs.utimesSync(baseDir, old, old);

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(baseDir)).toBe(true);
    expect(result.overlayBasesRemoved).toBe(0);
  });

  it("overlay-base sweep removes stale, unreferenced bases but keeps live + young ones", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
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
    const liveStale = mk("aaaaaaaaaaaaaaaa", 99);   // live → keep despite age
    const orphanStale = mk("bbbbbbbbbbbbbbbb", 99);  // unreferenced + old → REMOVE
    const orphanYoung = mk("cccccccccccccccc", 1);   // unreferenced but young → keep
    // A stray file (not a dir) must be ignored.
    fs.writeFileSync(path.join(root, "stray.txt"), "x");

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () => new Set(["aaaaaaaaaaaaaaaa"]),
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(liveStale)).toBe(true);
    expect(fs.existsSync(orphanStale)).toBe(false);
    expect(fs.existsSync(orphanYoung)).toBe(true);
    expect(fs.existsSync(path.join(root, "stray.txt"))).toBe(true);
    expect(result.overlayBasesRemoved).toBe(1);
  });

  it("reaps stale superseded generations inside a LIVE scope, keeping g0 + the current generation", async () => {
    // Generational bases (overlay-base.ts): a live scope dir is never removed,
    // but superseded `g<N>` children and crash-orphaned `.tmp-*` copies age out.
    // The pointer's current generation and `g0` (the empty cold-start lowerdir)
    // are kept unconditionally; young non-current generations survive too (a
    // long-running container may still pin one).
    setup();
    const sessionManager = new SessionManager(dbManager!);
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
    const g0 = mkGen("g0", 99);          // cold-start lowerdir → always kept
    const g1 = mkGen("g1", 99);          // superseded + old → REMOVE
    const g2 = mkGen("g2", 1);           // superseded but young → keep
    const g3 = mkGen("g3", 99);          // current per pointer → keep despite age
    const tmp = mkGen(".tmp-g4-ab12", 99); // crash-orphaned copy → REMOVE
    // Pointer names g3 as current.
    const metaDir = path.join(tmpDir, "overlay-base-meta");
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, `${hash}.json`),
      JSON.stringify({ scopeHash: hash, commit: "c".repeat(40), depth: 2, generation: 3, baseDir: g3, updatedAt: "2026-06-01T00:00:00Z" }),
    );

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
      cacheDays: 30,
      liveOverlayScopeHashes: () => new Set([hash]),
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(g0)).toBe(true);
    expect(fs.existsSync(g1)).toBe(false);
    expect(fs.existsSync(g2)).toBe(true);
    expect(fs.existsSync(g3)).toBe(true);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(scopeDir)).toBe(true);
    expect(result.overlayBasesRemoved).toBe(2);
  });

  it("reclaims ALL N per-dep-dir orphan overlay volumes and preserves a live session's N", async () => {
    // The dep-dir design names overlay volumes `shipit-<id12>_overlay-<hash8>`,
    // one per declared dep dir. The existing `^shipit-([a-f0-9-]{12})_` orphan
    // sweep keys on the session-ID prefix, so it reclaims EVERY crash-orphaned
    // per-dep-dir volume of a dead session and preserves every one of a live
    // session's — no per-dep-dir sweep logic needed. This locks that for N>1.
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    const livePrefix = liveId.slice(0, 12);

    const liveVols = [`shipit-${livePrefix}_overlay-aaaa1111`, `shipit-${livePrefix}_overlay-bbbb2222`];
    const orphanVols = ["shipit-deadbeef0000_overlay-cccc3333", "shipit-deadbeef0000_overlay-dddd4444"];

    const rmRequests: string[] = [];
    const dockerListing = [...liveVols, ...orphanVols].join("\n");
    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "volume" && args[1] === "ls") return Promise.resolve(dockerListing);
      if (args[0] === "volume" && args[1] === "rm") { rmRequests.push(args[2]); return Promise.resolve(""); }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({ sessionManager, repoStore, stateDir: tmpDir, runDocker });

    expect([...rmRequests].sort()).toEqual([...orphanVols].sort());
    for (const v of liveVols) expect(rmRequests).not.toContain(v);
    expect(result.orphanVolumesRemoved).toBe(2);
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

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
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
