/**
 * Integration tests for the async notify-on-merge watch (docs/196).
 *
 * Exercises the orchestrator end of the chain end-to-end through `buildApp`:
 *
 *   POST /api/sessions/:parentId/children/:childId/notify-on-merge   (arm)
 *   → the PR poller observes the child's PR reach a terminal state
 *     (simulated here by invoking the wired `mergeWatchManager` directly, the
 *     same entrypoint the poller's `onPrTerminalState` hook calls)
 *   → a persisted "Child PR merged / closed" card lands in the PARENT's history
 *   → a self-describing system turn is enqueued into the PARENT's runner.
 *
 * The poller's terminal-state detection → `onPrTerminalState` wire is covered
 * separately in `pr-status-poller.test.ts`; the manager's state machine
 * (fire-once, idle/busy parent, reconcile) in `merge-watch.test.ts`. Here we
 * prove the HTTP register route + the real runner-registry / chat-history
 * delivery in a fully-wired app.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/notify-on-merge-test.git";

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: notify-on-merge watch (docs/196)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;
  let spawnedAgents: FakeClaudeProcess[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-notify-merge-"));
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    spawnedAgents = [];

    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    const credentialStore = createTestCredentialStore(tmpDir);
    seedRepoCacheWithLocalBare({ tmpDir, repoUrl: REPO_URL, seedFiles: { "README.md": "# x\n" } });
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => {
        const a = new FakeClaudeProcess();
        spawnedAgents.push(a);
        return a as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    await new Promise((r) => setTimeout(r, 50));
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
  });

  async function createParent(title = "Parent"): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title } });
    expect(res.statusCode).toBe(200);
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Parent\n");
    execSync("git add README.md && git -c user.email=t@t.com -c user.name=T commit -m init", { cwd: workspaceDir });
    sessionManager.setRemoteUrl(sessionId, REPO_URL);
    return sessionId;
  }

  async function spawnChild(parentId: string, title = "Child API"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: "Build the foundation", title, spawnedByTurn: "turn-1" },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  function armWatch(parentId: string, childId: string) {
    return app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/children/${childId}/notify-on-merge`,
    });
  }

  async function parentCardOutcomes(parentId: string): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/history` });
    const messages = (res.json() as { messages: { childMerged?: { outcome: string } }[] }).messages;
    return messages.filter((m) => m.childMerged).map((m) => m.childMerged!.outcome);
  }

  it("arms a watch via the register route", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);

    const res = await armWatch(parentId, childId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ armed: true, state: "armed" });
    expect(sessionManager.getMergeWatch(childId)?.state).toBe("armed");
    expect(sessionManager.getMergeWatch(childId)?.parentSessionId).toBe(parentId);
  });

  it("rejects watching a session this parent did not spawn (cross-tenancy 404)", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const otherParent = await createParent("Other");
    const strangerChild = await spawnChild(otherParent);

    const res = await armWatch(parentId, strangerChild);
    expect(res.statusCode).toBe(404);
    expect(sessionManager.getMergeWatch(strangerChild)).toBeUndefined();
  });

  it("merged: surfaces the parent card + dispatches the wake-turn, marks delivered only once it runs", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    await app.mergeWatchManager!.handleChildPrTerminal({
      sessionId: childId,
      outcome: "merged",
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
      mergeSha: "deadbeefcafe1234",
    });

    // The card lands on the parent immediately; the wake-turn is dispatched into
    // the parent's real runner.
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
    await waitFor(
      () => {
        const r = app.runnerRegistry.get(parentId);
        return !!r && (r.running || r.queueLength > 0);
      },
      10_000,
      "parent wake-turn dispatched",
    );

    // Crucially, the watch is NOT yet `delivered` — the turn has only been
    // dispatched, not run. This is the window the docs/196 fix protects: a
    // restart here must leave the watch recoverable, so it stays `merge-observed`.
    expect(sessionManager.getMergeWatch(childId)?.state).toBe("merge-observed");

    // Drive the dispatched wake-turn to completion through the real
    // turn-executor; only its `onTurnComplete` advances the watch to `delivered`.
    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && a.lastPrompt?.includes("MERGED")),
      10_000,
      "wake-turn agent started",
    );
    spawnedAgents.find((a) => a.lastPrompt?.includes("MERGED"))!.finish();
    await waitFor(
      () => sessionManager.getMergeWatch(childId)?.state === "delivered",
      10_000,
      "watch delivered after wake-turn completion",
    );

    // Delivery is fire-once: the card was surfaced exactly once.
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
  });

  it("merged: a restart before the wake-turn runs is recovered by reconcile (no second card)", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    const info = {
      sessionId: childId,
      outcome: "merged" as const,
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
      mergeSha: "deadbeefcafe1234",
    };

    // Observe the merge: card surfaced + wake-turn dispatched, but we never let
    // it complete — this models the orchestrator dying before the turn runs.
    await app.mergeWatchManager!.handleChildPrTerminal(info);
    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && a.lastPrompt?.includes("MERGED")),
      10_000,
      "first wake-turn agent started",
    );
    expect(sessionManager.getMergeWatch(childId)?.state).toBe("merge-observed");
    const firstWakeAgents = spawnedAgents.filter((a) => a.lastPrompt?.includes("MERGED")).length;
    expect(firstWakeAgents).toBe(1);

    // Simulate the restart: tear the parent runner down (the in-memory turn is
    // gone), then re-derive from the persisted PR snapshot as startup does.
    app.runnerRegistry.dispose(parentId, { force: true });
    app.mergeWatchManager!.setPrStatusLookup((id) =>
      id === childId
        ? ({
            sessionId: childId,
            prNumber: 7,
            prUrl: info.prUrl,
            prTitle: "Foundation",
            prBody: "",
            prState: "merged",
            baseBranch: "main",
            headBranch: info.branch,
            insertions: 1,
            deletions: 0,
            checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0 },
            mergeable: "unknown",
            reviewDecision: "none",
            autoMergeEnabled: false,
          } as never)
        : undefined,
    );
    await app.mergeWatchManager!.reconcilePending();

    // Re-delivered (a second wake-turn agent), driven to completion → delivered,
    // and still exactly ONE card on the parent.
    await waitFor(
      () => spawnedAgents.filter((a) => a.runCalled && a.lastPrompt?.includes("MERGED")).length >= 2,
      10_000,
      "wake-turn re-dispatched after restart",
    );
    [...spawnedAgents].reverse().find((a) => a.runCalled && a.lastPrompt?.includes("MERGED"))!.finish();
    await waitFor(
      () => sessionManager.getMergeWatch(childId)?.state === "delivered",
      10_000,
      "watch delivered after reconcile re-delivery",
    );
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
  });

  it("is fire-once: a second terminal observation adds no second card", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    const info = {
      sessionId: childId,
      outcome: "merged" as const,
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
    };
    await app.mergeWatchManager!.handleChildPrTerminal(info);
    await app.mergeWatchManager!.handleChildPrTerminal(info);

    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
  });

  it("closed-unmerged: surfaces a distinct card and a terminal watch state", { timeout: 15_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    await app.mergeWatchManager!.handleChildPrTerminal({
      sessionId: childId,
      outcome: "closed",
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
    });

    expect(sessionManager.getMergeWatch(childId)?.state).toBe("closed-unmerged");
    expect(await parentCardOutcomes(parentId)).toEqual(["closed-unmerged"]);
  });
});
