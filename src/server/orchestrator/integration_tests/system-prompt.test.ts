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
import { AGENT_SYSTEM_INSTRUCTIONS, buildAgentSystemInstructions } from "../agent-instructions.js";

const CLAUDE_AGENT_INSTRUCTIONS = buildAgentSystemInstructions({ agentId: "claude" });
const CLAUDE_OPS_AGENT_INSTRUCTIONS = buildAgentSystemInstructions({ agentId: "claude", isOps: true });

describe("Integration: System prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sysprompt-"));
    sessionManager = new SessionManager(dbManager);
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
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
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("system prompt is passed to ClaudeProcess.run() when set", async () => {
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(`${CLAUDE_AGENT_INSTRUCTIONS}\n\nBe concise.`);

    client.close();
  });

  it("system prompt reaches a server-dispatched turn, not just a WS turn", async () => {
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "fix the failing check", activity: "Fixing CI…" },
    });
    expect(res.statusCode).toBe(200);

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastSystemPrompt).toBe(`${CLAUDE_AGENT_INSTRUCTIONS}\n\nBe concise.`);

    client.close();
  });

  it("system prompt contains only agent instructions when no user prompt file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(CLAUDE_AGENT_INSTRUCTIONS);
    expect(typeof AGENT_SYSTEM_INSTRUCTIONS).toBe("string");

    client.close();
  });

  // docs/014-system-prompt req 5 — an ops session takes the ops block instead of
  // the standard one, and takes nothing when the ops block is empty.
  it("an ops session gets the ops block, never the standard one", async () => {
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise.", systemPromptOps: "Report a timeline." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive();
    sessionManager.setKind(client.sessionId!, "ops");

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(
      `${CLAUDE_OPS_AGENT_INSTRUCTIONS}\n\nReport a timeline.`,
    );

    client.close();
  });

  it("an ops session with an empty ops block gets no user instructions at all", async () => {
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive();
    sessionManager.setKind(client.sessionId!, "ops");

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(CLAUDE_OPS_AGENT_INSTRUCTIONS);

    client.close();
  });

  it("a standard session keeps the standard block when an ops block is set", async () => {
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise.", systemPromptOps: "Report a timeline." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(`${CLAUDE_AGENT_INSTRUCTIONS}\n\nBe concise.`);

    client.close();
  });

  it("agent system instructions are omitted when disabled", async () => {
    const disableRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { agentSystemInstructionsEnabled: false },
    });
    expect(disableRes.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe("Be concise.");

    client.close();
  });
});
