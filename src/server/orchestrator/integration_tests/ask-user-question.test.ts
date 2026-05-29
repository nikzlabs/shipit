import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../auth.js";


import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

describe("Integration: AskUserQuestion / answer_question flow", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  /** Most recently created FakeClaudeProcess — set by agentFactory. */
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ask-question-"));

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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors — temp dir will be cleaned by OS
    }
  });

  it("answer_question kills the stale steering-capable agent and falls through to a fresh --resume spawn when the steering gate fails", async () => {
    // Regression: the user reported that an AskUserQuestion answer "appeared
    // in the chat, but the agent didn't react" — the same silent-drop shape
    // commit ee313d3661 fixed for `handleSendMessage`. The recent commit added
    // the `isStreamingActive` gate to `handleAnswerQuestion` but kept a legacy
    // `writeStdin` fallback below it. For steering-capable adapters (the only
    // kind in the registry today: claude, codex) `writeStdin` lands as raw
    // bytes on a process whose adapter expects NDJSON, and the line is
    // silently dropped. The fix mirrors `handleSendMessage`'s stale-kill at
    // line 263: drop the stale ref, fall through to the fresh-spawn `--resume`
    // path so the answer actually reaches the model.
    //
    // Default test setup (`liveSteering=false`, registry says
    // `supportsSteering=true` for claude) hits the exact gate-failed shape
    // that triggered the production bug: `existingAgent` is non-null,
    // `streamingActive` is false (the agent spawned with `useStreaming=false`).
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // First turn — agent is mid-turn, not yet finished.
    client.send({ type: "send_message", text: "Ask me something" });
    const firstClaude = await waitForClaude(() => lastClaude);

    client.send({ type: "answer_question", toolUseId: "tool-1", answers: { "0": "Redis" } });
    await waitForClaude(() => lastClaude, firstClaude);

    // Stale ref was killed, a fresh agent was spawned via the `--resume` path
    // with the answer as the next prompt. NOT routed through `writeStdin` on
    // the stale process (which would have been silently dropped).
    expect(firstClaude.killed).toBe(true);
    expect(firstClaude.stdinData).toEqual([]);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);
    expect(lastClaude.lastPrompt).toBe("Redis");

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

  it("answer_question fall-through emits session_status running=true to viewers", async () => {
    // Regression test for: after answering an agent question, the UI's
    // "Thinking..." indicator and sidebar active-runner dot fail to appear
    // because the handler skipped the running-state side effects that
    // handleSendMessage performs (set runner.running=true, broadcast
    // session_agent_started SSE, emit session_status). Without this,
    // useAttentionInfo on the client surfaces "Waiting for your input" and
    // the chat panel stays idle even though the agent is actively working.
    //
    // Use createTestSession() to get a real workspaceDir — the session_status
    // emit gates on `answerRunner`, which only exists for sessions whose
    // sessionDir is tracked (otherwise the WS handler can't create a runner).
    const { sessionId } = await createTestSession(sessionManager, tmpDir, "Ask-test");
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    // Drive the first turn to completion so the handler hits the
    // fall-through (no-running-agent) branch on the next answer_question.
    client.send({ type: "send_message", text: "First", sessionId });
    await waitForClaude(() => lastClaude);
    const firstClaude = lastClaude;
    firstClaude.finish(sessionId);

    // Wait for the post-turn cycle to settle — the test only needs the
    // runner to be in the no-running-agent state before answer_question.
    await new Promise((r) => setTimeout(r, 200));
    // Drain everything currently buffered so the next receive() picks up
    // messages emitted after answer_question, not stale ones from the
    // first turn.
    while (true) {
      try {
        await client.receive(50);
      } catch {
        break;
      }
    }

    // Now send the answer — this is the fall-through path. We expect a
    // session_status with running=true to be broadcast so attached viewers
    // (including ones that didn't initiate the answer) get the right state.
    client.send({ type: "answer_question", toolUseId: "tool-2", answers: { "0": "PostgreSQL" } });

    let sawRunning = false;
    const deadline = Date.now() + 2000;
    while (!sawRunning && Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(500);
      } catch {
        break;
      }
      if (msg.type === "session_status" && msg.running && msg.sessionId === sessionId) {
        sawRunning = true;
      }
    }
    expect(sawRunning).toBe(true);

    // Sanity: the new Claude process was actually started. Wait for run()
    // because the handler awaits readSystemPrompt() between emitting
    // session_status and calling currentAgent.run().
    await waitForClaude(() => lastClaude, firstClaude);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.runCalled).toBe(true);

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

  it("answer_question with multiple answers uses the client-formatted text verbatim as the fresh-spawn prompt", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Multi-question answers are a bullet list with the question text inline,
    // so commas inside an answer aren't ambiguous with the separator between
    // answers. After the steering-gate-fail kill+respawn, the formatted text
    // becomes the fresh agent's `--resume` prompt verbatim — same text the
    // chat bubble shows.
    client.send({
      type: "answer_question",
      toolUseId: "tool-4",
      answers: { "0": "Auth", "1": "Cache, with TTL" },
      text: "- Pick a feature?: Auth\n- Cache config?: Cache, with TTL",
    });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.lastPrompt).toBe(
      "- Pick a feature?: Auth\n- Cache config?: Cache, with TTL",
    );

    client.close();
  });

  it("answer_question falls back to joining answers when text is omitted", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "test" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // Old client (no `text` field) — server still joins so existing sessions
    // keep working through the rollout. The joined text becomes the fresh
    // spawn's prompt.
    client.send({
      type: "answer_question",
      toolUseId: "tool-4b",
      answers: { "0": "Auth", "1": "Cache" },
    });
    await waitForClaude(() => lastClaude, firstClaude);

    expect(firstClaude.killed).toBe(true);
    expect(lastClaude).not.toBe(firstClaude);
    expect(lastClaude.lastPrompt).toBe("Auth, Cache");

    client.close();
  });

  it("answer_question steers via sendUserMessage when liveSteering is on and the resident process is streaming (no kill, no respawn)", async () => {
    // Live-steering happy path: the persistent streaming process is blocked
    // on AskUserQuestion, and the answer must reach the resident CLI via
    // `sendUserMessage` (NDJSON) — NOT trigger a kill+respawn. This pins the
    // gate so the steering-capable / streaming-active branch keeps working
    // after the stale-kill fall-through was added to handleAnswerQuestion.
    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    // Rebuild the app with live steering enabled (the suite default is off).
    await app.close();
    app = await buildApp({
      credentialStore,
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

    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Pick something" });
    const claude = await waitForClaude(() => lastClaude);
    // With liveSteering=true and the registry's `supportsSteering=true` for
    // claude, the runner spins up with `isStreamingActive=true`.
    expect(claude.lastUseStreaming).toBe(true);

    // Drive the agent up to the AskUserQuestion interrupt: the listener flips
    // running=false on agent_result, but keeps the streaming process alive
    // (no `done` event). isStreamingActive stays true.
    claude.initSession("steer-answer-session");
    claude.emit("event", {
      type: "result",
      subtype: "error",
      session_id: "steer-answer-session",
      duration_ms: 50,
      result: "error_during_execution",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(claude.killed).toBe(false);

    client.send({
      type: "answer_question",
      toolUseId: "ask-1",
      answers: { "0": "Redis" },
      text: "Redis",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Same process — NOT killed, NOT respawned.
    expect(claude.killed).toBe(false);
    expect(lastClaude).toBe(claude);
    // FakeClaudeProcess.sendUserMessage proxies to writeStdin, so stdinData
    // captures the steered answer. NDJSON framing happens inside the real
    // adapter (out of scope for this fake) — the contract under test is
    // "sendUserMessage was called with the answer text".
    expect(claude.stdinData).toContain("Redis");

    client.close();
  });

  it("does not interrupt when AskUserQuestion is emitted with missing/empty questions", async () => {
    // The model occasionally emits AskUserQuestion with malformed input (no
    // `questions` field, or an empty array). The Claude CLI's input validator
    // rejects this with InputValidationError, which flows back to the model
    // as a tool_result so it can self-correct within the same turn. The
    // client also can't render the question card without a `questions` array.
    // Interrupting on a malformed call would kill the turn before the model
    // gets the error back, stranding the user with no card and no progress.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.interrupted).toBe(false);

    // Missing `questions` entirely (the actual production failure mode).
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-malformed-1",
          name: "AskUserQuestion",
          input: {},
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(false);

    // Empty `questions` array — also malformed (schema requires minItems: 1).
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-malformed-2",
          name: "AskUserQuestion",
          input: { questions: [] },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(false);

    client.close();
  });

  it("interrupts the agent when it emits an AskUserQuestion tool_use", async () => {
    // Without the interrupt, the Claude CLI in `-p` mode would auto-resolve
    // the AskUserQuestion call (no interactive terminal to wait on) and the
    // model would continue with whatever it planned next. The user would see
    // the question card AND the agent's subsequent output even though they
    // never answered. The fix in agent-listeners.ts interrupts the agent as
    // soon as we observe the AskUserQuestion tool_use.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);
    expect(lastClaude.interrupted).toBe(false);

    // Simulate the CLI emitting an AskUserQuestion tool_use as part of the
    // assistant turn — same shape that ClaudeAdapter would produce.
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Agent should have been interrupted — the CLI shouldn't be allowed to
    // continue with whatever auto-resolved result the headless mode produced.
    expect(lastClaude.interrupted).toBe(true);

    client.close();
  });

  it("suppresses the CLI's auto-resolved tool_result for an interrupted AskUserQuestion", async () => {
    // In live-steering (streaming) mode the CLI auto-resolves AskUserQuestion
    // before the orchestrator's `control_request` interrupt takes effect, so
    // the synthetic `user` event arrives at the orchestrator and would be
    // forwarded as `agent_tool_result`. If the client received it, MessageList
    // would set `questionDisabled = !!el.result` and AskUserQuestion would
    // render its options as already-answered — leaving the user unable to
    // click anything. The orchestrator tracks the interrupted AskUserQuestion
    // ids and drops matching tool_result blocks before broadcasting.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "Pick one" });
    await waitForClaude(() => lastClaude);

    // Emit a well-formed AskUserQuestion so the orchestrator interrupts and
    // remembers `ask-suppress-1` as a suppressed id.
    lastClaude.emit("event", {
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "ask-suppress-1",
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: "Pick a backend",
              header: "Backend",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastClaude.interrupted).toBe(true);

    // Now simulate the CLI's auto-resolved tool_result — a `user` event
    // carrying a tool_result block referencing the same id. Without the
    // suppression this would be broadcast to the client as agent_tool_result.
    lastClaude.emit("event", {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "ask-suppress-1",
          content: "No user response — auto-resolved by CLI",
        }],
      },
    });

    // Collect everything the client sees in the next short window. We assert
    // no agent_tool_result for `ask-suppress-1` slips through. Drain until the
    // receive call times out (no more buffered messages).
    let sawSuppressedResult = false;
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      let msg;
      try {
        msg = await client.receive(80);
      } catch {
        break;
      }
      if (msg.type === "agent_event") {
        const event = (msg as { event: { type: string; content?: unknown[] } }).event;
        if (event.type === "agent_tool_result") {
          const hasId = (event.content ?? []).some((b) => {
            const id = (b as { tool_use_id?: string }).tool_use_id;
            return id === "ask-suppress-1";
          });
          if (hasId) sawSuppressedResult = true;
        }
      }
    }
    expect(sawSuppressedResult).toBe(false);

    client.close();
  });
});
