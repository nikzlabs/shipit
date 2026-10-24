import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitFor,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import { DatabaseManager } from "../../shared/database.js";
import type { UsageManager } from "../usage.js";
import type { QueuedMessage, SessionRunnerInterface } from "../session-runner.js";
import { takeSessionHold } from "../session-hold.js";

const SESSION_ID = "merged-session";
const REPO_URL = "https://github.com/o/r.git";

describe("Integration: the pre-turn compaction of a merged session (docs/295)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let spawns: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;
  let repoStore: RepoStore;
  /**
   * A setup turn on a merged session spends the compaction offer (docs/218 req 6),
   * so a test that needs one runs it before the merge lands, as a real session does.
   */
  let beforeMerge: () => void;
  let mergeLands: () => void;
  /** While set, the git reads of a claimed turn wait: the window in which a turn sets up. */
  let setupGate: Promise<void> | null = null;

  function gatedGit(git: GitManager): GitManager {
    return new Proxy(git, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const gate = app.runnerRegistry.get(SESSION_ID)?.running ? setupGate : null;
          const call = () => (value as (...a: unknown[]) => unknown).apply(target, args);
          if (!gate) return call();
          return (async () => {
            await gate;
            return call();
          })();
        };
      },
    });
  }

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    setupGate = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-preturn-compact-"));
    credentialStore = createTestCredentialStore(tmpDir);

    sessionDir = path.join(tmpDir, "sessions", SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: sessionDir, encoding: "utf8" }).trim();
    git(["init", "-b", "shipit/fix-login"]);
    // Exclude fixture logs so auto-commit does not advance the merged HEAD.
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
    mergeLands = () => {
      sessionManager.markMerged(SESSION_ID);
      sessionManager.setMergedHeadSha(SESSION_ID, mergedHeadSha);
    };
    beforeMerge = () => { sessionManager.clearMerged(SESSION_ID, null); };
    mergeLands();
    sessionManager.setPrStatus(SESSION_ID, {
      sessionId: SESSION_ID,
      prNumber: 482,
      prUrl: "https://github.com/o/r/pull/482",
      prState: "merged",
      baseBranch: "main",
      headBranch: "shipit/fix-login",
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
    } as unknown as PrStatusSummary);

    repoStore = new RepoStore(dbManager);

    app = await buildApp({
      credentialStore,
      repoStore,
      createGitManager: (dir: string) => gatedGit(new GitManager(dir)),
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
    await client.receive();

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });

    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    expect(compaction.lastPrompt.startsWith("/compact ")).toBe(true);
    expect(compaction.lastPrompt).toContain("merged");
    expect(compaction.lastPrompt).not.toContain("start the next slice");

    compaction.emit("event", { type: "agent_compacted", preTokens: 19585, postTokens: 10335 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after-compaction" });
    compaction.emit("done", 0);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn).not.toBe(compaction);
    expect(userTurn.lastPrompt).toContain("start the next slice");
    expect(userTurn.lastCompact).toBeFalsy();

    userTurn.initSession("after-compaction");
    userTurn.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });
    userTurn.finish("after-compaction");
    await new Promise((r) => setTimeout(r, 200));

    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as {
      messages: { role?: string; text?: string; compaction?: { preTokens?: number } }[];
    };
    const cards = history.messages.filter((m) => m.compaction !== undefined);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.compaction?.preTokens).toBe(19585);

    const userRows = history.messages.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.text).toBe("start the next slice");

    expect(spawns).toHaveLength(2);

    client.close();
  });

  it("compacts a message that had to QUEUE behind a running turn (req 4)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    beforeMerge();
    client.send({ type: "send_message", text: "first" });
    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(first.lastPrompt).toContain("first");
    first.initSession("agent-a");

    mergeLands();
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

  /**
   * docs/218 req 6 — only the first message after the merge can trigger either
   * action. The declined turn leaves the session merged, clean and still on
   * `mergedHeadSha`, which is exactly the eligible state, so before the decline
   * was recorded the NEXT message reset the branch and compacted the context —
   * with no control on screen by then to stop it.
   */
  it("does not compact a later message once the user declined this merge (docs/218 req 6)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "first", compactContext: false, resetMergedBranch: false });
    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    first.initSession("agent-a");
    first.finish("agent-a");
    await client.receiveType("session_status");

    // No flags at all: its control is gone, so an absent `compactContext` would
    // otherwise fall back to the global setting, which is on.
    client.send({ type: "send_message", text: "second" });
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), first);
    expect(next.lastCompact).toBeFalsy();
    expect(next.lastPrompt).toContain("second");
    // Assert the compaction, not the spawn count: a finished turn also produces
    // a promptless spawn of its own, which is not what this is about.
    expect(spawns.some((s) => s.lastCompact)).toBe(false);

    client.close();
  });

  /**
   * docs/218 req 6 again, for an offer that was ACCEPTED. The fixture has no
   * origin, so the reset fails and the session stays merged, clean and on
   * `mergedHeadSha` — which read as eligible, and the next message compacted again.
   */
  it("compacts one time for a merge, also when the branch reset did not happen (docs/218 req 6)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "first" });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);

    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(first.lastPrompt).toContain("first");
    first.initSession("agent-a");
    first.finish("agent-a");
    await client.receiveType("session_status");
    await new Promise((r) => setTimeout(r, 200));

    client.send({ type: "send_message", text: "second" });
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), first);
    expect(next.lastCompact).toBeFalsy();
    expect(next.lastPrompt).toContain("second");
    expect(spawns.filter((s) => s.lastCompact)).toHaveLength(1);

    client.close();
  });

  it("does not compact a later message when the first unticked it and its reset failed (docs/218 req 6)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "first", compactContext: false });
    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(first.lastCompact).toBeFalsy();
    first.initSession("agent-a");
    first.finish("agent-a");
    await client.receiveType("session_status");
    await new Promise((r) => setTimeout(r, 200));

    client.send({ type: "send_message", text: "second" });
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), first);
    expect(next.lastPrompt).toContain("second");
    expect(spawns.some((s) => s.lastCompact)).toBe(false);

    client.close();
  });

  /**
   * An automatic turn whose steer the CLI did not take comes back as an "interactive"
   * queue entry (`steerToQueuedMessage`), so this drain decides for it, not the dispatched one.
   */
  it("does not compact a typed message under 200K tokens, though its box is ticked (req 15)", async () => {
    (app as unknown as { usageManager: UsageManager }).usageManager
      .record(SESSION_ID, 0, 1000, 100, 10, { contextTokens: 199_999 });
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "next slice", compactContext: true });
    const turn = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(turn.lastPrompt).toContain("next slice");
    expect(spawns.some((s) => s.lastCompact)).toBe(false);

    client.close();
  });

  it("applies the 200K floor to an automatic entry that this drain runs (req 15)", async () => {
    beforeMerge();
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "first" });
    const first = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    first.initSession("agent-a");

    mergeLands();
    const internals = app as unknown as {
      usageManager: UsageManager;
      runnerRegistry: { get(id: string): { enqueue(m: QueuedMessage): number } | undefined };
    };
    internals.usageManager.record(SESSION_ID, 0, 1000, 100, 10, { contextTokens: 20_000 });
    internals.runnerRegistry.get(SESSION_ID)!
      .enqueue({ text: "fix the preview errors", execution: "interactive", automatic: true });

    first.finish("agent-a");
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), first);
    expect(next.lastPrompt).toContain("fix the preview errors");
    expect(spawns.some((s) => s.lastCompact)).toBe(false);

    client.close();
  });

  it("queues a second send that arrives while the first is still being decided", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "first", compactContext: true });
    client.send({ type: "send_message", text: "second", compactContext: false });

    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    expect(spawns).toHaveLength(1);
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "after" });
    compaction.emit("done", 0);

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

  async function stdinHas(p: FakeClaudeProcess, text: string, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!p.stdinData.some((d) => d.includes(text))) {
      if (Date.now() - start > timeoutMs) throw new Error(`"${text}" never reached stdin`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("with live steering: a streaming compaction reuses the resident process and the message steers its turn", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    beforeMerge();
    client.send({ type: "send_message", text: "warm up" });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(resident.lastUseStreaming).toBe(true);
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    mergeLands();
    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    await stdinHas(resident, "/compact ");
    expect(spawns).toHaveLength(1);
    resident.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });

    await stdinHas(resident, "start the next slice");

    client.send({ type: "send_message", text: "and also this" });
    await client.receiveType("message_steered");
    await stdinHas(resident, "and also this");

    client.close();
  });

  // The compaction turn's drain runs again when the CLI starts a turn of its own after it, and
  // that turn's reset cleared the cards: the compaction is checked for once, at its own end.
  it("with live steering: says nothing about a compaction that ran when the CLI starts a turn after it", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    beforeMerge();
    client.send({ type: "send_message", text: "warm up" });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    mergeLands();
    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    await stdinHas(resident, "/compact ");
    // A rebase takes the session, so the message that waits for the compaction stays queued.
    const runner = (app as unknown as { runnerRegistry: { get(id: string): SessionRunnerInterface } })
      .runnerRegistry.get(SESSION_ID);
    const hold = takeSessionHold(runner);
    resident.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    // At once, before the compaction's own drain: the reset clears the cards first.
    resident.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
    await new Promise((r) => setTimeout(r, 50));
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    const deadline = Date.now() + 3000;
    while ((runner.running || runner.postTurnWorkInFlight) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runner.running || runner.postTurnWorkInFlight).toBe(false);
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as { messages: { notice?: boolean; text?: string }[] };
    expect(history.messages.filter((m) => m.notice && m.text?.includes("not compacted"))).toHaveLength(0);
    hold.release();
    client.close();
  });

  it("with live steering: a send during the decision waits, and follows the first message into its turn", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    beforeMerge();
    client.send({ type: "send_message", text: "warm up" });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    mergeLands();
    client.send({ type: "send_message", text: "first", compactContext: true });
    client.send({ type: "send_message", text: "second", compactContext: false });
    await client.receiveType("message_queued");
    await stdinHas(resident, "/compact ");
    expect(resident.stdinData.some((d) => d.includes("second"))).toBe(false);

    resident.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await stdinHas(resident, "first");
    // docs/329-user-steers-every-turn req 2 — not before the message that waited for the
    // compaction, and not after that message's whole turn.
    await stdinHas(resident, "second");
    const written = resident.stdinData.join("\n");
    expect(written.indexOf("first")).toBeLessThan(written.indexOf("second"));

    client.close();
  });

  it("returns the message to the input box when the user STOPS the compaction (docs/330)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);

    client.send({ type: "interrupt_agent" });
    const returned = await client.collectUntil((m) => m.type === "agent_interrupted");
    expect(returned.find((m) => m.type === "queue_updated" && m.returned)).toMatchObject({
      queue: [],
      returned: [{ text: "start the next slice" }],
    });
    await new Promise((r) => setTimeout(r, 300));
    // Nothing starts by itself: the message is the user's to send again.
    expect(spawns.at(-1)).toBe(compaction);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as { messages: { notice?: boolean; text?: string }[] };
    expect(history.messages.filter((m) => m.notice && m.text?.includes("not compacted"))).toHaveLength(1);

    client.close();
  });

  it("returns the message when the Stop comes while its turn sets up, before the compaction (docs/330)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    let openGate!: () => void;
    setupGate = new Promise<void>((resolve) => { openGate = resolve; });

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    await waitFor(() => app.runnerRegistry.get(SESSION_ID)?.running === true, "the turn is claimed");
    // The message is in no queue yet: the Stop finds nothing to return.
    client.send({ type: "interrupt_agent" });
    await client.receiveType("agent_interrupted");
    setupGate = null;
    openGate();

    const events = await client.collectUntil((m) => m.type === "queue_updated" && m.returned !== undefined);
    expect(events.find((m) => m.type === "queue_updated" && m.returned)).toMatchObject({
      queue: [],
      returned: [{ text: "start the next slice" }],
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(spawns.filter((p) => p.lastPrompt.includes("start the next slice"))).toEqual([]);

    client.close();
  });

  it("says so in the transcript when the compaction turn ends with no compaction (req 9)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "start the next slice", compactContext: true });
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
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
    const uploadsDir = path.join(path.dirname(sessionDir), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "notes.txt"), "UPLOAD-MARKER-7f3a\n");
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

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
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "/compact" });

    const only = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(only.lastCompact).toBe(true);
    expect(only.lastPrompt).toBe("/compact");
    expect(spawns).toHaveLength(1);

    client.close();
  });

  it("does not compact when the user unticked the control for that message (req 5)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "start the next slice", compactContext: false });

    const only = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(only.lastCompact).toBeFalsy();
    expect(only.lastPrompt).toContain("start the next slice");
    expect(spawns).toHaveLength(1);

    client.close();
  });

  /**
   * A send activates the session, and activation used to push a freshly
   * computed `reset_eligible`. That answer is a PRE-turn one that this very
   * message is about to invalidate, and it landed on the composer about 10 ms
   * after the send — cancelling the optimistic hide and putting both controls
   * back on screen, re-ticked, while the turn they belonged to was still
   * running. A viewer arriving still gets the signal; a send no longer
   * manufactures one.
   */
  it("does not echo reset_eligible back at a send (the controls stay hidden for the turn)", async () => {
    // Eligibility is only signalled for a repo-backed session, and a send is
    // only accepted for a trusted repo.
    repoStore.add(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);
    sessionManager.setRemoteUrl(SESSION_ID, REPO_URL);

    const client = await TestClient.connect(port, SESSION_ID);
    // A viewer arriving is told: this is what puts the controls on screen.
    const onConnect = await client.receiveType("reset_eligible");
    expect(onConnect).toMatchObject({ sessionId: SESSION_ID, eligible: true });

    client.send({ type: "send_message", text: "start the next slice", compactContext: false });
    await waitForClaude(() => spawns.at(-1) ?? (null as never));

    const duringTurn = await client.drain({ quietMs: 300, maxMs: 2000 });
    expect(duringTurn.filter((m) => m.type === "reset_eligible")).toEqual([]);

    client.close();
  });
});
