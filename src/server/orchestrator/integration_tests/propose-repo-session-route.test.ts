import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { WsRepoSessionProposalCard, WsRepoSessionProposalUpdate } from "../../shared/types.js";
import { MAX_PROMPT_LEN } from "../../shared/repo-session-proposal-validation.js";

const TARGET_URL = "https://github.com/acme/api.git";

describe("Integration: propose-repo-session route", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let chatHistory: ChatHistoryManager;
  let sessionId: string;
  let writeAccess: { canWrite: boolean; reachable: boolean; reason?: string };
  let accessChecks: { owner: string; repo: string }[];
  let client: TestClient;
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    agents = [];
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propose-repo-session-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    chatHistory = new ChatHistoryManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    writeAccess = { canWrite: true, reachable: true };
    accessChecks = [];

    // A real manager with one method replaced: the route's only GitHub call.
    const githubAuthManager = new GitHubAuthManager(tmpDir, credentialStore);
    githubAuthManager.checkRepoWriteAccess = async (owner: string, repo: string) => {
      accessChecks.push({ owner, repo });
      return writeAccess;
    };

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        agents.push(agent);
        return agent as unknown as never;
      },
      credentialStore,
      databaseManager: dbManager,
      githubAuthManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;

    // The route needs an active runner, as `propose-actions` does.
    client = await TestClient.connect(port, sessionId);
    await client.receive();
  });

  afterEach(async () => {
    client?.close();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const propose = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/propose-repo-session`,
      payload,
    });

  const validProposal = {
    repo: "acme/api",
    title: "Add cursor pagination to /events",
    prompt: "Add cursor pagination to GET /events; acme/web depends on the contract.",
  };

  const start = (cardId: string) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/repo-session-proposals/${cardId}/start`,
    });

  const decline = (cardId: string) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/repo-session-proposals/${cardId}/decline`,
    });

  it("emits a card naming the repository, and persists it", async () => {
    const res = await propose(validProposal);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, repo: "acme/api", registered: false });

    const emitted = (await client.receiveType(
      "repo_session_proposal_card",
    )) as WsRepoSessionProposalCard;
    expect(emitted.card).toMatchObject({
      repo: "acme/api",
      repoUrl: TARGET_URL,
      registered: false,
      title: validProposal.title,
      prompt: validProposal.prompt,
    });
    expect(emitted.card.state).toBeUndefined();

    const persisted = chatHistory.findRepoSessionProposalCard(sessionId, emitted.card.cardId);
    expect(persisted).toMatchObject({ repo: "acme/api", title: validProposal.title });
  });

  it("reports a repository ShipIt already has as registered", async () => {
    repoStore.add(TARGET_URL);
    repoStore.setReady(TARGET_URL);

    const res = await propose(validProposal);
    expect(res.json()).toMatchObject({ registered: true });
  });

  it("refuses a repository the connected account cannot see", async () => {
    writeAccess = { canWrite: false, reachable: false, reason: "not visible to this account" };

    const res = await propose(validProposal);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("not visible to this account");
    expect(accessChecks).toEqual([{ owner: "acme", repo: "api" }]);
  });

  it("accepts a read-only repository, and marks the card so the user knows", async () => {
    writeAccess = { canWrite: false, reachable: true, reason: "read-only access" };

    const res = await propose(validProposal);
    expect(res.statusCode).toBe(200);
    const card = chatHistory.findRepoSessionProposalCard(
      sessionId,
      (res.json() as { cardId: string }).cardId,
    );
    expect(card).toMatchObject({ readOnly: true });
  });

  it("builds the clone URL from the repository identity, never from the text given", async () => {
    // `parseGitHubRemote` is unanchored: this reads as acme/api but points elsewhere.
    const res = await propose({
      ...validProposal,
      repo: "https://attacker.example/github.com/acme/api.git",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses the session's own repository however the remote is spelled", async () => {
    sessionManager.setRemoteUrl(sessionId, "git@github.com:Acme/API.git");

    const res = await propose(validProposal);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/already on/);
  });

  it("refuses the session's own repository, because that work belongs here", async () => {
    sessionManager.setRemoteUrl(sessionId, TARGET_URL);

    const res = await propose(validProposal);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/already on/);
    expect(accessChecks).toEqual([]);
  });

  it("refuses a name that is not a GitHub repository", async () => {
    const res = await propose({ ...validProposal, repo: "not a repo" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/owner\/repo/);
  });

  it("refuses an over-long prompt, naming the cap", async () => {
    const res = await propose({ ...validProposal, prompt: "x".repeat(MAX_PROMPT_LEN + 1) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain(String(MAX_PROMPT_LEN));
  });

  it("accepts a full clone URL as well as owner/repo shorthand", async () => {
    const res = await propose({ ...validProposal, repo: "https://github.com/acme/api" });
    expect(res.json()).toMatchObject({ repo: "acme/api" });
  });

  describe("starting the proposed session", () => {
    it("404s for a card that is not in this session's history", async () => {
      const res = await start("repo-session-nope");
      expect(res.statusCode).toBe(404);
    });

    it("records the failure on the card when the spawn cannot run", async () => {
      // Ready in the store, so the start reaches the spawn without cloning.
      repoStore.add(TARGET_URL);
      repoStore.setReady(TARGET_URL);
      const proposed = await propose(validProposal);
      const { cardId } = proposed.json() as { cardId: string };

      // Archiving the proposing session makes the spawn fail deterministically.
      sessionManager.archive(sessionId);

      const res = await start(cardId);
      expect(res.statusCode).toBe(400);

      const card = chatHistory.findRepoSessionProposalCard(sessionId, cardId);
      expect(card).toMatchObject({ state: "failed" });
      expect(card?.errorMessage).toMatch(/archived/i);
      expect(card?.startedSessionId).toBeUndefined();
    });

    it("retries a card left starting by a dead process, rather than stranding it", async () => {
      repoStore.add(TARGET_URL);
      repoStore.setReady(TARGET_URL);
      const proposed = await propose(validProposal);
      const { cardId } = proposed.json() as { cardId: string };
      // What a crash mid-start leaves behind: persisted `starting`, nothing running.
      chatHistory.updateRepoSessionProposalCard(sessionId, cardId, { state: "starting" });
      sessionManager.archive(sessionId);

      const res = await start(cardId);
      expect(res.statusCode).not.toBe(409);
      expect(chatHistory.findRepoSessionProposalCard(sessionId, cardId)).toMatchObject({
        state: "failed",
      });
    });

    it("refuses a second start once one has already succeeded", async () => {
      const proposed = await propose(validProposal);
      const { cardId } = proposed.json() as { cardId: string };
      chatHistory.updateRepoSessionProposalCard(sessionId, cardId, {
        state: "started",
        startedSessionId: "ses_other",
      });

      const res = await start(cardId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ startedSessionId: "ses_other" });
    });

    it("refuses to start a card the user declined", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      expect((await decline(cardId)).statusCode).toBe(200);

      const res = await start(cardId);
      expect(res.statusCode).toBe(409);
      expect(chatHistory.findRepoSessionProposalCard(sessionId, cardId)?.state).toBe("declined");
    });
  });

  // docs/303 req 10.
  describe("declining the proposed session", () => {
    it("records the decline on the card and tells the viewer", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };

      const res = await decline(cardId);
      expect(res.statusCode).toBe(200);
      const { declinedAt } = res.json() as { declinedAt: string };
      expect(declinedAt).toBeTruthy();

      const update = (await client.receiveType("repo_session_proposal_update")) as WsRepoSessionProposalUpdate;
      expect(update).toMatchObject({ cardId, state: "declined", declinedAt });
      expect(chatHistory.findRepoSessionProposalCard(sessionId, cardId)).toMatchObject({
        state: "declined",
        declinedAt,
      });
    });

    it("declines a card whose start failed, and clears the failure", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      chatHistory.updateRepoSessionProposalCard(sessionId, cardId, { state: "failed", errorMessage: "boom" });

      expect((await decline(cardId)).statusCode).toBe(200);
      const card = chatHistory.findRepoSessionProposalCard(sessionId, cardId);
      expect(card?.state).toBe("declined");
      expect(card?.errorMessage).toBeUndefined();
    });

    it("answers a second decline with the first one's time", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      const first = (await decline(cardId)).json() as { declinedAt: string };
      const second = await decline(cardId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ declinedAt: first.declinedAt });
    });

    it("refuses to decline a session that was already started", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      chatHistory.updateRepoSessionProposalCard(sessionId, cardId, {
        state: "started",
        startedSessionId: "ses_other",
      });

      const res = await decline(cardId);
      expect(res.statusCode).toBe(409);
      expect(chatHistory.findRepoSessionProposalCard(sessionId, cardId)?.state).toBe("started");
    });

    it("404s for a card that is not in this session's history", async () => {
      expect((await decline("repo-session-nope")).statusCode).toBe(404);
    });
  });

  // docs/303 req 11, through the WebSocket send path (`agent-execution.ts`).
  describe("telling the proposing agent", () => {
    /** Send a user turn, let the agent answer it, and return the prompt it was given. */
    async function answeredTurn(text: string): Promise<string> {
      const before = agents.length;
      client.send({ type: "send_message", text });
      const deadline = Date.now() + 5000;
      for (;;) {
        const agent = agents[before];
        if (agent?.runCalled) {
          agent.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
          agent.emit("done", 0);
          await new Promise((r) => setTimeout(r, 50));
          return agent.lastPrompt;
        }
        if (Date.now() > deadline) throw new Error(`no agent ran for ${JSON.stringify(text)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it("tells the next turn that the user declined, once", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      await decline(cardId);

      const first = await answeredTurn("What next?");
      expect(first).toContain("[ShipIt] Since your last turn, the user acted on a card you posted");
      expect(first).toContain(`acme/api "${validProposal.title}" — DECLINED by the user`);
      expect(first.endsWith("What next?")).toBe(true);

      const second = await answeredTurn("And now?");
      expect(second).not.toContain("[ShipIt] Since your last turn");
    });

    it("tells the next turn which session the user started", async () => {
      const { cardId } = (await propose(validProposal)).json() as { cardId: string };
      chatHistory.updateRepoSessionProposalCard(sessionId, cardId, {
        state: "started",
        startedSessionId: "ses_started",
      });

      const prompt = await answeredTurn("Carry on");
      expect(prompt).toContain("STARTED by the user, as session ses_started");
    });

    it("says nothing about a card the user has not acted on", async () => {
      await propose(validProposal);
      const prompt = await answeredTurn("Carry on");
      expect(prompt).not.toContain("[ShipIt] Since your last turn");
    });
  });
});
