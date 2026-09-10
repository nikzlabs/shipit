import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent session naming from starting a provider CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({ name: null }),
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

    // Set GIT_CONFIG_GLOBAL before the seed helper writes its local fetch redirect.
    const credentialStore = createTestCredentialStore(tmpDir);
    seedRepoCacheWithLocalBare({
      tmpDir,
      repoUrl: REPO_URL,
      seedFiles: { "README.md": "# quick-capture-test\n" },
    });
    repoStore.add(REPO_URL);
    repoStore.setReady(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);

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
    // Avoid a slow clone racing the warm pool's fetch in the seeded cache.
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Fix the flaky test",
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
      status: "running",
      session: { title: "Fix the flaky test" },
    });
    expect(body.branch).toMatch(/^shipit\/[a-z0-9_-]{1,6}$/);

    const session = sessionManager.get(body.sessionId);
    expect(session).toMatchObject({
      remoteUrl: REPO_URL,
      branch: body.branch,
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
    }).trim()).toBe(body.branch);
  });

  it("drops the image and says so when the new session's model cannot see (planning#460)", { timeout: 15_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { payload, boundary } = buildMultipart(
      {
        repoUrl: REPO_URL,
        initialPrompt: "Match this design",
        agent: "claude",
        model: "deepseek-v4-pro",
        serviceId: "deepseek",
        billingMode: "key",
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
    const { sessionId } = res.json() as { sessionId: string };

    await waitFor(() => createdAgents.some((a) => a.runCalled), 5000, "headless agent start");
    const prompt = createdAgents[0].lastPrompt ?? "";
    expect(prompt).toContain("Match this design");
    expect(prompt).not.toContain("<attached_images>");

    const history = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/history` });
    expect(history.body).toContain("cannot read images");
    expect(history.body).toContain("V4 Pro");
  });

  it("references an attached image in the dispatched first-turn prompt", { timeout: 15_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { payload, boundary } = buildMultipart(
      {
        repoUrl: REPO_URL,
        initialPrompt: "Match this design",
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
    expect(prompt).toContain("Match this design");
    expect(prompt).toContain("<attached_images>");
    expect(prompt).toMatch(/\/uploads\/screenshot[^\s]*\.png/);

    const uploadsDir = path.join(path.dirname(session!.workspaceDir!), "uploads");
    const saved = fs.readdirSync(uploadsDir).filter((f) => f.endsWith(".png"));
    expect(saved.length).toBe(1);
  });

  it("never recycles a user's ungraduated /{repo}/new draft", { timeout: 20_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm before draft claim");

    const draftRes = await app.inject({
      method: "POST",
      url: `/api/repos/${encodeURIComponent(REPO_URL)}/claim-session`,
    });
    expect(draftRes.statusCode).toBe(200);
    const { sessionId: draftId } = draftRes.json() as { sessionId: string };
    expect(sessionManager.get(draftId)?.warm).toBe(true);

    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "re-warm after draft claim");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: { repoUrl: REPO_URL, initialPrompt: "background work", title: "Background" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { sessionId: headlessId } = res.json() as { sessionId: string };

    expect(headlessId).not.toBe(draftId);
    expect(sessionManager.get(draftId)?.warm).toBe(true);
    expect(sessionManager.get(headlessId)?.workspaceDir).not.toBe(
      sessionManager.get(draftId)?.workspaceDir,
    );
  });

  it("refuses a harness that cannot run the requested model (planning#389)", { timeout: 15_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const before = sessionManager.list().length;
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Use the model's agent",
        agent: "codex",
        model: "claude-opus-5",
      },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: string }).error).toContain(
      "Codex cannot run Opus 5 — they share no API style.",
    );
    expect(sessionManager.list().length).toBe(before);
    expect(createdAgents.some((a) => a.runCalled)).toBe(false);
  });

  it("still derives the agent from the model when none was named (docs/166)", { timeout: 15_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Use the model's agent",
        model: "claude-opus-5",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    expect(sessionManager.get(body.sessionId)).toMatchObject({
      model: "claude-opus-5",
      agentId: "claude",
      agentPinned: true,
    });
  });

  it("honours the requested harness when it can run the model (both can)", { timeout: 15_000 }, async () => {
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Run this on Codex",
        agent: "codex",
        model: "deepseek-v4-pro",
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };
    expect(sessionManager.get(body.sessionId)).toMatchObject({
      model: "deepseek-v4-pro",
      agentId: "codex",
      agentPinned: true,
    });
  });

  it("arms auto-merge at creation when armAutoMerge is true (docs/175)", { timeout: 15_000 }, async () => {
    await githubAuth.setToken("test-token");
    await waitFor(() => !!repoStore.get(REPO_URL)?.warmSessionId, 10_000, "warm session");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/headless",
      payload: {
        repoUrl: REPO_URL,
        initialPrompt: "Bump the dep and merge it",
        agent: "claude",
        armAutoMerge: true,
      },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { sessionId: string };

    const state = app.prStatusPoller?.getAutoMergeState(body.sessionId);
    expect(state?.enabled).toBe(true);

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
