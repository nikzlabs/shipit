/**
 * Integration tests for plugin feedback (docs/262 req 25) — reporting a bug, a
 * limitation or a feature request about a plugin as an issue on the **plugin's
 * own repository**, from inside a project session.
 *
 * The path under test is the whole channel: a `plugins.repos` declaration in the
 * project's `shipit.yaml` → `resolveGitHubTrackerContext` → the tracker registry
 * → the two container-reachable routes the `shipit issue` shim calls
 * (`issue/trackers` to resolve the name, `issue/create` to file). GitHub REST is
 * stubbed through `trackerFetchImpl`, so every assertion naming a URL is really
 * asserting the report reached the plugin's repository and nothing else did.
 *
 * The load-bearing assertions:
 *  - declaring the plugin is the ONLY configuration (req 25);
 *  - the report carries the exact commit the session is running (reqs 15, 25);
 *  - a plugin repository is not one of the project's trackers, so it renders no
 *    Issues tab;
 *  - filing is the whole channel — nothing here reaches a git remote (req 7).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  TestClient,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import type { TrackerInfo } from "../../shared/types.js";
import type { TrackerDestination } from "../../shared/declared-tracker.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The canonical declaration: one plugin repository, one plugin used from it. */
const DECLARE_TOOLS =
  "plugins:\n" +
  "  repos:\n" +
  "    - repo: acme/dev-tools\n" +
  "      name: tools\n" +
  "      branch: main\n" +
  "  use:\n" +
  "    - plugin: requirements\n" +
  "      from: tools\n";

const COMMIT = "9f2a1b3c4d5e6f708192a3b4c5d6e7f809a1b2c3";

describe("Integration: plugin feedback (docs/262 req 25)", () => {
  let app: FastifyInstance;
  let port: number;
  let client: TestClient | null;
  let tmpDir: string;
  let sessionDir: string;
  let workspaceDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let trackerFetch: ReturnType<typeof vi.fn>;
  /** Every GitHub call the app made, in order — the routing assertion. */
  let calls: { url: string; method: string; body?: string }[];

  const writeConfig = (yaml: string) =>
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);

  /**
   * Fake what an activation left on disk: the generation record the session is
   * running, behind the `active` symlink every reader follows.
   */
  const writeActiveGeneration = (
    repoName: string,
    commit: string,
    ref = "branch main",
    // What the generation was built FROM. A record is only this declaration's
    // when its source still matches what the declaration points at — the name
    // alone is re-pointable, so `source` is what stops a moved declaration
    // stamping a report with the previous repository's commit.
    source = "acme/dev-tools",
  ) => {
    const repoRoot = path.join(sessionDir, "state", "plugins", repoName);
    const generation = path.join(repoRoot, "generations", commit);
    fs.mkdirSync(generation, { recursive: true });
    fs.writeFileSync(
      path.join(generation, ".shipit-generation.json"),
      JSON.stringify({
        repoName,
        source,
        commit,
        ref,
        activatedAt: new Date().toISOString(),
        exports: ["requirements"],
        manifestWarnings: [],
      }),
    );
    fs.symlinkSync(generation, path.join(repoRoot, "active"));
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-plugin-feedback-"));
    // The state dir is derived from the clone sitting at `<sessionDir>/workspace`
    // (docs/246), and the running commit is read from it — so the layout matters.
    sessionDir = path.join(tmpDir, "sessions", "sess");
    workspaceDir = path.join(sessionDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    initGlobalGitConfig(tmpDir);
    execFileSync("git", ["config", "--global", "user.email", "test@shipit.local"]);
    execFileSync("git", ["config", "--global", "user.name", "ShipIt Test"]);
    // A real clone, so activating the session attaches a runner instead of
    // trying to restore a workspace it thinks is missing.
    await new GitManager(workspaceDir).init();
    credentialStore = new CredentialStore(tmpDir);

    calls = [];
    trackerFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.includes("/repos/acme/dev-tools/issues")) {
        return jsonResponse({
          id: 12,
          number: 12,
          title: "filed",
          html_url: "https://github.com/acme/dev-tools/issues/12",
          state: "open",
          labels: [],
          assignee: null,
        });
      }
      return jsonResponse([]);
    });

    sessionManager = new SessionManager(dbManager);
    const githubAuthManager = new StubGitHubAuthManager();
    client = null;
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
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    await githubAuthManager.setToken("ghp_test_token");
    sessionManager.track("sess", "Session", workspaceDir);
    sessionManager.setRemoteUrl("sess", "https://github.com/code-owner/app.git");
  });

  /** A write is only recorded for an ACTIVE session, so attach a viewer first. */
  const attachViewer = async (): Promise<void> => {
    client = await TestClient.connect(port, "sess");
    await client.receive();
  };

  afterEach(async () => {
    client?.close();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  });

  const destinations = async (): Promise<TrackerDestination[]> => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess/issue/trackers" });
    expect(res.statusCode).toBe(200);
    return (res.json() as { destinations: TrackerDestination[] }).destinations;
  };

  const tabs = async (): Promise<TrackerInfo[]> => {
    const res = await app.inject({ method: "GET", url: "/api/trackers?sessionId=sess" });
    expect(res.statusCode).toBe(200);
    return (res.json() as { trackers: TrackerInfo[] }).trackers;
  };

  const fileFeedback = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/sessions/sess/issue/create", payload });

  /** The body of the only POST that reached GitHub. */
  const filedBody = (): string => {
    const post = calls.find((c) => c.method === "POST");
    expect(post, "no issue was filed").toBeDefined();
    return JSON.parse(post!.body!).body as string;
  };

  // -- Declaring the plugin is what grants the channel (req 25) --------------

  it("makes a declared plugin repository addressable by its declared name", async () => {
    writeConfig(DECLARE_TOOLS);
    const dests = await destinations();
    const tools = dests.find((d) => d.name === "tools");
    expect(tools).toMatchObject({
      id: "github:acme/dev-tools",
      key: "acme/dev-tools",
      kind: "github",
      origin: "plugin",
      pluginNames: ["tools"],
    });
  });

  // A plugin repository is a dependency, not where the project's work lives.
  it("renders no Issues tab for it", async () => {
    writeConfig(DECLARE_TOOLS);
    expect((await tabs()).map((t) => t.id)).toEqual(["github"]);
  });

  // req 27 — a self-declared repository's issues ARE this session's own.
  it("registers nothing for `repo: self`", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: me\n");
    expect((await destinations()).map((d) => d.name)).toEqual([undefined]);
  });

  it("reflects an edited declaration on the next request, with no restart", async () => {
    expect((await destinations()).map((d) => d.name)).toEqual([undefined]);
    writeConfig(DECLARE_TOOLS);
    expect((await destinations()).map((d) => d.name)).toContain("tools");
  });

  // A dropped `repos:` entry takes its feedback destination with it, so the
  // reason has to reach the CLI that will fail to resolve the name.
  it("surfaces a dropped `plugins.repos` entry to the issue shim", async () => {
    writeConfig(
      `issues:\n  trackers:\n    - kind: github\n      repo: acme/planning\n      name: tools\n${DECLARE_TOOLS}`,
    );
    const res = await app.inject({ method: "GET", url: "/api/sessions/sess/issue/trackers" });
    const warnings = (res.json() as { warnings: string[] }).warnings;
    expect(warnings.join(" ")).toContain("plugins.repos[0]");
    expect(warnings.join(" ")).toContain("already a declared tracker name");
  });

  // -- The report, and the context it carries (reqs 15, 25) -----------------

  it("files on the plugin's repository, carrying the exact running commit", async () => {
    writeConfig(DECLARE_TOOLS);
    writeActiveGeneration("tools", COMMIT);
    await attachViewer();

    const res = await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "tools",
      title: "reqs CLI drops --root",
      body: "## Reproduction\n1. run `reqs --root docs`\n\n## Proposed fix\n```diff\n-a\n+b\n```",
    });
    expect(res.statusCode).toBe(200);

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/repos/acme/dev-tools/issues");
    const body = filedBody();
    // The author's report survives verbatim — footer, not preamble (req 25's
    // reproduction and proposed diff are the body).
    expect(body).toContain("## Reproduction");
    expect(body).toContain("```diff");
    expect(body).toContain("plugin repository `tools`");
    expect(body).toContain(`branch main @ \`${COMMIT}\``);
  });

  // The declaration name is not identity: `tools` can be re-pointed at another
  // repository, and every on-disk path keeps the name. Stamping a report with
  // whatever `plugins/tools/active` happens to resolve to would attach the
  // PREVIOUS repository's commit to a report filed on the new one — the exact
  // mismatch this footer exists to prevent (req 15).
  it("does not stamp a commit left by a repository the declaration no longer names", async () => {
    writeConfig(DECLARE_TOOLS);
    writeActiveGeneration("tools", COMMIT, "branch main", "acme/previous-tools");
    await attachViewer();

    const res = await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "tools",
      title: "Broken",
      body: "it broke",
    });
    expect(res.statusCode).toBe(200);
    const body = filedBody();
    expect(body).not.toContain(COMMIT);
    expect(body).toContain("no plugin generation is active");
  });

  it("files, and says the version is not active, before a generation exists", async () => {
    writeConfig(DECLARE_TOOLS);
    await attachViewer();
    const res = await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "tools",
      title: "Broken",
      body: "it broke",
    });
    expect(res.statusCode).toBe(200);
    expect(filedBody()).toContain("no plugin generation is active");
  });

  // req 7 — filing an issue is the WHOLE channel. Nothing about this path may
  // reach the plugin repository's git remote.
  it("touches nothing but the plugin repository's issues API", async () => {
    writeConfig(DECLARE_TOOLS);
    writeActiveGeneration("tools", COMMIT);
    await attachViewer();
    await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "tools",
      title: "t",
      body: "b",
    });
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining("https://api.github.com/repos/acme/dev-tools/issues"),
    ]);
    expect(calls.some((c) => /\/(pulls|git|contents)\b/.test(c.url))).toBe(false);
  });

  // The name chosen is the intent when a repository is declared BOTH ways: the
  // plugin name is feedback and carries the commit; the tracker name does not.
  it("stamps the context when the alias name is used, and not when the tracker name is", async () => {
    writeConfig(
      `issues:\n  trackers:\n    - kind: github\n      repo: acme/dev-tools\n      name: planning\n${DECLARE_TOOLS}`,
    );
    writeActiveGeneration("tools", COMMIT);
    await attachViewer();

    const viaPlugin = await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "tools",
      title: "reqs drops --root",
      body: "repro",
    });
    expect(viaPlugin.statusCode).toBe(200);
    expect(filedBody()).toContain(`branch main @ \`${COMMIT}\``);

    calls.length = 0;
    const viaTracker = await fileFeedback({
      tracker: "github:acme/dev-tools",
      trackerName: "planning",
      title: "Plain planning item",
      body: "no footer",
    });
    expect(viaTracker.statusCode).toBe(200);
    expect(filedBody()).toBe("no footer");
  });

  // -- Fail-closed, and no collateral damage to the trackers ----------------

  it("names plugin repositories separately when a create addresses nothing declared", async () => {
    writeConfig(DECLARE_TOOLS);
    await attachViewer();
    const res = await fileFeedback({ tracker: "github:acme/other", title: "t", body: "b" });
    expect(res.statusCode).toBe(404);
    const message = (res.json() as { error: string }).error;
    expect(message).toContain("plugin repositories");
    expect(message).toContain("tools");
    // Fail-closed means nothing was filed anywhere.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  // The reason the registry aliases rather than registering a second
  // destination: two named destinations with one backend identity make the
  // canonical form ambiguous and break the tracker that already worked.
  it("keeps a repository declared as BOTH a tracker and a plugin repo unambiguous", async () => {
    writeConfig(
      `issues:\n  trackers:\n    - kind: github\n      repo: acme/dev-tools\n      name: planning\n${DECLARE_TOOLS}`,
    );
    const dests = await destinations();
    expect(dests.filter((d) => d.id === "github:acme/dev-tools")).toHaveLength(1);
    const both = dests.find((d) => d.id === "github:acme/dev-tools")!;
    expect(both).toMatchObject({ name: "planning", pluginNames: ["tools"] });
    // It stays a tracker — tab and all.
    expect((await tabs()).map((t) => t.id)).toContain("github:acme/dev-tools");
  });
});
