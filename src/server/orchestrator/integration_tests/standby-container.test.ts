import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { deriveSessionMemorySizing } from "../session-container.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import {
  SessionContainerManager,
  CONTAINER_SESSION_ID_LABEL,
  CONTAINER_STANDBY_LABEL,
} from "../session-container.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";
import { allocateDeadLoopbackPort } from "./container-test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";

const REPO_URL = "https://github.com/owner/standby-test-repo.git";

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
    getNetwork: () => ({
      inspect: async () => { throw new Error("not found"); },
    }),

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
          NetworkSettings: {
            Networks: { "shipit-test": { IPAddress: ip } },
          },
        }),
        stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
        remove: async () => { containers.delete(id); },
      };
    },

    getContainer: (id: string) => ({
      inspect: async () => {
        const c = [...containers.values()].find((v) => v.id === id);
        if (!c) throw new Error("not found");
        return {
          id,
          NetworkSettings: {
            Networks: { "shipit-test": { IPAddress: c.ip } },
          },
        };
      },
      stop: async () => { if (containers.has(id)) containers.get(id)!.started = false; },
      remove: async () => { containers.delete(id); },
    }),

    // Preserve label filtering to distinguish standby and Compose cleanup.
    listContainers: async (opts?: { filters?: { label?: string[] } }) => {
      const wanted = opts?.filters?.label ?? [];
      return [...containers.values()]
        .filter((c) => wanted.every((f) => {
          const eq = f.indexOf("=");
          if (eq === -1) return f in c.labels;
          return c.labels[f.slice(0, eq)] === f.slice(eq + 1);
        }))
        .map((c) => ({
          Id: c.id,
          Labels: c.labels,
          State: c.started ? "running" : "exited",
        }));
    },

    getEvents: async () => eventEmitter,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("standby container pre-warming", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let origGitTerminalPrompt: string | undefined;
  let origGitConfigGlobal: string | undefined;
  let dbManager: DatabaseManager;
  let credentialStore: ReturnType<typeof createTestCredentialStore>;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-standby-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

    fakeDocker = createFakeDocker();
    containerManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: await allocateDeadLoopbackPort(),
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    // Set GIT_CONFIG_GLOBAL before the seed helper writes its local fetch redirect.
    credentialStore = createTestCredentialStore(tmpDir);

    seedRepoCacheWithLocalBare({ tmpDir, repoUrl: REPO_URL });

    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    dbManager.close();
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    if (origGitConfigGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    }
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("startup warming creates a standby container (so pre-install runs ahead of the first claim)", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session created",
    );

    const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;

    await waitFor(
      () => containerManager.isStandby(warmSessionId),
      10000,
      "standby container created at startup",
    );
    expect(containerManager.get(warmSessionId)).toBeDefined();
    expect(fakeDocker._containers.size).toBeGreaterThanOrEqual(1);
  }, 15000);

  it("claim triggers re-warming with standby container", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );
    const firstWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    const encodedUrl = encodeURIComponent(REPO_URL);
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toBe(firstWarmId);

    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== firstWarmId;
      },
      10000,
      "re-warmed session with standby",
    );

    const newWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    await waitFor(
      () => containerManager.isStandby(newWarmId),
      5000,
      "standby container created",
    );

    expect(containerManager.get(newWarmId)).toBeDefined();
    expect(containerManager.get(newWarmId)!.status).toBe("running");

    const dockerContainer = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === newWarmId,
    );
    expect(dockerContainer).toBeDefined();
    expect(dockerContainer!.labels[CONTAINER_STANDBY_LABEL]).toBe("true");
  }, 25000);

  it("standby reused on activation (zero cold start)", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );

    const encodedUrl = encodeURIComponent(REPO_URL);
    const firstClaimRes = await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });
    const firstClaimedId = firstClaimRes.json().sessionId;

    sessionManager.setWarm(firstClaimedId, false);

    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== firstClaimedId;
      },
      10000,
      "re-warmed session",
    );
    const standbySessionId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(
      () => containerManager.isStandby(standbySessionId),
      5000,
      "standby ready",
    );

    const standbyContainerId = containerManager.get(standbySessionId)!.id;

    const claimRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(claimRes.json().sessionId).toBe(standbySessionId);

    const client = await TestClient.connect(port, standbySessionId);
    await new Promise((r) => setTimeout(r, 500));

    const sc = containerManager.get(standbySessionId);
    expect(sc).toBeDefined();
    expect(sc!.id).toBe(standbyContainerId);

    expect(containerManager.isStandby(standbySessionId)).toBe(false);

    client.close();
  }, 30000);

  it("standby protected from idle cleanup", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );

    const claimedWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== claimedWarmId;
      },
      10000,
      "re-warmed session",
    );
    const standbySessionId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(
      () => containerManager.isStandby(standbySessionId),
      5000,
      "standby ready",
    );

    expect(containerManager.get(standbySessionId)).toBeDefined();
    expect(containerManager.isStandby(standbySessionId)).toBe(true);

    const sessionsDir = path.join(tmpDir, "sessions");
    const idleSessionId = `idle-test-${Date.now()}`;
    const idleDir = path.join(sessionsDir, idleSessionId);
    fs.mkdirSync(idleDir, { recursive: true });
    const git = new GitManager(idleDir);
    await git.init();
    sessionManager.track(idleSessionId, "Idle test", idleDir);

    const client = await TestClient.connect(port, idleSessionId);
    await new Promise((r) => setTimeout(r, 500));

    expect(containerManager.get(standbySessionId)).toBeDefined();
    expect(containerManager.isStandby(standbySessionId)).toBe(true);

    client.close();
  }, 25000);

  it("standby destroyed on repo delete", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );

    const claimedWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== claimedWarmId;
      },
      10000,
      "re-warmed session",
    );
    const standbySessionId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(
      () => containerManager.isStandby(standbySessionId),
      5000,
      "standby ready",
    );

    expect(containerManager.get(standbySessionId)).toBeDefined();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodedUrl}`,
    });
    expect(deleteRes.statusCode).toBe(200);

    expect(containerManager.get(standbySessionId)).toBeUndefined();
    expect(containerManager.isStandby(standbySessionId)).toBe(false);
  }, 25000);

  it("kills the previous process's standby container on restart and re-warms", async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10000, "warm session");
    const oldWarmId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(() => containerManager.isStandby(oldWarmId), 10000, "standby at first boot");
    const oldContainerId = containerManager.get(oldWarmId)!.id;
    expect(fakeDocker._containers.has(oldContainerId)).toBe(true);

    const oldPreviewId = "fake-preview-of-warm";
    fakeDocker._containers.set(oldPreviewId, {
      id: oldPreviewId,
      started: true,
      labels: { "shipit-parent-session": oldWarmId },
      ip: "127.0.0.99",
      hostConfig: {},
    });

    await app.close();
    const restartedManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: await allocateDeadLoopbackPort(),
      skipHealthCheck: true,
      stackName: "shipit-test",
    });
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: restartedManager,
    });

    expect(fakeDocker._containers.has(oldContainerId)).toBe(false);
    expect(restartedManager.isStandby(oldWarmId)).toBe(false);
    expect(fakeDocker._containers.has(oldPreviewId)).toBe(false);
    expect(sessionManager.get(oldWarmId)).toBeUndefined();

    await waitFor(
      () => {
        const id = repoStore.get(REPO_URL)?.warmSessionId;
        return !!id && id !== oldWarmId && restartedManager.isStandby(id);
      },
      10000,
      "re-warmed session with a new standby",
    );
  }, 30000);

  it("rediscover adopts a claimed standby as an ordinary container", async () => {
    const standbyId = "standby-rediscover-test";
    const standbyDir = path.join(tmpDir, "sessions", standbyId);
    fs.mkdirSync(standbyDir, { recursive: true });

    await containerManager.createStandby({
      sessionId: standbyId,
      sessionDir: standbyDir,
      workspaceDir: path.join(standbyDir, "workspace"),
      sessionStateDir: path.join(standbyDir, "state"),
      credentialsDir: tmpDir,
      imageName: "shipit-session-worker:test",
      memoryLimit: 512 * 1024 * 1024,
      cpuQuota: 50_000,
      pidsLimit: 256,
    });

    expect(containerManager.isStandby(standbyId)).toBe(true);
    expect(containerManager.standbyCount).toBe(1);

    const newManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: await allocateDeadLoopbackPort(),
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    const count = await newManager.rediscover(new Set([standbyId]), () => ({
      workspaceDir: "/workspace/sessions/standby",
      dockerAccess: false,
    }));
    expect(count).toBe(1);
    expect(newManager.isStandby(standbyId)).toBe(false);
    expect(newManager.get(standbyId)).toBeDefined();
    expect(newManager.get(standbyId)!.status).toBe("running");
  });

  it("a claimed standby's container survives the restart", async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10000, "warm session");
    const claimedId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(() => containerManager.isStandby(claimedId), 10000, "standby");
    const claimedContainerId = containerManager.get(claimedId)!.id;

    // Graduation clears the row's warm flag; the container keeps its creation label.
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(REPO_URL)}/claim-session`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toBe(claimedId);
    sessionManager.setWarm(claimedId, false);

    await app.close();
    const restartedManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: await allocateDeadLoopbackPort(),
      skipHealthCheck: true,
      stackName: "shipit-test",
    });
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: restartedManager,
    });

    expect(fakeDocker._containers.has(claimedContainerId)).toBe(true);
    expect(sessionManager.get(claimedId)).toBeDefined();
    expect(restartedManager.isStandby(claimedId)).toBe(false);
  }, 30000);

});

describe("standby container resources are auto-sized", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let containerManager: SessionContainerManager;
  let fakeDocker: ReturnType<typeof createFakeDocker>;
  let origGitTerminalPrompt: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-standby-rsrc-"));
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

    const credentialStore = createTestCredentialStore(tmpDir);

    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: REPO_URL,
      seedFiles: { "shipit.yaml": "agent:\n  memory: 3072\n  cpu: 2.0\n  pids: 2048\n" },
    });
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    dbManager.close();
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  it("standby container is auto-sized, ignoring removed agent.memory/cpu/pids", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "initial warm session",
    );
    const firstWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== firstWarmId;
      },
      10000,
      "re-warmed session",
    );
    const standbySessionId = repoStore.get(REPO_URL)!.warmSessionId!;
    await waitFor(
      () => containerManager.isStandby(standbySessionId),
      5000,
      "standby ready",
    );

    const standbyDocker = [...fakeDocker._containers.values()].find(
      (c) => c.labels[CONTAINER_SESSION_ID_LABEL] === standbySessionId,
    );
    expect(standbyDocker).toBeDefined();
    const expectedMem = deriveSessionMemorySizing().effectiveMb * 1024 * 1024;
    expect(standbyDocker!.hostConfig.Memory).toBe(expectedMem);
    expect(standbyDocker!.hostConfig.PidsLimit).toBe(8192);
    expect(standbyDocker!.hostConfig.CpuQuota).toBe(Math.max(1, os.cpus().length) * 100_000);
  }, 25000);
});
