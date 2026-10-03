import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import { RepoStore } from "../repo-store.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  waitFor,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

type AnyMsg = any;

const REPO_URL = "https://github.com/owner/repo";
const MARKER =
  `<!--shipit:release {"action":"propose","version":"0.5.2","bumpType":"patch","tag":"v0.5.2","prerelease":false}-->`;

// A turn the server starts (dispatch, a session created with its prompt, a wake-up) must
// raise the release card exactly like a turn the user starts from the composer.
describe("Integration: release marker in a turn started by the server", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let claudes: FakeClaudeProcess[];
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-release-dispatch-"));
    claudes = [];
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    const githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("test-token");
    const repoStore = new RepoStore(dbManager);
    repoStore.add(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
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

  /** The reported repo state: its workflow publishes authored notes, and the draft has content. */
  async function openReleaseSession(): Promise<{ client: TestClient; sessionId: string }> {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;
    sessionManager.setRemoteUrl(sessionId, REPO_URL);
    const workspace = path.join(tmpDir, "sessions", sessionId, "workspace");
    fs.mkdirSync(path.join(workspace, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".github", "workflows", "release.yml"),
      "steps:\n  - run: cat .release-notes/$TAG.md\n",
    );
    fs.writeFileSync(path.join(workspace, "RELEASE_NOTES.draft.md"), "## Highlights\n\n- A fix.\n");
    return { client, sessionId };
  }

  function answerWithMarker(claude: FakeClaudeProcess, agentSessionId: string): void {
    claude.initSession(agentSessionId);
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: `Proposing v0.5.2.\n\n${MARKER}` }] },
    });
    claude.finish(agentSessionId);
  }

  async function expectProposedCard(client: TestClient, sessionId: string): Promise<void> {
    const sent: AnyMsg = await client.receiveType("release_card", 5000);
    expect(sent).toMatchObject({
      sessionId,
      card: { phase: "proposed", version: "0.5.2", tag: "v0.5.2", notesDraftPath: "RELEASE_NOTES.draft.md" },
    });
    await waitFor(
      () => chatHistoryManager.load(sessionId).some((m) => m.releaseCard?.phase === "proposed"),
      "persisted release card",
    );
  }

  it("raises and persists the card for a turn started from the composer", async () => {
    const { client, sessionId } = await openReleaseSession();
    client.send({ type: "send_message", text: "cut a patch release", sessionId });
    answerWithMarker(await waitForClaude(latest), "agent-composer");

    await expectProposedCard(client, sessionId);
    client.close();
  });

  it("raises and persists the card for a dispatched turn", async () => {
    const { client, sessionId } = await openReleaseSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/agent/dispatch`,
      payload: { text: "cut a patch release" },
    });
    expect(res.statusCode).toBe(200);
    answerWithMarker(await waitForClaude(latest), "agent-dispatched");

    await expectProposedCard(client, sessionId);
    client.close();
  });
});
