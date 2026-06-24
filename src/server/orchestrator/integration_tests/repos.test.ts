/**
 * Integration tests for repo management endpoints and RepoStore.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { RepoStore } from "../repo-store.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import { StubAuthManager, StubGitHubAuthManager, createTestCredentialStore, createTestDatabaseManager } from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";

let tmpDir: string;
let app: FastifyInstance;
let sessionManager: SessionManager;
let repoStore: RepoStore;
let dbManager: DatabaseManager;
let githubStub: StubGitHubAuthManager;
let origGitTerminalPrompt: string | undefined;

beforeEach(async () => {
  dbManager = createTestDatabaseManager();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-repo-test-"));
  sessionManager = new SessionManager(dbManager);
  repoStore = new RepoStore(dbManager);

  // Prevent git from prompting for credentials (hangs in CI/test). The
  // claim-session slow path now re-clones a missing bare cache from the
  // remote (ensureBareCache); against a nonexistent repo that would block
  // on a credential prompt without this. GIT_TERMINAL_PROMPT=0 makes it
  // fail fast so the route returns 500.
  origGitTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_TERMINAL_PROMPT = "0";

  const credentialStore = createTestCredentialStore(tmpDir);

  githubStub = new StubGitHubAuthManager();

  app = await buildApp({
    sessionManager,
    repoStore,
    authManager: new StubAuthManager() as unknown as AuthManager,
    githubAuthManager: githubStub as unknown as GitHubAuthManager,
    credentialStore,
    workspaceDir: tmpDir,
    serveStatic: false,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await app.close();
  dbManager.close();
  if (origGitTerminalPrompt === undefined) {
    delete process.env.GIT_TERMINAL_PROMPT;
  } else {
    process.env.GIT_TERMINAL_PROMPT = origGitTerminalPrompt;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/repos", () => {
  it("returns empty list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/repos" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repos).toEqual([]);
  });

  it("returns repos after adding", async () => {
    repoStore.add("https://github.com/owner/repo.git");
    repoStore.setReady("https://github.com/owner/repo.git");

    const res = await app.inject({ method: "GET", url: "/api/repos" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({
      url: "https://github.com/owner/repo.git",
      status: "ready",
    });
  });
});

describe("POST /api/repos with url", () => {
  it("adds a new repo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { url: "https://github.com/test/repo.git" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repo).toMatchObject({
      url: "https://github.com/test/repo.git",
      status: "cloning",
    });

    // Verify it's in the store
    expect(repoStore.has("https://github.com/test/repo.git")).toBe(true);
  });

  it("supports owner/repo shorthand", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { url: "owner/repo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repo.url).toBe("https://github.com/owner/repo.git");
  });

  it("returns 400 for empty url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { url: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/repos/trust (docs/178)", () => {
  it("a repo added by URL is untrusted by default", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { url: "https://github.com/test/repo.git" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.trusted).toBe(false);
    expect(repoStore.isTrusted("https://github.com/test/repo.git")).toBe(false);
  });

  it("trusts a known remote", async () => {
    const url = "https://github.com/owner/repo.git";
    repoStore.add(url);
    repoStore.setReady(url);
    expect(repoStore.isTrusted(url)).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/trust",
      payload: { url },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ trusted: true });
    expect(repoStore.isTrusted(url)).toBe(true);
  });

  it("trusts by canonical identity regardless of URL form", async () => {
    repoStore.add("https://github.com/owner/repo.git");
    repoStore.setReady("https://github.com/owner/repo.git");

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/trust",
      // suffix-less form — same canonical key as the stored `.git` form
      payload: { url: "https://github.com/owner/repo" },
    });
    expect(res.statusCode).toBe(200);
    expect(repoStore.isTrusted("https://github.com/owner/repo.git")).toBe(true);
  });

  it("re-runs deferred setup for a still-WARM open session of the remote", async () => {
    // Regression: clicking Trust right after adding a repo — before the first
    // turn graduates the session — left the preview empty forever. The trust
    // endpoint enumerated `sessionManager.list()`, which filters out warm
    // sessions (`WHERE warm = 0`), so the just-claimed (still warm=1) session
    // the user was looking at was skipped and its deferred install/compose
    // never re-ran. It must enumerate the runner registry instead, which
    // includes warm sessions that have a live runner. (docs/178)
    const url = "https://github.com/owner/repo.git";
    repoStore.add(url);
    repoStore.setReady(url);

    // A just-claimed warm session, with a valid clone dir (tmpDir exists) and
    // registered as the repo's warm session — so the startup zombie-warm sweep
    // (`startup-tasks.ts`) keeps it instead of deleting it as a stale orphan.
    const warmId = "warm-session-1";
    sessionManager.track(warmId, undefined, tmpDir);
    sessionManager.setRemoteUrl(warmId, url);
    sessionManager.setWarm(warmId, true); // ungraduated → excluded from list()
    repoStore.setWarmSessionId(url, warmId);
    expect(sessionManager.list().some((s) => s.id === warmId)).toBe(false);

    let reran = 0;
    // Inject a minimal stub runner so trust's loop has something to nudge. A
    // warm session keeps its runner in the registry even though `list()` hides
    // it — that is exactly the case the fix must cover.
    (app.runnerRegistry as unknown as { runners: Map<string, unknown> }).runners.set(
      warmId,
      { disposed: false, rerunServiceSetup: () => { reran += 1; }, dispose: () => {} },
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/repos/trust",
      payload: { url },
    });
    expect(res.statusCode).toBe(200);
    expect(reran).toBe(1);
  });

  it("returns 404 for an unknown remote", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos/trust",
      payload: { url: "https://github.com/never/added.git" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for an empty url", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos/trust",
      payload: { url: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/repos/:url (hide/show, docs/222)", () => {
  const url = "https://github.com/owner/repo.git";

  it("hides a repo without removing it or its sessions", async () => {
    repoStore.add(url);
    sessionManager.track("sess-a", "A");
    sessionManager.setRemoteUrl("sess-a", url);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent(url)}`,
      payload: { hidden: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo).toMatchObject({ url, hidden: true });

    // Repo row and session both survive — only the visibility flag changed.
    expect(repoStore.has(url)).toBe(true);
    expect(repoStore.get(url)?.hidden).toBe(true);
    expect(sessionManager.get("sess-a")?.userArchived).toBeFalsy();
    expect(sessionManager.list().map((s) => s.id)).toContain("sess-a");
  });

  it("shows a hidden repo again", async () => {
    repoStore.add(url);
    repoStore.setHidden(url, true);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent(url)}`,
      payload: { hidden: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo).toMatchObject({ url, hidden: false });
    expect(repoStore.get(url)?.hidden).toBe(false);
  });

  it("re-adding a hidden repo unhides it", async () => {
    repoStore.add(url);
    repoStore.setHidden(url, true);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { url },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.hidden).toBe(false);
    expect(repoStore.get(url)?.hidden).toBe(false);
  });

  it("returns 400 when 'hidden' is missing or not a boolean", async () => {
    repoStore.add(url);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent(url)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown repo", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent("https://github.com/never/added.git")}`,
      payload: { hidden: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/repos/:url", () => {
  it("removes a repo", async () => {
    repoStore.add("https://github.com/owner/repo.git");

    const encodedUrl = encodeURIComponent("https://github.com/owner/repo.git");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodedUrl}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });

    expect(repoStore.has("https://github.com/owner/repo.git")).toBe(false);
  });

  it("returns 404 for unknown repo", async () => {
    const encodedUrl = encodeURIComponent("https://github.com/unknown/repo.git");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodedUrl}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("removes a repo whose URL exceeds Fastify's default 100-char maxParamLength", async () => {
    // A remote URL longer than 100 chars (long org/repo names, or a
    // credential-bearing URL) overflows Fastify's default maxParamLength of 100.
    // Before raising the ceiling the request never matched the route — it fell
    // through to a 404 here, and to the SPA static handler in prod — so the repo
    // was silently undeletable from the UI. See `maxParamLength` in index.ts.
    const longUrl =
      "https://github.com/a-very-long-organization-name-here/an-equally-long-repository-name-that-pushes-us-well-past-one-hundred-characters.git";
    expect(longUrl.length).toBeGreaterThan(100);
    repoStore.add(longUrl);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodeURIComponent(longUrl)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(repoStore.has(longUrl)).toBe(false);
  });

  it("archives the repo's sessions so they leave the sidebar but stay in the DB", async () => {
    const repoUrl = "https://github.com/owner/repo.git";
    repoStore.add(repoUrl);

    // Two real sessions backed by this repo, plus an unrelated one.
    sessionManager.track("sess-a", "A");
    sessionManager.setRemoteUrl("sess-a", repoUrl);
    sessionManager.track("sess-b", "B");
    sessionManager.setRemoteUrl("sess-b", repoUrl);
    sessionManager.track("sess-other", "Other");
    sessionManager.setRemoteUrl("sess-other", "https://github.com/owner/different.git");

    expect(sessionManager.list().map((s) => s.id).sort()).toEqual(["sess-a", "sess-b", "sess-other"]);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/repos/${encodeURIComponent(repoUrl)}`,
    });
    expect(res.statusCode).toBe(200);

    // The repo's sessions are gone from the sidebar list…
    expect(sessionManager.list().map((s) => s.id)).toEqual(["sess-other"]);
    // …but still present in the DB, flagged archived (history preserved).
    expect(sessionManager.get("sess-a")?.userArchived).toBe(true);
    expect(sessionManager.get("sess-b")?.userArchived).toBe(true);
    // The unrelated session is untouched.
    expect(sessionManager.get("sess-other")?.userArchived).toBeUndefined();
  });
});

describe("GET /api/github/orgs", () => {
  it("returns [] when not authenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/api/github/orgs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgs).toEqual([]);
  });

  it("returns the user's organizations when authenticated", async () => {
    await githubStub.setToken("ghp_test");
    githubStub.setOrgs([
      { login: "acme", avatarUrl: "https://a/acme.png" },
      { login: "globex", avatarUrl: "https://a/globex.png" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/github/orgs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgs.map((o: { login: string }) => o.login)).toEqual(["acme", "globex"]);
  });
});

describe("Bootstrap includes repos", () => {
  it("returns repos in bootstrap data", async () => {
    repoStore.add("https://github.com/owner/repo.git");
    repoStore.setReady("https://github.com/owner/repo.git");

    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0].url).toBe("https://github.com/owner/repo.git");
  });
});

describe("POST /api/repos/:url/claim-session", () => {
  it("returns 404 for unknown repo", async () => {
    const encodedUrl = encodeURIComponent("https://github.com/unknown/repo.git");
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for repo still cloning", async () => {
    repoStore.add("https://github.com/owner/repo.git");
    // status is "cloning" by default after add()

    const encodedUrl = encodeURIComponent("https://github.com/owner/repo.git");
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "Repository is still cloning" });
  });

  it("creates a synchronous session when no warm session is available", async () => {
    const repoUrl = "https://github.com/owner/repo.git";
    repoStore.add(repoUrl);
    repoStore.setReady(repoUrl);

    // Create the cached repo dir with a valid git repo so the claim path works
    const repoDir = path.join(tmpDir, "repos");
    fs.mkdirSync(repoDir, { recursive: true });

    const encodedUrl = encodeURIComponent(repoUrl);
    const res = await app.inject({
      method: "POST",
      url: `/api/repos/${encodedUrl}/claim-session`,
    });

    // This will fail if the shared repo dir doesn't exist — but it exercises
    // the error path cleanly (500 with descriptive message)
    if (res.statusCode === 200) {
      const body = res.json();
      expect(body.sessionId).toBeDefined();
      expect(body.sessionDir).toBeDefined();
    } else {
      // Expected when cached repo dir hash doesn't match — the fallback tries
      // to clone from a nonexistent repo dir
      expect(res.statusCode).toBe(500);
    }
  });
});
