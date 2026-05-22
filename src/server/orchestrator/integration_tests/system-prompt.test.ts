import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
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

// docs/117 Phase 2 — `agent-execution.ts` now passes `currentAgent.agentId`
// into `buildAgentSystemInstructions`, so the runtime prompt includes the
// per-agent "Parallel sessions" section. FakeClaudeProcess reports
// `agentId === "claude"`, so the expected baseline for these tests is the
// Claude-flavoured rendering.
const CLAUDE_AGENT_INSTRUCTIONS = buildAgentSystemInstructions({ agentId: "claude" });

describe("Integration: System prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sysprompt-"));
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
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
    // Set a system prompt via HTTP
    const settingsRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });
    expect(settingsRes.statusCode).toBe(200);

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send a message to Claude
    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(`${CLAUDE_AGENT_INSTRUCTIONS}\n\nBe concise.`);

    client.close();
  });

  it("system prompt contains only agent instructions when no user prompt file exists", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe(CLAUDE_AGENT_INSTRUCTIONS);
    // Sanity: keep AGENT_SYSTEM_INSTRUCTIONS referenced so the no-options
    // baseline stays imported (the Settings UI snapshot still uses it).
    expect(typeof AGENT_SYSTEM_INSTRUCTIONS).toBe("string");

    client.close();
  });

  it("agent system instructions are omitted when disabled", async () => {
    // Disable agent system instructions
    const disableRes = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { agentSystemInstructionsEnabled: false },
    });
    expect(disableRes.statusCode).toBe(200);

    // Set a user system prompt
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { systemPrompt: "Be concise." },
    });

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSystemPrompt).toBe("Be concise.");

    client.close();
  });
});
