import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";
import {
  MAX_NEEDS_YOU_ITEMS,
  MAX_STATUS_LEN,
} from "../../shared/session-status-validation.js";

describe("Integration: session-status route", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let sessionId: string;
  // Lets a test run something inside the route's provenance await.
  let duringGitRead: (() => void) | null;

  beforeEach(async () => {
    duringGitRead = null;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-status-route-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => {
        const git = new GitManager(dir);
        const readBranch = git.getCurrentBranch.bind(git);
        git.getCurrentBranch = async () => {
          duringGitRead?.();
          return readBranch();
        };
        return git;
      },
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    credentialStore.setSessionStatusCard(true);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/sessions/${sessionId}/session-status`, payload });

  it("persists the card with per-offer provenance and marks the turn updated", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await post({
      status: "Billing service.\n\n- routes done\n- webhook not started",
      needsYou: ["Paste the Stripe test key.", "Enable the webhook endpoint in the dashboard."],
      actions: [{
        id: "webhook",
        label: "Wire the webhook",
        description: "Adds the handler and its test.",
        payload: "Wire the Stripe webhook.",
      }],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      needsYou?: string[];
      actions: { offerId: string; label: string; taken: boolean }[];
    };
    // Markdown is stored as written: the card renders it (req 27).
    expect(body.status).toContain("- routes done");
    expect(body.needsYou).toEqual([
      "Paste the Stripe test key.",
      "Enable the webhook endpoint in the dashboard.",
    ]);
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]).toMatchObject({ label: "Wire the webhook", taken: false });
    expect(body.actions[0]?.offerId).toBeTruthy();

    const stored = sessionManager.get(sessionId)?.sessionStatus;
    expect(stored).toMatchObject({ fresh: true, writeSeq: 1 });
    expect(stored?.actions[0]?.branch).toBeTruthy();

    expect(app.runnerRegistry.get(sessionId)?.statusUpdated).toBe(true);
  });

  it("accepts a bare call as a confirmation once a card is stored", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await post({ status: "Half done.", needsYou: ["Paste the key."] });
    const before = sessionManager.get(sessionId)?.sessionStatus;
    // The settlement of an earlier turn is what leaves a card stale.
    sessionManager.setSessionStatus(sessionId, { ...before!, fresh: false });

    const res = await post({});
    expect(res.statusCode).toBe(200);

    const after = sessionManager.get(sessionId)?.sessionStatus;
    expect(after?.fresh).toBe(true);
    expect(after?.writeSeq).toBe((before?.writeSeq ?? 0) + 1);
    expect(after?.status).toBe(before?.status);
    expect(after?.needsYou).toEqual(before?.needsYou);
  });

  it("carries the last-turn line through, and drops it on the next write (req 31)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await post({ status: "Billing service.", lastTurn: "Wired the webhook route." });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { lastTurn?: string }).lastTurn).toBe("Wired the webhook route.");
    expect(sessionManager.get(sessionId)?.sessionStatus?.lastTurn).toBe("Wired the webhook route.");

    // The line names the turn that is ending, so the next write owns it: a call
    // that omits it clears it rather than leaving a sentence about a turn that
    // is over. The bare confirmation is a write like any other.
    const bare = await post({});
    expect(bare.statusCode).toBe(200);
    expect((bare.json() as { lastTurn?: string }).lastTurn).toBeUndefined();
    expect(sessionManager.get(sessionId)?.sessionStatus?.lastTurn).toBeUndefined();
    expect(sessionManager.get(sessionId)?.sessionStatus?.status).toBe("Billing service.");
  });

  it("refuses a bare call before the session has a card, naming status", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("`status`");
    expect(sessionManager.get(sessionId)?.sessionStatus).toBeUndefined();
  });

  it("rejects an over-long status, naming the size and the cap", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await post({ status: "x".repeat(MAX_STATUS_LEN + 1) });
    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain(`${MAX_STATUS_LEN + 1} chars`);
    expect(error).toContain(String(MAX_STATUS_LEN));
  });

  it("refuses while the setting is off, naming propose_actions (req 21)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    credentialStore.setSessionStatusCard(false);

    const res = await post({ status: "Written with the card off." });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain("propose_actions");
    expect(sessionManager.get(sessionId)?.sessionStatus).toBeUndefined();
  });

  it("does not credit a successor turn with a write the stopped turn made", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();
    const runner = app.runnerRegistry.get(sessionId)!;

    // The turn that called is stopped and another starts while the route awaits.
    duringGitRead = () => {
      runner.turnEpoch = (runner.turnEpoch ?? 0) + 1;
      runner.statusUpdated = false;
    };

    const res = await post({ status: "Written by the turn that was stopped." });

    expect(res.statusCode).toBe(200);
    // The card is still right; only the credit for it is withheld.
    expect(sessionManager.get(sessionId)?.sessionStatus?.status)
      .toBe("Written by the turn that was stopped.");
    expect(runner.statusUpdated).toBe(false);
  });

  it("replaces the offered list when asked, and clears it with an empty one", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await post({
      status: "Done.",
      actions: [
        { id: "pr", label: "Open a PR", description: "Opens it against main.", payload: "Open a PR." },
        { id: "docs", label: "Update the docs", description: "The new route.", payload: "Update the docs." },
      ],
    });

    const replaced = await post({
      replaceActions: true,
      actions: [{
        id: "docs",
        label: "Update the docs",
        description: "The new route.",
        payload: "Update the docs.",
      }],
    });
    expect((replaced.json() as { actions: { id: string }[] }).actions.map((a) => a.id))
      .toEqual(["docs"]);

    const cleared = await post({ replaceActions: true, actions: [] });
    expect((cleared.json() as { actions: unknown[] }).actions).toEqual([]);
    expect(sessionManager.get(sessionId)?.sessionStatus?.actions).toEqual([]);
  });

  it("clears the manual steps on an empty list, and refuses a bad one", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    await post({ status: "Waiting on a key.", needsYou: ["Paste the key."] });
    expect(sessionManager.get(sessionId)?.sessionStatus?.needsYou).toEqual(["Paste the key."]);

    const cleared = await post({ needsYou: [] });
    expect(cleared.statusCode).toBe(200);
    expect(sessionManager.get(sessionId)?.sessionStatus?.needsYou ?? []).toEqual([]);

    const tooMany = await post({
      needsYou: Array.from({ length: MAX_NEEDS_YOU_ITEMS + 1 }, (_, i) => `Step ${i}`),
    });
    expect(tooMany.statusCode).toBe(400);
    expect((tooMany.json() as { error: string }).error).toContain(String(MAX_NEEDS_YOU_ITEMS));
  });

  it("refuses an offer with no description, naming it (req 26)", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const res = await post({
      status: "Done.",
      actions: [{ id: "pr", label: "Open a PR", payload: "Open a PR." }],
    });

    expect(res.statusCode).toBe(400);
    const { error } = res.json() as { error: string };
    expect(error).toContain("description");
    expect(error).toContain("\"pr\"");
    expect(sessionManager.get(sessionId)?.sessionStatus).toBeUndefined();
  });

  it("answers 409 when the session has no runner", async () => {
    const res = await post({ status: "Nobody is watching." });
    expect(res.statusCode).toBe(409);
    expect(sessionManager.get(sessionId)?.sessionStatus).toBeUndefined();
  });

  it("reports each offer's taken state so the agent can keep or replace it", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    const first = await post({
      status: "Done.",
      actions: [
        { id: "pr", label: "Open a PR", description: "Opens it against main.", payload: "Open a PR." },
        { id: "docs", label: "Update the docs", description: "The new route.", payload: "Update the docs." },
      ],
    });
    const offers = (first.json() as { actions: { offerId: string; id: string }[] }).actions;
    const taken = offers.find((o) => o.id === "pr")!.offerId;

    const stored = sessionManager.get(sessionId)!.sessionStatus!;
    sessionManager.setSessionStatus(sessionId, {
      ...stored,
      actions: stored.actions.map((o) =>
        o.offerId === taken ? { ...o, takenAt: new Date().toISOString() } : o,
      ),
    });

    const second = await post({});
    const listed = (second.json() as { actions: { id: string; taken: boolean }[] }).actions;
    expect(listed).toEqual([
      { offerId: expect.any(String), id: "pr", label: "Open a PR", taken: true },
      { offerId: expect.any(String), id: "docs", label: "Update the docs", taken: false },
    ]);
  });
});
