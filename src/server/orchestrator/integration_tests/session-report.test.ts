/**
 * Integration tests for the upward / lateral session-report channel
 * (docs/233, SHI-241).
 *
 * Exercises the orchestrator end of the chain end-to-end through `buildApp`:
 *
 *   GET  /api/sessions/:sessionId/cohort   (a child resolving ITSELF)
 *   POST /api/sessions/:sessionId/report   (a child pushing a report upward)
 *   → a persisted report card lands in each recipient's history
 *   → a self-describing system turn is dispatched into each recipient's runner
 *
 * The recipient-resolution rules, validation, and the rate limit are unit-tested
 * in `services/session-report.test.ts`. Here we prove the HTTP routes plus the
 * real runner-registry / chat-history delivery in a fully-wired app — including
 * that a report from a real spawned child reaches its real parent.
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
import { clearSessionReportRateLimits } from "../services/session-report.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/session-report-test.git";

async function waitFor(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: session report (docs/233)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let dbManager: DatabaseManager;
  let origGitTerminalPrompt: string | undefined;
  let spawnedAgents: FakeClaudeProcess[];

  beforeEach(async () => {
    clearSessionReportRateLimits();
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-session-report-"));
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

  async function spawnChild(parentId: string, title: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${parentId}/spawn`,
      payload: { prompt: `Work on ${title}`, title, spawnedByTurn: "turn-1" },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessionId: string }).sessionId;
  }

  function report(sessionId: string, payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/api/sessions/${sessionId}/report`, payload });
  }

  async function reportCards(sessionId: string): Promise<Record<string, unknown>[]> {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    const messages = (res.json() as { messages: { sessionReport?: Record<string, unknown> }[] }).messages;
    return messages.filter((m) => m.sessionReport).map((m) => m.sessionReport!);
  }

  it("a child resolves ITSELF, its parent, and its cohort", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childA = await spawnChild(parentId, "Druid catalog");
    const childB = await spawnChild(parentId, "Elementalist catalog");

    const res = await app.inject({ method: "GET", url: `/api/sessions/${childB}/cohort` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      self: { id: string; title: string };
      parent?: { id: string };
      siblings: { id: string }[];
      children: unknown[];
    };
    expect(body.self).toMatchObject({ id: childB, title: "Elementalist catalog" });
    expect(body.parent?.id).toBe(parentId);
    expect(body.siblings.map((s) => s.id)).toEqual([childA]);
    expect(body.children).toEqual([]);

    // …and the parent sees its whole brood.
    const parentRes = await app.inject({ method: "GET", url: `/api/sessions/${parentId}/cohort` });
    const parentBody = parentRes.json() as { parent?: unknown; children: { id: string }[] };
    expect(parentBody.parent).toBeUndefined();
    expect(parentBody.children.map((c) => c.id).sort()).toEqual([childA, childB].sort());
  });

  it("delivers a child's report to the parent as a card + a wake-turn", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId, "Elementalist catalog");

    const res = await report(childId, {
      body: "The shared regen command deletes every catalog, not just mine.",
      subject: "regen wipes data/catalogs",
      severity: "blocker",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      to: "parent",
      severity: "blocker",
      recipients: [{ sessionId: parentId, relation: "child", woken: true }],
    });

    // The card is persisted in the PARENT's transcript (survives switch/reload).
    const cards = await reportCards(parentId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      fromSessionId: childId,
      severity: "blocker",
      subject: "regen wipes data/catalogs",
      relation: "child",
    });

    // And the parent's real runner is woken with a self-describing system turn.
    await waitFor(
      () => spawnedAgents.some((a) => a.runCalled && a.lastPrompt?.includes("You received a REPORT")),
      10_000,
      "parent wake-turn started",
    );
    const wake = spawnedAgents.find((a) => a.lastPrompt?.includes("You received a REPORT"))!;
    expect(wake.lastPrompt).toContain("BLOCKER");
    expect(wake.lastPrompt).toContain("deletes every catalog");
  });

  it("--to cohort reaches every sibling as well as the parent", { timeout: 30_000 }, async () => {
    const parentId = await createParent();
    const druid = await spawnChild(parentId, "Druid catalog");
    const necro = await spawnChild(parentId, "Necromancer catalog");
    const elem = await spawnChild(parentId, "Elementalist catalog");

    const res = await report(elem, { body: "Do not run npm run regen.", to: "cohort", severity: "warn" });
    expect(res.statusCode).toBe(200);
    const recipients = (res.json() as { recipients: { sessionId: string }[] }).recipients;
    expect(recipients.map((r) => r.sessionId).sort()).toEqual([parentId, druid, necro].sort());

    // Every recipient carries the card; the reporter carries none.
    expect(await reportCards(parentId)).toHaveLength(1);
    expect(await reportCards(druid)).toHaveLength(1);
    expect(await reportCards(necro)).toHaveLength(1);
    expect(await reportCards(elem)).toHaveLength(0);
    expect((await reportCards(druid))[0]).toMatchObject({ relation: "sibling", fromSessionId: elem });
  });

  it("rejects a report from a session with no parent", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const res = await report(parentId, { body: "nobody to tell" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/no parent/i);
  });

  it("rejects an invalid severity without touching any transcript", { timeout: 20_000 }, async () => {
    const parentId = await createParent();
    const childId = await spawnChild(parentId, "Elementalist catalog");

    const res = await report(childId, { body: "hi", severity: "urgent" });
    expect(res.statusCode).toBe(400);
    expect(await reportCards(parentId)).toHaveLength(0);
  });
});
