/**
 * Integration tests for declared additional issue trackers (docs/247, SHI-304).
 *
 * Exercises the end-to-end path a `shipit.yaml` declaration takes: the config
 * parser → `resolveGitHubTrackerContext` → the tracker registry → the routes the
 * Issues tab and the `shipit issue` shim both call. Orchestrator-only, with the
 * GitHub REST calls stubbed through `trackerFetchImpl`.
 *
 * The load-bearing case is the **same-numbered issue**: two repositories that
 * each have an issue `#42`. Before this feature, a qualified pointer's
 * repository was reduced to display text and every GitHub operation was
 * reconstructed against the *session's* remote, so `planning-owner/planning#42`
 * would read or mutate `code-owner/app`'s issue 42 instead. Every assertion here
 * that names a URL is really asserting that the wrong repository was not
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import type { TrackerInfo, TrackerIssue } from "../../shared/types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A GitHub REST issue node for `owner/repo#number`. */
function ghIssue(owner: string, repo: string, number: number, title: string) {
  return {
    id: number,
    number,
    title,
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    state: "open",
    labels: [],
    assignee: null,
  };
}

describe("Integration: declared issue trackers (docs/247)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let workspaceDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let githubAuthManager: StubGitHubAuthManager;
  let trackerFetch: ReturnType<typeof vi.fn>;
  /** Every GitHub URL the app requested, in order — the routing assertion. */
  let requestedUrls: string[];

  /** Write the session workspace's shipit.yaml. */
  const writeConfig = (yaml: string) => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-declared-trackers-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    initGlobalGitConfig(tmpDir);
    credentialStore = new CredentialStore(tmpDir);

    requestedUrls = [];
    // Serve each repo's issues from its own URL, so a request that reached the
    // wrong repository returns the wrong issue rather than silently passing.
    trackerFetch = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes("/repos/code-owner/app/issues/42")) {
        return jsonResponse(ghIssue("code-owner", "app", 42, "Code repo issue"));
      }
      if (url.includes("/repos/planning-owner/planning/issues/42")) {
        return jsonResponse(ghIssue("planning-owner", "planning", 42, "Planning issue"));
      }
      if (url.includes("/repos/code-owner/app/issues")) {
        return jsonResponse([ghIssue("code-owner", "app", 42, "Code repo issue")]);
      }
      if (url.includes("/repos/planning-owner/planning/issues")) {
        return jsonResponse([ghIssue("planning-owner", "planning", 42, "Planning issue")]);
      }
      if (url.includes("/repos/private-owner/notes/issues")) {
        return jsonResponse([ghIssue("private-owner", "notes", 7, "Undeclared but reachable")]);
      }
      if (url.includes("/repos/missing-owner/nope/issues")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return jsonResponse([]);
    });

    sessionManager = new SessionManager(dbManager);
    githubAuthManager = new StubGitHubAuthManager();
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

    await githubAuthManager.setToken("ghp_test_token");
    sessionManager.track("sess", "Session", workspaceDir);
    sessionManager.setRemoteUrl("sess", "https://github.com/code-owner/app.git");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  });

  const trackers = async (): Promise<TrackerInfo[]> => {
    const res = await app.inject({ method: "GET", url: "/api/trackers?sessionId=sess" });
    expect(res.statusCode).toBe(200);
    return (res.json() as { trackers: TrackerInfo[] }).trackers;
  };

  // -- Declaration → tab ----------------------------------------------------

  it("renders a declared repository as its own tab", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n      label: Planning\n");
    const list = await trackers();
    expect(list.map((t) => t.id)).toEqual(["linear", "github", "github:planning-owner/planning"]);
    const planning = list.find((t) => t.id === "github:planning-owner/planning")!;
    expect(planning.label).toBe("Planning");
    expect(planning.configured).toBe(true);
    expect(planning.binding).toEqual({
      key: "planning-owner/planning",
      name: "planning-owner/planning",
    });
  });

  it("shows no extra tab when the repository declares none", async () => {
    expect((await trackers()).map((t) => t.id)).toEqual(["linear", "github"]);
  });

  it("reflects an edited shipit.yaml on the next request, with no restart", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n");
    expect((await trackers()).map((t) => t.id)).toContain("github:planning-owner/planning");
    writeConfig("issues:\n  trackers: []\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["linear", "github"]);
  });

  it("ignores an unrecognized tracker kind instead of failing the tab list", async () => {
    // Forward compatibility (req 5): a config written for a newer ShipIt must
    // degrade to a missing tab, never to a broken Issues panel.
    writeConfig("issues:\n  trackers:\n    - kind: some-future-tracker\n      handle: x\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["linear", "github"]);
  });

  it("degrades to no declared trackers when shipit.yaml is unparseable", async () => {
    writeConfig("issues:\n  trackers:\n  - kind: github\n   repo: broken indent\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["linear", "github"]);
  });

  // -- Same-numbered issues in two repositories -----------------------------

  it("reads #42 from the declared repository, not the code repository", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n");
    const res = await app.inject({
      method: "GET",
      url: "/api/issue?tracker=github%3Aplanning-owner%2Fplanning&id=42&sessionId=sess",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { issue: TrackerIssue };
    expect(body.issue.title).toBe("Planning issue");
    expect(body.issue.identifier).toBe("planning-owner/planning#42");
    expect(requestedUrls.some((u) => u.includes("/repos/code-owner/app/"))).toBe(false);
  });

  it("still reads #42 from the code repository for the bare `github` tracker", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n");
    const res = await app.inject({
      method: "GET",
      url: "/api/issue?tracker=github&id=42&sessionId=sess",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { issue: TrackerIssue }).issue.title).toBe("Code repo issue");
    expect(requestedUrls.some((u) => u.includes("/repos/planning-owner/"))).toBe(false);
  });

  it("lists each destination independently", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n");
    const code = await app.inject({ method: "GET", url: "/api/issues?tracker=github&sessionId=sess" });
    const planning = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Aplanning-owner%2Fplanning&sessionId=sess",
    });
    expect((code.json() as { issues: TrackerIssue[] }).issues[0].title).toBe("Code repo issue");
    expect((planning.json() as { issues: TrackerIssue[] }).issues[0].title).toBe("Planning issue");
  });

  // -- `--repo` reaches any repository the credential can reach --------------

  it("resolves an UNDECLARED repository named on the operation", async () => {
    // req 3 — declarations drive tabs, not reachability. `--repo` accepts any
    // repository the credential can reach, with GitHub authorization as the only
    // gate, so this must work with an empty `issues:` block.
    const res = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Aprivate-owner%2Fnotes&sessionId=sess",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tracker: TrackerInfo; issues: TrackerIssue[] };
    expect(body.issues[0].title).toBe("Undeclared but reachable");
    // ...and it stays off the tab list.
    expect((await trackers()).map((t) => t.id)).not.toContain("github:private-owner/notes");
  });

  it("fails closed on an unreachable repository, naming both possibilities", async () => {
    // GitHub returns 404 for a private repo the credential cannot see, so the
    // error must not claim the repository is missing — the two are genuinely
    // indistinguishable and send the user to different fixes.
    const res = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Amissing-owner%2Fnope&sessionId=sess",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const message = JSON.stringify(res.json());
    expect(message).toContain("missing-owner/nope");
    expect(message).toMatch(/does not exist/i);
    expect(message).toMatch(/cannot access/i);
    // No fallback: the code repository was never tried.
    expect(requestedUrls.some((u) => u.includes("/repos/code-owner/app/"))).toBe(false);
  });

  it("rejects a malformed tracker id rather than falling back to the code repo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Anot-a-slug&sessionId=sess",
    });
    expect(res.statusCode).toBe(404);
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });
});
