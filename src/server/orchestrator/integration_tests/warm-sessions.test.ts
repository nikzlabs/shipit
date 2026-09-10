import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent session naming from starting a provider CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
}));

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
  getRepoCacheDir,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  INSTALL_MARKER_FILE,
  sessionSharedStateDir,
  sessionStateDirForWorkspace,
} from "../session-state-dir.js";

const REPO_URL = "https://github.com/owner/test-repo.git";

function installMarkerPath(workspaceDir: string): string {
  return path.join(
    sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir)),
    INSTALL_MARKER_FILE,
  );
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

describe("Integration: warm session lifecycle", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let lastClaude: FakeClaudeProcess;
  let origGitTerminalPrompt: string | undefined;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-warm-session-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    const credentialStore = createTestCredentialStore(tmpDir);

    // Seed before startup warming; the helper redirects fetches to a local repo.
    seedRepoCacheWithLocalBare({ tmpDir, repoUrl: REPO_URL });

    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      credentialStore,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    // Close the app before the DB to cancel startup warming that uses the DB.
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("warmSessionForRepo", () => {
    it("creates a warm session on startup for a ready repo", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session created",
      );

      const repo = repoStore.get(REPO_URL)!;
      expect(repo.warmSessionId).toBeDefined();

      const session = sessionManager.get(repo.warmSessionId!);
      expect(session).toBeDefined();
      expect(session!.warm).toBe(true);
      expect(session!.remoteUrl).toBe(REPO_URL);

      const visibleSessions = sessionManager.list();
      expect(visibleSessions.find((s) => s.id === repo.warmSessionId)).toBeUndefined();
    }, 15000);

    it("warm session has a cloned directory with repo files", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );

      const session = sessionManager.get(repoStore.get(REPO_URL)!.warmSessionId!)!;
      expect(session.workspaceDir).toBeDefined();

      const stat = await fsp.stat(session.workspaceDir!);
      expect(stat.isDirectory()).toBe(true);

      const readme = path.join(session.workspaceDir!, "README.md");
      const content = await fsp.readFile(readme, "utf-8");
      expect(content).toBe("# test\n");
    }, 15000);
  });

  describe("claim-session with warm session", () => {
    it("claims the pre-created warm session", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;

      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBe(warmSessionId);
      expect(body.sessionDir).toBeDefined();

      expect(repoStore.get(REPO_URL)!.warmSessionId).not.toBe(warmSessionId);
    }, 15000);

    it("resets createdAt so workspace files don't appear modified-in-session", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;
      const warmCreatedAt = sessionManager.get(warmSessionId)!.createdAt;

      // Separate timestamps across millisecond clock ticks.
      await new Promise((r) => setTimeout(r, 5));

      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });
      expect(res.statusCode).toBe(200);

      const claimedCreatedAt = sessionManager.get(warmSessionId)!.createdAt;
      expect(claimedCreatedAt > warmCreatedAt).toBe(true);

      const workspaceDir = sessionManager.get(warmSessionId)!.workspaceDir!;
      const readmeMtime = fs.statSync(path.join(workspaceDir, "README.md")).mtime.toISOString();
      expect(readmeMtime <= claimedCreatedAt).toBe(true);
    }, 15000);

    // Test mode disables the prefetcher; its missing-cache path is tested separately.
    it("still claims when the bare cache was reclaimed underneath it", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );

      const cacheDir = getRepoCacheDir(tmpDir, REPO_URL);
      fs.rmSync(cacheDir, { recursive: true, force: true });
      expect(fs.existsSync(cacheDir)).toBe(false);

      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodeURIComponent(REPO_URL)}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBeTruthy();
      expect(fs.existsSync(path.join(body.workspaceDir, ".git"))).toBe(true);
    }, 20000);

    it("stamps the repo's lastUsedAt on claim, not only on graduation", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const before = repoStore.get(REPO_URL)!.lastUsedAt;
      await new Promise((r) => setTimeout(r, 5));

      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodeURIComponent(REPO_URL)}/claim-session`,
      });
      expect(res.statusCode).toBe(200);

      expect(repoStore.get(REPO_URL)!.lastUsedAt > before).toBe(true);
    }, 15000);

    it("triggers re-warming after claim", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
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
        "second warm session",
      );

      const newWarmId = repoStore.get(REPO_URL)!.warmSessionId!;
      expect(newWarmId).not.toBe(firstWarmId);

      const newSession = sessionManager.get(newWarmId);
      expect(newSession).toBeDefined();
      expect(newSession!.warm).toBe(true);
    }, 25000);

    it("rapid back-to-back claims each yield a usable session (docs/144 fix #1)", async () => {
      // Claims can reuse an ungraduated draft, so IDs need not be unique here.
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );

      const encodedUrl = encodeURIComponent(REPO_URL);
      const N = 5;
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` }),
        ),
      );

      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.sessionId).toBeTruthy();
        expect(body.sessionDir).toBeTruthy();

        const session = sessionManager.get(body.sessionId);
        expect(session?.workspaceDir).toBeTruthy();
        expect(fs.existsSync(session!.workspaceDir!)).toBe(true);
        expect(fs.existsSync(path.join(session!.workspaceDir!, "README.md"))).toBe(true);
      }
    }, 30000);

    it("does not recycle an abandoned draft that carries a network mode (docs/285 req 8)", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );
      const encodedUrl = encodeURIComponent(REPO_URL);

      const first = (await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      })).json();
      await app.inject({
        method: "PUT",
        url: `/api/egress/session/${first.sessionId}`,
        payload: { override: false },
      });

      const second = (await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      })).json();
      expect(second.sessionId).not.toBe(first.sessionId);

      const fresh = (await app.inject({
        method: "GET",
        url: `/api/egress/session/${second.sessionId}`,
      })).json();
      expect(fresh.override).toBeNull();
      const abandoned = (await app.inject({
        method: "GET",
        url: `/api/egress/session/${first.sessionId}`,
      })).json();
      expect(abandoned.override).toBe(false);
    }, 30000);

    it("claim → graduate → claim yields a fresh, distinct usable session (docs/144 fix #1)", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );
      const encodedUrl = encodeURIComponent(REPO_URL);

      const claim1 = await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });
      expect(claim1.statusCode).toBe(200);
      const first = claim1.json().sessionId as string;

      const client = await TestClient.connect(port, first);
      await client.receive();
      client.send({ type: "send_message", text: "Build something", sessionId: first });
      await waitForClaude(() => lastClaude);
      expect(sessionManager.get(first)!.warm).not.toBe(true);
      lastClaude.finish("test-session");
      client.close();

      await waitFor(
        () => {
          const w = repoStore.get(REPO_URL)?.warmSessionId;
          return !!w && w !== first;
        },
        10000,
        "replenished warm session",
      );
      const claim2 = await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });
      expect(claim2.statusCode).toBe(200);
      const second = claim2.json().sessionId as string;

      expect(second).not.toBe(first);
      const session = sessionManager.get(second);
      expect(fs.existsSync(path.join(session!.workspaceDir!, "README.md"))).toBe(true);
    }, 30000);
  });

  describe("claim-session skips reinstall when HEAD unchanged", () => {
    it("preserves install marker when no new commits were fetched", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;
      const warmSession = sessionManager.get(warmSessionId)!;
      const workspaceDir = warmSession.workspaceDir!;

      const marker = installMarkerPath(workspaceDir);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
      expect(fs.existsSync(marker)).toBe(true);

      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(marker)).toBe(true);
    }, 15000);

    it("clears install marker when HEAD changed", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;
      const warmSession = sessionManager.get(warmSessionId)!;
      const workspaceDir = warmSession.workspaceDir!;

      const marker = installMarkerPath(workspaceDir);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString());
      expect(fs.existsSync(marker)).toBe(true);

      const repoDir = getRepoCacheDir(tmpDir, REPO_URL);
      execSync(`git remote set-url origin ${repoDir}`, {
        cwd: workspaceDir,
        stdio: "ignore",
      });

      fs.writeFileSync(path.join(repoDir, "new-file.txt"), "new content\n");
      execSync("git add . && git commit -m 'new commit' --no-gpg-sign", {
        cwd: repoDir,
        stdio: "ignore",
      });

      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(marker)).toBe(false);
    }, 15000);
  });

  describe("graduation on first message", () => {
    it("graduates warm session when user sends first message", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;

      const encodedUrl = encodeURIComponent(REPO_URL);
      const claimRes = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });
      expect(claimRes.statusCode).toBe(200);

      const client = await TestClient.connect(port, warmSessionId);
      await client.receive();
      await new Promise((r) => setTimeout(r, 200));

      expect(sessionManager.get(warmSessionId)!.warm).toBe(true);

      client.send({ type: "send_message", text: "Build a landing page", sessionId: warmSessionId });
      await waitForClaude(() => lastClaude);

      const graduated = sessionManager.get(warmSessionId)!;
      expect(graduated.warm).not.toBe(true);

      const visibleSessions = sessionManager.list();
      expect(visibleSessions.find((s) => s.id === warmSessionId)).toBeDefined();

      const bootstrapRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const listed = bootstrapRes.json().sessions as any[];
      expect(listed.find((s: any) => s.id === warmSessionId)).toBeDefined();

      lastClaude.finish("test-session");
      client.close();
    }, 15000);

    it("does not trigger graduation for non-warm sessions", async () => {
      const sessionDir = path.join(tmpDir, "sessions", "normal-session");
      fs.mkdirSync(sessionDir, { recursive: true });
      const git = new GitManager(sessionDir);
      await git.init();
      sessionManager.track("normal-session", "Normal session", sessionDir);

      const client = await TestClient.connect(port, "normal-session");
      await client.receive();
      await new Promise((r) => setTimeout(r, 200));

      client.send({ type: "send_message", text: "Hello", sessionId: "normal-session" });
      await waitForClaude(() => lastClaude);

      const session = sessionManager.get("normal-session");
      expect(session!.warm).toBeUndefined();

      lastClaude.finish("test-session");
      client.close();
    });
  });
});
