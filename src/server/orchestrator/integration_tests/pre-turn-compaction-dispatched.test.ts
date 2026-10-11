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
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import type { PrStatusSummary } from "../../shared/types/github-types.js";
import { DatabaseManager } from "../../shared/database.js";

const SESSION_ID = "merged-session";
const INTERFACE = { source: "agent_interface_sdk", surface: "present" } as const;

describe("Integration: a dispatched message on a merged session with a real origin (docs/295)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let spawns: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;
  let baseTip: string;
  let markMerged: () => void;

  const gitIn = (cwd: string, args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-preturn-dispatched-"));
    credentialStore = createTestCredentialStore(tmpDir);
    const now = Date.now();
    credentialStore.upsertCredentialRoute({
      id: "acct-added-claude",
      serviceId: "anthropic", billingMode: "sub", via: "account",
      label: "Added Claude subscription",
      isPrimary: true,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });

    const originDir = path.join(tmpDir, "origin.git");
    fs.mkdirSync(originDir, { recursive: true });
    gitIn(originDir, ["init", "--bare", "-b", "main"]);

    const identity = (dir: string): void => {
      gitIn(dir, ["config", "user.email", "t@example.com"]);
      gitIn(dir, ["config", "user.name", "Test"]);
    };

    sessionDir = path.join(tmpDir, "sessions", SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    gitIn(sessionDir, ["init", "-b", "main"]);
    identity(sessionDir);
    gitIn(sessionDir, ["remote", "add", "origin", originDir]);
    fs.writeFileSync(path.join(sessionDir, ".git", "info", "exclude"), "logs/\n");
    fs.writeFileSync(path.join(sessionDir, "base.txt"), "base\n");
    gitIn(sessionDir, ["add", "-A"]);
    gitIn(sessionDir, ["commit", "-m", "base"]);
    gitIn(sessionDir, ["push", "origin", "main"]);
    gitIn(sessionDir, ["checkout", "-b", "shipit/fix-login"]);
    fs.writeFileSync(path.join(sessionDir, "a.txt"), "shipped work\n");
    gitIn(sessionDir, ["add", "-A"]);
    gitIn(sessionDir, ["commit", "-m", "the work that merged"]);
    gitIn(sessionDir, ["push", "origin", "shipit/fix-login"]);
    const mergedHeadSha = gitIn(sessionDir, ["rev-parse", "HEAD"]);

    // The squash merge lands on origin only; the session's `origin/main` stays stale.
    const upstream = path.join(tmpDir, "upstream");
    execFileSync("git", ["clone", originDir, upstream], { encoding: "utf8" });
    identity(upstream);
    fs.writeFileSync(path.join(upstream, "a.txt"), "shipped work\n");
    gitIn(upstream, ["add", "-A"]);
    gitIn(upstream, ["commit", "-m", "the work that merged (#482)"]);
    gitIn(upstream, ["push", "origin", "main"]);
    baseTip = gitIn(upstream, ["rev-parse", "HEAD"]);

    sessionManager = new SessionManager(dbManager);
    const chatHistoryManager = new ChatHistoryManager(dbManager);
    sessionManager.track(SESSION_ID, "Fix login redirect", sessionDir);
    markMerged = () => {
      sessionManager.markMerged(SESSION_ID);
      sessionManager.setMergedHeadSha(SESSION_ID, mergedHeadSha);
    };
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
      credentialsDir: path.join(tmpDir, "credentials"),
      repoStore: new RepoStore(dbManager),
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

  const dispatch = async (text: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent/dispatch`,
      payload: { text, agentInterface: INTERFACE, ...extra },
    });
    expect(res.statusCode).toBe(200);
  };

  const finishCompaction = (compaction: FakeClaudeProcess): void => {
    compaction.emit("event", { type: "agent_compacted", preTokens: 100, postTokens: 50 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);
  };

  const finishTurn = async (turn: FakeClaudeProcess): Promise<void> => {
    turn.initSession("agent-a");
    turn.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });
    turn.finish("agent-a");
    await new Promise((r) => setTimeout(r, 300));
  };

  const head = (): string => gitIn(sessionDir, ["rev-parse", "HEAD"]);

  it("compacts, resets the branch, and ends the offer for this merge", async () => {
    markMerged();
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    await dispatch("first from the page");
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    finishCompaction(compaction);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("automatically reset to the latest origin/main");
    expect(userTurn.lastPrompt).toContain("first from the page");
    expect(head()).toBe(baseTip);
    expect(sessionManager.get(SESSION_ID)?.mergedAt).toBeUndefined();
    await finishTurn(userTurn);

    await dispatch("second from the page");
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), userTurn);
    expect(next.lastPrompt).toContain("second from the page");
    expect(spawns.filter((s) => s.lastCompact)).toHaveLength(1);

    client.close();
  });

  it("obeys the untick it carries: no compaction, and the branch still resets (req 14)", async () => {
    markMerged();
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    await dispatch("from the page", { compactContext: false });
    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(userTurn.lastCompact).toBeFalsy();
    expect(userTurn.lastPrompt).toContain("automatically reset to the latest origin/main");
    expect(head()).toBe(baseTip);
    expect(spawns.some((s) => s.lastCompact)).toBe(false);

    client.close();
  });

  it("with live steering: retires the resident process, compacts, and resets the branch", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    client.send({ type: "send_message", text: "warm up" });
    const resident = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(resident.lastUseStreaming).toBe(true);
    resident.doneOnKill = true;
    resident.initSession("agent-a");
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await client.receiveType("session_status");

    // The merge lands between turns, with the resident process still alive.
    markMerged();
    await dispatch("first from the page");
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never), resident);
    expect(compaction.lastCompact).toBe(true);
    expect(resident.killed).toBe(true);
    finishCompaction(compaction);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("automatically reset to the latest origin/main");
    expect(head()).toBe(baseTip);
    expect(sessionManager.get(SESSION_ID)?.mergedAt).toBeUndefined();

    client.close();
  });

  it("says why when the reset fails, and no later message compacts or resets for the same merge", async () => {
    markMerged();
    fs.renameSync(path.join(tmpDir, "origin.git"), path.join(tmpDir, "origin-gone.git"));
    const mergedHead = head();
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();

    await dispatch("first from the page");
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    expect(compaction.lastCompact).toBe(true);
    finishCompaction(compaction);

    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn.lastPrompt).toContain("NOT reset to origin/main");
    expect(userTurn.lastPrompt).toContain("the reset could not be completed");
    expect(head()).toBe(mergedHead);
    await finishTurn(userTurn);

    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as { messages: { text?: string; notice?: { text?: string } }[] };
    expect(JSON.stringify(history.messages)).toContain("the reset could not be completed");

    // Still merged and on the merged head, which read as eligible before. The origin is
    // reachable again, so a reset that was still on offer would now move the branch.
    expect(sessionManager.get(SESSION_ID)?.mergedAt).toBeDefined();
    fs.renameSync(path.join(tmpDir, "origin-gone.git"), path.join(tmpDir, "origin.git"));
    await dispatch("second from the page");
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), userTurn);
    expect(next.lastPrompt).toContain("second from the page");
    expect(next.lastPrompt).toContain("NOT reset to origin/main");
    expect(spawns.filter((s) => s.lastCompact)).toHaveLength(1);
    expect(head()).toBe(mergedHead);

    client.close();
  });
});
