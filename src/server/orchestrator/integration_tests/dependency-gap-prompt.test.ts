import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import type { DependencyGap } from "../dependency-staleness.js";
import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "../credential-store.js";

describe("Integration: the dependency gap reaches the agent's prompt", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  let agents: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-gap-prompt-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    agents = [];

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
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  // Inject the public runner state without Docker or a workspace rewrite.
  function setGap(gap: DependencyGap | null): void {
    const runner = (app as unknown as {
      runnerRegistry: { get(id: string): { dependencyGap?: DependencyGap | null } | undefined };
    }).runnerRegistry.get(sessionId);
    if (!runner) throw new Error("no runner for the test session");
    runner.dependencyGap = gap;
  }

  it("prefixes the turn with a `[System]` instruction naming the install commands", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    setGap({
      reason: "not-content-keyed",
      rewrite: "rebase",
      commands: ["npm ci", "npm run build"],
    });

    const prompt = await sendUserTurn(client, () => agents, "The preview is 500ing");

    expect(prompt).toContain("[System]");
    expect(prompt).toContain("a sync onto the latest base");
    expect(prompt).toContain("npm ci");
    expect(prompt).toContain("npm run build");
    expect(prompt).toMatch(/before you treat[\s\S]*as a fault in the code/);
    expect(prompt.endsWith("The preview is 500ing")).toBe(true);

    client.close();
  });

  it("repeats on every turn until an install clears the gap", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    setGap({ reason: "install-failed", rewrite: "git-pull", commands: ["npm ci"] });

    const first = await sendUserTurn(client, () => agents, "one");
    const second = await sendUserTurn(client, () => agents, "two");
    expect(first).toContain("[System]");
    expect(second).toContain("[System]");
    expect(second).toContain("FAILED");

    setGap(null);
    const third = await sendUserTurn(client, () => agents, "three");
    expect(third).toBe("three");

    client.close();
  });

  it("says nothing at all to a healthy session", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const prompt = await sendUserTurn(client, () => agents, "Add a button");
    expect(prompt).toBe("Add a button");

    client.close();
  });

  it("holds the instruction back on /compact, and still delivers it after", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    setGap({ reason: "not-content-keyed", rewrite: "rollback", commands: ["./build.sh"] });

    const compact = await sendUserTurn(client, () => agents, "/compact");
    expect(compact).not.toContain("[System]");
    expect(compact).not.toContain("./build.sh");

    const next = await sendUserTurn(client, () => agents, "Now what?");
    expect(next).toContain("[System]");
    expect(next).toContain("./build.sh");

    client.close();
  });
});

async function sendUserTurn(
  client: TestClient,
  getAgents: () => FakeClaudeProcess[],
  text: string,
  timeoutMs = 5000,
): Promise<string> {
  const before = getAgents().length;
  client.send({ type: "send_message", text });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spawned = getAgents()[before];
    if (spawned?.runCalled) {
      spawned.emit("done", 0);
      await new Promise((r) => setTimeout(r, 50));
      return spawned.lastPrompt;
    }
    if (Date.now() > deadline) {
      throw new Error(`no agent spawned for user turn ${JSON.stringify(text)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
