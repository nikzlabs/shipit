/**
 * docs/295 end-to-end: a real merged repository, a real admission, a compaction
 * turn, then the user's turn. Nothing is stubbed except the CLI. The `GET
 * /history` read AFTER the user's turn is the load-bearing assertion: the
 * compaction card and exactly one user row must survive that turn.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import { DatabaseManager } from "../../shared/database.js";

const SESSION_ID = "merged-session";

describe("Integration: the pre-turn compaction of a merged session (docs/295)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let spawns: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-preturn-compact-"));
    credentialStore = createTestCredentialStore(tmpDir);

    // A real repository, so the REAL eligibility predicate runs: merged, clean,
    // HEAD still exactly at the commit GitHub merged.
    sessionDir = path.join(tmpDir, "sessions", SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: sessionDir, encoding: "utf8" }).trim();
    git(["init", "-b", "shipit/fix-login"]);
    // The fixture puts the session's log dir inside the repo; keep the
    // post-turn commit from sweeping it up and moving HEAD past the merge.
    fs.writeFileSync(path.join(sessionDir, ".git", "info", "exclude"), "logs/\n");
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(sessionDir, "a.txt"), "shipped work\n");
    git(["add", "-A"]);
    git(["commit", "-m", "the work that merged"]);
    const mergedHeadSha = git(["rev-parse", "HEAD"]);

    sessionManager = new SessionManager(dbManager);
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    sessionManager.track(SESSION_ID, "Fix login redirect", sessionDir);
    sessionManager.markMerged(SESSION_ID);
    sessionManager.setMergedHeadSha(SESSION_ID, mergedHeadSha);
    sessionManager.setPrStatus(SESSION_ID, {
      sessionId: SESSION_ID,
      prNumber: 482,
      prUrl: "https://github.com/o/r/pull/482",
      prState: "merged",
      baseBranch: "main",
      headBranch: "shipit/fix-login",
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    } as unknown as PrStatusSummary);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const p = new FakeClaudeProcess();
        spawns.push(p);
        return p as never;
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
    } catch { /* cleanup is best-effort */ }
  });

  it("compacts first, then runs the user's turn, and the card SURVIVES that turn", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });

    // 1 — the compaction spawn, driven by the real decision off a real merged repo.
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    expect(compaction.lastPrompt.startsWith("/compact ")).toBe(true);
    expect(compaction.lastPrompt).toContain("merged");
    // The user's message is NOT in the compaction's prompt: this spawn is
    // ShipIt's, and the user's turn has not started.
    expect(compaction.lastPrompt).not.toContain("start the next slice");

    compaction.emit("event", { type: "agent_compacted", preTokens: 19585, postTokens: 10335 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after-compaction" });
    compaction.emit("done", 0);

    // 2 — the user's own turn, spawned only after the compaction ends.
    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn).not.toBe(compaction);
    expect(userTurn.lastPrompt).toContain("start the next slice");
    expect(userTurn.lastCompact).toBeFalsy();

    // 3 — and the turn runs to completion.
    userTurn.initSession("after-compaction");
    userTurn.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });
    userTurn.finish("after-compaction");
    await new Promise((r) => setTimeout(r, 200));

    // The compaction card survives the user's turn.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as {
      messages: { role?: string; text?: string; compaction?: { preTokens?: number } }[];
    };
    const cards = history.messages.filter((m) => m.compaction !== undefined);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.compaction?.preTokens).toBe(19585);

    // 4 — exactly ONE user row: ShipIt started the compaction, so no bubble for it.
    const userRows = history.messages.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.text).toBe("start the next slice");

    // 5 — and the compaction happened once (the re-queued message carries
    // `compactContext: false`; the session itself stays eligible).
    expect(spawns).toHaveLength(2);

    client.close();
  });

  it("compacts a message that had to QUEUE behind a running turn (req 4)", async () => {
    // The first send opts out of both actions, so it runs at once and leaves
    // the session eligible. The second, sent while it runs, queues — and must
    // still get its compaction when it drains.
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "first", compactContext: false, resetMergedBranch: false });
    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(first.lastPrompt).toContain("first");
    first.initSession("agent-a");

    client.send({ type: "send_message", text: "second", compactContext: true });
    await client.receiveType("message_queued");

    first.finish("agent-a");
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never), first);
    expect(compaction.lastCompact).toBe(true);
    expect(compaction.lastPrompt).not.toContain("second");
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("second");
    expect(userTurn.lastCompact).toBeFalsy();
    expect(spawns).toHaveLength(3);

    client.close();
  });

  it("queues a second send that arrives while the first is still being decided", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "first", compactContext: true });
    // Unticked so this fixture (no `origin/main`, so the reset is refused and
    // the session stays eligible) does not compact a second time.
    client.send({ type: "send_message", text: "second", compactContext: false });

    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    expect(spawns).toHaveLength(1);
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    compaction.emit("done", 0);

    // first, then second — in order, each as its own turn.
    const firstTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(firstTurn.lastPrompt).toContain("first");
    expect(firstTurn.lastPrompt).not.toContain("second");
    firstTurn.initSession("after");
    firstTurn.finish("after");
    const secondTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), firstTurn);
    expect(secondTurn.lastPrompt).toContain("second");
    expect(secondTurn.lastCompact).toBeFalsy();

    client.close();
  });

  /** Poll until the resident process has been handed `text` via stdin. */
  async function stdinHas(p: FakeClaudeProcess, text: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!p.stdinData.some((d) => d.includes(text))) {
      if (Date.now() - start > timeoutMs) throw new Error(`"${text}" never reached stdin`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("with live steering: a streaming compaction reuses the resident process and releases the system-turn flag", async () => {
    // The compaction turn strips no listeners of its own, but the turn that
    // follows it reuses the same resident process and removes the compaction's
    // listeners — including the `done` that would have cleared
    // `systemTurnInProgress`. Observable: a send during the user's turn must
    // still be STEERED (the flag is down), not queued forever.
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    // Turn 0 leaves a resident streaming process behind.
    client.send({ type: "send_message", text: "warm up", compactContext: false, resetMergedBranch: false });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(resident.lastUseStreaming).toBe(true);
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    // The compaction rides the resident.
    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    await stdinHas(resident, "/compact ");
    expect(spawns).toHaveLength(1);
    resident.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });

    // …and so does the user's turn.
    await stdinHas(resident, "start the next slice");

    // A send during the user's turn is steered into it: the flag is down.
    client.send({ type: "send_message", text: "and also this" });
    await client.receiveType("message_steered");
    await stdinHas(resident, "and also this");

    client.close();
  });

  it("with live steering: a send during the decision queues, it is not steered into the idle resident", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "warm up", compactContext: false, resetMergedBranch: false });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    client.send({ type: "send_message", text: "first", compactContext: true });
    client.send({ type: "send_message", text: "second", compactContext: false });
    await client.receiveType("message_queued");
    await stdinHas(resident, "/compact ");
    // Nothing of the second message reached the process ahead of the first.
    expect(resident.stdinData.some((d) => d.includes("second"))).toBe(false);

    resident.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await stdinHas(resident, "first");
    expect(resident.stdinData.some((d) => d.includes("second"))).toBe(false);

    client.close();
  });

  it("still runs the message when the user STOPS the compaction (req 9)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);

    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");
    // The fake exits with code 1 after an interrupt (see `interrupt()`).
    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("start the next slice");
    expect(userTurn.lastCompact).toBeFalsy();
    userTurn.initSession("after");
    userTurn.finish("after");
    await new Promise((r) => setTimeout(r, 200));

    // The stop left no card and no error; the transcript still says so.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as { messages: { notice?: boolean; text?: string }[] };
    expect(history.messages.filter((m) => m.notice && m.text?.includes("not compacted"))).toHaveLength(1);

    client.close();
  });

  it("says so in the transcript when the compaction turn ends with no compaction (req 9)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    // Exits 0 with a result and no `agent_compacted`.
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    compaction.emit("done", 0);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("start the next slice");
    userTurn.initSession("after");
    userTurn.finish("after");
    await new Promise((r) => setTimeout(r, 200));

    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as { messages: { notice?: boolean; noticeLevel?: string; text?: string; compaction?: unknown }[] };
    expect(history.messages.filter((m) => m.compaction !== undefined)).toHaveLength(0);
    const notices = history.messages.filter((m) => m.notice);
    const missed = notices.filter((m) => m.text?.includes("not compacted"));
    expect(missed).toHaveLength(1);
    expect(missed[0]?.noticeLevel).toBe("warn");

    client.close();
  });

  it("carries an upload to the user's turn exactly once", async () => {
    // The takeover queues the RAW send; the drain resolves the upload. Queuing
    // the resolved copies as well would hand the file to the agent twice.
    const uploadsDir = path.join(path.dirname(sessionDir), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "notes.txt"), "UPLOAD-MARKER-7f3a\n");
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({
      type: "send_message",
      text: "start the next slice",
      compactContext: true,
      uploads: [{ path: "/uploads/notes.txt", type: "upload" }],
    });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastPrompt).not.toContain("UPLOAD-MARKER-7f3a");
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    compaction.emit("done", 0);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt.split("UPLOAD-MARKER-7f3a")).toHaveLength(2);

    client.close();
  });

  it("does not compact when the message is the user's own `/compact` (req 12)", async () => {
    // They asked for exactly one compaction. Prefixing theirs with ours would
    // make it two, and the second would summarize the summary.
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "/compact" });

    const only = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(only.lastCompact).toBe(true);
    expect(only.lastPrompt).toBe("/compact");
    expect(spawns).toHaveLength(1);

    client.close();
  });

  it("does not compact when the user unticked the control for that message (req 5)", async () => {
    // Same eligible session, same send, one field different — so a pass here
    // cannot be the eligibility gate refusing for its own reasons.
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: "start the next slice", compactContext: false });

    const only = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(only.lastCompact).toBeFalsy();
    expect(only.lastPrompt).toContain("start the next slice");
    expect(spawns).toHaveLength(1);

    client.close();
  });
});
