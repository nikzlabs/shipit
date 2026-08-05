/**
 * Integration tests for POST /api/sessions/:id/agent/dispatch (docs/150).
 *
 * The HTTP route is the system-initiated counterpart to the WS `send_message`
 * handler — converted client buttons (Create PR, Send compose error, Auto-fix
 * preview errors, etc.) POST here instead of prefilling the textarea or
 * sending over WS. Internally it delegates to `runner.dispatch`, the same
 * funnel Fix CI and child-session spawn use.
 *
 * Coverage:
 *   - POST → idle session starts a turn (queued: false, agent runs).
 *   - POST → running session queues (queued: true, message_queued broadcast).
 *   - 400 for empty / oversized text and unknown permission mode.
 *   - 404 for unknown session ids (and for archived ones).
 *   - 401 when the active agent isn't authenticated.
 *   - docs/131 — a cold session (no runner) is woken rather than 404'd, and its
 *     turn is observable afterwards over `/status` and `/history`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";

import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

type AnyMsg = any;

describe("Integration: POST /api/sessions/:id/agent/dispatch", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;
  let stubAuth: StubAuthManager;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    stubAuth = new StubAuthManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-dispatch-"));

    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);

    credentialStore = createTestCredentialStore(tmpDir);
    const now = Date.now();
    credentialStore.upsertProviderAccount({
      id: "acct-added-claude",
      provider: "claude",
      label: "Added Claude subscription",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });

    app = await buildApp({
      credentialStore,
      credentialsDir: path.join(tmpDir, "credentials"),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: stubAuth as unknown as AuthManager,
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
      // Ignore cleanup errors
    }
  });

  async function drainUntil(client: TestClient, predicate: (m: AnyMsg) => boolean, maxMsgs = 30, timeoutMs = 2000): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("400 — empty text is rejected before reaching the runner", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/text is required/i) });
    client.close();
  });

  it("400 — unknown permission mode is rejected", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "do a thing", permissionMode: "wide-open" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/permission mode/i) });
    client.close();
  });

  it("404 — an unknown session id returns not active", async () => {
    // Note the id genuinely doesn't exist. Since docs/131, "no runner" alone is
    // no longer a 404 — a real session with a workspace gets woken instead (see
    // the wake-on-dispatch block at the bottom of this file). What still 404s is
    // an id with nothing behind it.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/nonexistent-session/agent/dispatch`,
      payload: { text: "go" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/not active/i) });
  });

  it("401 — unauthenticated Claude blocks dispatch", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    credentialStore.deleteProviderAccount("claude", "acct-added-claude");
    stubAuth.authenticated = false;
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "do thing" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/not authenticated/i) });
    client.close();
  });

  it("idle session — dispatch starts a turn immediately (queued: false)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Please create a PR", activity: "Creating PR…" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, queued: false });

    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastPrompt).toBe("Please create a PR");

    // The runner emits system_user_message before the agent run starts.
    const sys = await drainUntil(client, (m) => m.type === "system_user_message");
    expect(sys).toMatchObject({
      type: "system_user_message",
      text: "Please create a PR",
      activity: "Creating PR…",
    });

    client.close();
  });

  it("SDK dispatch preserves host provenance and wraps the agent input", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: {
        text: "Apply the selected settings",
        agentInterface: { source: "agent_interface_sdk", surface: "present" },
      },
    });
    expect(res.statusCode).toBe(200);
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastPrompt).toContain("Agent Interface SDK message from the active Present surface");
    expect(claude.lastPrompt).toContain("<agent-interface-message>\nApply the selected settings\n</agent-interface-message>");

    const sys = await drainUntil(client, (m) => m.type === "system_user_message");
    expect(sys).toMatchObject({
      text: "Apply the selected settings",
      agentInterface: { source: "agent_interface_sdk", surface: "present" },
    });
    expect(chatHistoryManager.load(client.sessionId)[0]).toMatchObject({
      text: "Apply the selected settings",
      agentInterface: { source: "agent_interface_sdk", surface: "present" },
    });
    client.close();
  });

  it("running session — dispatch queues and broadcasts message_queued (docs/150)", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Send first message over WS to start a turn
    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);
    expect(firstClaude.lastPrompt).toBe("First");

    // HTTP dispatch while the turn is running — should enqueue.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Second via HTTP", activity: "Creating PR…" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, queued: true });

    // The queue broadcast is now emitted by runner.dispatch (not by the WS
    // handler), so even this WS-attached client receives the same payload.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({
      type: "message_queued",
      text: "Second via HTTP",
      position: 1,
    });

    // The second Claude process should NOT have been started yet.
    expect(lastClaude).toBe(firstClaude);
    client.close();
  });

  it("warm session — dispatch graduates it (docs/156)", async () => {
    // Regression test: the compose-hint / compose-error / Create PR buttons all
    // POST here, and on a `/{repo}/new` route the session behind them is still
    // warm. Before graduation was wired in, pressing one started a real turn but
    // left `warm: 1` — the session never entered the session list, kept its
    // placeholder title, and `findUngraduatedWarm` would hand it to the next
    // "New Session" click for the repo, recycling it mid-turn.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    sessionManager.setWarm(client.sessionId!, true);
    expect(sessionManager.get(client.sessionId!)?.warm).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Add a compose block to shipit.yaml", activity: "Setting up preview…" },
    });
    expect(res.statusCode).toBe(200);

    const graduated = sessionManager.get(client.sessionId!);
    expect(graduated?.warm).toBeFalsy();
    // graduateSession sets the placeholder title from the dispatched text.
    expect(graduated?.title).toBe("Add a compose block to shipit.yaml");

    // The turn still runs — graduation is additive, not a replacement.
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastPrompt).toBe("Add a compose block to shipit.yaml");

    client.close();
  });

  it("dispatch persists tool calls and splits assistant text at tool-result boundary", async () => {
    // Regression test for the "invisible tool calls + concatenated assistant
    // text" bug class. Before the unification refactor, runDispatchedTurn
    // had its own inline event listener that concatenated assistant text
    // across events with no separator and dropped all tool_use blocks —
    // producing a single assistant chat-history row like
    //   { role: "assistant", text: "First half.Second half." }
    // and silently losing any tool calls the agent made between the two
    // utterances. After unification, runDispatchedTurn goes through the
    // same `wireAgentListeners` the WS user-typed turn uses, so dispatched
    // turns produce the same message-group structure (tool calls visible,
    // assistant text split at tool-result boundaries).
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Please fix this", activity: "Auto-fixing CI…" },
    });
    expect(res.statusCode).toBe(200);

    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastPrompt).toBe("Please fix this");

    // Drive the canonical bug sequence: assistant text + tool_use → tool_result
    // → assistant text → result. FakeClaudeProcess translates raw Claude
    // events to AgentEvent via `mapClaudeEvent`.
    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-dispatch",
    });
    await client.receiveType("session_started");

    claude.emit("event", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll examine the failing test and fix it." },
          {
            type: "tool_use",
            id: "tool_x",
            name: "Read",
            input: { file_path: "src/some-file.ts" },
          },
        ],
      },
    });
    claude.emit("event", {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool_x", content: "file contents..." },
        ],
      },
    });
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Found it — patched the typo." }] },
    });
    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "agent-session-dispatch",
      duration_ms: 10,
    });
    claude.emit("done", 0);

    // Wait for the result to be persisted (the listener calls
    // finalizeInProgress on agent_result, but persistence is fully synchronous;
    // the test still needs to yield so async post-turn work settles).
    await new Promise((r) => setTimeout(r, 50));

    const history = chatHistoryManager.load(client.sessionId);
    const userRows = history.filter((m) => m.role === "user");
    const assistantRows = history.filter((m) => m.role === "assistant");

    // One user message (the dispatched prompt) and TWO assistant rows.
    // Before the fix, the assistant rows would have collapsed into one row
    // with text="I'll examine the failing test and fix it.Found it — patched the typo."
    // and `toolUse` undefined.
    expect(userRows.length).toBe(1);
    expect(userRows[0].text).toBe("Please fix this");

    expect(assistantRows.length).toBe(2);
    expect(assistantRows[0].text).toBe("I'll examine the failing test and fix it.");
    expect(assistantRows[0].toolUse?.length).toBe(1);
    expect(assistantRows[0].toolUse?.[0].name).toBe("Read");
    expect(assistantRows[0].toolResults?.length).toBe(1);
    expect(assistantRows[0].toolResults?.[0].toolUseId).toBe("tool_x");

    expect(assistantRows[1].text).toBe("Found it — patched the typo.");
    expect(assistantRows[1].toolUse).toBeUndefined();

    client.close();
  });

  it("dispatched turn links the auto-commit to the last chat message", async () => {
    // Regression: runDispatchedTurn used to run `autoCommit` but never write
    // `commit_hash` / `parent_commit_hash` back onto the chat message, so
    // `findCommitBeforeGap` returned null and the Rewind dropdown always
    // reported "0 files" for sessions whose turns came through dispatch
    // (queued WS turns, HTTP /agent/dispatch, Fix CI, child sessions).
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    const workspaceDir = path.join(tmpDir, "sessions", client.sessionId, "workspace");
    const initialHead = await new GitManager(workspaceDir).getHeadHash();
    expect(initialHead).toBeTruthy();

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Make a change" },
    });
    expect(res.statusCode).toBe(200);

    const claude = await waitForClaude(() => lastClaude);

    claude.emit("event", {
      type: "system",
      subtype: "init",
      session_id: "agent-session-link",
    });
    await client.receiveType("session_started");

    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Done — patched it." }] },
    });
    claude.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "agent-session-link",
      duration_ms: 5,
    });

    // Simulate the agent's file change so post-turn autoCommit has something
    // to commit. FakeClaudeProcess doesn't actually edit files.
    fs.writeFileSync(path.join(workspaceDir, "patched.txt"), "patched\n");
    claude.emit("done", 0);

    // commit_linked fires from dispatched-turn after the autoCommit writes
    // commit_hash / parent_commit_hash onto the last assistant message.
    const linked = await drainUntil(client, (m) => m.type === "commit_linked");
    expect(linked).toMatchObject({
      type: "commit_linked",
      parentCommitHash: initialHead,
    });

    const history = chatHistoryManager.load(client.sessionId);
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.commitHash).toBeTruthy();
    expect(lastAssistant?.parentCommitHash).toBe(initialHead);

    client.close();
  });

  it("queued dispatch threads activity through the drain (docs/150)", async () => {
    // The recursive drain at runDispatchedTurn:204 previously dropped every
    // QueuedMessage field except `text`. This test exercises the drain path
    // by queueing a dispatch with an activity label and verifying the next
    // turn's system_user_message carries the activity.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    // Kick off a turn via WS so the next HTTP dispatch is queued.
    client.send({ type: "send_message", text: "First" });
    const firstClaude = await waitForClaude(() => lastClaude);

    // HTTP dispatch lands in the queue.
    await app.inject({
      method: "POST",
      url: `/api/sessions/${client.sessionId}/agent/dispatch`,
      payload: { text: "Drain me", activity: "Auto-fixing CI…" },
    });

    // Drain the message_queued before completing the first turn — the queue
    // broadcast is now on the runner channel, so this is a structural check
    // that the route reached `runner.dispatch`.
    const queued = await drainUntil(client, (m) => m.type === "message_queued");
    expect(queued).toMatchObject({ text: "Drain me", position: 1 });

    // Finish the first turn — drains via the WS path (runAgentWithMessage),
    // which honors the queued message's full shape.
    firstClaude.emit("event", { type: "agent_result", status: "success", sessionId: "s-a", durationMs: 10 });
    firstClaude.emit("done", 0);

    const secondClaude = await waitForClaude(() => lastClaude, firstClaude);
    expect(secondClaude.lastPrompt).toBe("Drain me");

    client.close();
  });

  // ---- Wake-on-dispatch (docs/131 reqs 8–10) ----
  //
  // A session nobody currently has open has no runner: only the WS connect path
  // called `getOrCreate`. That made HTTP dispatch reachable *only* for sessions
  // a browser was already attached to, which is exactly the case the outer agent
  // driving the inner dogfood ShipIt doesn't have. These pin the relaxation —
  // and its limits.

  it("cold session — dispatch wakes it and runs the turn (docs/131 req 8)", async () => {
    // A session row with a workspace but no runner: what an earlier dogfood boot
    // leaves behind, and what an idle-evicted session looks like.
    const sessionDir = fs.mkdtempSync(path.join(tmpDir, "cold-"));
    sessionManager.track("cold-session", "From an earlier boot", sessionDir);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/cold-session/agent/dispatch`,
      payload: { text: "Fix the failing test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, queued: false });
    const claude = await waitForClaude(() => lastClaude);
    expect(claude.lastPrompt).toBe("Fix the failing test");
  });

  it("a woken session reports running, then finished (docs/131 req 10)", async () => {
    // Requirement 10 is "the outer agent can tell whether it's still working" —
    // which only means anything if the flag actually flips around a turn the
    // outer agent started over HTTP.
    const sessionDir = fs.mkdtempSync(path.join(tmpDir, "cold-status-"));
    sessionManager.track("status-session", "Cold", sessionDir);

    const before = await app.inject({ method: "GET", url: "/api/sessions/status-session/status" });
    expect(before.json()).toMatchObject({ running: false });

    await app.inject({
      method: "POST",
      url: `/api/sessions/status-session/agent/dispatch`,
      payload: { text: "Do the thing" },
    });
    const claude = await waitForClaude(() => lastClaude);

    const during = await app.inject({ method: "GET", url: "/api/sessions/status-session/status" });
    expect(during.json()).toMatchObject({ running: true, queueLength: 0 });

    claude.emit("event", {
      type: "result", subtype: "success", session_id: "s-cold", duration_ms: 10,
    });
    claude.emit("done", 0);
    await vi.waitFor(async () => {
      const after = await app.inject({ method: "GET", url: "/api/sessions/status-session/status" });
      expect(after.json()).toMatchObject({ running: false });
    });
  });

  it("a woken session's turn is readable from history afterwards (docs/131 req 9)", async () => {
    const sessionDir = fs.mkdtempSync(path.join(tmpDir, "cold-history-"));
    sessionManager.track("history-session", "Cold", sessionDir);

    await app.inject({
      method: "POST",
      url: `/api/sessions/history-session/agent/dispatch`,
      payload: { text: "Summarize the repo" },
    });
    const claude = await waitForClaude(() => lastClaude);
    // FakeClaudeProcess emits raw Claude events; `mapClaudeEvent` translates.
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "It is a todo list." }] },
    });
    claude.emit("event", {
      type: "result", subtype: "success", session_id: "s-hist", duration_ms: 10,
    });
    claude.emit("done", 0);

    // The conversation the outer agent reads back is the persisted one, not a
    // live WS stream — nobody is attached to this session.
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/api/sessions/history-session/history" });
      const texts = (res.json().messages as AnyMsg[]).map((m) => m.text);
      expect(texts).toContain("Summarize the repo");
      expect(texts).toContain("It is a todo list.");
    });
  });

  it("archived sessions stay unreachable — waking must not resurrect one", async () => {
    // "Archived sessions receive nothing" is an invariant of the WS activation
    // path; sharing that path is the reason wake-on-dispatch can't quietly
    // reintroduce a way around it by booting a container for an archived id.
    const sessionDir = fs.mkdtempSync(path.join(tmpDir, "archived-"));
    sessionManager.track("archived-session", "Old work", sessionDir);
    sessionManager.archive("archived-session");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/archived-session/agent/dispatch`,
      payload: { text: "wake up" },
    });
    expect(res.statusCode).toBe(404);
    expect(lastClaude).toBe(null);
  });
});
