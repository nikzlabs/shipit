import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { deriveSessionMemorySizing } from "../session-container.js";
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
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";

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
      const ip = `127.0.0.${containerCounter + 2}`;
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

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

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

  beforeEach(async () => {
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
      workerPort: await allocateDeadLoopbackPort(),
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

  async function setup(remoteFiles: Record<string, string>): Promise<{ remoteDir: string }> {
    const remoteDir = createRealRemote(path.join(tmpDir, "real-remote"), remoteFiles);
    repoUrl = remoteDir;

    const cacheDir = path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl));
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    git(tmpDir, `clone "${remoteDir}" "${cacheDir}"`);
    // Suppress cache refresh to test the workspace clone's fetch.
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

  it("W2: warm standby boots auto-sized and records its booted limits", async () => {
    const { remoteDir } = await setup({ "README.md": "# test\n" });
    advanceRemote(remoteDir, { "shipit.yaml": "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n" });

    await waitFor(() => !!repoStore.get(repoUrl)?.warmSessionId, 10000, "warm #1");
    const firstWarmId = repoStore.get(repoUrl)!.warmSessionId!;

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

    const standbyDocker = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === standbyId,
    );
    expect(standbyDocker).toBeDefined();
    const expectedMem = deriveSessionMemorySizing().effectiveMb * 1024 * 1024;
    const expectedCpu = Math.max(1, os.cpus().length) * 100_000;
    expect(standbyDocker!.hostConfig.Memory).toBe(expectedMem);
    expect(standbyDocker!.hostConfig.PidsLimit).toBe(8192);

    expect(containerManager.get(standbyId)?.bootedLimits).toEqual({
      memoryLimit: expectedMem,
      cpuQuota: expectedCpu,
      pidsLimit: 8192,
    });
  }, 30000);

  it("W3: a HEAD change does not destroy a standby (limits are host-stable under auto-sizing)", async () => {
    const { remoteDir } = await setup({ "README.md": "# test\n" });

    await waitFor(() => !!repoStore.get(repoUrl)?.warmSessionId, 10000, "warm #1");
    const warmId = repoStore.get(repoUrl)!.warmSessionId!;
    expect(sessionManager.get(warmId)!.workspaceDir).toBeDefined();

    await waitFor(() => containerManager.isStandby(warmId), 10000, "startup standby");
    const expectedMem = deriveSessionMemorySizing().effectiveMb * 1024 * 1024;
    expect(containerManager.get(warmId)?.bootedLimits?.memoryLimit).toBe(expectedMem);

    advanceRemote(remoteDir, { "shipit.yaml": "agent:\n  memory: 3072\n" });

    const destroySpy = vi.spyOn(containerManager, "destroy");

    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(repoUrl)}/claim-session`,
    });
    expect(res.statusCode).toBe(200);

    expect(destroySpy).not.toHaveBeenCalledWith(warmId);
    expect(containerManager.get(warmId)).toBeDefined();
  }, 30000);
});
