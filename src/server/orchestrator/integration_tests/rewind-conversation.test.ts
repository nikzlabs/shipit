import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * docs/007-threads-checkpoints reqs 2–9 — a rewind never resets the stored conversation:
 * a chat rewind leaves a point the next spawn forks the conversation at, a code rewind
 * leaves it alone and tells the next prompt, and a rewind with nothing to fork at is
 * refused with fork named instead.
 */
describe("Integration: what a rewind does to the agent's conversation (docs/007)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess = null as never;

  const TURN_ONE_TEXT = "Added the billing routes in src/billing.ts.";

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-rewind-conversation-"));
    sessionManager = new SessionManager(dbManager);
    chatHistoryManager = new ChatHistoryManager(dbManager);
    lastClaude = null as never;

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
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  const settled = (sessionId: string) => waitFor(() => {
    const runner = app.runnerRegistry.get(sessionId);
    return runner !== undefined && !runner.running && !runner.agentBusy;
  }, "the turn settled");

  async function receiveOneOf(client: TestClient, types: string[]): Promise<WsServerMessage> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const msg = await client.receive(deadline - Date.now());
      if (types.includes(msg.type)) return msg;
    }
    throw new Error(`none of ${types.join(", ")} arrived`);
  }

  /** A turn the CLI answers in conversation `cliId`, its reply carrying the message id `uuid`. */
  async function runTurn(
    client: TestClient,
    text: string,
    reply: { cliId: string; uuid: string; text: string },
    previous: FakeClaudeProcess | null = null,
  ): Promise<FakeClaudeProcess> {
    client.send({ type: "send_message", text, requestId: `req-${reply.uuid}` });
    const claude = await waitForClaude(() => lastClaude, previous ?? undefined);
    claude.initSession(reply.cliId);
    // What streaming mode echoes back: the prompt as the CLI stored it, with its id.
    claude.emit("event", {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "text", text: claude.lastPrompt }] },
      uuid: `user-${reply.uuid}`,
      session_id: reply.cliId,
    });
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: reply.text }] },
      uuid: reply.uuid,
      session_id: reply.cliId,
    });
    claude.finish(reply.cliId);
    await settled(client.sessionId);
    return claude;
  }

  async function twoTurns(client: TestClient): Promise<FakeClaudeProcess> {
    const first = await runTurn(client, "Add the billing routes", { cliId: "conv-1", uuid: "msg-a1", text: TURN_ONE_TEXT });
    return runTurn(client, "Now the webhook route", { cliId: "conv-1", uuid: "msg-a2", text: "Added the webhook." }, first);
  }

  const gapBefore = (sessionId: string, text: string): number =>
    chatHistoryManager.load(sessionId).findIndex((m) => m.text === text);

  it("records the CLI's id of each message, the prompt's from its echo", async () => {
    const client = await TestClient.connect(port);
    await twoTurns(client);

    const rows = chatHistoryManager.load(client.sessionId);
    expect(rows.map((m) => [m.role, m.agentMessageId])).toEqual([
      ["user", "user-msg-a1"],
      ["assistant", "msg-a1"],
      ["user", "user-msg-a2"],
      ["assistant", "msg-a2"],
    ]);
    client.close();
  }, 30_000);

  it("knows a fork's first prompt from its echo, the replay in front included", async () => {
    const client = await TestClient.connect(port);
    sessionManager.setConversationReplay(client.sessionId, "You are continuing a conversation.\nUser: hello");

    const first = await runTurn(client, "Carry on from there", { cliId: "conv-9", uuid: "msg-f1", text: "Carrying on." });
    expect(first.lastPrompt.startsWith("You are continuing a conversation.")).toBe(true);
    expect(chatHistoryManager.load(client.sessionId)[0]).toMatchObject({
      role: "user",
      text: "Carry on from there",
      agentMessageId: "user-msg-f1",
    });
    expect(sessionManager.get(client.sessionId)?.conversationReplay).toBeUndefined();
    client.close();
  }, 30_000);

  it("stamps a group with its tool results' id, and never with text the CLI wrote itself", async () => {
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Read the file" });
    const claude = await waitForClaude(() => lastClaude);
    claude.initSession("conv-1");
    const event = (raw: Record<string, unknown>) => claude.emit("event", { session_id: "conv-1", ...raw });
    event({ type: "assistant", uuid: "msg-tool", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } });
    event({ type: "user", uuid: "msg-result", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    event({ type: "assistant", uuid: "msg-text", message: { content: [{ type: "text", text: "It says ok." }] } });
    event({ type: "assistant", uuid: "msg-own", is_api_error_message: true, message: { content: [{ type: "text", text: "API Error: 500" }] } });
    claude.finish("conv-1");
    await settled(client.sessionId);

    // No echo arrived (one-shot mode), so the prompt's row has no id.
    expect(chatHistoryManager.load(client.sessionId).map((m) => [m.role, m.agentMessageId])).toEqual([
      ["user", undefined],
      ["assistant", "msg-result"],
      ["assistant", "msg-text"],
    ]);
    client.close();
  }, 30_000);

  it("forks the stored conversation at the kept message, and stores only the id the CLI reports", async () => {
    const client = await TestClient.connect(port);
    const second = await twoTurns(client);
    expect(second.lastSessionId).toBe("conv-1");
    expect(second.lastResumeAt).toBeUndefined();

    client.send({ type: "rewind_at_gap", gapPosition: gapBefore(client.sessionId, "Now the webhook route"), action: "chat" });
    await client.receiveType("rewind_complete");
    expect(sessionManager.get(client.sessionId)).toMatchObject({ agentSessionId: "conv-1", agentResumeAt: "msg-a1" });
    expect(sessionManager.get(client.sessionId)?.conversationReplay).toBeUndefined();

    // A spawn that fails before the CLI reports a conversation leaves the point for the next.
    client.send({ type: "send_message", text: "Try the refunds route" });
    const failed = await waitForClaude(() => lastClaude, second);
    expect(failed.lastSessionId).toBe("conv-1");
    expect(failed.lastResumeAt).toBe("msg-a1");
    failed.emit("error", new Error("Payload Too Large"));
    await settled(client.sessionId);
    expect(sessionManager.get(client.sessionId)).toMatchObject({ agentSessionId: "conv-1", agentResumeAt: "msg-a1" });

    const forked = await runTurn(client, "Refunds route, please", { cliId: "conv-2", uuid: "msg-b1", text: "Added refunds." }, failed);
    expect(forked.lastSessionId).toBe("conv-1");
    expect(forked.lastResumeAt).toBe("msg-a1");
    // Nothing of the conversation is sent again: the CLI forks its own copy.
    expect(forked.lastPrompt).not.toContain(TURN_ONE_TEXT);
    expect(forked.lastSystemPrompt ?? "").not.toContain(TURN_ONE_TEXT);
    expect(sessionManager.get(client.sessionId)?.agentSessionId).toBe("conv-2");
    expect(sessionManager.get(client.sessionId)?.agentResumeAt).toBeUndefined();

    const next = await runTurn(client, "And the invoices", { cliId: "conv-2", uuid: "msg-b2", text: "Done." }, forked);
    expect(next.lastSessionId).toBe("conv-2");
    expect(next.lastResumeAt).toBeUndefined();
    client.close();
  }, 30_000);

  it("forks at the user's message when the rewind keeps a prompt without its reply", async () => {
    const client = await TestClient.connect(port);
    await twoTurns(client);

    client.send({ type: "rewind_at_gap", gapPosition: gapBefore(client.sessionId, "Added the webhook."), action: "chat" });
    await client.receiveType("rewind_complete");
    expect(sessionManager.get(client.sessionId)?.agentResumeAt).toBe("user-msg-a2");
    client.close();
  }, 30_000);

  it("undoes a chat rewind back to the stored conversation as it was", async () => {
    const client = await TestClient.connect(port);
    const second = await twoTurns(client);

    client.send({ type: "rewind_at_gap", gapPosition: gapBefore(client.sessionId, "Now the webhook route"), action: "chat" });
    await client.receiveType("rewind_complete");
    client.send({ type: "rewind_restore_request", sessionId: client.sessionId });
    await client.receiveType("rewind_restored");
    expect(sessionManager.get(client.sessionId)?.agentSessionId).toBe("conv-1");
    expect(sessionManager.get(client.sessionId)?.agentResumeAt).toBeUndefined();

    const next = await runTurn(client, "Carry on", { cliId: "conv-1", uuid: "msg-a3", text: "Carried on." }, second);
    expect(next.lastSessionId).toBe("conv-1");
    expect(next.lastResumeAt).toBeUndefined();
    client.close();
  }, 30_000);

  it("retires an idle resident process, which still holds the conversation from before", async () => {
    const client = await TestClient.connect(port);
    await twoTurns(client);
    const runner = app.runnerRegistry.get(client.sessionId)!;
    const resident = new FakeClaudeProcess();
    runner.setAgent(resident as never);

    client.send({ type: "rewind_at_gap", gapPosition: gapBefore(client.sessionId, "Now the webhook route"), action: "chat" });
    await client.receiveType("rewind_complete");
    expect(resident.killed).toBe(true);
    expect(runner.getAgent()).toBeNull();
    client.close();
  }, 30_000);

  it("keeps the point and names fork when the CLI cannot find it", async () => {
    const client = await TestClient.connect(port);
    const second = await twoTurns(client);
    client.send({ type: "rewind_at_gap", gapPosition: gapBefore(client.sessionId, "Now the webhook route"), action: "chat" });
    await client.receiveType("rewind_complete");

    client.send({ type: "send_message", text: "Go on" });
    const attempt = await waitForClaude(() => lastClaude, second);
    attempt.emit("log", "stderr", "No message found with message.uuid of: msg-a1");
    attempt.emit("event", { type: "result", subtype: "error_during_execution", is_error: true, session_id: "never-written" });
    attempt.emit("done", 1);
    await settled(client.sessionId);

    expect(sessionManager.get(client.sessionId)).toMatchObject({ agentSessionId: "conv-1", agentResumeAt: "msg-a1" });
    const errors = chatHistoryManager.load(client.sessionId).filter((m) => m.isError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toContain("fork the session there");
    client.close();
  }, 30_000);

  it("leaves the conversation alone on a code rewind and tells the next prompt; its undo takes the line back", async () => {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Code rewind" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const git = new GitManager(workspaceDir);
    const initialHead = (await git.getHeadHash())!;
    fs.writeFileSync(path.join(workspaceDir, "feature.txt"), "changed\n");
    const { commitHash } = await git.autoCommit("change feature");
    chatHistoryManager.append(sessionId, { role: "user", text: "change it", agentMessageId: "user-1" });
    chatHistoryManager.append(sessionId, {
      role: "assistant", text: "changed", agentMessageId: "msg-1",
      commitHash: commitHash ?? undefined, parentCommitHash: initialHead,
    });
    sessionManager.setAgentSessionId(sessionId, "conv-1");

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "code" });
    await client.receiveType("rewind_complete");

    const notice = sessionManager.get(sessionId)?.pendingAgentNotice ?? "";
    expect(notice).toContain(`rolled the code back to commit ${initialHead.slice(0, 7)}`);
    expect(notice.split("\n")).toHaveLength(1);
    expect(sessionManager.get(sessionId)).toMatchObject({ agentSessionId: "conv-1" });
    expect(sessionManager.get(sessionId)?.agentResumeAt).toBeUndefined();
    expect(sessionManager.get(sessionId)?.conversationReplay).toBeUndefined();

    client.send({ type: "rewind_restore_request", sessionId });
    await client.receiveType("rewind_restored");
    expect(sessionManager.get(sessionId)?.pendingAgentNotice).toBeUndefined();
    expect(sessionManager.get(sessionId)?.agentSessionId).toBe("conv-1");

    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "code" });
    await client.receiveType("rewind_complete");
    client.send({ type: "send_message", text: "What changed?" });
    const next = await waitForClaude(() => lastClaude);
    expect(next.lastSessionId).toBe("conv-1");
    expect(next.lastResumeAt).toBeUndefined();
    expect(next.lastPrompt).toContain(`rolled the code back to commit ${initialHead.slice(0, 7)}`);
    next.initSession("conv-1");
    next.finish("conv-1");
    await settled(sessionId);
    client.close();
  }, 30_000);

  it("refuses an in-place chat rewind with no message to fork at, and the preview names fork", async () => {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Older chat" } });
    const { sessionId } = res.json() as { sessionId: string };
    // Rows from before ShipIt recorded message ids.
    chatHistoryManager.append(sessionId, { role: "user", text: "first" });
    chatHistoryManager.append(sessionId, { role: "assistant", text: "first reply" });
    chatHistoryManager.append(sessionId, { role: "user", text: "second" });
    sessionManager.setAgentSessionId(sessionId, "conv-1");

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    client.send({ type: "rewind_preview_request", gapPosition: 2, action: "chat" });
    expect(await client.receiveType("rewind_preview")).toMatchObject({
      action: "chat",
      unavailableReason: expect.stringContaining("Fork from here"),
    });
    client.send({ type: "rewind_preview_request", gapPosition: 2, action: "code" });
    expect(await client.receiveType("rewind_preview")).not.toHaveProperty("unavailableReason");

    for (const action of ["chat", "both"] as const) {
      client.send({ type: "rewind_at_gap", gapPosition: 2, action });
      expect(await receiveOneOf(client, ["rewind_complete", "error"])).toMatchObject({
        type: "error",
        message: expect.stringContaining("Fork from here"),
      });
    }
    expect(chatHistoryManager.load(sessionId)).toHaveLength(3);
    expect(sessionManager.get(sessionId)?.agentSessionId).toBe("conv-1");
    expect(sessionManager.get(sessionId)?.agentResumeAt).toBeUndefined();
    client.close();
  }, 30_000);

  it("refuses a rewind to the start of the chat, which has no message to fork at", async () => {
    const client = await TestClient.connect(port);
    await twoTurns(client);

    client.send({ type: "rewind_at_gap", gapPosition: 0, action: "chat" });
    expect(await receiveOneOf(client, ["rewind_complete", "error"])).toMatchObject({
      type: "error",
      message: expect.stringContaining("Fork from here"),
    });
    expect(chatHistoryManager.load(client.sessionId)).toHaveLength(4);
    client.close();
  }, 30_000);

  it("refuses an in-place chat rewind for an agent that cannot fork at a message, and resets no code", async () => {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Codex" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const git = new GitManager(workspaceDir);
    const initialHead = (await git.getHeadHash())!;
    fs.writeFileSync(path.join(workspaceDir, "feature.txt"), "changed\n");
    const { commitHash } = await git.autoCommit("change feature");
    chatHistoryManager.append(sessionId, { role: "user", text: "change it", agentMessageId: "user-1" });
    chatHistoryManager.append(sessionId, {
      role: "assistant", text: "changed", agentMessageId: "msg-1",
      commitHash: commitHash ?? undefined, parentCommitHash: initialHead,
    });
    chatHistoryManager.append(sessionId, { role: "user", text: "and more" });
    sessionManager.setAgentId(sessionId, "codex");

    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    client.send({ type: "rewind_at_gap", gapPosition: 1, action: "both" });
    expect(await receiveOneOf(client, ["rewind_complete", "error"])).toMatchObject({
      type: "error",
      message: expect.stringMatching(/^Codex cannot rewind its conversation in place\. Fork from here/),
    });
    expect(await git.getHeadHash()).toBe(commitHash);
    expect(chatHistoryManager.load(sessionId)).toHaveLength(3);
    client.close();
  }, 30_000);

  it("gives a fork's rows none of the parent's message ids, and the replay leads the child's first prompt", async () => {
    const client = await TestClient.connect(port);
    await twoTurns(client);

    client.send({
      type: "rewind_at_gap",
      gapPosition: gapBefore(client.sessionId, "Now the webhook route"),
      action: "fork",
      sessionName: "Fork",
    });
    const forked = await client.receiveType("session_forked") as { childSessionId: string };
    const childRows = chatHistoryManager.load(forked.childSessionId);
    expect(childRows.map((m) => m.text)).toEqual(["Add the billing routes", TURN_ONE_TEXT]);
    expect(childRows.every((m) => m.agentMessageId === undefined)).toBe(true);
    expect(sessionManager.get(forked.childSessionId)?.conversationReplay).toContain(TURN_ONE_TEXT);
    client.close();
  }, 30_000);
});
