import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";


import type { WsServerMessage, WsLogRecord } from "../../shared/types.js";
import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

/** docs/192 — the agent Logs tab is one channel-keyed stream. Live lines arrive
 *  as `log_append`; the connect-time / subscribe backlog as `log_snapshot`. */
async function nextAppend(client: TestClient): Promise<WsLogRecord> {
  const m = await client.receiveType("log_append");
  return (m as { records: WsLogRecord[] }).records[0];
}

/** Flatten every agent log record a client has seen (snapshots + appends). */
function agentRecords(msgs: WsServerMessage[]): WsLogRecord[] {
  const out: WsLogRecord[] = [];
  for (const m of msgs) {
    if ((m.type === "log_append" || m.type === "log_snapshot") && m.channel === "agent") {
      out.push(...m.records);
    }
  }
  return out;
}

describe("Integration: Terminal/logs relay", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-logs-"));

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
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
    // Small delay to let lingering git processes release file handles
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("relays Claude stderr as a log_append record to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume the server "Agent process started" log record
    const startLog = await nextAppend(client);
    expect(startLog.source).toBe("server");

    // Simulate stderr from Claude CLI
    lastClaude.emit("log", "stderr", "Debug: loading model");

    const rec = await nextAppend(client);
    expect(rec.source).toBe("stderr");
    expect(rec.text).toBe("Debug: loading model");
    expect(rec.ts).toBeTruthy();

    client.close();
  });

  it("relays non-JSON stdout as a log_append record to client", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume "Agent process started"
    await nextAppend(client);

    // Simulate non-JSON stdout from Claude CLI
    lastClaude.emit("log", "stdout", "Warning: experimental feature");

    const rec = await nextAppend(client);
    expect(rec.source).toBe("stdout");
    expect(rec.text).toBe("Warning: experimental feature");

    client.close();
  });

  it("sends server lifecycle log records (process start/exit)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Should receive "Agent process started"
    const startLog = await nextAppend(client);
    expect(startLog.source).toBe("server");
    expect(startLog.text).toBe("Agent process started");

    // Simulate Claude finishing
    lastClaude.finish();

    // Should receive "Agent process exited" (may interleave with git_committed etc.)
    let exitRec: WsLogRecord | null = null;
    for (let i = 0; i < 15; i++) {
      const msg = await client.receive();
      if (msg.type === "log_append" && msg.channel === "agent" && msg.records[0]?.text.includes("exited")) {
        exitRec = msg.records[0];
        break;
      }
    }

    expect(exitRec).not.toBeNull();
    expect(exitRec!.source).toBe("server");
    expect(exitRec!.text).toBe("Agent process exited with code 0");

    // Drain remaining messages (e.g. git_committed) so the async done handler
    // (autoCommit, portScan) finishes before afterEach tears down the temp dir.
    try {
      for (let i = 0; i < 5; i++) {
        await client.receive(300);
      }
    } catch {
      // timeout expected when no more messages
    }

    client.close();
  });

  it("re-seeds buffered logs as a log_snapshot to newly connected clients on the SAME session", async () => {
    // First client triggers some log entries
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "generate logs" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    // Consume the "Agent process started" log
    await nextAppend(client1);

    // Add more logs via CLI output
    lastClaude.emit("log", "stderr", "Loading model...");
    await nextAppend(client1); // consume the stderr log

    // Second client connects to the same session — its connect snapshot carries
    // the full durable backlog (non-empty, so it's NOT auto-skipped).
    const client2 = await TestClient.connect(port, client1.sessionId);

    const allMsgs: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 15; i++) {
        allMsgs.push(await client2.receive(500));
      }
    } catch { /* timeout expected */ }

    const records = agentRecords(allMsgs);
    expect(records.find((r) => r.text === "Agent process started")).toBeDefined();
    expect(records.find((r) => r.text === "Loading model...")).toBeDefined();

    client1.close();
    client2.close();
  });

  it("does NOT leak buffered logs across sessions", async () => {
    // Session A generates logs
    const clientA = await TestClient.connect(port);
    await clientA.receive(); // preview_status

    clientA.send({ type: "send_message", text: "session A work" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();

    await nextAppend(clientA); // "Agent process started"
    lastClaude.emit("log", "stderr", "Session A debug output");
    await nextAppend(clientA); // consume

    // Brand-new client connects to a DIFFERENT (newly-created) session.
    // Its connect snapshot is empty and must not carry Session A's records.
    const clientB = await TestClient.connect(port);
    expect(clientB.sessionId).not.toBe(clientA.sessionId);

    const initialMsgs: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        initialMsgs.push(await clientB.receive(300));
      }
    } catch { /* timeout expected */ }

    const leaked = agentRecords(initialMsgs).filter(
      (r) => r.text === "Agent process started" || r.text === "Session A debug output",
    );
    expect(leaked).toHaveLength(0);

    clientA.close();
    clientB.close();
  });

  it("log_clear empties the durable backlog for the current session", async () => {
    // Generate some logs
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    client1.send({ type: "send_message", text: "test" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession();
    await nextAppend(client1); // "Agent process started"

    // Clear the agent log channel
    client1.send({ type: "log_clear", channel: "agent" });
    await new Promise((r) => setTimeout(r, 50));

    // New client connecting to the SAME session gets an EMPTY snapshot (which
    // the TestClient auto-skips), so it sees no agent log records at all.
    const client2 = await TestClient.connect(port, client1.sessionId);

    const msgs: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        msgs.push(await client2.receive(200));
      }
    } catch {
      // Timeout — expected
    }
    expect(agentRecords(msgs)).toHaveLength(0);

    client1.close();
    client2.close();
  });

  // ---- Preview error relay ----

  it("relays preview_error to the agent log channel", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send preview error via HTTP using the client's actual session ID
    await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/preview-errors`,
      payload: {
        message: "TypeError: Cannot read properties of undefined",
        stack: "TypeError: Cannot read properties of undefined\n  at App.tsx:42",
      },
    });

    const rec = await nextAppend(client);
    expect(rec.source).toBe("preview");
    expect(rec.text).toContain("TypeError: Cannot read properties of undefined");
    // Stack should also be included in the text
    expect(rec.text).toContain("App.tsx:42");

    client.close();
  });

  it("rejects empty preview_error messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/any/preview-errors",
      payload: { message: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Preview error message cannot be empty");
  });

  it("rejects overly long preview_error messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/any/preview-errors",
      payload: { message: "x".repeat(11_000) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Preview error message too long (max 10,000 characters)");
  });

  it("preview log entries are included in the snapshot for new clients", async () => {
    const client1 = await TestClient.connect(port);
    await client1.receive(); // preview_status

    // Send a preview error via HTTP using the client's actual session ID
    await app.inject({
      method: "POST",
      url: `/api/sessions/${client1.sessionId}/preview-errors`,
      payload: { message: "Runtime error in preview" },
    });
    await nextAppend(client1); // live log_append

    // Second client connects to the same session — its snapshot carries the
    // persisted preview log record.
    const client2 = await TestClient.connect(port, client1.sessionId);

    const messages: WsServerMessage[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        messages.push(await client2.receive(500));
      }
    } catch {
      // Timeout — we've collected what's available
    }
    const previewRec = agentRecords(messages).find((r) => r.source === "preview");
    expect(previewRec).toBeDefined();
    expect(previewRec!.text).toContain("Runtime error in preview");

    client1.close();
    client2.close();
  });
});
