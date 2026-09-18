import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { SecretStore } from "./secret-store.js";
import { CredentialStore } from "./credential-store.js";
import { resolvePluginCredentials } from "../shared/plugin-credentials.js";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";
import { resolveLiveGenerations } from "./plugin-generations.js";
import {
  collectPluginCredentialDeclarations,
  liveManifestReader,
  loadSatisfiedPluginCredentialNames,
} from "./plugin-credentials.js";

const CONSUMER_URL = "https://github.com/nicolasalt/my-project.git";
const PLUGIN_REPO_URL = "https://github.com/nicolasalt/art-kit.git";

function makeSession(shipitYaml: string): { sessionDir: string; workspaceDir: string } {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-"));
  const workspaceDir = path.join(sessionDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), shipitYaml);
  return { sessionDir, workspaceDir };
}

function publishGeneration(
  sessionDir: string,
  repoName: string,
  manifestYaml: string,
  source = "nicolasalt/art-kit",
): void {
  const commit = "a".repeat(40);
  const commitDir = path.join(sessionDir, "state", "plugins", repoName, "generations", commit);
  fs.mkdirSync(commitDir, { recursive: true });
  fs.writeFileSync(path.join(commitDir, "shipit.yaml"), manifestYaml);
  fs.writeFileSync(
    path.join(commitDir, ".shipit-generation.json"),
    JSON.stringify({
      repoName,
      source,
      commit,
      ref: "branch main",
      activatedAt: new Date().toISOString(),
      exports: ["palette"],
      manifestWarnings: [],
    }),
  );
  fs.symlinkSync(commitDir, path.join(sessionDir, "state", "plugins", repoName, "active"));
}

describe("plugin credential resolution — the consuming project's store (req 23)", () => {
  let dbManager: DatabaseManager;
  let secretStore: SecretStore;
  const dirs: string[] = [];

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    secretStore = new SecretStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const track = (s: { sessionDir: string; workspaceDir: string }) => {
    dirs.push(s.sessionDir);
    return s;
  };

  it("reads the declared names out of the LIVE generation's manifest", () => {
    const session = track(
      makeSession(`plugins:\n  repos:\n    - repo: nicolasalt/art-kit\n      name: art-kit\n      branch: main\n  use:\n    - plugin: palette\n      from: art-kit\n      alias: artk\n`),
    );
    publishGeneration(
      session.sessionDir,
      "art-kit",
      `exports:\n  plugins:\n    palette:\n      credentials: [FAL_KEY]\n`,
    );

    expect(collectPluginCredentialDeclarations(session.workspaceDir)).toEqual([
      { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] },
    ]);
  });

  it("reports nothing when the live generation came from a repository the declaration no longer names", () => {
    const session = track(
      makeSession(`plugins:\n  repos:\n    - repo: nicolasalt/art-kit\n      name: art-kit\n      branch: main\n  use:\n    - plugin: palette\n      from: art-kit\n      alias: artk\n`),
    );
    publishGeneration(
      session.sessionDir,
      "art-kit",
      `exports:\n  plugins:\n    palette:\n      credentials: [FAL_KEY]\n`,
      "nicolasalt/previous-art-kit",
    );

    expect(collectPluginCredentialDeclarations(session.workspaceDir)).toEqual([]);
  });

  it("a self-declared repository reads its own working tree (req 27)", () => {
    const session = track(
      makeSession(
        `plugins:\n  repos:\n    - repo: self\n      name: dev\n  use:\n    - plugin: probe\n      from: dev\nexports:\n  plugins:\n    probe:\n      credentials: [PROBE_KEY]\n`,
      ),
    );
    expect(collectPluginCredentialDeclarations(session.workspaceDir)).toEqual([
      { repo: "dev", plugin: "probe", alias: "probe", credentials: [{ name: "PROBE_KEY", optional: false }] },
    ]);
  });

  it("resolves against the consuming project's store — NOT the plugin repository's", () => {
    secretStore.saveSecrets(PLUGIN_REPO_URL, { FAL_KEY: "fixture-from-the-wrong-store" });

    const declarations = [
      { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] },
    ];
    const [group] = resolvePluginCredentials(
      declarations,
      loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL),
    );
    expect(group.credentials).toEqual([{ name: "FAL_KEY", satisfied: false, optional: false }]);

    secretStore.saveSecrets(CONSUMER_URL, { FAL_KEY: "fixture-live" });
    const [after] = resolvePluginCredentials(
      declarations,
      loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL),
    );
    expect(after.credentials).toEqual([{ name: "FAL_KEY", satisfied: true, optional: false }]);
  });

  it("an empty stored value is not a value", () => {
    secretStore.saveSecrets(CONSUMER_URL, { FAL_KEY: "" });
    expect(loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL).has("FAL_KEY")).toBe(false);
  });

  it("a session with no remote resolves nothing — it has no store to read", () => {
    expect(loadSatisfiedPluginCredentialNames(secretStore, null).size).toBe(0);
  });

  it("a store that cannot be read reports gaps, never blanket satisfaction", () => {
    const exploding = {
      loadSecrets: () => {
        throw new Error("database is locked");
      },
    };
    expect(loadSatisfiedPluginCredentialNames(exploding, CONSUMER_URL).size).toBe(0);
  });
});

describe("platform credentials are unreachable from a plugin's store (req 23)", () => {
  let dbManager: DatabaseManager;
  let secretStore: SecretStore;
  let credentialsDir: string;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    secretStore = new SecretStore(dbManager);
    credentialsDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-platform-"));
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(credentialsDir, { recursive: true, force: true });
  });

  it("a plugin declaring ShipIt's own credential names still reports every one as a gap", () => {
    const credentialStore = new CredentialStore(credentialsDir);
    credentialStore.setGithubToken("fixture-the-users-github-identity");
    credentialStore.setLinearToken("fixture-the-users-tracker-token");
    credentialStore.setAgentEnv("ANTHROPIC_API_KEY", "fixture-the-users-agent-token");
    credentialStore.setMcpOAuthTokens("notion", {
      accessToken: "mcp-oauth-access-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
    });

    const declarations = [
      {
        repo: "art-kit",
        plugin: "palette",
        alias: "artk",
        credentials: [
          "GITHUB_TOKEN",
          "SHIPIT_GITHUB_TOKEN",
          "LINEAR_API_KEY",
          "ANTHROPIC_API_KEY",
          "MCP_PLATFORM_NOTION",
        ].map((name) => ({ name, optional: false })),
      },
    ];

    const [group] = resolvePluginCredentials(
      declarations,
      loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL),
    );
    expect(group.credentials).toEqual([
      { name: "GITHUB_TOKEN", satisfied: false, optional: false },
      { name: "SHIPIT_GITHUB_TOKEN", satisfied: false, optional: false },
      { name: "LINEAR_API_KEY", satisfied: false, optional: false },
      { name: "ANTHROPIC_API_KEY", satisfied: false, optional: false },
      { name: "MCP_PLATFORM_NOTION", satisfied: false, optional: false },
    ]);

    expect(credentialStore.getGithubToken()).toBeTruthy();
    expect(credentialStore.getLinearToken()).toBeTruthy();
    expect(credentialStore.getAllAgentEnv().ANTHROPIC_API_KEY).toBeTruthy();
    expect(credentialStore.getAllMcpOAuthTokens().notion?.accessToken).toBeTruthy();
  });

  it("a value the USER placed in the project store under a platform-ish name is theirs, and resolves", () => {
    secretStore.saveSecrets(CONSUMER_URL, { GITHUB_TOKEN: "fixture-the-users-own-choice" });
    const [group] = resolvePluginCredentials(
      [{ repo: "r", plugin: "p", alias: "p", credentials: [{ name: "GITHUB_TOKEN", optional: false }] }],
      loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL),
    );
    expect(group.credentials).toEqual([{ name: "GITHUB_TOKEN", satisfied: true, optional: false }]);
  });
});

describe("liveManifestReader", () => {
  it("returns null for a tracked repo with no active generation", () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-live-"));
    const workspaceDir = path.join(sessionDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    try {
      const repos: DeclaredPluginRepo[] = [
        { name: "art-kit", source: { kind: "github", owner: "acme", repo: "art-kit" } },
      ];
      const read = liveManifestReader(repos, [], resolveLiveGenerations(path.join(sessionDir, "state"), repos));
      expect(read("art-kit")).toBeNull();
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("returns the self manifest without touching the state dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-flat-"));
    try {
      const selfExports = [
        { name: "probe", cli: {}, installInputs: [], depDirs: [], credentials: [{ name: "PROBE_KEY", optional: false }], hosts: [], settings: {} },
      ];
      const repos: DeclaredPluginRepo[] = [{ name: "dev", source: { kind: "self" } }];
      const read = liveManifestReader(repos, selfExports, () => null);
      expect(read("dev")).toEqual(selfExports);
      expect(read("other")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
