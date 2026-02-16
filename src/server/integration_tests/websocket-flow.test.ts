import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";
import { ViteManager } from "../vite-manager.js";
import { ClaudeProcess } from "../claude.js";
import { FileWatcher } from "../file-watcher.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubViteManager,
  StubAuthManager,
  FakeClaudeProcess,
  StubFileWatcher,
  waitForClaude,
} from "./test-helpers.js";

describe("Integration: WebSocket flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let gitManager: GitManager;
  let sessionManager: SessionManager;
  /** Most recently created FakeClaudeProcess — set by claudeFactory. */
  let lastClaude: FakeClaudeProcess = null as any;

  beforeEach(async () => {
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-integration-"));

    // Create a markdown file for doc tests
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello\nWorld");

    gitManager = new GitManager(tmpDir);
    await gitManager.init();

    const sessionsFile = path.join(tmpDir, "sessions.json");
    sessionManager = new SessionManager(sessionsFile);

    app = await buildApp({
      gitManager,
      sessionManager,
      viteManager: new StubViteManager() as unknown as ViteManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      claudeFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as unknown as ClaudeProcess;
      },
      fileWatcher: new StubFileWatcher() as unknown as FileWatcher,
      workspaceDir: tmpDir,
      serveStatic: false,
      startVite: false,
      portScanIntervalMs: 0, // disable periodic scanning for these tests
    });

    // Listen on port 0 to get an ephemeral port
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    // Small delay to let lingering git processes release file handles
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  // ---- Connection ----

  it("sends preview_status on connect", async () => {
    const client = await TestClient.connect(port);
    const msg = await client.receive();

    expect(msg).toMatchObject({
      type: "preview_status",
      running: false,
      port: 5173,
    });

    client.close();
  });

  // ---- Invalid JSON ----

  it("returns error for invalid JSON", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // consume preview_status

    client.sendRaw("not valid json {{{");
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid JSON");

    client.close();
  });

  // ---- Session management ----

  it("list_sessions returns empty list initially", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "list_sessions" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");
    expect((msg as any).sessions).toEqual([]);

    client.close();
  });

  it("new_session returns session list", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "new_session" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_list");

    client.close();
  });

  it("delete_session removes a session", async () => {
    // Pre-populate a session
    sessionManager.track("sess-1", "Test session");

    const client = await TestClient.connect(port);
    await client.receive();

    // Verify it exists
    client.send({ type: "list_sessions" });
    const listMsg = await client.receive();
    expect((listMsg as any).sessions).toHaveLength(1);

    // Delete it
    client.send({ type: "delete_session", sessionId: "sess-1" });
    const deleteMsg = await client.receive();
    expect(deleteMsg.type).toBe("session_list");
    expect((deleteMsg as any).sessions).toHaveLength(0);

    client.close();
  });

  it("rename_session renames a session and returns updated session", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "New title" });
    const msg = await client.receive();

    expect(msg.type).toBe("session_renamed");
    expect((msg as any).session.id).toBe("sess-1");
    expect((msg as any).session.title).toBe("New title");

    // Verify the session was actually renamed in the manager
    const sessions = sessionManager.list();
    expect(sessions[0].title).toBe("New title");

    client.close();
  });

  it("rename_session returns error for non-existent session", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "nonexistent", title: "Nope" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session not found");

    client.close();
  });

  it("rename_session rejects empty title", async () => {
    sessionManager.track("sess-1", "Original title");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "rename_session", sessionId: "sess-1", title: "   " });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Session title cannot be empty");

    // Verify the title was NOT changed
    expect(sessionManager.list()[0].title).toBe("Original title");

    client.close();
  });

  // ---- Git operations ----

  it("get_git_log returns commit history", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_git_log" });
    const msg = await client.receive();

    expect(msg.type).toBe("git_log");
    const commits = (msg as any).commits;
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits[0].message).toBe("Initial commit");

    client.close();
  });

  it("rollback resets to a previous commit", async () => {
    // Create a file and commit it
    fs.writeFileSync(path.join(tmpDir, "rollback-test.txt"), "original");
    await gitManager.autoCommit("Add rollback-test");

    const log = await gitManager.log();
    const initialHash = log[log.length - 1].hash; // "Initial commit"

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "rollback", commitHash: initialHash });
    const msg = await client.receive();

    expect(msg.type).toBe("rollback_complete");
    expect((msg as any).commitHash).toBe(initialHash);

    // File should be gone after rollback
    expect(fs.existsSync(path.join(tmpDir, "rollback-test.txt"))).toBe(false);

    client.close();
  });

  // ---- Docs ----

  it("list_docs returns markdown files in workspace", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "list_docs" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_list");
    expect((msg as any).files).toContain("README.md");

    client.close();
  });

  it("get_doc returns file content", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "README.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("doc_content");
    expect((msg as any).path).toBe("README.md");
    expect((msg as any).content).toBe("# Hello\nWorld");

    client.close();
  });

  it("get_doc rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_doc returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_doc", path: "does-not-exist.md" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read doc");

    client.close();
  });

  // ---- File content viewer ----

  it("get_file_content returns file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.ts"), "const x = 42;");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "hello.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("hello.ts");
    expect((msg as any).content).toBe("const x = 42;");

    client.close();
  });

  it("get_file_content returns nested file content", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "export default {};");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "src/app.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).path).toBe("src/app.ts");
    expect((msg as any).content).toBe("export default {};");

    client.close();
  });

  it("get_file_content rejects path traversal", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "../../etc/passwd" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Invalid path");

    client.close();
  });

  it("get_file_content returns error for non-existent file", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "no-such-file.ts" });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Failed to read file");

    client.close();
  });

  it("get_file_content returns isBinary for binary files", async () => {
    // Write a file with null bytes (binary indicator)
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    fs.writeFileSync(path.join(tmpDir, "image.png"), buf);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "image.png" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("Binary file");

    client.close();
  });

  it("get_file_content returns isBinary for large files", async () => {
    // Write a file over 1 MB
    const bigContent = "x".repeat(1_048_577);
    fs.writeFileSync(path.join(tmpDir, "big.txt"), bigContent);

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "get_file_content", path: "big.txt" });
    const msg = await client.receive();

    expect(msg.type).toBe("file_content");
    expect((msg as any).isBinary).toBe(true);
    expect((msg as any).content).toContain("too large");

    client.close();
  });

  // ---- Claude message flow ----

  it("send_message creates a ClaudeProcess and relays events", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Hello Claude" });

    await waitForClaude(() => lastClaude);
    expect(lastClaude.lastPrompt).toBe("Hello Claude");

    // Simulate Claude emitting a system init event
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "test-session-123",
      tools: ["Write"],
    });

    // Should receive claude_event + session_started (skip any log_entry messages)
    const claudeEvent = await client.receiveSkipLogs();
    expect(claudeEvent).toBeDefined();
    expect(claudeEvent.type).toBe("claude_event");
    expect((claudeEvent as any).event.type).toBe("system");

    const sessionStarted = await client.receiveSkipLogs();
    expect(sessionStarted).toBeDefined();
    expect(sessionStarted.type).toBe("session_started");
    // Session ID is now an app-generated UUID (not the agent's session_id)
    expect((sessionStarted as any).session.id).toBeTruthy();
    expect((sessionStarted as any).session.title).toBe("Hello Claude");
    expect((sessionStarted as any).session.agentSessionId).toBe("test-session-123");

    client.close();
  });

  it("send_message with sessionId passes it to ClaudeProcess.run()", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Resume", sessionId: "existing-session" });
    await waitForClaude(() => lastClaude);

    expect(lastClaude.lastSessionId).toBe("existing-session");

    client.close();
  });

  it("claude done event triggers git auto-commit", async () => {
    // Create a file that will be committed on done
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "auto commit me");

    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Make a file" });
    await waitForClaude(() => lastClaude);

    // Simulate assistant text (used as commit message)
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I created new-file.txt for you" }],
      },
    });

    // Consume the claude_event for the assistant message (skip log_entry messages)
    await client.receiveSkipLogs();

    // Simulate Claude finishing — this triggers auto-commit
    lastClaude.finish("test-session");
    await client.receiveSkipLogs(); // consume the result claude_event

    // Wait for the async auto-commit (skip log_entry messages)
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("git_committed");
    expect((msg as any).message).toBe("I created new-file.txt for you");
    expect((msg as any).hash).toBeTruthy();

    client.close();
  });

  it("claude error event is relayed to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "fail" });
    await waitForClaude(() => lastClaude);

    lastClaude.emit("error", new Error("spawn ENOENT"));

    // Skip log_entry messages to get the error
    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("Claude process error");
    expect((msg as any).message).toContain("spawn ENOENT");

    client.close();
  });

  it("claude process exit without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // Process exits with non-zero code and no result event
    lastClaude.emit("done", 1);

    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("exited with code 1");

    client.close();
  });

  it("claude process exit code 0 without result sends error to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Hello" });
    await waitForClaude(() => lastClaude);

    // Process exits with code 0 but no result event (e.g. auth issue)
    lastClaude.emit("done", 0);

    const msg = await client.receiveSkipLogs();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toContain("ended without a response");

    client.close();
  });

  it("sending a new message kills the previous ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    // First message
    client.send({ type: "send_message", text: "First" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    // Second message before first completes
    client.send({ type: "send_message", text: "Second" });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Second");
    expect(lastClaude).not.toBe(firstClaude);

    client.close();
  });

  // ---- Multiple clients ----

  it("multiple clients each receive their own preview_status on connect", async () => {
    const client1 = await TestClient.connect(port);
    const msg1 = await client1.receive();
    expect(msg1.type).toBe("preview_status");

    const client2 = await TestClient.connect(port);
    const msg2 = await client2.receive();
    expect(msg2.type).toBe("preview_status");

    client1.close();
    client2.close();
  });

  // ---- Disconnect cleanup ----

  it("disconnecting kills any running ClaudeProcess", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    const claude = lastClaude;

    // Close the websocket — should kill the process
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(claude.killed).toBe(true);
  });

  // ---- Result event tracking ----

  it("result event updates session lastUsedAt", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Init event creates the session
    lastClaude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "track-session",
    });
    // Consume claude_event + session_started (skip log_entry messages)
    await client.receiveSkipLogs(); // claude_event
    await client.receiveSkipLogs(); // session_started

    const sessionsBefore = sessionManager.list();
    const lastUsedBefore = sessionsBefore[0].lastUsedAt;

    // Wait a tick so timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    // Result event should update lastUsedAt
    lastClaude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "track-session",
    });
    // Consume the claude_event (skip log_entry messages)
    await client.receiveSkipLogs();

    const sessionsAfter = sessionManager.list();
    expect(sessionsAfter[0].lastUsedAt >= lastUsedBefore).toBe(true);

    client.close();
  });

  // ---- AskUserQuestion / answer_question flow ----

  it("answer_question writes to stdin when Claude process is running", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "Ask me something" });
    await waitForClaude(() => lastClaude);

    // Claude is now running — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-1", answers: { "0": "Redis" } });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClaude.stdinData).toEqual(["Redis\n"]);

    client.close();
  });

  it("answer_question starts new Claude process when no process is running", async () => {
    // Pre-populate a session so we can resume
    sessionManager.track("existing-sess", "Test session");

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start and immediately finish a Claude turn to set currentSessionId
    client.send({ type: "send_message", text: "First message", sessionId: "existing-sess" });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;

    // Simulate Claude finishing
    firstClaude.finish("existing-sess");
    await new Promise((r) => setTimeout(r, 100));

    // Now Claude is null — send an answer
    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });
    await new Promise((r) => setTimeout(r, 50));

    // A new ClaudeProcess should have been created
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("PostgreSQL");
    expect(lastClaude.lastSessionId).toBe("existing-sess");

    client.close();
  });

  it("answer_question returns error for empty answer", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "answer_question", toolUseId: "tool-3", answers: {} });
    const msg = await client.receive();

    expect(msg.type).toBe("error");
    expect((msg as any).message).toBe("Answer cannot be empty");

    client.close();
  });

  it("answer_question with multiple answers joins them", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Start a Claude message flow
    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);

    // Send an answer with multiple values
    client.send({
      type: "answer_question",
      toolUseId: "tool-4",
      answers: { "0": "Auth", "1": "Cache" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Should write both answers joined by comma
    expect(lastClaude.stdinData).toEqual(["Auth, Cache\n"]);

    client.close();
  });
});
