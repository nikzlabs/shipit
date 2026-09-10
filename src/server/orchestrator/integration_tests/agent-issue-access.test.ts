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

describe("Integration: agent issue access (docs/175)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let trackerFetch: ReturnType<typeof vi.fn>;
  let sessionId: string;
  let workspaceDir: string;

  const writeConfig = (yaml: string) => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-issue-"));
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    trackerFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("linear.app")) {
        const query = (JSON.parse((init?.body as string) ?? "{}") as { query?: string }).query ?? "";
        if (query.includes("TeamByKey")) {
          return jsonResponse({ data: { teams: { nodes: [{ id: "team-1", key: "TRACKER" }] } } });
        }
        if (query.includes("TeamIssues")) {
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
        // Match IssueComments before the broader Issue check.
        if (query.includes("IssueComments")) {
          return jsonResponse({
            data: {
              issue: {
                team: { key: "TRACKER" },
                comments: {
                  nodes: [
                    { id: "c1", body: "first Linear comment", url: "lc1", createdAt: "2026-01-01T00:00:00Z", user: { displayName: "Nik" } },
                    { id: "c2", body: "second Linear comment", url: "lc2", createdAt: "2026-01-02T00:00:00Z", user: { displayName: "Pat" } },
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
                team: { key: "TRACKER" },
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
      // Match comment URLs before the broader issue regex.
      if (/\/issues\/\d+\/comments/.test(url)) {
        return jsonResponse([
          {
            id: 11,
            body: "first GH comment",
            html_url: "https://github.com/octocat/hello-world/issues/42#issuecomment-11",
            created_at: "2026-01-01T00:00:00Z",
            user: { login: "octocat" },
          },
          {
            id: 12,
            body: "second GH comment",
            html_url: "https://github.com/octocat/hello-world/issues/42#issuecomment-12",
            created_at: "2026-01-02T00:00:00Z",
            user: { login: "monalisa" },
          },
        ]);
      }
      if (url.includes("/repos/acme/planning/issues/7")) {
        return jsonResponse({
          id: 7,
          number: 7,
          title: "A planning issue",
          html_url: "https://github.com/acme/planning/issues/7",
          state: "open",
          labels: [],
          body: "The planning body.",
          assignee: null,
        });
      }
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

    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeConfig(
      "issues:\n  trackers:\n" +
        "    - kind: linear\n      team: TRACKER\n      name: roadmap\n" +
        "    - kind: github\n      repo: acme/planning\n      name: planning\n",
    );

    sessionId = "gh-sess";
    sessionManager.track(sessionId, "GH session", workspaceDir);
    sessionManager.setRemoteUrl(sessionId, "https://github.com/octocat/hello-world.git");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
      method: "GET" | "POST" | "PATCH",
      reqPath: string,
      body?: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
      const suffix = reqPath.replace(/^\/agent-ops\/issue/, "");
      const res = await app.inject({
        method,
        url: `/api/sessions/${sessionId}/issue${suffix}`,
        ...(body !== undefined ? { payload: body as object } : {}),
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
    const { stdout, exitCode } = await runIssueShim(["issue", "view", "42"]);
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
        const { stdout, exitCode } = await runIssueShim(["issue", "view", "TRACKER-28"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TRACKER-28");
    expect(stdout).toContain("Decouple priorities");
    expect(stdout).toContain("priority:  Urgent");
    expect(stdout).toContain("The Linear body.");
  });

  it("view --comments reads the GitHub thread after the issue body (planning#139)", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "view", "octocat/hello-world#42", "--comments",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("The GitHub body.");
    expect(stdout).toContain("comments (2):");
    expect(stdout).toContain("octocat · 2026-01-01T00:00:00Z");
    expect(stdout).toContain("first GH comment");
    expect(stdout).toContain("monalisa");
    expect(stdout).toContain("second GH comment");
  });

  it("view --comments --json embeds a comments array on the issue (planning#139)", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "view", "octocat/hello-world#42", "--comments", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issue = JSON.parse(stdout) as { identifier: string; comments: { body: string; author?: { name: string } }[] };
    expect(issue.identifier).toBe("octocat/hello-world#42");
    expect(issue.comments.map((c) => c.body)).toEqual(["first GH comment", "second GH comment"]);
    expect(issue.comments[0].author?.name).toBe("octocat");
  });

  it("view --comments reads the Linear thread with the same shape (planning#139)", async () => {
    credentialStore.setLinearToken("lin_api_x");
        const { stdout, exitCode } = await runIssueShim(["issue", "view", "TRACKER-28", "--comments"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("The Linear body.");
    expect(stdout).toContain("comments (2):");
    expect(stdout).toContain("Nik · 2026-01-01T00:00:00Z");
    expect(stdout).toContain("first Linear comment");
    expect(stdout).toContain("second Linear comment");
  });

  it("view --comments errors (exit 1) when Linear is unconfigured", async () => {
    const { exitCode, stderr } = await runIssueShim(["issue", "view", "TRACKER-28", "--comments"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not configured/i);
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
        const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "roadmap", "--state", "closed", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier)).toEqual(["roadmap#TRACKER-2"]);
  });

  it("list --state all keeps both open and finished issues", async () => {
    credentialStore.setLinearToken("lin_api_x");
        const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--tracker", "roadmap", "--state", "all", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier).sort()).toEqual(["roadmap#TRACKER-1", "roadmap#TRACKER-2"]);
  });

  it("GitHub list --state open returns open issues only", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--state", "open", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier)).toEqual(["octocat/hello-world#1"]);
  });

  it("GitHub list --state closed returns closed issues only", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--state", "closed", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier)).toEqual(["octocat/hello-world#2"]);
  });

  it("GitHub list --state all returns both open and closed issues", async () => {
    const { stdout, exitCode } = await runIssueShim([
      "issue", "list", "--state", "all", "--json",
    ]);
    expect(exitCode).toBe(0);
    const issues = JSON.parse(stdout) as { identifier: string }[];
    expect(issues.map((i) => i.identifier).sort()).toEqual([
      "octocat/hello-world#1",
      "octocat/hello-world#2",
    ]);
  });

  it("accepts `issue create` and brokers it to the create route (docs/187 — no longer human-gated)", async () => {
    // No runner is attached; a parsed write reaches the route's activity guard.
    const { stderr, exitCode } = await runIssueShim(["issue", "create", "--title", "x", "--tracker", "planning"]);
    expect(stderr).not.toContain("does not support");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Session is not active");
  });

  it("accepts `issue label create` and brokers it to the label route (planning#232)", async () => {
    const { stderr, exitCode } = await runIssueShim([
      "issue", "label", "create", "--name", "t3code", "--tracker", "planning",
    ]);
    expect(stderr).not.toContain("are supported");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Session is not active");
  });

  it("accepts `issue label edit` and brokers it to the label-edit route (planning#88)", async () => {
    const { stderr, exitCode } = await runIssueShim([
      "issue", "label", "edit", "--name", "bug", "--new-name", "Bug", "--tracker", "planning",
    ]);
    expect(stderr).not.toContain("are supported");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Session is not active");
  });

  it("rejects `issue label delete` at the shim, pointing at edit (planning#88)", async () => {
    const { stderr, exitCode } = await runIssueShim(["issue", "label", "delete", "t3code"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no issue carries");
    expect(stderr).toContain("shipit issue label edit");
  });

  describe("declared trackers (docs/248)", () => {
    it.each([
      ["tracker name + backend id", "planning#7"],
      ["the backend's canonical address", "acme/planning#7"],
      ["a bare id with --tracker", "7"],
    ])("resolves a declared GitHub tracker by %s", async (_label, reference) => {
      const argv = reference === "7"
        ? ["issue", "view", "7", "--tracker", "planning", "--json"]
        : ["issue", "view", reference, "--json"];
      const { stdout, exitCode } = await runIssueShim(argv);
      expect(exitCode).toBe(0);
      const issue = JSON.parse(stdout) as { identifier: string; title: string };
      expect(issue.title).toBe("A planning issue");
      expect(issue.identifier).toBe("planning#7");
    });

    it.each([
      ["tracker name + backend id", "roadmap#TRACKER-28"],
      ["tracker name + number", "roadmap#28"],
      ["the backend's canonical address", "TRACKER-28"],
    ])("resolves a declared Linear tracker by %s", async (_label, reference) => {
      credentialStore.setLinearToken("lin_api_x");
      const { stdout, exitCode } = await runIssueShim(["issue", "view", reference]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Decouple priorities");
    });

    it("fails closed on a canonical address for an undeclared repository", async () => {
      const { stderr, exitCode } = await runIssueShim(["issue", "view", "someone/else#7"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/does not declare/i);
      expect(stderr).toContain("planning");
    });

    it("fails closed on a name nobody declared", async () => {
      const { stderr, exitCode } = await runIssueShim(["issue", "view", "nope#7"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/No issue tracker named/i);
    });

    it("refuses a duplicate destination at declaration time rather than resolving ambiguously", async () => {
      writeConfig(
        "issues:\n  trackers:\n" +
          "    - kind: github\n      repo: acme/planning\n      name: planning\n" +
          "    - kind: github\n      repo: acme/planning\n      name: alias\n",
      );
      const { stdout, stderr } = await runIssueShim(["issue", "view", "acme/planning#7"]);
      expect(stderr).toMatch(/already declared as `planning`/i);
      expect(stderr).not.toMatch(/more than one declared tracker/i);
      expect(`${stdout}${stderr}`).toContain("planning#7");
    });

    it("refuses `issue create` with no --tracker", async () => {
      const { stderr, exitCode } = await runIssueShim(["issue", "create", "--title", "x"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--tracker <name> is required");
      expect(stderr).toContain("planning");
    });

    it("refuses `issue label create` with no --tracker", async () => {
      const { stderr, exitCode } = await runIssueShim(["issue", "label", "create", "--name", "x"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--tracker <name> is required");
    });

    it("prints declaration warnings on stderr even when the command succeeds", async () => {
      writeConfig(
        "issues:\n  trackers:\n" +
          "    - kind: github\n      repo: acme/planning\n      name: planning\n" +
          "    - kind: jira\n      project: X\n      name: jira\n",
      );
      const { stderr, exitCode } = await runIssueShim(["issue", "view", "planning#7"]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("jira");
    });

    it("still reaches the session's own repository with a bare number", async () => {
      const { stdout, exitCode } = await runIssueShim(["issue", "view", "42", "--json"]);
      expect(exitCode).toBe(0);
      expect((JSON.parse(stdout) as { title: string }).title).toBe("An open issue");
    });

    it("rejects `--repo`, which no longer exists", async () => {
      const { stderr, exitCode } = await runIssueShim([
        "issue", "list", "--repo", "acme/planning",
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Unsupported flag");
    });
  });
});
