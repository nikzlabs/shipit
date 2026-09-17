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
import type { WsServerMessage } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const NOTICE = "[System] Your previous pull request (#482) was merged into main.";

/**
 * docs/299 — the CLI reads its own command only when the message is exactly the
 * command: measured, a notice before it means no command is seen at all, and
 * context after it lands inside the command's argument.
 */
describe("Integration: a command invocation reaches the harness alone (docs/299)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessions: SessionManager;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as unknown as FakeClaudeProcess;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-native-command-"));
    credentialStore = createTestCredentialStore(tmpDir);
    sessions = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: sessions,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function receiveError(client: TestClient, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await client.receive(Math.max(1, deadline - Date.now())) as WsServerMessage;
      if (msg.type === "error") return msg.message;
    }
  }

  it("sends a skill invocation alone, leaving the pending notice for the next turn", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "/code-review high" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe("/code-review high");
    expect(sessions.consumePendingAgentNotice(client.sessionId)).toBe(NOTICE);
    client.close();
  });

  it("leaves a role's brief untaken by a command turn, and delivers it on the next one", async () => {
    credentialStore.setRole("Reviewer", {
      name: "Reviewer",
      prompt: "Read everything before judging.",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
      },
    });
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setRoleName(client.sessionId, "Reviewer");

    client.send({ type: "send_message", text: "/code-review" });
    const commandTurn = await waitForClaude(() => lastClaude);
    expect(commandTurn.lastPrompt).toBe("/code-review");
    // The take records its origin; an untaken brief still has none.
    expect(sessions.get(client.sessionId)?.originRoleName).toBeUndefined();
    commandTurn.finish("role-thread");

    client.send({ type: "send_message", text: "review the auth module" });
    const ordinary = await waitForClaude(() => lastClaude, commandTurn);
    expect(ordinary.lastPrompt).toContain("Read everything before judging.");
    expect(sessions.get(client.sessionId)?.originRoleName).toBe("Reviewer");
    client.close();
  });

  it("still prefixes the notice onto an ordinary message", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "review the auth module" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe(`${NOTICE}\n\nreview the auth module`);
    expect(sessions.consumePendingAgentNotice(client.sessionId)).toBeUndefined();
    client.close();
  });

  it("does not treat a path-first message as a command", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "/tmp/foo.ts is broken, fix it" });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe(`${NOTICE}\n\n/tmp/foo.ts is broken, fix it`);
    client.close();
  });

  it("refuses a command that carries attachments instead of folding them into its argument", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const a = 1;\n");

    client.send({ type: "send_message", text: "/code-review", files: [{ path: "a.ts" }] });

    // An `error` rather than a notice: the browser already showed an optimistic
    // bubble and a spinner for this send, and only the error handler settles them.
    expect(await receiveError(client)).toMatch(/cannot carry attachments/);
    expect(lastClaude).toBeNull();
    client.close();
  });

  // A user-typed `/compact` is one of these commands: the Claude adapter never reads
  // the compact run-param, so the CLI only compacts if the prompt is the command.
  it("sends /compact alone and still marks the turn as a compaction", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);
    sessions.setRoleName(client.sessionId, "Reviewer");

    // Dictated: the dictation block rides every prompt, so it shows whether
    // anything was added, without depending on a notice compaction already skips.
    client.send({ type: "send_message", text: "/compact focus on the auth work", dictated: true });
    const claude = await waitForClaude(() => lastClaude);

    expect(claude.lastPrompt).toBe("/compact focus on the auth work");
    expect(claude.lastCompact).toBe(true);
    expect(sessions.get(client.sessionId)?.originRoleName).toBeUndefined();
    client.close();
  });

  // The command turn must not eat the notice, and the ordinary turn after it must
  // deliver it exactly once — which neither turn alone can show.
  it("delivers a skipped notice on the next ordinary turn, once", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "/code-review" });
    const commandTurn = await waitForClaude(() => lastClaude);
    expect(commandTurn.lastPrompt).toBe("/code-review");
    commandTurn.finish("native-command-thread");

    client.send({ type: "send_message", text: "now review the auth module" });
    const ordinary = await waitForClaude(() => lastClaude, commandTurn);
    expect(ordinary.lastPrompt).toBe(`${NOTICE}\n\nnow review the auth module`);
    ordinary.finish("native-command-thread");

    client.send({ type: "send_message", text: "and the routes" });
    const third = await waitForClaude(() => lastClaude, ordinary);
    expect(third.lastPrompt).toBe("and the routes");
    client.close();
  });

  // req 4 — a message sent while a turn runs is assembled when the queue drains,
  // from the queued text rather than from the decision the first turn made.
  it("drains a command queued behind a running turn, still alone", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessions.setPendingAgentNotice(client.sessionId, NOTICE);

    client.send({ type: "send_message", text: "start the work" });
    const first = await waitForClaude(() => lastClaude);
    expect(first.lastPrompt).toBe(`${NOTICE}\n\nstart the work`);

    client.send({ type: "send_message", text: "/code-review high" });
    sessions.setPendingAgentNotice(client.sessionId, "The branch was reset again.");
    first.finish("queued-command-thread");

    const queued = await waitForClaude(() => lastClaude, first);
    expect(queued.lastPrompt).toBe("/code-review high");
    expect(sessions.consumePendingAgentNotice(client.sessionId)).toBe("The branch was reset again.");
    client.close();
  });

  it("steers a command invocation alone, with no dictation block appended", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "start the work" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("native-command-session");

    client.send({ type: "send_message", text: "/code-review high", dictated: true });
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.stdinData).toContain("/code-review high");
    client.close();
  });
});
