/**
 * Integration tests for what a viewer sees when it (re)attaches to a session
 * whose turn is still running — the session-switch-mid-turn path.
 *
 * The bug these pin: rebuilding a running turn used to stitch two
 * independently-sampled sources — the `GET /history` DB snapshot plus a
 * cursor-sliced replay of the runner's turn-event buffer. The cursor
 * (`lastPersistedBufferIndex`) only means "everything before this is already in
 * the DB", which holds for a history snapshot taken *after* the persist that
 * moved it. The browser's history fetch is a round trip that lands before or
 * after the attach depending on latency, so a tool-result boundary landing
 * between the two samples either erased a whole slice of the turn from the
 * transcript (history read first — the slice was in neither half) or duplicated
 * it (attach first — it was in both). Nothing repaired it: the viewer sat on a
 * wrong transcript until the next reload. Reported as "I switch to another
 * session mid-turn, switch back, and the earlier messages are gone."
 *
 * The fix is `turn_snapshot`: the attach sends the whole running turn, built in
 * the same synchronous block that subscribes the socket, so the baseline and
 * the live stream are split at exactly one instant. These tests assert the
 * snapshot covers the turn in BOTH orderings, and that the buffer replay no
 * longer double-delivers the same agent events on top of it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
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

// Test code asserts on heterogeneous ws messages at runtime.
type AnyMsg = any;

describe("Integration: mid-turn reattach snapshot", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-reattach-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  /** Start a turn and produce one persisted assistant group. */
  async function startTurnWithOneGroup(): Promise<TestClient> {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    client.send({ type: "send_message", text: "Do the thing" });
    await waitForClaude(() => lastClaude);
    lastClaude.initSession("reattach-session");
    await client.receiveType("session_started");

    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-ONE" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "bytes" }] },
    });
    await settle();
    return client;
  }

  /** Emit a second assistant group and close it at a tool-result boundary. */
  function emitGroupTwo(): void {
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "GROUP-TWO" },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    lastClaude.emit("event", {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "out" }] },
    });
  }

  /** Drain a freshly-connected client's messages. */
  async function drainAll(client: TestClient): Promise<AnyMsg[]> {
    const msgs: AnyMsg[] = [];
    try {
      for (let i = 0; i < 40; i++) msgs.push(await client.receive(300));
    } catch { /* drained */ }
    return msgs;
  }

  it("sends the whole running turn when a persist lands between the history read and the attach", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;

    // The user switches away.
    client.close();
    await settle();

    // Switching back: the browser reads history the moment the socket opens,
    // while the server is still on its way to attaching this viewer.
    const histRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/history`);
    const hist = await histRes.json() as { messages: AnyMsg[] };
    expect(hist.messages.map((m) => m.text)).toEqual(["Do the thing", "GROUP-ONE"]);

    // A tool-result boundary lands in that window. It persists the turn and, in
    // the old design, advanced the replay cursor past everything buffered so
    // far — so GROUP-TWO was in neither the fetched history nor the replay.
    emitGroupTwo();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    const snapshot = replayed.find((m) => m.type === "turn_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.messages.map((m: AnyMsg) => m.text)).toEqual(["GROUP-ONE", "GROUP-TWO"]);
    expect(snapshot.messages.every((m: AnyMsg) => m.inProgress)).toBe(true);
    back.close();
  });

  it("does not replay agent events on top of the snapshot (no duplicated turn content)", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;
    client.close();
    await settle();

    // Un-persisted tail: assistant text produced after the last tool-result
    // boundary. Previously this was the cursor-sliced replay's job; the
    // snapshot carries it now, and the replay must not send it again.
    lastClaude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "TAIL-TEXT" }] },
    });
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    const snapshot = replayed.find((m) => m.type === "turn_snapshot");
    expect(snapshot.messages.map((m: AnyMsg) => m.text)).toEqual(["GROUP-ONE", "TAIL-TEXT"]);
    // The tail is in the snapshot exactly once — no `agent_event` echo of it.
    expect(replayed.filter((m) => m.type === "agent_event")).toEqual([]);
    back.close();
  });

  /**
   * planning#246 — the attach's own `GET /history` carries the runner's CURRENT
   * `backgroundTasks`, read live at request time, so a buffered `background_tasks`
   * can only ever be older. It matters because the marker is also cleared by
   * paths that emit no `background_tasks` of their own (a crashed process, a
   * disposed runner — those announce over SSE instead), which leaves the last
   * buffered copy still saying "outstanding". Replaying it resurrected a green
   * sidebar dot on a session with nothing running, and which value won came
   * down to whether the replay landed before or after the HTTP history it
   * contradicts.
   */
  it("does not replay a background-task message on reattach", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;

    lastClaude.emit("event", {
      type: "agent_background_tasks",
      tasks: [{ id: "bg-1", description: "shipit agent run --agent codex" }],
    });
    await settle();
    // The live viewer does get it — that half is the chat status line.
    expect(
      (await drainAll(client)).some((m) => m.type === "background_tasks"),
    ).toBe(true);

    client.close();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    expect(replayed.filter((m) => m.type === "background_tasks")).toEqual([]);
    back.close();
  });

  it("sends no snapshot when no turn is running", async () => {
    const client = await startTurnWithOneGroup();
    const sessionId = client.sessionId;
    lastClaude.finish("reattach-session");
    await settle(250);
    client.close();
    await settle();

    const back = await TestClient.connect(port, sessionId);
    const replayed = await drainAll(back);

    // The finished turn lives in chat history as finalized rows; re-sending it
    // as an in-progress snapshot would resurrect it as a running turn.
    expect(replayed.find((m) => m.type === "turn_snapshot")).toBeUndefined();
    back.close();
  });
});
