/**
 * Integration test for the agent's read-only issue access (docs/175).
 *
 * Exercises `shipit issue view`/`list` end-to-end against a *real* orchestrator
 * (`buildApp()`) with faked GitHub REST + Linear GraphQL HTTP. The shim's broker
 * call is wired to the orchestrator's session-scoped routes exactly as the
 * worker relay does in production (`/agent-ops/issue/* → /api/sessions/:id/issue/*`,
 * injecting the trusted session id), so this covers shim parsing → relay shape →
 * orchestrator route → service → tracker registry as one slice.
 *
 * The point of the test is the tracker-neutral contract: `shipit issue view`
 * produces the same shaped output whether the pointer resolves to GitHub
 * (`owner/repo#42`) or Linear (`TRACKER-28`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import { CredentialStore } from "../credential-store.js";
import { GitHubAuthManager } from "../github-auth.js";
import { initGlobalGitConfig } from "../git-config.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { runShim, type ShimIO } from "../../session/agent-shim/shipit.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEAM = { id: "team-1", key: "SHI", name: "ShipIt" };

describe("Integration: agent issue access (docs/175)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let trackerFetch: ReturnType<typeof vi.fn>;
  let sessionId: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-issue-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    trackerFetch = vi.fn(async (url: string, init?: RequestInit) => {
      // Linear GraphQL — routed by query content.
      if (url.includes("linear.app")) {
        const query = (JSON.parse((init?.body as string) ?? "{}") as { query?: string }).query ?? "";
        if (query.includes("TeamIssues")) {
          // A mixed working set: one open, one completed. With includeDone the
          // tracker returns both; the route post-filters for `--state closed`.
          return jsonResponse({
            data: {
              team: {
                issues: {
                  nodes: [
                    { id: "o", identifier: "TRACKER-1", title: "Open one", url: "u1", priority: 1, priorityLabel: "Urgent", state: { name: "In Progress", type: "started" }, assignee: null },
                    { id: "d", identifier: "TRACKER-2", title: "Done one", url: "u2", priority: 3, priorityLabel: "Medium", state: { name: "Done", type: "completed" }, assignee: null },
                  ],
                },
              },
            },
          });
        }
        if (query.includes("Issue")) {
          return jsonResponse({
            data: {
              issue: {
                id: "abc",
                identifier: "TRACKER-28",
                title: "Decouple priorities",
                url: "https://linear.app/example/issue/TRACKER-28",
                description: "The Linear body.",
                priority: 1,
                priorityLabel: "Urgent",
                state: { name: "In Progress" },
                assignee: { displayName: "Nik" },
              },
            },
          });
        }
        return jsonResponse({ data: {} });
      }
      // GitHub REST. A single-issue read hits `/issues/<n>`; a list hits
      // `/issues?state=<state>`. The fake honors `state` exactly as GitHub does
      // (open → open only, all → open + closed) so the adapter's state mapping
      // is exercised end-to-end.
      if (/\/issues\/\d+/.test(url)) {
        return jsonResponse({
          id: 1,
          number: 42,
          title: "An open issue",
          html_url: "https://github.com/octocat/hello-world/issues/42",
          state: "open",
          labels: ["P1"],
          body: "The GitHub body.",
          assignee: { login: "octocat" },
        });
      }
      const state = new URL(url).searchParams.get("state");
      const open = {
        id: 1, number: 1, title: "Open GH", html_url: "https://github.com/octocat/hello-world/issues/1",
        state: "open", labels: ["P1"], assignee: null,
      };
      const closed = {
        id: 2, number: 2, title: "Closed GH", html_url: "https://github.com/octocat/hello-world/issues/2",
        state: "closed", labels: [], assignee: null,
      };
      return jsonResponse(state === "all" ? [open, closed] : [open]);
    });

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
    await githubAuthManager.setToken("ghp_test_token");

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: githubAuthManager as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      workspaceDir: tmpDir,
      serveStatic: false,
      trackerFetchImpl: trackerFetch as unknown as typeof fetch,
    });

    sessionId = "gh-sess";
    sessionManager.track(sessionId, "GH session");
    sessionManager.setRemoteUrl(sessionId, "https://github.com/octocat/hello-world.git");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run the shim, routing its `/agent-ops/issue/*` broker calls to the
   * orchestrator's session-scoped routes via app.inject — exactly what the
   * worker relay does, with the trusted session id injected here.
   */
  async function runIssueShim(
    argv: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    const io: ShimIO = {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      exit: (code) => { exitCode = code; throw new Error("__shim_exit__"); },
    };
    const call = async (
      _method: "GET" | "POST" | "PATCH",
      reqPath: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      // /agent-ops/issue/view?... → /api/sessions/:id/issue/view?...
      const suffix = reqPath.replace(/^\/agent-ops\/issue/, "");
      const res = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/issue${suffix}`,
      });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };
    try {
      await runShim(argv, io, {}, call as never);
    } catch (err) {
      if (err instanceof Error && err.message !== "__shim_exit__") throw err;
    }
    return { stdout, stderr, exitCode };
  }

  it("view owner/repo#42 reads the session's GitHub issue", async () => {
    const { stdout, exitCode } = await runIssueShim(["issue", "view", "octocat/hello-world#42"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("octocat/hello-world#42");
    expect(stdout).toContain("An open issue");
    expect(stdout).toContain("priority:  High");
    expect(stdout).toContain("The GitHub body.");
  });

  it("view 42 with --tracker github resolves the bare number", async () => {
    const { stdout, exitCode } = await runIssueShim(["issue", "view", "42", "--tracker", "github"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("octocat/hello-world#42");
  });

  it("view --json emits the TrackerIssue object", async () => {
    const { stdout, exitCode } = await runIssueShim(["issue", "view", "octocat/hello-world#42", "--json"]);
    expect(exitCode).toBe(0);
    const issue = JSON.parse(stdout) as { identifier: string; priority: { level: string } };
    expect(issue.identifier).toBe("octocat/hello-world#42");
    expect(issue.priority.level).toBe("high");
  });

  it("view TRACKER-28 reads the Linear issue with the same output shape", async () => {
    credentialStore.setLinearToken("lin_api_x");
    credentialStore.setLinearTeam(TEAM);
    const { stdout, exitCode } = await runIssueShim(["issue", "view", "TRACKER-28"]);
    expect(exitCode).toBe(0);
    // Same shaped output as GitHub — that is the tracker-neutral guarantee.
    expect(stdout).toContain("TRACKER-28");
    expect(stdout).toContain("Decouple priorities");
    expect(stdout).toContain("priority:  Urgent");
    expect(stdout).toContain("The Linear body.");
  });

  it("view errors (exit 1) when Linear is unconfigured", async () => {
    const { stderr, exitCode } = await runIssueShim(["issue", "view", "TRACKER-28"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not configured/i);
  });

  it("view 404s (exit 1) for a missing GitHub issue", async () => {
    trackerFetch.mockImplementationOnce(async () => jsonResponse({ message: "Not Found" }, 404));
    const { exitCode } = await runIssueShim(["issue", "view", "octocat/hello-world#999"]);
    expect(exitCode).toBe(1);
  });

  it("list --state closed returns only finished issues (no open over-return)", async () => {
    credentialStore.setLinearToken("lin_api_x");
    credentialStore.setLinearTeam(TEAM);
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "linear", "--state", "closed", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    // The fake returns TRACKER-1 (open) + TRACKER-2 (completed); `closed` keeps only the
    // done one. `includeDone` alone would have over-returned the open issue.
    expect(issues.map((i) => i.identifier)).toEqual(["TRACKER-2"]);
  });

  it("list --state all keeps both open and finished issues", async () => {
    credentialStore.setLinearToken("lin_api_x");
    credentialStore.setLinearTeam(TEAM);
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "linear", "--state", "all", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier).sort()).toEqual(["TRACKER-1", "TRACKER-2"]);
  });

  it("GitHub list --state open returns open issues only", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "github", "--state", "open", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier)).toEqual(["octocat/hello-world#1"]);
  });

  it("GitHub list --state closed returns closed issues only", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "github", "--state", "closed", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    // The adapter fetches state=all (open + closed); the route post-filters to
    // the done set — so only the closed issue survives, no open over-return.
    expect(issues.map((i) => i.identifier)).toEqual(["octocat/hello-world#2"]);
  });

  it("GitHub list --state all returns both open and closed issues", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "github", "--state", "all", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier).sort()).toEqual([
      "octocat/hello-world#1",
      "octocat/hello-world#2",
    ]);
  });

  it("rejects issue creation with a docs pointer (writes land via docs/177, but create stays human-gated)", async () => {
    const { stderr, exitCode } = await runIssueShim(["issue", "create", "--title", "x"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("does not support `shipit issue create`");
    expect(stderr).toContain("/shipit-docs/issues.md");
  });
});
