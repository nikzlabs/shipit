import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { CredentialStore } from "../credential-store.js";
import type { GitHubAuthManager } from "../github-auth.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
  createTestSession,
  waitFor,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { buildIssueSeedPrompt } from "../../shared/issue-ref.js";

// Return a title-derived name so the control test exercises branch renaming without a CLI.
vi.mock("../session-namer.js", () => ({
  generateSessionName: vi.fn().mockResolvedValue({
    name: { slug: "sso-login-crash", title: "SSO login crash" },
  }),
}));

const ISSUE_TITLE = "SSO login crashes on the enterprise tenant";
const ISSUE_REF = {
  tracker: "github" as const,
  identifier: "octocat/hello-world#42",
  title: ISSUE_TITLE,
  url: "https://github.com/octocat/hello-world/issues/42",
};

const REPO_URL = "https://github.com/octocat/hello-world.git";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Integration: issue-seeded session branch + started (planning#322)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let repoStore: RepoStore;
  let sessionId: string;
  let sessionDir: string;
  let issueState: "open" | "closed";
  let statusPatches: { state?: string }[];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-seeded-branch-"));
    sessionManager = new SessionManager(dbManager);
    repoStore = new RepoStore(dbManager);
    repoStore.add(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);
    credentialStore = createTestCredentialStore(tmpDir);
    const githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");
    // A closed issue makes the transition to started observable.
    issueState = "closed";
    statusPatches = [];

    const trackerFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (/\/issues\/\d+$/.test(url) && init?.method === "PATCH") {
        const body = init.body ? (JSON.parse(init.body) as { state?: string }) : {};
        statusPatches.push(body);
        if (body.state) issueState = body.state as "open" | "closed";
        return jsonResponse(issueIssueBody());
      }
      if (/\/issues\/\d+$/.test(url)) return jsonResponse(issueIssueBody());
      return jsonResponse({ message: "Not Found" }, 404);
    });
    const issueIssueBody = () => ({
      id: 1,
      number: 42,
      title: ISSUE_TITLE,
      html_url: ISSUE_REF.url,
      state: issueState,
      labels: [],
      body: "Reported by a customer.",
    });

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as unknown as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);

    const created = await createTestSession(sessionManager, tmpDir);
    sessionId = created.sessionId;
    sessionDir = created.sessionDir;
    sessionManager.setRemoteUrl(sessionId, REPO_URL);

    fs.writeFileSync(path.join(sessionDir, "README.md"), "# test\n");
    execSync("git add -A && git commit -m init --no-gpg-sign", { cwd: sessionDir, stdio: "ignore" });
    execSync("git branch -M shipit/ab12cd", { cwd: sessionDir, stdio: "ignore" });
    sessionManager.setBranch(sessionId, "shipit/ab12cd");
    sessionManager.setWarm(sessionId, true);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  });

  const seededPrompt = buildIssueSeedPrompt({
    identifier: ISSUE_REF.identifier,
    title: ISSUE_TITLE,
  });

  it("pins the branch to the pointer and moves the issue to started", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: seededPrompt, sessionId, issueRef: ISSUE_REF });

    await waitFor(
      () => sessionManager.get(sessionId)?.warm !== true,
      "graduation",
    );

    const branch = sessionManager.get(sessionId)!.branch ?? "";
    const named = /^(octocat-hello-world-42)-([a-z0-9_-]{1,6})$/.exec(branch);
    expect(named, branch).not.toBeNull();
    expect(
      execSync("git branch --show-current", { cwd: sessionDir }).toString().trim(),
    ).toBe(branch);

    // Check only the stem; the random suffix can contain short title words by chance.
    for (const word of ISSUE_TITLE.toLowerCase().split(/\W+/).filter(Boolean)) {
      expect(named![1]).not.toContain(word);
    }

    expect(sessionManager.get(sessionId)!.branchRenamed).toBe(true);

    expect(sessionManager.get(sessionId)!.title).toBe(`${ISSUE_REF.identifier}: ${ISSUE_TITLE}`);

    await waitFor(() => statusPatches.length > 0, "issue status write");
    expect(statusPatches[0]).toMatchObject({ state: "open" });

    client.close();
  });

  it("leaves an ordinary first message on the AI-named branch", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive();

    client.send({ type: "send_message", text: seededPrompt, sessionId });

    await waitFor(
      () => sessionManager.get(sessionId)?.branch?.includes("sso-login-crash") === true,
      "AI branch rename",
    );
    expect(statusPatches).toHaveLength(0);

    client.close();
  });
});
