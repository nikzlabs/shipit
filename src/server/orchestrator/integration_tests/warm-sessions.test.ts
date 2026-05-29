/**
 * Integration tests for warm session lifecycle:
 *   warm session creation → claim → graduation on first message.
 *
 * Tests warmSessionForRepo() background warming, claim-session endpoint
 * with a real warm session, and graduation logic in handleSendMessage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// docs/156 — `graduateSession` fires `generateSessionName` (real CLI, 15s
// timeout) on warm-graduation when the user's first message has no explicit
// title/branch. Mock to null so the placeholder slice sticks; the cross-
// flow AI naming logic is covered by `graduate-session.test.ts` with the
// CLI fully mocked.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
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

const REPO_URL = "https://github.com/owner/test-repo.git";

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
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-warm-session-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Prevent git from prompting for credentials (hangs in CI/test)
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    const credentialStore = createTestCredentialStore(tmpDir);

    // Seed the bare cache + matching local bare repo BEFORE buildApp.
    // warmSessionForRepo needs the cache dir to exist, and the helper's
    // `insteadOf` redirect keeps subsequent fetches off the network.
    seedRepoCacheWithLocalBare({ tmpDir, repoUrl: REPO_URL });

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
    // Close the app BEFORE the DB. `buildApp` schedules a setTimeout(0) for
    // startup re-warming (`scheduleStartupTasks`), which fires
    // `void warmSessionForRepo(url)` against `repoStore` / `sessionManager`.
    // `app.close()`'s onClose hook clears that timer; if the DB is dropped
    // first, any already-queued warm task hits the closed `better-sqlite3`
    // handle synchronously and surfaces as an unhandled rejection
    // (`The database connection is not open`).
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

      // Should contain the README.md from the cached repo
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

      // The claimed session should no longer be the warm session
      // (claim-session clears the old one and immediately re-warms a new one)
      expect(repoStore.get(REPO_URL)!.warmSessionId).not.toBe(warmSessionId);
    }, 15000);

    it("resets createdAt so workspace files don't appear modified-in-session", async () => {
      // Regression: warm sessions are inserted into the DB before the workspace
      // is cloned, so cloned files have mtime > original createdAt. Without a
      // reset on claim, the docs viewer's "Modified in this session" group
      // would list every file in the repo immediately after the user creates
      // a new session. claim-session must update createdAt so that all
      // workspace files have mtime <= createdAt.
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "warm session",
      );
      const warmSessionId = repoStore.get(REPO_URL)!.warmSessionId!;
      const warmCreatedAt = sessionManager.get(warmSessionId)!.createdAt;

      // Wait long enough that the post-claim ISO timestamp will differ from
      // the warming-time one, regardless of millisecond clock granularity.
      await new Promise((r) => setTimeout(r, 5));

      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });
      expect(res.statusCode).toBe(200);

      const claimedCreatedAt = sessionManager.get(warmSessionId)!.createdAt;
      expect(claimedCreatedAt > warmCreatedAt).toBe(true);

      // Files cloned during warming must have mtime <= the new createdAt;
      // otherwise the docs viewer would still flag them as modified.
      const workspaceDir = sessionManager.get(warmSessionId)!.workspaceDir!;
      const readmeMtime = fs.statSync(path.join(workspaceDir, "README.md")).mtime.toISOString();
      expect(readmeMtime <= claimedCreatedAt).toBe(true);
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

    it("rapid back-to-back claims each yield a usable session (docs/144 fix #1)", async () => {
      // Invariant: creating sessions in immediate succession — a user clicking
      // "New Session" repeatedly — must ALWAYS produce a usable session, even
      // though the next-session re-warm is now fire-and-forget (not awaited). It
      // may be slower under load (follow-ups take the waiting / slow-clone
      // path), but never fails or returns a half-built session.
      //
      // Note on distinctness: claims that are never graduated (no message sent)
      // intentionally COLLAPSE onto the same session via the reuse path —
      // that's how abandoned "New Session" navigations avoid leaking warm
      // sessions. So the invariant here is "every claim is usable", not "every
      // claim is unique"; replenishment-into-a-new-session is covered by the
      // "triggers re-warming after claim" test above and the graduate case below.
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );

      const encodedUrl = encodeURIComponent(REPO_URL);
      const N = 5;
      // Fire all claims concurrently — the per-repo serializeClaim chain plus
      // each claim's leading `await waitForWarmSession` must keep them correct.
      const responses = await Promise.all(
        Array.from({ length: N }, () =>
          app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` }),
        ),
      );

      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // Every claim returns a session id + dir...
        expect(body.sessionId).toBeTruthy();
        expect(body.sessionDir).toBeTruthy();

        // ...and that session is actually usable: the workspace exists on disk
        // with the repo's files (a real clone, not a half-built stub).
        const session = sessionManager.get(body.sessionId);
        expect(session?.workspaceDir).toBeTruthy();
        expect(fs.existsSync(session!.workspaceDir!)).toBe(true);
        expect(fs.existsSync(path.join(session!.workspaceDir!, "README.md"))).toBe(true);
      }
    }, 30000);

    it("claim → graduate → claim yields a fresh, distinct usable session (docs/144 fix #1)", async () => {
      // The complement to the collapse case: once a claimed session graduates
      // (the user sends a message), the next claim must NOT reuse it — it gets a
      // freshly replenished warm session. This confirms the fire-and-forget
      // re-warm actually repopulates the pool.
      await waitFor(
        () => !!repoStore.get(REPO_URL)?.warmSessionId,
        10000,
        "first warm session",
      );
      const encodedUrl = encodeURIComponent(REPO_URL);

      const claim1 = await app.inject({ method: "POST", url: `/api/repos/${encodedUrl}/claim-session` });
      expect(claim1.statusCode).toBe(200);
      const first = claim1.json().sessionId as string;

      // Graduate it (drop the warm flag) so the reuse path can't hand it back.
      const client = await TestClient.connect(port, first);
      await client.receive(); // preview_status
      client.send({ type: "send_message", text: "Build something", sessionId: first });
      await waitForClaude(() => lastClaude);
      expect(sessionManager.get(first)!.warm).not.toBe(true);
      lastClaude.finish("test-session");
      client.close();

      // Wait for the pool to replenish, then claim again.
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

      // Simulate a completed install (marker present)
      fs.mkdirSync(path.join(workspaceDir, ".shipit"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, ".shipit", ".install-done"), new Date().toISOString());
      expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(true);

      // Claim the session — refreshCloneToLatestMain fetches but HEAD hasn't changed
      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      // Install marker should still be present (no reinstall needed)
      expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(true);
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

      // Simulate a completed install
      fs.mkdirSync(path.join(workspaceDir, ".shipit"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, ".shipit", ".install-done"), new Date().toISOString());
      expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(true);

      // Point the clone's origin to the local shared repo so fetch works
      const repoDir = getRepoCacheDir(tmpDir, REPO_URL);
      execSync(`git remote set-url origin ${repoDir}`, {
        cwd: workspaceDir,
        stdio: "ignore",
      });

      // Add a new commit to the shared repo (simulating upstream changes)
      fs.writeFileSync(path.join(repoDir, "new-file.txt"), "new content\n");
      execSync("git add . && git commit -m 'new commit' --no-gpg-sign", {
        cwd: repoDir,
        stdio: "ignore",
      });

      // Claim the session — refreshCloneToLatestMain detects HEAD changed
      const encodedUrl = encodeURIComponent(REPO_URL);
      const res = await app.inject({
        method: "POST",
        url: `/api/repos/${encodedUrl}/claim-session`,
      });

      expect(res.statusCode).toBe(200);
      // Install marker should be cleared (reinstall needed)
      expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".install-done"))).toBe(false);
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
