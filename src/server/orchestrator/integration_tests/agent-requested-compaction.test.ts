// docs/324-agent-requested-compaction — end to end: the route records the request, the turn
// that asked ends, a silent compaction turn runs, and the agent continues with its note.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const SESSION_ID = "compacting-session";

describe("Integration: a compaction the agent asked for (docs/324-agent-requested-compaction)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let spawns: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-agent-compact-"));
    const sessionDir = path.join(tmpDir, "sessions", SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = (args: string[]): void => { execFileSync("git", args, { cwd: sessionDir, stdio: "pipe" }); };
    git(["init", "-b", "shipit/features"]);
    fs.writeFileSync(path.join(sessionDir, ".git", "info", "exclude"), "logs/\n");
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(sessionDir, "a.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);

    sessionManager = new SessionManager(dbManager);
    sessionManager.track(SESSION_ID, "Two features", sessionDir);
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setDeclaredSetting("advanced.agentCompaction", true);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
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

  const request = (sessionId: string, body: object) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/compact-after-turn`, payload: body });

  it("compacts after the requesting turn, silently, then continues with the note and the instructions", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    client.send({ type: "send_message", text: "build feature A" });
    const featureA = await waitForClaude(() => spawns.at(-1) ?? (null as never));

    // Mid-turn, as `shipit compact` does it: the request is recorded, nothing runs yet.
    const res = await request(SESSION_ID, { instructions: "keep the API contract", note: "start feature B" });
    expect(res.statusCode).toBe(200);
    expect(spawns).toHaveLength(1);

    featureA.initSession("agent-a");
    featureA.finish("agent-a");

    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never), featureA);
    expect(compaction.lastCompact).toBe(true);
    expect(compaction.lastPrompt.startsWith("/compact keep the API contract")).toBe(true);
    expect(sessionManager.getPendingCompaction(SESSION_ID)).toBeUndefined();

    compaction.emit("event", { type: "agent_compacted", preTokens: 5000, postTokens: 900 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);

    const featureB = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(featureB.lastCompact).toBeFalsy();
    expect(featureB.lastPrompt).toContain("start feature B");
    expect(featureB.lastPrompt).toContain("keep the API contract");
    featureB.finish("agent-a");
    await new Promise((r) => setTimeout(r, 200));

    const history = (await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` })).json() as {
      messages: { role?: string; text?: string; compaction?: unknown }[];
    };
    expect(history.messages.filter((m) => m.compaction !== undefined)).toHaveLength(1);
    // The compaction is ShipIt's own turn: it adds no user row of its own.
    expect(history.messages.some((m) => m.role === "user" && m.text?.startsWith("/compact"))).toBe(false);
    client.close();
  });

  it("Stop during the compaction: the compaction ends and the agent does not continue (req 10)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    client.send({ type: "send_message", text: "build feature A" });
    const featureA = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    await request(SESSION_ID, { instructions: "keep the API contract", note: "start feature B" });
    featureA.initSession("agent-a");
    featureA.finish("agent-a");

    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never), featureA);
    expect(compaction.lastCompact).toBe(true);
    client.send({ type: "interrupt_agent" });
    await new Promise((r) => setTimeout(r, 100));
    expect(compaction.interrupted).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    expect(spawns).toHaveLength(2);
    // The instructions still reach the user's next turn.
    client.send({ type: "send_message", text: "what next?" });
    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(next.lastPrompt).toContain("keep the API contract");
    expect(next.lastPrompt).not.toContain("start feature B");
    client.close();
  });

  it("is refused while the setting is off, which is its default (req 11)", async () => {
    credentialStore.setDeclaredSetting("advanced.agentCompaction", false);
    const res = await request(SESSION_ID, { instructions: "keep A" });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toContain("advanced.agentCompaction");
    expect(sessionManager.getPendingCompaction(SESSION_ID)).toBeUndefined();
  });

  it("refuses a harness that cannot compact, an unknown session and overlong text", async () => {
    expect((await request("no-such-session", {})).statusCode).toBe(404);
    expect((await request(SESSION_ID, { note: "x".repeat(4001) })).statusCode).toBe(400);
    sessionManager.setAgentId(SESSION_ID, "antigravity");
    expect((await request(SESSION_ID, { instructions: "keep A" })).statusCode).toBe(409);
    expect(sessionManager.getPendingCompaction(SESSION_ID)).toBeUndefined();
  });
});
