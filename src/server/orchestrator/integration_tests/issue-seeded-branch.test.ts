/**
 * Integration test for planning#322 — the Issues tab's "Start session", end to end.
 *
 * Since docs/236 that action does NOT create the session: it prefills the chat
 * composer, so the session becomes real only when the user sends the first
 * message. Two things therefore have to ride on that message rather than on
 * creation, and both regressed when the flow changed:
 *
 *   1. The branch must be pinned to the issue's POINTER (docs/248-declared-issue-trackers req 22). The
 *      prefilled prompt opens with the issue's *title*, so a session that
 *      graduates normally has its branch AI-named from that text — publishing
 *      tracker content to a git remote. This test asserts the pushed-branch
 *      name contains no fragment of the title.
 *   2. The issue must move to **started**, which `shipit-docs/issues.md`
 *      promises and which only fires when the session carries an issue ref.
 *
 * Drives the real orchestrator (`buildApp()`) over a live WS, with the tracker
 * REST layer faked so the GitHub write is observable without the network.
 */

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

// `graduateSession` shells out to the real naming CLI when nothing is pinned.
// Returning a name here is deliberate: it is exactly what would rewrite the
// branch to a title-derived slug, so the pin has something real to beat.
// docs/252 phase 7 — `generateSessionName` returns `{ name, usage?, failure? }`
// rather than a bare `SessionName | null`. The old shape resolved to a value
// whose `.name` was undefined, which graduation reads as "naming failed" — so
// the AI branch rename below never fired and the control case timed out.
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
    // docs/243 — the first turn passes runner-owned trust admission; this test
    // is about what graduation does with an issue ref, not the trust gate.
    repoStore.add(REPO_URL);
    repoStore.setTrusted(REPO_URL, true);
    credentialStore = createTestCredentialStore(tmpDir);
    const githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");
    // Closed → `started` reopens it, so the transition is a real state change
    // rather than a no-op we couldn't distinguish from "never fired".
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

    // A claimed-but-unsent session as the Issues tab leaves it: warm, on a
    // throwaway branch, with a commit so the branch actually exists.
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

  /** The prompt the Issues tab prefills — it names the issue, nothing more. */
  const seededPrompt = buildIssueSeedPrompt({
    identifier: ISSUE_REF.identifier,
    title: ISSUE_TITLE,
  });

  it("pins the branch to the pointer and moves the issue to started", async () => {
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: seededPrompt, sessionId, issueRef: ISSUE_REF });

    await waitFor(
      () => sessionManager.get(sessionId)?.warm !== true,
      "graduation",
    );

    // The branch is the pointer, slugified, plus a random uniqueness suffix
    // (planning#413) — the same value in the DB and on disk. The suffix is what
    // stops the NEXT session on this issue from landing on this branch and
    // adopting its PR; the stem is what keeps the branch readable.
    const branch = sessionManager.get(sessionId)!.branch;
    expect(branch).toMatch(/^octocat-hello-world-42-[a-z0-9_-]{1,6}$/);
    expect(
      execSync("git branch --show-current", { cwd: sessionDir }).toString().trim(),
    ).toBe(branch);

    // docs/248-declared-issue-trackers req 22 — no fragment of the issue title reaches the branch name.
    for (const word of ISSUE_TITLE.toLowerCase().split(/\W+/).filter(Boolean)) {
      expect(branch).not.toContain(word);
    }

    // AI naming is off for this session: `branchRenamed` is set synchronously,
    // so the mocked namer's "sso-login-crash" slug can never land on it.
    expect(sessionManager.get(sessionId)!.branchRenamed).toBe(true);

    // The title still carries the issue — req 21 restricts what leaves ShipIt,
    // and the sidebar title never does. Same value the headless path pins.
    expect(sessionManager.get(sessionId)!.title).toBe(`${ISSUE_REF.identifier}: ${ISSUE_TITLE}`);

    // Second symptom: the issue moved to started (closed → reopened).
    await waitFor(() => statusPatches.length > 0, "issue status write");
    expect(statusPatches[0]).toMatchObject({ state: "open" });

    client.close();
  });

  it("leaves an ordinary first message on the AI-named branch", async () => {
    // The control: the same session, same graduation path, no issue ref. This
    // is what the issue-started path looked like before the fix — proof that
    // the pin above is doing the work, not the test's mock.
    const client = await TestClient.connect(port, sessionId);
    await client.receive(); // preview_status

    client.send({ type: "send_message", text: seededPrompt, sessionId });

    await waitFor(
      () => sessionManager.get(sessionId)?.branch?.includes("sso-login-crash") === true,
      "AI branch rename",
    );
    expect(statusPatches).toHaveLength(0);

    client.close();
  });
});
