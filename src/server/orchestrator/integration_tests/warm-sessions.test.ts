/**
 * Integration tests for warm session lifecycle:
 *   warm session creation → claim → graduation on first message.
 *
 * Tests warmSessionForRepo() background warming, claim-session endpoint
 * with a real warm session, and graduation logic in handleSendMessage.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { repoUrlToHash } from "../git-utils.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import type { AuthManager } from "../auth.js";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/test-repo.git";

/**
 * Create a git repo that simulates a cloned shared repo with at least
 * one commit on a default branch. Needed because warmSessionForRepo
 * and claim-session create worktrees from this shared repo.
 */
function createSharedRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  execSync("git add .", { cwd: repoDir, stdio: "ignore" });
  execSync('git commit -m "init" --no-gpg-sign', { cwd: repoDir, stdio: "ignore" });
  execSync("git remote add origin https://github.com/owner/test-repo.git", {
    cwd: repoDir,
    stdio: "ignore",
  });
  // Create origin/main ref that worktree can branch from
  execSync("git update-ref refs/remotes/origin/main HEAD", {
    cwd: repoDir,
    stdio: "ignore",
  });
}

function getSharedRepoDirForUrl(workspaceDir: string, repoUrl: string): string {
  return path.join(workspaceDir, "repos", repoUrlToHash(repoUrl));
}

/** Poll until a condition becomes true. */
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

// ---- warmSessionForRepo + claim lifecycle ----

describe("Integration: warm session lifecycle", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let port: number;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let lastClaude: FakeClaudeProcess;
  let origGitTerminalPrompt: string | undefined;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-warm-session-"));
    sessionManager = new SessionManager(path.join(tmpDir, "sessions.json"));
    repoStore = new RepoStore(path.join(tmpDir, "repos.json"));

    // Prevent git from prompting for credentials (hangs in CI/test)
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    const credentialStore = createTestCredentialStore(tmpDir);

    // Create the shared repo directory BEFORE buildApp — warmSessionForRepo
    // needs this directory to exist when creating worktrees.
    const repoDir = getSharedRepoDirForUrl(tmpDir, REPO_URL);
    createSharedRepo(repoDir);

    // Add the repo to the store BEFORE buildApp so the startup re-warming
    // (setTimeout(0)) picks it up and calls warmSessionForRepo.
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

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
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    await app.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("warmSessionForRepo", () => {
    it("creates a warm session on startup for a ready repo", async () => {
      // warmSessionForRepo runs via setTimeout(0) after buildApp returns.
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session created",
      );

      const repo = repoStore.get(REPO_URL)!;
      expect(repo.warmSessionId).toBeDefined();

      // The warm session should exist with warm=true and remoteUrl
      const session = sessionManager.get(repo.warmSessionId!);
      expect(session).toBeDefined();
      expect(session!.warm).toBe(true);
      expect(session!.remoteUrl).toBe(REPO_URL);

      // Warm sessions are invisible in the normal session list
      const visibleSessions = sessionManager.list();
      expect(visibleSessions.find((s) => s.id === repo.warmSessionId)).toBeUndefined();
    }, 15000);

    it("warm session has a worktree directory with repo files", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );

      const session = sessionManager.get(repoStore.get(REPO_URL)!.warmSessionId!)!;
      expect(session.workspaceDir).toBeDefined();

      const stat = await fsp.stat(session.workspaceDir!);
      expect(stat.isDirectory()).toBe(true);

      // Should contain the README.md from the shared repo
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

      // The repo's warmSessionId should be cleared after claiming
      expect(repoStore.get(REPO_URL)!.warmSessionId).toBeUndefined();
    }, 15000);

    it("triggers re-warming after claim", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );
      const firstWarmId = repoStore.get(REPO_URL)!.warmSessionId!;

      // Claim the warm session
      const encodedUrl = encodeURIComponent(REPO_URL);
      await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });

      // A new warm session should eventually be created
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
  });

  describe("graduation on first message", () => {
    it("graduates warm session when user sends first message", async () => {
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;

      // Claim the session
      const encodedUrl = encodeURIComponent(REPO_URL);
      const claimRes = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });
      expect(claimRes.statusCode).toBe(200);

      // Connect directly to the claimed session (auto-activates)
      const client = await TestClient.connect(port, warmSessionId);
      await client.receive(); // preview_status
      await new Promise((r) => setTimeout(r, 200));

      // Session should still be warm before sending a message
      expect(sessionManager.get(warmSessionId)!.warm).toBe(true);

      // Send the first message — triggers graduation
      client.send({ type: "send_message", text: "Build a landing page", sessionId: warmSessionId });
      await waitForClaude(() => lastClaude);

      // Graduation should have removed the warm flag
      const graduated = sessionManager.get(warmSessionId)!;
      expect(graduated.warm).not.toBe(true);

      // Session should now be visible in the session list
      const visibleSessions = sessionManager.list();
      expect(visibleSessions.find((s) => s.id === warmSessionId)).toBeDefined();

      // Session should be visible via HTTP bootstrap (session_list is SSE-only)
      const bootstrapRes = await app.inject({ method: "GET", url: "/api/bootstrap" });
      const listed = bootstrapRes.json().sessions as any[];
      expect(listed.find((s: any) => s.id === warmSessionId)).toBeDefined();

      lastClaude.finish("test-session");
      client.close();
    }, 15000);

    it("does not trigger graduation for non-warm sessions", async () => {
      // Create a normal (non-warm) session
      const sessionDir = path.join(tmpDir, "sessions", "normal-session");
      fs.mkdirSync(sessionDir, { recursive: true });
      const git = new GitManager(sessionDir);
      await git.init();
      sessionManager.track("normal-session", "Normal session", sessionDir);

      const client = await TestClient.connect(port, "normal-session");
      await client.receive(); // preview_status
      await new Promise((r) => setTimeout(r, 200));

      client.send({ type: "send_message", text: "Hello", sessionId: "normal-session" });
      await waitForClaude(() => lastClaude);

      // Session should remain non-warm (no graduation side effects)
      const session = sessionManager.get("normal-session");
      expect(session!.warm).toBeUndefined();

      lastClaude.finish("test-session");
      client.close();
    });
  });
});
