import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { RepoStore } from "./repo-store.js";
import { runDiskJanitor } from "./startup-janitor.js";
import { repoUrlToHash } from "./git-utils.js";
import type { GitRemoteCredential } from "./repo-git.js";
import { EGRESS_RESOLVER_LABEL } from "./egress-dns-install.js";
import { EGRESS_PROXY_LABEL } from "./egress-proxy-install.js";

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

    const liveSessionId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    const liveSessionPrefix = liveSessionId.slice(0, 12);
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveSessionId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const lsRequests: string[][] = [];
    const rmRequests: string[] = [];
    const dockerListing = [
      `shipit-${liveSessionPrefix}_node_modules`,
      "shipit-fed987654321_dist",
      "shipit-aaaa11112222_build",
      "shipit-deadbeef0000_cache",
      "shipit-foo-bar",
      "shipit_workspace",
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

    expect(lsRequests).toHaveLength(1);
    expect(lsRequests[0]).toContain("--filter");
    expect(lsRequests[0]).toContain("dangling=true");
    expect(lsRequests[0]).toContain("name=shipit-");

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
      expect(rmAt[i] - rmAt[i - 1]).toBeGreaterThanOrEqual(paceMs - 5);
    }
  });

  it("sweeps orphan session networks whose session is no longer tracked", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveSessionId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    const liveSessionPrefix = liveSessionId.slice(0, 12);
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveSessionId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const lsRequests: string[][] = [];
    const rmRequests: string[] = [];
    const dockerListing = [
      `shipit-session-${liveSessionPrefix}`,
      `shipit-session-${liveSessionId}`,
      "shipit-session-fed987654321",
      "shipit-session-deadbeef0000-1111-2222-3333-444444444444",
      "shipit-session-foo",
      "bridge",
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

    expect(lsRequests).toHaveLength(1);
    expect(lsRequests[0]).toContain("--filter");
    expect(lsRequests[0]).toContain("dangling=true");
    expect(lsRequests[0]).toContain("name=shipit-");

    expect(rmRequests.sort()).toEqual([
      "shipit-session-deadbeef0000-1111-2222-3333-444444444444",
      "shipit-session-fed987654321",
    ]);
    expect(result.orphanNetworksRemoved).toBe(2);
  });

  it("spares a network whose session is created after the listing (docs/113)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const racingSessionId = "aaaabbbbcccc-dddd-eeee-ffff-000000000000";
    const rmRequests: string[] = [];
    const runDocker = (args: string[]): Promise<string> => {
      if (args[0] === "network" && args[1] === "ls") {
        // Removing the first network creates the session that owns the second.
        return Promise.resolve([
          "shipit-session-fed987654321",
          `shipit-session-${racingSessionId.slice(0, 12)}`,
        ].join("\n"));
      }
      if (args[0] === "network" && args[1] === "rm") {
        rmRequests.push(args[2]);
        underlyingDb!.prepare(
          "INSERT OR IGNORE INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
        ).run(racingSessionId, "Racing", "2026-08-10", "2026-08-10", "https://github.com/example/repo.git");
      }
      return Promise.resolve("");
    };

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker,
    });

    expect(rmRequests).toEqual(["shipit-session-fed987654321"]);
    expect(result.orphanNetworksRemoved).toBe(1);
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

  it("sweeps archived workspaces older than coldArtifactRetentionDays", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

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
      coldArtifactRetentionDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("planning#194: archive sweep reclaims overlay/ sibling but preserves uploads/", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const sessionRoot = path.join(tmpDir, "sessions", "old-session");
    const workspaceDir = path.join(sessionRoot, "workspace");
    const overlayDir = path.join(sessionRoot, "overlay", "abc123", "upper");
    const uploadsDir = path.join(sessionRoot, "uploads");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "file"), "checkout");
    fs.writeFileSync(path.join(overlayDir, "dep"), "install delta");
    fs.writeFileSync(path.join(uploadsDir, "photo.png"), "user upload");

    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("old-session", "Old", old, old, workspaceDir, "https://github.com/example/repo.git");

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      coldArtifactRetentionDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
    expect(fs.existsSync(path.join(uploadsDir, "photo.png"))).toBe(true);
  });

  it("planning#194: archive sweep reclaims an orphaned overlay/ even when workspace/ is already gone", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const sessionRoot = path.join(tmpDir, "sessions", "orphan-session");
    const workspaceDir = path.join(sessionRoot, "workspace");
    const overlayDir = path.join(sessionRoot, "overlay", "abc123", "upper");
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.writeFileSync(path.join(overlayDir, "dep"), "orphaned install delta");

    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("orphan-session", "Orphan", old, old, workspaceDir, "https://github.com/example/repo.git");

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      coldArtifactRetentionDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(path.join(sessionRoot, "overlay"))).toBe(false);
  });

  it("archive backstop runs by default at the cold-artifact retention", async () => {
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

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it("skips archived sessions without a remoteUrl (defensive)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const oldDir = path.join(tmpDir, "sessions", "no-remote-session", "workspace");
    fs.mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("no-remote-session", "No remote", old, old, oldDir);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      coldArtifactRetentionDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(0);
    expect(fs.existsSync(oldDir)).toBe(true);
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
    fs.mkdirSync(path.join(nmRoot, "fresh-store-key"), { recursive: true });
    const staleDir = path.join(nmRoot, "stale-store-key");
    fs.mkdirSync(staleDir, { recursive: true });
    const backdated = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(staleDir, backdated, backdated);
    fs.mkdirSync(path.join(nmRoot, ".tmp-deadbeef-store-key"), { recursive: true });

    const depCacheKept = path.join(tmpDir, "dep-cache", liveHash, "_cacache");
    fs.mkdirSync(depCacheKept, { recursive: true });

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

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

    fs.mkdirSync(path.join(tmpDir, "dep-cache", liveHash, "_cacache"), { recursive: true });

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.nmStoresRemoved).toBe(0);
  });

  it("continues with the workspace sweep when the volume sweep fails", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

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
      coldArtifactRetentionDays: 30,
      runDocker,
    });

    expect(result.orphanVolumesRemoved).toBe(0);
    expect(result.workspacesRemoved).toBe(1);
  });

  function buildGitHubStub(
    branches: Record<string, { name: string; states: string[] }[]>,
    opts: { authenticated?: boolean; token?: string | null } = {},
  ) {
    return {
      authenticated: opts.authenticated ?? true,
      getToken: () => (opts.token === undefined ? "ghp_test_token" : opts.token),
      appTokensEnabled: () => false,

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

  function buildRepoGitFactory(opts: { deleteFails?: boolean } = {}) {
    const deleted: string[] = [];
    const setRemoteUrlCalls: string[] = [];
    const credentials: (GitRemoteCredential | undefined)[] = [];
    const factory = (_dir: string, credential?: GitRemoteCredential) => {
      credentials.push(credential);
      return {
        deleteBranch: (branch: string) => {
          if (opts.deleteFails) return Promise.reject(new Error("push denied"));
          deleted.push(branch);
          return Promise.resolve();
        },
        setRemoteUrl: (url: string) => {
          setRemoteUrlCalls.push(url);
          return Promise.resolve();
        },
      } as unknown as ReturnType<NonNullable<Parameters<typeof runDiskJanitor>[0]["createRepoGit"]>>;
    };
    return { factory, deleted, setRemoteUrlCalls, credentials };
  }

  const CREDENTIAL_FIELDS = {
    getToken: () => "ghp_test_token",
    appTokensEnabled: () => false,
  };

  it("deletes merged-PR branches that no live session points at", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);

    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, branch, archived) VALUES (?, ?, ?, ?, ?, ?, 0)",
    ).run(
      "11111111-1111-1111-1111-111111111111", "Live", "2026-05-12", "2026-05-12",
      repoUrl, "shipit/active-feature",
    );

    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub({
      "example/repo": [
        { name: "active-feature", states: ["MERGED"] },
        { name: "old-merged", states: ["MERGED"] },
        { name: "still-open", states: ["OPEN"] },
        { name: "open-and-merged", states: ["OPEN", "MERGED"] },
        { name: "closed-no-merge", states: ["CLOSED"] },
        { name: "no-pr", states: [] },
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
    expect(setRemoteUrlCalls).toEqual([repoUrl]);
  });

  it("hands the bare-cache push an explicit repo-scoped credential", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub({
      "example/repo": [{ name: "old-merged", states: ["MERGED"] }],
    });
    const { factory, deleted, credentials } = buildRepoGitFactory();

    await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      githubAuthManager,
      createRepoGit: factory,
      getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
    });

    expect(deleted).toEqual(["shipit/old-merged"]);
    expect(credentials).toEqual([{
      origin: "https://github.com",
      token: { username: "x-access-token", password: "ghp_test_token" },
    }]);
  });

  it("declines the sweep, loudly, when no credential can be resolved", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = buildGitHubStub(
      { "example/repo": [{ name: "old-merged", states: ["MERGED"] }] },
      { token: null },
    );
    const { factory, deleted } = buildRepoGitFactory();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let result;
    try {
      result = await runDiskJanitor({
        sessionManager,
        repoStore,
        stateDir: tmpDir,
        runDocker: () => Promise.resolve(""),
        githubAuthManager,
        createRepoGit: factory,
        getBareCacheDir: (url) => path.join(tmpDir, "repo-cache", repoUrlToHash(url)),
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(deleted).toEqual([]);
    expect(result.orphanBranchesRemoved).toBe(0);
    expect(warnings.some((w) => w.includes("no GitHub credential available for example/repo"))).toBe(true);
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
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

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
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    const githubAuthManager = {
      authenticated: true,
      ...CREDENTIAL_FIELDS,
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
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const repoUrl = "https://github.com/example/repo.git";
    repoStore.add(repoUrl);
    fs.mkdirSync(path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl)), { recursive: true });

    let prPage = 0;
    const githubAuthManager = {
      authenticated: true,
      ...CREDENTIAL_FIELDS,
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
    const evictedLiveId = "evic000000000000";
    const goneId = "gone000000000000";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run(archivedId, "Archived", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 0, 0, 'evicted')",
    ).run(evictedLiveId, "Evicted live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const credentialsDir = path.join(tmpDir, "credentials");
    for (const id of [liveId, archivedId, evictedLiveId, goneId]) {
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

    expect(fs.existsSync(path.join(credentialsDir, "sessions", liveId))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir, "sessions", evictedLiveId))).toBe(true);
    expect(fs.existsSync(path.join(credentialsDir, "sessions", archivedId))).toBe(false);
    expect(fs.existsSync(path.join(credentialsDir, "sessions", goneId))).toBe(false);
    expect(result.credentialDirsRemoved).toBe(2);
  });

  it("preserves per-session logs for disk-evicted-but-live sessions; reaps user-archived/untracked (planning#181)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveId = "live000000000000";
    const evictedLiveId = "evic000000000000";
    const archivedId = "arch000000000000";
    const goneId = "gone000000000000";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 0, 0, 'evicted')",
    ).run(evictedLiveId, "Evicted live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run(archivedId, "Archived", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const sessionsRoot = path.join(tmpDir, "sessions");
    for (const id of [liveId, evictedLiveId, archivedId, goneId]) {
      const dir = path.join(sessionsRoot, id, "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "container.log"), "x");
    }

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      sessionsRoot,
      runDocker: () => Promise.resolve(""),
    });

    expect(fs.existsSync(path.join(sessionsRoot, liveId, "logs"))).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot, evictedLiveId, "logs"))).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot, archivedId, "logs"))).toBe(false);
    expect(fs.existsSync(path.join(sessionsRoot, goneId, "logs"))).toBe(false);
    expect(result.logDirsRemoved).toBe(2);
  });

  it("archived-workspace sweep skips disk-evicted-but-live sessions (planning#181)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveDir = path.join(tmpDir, "sessions", "evicted-live", "workspace");
    const archivedDir = path.join(tmpDir, "sessions", "user-archived", "workspace");
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, "file"), "content");
    fs.writeFileSync(path.join(archivedDir, "file"), "content");

    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const remote = "https://github.com/example/repo.git";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'evicted')",
    ).run("evicted-live", "Evicted live", old, old, liveDir, remote);
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, workspace_dir, remote_url, archived, user_archived, disk_tier) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'evicted')",
    ).run("user-archived", "User archived", old, old, archivedDir, remote);

    const result = await runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir: tmpDir,
      coldArtifactRetentionDays: 30,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.workspacesRemoved).toBe(1);
    expect(fs.existsSync(liveDir)).toBe(true);
    expect(fs.existsSync(archivedDir)).toBe(false);
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

  it("reclaims an orphan `shipit-<id>_overlay` volume (existing orphan-volume sweep)", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const liveId = "abc123def456-aaaa-bbbb-cccc-dddddddddddd";
    underlyingDb!.prepare(
      "INSERT INTO sessions (id, title, created_at, last_used_at, remote_url, archived) VALUES (?, ?, ?, ?, ?, 0)",
    ).run(liveId, "Live", "2026-05-12", "2026-05-12", "https://github.com/example/repo.git");

    const rmRequests: string[] = [];
    const dockerListing = [
      `shipit-${liveId.slice(0, 12)}_overlay`,
      "shipit-deadbeef0000_overlay",
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

  it("reclaims ALL N per-dep-dir orphan overlay volumes and preserves a live session's N", async () => {
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

  it("reaps egress sidecars whose netns parent is gone, and spares the live ones", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    interface FakeC { labels: Record<string, string>; networkMode?: string; running?: boolean }
    const store = new Map<string, FakeC>([
      ["agent-live", { labels: {}, networkMode: "bridge", running: true }],
      ["res-live", { labels: { [EGRESS_RESOLVER_LABEL]: "s1" }, networkMode: "container:agent-live", running: true }],
      ["res-orphan", { labels: { [EGRESS_RESOLVER_LABEL]: "s2" }, networkMode: "container:agent-dead", running: false }],
      ["proxy-orphan", { labels: { [EGRESS_PROXY_LABEL]: "s2" }, networkMode: "container:agent-dead", running: false }],
    ]);
    const removed: string[] = [];
    const docker = {
      // Match Docker's default: stopped containers require all=true.
      listContainers: async (opts: { all?: boolean; filters?: { label?: string[] } }) => {
        const key = opts.filters?.label?.[0] ?? "";
        return [...store.entries()]
          .filter(([, c]) => key in c.labels && (opts.all || (c.running ?? false)))
          .map(([Id]) => ({ Id }));
      },
      getContainer: (id: string) => ({
        inspect: async () => {
          const c = store.get(id);
          if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
          return { HostConfig: { NetworkMode: c.networkMode }, State: { Running: c.running ?? false } };
        },
        remove: async () => { removed.push(id); store.delete(id); },
      }),
    } as unknown as Parameters<typeof runDiskJanitor>[0]["docker"];

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
      docker,
    });

    expect([...removed].sort()).toEqual(["proxy-orphan", "res-orphan"]);
    expect(removed).not.toContain("res-live");
    expect(result.orphanEgressSidecarsRemoved).toBe(2);
  });

  it("skips the egress-sidecar sweep entirely when no Docker client is wired", async () => {
    setup();
    const sessionManager = new SessionManager(dbManager!);
    const repoStore = new RepoStore(dbManager!);

    const result = await runDiskJanitor({
      sessionManager, repoStore, stateDir: tmpDir,
      runDocker: () => Promise.resolve(""),
    });

    expect(result.orphanEgressSidecarsRemoved).toBe(0);
  });
});
