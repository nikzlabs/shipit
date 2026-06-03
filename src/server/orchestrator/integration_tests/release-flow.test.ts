import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

/**
 * docs/171 Phase 1 — confirm → tag → publish, end to end. Drives the WS turn
 * loop with a fake agent that emits release markers, and a fake GitHub auth
 * manager that serves the gate status + the published Release. Asserts the
 * orchestrator's release flow advances the inline card from `proposed` →
 * `released`.
 */
describe("Integration: release flow — propose → tag → publish", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let lastClaude: FakeClaudeProcess | null;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-release-"));
    lastClaude = null;
    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token");

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        lastClaude = cp;
        return cp as any;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    app.releaseStatusPoller?.destroy();
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function createSession(client: TestClient): Promise<string> {
    client.send({ type: "send_message", text: "hello" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("agent-1");
    claude.finish("agent-1");
    let sessionId = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const msg = await client.receive(200);
        if (msg.type === "session_started") sessionId = (msg as any).session.id;
        if (msg.type === "git_committed") break;
      } catch {
        break;
      }
    }
    return sessionId;
  }

  /** Run one turn whose assistant text carries the given marker payload. */
  async function runTurnWithText(client: TestClient, userText: string, assistantText: string): Promise<void> {
    lastClaude = null;
    client.send({ type: "send_message", text: userText });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("agent-1");
    claude.emit("event", {
      type: "assistant",
      session_id: "agent-1",
      message: { content: [{ type: "text", text: assistantText }] },
    });
    claude.finish("agent-1");
  }

  async function waitForPhase(sessionId: string, phase: string, ms = 4000): Promise<string | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const card = app.releaseStatusPoller?.getStatus(sessionId);
      if (card?.phase === phase) return card.phase;
      await new Promise((r) => setTimeout(r, 25));
    }
    return app.releaseStatusPoller?.getStatus(sessionId)?.phase;
  }

  it("advances the card from proposed to released across two turns", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const sessionId = await createSession(client);
    expect(sessionId).toBeTruthy();
    // Releases require a remote — wire one onto the session.
    sessionManager.setRemoteUrl(sessionId, "https://github.com/owner/repo");

    // Turn 1: the agent proposes. The card should land in `proposed`.
    await runTurnWithText(
      client,
      "cut a 0.3.0 release",
      `I'll cut version 0.3.0.
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: x"}-->`,
    );

    const proposedPhase = await waitForPhase(sessionId, "proposed");
    expect(proposedPhase).toBe("proposed");
    const proposed = app.releaseStatusPoller!.getStatus(sessionId)!;
    expect(proposed.version).toBe("0.3.0");
    expect(proposed.tag).toBe("v0.3.0");
    expect(proposed.bumpType).toBe("minor");

    // The gate passes and the repo's CI publishes the Release.
    githubAuthManager.setCheckStatus({ state: "success", total: 2, passed: 2, failed: 0, pending: 0 });
    githubAuthManager.setReleaseByTag({
      name: "v0.3.0",
      body: "## Features\n- x",
      htmlUrl: "https://github.com/owner/repo/releases/tag/v0.3.0",
      prerelease: false,
      publishedAt: "2026-06-03T00:00:00Z",
      tagName: "v0.3.0",
    });

    // Turn 2: the user confirms; the agent tags + pushes and emits `tagged`.
    await runTurnWithText(
      client,
      "yes, ship it",
      `Tagged and pushed.
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"abc123"}-->`,
    );

    const releasedPhase = await waitForPhase(sessionId, "released");
    expect(releasedPhase).toBe("released");
    const released = app.releaseStatusPoller!.getStatus(sessionId)!;
    expect(released.release?.htmlUrl).toContain("releases/tag/v0.3.0");
    expect(released.notes).toContain("Features");

    client.close();
  });

  it("shows an already-released card when the tag already exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    const sessionId = await createSession(client);
    sessionManager.setRemoteUrl(sessionId, "https://github.com/owner/repo");

    githubAuthManager.setReleaseByTag({
      name: "v1.0.0",
      body: "old notes",
      htmlUrl: "https://github.com/owner/repo/releases/tag/v1.0.0",
      prerelease: false,
      publishedAt: "2026-01-01T00:00:00Z",
      tagName: "v1.0.0",
    });

    await runTurnWithText(
      client,
      "release 1.0.0",
      `That tag already exists.
<!--shipit:release {"action":"already-released","tag":"v1.0.0","version":"1.0.0"}-->`,
    );

    // already-released resolves to a terminal released card flagged as such.
    const phase = await waitForPhase(sessionId, "released");
    expect(phase).toBe("released");
    expect(app.releaseStatusPoller!.getStatus(sessionId)?.alreadyReleased).toBe(true);

    client.close();
  });
});
