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
