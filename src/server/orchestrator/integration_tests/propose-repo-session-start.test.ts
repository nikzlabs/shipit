/**
 * docs/303 — the successful start, end to end.
 *
 * Everything this asserts is invisible to the route's error-path tests: the
 * target repository the new session is actually on, that it carries no parent
 * linkage, and that the first message is the proposed prompt and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
  waitFor,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import type { RepoSessionProposalCard } from "../../shared/types.js";

const TARGET_URL = "https://github.com/acme/api.git";
const PROMPT = "Add cursor pagination to GET /events. The caller lives in acme/web.";

describe("Integration: starting a proposed cross-repo session", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let chatHistory: ChatHistoryManager;
  let agents: FakeClaudeProcess[];
  let origGitTerminalPrompt: string | undefined;
  let client: TestClient;
  let parentId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "propose-repo-start-"));
    agents = [];
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    chatHistory = new ChatHistoryManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: TARGET_URL,
      seedFiles: { "README.md": "# acme/api\n" },
    });
    repoStore.add(TARGET_URL);
    repoStore.setReady(TARGET_URL);
    repoStore.setTrusted(TARGET_URL, true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        const cp = new FakeClaudeProcess();
        agents.push(cp);
        return cp as never;
      },
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Proposing session" },
    });
    parentId = (created.json() as { sessionId: string }).sessionId;

    client = await TestClient.connect(port, parentId);
    await client.receive();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    client?.close();
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  async function proposeAndStart(): Promise<{ cardId: string; startedSessionId: string }> {
    const proposed = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/propose-repo-session`,
      payload: { repo: "acme/api", title: "Cursor pagination", prompt: PROMPT },
    });
    expect(proposed.statusCode).toBe(200);
    const { cardId } = proposed.json() as { cardId: string };

    const started = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/repo-session-proposals/${cardId}/start`,
    });
    expect(started.statusCode).toBe(200);
    const { startedSessionId } = started.json() as { startedSessionId: string };
    return { cardId, startedSessionId };
  }

  it("starts an INDEPENDENT session on the target repository", { timeout: 30_000 }, async () => {
    const { startedSessionId } = await proposeAndStart();

    const child = sessionManager.get(startedSessionId);
    expect(child?.remoteUrl).toBe(TARGET_URL);
    expect(child?.title).toBe("Cursor pagination");
    expect(child?.branch).toMatch(/^shipit\//);
    // req 6 — no nesting: a nested session renders under the parent's repo group.
    expect(child?.parentSessionId).toBeUndefined();
    expect(child?.rootSessionId).toBeUndefined();
  });

  it("sends the proposed prompt as the first message, unmodified", { timeout: 30_000 }, async () => {
    // A role on the PROPOSING session is what a plain inherit would join onto the
    // prompt; without a real one stored, this test could not see the difference.
    credentialStore.setRole("critic", {
      name: "critic",
      prompt: "REVIEW ONLY. Never edit a file.",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "sub",
        modelId: "claude-sonnet-4-20250514",
      },
    });
    sessionManager.setRoleName(parentId, "critic");

    await proposeAndStart();

    await waitFor(() => agents.some((a) => a.runCalled), "target agent started");
    const dispatched = agents.find((a) => a.runCalled)!;
    // No role brief joined on: the card showed the user exactly this text.
    expect(dispatched.lastPrompt).toBe(PROMPT);
    expect(dispatched.lastPrompt).not.toContain("REVIEW ONLY");
  });

  it("records the started session on the card, so a reload can still open it", { timeout: 30_000 }, async () => {
    const { cardId, startedSessionId } = await proposeAndStart();

    expect(chatHistory.findRepoSessionProposalCard(parentId, cardId)).toMatchObject({
      state: "started",
      startedSessionId,
      repo: "acme/api",
    });
  });

  describe("an untrusted target (docs/243, docs/303 req 12)", () => {
    let cardId: string;
    const start = (payload?: Record<string, unknown>) => app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/repo-session-proposals/${cardId}/start`,
      ...(payload ? { payload } : {}),
    });
    const onTarget = () =>
      sessionManager.listAllIncludingWarm().filter((s) => s.remoteUrl === TARGET_URL && !s.warm);

    beforeEach(async () => {
      repoStore.setTrusted(TARGET_URL, false);
      const proposed = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/propose-repo-session`,
        payload: { repo: "acme/api", title: "Cursor pagination", prompt: PROMPT },
      });
      cardId = (proposed.json() as { cardId: string }).cardId;
    });

    it("refuses a start without the consent, before it creates a session there", { timeout: 30_000 }, async () => {
      const refused = await start();

      expect(refused.statusCode).toBe(403);
      const { error, code } = refused.json() as { error: string; code?: string };
      expect(code).toBe("repository_untrusted");
      expect(error).toContain("acme/api");
      // The card carries the Trust action, so the reason must not send the user elsewhere.
      expect(error).toContain("on this card");
      expect(error).not.toMatch(/open a session/i);
      expect(chatHistory.findRepoSessionProposalCard(parentId, cardId)).toMatchObject({
        state: "failed",
        errorMessage: error,
      });
      expect(onTarget()).toEqual([]);
      expect(repoStore.isTrusted(TARGET_URL)).toBe(false);
    });

    it("takes only a literal true as the consent", { timeout: 30_000 }, async () => {
      expect((await start({ trust: "true" })).statusCode).toBe(403);
      expect(repoStore.isTrusted(TARGET_URL)).toBe(false);
    });

    it("trusts the repository and starts the session on the click that carries the consent", { timeout: 30_000 }, async () => {
      // A refused attempt first: the card stays retryable, and the retry starts exactly one session.
      expect((await start()).statusCode).toBe(403);

      const started = await start({ trust: true });

      expect(started.statusCode).toBe(200);
      expect(repoStore.isTrusted(TARGET_URL)).toBe(true);
      expect(onTarget()).toHaveLength(1);
      const { startedSessionId } = started.json() as { startedSessionId: string };
      expect(chatHistory.findRepoSessionProposalCard(parentId, cardId)).toMatchObject({
        state: "started",
        startedSessionId,
      });
      await waitFor(() => agents.some((a) => a.runCalled), "target agent started");
      expect(agents.find((a) => a.runCalled)!.lastPrompt).toBe(PROMPT);
    });
  });

  it("refuses to start the same proposal twice", { timeout: 30_000 }, async () => {
    const { cardId } = await proposeAndStart();

    const again = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/repo-session-proposals/${cardId}/start`,
    });
    expect(again.statusCode).toBe(409);
  });

  // docs/303 plan, "A start that did not finish".
  describe("a start that never reported back", () => {
    let cardId: string;
    const post = (action: "start" | "decline") => app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/repo-session-proposals/${cardId}/${action}`,
    });
    const storedCard = () => chatHistory.findRepoSessionProposalCard(parentId, cardId)!;
    const onTarget = () =>
      sessionManager.listAllIncludingWarm().filter((s) => s.remoteUrl === TARGET_URL && !s.warm);

    /** Fails the chosen card write, the given number of times, and passes every other one through. */
    function failCardWrites(when: (patch: Partial<RepoSessionProposalCard>) => boolean, times = Infinity): void {
      const history = app.chatHistoryManager;
      const write = history.updateRepoSessionProposalCard.bind(history);
      let left = times;
      vi.spyOn(history, "updateRepoSessionProposalCard").mockImplementation((sid, cid, patch) => {
        if (left > 0 && when(patch)) {
          left -= 1;
          throw new Error("database is locked");
        }
        return write(sid, cid, patch);
      });
    }

    /** What a dead start leaves: a graduated session on the target, and a card still `starting`. */
    function leaveUnfinishedStart(firstMessage?: string): string {
      const id = "leftover";
      const workspaceDir = path.join(tmpDir, "sessions", id, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });
      sessionManager.track(id, "Cursor pagination", workspaceDir);
      sessionManager.setRemoteUrl(id, TARGET_URL);
      if (firstMessage) chatHistory.append(id, { role: "user", text: firstMessage });
      chatHistory.updateRepoSessionProposalCard(parentId, cardId, { state: "starting", pendingSessionId: id });
      return id;
    }

    beforeEach(async () => {
      const proposed = await app.inject({
        method: "POST",
        url: `/api/sessions/${parentId}/propose-repo-session`,
        payload: { repo: "acme/api", title: "Cursor pagination", prompt: PROMPT },
      });
      cardId = (proposed.json() as { cardId: string }).cardId;
    });

    it("records the allocated session on the card before its prompt is sent", { timeout: 30_000 }, async () => {
      const history = app.chatHistoryManager;
      const write = history.updateRepoSessionProposalCard.bind(history);
      const recorded: { pending: string; agentStarted: boolean }[] = [];
      vi.spyOn(history, "updateRepoSessionProposalCard").mockImplementation((sid, cid, patch) => {
        if (patch.pendingSessionId) {
          recorded.push({ pending: patch.pendingSessionId, agentStarted: agents.some((a) => a.runCalled) });
        }
        return write(sid, cid, patch);
      });

      const started = await post("start");

      const { startedSessionId } = started.json() as { startedSessionId: string };
      expect(recorded).toEqual([{ pending: startedSessionId, agentStarted: false }]);
      expect(storedCard()).toMatchObject({ state: "started", startedSessionId });
      expect(storedCard().pendingSessionId).toBeUndefined();
    });

    it("finds the session that has its prompt, and starts no second one", { timeout: 30_000 }, async () => {
      const leftover = leaveUnfinishedStart(PROMPT);

      const res = await post("start");

      expect(res.statusCode).toBe(200);
      expect((res.json() as { startedSessionId: string }).startedSessionId).toBe(leftover);
      expect(onTarget().map((s) => s.id)).toEqual([leftover]);
      expect(storedCard()).toMatchObject({ state: "started", startedSessionId: leftover });
      expect(agents.some((a) => a.runCalled)).toBe(false);
    });

    it.each([
      ["never received its prompt", undefined],
      ["someone used for other work", "Something else entirely."],
    ])("starts again, and leaves alone, a session that %s", { timeout: 30_000 }, async (_what, firstMessage) => {
      const leftover = leaveUnfinishedStart(firstMessage);

      const res = await post("start");

      expect(res.statusCode).toBe(200);
      const { startedSessionId } = res.json() as { startedSessionId: string };
      expect(startedSessionId).not.toBe(leftover);
      expect(sessionManager.get(leftover)).toBeDefined();
      expect(chatHistory.load(leftover)).toHaveLength(firstMessage ? 1 : 0);
      expect(storedCard()).toMatchObject({ state: "started", startedSessionId });
      await waitFor(() => agents.some((a) => a.runCalled), "target agent started");
      expect(agents.find((a) => a.runCalled)!.lastPrompt).toBe(PROMPT);
    });

    it.each([
      ["has not written its message yet", undefined],
      // The card's prompt can wait in the queue behind a turn that someone else started.
      ["is someone else's", "Something else entirely."],
    ])("starts no second session while a turn there %s", { timeout: 30_000 }, async (_what, firstMessage) => {
      const leftover = leaveUnfinishedStart(firstMessage);
      app.runnerRegistry.getOrCreate(leftover, sessionManager.get(leftover)!.workspaceDir!, "claude").running = true;

      for (const action of ["start", "decline"] as const) {
        const res = await post(action);
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toMatch(/already starting/);
      }

      expect(onTarget().map((s) => s.id)).toEqual([leftover]);
      expect(storedCard()).toMatchObject({ state: "starting", pendingSessionId: leftover });
    });

    it("reports the start when its result cannot be recorded, and the next click finds the session", { timeout: 30_000 }, async () => {
      failCardWrites((patch) => patch.state === "started", 1);

      const first = await post("start");

      expect(first.statusCode).toBe(200);
      const { startedSessionId } = first.json() as { startedSessionId: string };
      // Not `failed`: the session exists and has its prompt.
      expect(storedCard()).toMatchObject({ state: "starting", pendingSessionId: startedSessionId });
      await waitFor(
        () => chatHistory.load(startedSessionId).some((m) => m.role === "user"),
        "the prompt in the target's transcript",
      );

      const second = await post("start");

      expect(second.statusCode).toBe(200);
      expect((second.json() as { startedSessionId: string }).startedSessionId).toBe(startedSessionId);
      expect(onTarget().map((s) => s.id)).toEqual([startedSessionId]);
      expect(storedCard()).toMatchObject({ state: "started", startedSessionId });
    });

    it("starts nothing when the allocated session cannot be recorded", { timeout: 30_000 }, async () => {
      failCardWrites((patch) => typeof patch.pendingSessionId === "string");

      const res = await post("start");

      expect(res.statusCode).toBe(500);
      expect(onTarget()).toEqual([]);
      expect(agents.some((a) => a.runCalled)).toBe(false);
      expect(storedCard().state).toBe("failed");
    });

    it("starts nothing when the card left the history before the session could be recorded", { timeout: 30_000 }, async () => {
      const history = app.chatHistoryManager;
      const write = history.updateRepoSessionProposalCard.bind(history);
      vi.spyOn(history, "updateRepoSessionProposalCard").mockImplementation((sid, cid, patch) =>
        typeof patch.pendingSessionId === "string" ? false : write(sid, cid, patch));

      const res = await post("start");

      expect(res.statusCode).toBe(409);
      expect(onTarget()).toEqual([]);
      expect(agents.some((a) => a.runCalled)).toBe(false);
    });

    it("refuses a decline when the session has its prompt, because the work did start", { timeout: 30_000 }, async () => {
      const leftover = leaveUnfinishedStart(PROMPT);

      const res = await post("decline");

      expect(res.statusCode).toBe(409);
      expect((res.json() as { startedSessionId?: string }).startedSessionId).toBe(leftover);
      expect(storedCard()).toMatchObject({ state: "started", startedSessionId: leftover });
    });

    it("declines when the session never received its prompt, and leaves that session alone", { timeout: 30_000 }, async () => {
      const leftover = leaveUnfinishedStart();

      const res = await post("decline");

      expect(res.statusCode).toBe(200);
      expect(sessionManager.get(leftover)).toBeDefined();
      expect(storedCard().state).toBe("declined");
    });
  });
});
