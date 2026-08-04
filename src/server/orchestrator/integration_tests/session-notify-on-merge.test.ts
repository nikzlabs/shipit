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
import { MAX_DELIVERY_ATTEMPTS } from "../merge-watch.js";
import {
  TestClient,
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

const isMergeWakePrompt = (prompt: string | undefined): boolean =>
  prompt?.includes("Child PR #") === true && prompt.includes(" merged:");

describe("Integration: notify-on-merge watch (docs/196)", () => {
  let app: FastifyInstance;
  let port: number;
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
    // docs/243 — the merge notification is delivered as a wake-turn, and every
    // agent turn now passes runner-owned trust admission. This suite exercises
    // watch/delivery behavior after repository consent, not the trust gate.
    repoStore.setTrusted(REPO_URL, true);

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
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
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

  interface HistoryCard {
    outcome: string;
    prNumber: number;
    deliveryFailure?: { attempts: number; error?: string };
  }

  /** The parent's `childMerged` cards, read back through the HTTP history route. */
  async function parentCards(parentId: string): Promise<HistoryCard[]> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/history` });
    const messages = (res.json() as { messages: { childMerged?: HistoryCard }[] }).messages;
    return messages.filter((m) => m.childMerged).map((m) => m.childMerged!);
  }

  async function parentCardOutcomes(parentId: string): Promise<string[]> {
    return (await parentCards(parentId)).map((c) => c.outcome);
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
      () => spawnedAgents.some((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt)),
      10_000,
      "wake-turn agent started",
    );
    spawnedAgents.find((a) => isMergeWakePrompt(a.lastPrompt))!.finish();
    await waitFor(
      () => sessionManager.getMergeWatch(childId)?.state === "delivered",
      10_000,
      "watch delivered after wake-turn completion",
    );

    // Delivery is fire-once: the card was surfaced exactly once.
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
  });

  it("merged: a wake-turn queued behind a REAL interactive parent turn reaches delivered in-process (SHI-255)", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    // The parent is busy with a REAL user turn — the common case, and the one
    // the fake busy runner in merge-watch.test.ts couldn't reproduce: the
    // interactive drain (not the dispatched one) is what picks the wake-turn up.
    const client = await TestClient.connect(port, parentId);
    client.send({ type: "send_message", text: "Keep working on the integration" });
    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && a.lastPrompt?.includes("Keep working on the integration")),
      10_000,
      "parent user turn started",
    );
    const userTurn = spawnedAgents.find((a) => a.lastPrompt?.includes("Keep working on the integration"))!;
    const runner = app.runnerRegistry.get(parentId)!;
    expect(runner.running).toBe(true);

    await app.mergeWatchManager!.handleChildPrTerminal({
      sessionId: childId,
      outcome: "merged",
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
      mergeSha: "deadbeefcafe1234",
    });

    // Card now; wake-turn QUEUED behind the running user turn (never preempting).
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
    await waitFor(() => runner.queueLength === 1, 10_000, "wake-turn queued behind the user turn");
    expect(sessionManager.getMergeWatch(childId)?.state).toBe("merge-observed");

    // The user turn ends → the interactive drain starts the wake-turn. Before
    // the fix it re-entered with text only, so the turn ran as an ordinary
    // interactive one, `onTurnComplete` never fired, and the watch sat at
    // `merge-observed` until a restart re-fired it (duplicate notification).
    userTurn.finish("parent-user-turn");
    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt)),
      10_000,
      "wake-turn started from the interactive drain",
    );
    expect(runner.systemTurnInProgress).toBe(true);

    spawnedAgents.find((a) => isMergeWakePrompt(a.lastPrompt))!.finish("parent-wake-turn");
    await waitFor(
      () => sessionManager.getMergeWatch(childId)?.state === "delivered",
      10_000,
      "watch delivered in-process (no restart)",
    );
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);

    client.close();
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
      () => spawnedAgents.some((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt)),
      10_000,
      "first wake-turn agent started",
    );
    expect(sessionManager.getMergeWatch(childId)?.state).toBe("merge-observed");
    const firstWakeAgents = spawnedAgents.filter((a) => isMergeWakePrompt(a.lastPrompt)).length;
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
      () => spawnedAgents.filter((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt)).length >= 2,
      10_000,
      "wake-turn re-dispatched after restart",
    );
    [...spawnedAgents].reverse().find((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt))!.finish();
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

  it("merged: a delivery that THROWS is retried in-process and recovers (SHI-258)", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    // The parent's container can't be resumed on the first attempt. Before this
    // fix the watch sat at `merge-observed` until an orchestrator restart: the
    // poller's terminal callback fires once per transition, and `reconcilePending`
    // only runs at bootstrap.
    const getOrCreate = vi
      .spyOn(app.runnerRegistry, "getOrCreate")
      .mockImplementationOnce(() => { throw new Error("container could not be resumed"); });

    await app.mergeWatchManager!.handleChildPrTerminal({
      sessionId: childId,
      outcome: "merged",
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
      mergeSha: "deadbeefcafe1234",
    });

    // Card surfaced (the human sees the merge) but no wake-turn ran, and the
    // failure is recorded on the persisted watch.
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
    const failed = sessionManager.getMergeWatch(childId);
    expect(failed?.state).toBe("merge-observed");
    expect(failed?.deliveryAttempts).toBe(1);
    expect(failed?.lastDeliveryError).toContain("could not be resumed");
    expect(spawnedAgents.some((a) => isMergeWakePrompt(a.lastPrompt))).toBe(false);

    // Container comes back. Backdate the attempt anchor past the backoff and let
    // the retry supervisor's pass run — the SAME process, no restart, no reconcile.
    getOrCreate.mockRestore();
    sessionManager.setMergeWatch(childId, {
      ...sessionManager.getMergeWatch(childId)!,
      lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await app.mergeWatchManager!.retryStalledDeliveries();

    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && isMergeWakePrompt(a.lastPrompt)),
      10_000,
      "wake-turn dispatched by the retry pass",
    );
    spawnedAgents.find((a) => isMergeWakePrompt(a.lastPrompt))!.finish();
    await waitFor(
      () => sessionManager.getMergeWatch(childId)?.state === "delivered",
      10_000,
      "watch delivered after the in-process retry",
    );
    // Still exactly one card — the retry re-enters at `merge-observed`, which
    // skips the card guard.
    expect(await parentCardOutcomes(parentId)).toEqual(["merged"]);
  });

  it("merged: a permanently-failing delivery gives up and persists a failure card (SHI-258)", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId);
    await armWatch(parentId, childId);

    // Every attempt fails — a parent whose container will never come back.
    const getOrCreate = vi
      .spyOn(app.runnerRegistry, "getOrCreate")
      .mockImplementation(() => { throw new Error("container could not be resumed"); });

    await app.mergeWatchManager!.handleChildPrTerminal({
      sessionId: childId,
      outcome: "merged",
      prNumber: 7,
      prUrl: "https://github.com/owner/notify-on-merge-test/pull/7",
      prTitle: "Foundation",
      branch: sessionManager.get(childId)!.branch!,
    });
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      sessionManager.setMergeWatch(childId, {
        ...sessionManager.getMergeWatch(childId)!,
        lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      await app.mergeWatchManager!.retryStalledDeliveries();
    }
    getOrCreate.mockRestore();

    expect(sessionManager.getMergeWatch(childId)?.state).toBe("delivery-failed");
    // A terminal watch drops out of the pending list, so it stops holding the PR
    // polling gate open for a wake that will never happen.
    expect(sessionManager.listPendingMergeWatches()).toHaveLength(0);

    // The failure is transcript content, so it must come back over the HTTP
    // history route (not merely have been emitted on the wire).
    const cards = await parentCards(parentId);
    expect(cards).toHaveLength(2);
    expect(cards[0].deliveryFailure).toBeUndefined();
    expect(cards[1].deliveryFailure?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(cards[1].deliveryFailure?.error).toContain("could not be resumed");
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
