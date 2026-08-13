/**
 * docs/262 — GET /api/plugin-repos: the snapshot behind the Plugins tab.
 *
 * Exercises the path a `plugins:` declaration takes end to end: shipit.yaml →
 * config parser (phase-1 validation) → snapshot projection → the route the tab
 * fetches. The config is read per request, so an edit must change the answer
 * on the very next call — that property is asserted, since the client's
 * files-changed refetch depends on it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { SecretStore } from "../secret-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import type { PluginReposSnapshot } from "../../shared/plugin-repos.js";

/** The two-repo fixture shape (plan §5): self + a tracked repo by owner/name. */
const DECLARE_FIXTURE = `
exports:
  plugins:
    probe:
      cli:
        probe: test-plugin/cli/probe.mjs
plugins:
  repos:
    - repo: self
      name: dev
    - repo: nikzlabs/shipit
      name: tools
      branch: main
  use:
    - plugin: probe
      from: dev
    - plugin: probe
      from: tools
      alias: remote-probe
`;

describe("Integration: GET /api/plugin-repos (docs/262)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let workspaceDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let credentialStore: CredentialStore;

  const writeConfig = (yaml: string) => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
  };

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-plugin-repos-"));
    workspaceDir = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    initGlobalGitConfig(tmpDir);

    sessionManager = new SessionManager(dbManager);
    credentialStore = new CredentialStore(tmpDir);
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      databaseManager: dbManager,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    sessionManager.track("sess", "Session", workspaceDir);
    sessionManager.setRemoteUrl("sess", "https://github.com/code-owner/app.git");
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const snapshot = async (query = "?sessionId=sess"): Promise<PluginReposSnapshot> => {
    const res = await app.inject({ method: "GET", url: `/api/plugin-repos${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as PluginReposSnapshot;
  };

  it("projects the two-fixture declaration into cards", async () => {
    writeConfig(DECLARE_FIXTURE);
    const snap = await snapshot();

    expect(snap.declared).toBe(true);
    expect(snap.consumerRepoUrl).toBe("https://github.com/code-owner/app.git");
    expect(snap.warnings).toEqual([]);
    expect(snap.repos).toHaveLength(2);

    const dev = snap.repos.find((r) => r.name === "dev")!;
    expect(dev).toMatchObject({ source: "self", status: "self", ref: null, commit: null });
    // Self resolves its selectors against the same file's manifest (its
    // phase 2 needs no fetch).
    expect(dev.uses).toEqual([{ plugin: "probe", alias: "probe", found: true, credentials: [] }]);

    const tools = snap.repos.find((r) => r.name === "tools")!;
    // Nothing has been activated in this test (activation is a lifecycle
    // trigger, never a GET side effect), so the tracked repo reads as
    // unavailable with no commit — req 13's "session runs without it".
    expect(tools).toMatchObject({ source: "nikzlabs/shipit", status: "unavailable", ref: "main", commit: null });
    expect(tools.uses).toEqual([{ plugin: "probe", alias: "remote-probe", found: null, credentials: [] }]);
  });

  it("no plugins block → not declared; the tab has nothing to gate on", async () => {
    writeConfig("agent:\n  install: npm install\n");
    const snap = await snapshot();
    expect(snap.declared).toBe(false);
    expect(snap.repos).toEqual([]);
    expect(snap.warnings).toEqual([]);
  });

  it("an invalid declaration keeps its warning surface (req 13)", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: not-a-slug\n      name: broken\n");
    const snap = await snapshot();
    expect(snap.declared).toBe(true);
    expect(snap.repos).toEqual([]);
    expect(snap.warnings).toContainEqual(expect.stringContaining("`owner/name` slug or `self`"));
  });

  it("a self selector missing from the manifest becomes a card issue", async () => {
    writeConfig("plugins:\n  repos:\n    - repo: self\n      name: dev\n  use:\n    - plugin: ghost\n      from: dev\n");
    const snap = await snapshot();
    const dev = snap.repos[0];
    expect(dev.uses).toEqual([{ plugin: "ghost", alias: "ghost", found: false, credentials: [] }]);
    expect(dev.issues).toContainEqual(expect.stringContaining("`ghost`"));
  });

  // req 26 — a settings value that cannot take effect is a card issue, and it
  // is computed by re-resolving the declaration against the live manifest, so
  // it shows before any activation round has run.
  it("a settings value the plugin does not declare becomes a card issue", async () => {
    writeConfig(
      "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hello\n"
        + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
        + "  use:\n    - plugin: probe\n      from: dev\n      alias: p\n"
        + "      overrides:\n        settings:\n          greting: hi\n",
    );
    const dev = (await snapshot()).repos[0];
    expect(dev.issues).toContainEqual(expect.stringContaining("`greting`"));
    expect(dev.issues[0]).toContain("`p`");
  });

  // `constructor`, `toString` and friends are valid declared names, and reading
  // an issues map keyed by repo name on a plain object returns an inherited
  // FUNCTION for a repository that has no issues at all — truthy, non-zero
  // `.length`, and fatal at the first spread (review finding).
  it("a repository named after an Object prototype member is an ordinary card", async () => {
    writeConfig(
      "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hello\n"
        + "plugins:\n  repos:\n    - repo: self\n      name: constructor\n"
        + "  use:\n    - plugin: probe\n      from: constructor\n      alias: p\n",
    );
    const snap = await snapshot();
    expect(snap.warnings).toEqual([]);
    expect(snap.repos[0]).toMatchObject({ name: "constructor", status: "self" });
    expect(snap.repos[0].issues).toEqual([]);
  });

  it("a valid settings value produces no issue", async () => {
    writeConfig(
      "exports:\n  plugins:\n    probe:\n      settings:\n        greeting:\n          default: hello\n"
        + "plugins:\n  repos:\n    - repo: self\n      name: dev\n"
        + "  use:\n    - plugin: probe\n      from: dev\n      alias: p\n"
        + "      overrides:\n        settings:\n          greeting: hi\n",
    );
    expect((await snapshot()).repos[0].issues).toEqual([]);
  });

  it("re-reads the file per request — an edit changes the very next answer", async () => {
    writeConfig("agent: {}\n");
    expect((await snapshot()).declared).toBe(false);
    writeConfig(DECLARE_FIXTURE);
    expect((await snapshot()).declared).toBe(true);
  });

  it("unknown session or no sessionId → empty snapshot, not an error", async () => {
    expect((await snapshot("")).declared).toBe(false);
    expect((await snapshot("?sessionId=nope")).declared).toBe(false);
  });

  // "Not yet knowable" must not be cached as "declares nothing" — the client
  // retries on `pending`, which is what keeps an evicted session's Plugins tab
  // from vanishing until the next shipit.yaml event.
  it("reports pending for an evicted session instead of an empty declaration", async () => {
    writeConfig(DECLARE_FIXTURE);
    sessionManager.setDiskTier("sess", "evicted");
    const snap = await snapshot();
    expect(snap.pending).toBe(true);
    expect(snap.declared).toBe(false);
    expect(snap.repos).toEqual([]);
  });

  it("reports pending when the workspace directory is gone (mid-restore)", async () => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    expect((await snapshot()).pending).toBe(true);
    // …and stops once the checkout is back.
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeConfig(DECLARE_FIXTURE);
    const snap = await snapshot();
    expect(snap.pending).toBe(false);
    expect(snap.declared).toBe(true);
  });

  it("a bare `plugins:` key declares intent (the tab must appear)", async () => {
    writeConfig("plugins:\n");
    const snap = await snapshot();
    expect(snap.declared).toBe(true);
    expect(snap.repos).toEqual([]);
  });

  it("an exports-only repo returns no declaration and no warnings", async () => {
    writeConfig("exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n");
    const snap = await snapshot();
    expect(snap.declared).toBe(false);
    expect(snap.warnings).toEqual([]);
  });

  // docs/262 req 23 — the tab is where a missing key becomes visible, and the
  // store it resolves against is the CONSUMING project's own.
  describe("credential needs", () => {
    const WITH_CREDENTIAL = `
exports:
  plugins:
    probe:
      credentials: [FAL_KEY]
plugins:
  repos:
    - repo: self
      name: dev
  use:
    - plugin: probe
      from: dev
`;

    it("reports an unset credential as an unsatisfied need on its own plugin", async () => {
      writeConfig(WITH_CREDENTIAL);
      const snap = await snapshot();
      expect(snap.repos[0].uses[0]).toMatchObject({
        alias: "probe",
        credentials: [{ name: "FAL_KEY", satisfied: false }],
      });
    });

    it("flips to satisfied once the value is in THIS project's store", async () => {
      writeConfig(WITH_CREDENTIAL);
      // Same database the app's own SecretStore reads.
      new SecretStore(dbManager).saveSecrets("https://github.com/code-owner/app.git", {
        FAL_KEY: "fixture-live",
      });
      const snap = await snapshot();
      expect(snap.repos[0].uses[0].credentials).toEqual([{ name: "FAL_KEY", satisfied: true }]);
    });

    // req 23's platform boundary, end to end: the app under test holds a real,
    // populated CredentialStore, and the plugin asks for exactly the names
    // ShipIt keeps there. Every one must still read as a gap.
    it("ShipIt's own platform credentials never satisfy a plugin, through the route", async () => {
      writeConfig(`
exports:
  plugins:
    probe:
      credentials: [GITHUB_TOKEN, LINEAR_API_KEY, ANTHROPIC_API_KEY]
plugins:
  repos:
    - repo: self
      name: dev
  use:
    - plugin: probe
      from: dev
`);
      // `credentialStore` is the very instance this app was built with.
      credentialStore.setGithubToken("fixture-the-users-github-identity");
      credentialStore.setLinearToken("fixture-the-users-tracker-token");
      credentialStore.setAgentEnv("ANTHROPIC_API_KEY", "fixture-the-users-agent-token");

      const snap = await snapshot();
      expect(snap.repos[0].uses[0].credentials).toEqual([
        { name: "GITHUB_TOKEN", satisfied: false },
        { name: "LINEAR_API_KEY", satisfied: false },
        { name: "ANTHROPIC_API_KEY", satisfied: false },
      ]);
      // The platform store really is populated — the gaps are the boundary.
      expect(credentialStore.getGithubToken()).toBeTruthy();
      expect(credentialStore.getLinearToken()).toBeTruthy();
      expect(credentialStore.getAllAgentEnv().ANTHROPIC_API_KEY).toBeTruthy();
    });

    it("a value stored against another repository does not satisfy it", async () => {
      // The store trap (plan §3): the plugin repository has its own store, and
      // a key saved there is a key saved where nothing reads it.
      writeConfig(WITH_CREDENTIAL);
      new SecretStore(dbManager).saveSecrets("https://github.com/nikzlabs/shipit.git", {
        FAL_KEY: "fixture-wrong-store",
      });
      const snap = await snapshot();
      expect(snap.repos[0].uses[0].credentials).toEqual([{ name: "FAL_KEY", satisfied: false }]);
    });
  });

  it("a malformed document degrades to a warning, not a 500", async () => {
    writeConfig("plugins: [unclosed\n  - broken yaml");
    const snap = await snapshot();
    expect(snap.repos).toEqual([]);
    expect(snap.warnings).toContainEqual(expect.stringContaining("could not be parsed"));
  });
});
