import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// docs/156 — every session-creation surface now ends with `graduateSession`,
// which fires `generateSessionName` (real CLI child, 15s timeout) for any
// path without an explicit title+branch. Mock to null so the placeholder
// title sticks and the branch is unchanged. Without this, the
// no-explicit-title path would shell out to a real provider CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue(null),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { GitManager } from "../../shared/git.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  FakeClaudeProcess,
  StubAuthManager,
  StubGitHubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
  seedRepoCacheWithLocalBare,
} from "./test-helpers.js";

const REPO_URL = "https://github.com/owner/quick-capture-test.git";

/**
 * Build a multipart/form-data body for app.inject() with a mix of text fields
 * and file parts (the shape the quick-capture overlay POSTs when the user
 * attaches an image).
 */
function buildMultipart(
  fields: Record<string, string>,
  files: { name: string; filename: string; content: Buffer }[],
): { payload: Buffer; boundary: string } {
  const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
    ));
  }
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    parts.push(file.content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), boundary };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor("${label}") timed out`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Integration: quick-capture headless sessions", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let createdAgents: FakeClaudeProcess[];
  let githubAuth: StubGitHubAuthManager;
  let origGitTerminalPrompt: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-quick-capture-"));
    origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    createdAgents = [];
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);

    // Set up credentials (which sets GIT_CONFIG_GLOBAL) before seeding the
    // cache — `seedRepoCacheWithLocalBare` writes its `insteadOf` redirect
    // there. Without this, warming would fire a real github.com fetch.
    const credentialStore = createTestCredentialStore(tmpDir);
    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: REPO_URL,
      seedFiles: { "README.md": "# quick-capture-test\n" },
    });
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);

    githubAuth = new StubGitHubAuthManager();
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuth as unknown as GitHubAuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        createdAgents.push(agent);
        return agent as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    if (origGitTerminalPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("POST /api/sessions/headless creates and starts a session without WebSocket attachment", { timeout: 15_000 }, async () => {
    // Wait for the warm pool to register a warm session before claiming.
    // buildApp() schedules warming via setTimeout(0); if claim runs before
    // that fires (CI load) it falls to the slow-clone path, which calls
    // `ensureBareCache` — the helper sees no `HEAD` file at the top of the
    // *non-bare* seeded cache and `rm -rf`s it, racing the warm pool's
    // concurrent `git fetch` for an ENOTEMPTY on `.git/`. Matches
    // `agent-spawned-session.test.ts`'s `claimGraduatedParent` waitFor.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Fix the flaky test",
        branch: "quick/flaky-test",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      sessionId: string;
      branch: string;
      status: "running";
      session: { id: string; title: string };
    };
    expect(body).toMatchObject({
      branch: "quick/flaky-test",
      status: "running",
      session: { title: "Fix the flaky test" },
    });

    const session = sessionManager.get(body.sessionId);
    expect(session).toMatchObject({
      remoteUrl: REPO_URL,
      branch: "quick/flaky-test",
      branchRenamed: true,
      model: "claude-sonnet-4-20250514",
      agentId: "claude",
      agentPinned: true,
    });
    expect(session?.workspaceDir).toBeTruthy();
    await waitFor(() => createdAgents.some((agent) => agent.runCalled), 5000, "headless agent start");
    expect(createdAgents[0].lastPrompt).toBe("Fix the flaky test");
    expect(createdAgents[0].lastCwd).toBe(session?.workspaceDir);
    expect(execSync("git branch --show-current", {
      cwd: session!.workspaceDir!,
      encoding: "utf8",
    }).trim()).toBe("quick/flaky-test");
  });

  it("references an attached image in the dispatched first-turn prompt", { timeout: 15_000 }, async () => {
    // Regression: an image attached in the quick-capture overlay is saved into
    // the new session's uploads dir but was NEVER folded into the prompt the
    // agent receives — `runDispatchedTurn` passed `prompt: text` only, dropping
    // `opts.uploads`. The agent never saw the screenshot. The dispatch path now
    // resolves upload refs and assembles the same `<attached_images>` prompt
    // block the WS path does, so the first turn references the image by path.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { payload, boundary } = buildMultipart(
      {
        repoUrl: REPO_URL,
        initialPrompt: "Match this design",
        branch: "quick/with-image",
        agent: "claude",
      },
      [{ name: "file", filename: "screenshot.png", content: png }],
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string; session: { workspaceDir?: string } };
    const session = sessionManager.get(body.sessionId);

    await waitFor(() => createdAgents.some((a) => a.runCalled), 5000, "headless agent start");
    const prompt = createdAgents.find((a) => a.runCalled)!.lastPrompt;
    // The agent's prompt carries the user text AND the attached-image block that
    // points it at the saved /uploads/ path — proof the image reached the turn.
    expect(prompt).toContain("Match this design");
    expect(prompt).toContain("<attached_images>");
    expect(prompt).toMatch(/\/uploads\/screenshot[^\s]*\.png/);

    // The image was actually written to the session's uploads dir on disk.
    const uploadsDir = path.join(path.dirname(session!.workspaceDir!), "uploads");
    const saved = fs.readdirSync(uploadsDir).filter((f) => f.endsWith(".png"));
    expect(saved.length).toBe(1);
  });

  it("never recycles a user's ungraduated /{repo}/new draft", { timeout: 20_000 }, async () => {
    // Regression: a headless session (quick-capture, issue-seeded start, webhook)
    // is always a NEW session for the requested work, never a recycle of an
    // existing draft. A `/{repo}/new` page claims a warm session that stays
    // `warm = 1` until its first message graduates it; without `skipReuse: true`
    // on the headless claim, the reuse path (`findUngraduatedWarm`) could hand
    // that live draft to a concurrent quick-capture for the same repo —
    // graduating it and dispatching the quick-capture prompt into the session
    // the user is composing in (a message appearing from nowhere mid-compose).
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm before draft claim");

    // Simulate the user's `/{repo}/new` page: claim a warm session and leave it
    // ungraduated. This is the draft the headless create must NOT steal.
    const draftRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(REPO_URL)}/claim-session`,
    });
    expect(draftRes.statusCode).toBe(200);
    const { sessionId: draftId } = draftRes.json() as { sessionId: string };
    expect(sessionManager.get(draftId)?.warm).toBe(true);

    // Re-warm so the headless create has a clean pool session to take.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "re-warm after draft claim");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: { repoUrl: REPO_URL, initialPrompt: "background work", title: "Background" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { sessionId: headlessId } = res.json() as { sessionId: string };

    // The headless session is its own session — NOT the user's draft.
    expect(headlessId).not.toBe(draftId);
    // The draft is untouched: still ungraduated (`warm = 1`). Had reuse fired,
    // it would have graduated (`warm = false`) and run the headless prompt.
    expect(sessionManager.get(draftId)?.warm).toBe(true);
    expect(sessionManager.get(headlessId)?.workspaceDir).not.toBe(
      sessionManager.get(draftId)?.workspaceDir,
    );
  });

  it("pins the model's agent when agent+model disagree (model is source of truth)", { timeout: 15_000 }, async () => {
    // docs/166: a caller (e.g. the quick-capture overlay with a stale
    // `vibe-agent-id`, or a legacy client) sends a Claude model with a
    // conflicting `agent: "codex"`. The model is authoritative, so the server
    // must derive and pin "claude", never the mismatched agent it was handed.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Use the model's agent",
        branch: "quick/agent-derive",
        agent: "codex",
        model: "claude-opus-4-8",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    const session = sessionManager.get(body.sessionId);
    expect(session).toMatchObject({
      model: "claude-opus-4-8",
      agentId: "claude",
      agentPinned: true,
    });
  });

  it("arms auto-merge at creation when armAutoMerge is true (docs/175)", { timeout: 15_000 }, async () => {
    // The pre-PR arm path requires GitHub auth (`toggleAutoMerge` throws 401
    // otherwise). Authenticate the stub, then create an armed quick session and
    // assert the poller seeded the per-session armed state — the same state the
    // overflow toggle would have set, which `activatePendingAutoMergeForPr`
    // applies once the first turn opens a PR.
    await githubAuth.setToken("test-token");
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Bump the dep and merge it",
        branch: "quick/arm-merge",
        agent: "claude",
        armAutoMerge: true,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };

    const state = app.prStatusPoller?.getAutoMergeState(body.sessionId);
    expect(state?.enabled).toBe(true);

    // Decision #1 — the flag is transient: nothing about auto-merge is persisted
    // onto the session row / DB.
    expect(JSON.stringify(sessionManager.get(body.sessionId))).not.toContain("autoMerge");
  });

  it("does not arm auto-merge when the flag is omitted (docs/175)", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Just a normal session",
        branch: "quick/no-arm",
        agent: "claude",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    expect(app.prStatusPoller?.getAutoMergeState(body.sessionId)).toBeUndefined();
  });

  it("rejects a non-boolean armAutoMerge (docs/175)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "bad flag",
        armAutoMerge: "yes" as unknown as boolean,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "armAutoMerge must be a boolean" });
  });

  it("maps validation errors through the HTTP route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: "",
        initialPrompt: "Second",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Add a repo first." });
  });
});
