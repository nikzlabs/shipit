/**
 * docs/295 end-to-end — real admission, a real compaction, and the user's turn
 * after it.
 *
 * This is the test that outlived the implementation. It was written against a
 * design where the compaction ran nested INSIDE the user's send, as a
 * slot-owning operation with its own admission hold; it passes unchanged against
 * the one that shipped, where the compaction is an ordinary `/compact` turn and
 * the user's message simply queues behind it. That is the point of asserting on
 * observable behaviour — two spawns in order, one user row, and a `GET /history`
 * read AFTER the user's turn finishes — rather than on the machinery.
 *
 * The history read is the load-bearing one. The nested design recorded the
 * compaction card against a turn that had not started, so the user's turn
 * deleted it at its first `replaceInProgress`: it rendered live and was gone on
 * reload. Every unit-level assertion about that card passed, because the unit
 * harness manufactured the state the design had assumed. Nothing is stubbed here
 * except the CLI itself.
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

    // 1 — the compaction spawn, driven by the real hook off a real merged repo.
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

    // 2 — the user's own turn, spawned only now, into the slot the operation
    // handed back.
    const userTurn = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(userTurn).not.toBe(compaction);
    expect(userTurn.lastPrompt).toContain("start the next slice");
    expect(userTurn.lastCompact).toBeFalsy();

    // 3 — and the turn runs to completion, which is where its first
    // `replaceInProgress` deletes every in-progress row the session has.
    userTurn.initSession("after-compaction");
    userTurn.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "On it." }] } });
    userTurn.finish("after-compaction");
    await new Promise((r) => setTimeout(r, 200));

    // THE assertion. A card recorded in-band would be gone by here — rendered
    // live, absent on reload, which is what shipped through two review rounds.
    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` });
    const history = res.json() as {
      messages: { role?: string; text?: string; compaction?: { preTokens?: number } }[];
    };
    const cards = history.messages.filter((m) => m.compaction !== undefined);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.compaction?.preTokens).toBe(19585);

    // 4 — and there is exactly ONE user row: the message the user actually
    // typed. ShipIt started the compaction, so a `/compact …` bubble for it
    // would be a message nobody sent.
    const userRows = history.messages.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.text).toBe("start the next slice");

    // 5 — and the compaction happened once. The user's message goes back on the
    // queue carrying `compactContext: false`, which is what stops the drain
    // deciding to compact for it all over again — an eligible session stays
    // eligible, so without that the two would ping-pong forever.
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
