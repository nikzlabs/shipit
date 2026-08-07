/**
 * Integration tests for declared additional issue trackers (docs/248, planning#306).
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

/** The canonical single declaration used across these tests. */
const DECLARE_PLANNING =
  "issues:\n  trackers:\n    - kind: github\n      repo: planning-owner/planning\n      name: planning\n";

const destinationsIds = (d: { destinations: { id: string }[] }): string[] =>
  d.destinations.map((x) => x.id);

describe("Integration: declared issue trackers (docs/248)", () => {
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

  const destinations = async (): Promise<{
    destinations: { id: string; name?: string; kind: string }[];
    warnings: string[];
  }> => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess/issue/trackers" });
    expect(res.statusCode).toBe(200);
    return res.json() as { destinations: { id: string; name?: string; kind: string }[]; warnings: string[] };
  };

  // -- Declaration → tab (reqs 1, 9) ----------------------------------------

  it("renders a declared repository as its own tab", async () => {
    writeConfig(DECLARE_PLANNING);
    const list = await trackers();
    expect(list.map((t) => t.id)).toEqual(["github", "github:planning-owner/planning"]);
    const planning = list.find((t) => t.id === "github:planning-owner/planning")!;
    expect(planning.label).toBe("planning");
    expect(planning.name).toBe("planning");
    expect(planning.configured).toBe(true);
    expect(planning.binding).toEqual({
      key: "planning-owner/planning",
      name: "planning-owner/planning",
    });
  });

  // req 1's clean break: a deployment with a stored Linear credential gets no
  // Linear tab until a repository declares one. No migration, no warning — the
  // absence of the tab is the only signal, by decision.
  it("shows no Linear tab for a repository that declares none, even with a credential", async () => {
    credentialStore.setLinearToken("lin_api_x");
    expect((await trackers()).map((t) => t.id)).toEqual(["github"]);
  });

  it("renders a declared linear team as its own tab (reqs 3–5)", async () => {
    credentialStore.setLinearToken("lin_api_x");
    writeConfig(
      "issues:\n  trackers:\n    - kind: linear\n      team: SHI\n      name: roadmap\n",
    );
    const list = await trackers();
    expect(list.map((t) => t.id)).toEqual(["github", "linear:SHI"]);
    const roadmap = list.find((t) => t.id === "linear:SHI")!;
    expect(roadmap).toMatchObject({ name: "roadmap", kind: "linear", configured: true });
  });

  it("renders two linear teams declared at once", async () => {
    credentialStore.setLinearToken("lin_api_x");
    writeConfig(
      "issues:\n  trackers:\n" +
        "    - kind: linear\n      team: SHI\n      name: roadmap\n" +
        "    - kind: linear\n      team: OPS\n      name: ops\n",
    );
    expect((await trackers()).map((t) => t.id)).toEqual(["github", "linear:SHI", "linear:OPS"]);
  });

  // req 12 — a repository may declare its OWN repository to give it a name. The
  // shipped registry discarded such a declaration; now it replaces the unnamed
  // tab rather than adding a second one for the same issues.
  it("names the session's own repository without minting a duplicate tab", async () => {
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: code-owner/app\n      name: code\n");
    const list = await trackers();
    expect(list.map((t) => t.id)).toEqual(["github:code-owner/app"]);
    expect(list[0].name).toBe("code");
    // Still reachable unnamed — req 12's exception survives the self-declaration.
    expect(destinationsIds(await destinations())).toContain("github");
  });

  it("shows only the session's own repository when nothing is declared", async () => {
    expect((await trackers()).map((t) => t.id)).toEqual(["github"]);
  });

  it("reflects an edited shipit.yaml on the next request, with no restart", async () => {
    writeConfig(DECLARE_PLANNING);
    expect((await trackers()).map((t) => t.id)).toContain("github:planning-owner/planning");
    writeConfig("issues:\n  trackers: []\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["github"]);
  });

  it("ignores an unrecognized tracker kind instead of failing the tab list", async () => {
    // Forward compatibility (req 7): a config written for a newer ShipIt must
    // degrade to a missing tab, never to a broken Issues panel.
    writeConfig("issues:\n  trackers:\n    - kind: some-future-tracker\n      handle: x\n      name: future\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["github"]);
  });

  it("degrades to no declared trackers when shipit.yaml is unparseable", async () => {
    writeConfig("issues:\n  trackers:\n  - kind: github\n   repo: broken indent\n");
    expect((await trackers()).map((t) => t.id)).toEqual(["github"]);
  });

  // -- Declaration warnings reach the agent (req 8) --------------------------

  it("surfaces declaration warnings on the destinations route the shim reads", async () => {
    writeConfig(
      "issues:\n  trackers:\n" +
        "    - kind: github\n      repo: planning-owner/planning\n      name: planning\n" +
        "    - kind: github\n      repo: other/other\n      name: planning\n" +
        "    - kind: jira\n      project: X\n      name: jira\n",
    );
    const { destinations: dests, warnings } = await destinations();
    // The duplicate name and the unknown kind are both dropped...
    expect(dests.map((d) => d.id)).toEqual(["github", "github:planning-owner/planning"]);
    // ...and both are reported, so the agent can repair the declaration.
    expect(warnings.some((w) => w.includes("duplicate tracker name"))).toBe(true);
    expect(warnings.some((w) => w.includes("jira"))).toBe(true);
  });

  it("says so when shipit.yaml could not be parsed at all", async () => {
    writeConfig("issues:\n  trackers:\n  - kind: github\n   repo: broken indent\n");
    const { warnings } = await destinations();
    expect(warnings.some((w) => w.includes("could not be parsed"))).toBe(true);
  });

  // -- Same-numbered issues in two repositories ------------------------------
  //
  // The shipped regression guard for the routing invariant, unchanged in intent:
  // every assertion naming a URL is really asserting the wrong repository was
  // not touched.

  it("reads #42 from the declared repository, not the code repository", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "GET",
      url: "/api/issue?tracker=github%3Aplanning-owner%2Fplanning&id=42&sessionId=sess",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { issue: TrackerIssue };
    expect(body.issue.title).toBe("Planning issue");
    // req 15 — ShipIt-emitted references carry the declared name form.
    expect(body.issue.identifier).toBe("planning#42");
    expect(requestedUrls.some((u) => u.includes("/repos/code-owner/app/"))).toBe(false);
  });

  it("still reads #42 from the code repository for the bare `github` tracker", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "GET",
      url: "/api/issue?tracker=github&id=42&sessionId=sess",
    });
    expect(res.statusCode).toBe(200);
    const issue = (res.json() as { issue: TrackerIssue }).issue;
    expect(issue.title).toBe("Code repo issue");
    // Unnamed destination → the backend's own address form.
    expect(issue.identifier).toBe("code-owner/app#42");
    expect(requestedUrls.some((u) => u.includes("/repos/planning-owner/"))).toBe(false);
  });

  it("lists each destination independently", async () => {
    writeConfig(DECLARE_PLANNING);
    const code = await app.inject({ method: "GET", url: "/api/issues?tracker=github&sessionId=sess" });
    const planning = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Aplanning-owner%2Fplanning&sessionId=sess",
    });
    expect((code.json() as { issues: TrackerIssue[] }).issues[0].title).toBe("Code repo issue");
    expect((planning.json() as { issues: TrackerIssue[] }).issues[0].title).toBe("Planning issue");
  });

  // -- Fail closed on an undeclared destination (req 11) ---------------------

  it("refuses an UNDECLARED repository named on the operation", async () => {
    // The shipped registry synthesized a tracker for any well-formed id, so
    // `--repo` reached anything the credential could see. Requirement 11 removed
    // that: req 1 leaves no destination outside the declarations, so this has
    // nowhere to go — and it must not silently become the code repository.
    const res = await app.inject({
      method: "GET",
      url: "/api/issues?tracker=github%3Aprivate-owner%2Fnotes&sessionId=sess",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).toMatch(/not a tracker this repository declares/i);
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });

  it("fails closed on an unreachable DECLARED repository, naming both possibilities", async () => {
    // GitHub returns 404 for a private repo the credential cannot see, so the
    // error must not claim the repository is missing — the two are genuinely
    // indistinguishable and send the user to different fixes.
    writeConfig("issues:\n  trackers:\n    - kind: github\n      repo: missing-owner/nope\n      name: gone\n");
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

  // req 13 — a create ALWAYS names its destination. The shim enforces it, but
  // `/agent-ops/issue/*` is reachable from the session container by anything the
  // agent runs, so a `curl` bypasses the shim entirely. Without a server-side
  // backstop the rule would be a convention, not a guarantee — and the thing it
  // guards against is filing a planning issue into a PUBLIC code repository.
  it("refuses a create addressed at the unnamed own repository", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess/issue/create",
      payload: { tracker: "github", title: "Private planning item" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/must name the tracker it files into/i);
    // Nothing reached GitHub — the issue was never created anywhere.
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });

  it("refuses a label create addressed at the unnamed own repository", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess/issue/label/create",
      payload: { tracker: "github", name: "internal" },
    });
    expect(res.statusCode).toBe(400);
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });

  // The write body carries `tracker` (where the write goes) and `trackerName`
  // (the name it was addressed through) as independent caller-supplied fields.
  // Undo re-resolves through the NAME first (req 16), so an incoherent pair
  // writes to one destination and, on Undo, applies that snapshot to another —
  // the wrong-target bug this feature exists to prevent. The shim always derives
  // both from one resolution, but this endpoint is container-accessible.
  it("refuses a write whose trackerName names a different destination than its tracker", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess/issue/comment",
      payload: { tracker: "github:code-owner/app", trackerName: "planning", id: "42", body: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/other than the one it was addressed through/i);
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });

  it("refuses a write naming a trackerName this repository does not declare", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess/issue/comment",
      payload: { tracker: "github:planning-owner/planning", trackerName: "roadmap", id: "42", body: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(requestedUrls.some((u) => u.includes("/repos/"))).toBe(false);
  });

  // The mirror of the two above: a COHERENT pair must get past the check. This
  // harness has no attached runner, so the write then stops at the 409 that
  // guards card emission — which is precisely the evidence wanted here, since a
  // rejected pair never reaches it. The completed write is covered in
  // `agent-issue-access.test.ts`, which runs with a runner.
  it("lets a write whose trackerName and tracker agree past the coherence check", async () => {
    writeConfig(DECLARE_PLANNING);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/sess/issue/comment",
      payload: { tracker: "github:planning-owner/planning", trackerName: "planning", id: "42", body: "hi" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).not.toMatch(/addressed through/i);
  });

  it("rejects the retired bare `linear` id rather than reading a stored team", async () => {
    credentialStore.setLinearToken("lin_api_x");
    const res = await app.inject({ method: "GET", url: "/api/issues?tracker=linear&sessionId=sess" });
    expect(res.statusCode).toBe(404);
  });
});
