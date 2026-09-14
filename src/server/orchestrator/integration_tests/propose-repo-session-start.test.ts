/**
 * docs/303 — the successful start, end to end.
 *
 * Everything this asserts is invisible to the route's error-path tests: the
 * target repository the new session is actually on, that it carries no parent
 * linkage, and that the first message is the proposed prompt and nothing else.
 */

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

  it("refuses to start the same proposal twice", { timeout: 30_000 }, async () => {
    const { cardId } = await proposeAndStart();

    const again = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/repo-session-proposals/${cardId}/start`,
    });
    expect(again.statusCode).toBe(409);
  });
});
