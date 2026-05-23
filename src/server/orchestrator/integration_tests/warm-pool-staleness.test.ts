/**
 * Integration tests for warm-pool / claim-time staleness (W2 + W3).
 *
 * Root cause being covered (session 90afd431): the bare cache could be
 * hundreds of commits behind the real remote, so the warm pool provisioned
 * the session container's memory limit off a frozen `shipit.yaml`. Two
 * fixes:
 *
 *   W2 — the warm pool and claim slow-path now fetch the *real remote* in
 *        the workspace clone (`fetchAndResolveDefaultBranch`) before cutting
 *        the branch, so the session lands on the actual latest commit even
 *        when the bare cache is stale.
 *   W3 — the claim-time `refreshCloneToLatestMain` re-provisions the standby
 *        container when the HEAD jump changed the declared `agent.memory`
 *        (container memory is immutable at runtime, so the only fix is to
 *        destroy + rebuild).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { SessionContainerManager, CONTAINER_SESSION_ID_LABEL } from "../session-container.js";
import { repoUrlToHash } from "../git-utils.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { AuthManager } from "../auth.js";
import type { GitHubAuthManager } from "../github-auth.js";

// ---------------------------------------------------------------------------
// Fake Docker — same shape as standby-container.test.ts
// ---------------------------------------------------------------------------

function createFakeDocker() {
  let containerCounter = 0;
  const containers = new Map<string, {
    id: string; started: boolean; labels: Record<string, string>; ip: string;
    hostConfig: Record<string, unknown>;
  }>();
  const eventEmitter = new EventEmitter();

  return {
    _containers: containers,
    _eventEmitter: eventEmitter,
    ping: async () => "OK",
    createNetwork: async () => ({ id: "net-fake" }),
    getNetwork: () => ({ inspect: async () => { throw new Error("not found"); } }),
    createContainer: async (opts: any) => {
      containerCounter++;
      const id = `fake-container-${containerCounter}`;
      const ip = `172.18.0.${containerCounter + 2}`;
      containers.set(id, {
        id, started: false, labels: opts.Labels ?? {}, ip,
        hostConfig: opts.HostConfig ?? {},
      });
      return {
        id,
        start: async () => { containers.get(id)!.started = true; },
        inspect: async () => ({
          id,
          NetworkSettings: { Networks: { "shipit-test": { IPAddress: ip } } },
        }),
        stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
        remove: async () => { containers.delete(id); },
      };
    },
    getContainer: (id: string) => ({
      inspect: async () => {
        const c = [...containers.values()].find((v) => v.id === id);
        if (!c) throw new Error("not found");
        return { id, NetworkSettings: { Networks: { "shipit-test": { IPAddress: c.ip } } } };
      },
      stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
      remove: async () => { containers.delete(id); },
    }),
    listContainers: async () =>
      [...containers.values()].map((c) => ({
        Id: c.id, Labels: c.labels, State: c.started ? "running" : "exited",
      })),
    getEvents: async () => eventEmitter,
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/** Create a "real remote" repo with one commit on `main`. Returns its path. */
function createRealRemote(dir: string, files: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "checkout -b main");
  git(dir, "config user.email test@test");
  git(dir, "config user.name test");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, "add -A");
  git(dir, 'commit -m "c1" --no-gpg-sign');
  return dir;
}

/** Commit another revision into the real remote's `main`. */
function advanceRemote(remoteDir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(remoteDir, name), content);
  }
  git(remoteDir, "add -A");
  git(remoteDir, 'commit -m "c2" --no-gpg-sign');
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: warm-pool / claim staleness (W2 + W3)", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;
  let repoUrl: string;

  beforeEach(() => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-warm-stale-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    fakeDocker = createFakeDocker();
    containerManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: 9100,
      skipHealthCheck: true,
      stackName: "shipit-test",
    });
  });

  afterEach(async () => {
    dbManager.close();
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await app?.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  /**
   * Build the app against a "real remote" + a bare cache pinned at the
   * remote's first commit. `repoUrl` IS the real-remote path, so the
   * workspace clone's `origin` (set by `cloneFromCache`) is fetchable —
   * which is exactly what W2's `fetchAndResolveDefaultBranch` relies on.
   */
  async function setup(remoteFiles: Record<string, string>): Promise<{ remoteDir: string }> {
    const remoteDir = createRealRemote(path.join(tmpDir, "real-remote"), remoteFiles);
    repoUrl = remoteDir; // a local path acts as the repo URL

    // Bare cache = a clone of the real remote, pinned at its current HEAD.
    const cacheDir = path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl));
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    git(tmpDir, `clone "${remoteDir}" "${cacheDir}"`);
    // Freeze the cache: a fresh `.shipit-last-fetch` marker makes
    // `fetchCache()` a TTL no-op, so the cache stays at this commit even as
    // the real remote advances — isolating W2's workspace-clone fetch.
    fs.writeFileSync(path.join(cacheDir, ".shipit-last-fetch"), String(Date.now()));

    repoStore.add(repoUrl);
    repoStore.setReady(repoUrl);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore: createTestCredentialStore(tmpDir),
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    return { remoteDir };
  }

  it("W2: warm standby boots at the real remote's latest agent.memory, not the stale cache's", async () => {
    // Real remote: c1 has NO shipit.yaml; c2 declares 3 GiB. The bare cache
    // is frozen at c1 — so the only way the standby boots at 3 GiB is if
    // the warm path fetched the real remote in the workspace clone.
    const { remoteDir } = await setup({ "README.md": "# test\n" });
    advanceRemote(remoteDir, { "shipit.yaml": "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n" });

    // Startup warming creates warm #1 (no standby).
    await waitFor(() => !!repoStore.get(repoUrl)?.warmSessionId, 10000, "warm #1");
    const firstWarmId = repoStore.get(repoUrl)!.warmSessionId!;

    // Claim → re-warm → standby container.
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(repoUrl)}/claim-session`,
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => {
      const id = repoStore.get(repoUrl)?.warmSessionId;
      return !!id && id !== firstWarmId;
    }, 10000, "re-warmed session");
    const standbyId = repoStore.get(repoUrl)!.warmSessionId!;
    await waitFor(() => containerManager.isStandby(standbyId), 10000, "standby ready");

    // The standby's fake-docker container must carry the 3 GiB limit from
    // c2's shipit.yaml — proving the workspace landed on the latest commit
    // despite the bare cache being frozen at c1.
    const standbyDocker = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === standbyId,
    );
    expect(standbyDocker).toBeDefined();
    expect(standbyDocker!.hostConfig.Memory).toBe(3072 * 1024 * 1024);
    expect(standbyDocker!.hostConfig.PidsLimit).toBe(2048);

    // And the booted limits are recorded on the tracked container (W3 plumbing).
    expect(containerManager.get(standbyId)?.bootedLimits).toEqual({
      memoryLimit: 3072 * 1024 * 1024,
      cpuQuota: 200_000,
      pidsLimit: 2048,
    });
  }, 30000);

  it("W3: claim destroys a standby whose booted limits no longer match the refreshed workspace", async () => {
    // Real remote starts at c1 with NO shipit.yaml → defaults (1.5 GiB).
    const { remoteDir } = await setup({ "README.md": "# test\n" });

    await waitFor(() => !!repoStore.get(repoUrl)?.warmSessionId, 10000, "warm #1");
    const warmId = repoStore.get(repoUrl)!.warmSessionId!;
    expect(sessionManager.get(warmId)!.workspaceDir).toBeDefined();

    // Startup warming now boots the standby itself (docs/148). c1 has no
    // shipit.yaml → defaults to 1.5 GiB, which is exactly the stale-limits
    // baseline this test wants. Wait for it to land instead of building a
    // duplicate by hand (which would now collide with the startup standby).
    await waitFor(() => containerManager.isStandby(warmId), 10000, "startup standby");
    expect(containerManager.get(warmId)?.bootedLimits?.memoryLimit).toBe(1536 * 1024 * 1024);

    // The remote advances: c2 declares 3 GiB. The standby is now stale.
    advanceRemote(remoteDir, { "shipit.yaml": "agent:\n  memory: 3072\n" });

    const destroySpy = vi.spyOn(containerManager, "destroy");

    // Claim → warm path → refreshCloneToLatestMain fetches c2 → headChanged
    // → reprovisionStandbyIfLimitsChanged sees 1 GiB booted vs 3 GiB declared
    // → destroys the standby so the runner factory rebuilds it correctly.
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(repoUrl)}/claim-session`,
    });
    expect(res.statusCode).toBe(200);

    expect(destroySpy).toHaveBeenCalledWith(warmId);
    expect(containerManager.get(warmId)).toBeUndefined();
  }, 30000);
});
