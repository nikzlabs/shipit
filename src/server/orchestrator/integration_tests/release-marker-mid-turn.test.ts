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
import type { CredentialStore } from "../credential-store.js";
import { RepoStore } from "../repo-store.js";

type AnyMsg = any;

const REPO_URL = "https://github.com/owner/repo";
const MARKER =
  `<!--shipit:release {"action":"propose","version":"0.5.1","bumpType":"patch","tag":"v0.5.1","prerelease":false}-->`;

// A propose marker must raise the card whatever else the turn did after it.
describe("Integration: release marker in a turn that is followed by more work", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let claudes: FakeClaudeProcess[];
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-release-midturn-"));
    claudes = [];
    credentialStore = createTestCredentialStore(tmpDir);
    sessionManager = new SessionManager(dbManager);
    const githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token");
    const repoStore = new RepoStore(dbManager);
    repoStore.add(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        claudes.push(cp);
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

  const latest = () => claudes[claudes.length - 1] ?? null;

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 60): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(2000);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  async function waitForProposal(sessionId: string, ms = 4000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const card = app.releaseStatusPoller?.getStatus(sessionId);
      if (card) return card;
      await new Promise((r) => setTimeout(r, 25));
    }
    return app.releaseStatusPoller?.getStatus(sessionId);
  }

  async function startSession(client: TestClient, agentSessionId: string): Promise<{ sessionId: string; claude: FakeClaudeProcess }> {
    const sessionId = client.sessionId;
    client.send({ type: "send_message", text: "cut a patch release", sessionId });
    const claude = await waitForClaude(latest);
    claude.initSession(agentSessionId);
    sessionManager.setRemoteUrl(sessionId, REPO_URL);
    return { sessionId, claude };
  }

  function markerThenToolCall(claude: FakeClaudeProcess): void {
    claude.emit("event", {
      type: "assistant",
      message: { content: [
        { type: "text", text: `Proposing v0.5.1.\n${MARKER}` },
        { type: "tool_use", id: "status-1", name: "mcp__shipit__session_status", input: {} },
      ] },
    });
    claude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "status-1", content: "ok" }] },
    });
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Confirm on the card to publish." }] },
    });
  }

  it("raises the card when the marker's text block is followed by a tool call and more text", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { sessionId, claude } = await startSession(client, "agent-plain");

    markerThenToolCall(claude);
    claude.finish("agent-plain");

    const card = await waitForProposal(sessionId);
    expect(card).toMatchObject({ phase: "proposed", version: "0.5.1", tag: "v0.5.1" });
    client.close();
  });

  it("raises the card when a message the user sent mid-turn is queued behind the marker turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const { sessionId, claude } = await startSession(client, "agent-queued");

    client.send({ type: "send_message", text: "Maybe 0.5.1?", sessionId });
    await drainUntil(client, (m) => m.type === "message_queued");

    markerThenToolCall(claude);
    // One-shot: the drain runs at the result and the release flow at `done`, so let the
    // queued turn start in between.
    claude.emit("event", { type: "result", subtype: "success", session_id: "agent-queued" });
    const successor = await waitForClaude(() => (claudes.length > 1 ? latest() : null));
    expect(successor.lastPrompt).toContain("Maybe 0.5.1?");
    claude.emit("done", 0);

    const card = await waitForProposal(sessionId);
    expect(card).toMatchObject({ phase: "proposed", version: "0.5.1" });
    client.close();
  });

  describe("with live steering", () => {
    beforeEach(() => {
      credentialStore.setLiveSteering(true);
    });

    it("raises the card when the user steers mid-turn and the agent answers with the marker", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      const { sessionId, claude } = await startSession(client, "agent-steer");
      expect(claude.lastUseStreaming).toBe(true);

      claude.emit("event", {
        type: "assistant",
        message: { content: [
          { type: "text", text: "Writing the draft notes." },
          { type: "tool_use", id: "write-1", name: "Write", input: {} },
        ] },
      });
      client.send({ type: "send_message", text: "Maybe 0.5.1?", sessionId });
      await drainUntil(client, (m) => m.type === "message_steered");
      claude.emit("event", {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "write-1", content: "ok" }] },
      });

      markerThenToolCall(claude);
      claude.emit("event", { type: "result", subtype: "success", session_id: "agent-steer" });

      const card = await waitForProposal(sessionId);
      expect(card).toMatchObject({ phase: "proposed", version: "0.5.1" });
      client.close();
    });

    // A steer that lands as the turn wraps up is re-queued (docs/140), and the drain
    // starts its turn before the finished turn's release flow runs.
    it("raises the card when a steer sent as the turn ends is re-queued as the next turn", async () => {
      const client = await TestClient.connect(port);
      await client.receive();
      const { sessionId, claude } = await startSession(client, "agent-gap");

      markerThenToolCall(claude);
      client.send({ type: "send_message", text: "Maybe 0.5.1?", sessionId });
      await drainUntil(client, (m) => m.type === "message_steered");
      claude.emit("event", { type: "result", subtype: "success", session_id: "agent-gap" });
      await drainUntil(client, (m) => m.type === "message_queued");

      const card = await waitForProposal(sessionId);
      expect(card).toMatchObject({ phase: "proposed", version: "0.5.1" });
      client.close();
    });
  });
});
