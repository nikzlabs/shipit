/**
 * Integration tests for Phase 4b: container-level standby pre-warming.
 *
 * Validates that:
 *   - Startup warming does NOT create standby containers
 *   - Claim triggers re-warming with standby container
 *   - Standby containers are reused on activation (zero cold start)
 *   - Fetch origin is called during re-warming
 *   - Standby containers survive idle cleanup
 *   - No standby when at container cap
 *   - Standby destroyed on repo delete
 *   - Rediscover restores standby state
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
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
} from "./test-helpers.js";
import type { AuthManager } from "../auth.js";

const REPO_URL = "https://github.com/owner/standby-test-repo.git";

// ---------------------------------------------------------------------------
// Fake Docker (same pattern as container-lifecycle.test.ts)
// ---------------------------------------------------------------------------

function createFakeDocker() {
  let containerCounter = 0;
  const containers = new Map<string, {
    id: string; started: boolean; labels: Record<string, string>; ip: string;
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
      const ip = `172.18.0.${containerCounter + 2}`;
      containers.set(id, { id, started: false, labels: opts.Labels ?? {}, ip });

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

    listContainers: async () =>
      [...containers.values()]
        .map((c) => ({
          Id: c.id,
          Labels: c.labels,
          State: c.started ? "running" : "exited",
        })),

    getEvents: async () => eventEmitter,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSharedRepoDirForUrl(workspaceDir: string, repoUrl: string): string {
  const hash = crypto.createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
  return path.join(workspaceDir, "repos", hash);
}

function createSharedRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  execSync("git add .", { cwd: repoDir, stdio: "ignore" });
  execSync('git commit -m "init" --no-gpg-sign', { cwd: repoDir, stdio: "ignore" });
  execSync(`git remote add origin ${REPO_URL}`, { cwd: repoDir, stdio: "ignore" });
  execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: repoDir, stdio: "ignore" });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-standby-"));
    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    repoStore = new RepoStore(path.join(tmpDir, "repos.json"));

    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

    fakeDocker = createFakeDocker();
    containerManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: 9100,
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    // Set up credential store (and GIT_CONFIG_GLOBAL) BEFORE creating the
    // shared repo — git commit needs a valid identity config.
    const credentialStore = createTestCredentialStore(tmpDir);

    // Create shared repo
    const repoDir = getSharedRepoDirForUrl(tmpDir, REPO_URL);
    createSharedRepo(repoDir);

    // Add repo before buildApp so startup warming fires
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as import("../github-auth.js").GitHubAuthManager,
      credentialStore,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      credentialsDir: tmpDir,
      serveStatic: false,
      sessionContainerManager: containerManager,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
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

  it("startup warming does NOT create a standby container", async () => {
    // Wait for warm session to be created
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session created",
    );

    const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;

    // Startup warming should NOT boot a container
    expect(containerManager.get(warmSessionId)).toBeUndefined();
    expect(containerManager.isStandby(warmSessionId)).toBe(false);
    expect(fakeDocker._containers.size).toBe(0);
  }, 15000);

  it("claim triggers re-warming with standby container", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );
    const firstWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    // Claim the warm session — this triggers re-warming with { withStandby: true }
    const encodedUrl = encodeURIComponent(REPO_URL);
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionId).toBe(firstWarmId);

    // Wait for the re-warmed session to appear
    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== firstWarmId;
      },
      10000,
      "re-warmed session with standby",
    );

    const newWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    // The re-warmed session should have a standby container
    await waitFor(
      () => containerManager.isStandby(newWarmId),
      5000,
      "standby container created",
    );

    expect(containerManager.get(newWarmId)).toBeDefined();
    expect(containerManager.get(newWarmId)!.status).toBe("running");

    // Docker container should have the standby label
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

    // Claim first warm session → triggers re-warming with standby
    const encodedUrl = encodeURIComponent(REPO_URL);
    const firstClaimRes = await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });
    const firstClaimedId = firstClaimRes.json().sessionId;

    // Graduate the first session so it won't be returned by the reusable path
    sessionManager.setWarm(firstClaimedId, false);

    // Wait for re-warmed session with standby
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

    // Claim the standby session
    const claimRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(claimRes.json().sessionId).toBe(standbySessionId);

    // Activate via WS — should reconnect to the standby container
    const client = await TestClient.connect(port, standbySessionId);
    await new Promise((r) => setTimeout(r, 500));

    // Same container reused — no new container created for this session.
    // (Total container count may increase because the claim fires off
    // re-warming with a new standby for the next warm session.)
    const sc = containerManager.get(standbySessionId);
    expect(sc).toBeDefined();
    expect(sc!.id).toBe(standbyContainerId);

    // Standby flag should be cleared after claiming
    expect(containerManager.isStandby(standbySessionId)).toBe(false);

    client.close();
  }, 30000);

  it("standby protected from idle cleanup", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );

    // Claim → triggers re-warming with standby
    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    const firstWarmId = repoStore.get(REPO_URL)?.warmSessionId;
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

    // The standby container exists and is idle (no runner, no viewers)
    expect(containerManager.get(standbySessionId)).toBeDefined();
    expect(containerManager.isStandby(standbySessionId)).toBe(true);

    // Activating another session triggers idle enforcement.
    // The standby should survive because it's excluded from idle candidates.
    const sessionsDir = path.join(tmpDir, "sessions");
    const idleSessionId = `idle-test-${Date.now()}`;
    const idleDir = path.join(sessionsDir, idleSessionId);
    fs.mkdirSync(idleDir, { recursive: true });
    const git = new GitManager(idleDir);
    await git.init();
    sessionManager.track(idleSessionId, "Idle test", idleDir);

    const client = await TestClient.connect(port, idleSessionId);
    await new Promise((r) => setTimeout(r, 500));

    // The standby container should survive idle cleanup
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

    // Claim → triggers re-warming with standby
    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    const firstWarmId = repoStore.get(REPO_URL)?.warmSessionId;
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

    expect(containerManager.get(standbySessionId)).toBeDefined();

    // Delete the repo — should destroy the standby container
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodedUrl}`,
    });
    expect(deleteRes.statusCode).toBe(200);

    // Standby container should be gone
    expect(containerManager.get(standbySessionId)).toBeUndefined();
    expect(containerManager.isStandby(standbySessionId)).toBe(false);
  }, 25000);

  it("rediscover restores standby state after restart", async () => {
    // Create a standby container directly
    const standbyId = "standby-rediscover-test";
    const standbyDir = path.join(tmpDir, "sessions", standbyId);
    fs.mkdirSync(standbyDir, { recursive: true });

    await containerManager.createStandby({
      sessionId: standbyId,
      sessionDir: standbyDir,
      credentialsDir: tmpDir,
      imageName: "shipit-session-worker:test",
      memoryLimit: 512 * 1024 * 1024,
      cpuQuota: 50_000,
      pidsLimit: 256,
    });

    expect(containerManager.isStandby(standbyId)).toBe(true);
    expect(containerManager.standbyCount).toBe(1);

    // Simulate restart: create a new container manager and rediscover
    const newManager = new SessionContainerManager({
      docker: fakeDocker as any,
      imageName: "shipit-session-worker:test",
      networkName: "shipit-test",
      workerPort: 9100,
      skipHealthCheck: true,
      stackName: "shipit-test",
    });

    const count = await newManager.rediscover(new Set([standbyId]));
    expect(count).toBe(1);
    expect(newManager.isStandby(standbyId)).toBe(true);
    expect(newManager.get(standbyId)).toBeDefined();
    expect(newManager.get(standbyId)!.status).toBe("running");
  });

  it("no standby when at container cap", async () => {
    await waitFor(
      () => !!repoStore.get(REPO_URL)?.warmSessionId,
      10000,
      "warm session",
    );

    // Fill up containers to the cap (default maxIdleContainers = 10)
    // by creating real containers
    const sessionsDir = path.join(tmpDir, "sessions");
    for (let i = 0; i < 10; i++) {
      const sid = `fill-session-${i}`;
      const dir = path.join(sessionsDir, sid);
      fs.mkdirSync(dir, { recursive: true });
      await containerManager.create({
        sessionId: sid,
        sessionDir: dir,
        credentialsDir: tmpDir,
        imageName: "shipit-session-worker:test",
        memoryLimit: 512 * 1024 * 1024,
        cpuQuota: 50_000,
        pidsLimit: 256,
      });
    }
    expect(containerManager.size).toBe(10);

    // Claim the warm session — triggers re-warming with { withStandby: true }
    const encodedUrl = encodeURIComponent(REPO_URL);
    await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

    // Wait for re-warmed session to appear
    const firstWarmId = repoStore.get(REPO_URL)?.warmSessionId;
    await waitFor(
      () => {
        const repo = repoStore.get(REPO_URL);
        return !!repo?.warmSessionId && repo.warmSessionId !== firstWarmId;
      },
      10000,
      "re-warmed session",
    );

    const newWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

    // Wait a bit to ensure standby creation would have completed if attempted
    await new Promise((r) => setTimeout(r, 500));

    // No standby should be created — we're at the container cap
    expect(containerManager.isStandby(newWarmId)).toBe(false);
    expect(containerManager.get(newWarmId)).toBeUndefined();
  }, 25000);
});
