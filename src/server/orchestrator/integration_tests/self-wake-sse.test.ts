/**
 * A turn the CLI starts on its own must reach OTHER sessions' sidebars
 * (docs/267).
 *
 * The sidebar dot reads `activeRunnerSessions`, and the only thing that ADDS to
 * that set is the global-SSE `session_agent_started` event. Adoption
 * (`adoptCliStartedTurn` in `agent-listeners.ts`) announced the turn on the
 * per-session WebSocket alone, so every sidebar not attached to the session kept
 * `isAgentRunning === false` and `SessionStatusDot` fell through to the green
 * "CI passed" checkmark while the agent was working. `session_agent_finished`
 * was already an SSE broadcast — only the add was missing.
 *
 * These run the whole path: a real orchestrator, a streaming turn, a background
 * job reporting back after that turn ended, and an SSE client reading the global
 * stream the way a browser does. They pin the PAIR — a start that is announced
 * is a start that gets retracted — and the no-burst rule, since the CLI's
 * `task_notification` fires many times per turn and only the first is a real
 * false→true transition.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
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
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

interface SseFrame { event: string; data: Record<string, unknown> }

/** Minimal SSE reader: connects to /api/events and buffers parsed frames. */
class SseTestClient {
  private req: http.ClientRequest;
  private buffer = "";
  readonly frames: SseFrame[] = [];

  private constructor(req: http.ClientRequest) {
    this.req = req;
  }

  static connect(port: number): Promise<SseTestClient> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/events`,
        { headers: { Accept: "text/event-stream" } },
        (res) => {
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => client.ingest(chunk));
        },
      );
      const client = new SseTestClient(req);
      req.on("error", reject);
      req.on("response", () => setTimeout(() => resolve(client), 20));
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        this.frames.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
      } catch {
        // Non-JSON keepalive / comment — ignore.
      }
    }
  }

  /** The agent-lifecycle frames for one session, in order, as `started`/`finished`. */
  lifecycle(sessionId: string): string[] {
    return this.frames
      .filter((f) => (f.event === "session_agent_started" || f.event === "session_agent_finished")
        && f.data.sessionId === sessionId)
      .map((f) => (f.event === "session_agent_started" ? "started" : "finished"));
  }

  close(): void {
    this.req.destroy();
  }
}

describe("Integration: a CLI-started turn on the global SSE (docs/267)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  let sse: SseTestClient | null = null;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-wake-sse-"));
    credentialStore = createTestCredentialStore(tmpDir);
    // Self-wake adoption announces itself only on a streaming turn — that is
    // the shape where `turn-executor` re-arms a post-turn flow to broadcast the
    // matching finish. Live steering is the switch that produces one.
    credentialStore.setLiveSteering(true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
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
    sse?.close();
    sse = null;
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  async function waitForLifecycle(
    client: SseTestClient,
    sessionId: string,
    length: number,
    timeoutMs = 4000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (client.lifecycle(sessionId).length >= length) return client.lifecycle(sessionId);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `timed out waiting for ${length} lifecycle frames; saw ${JSON.stringify(client.lifecycle(sessionId))}`,
    );
  }

  it("announces a self-woken turn and retracts it when that turn ends", async () => {
    sse = await SseTestClient.connect(port);
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    // A user turn that backgrounds a job, then ends. The resident streaming
    // process stays up; `result` (no `done`) is the whole turn boundary.
    client.send({ type: "send_message", text: "Run the consult in the background" });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastUseStreaming).toBe(true);
    claude.initSession("wake-sse-session");
    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-session" });
    expect(await waitForLifecycle(sse, sessionId, 2)).toEqual(["started", "finished"]);

    // The job reports back and the CLI starts a turn nobody asked for. Before
    // docs/267 this reached only viewers attached to the session.
    claude.emit("event", {
      type: "agent_self_wake",
      taskId: "bg-1",
      summary: "reviewer finished",
      status: "completed",
    });
    expect(await waitForLifecycle(sse, sessionId, 3)).toEqual(["started", "finished", "started"]);

    // …and the adopted turn's own result retracts it, so the session cannot be
    // left reading as running.
    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-session" });
    expect(await waitForLifecycle(sse, sessionId, 4))
      .toEqual(["started", "finished", "started", "finished"]);

    client.close();
  });

  // The OTHER adoption edge, on its own. A live steer the CLI acked too late to
  // apply runs as its own turn, and nothing announces it — the model producing
  // output is the first proof it exists (docs/140). Emitted as the FIRST
  // post-result event here, so the case fails if the executor stops enabling
  // assistant-edge adoption (`adoptsCliStartedTurns`) rather than riding in
  // behind a self-wake that already marked the runner running.
  it("announces a turn the CLI started from a late steer, where assistant output is the only signal", async () => {
    sse = await SseTestClient.connect(port);
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Turn one" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("wake-sse-steer");
    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-steer" });
    expect(await waitForLifecycle(sse, sessionId, 2)).toEqual(["started", "finished"]);

    claude.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "renaming it" }] } });
    expect(await waitForLifecycle(sse, sessionId, 3)).toEqual(["started", "finished", "started"]);

    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-steer" });
    expect(await waitForLifecycle(sse, sessionId, 4))
      .toEqual(["started", "finished", "started", "finished"]);

    client.close();
  });

  // The pairing must survive the terminal path that produces no `agent_result`
  // at all. A start that is announced and never retracted is a worse bug than
  // the missing announcement this change fixes, so the abnormal exit gets its
  // own case rather than being inferred from the clean one.
  it("retracts the announcement when the adopted turn's process dies without a result", async () => {
    sse = await SseTestClient.connect(port);
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Run the consult in the background" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("wake-sse-crash");
    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-crash" });
    await waitForLifecycle(sse, sessionId, 2);

    claude.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    expect(await waitForLifecycle(sse, sessionId, 3)).toEqual(["started", "finished", "started"]);

    // The resident process is killed mid-adopted-turn (OOM, SIGTERM, a container
    // restart): `done` with no preceding result for that turn.
    claude.emit("done", 1);
    expect(await waitForLifecycle(sse, sessionId, 4))
      .toEqual(["started", "finished", "started", "finished"]);

    client.close();
  });

  it("announces one start per adopted turn, however many notifications it produces", async () => {
    sse = await SseTestClient.connect(port);
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const sessionId = client.sessionId;

    client.send({ type: "send_message", text: "Kick off three jobs" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("wake-sse-burst");
    claude.emit("event", { type: "result", subtype: "success", session_id: "wake-sse-burst" });
    await waitForLifecycle(sse, sessionId, 2);

    // The CLI's `task_notification` fires per finished job — the production log
    // carried 15+ in one session. Only the first is a false→true transition.
    for (const taskId of ["bg-1", "bg-2", "bg-3"]) {
      claude.emit("event", { type: "agent_self_wake", taskId, status: "completed" });
      await settle(30);
    }
    // The adopted turn's own output reaches the OTHER adoption edge as well.
    claude.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } });
    await settle();

    expect(sse.lifecycle(sessionId)).toEqual(["started", "finished", "started"]);

    client.close();
  });
});
