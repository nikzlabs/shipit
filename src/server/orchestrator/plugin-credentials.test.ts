/**
 * docs/262 req 23 — the credential store boundary, proved rather than asserted.
 *
 * Two properties this file exists for:
 *   1. A plugin credential resolves from the CONSUMING project's own secret
 *      store — never from the plugin repository's store, the trap `plan.md` §3
 *      records for the "Add key…" affordance, here on the read side.
 *   2. ShipIt's own platform credentials — the user's GitHub identity, tracker
 *      tokens, agent/provider tokens — can NEVER satisfy a plugin's declared
 *      name, whatever the plugin calls it. The test populates a real
 *      `CredentialStore` with all three and shows the plugin still reports a
 *      gap.
 */

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

/** A session dir laid out the way `createSessionDirFactory` guarantees. */
function makeSession(shipitYaml: string): { sessionDir: string; workspaceDir: string } {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-"));
  const workspaceDir = path.join(sessionDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), shipitYaml);
  return { sessionDir, workspaceDir };
}

/**
 * A published generation for `repoName`, carrying its own manifest AND the
 * record activation writes beside it. The record is not decoration: it names the
 * repository the generation was built FROM, and every reader through the
 * `active` symlink checks it, because the declaration name it is filed under is
 * re-pointable.
 */
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

  // The name is filed on disk; the repository it points at is not. Answering
  // from a generation another repository left would tell this project to supply
  // THAT repository's credential names — a gap it can never close, against a
  // plugin it no longer uses.
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
    // The store trap (plan §3): the key sits in the PLUGIN repository's store,
    // which is a different store entirely. The consuming project has no value,
    // so the plugin's need is an unsatisfied, named gap.
    secretStore.saveSecrets(PLUGIN_REPO_URL, { FAL_KEY: "fixture-from-the-wrong-store" });

    const declarations = [
      { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] },
    ];
    const [group] = resolvePluginCredentials(
      declarations,
      loadSatisfiedPluginCredentialNames(secretStore, CONSUMER_URL),
    );
    expect(group.credentials).toEqual([{ name: "FAL_KEY", satisfied: false, optional: false }]);

    // …and it flips the moment the value lands in the CONSUMING project's store.
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
    // Everything ShipIt holds on the user's behalf, all set, all real.
    const credentialStore = new CredentialStore(credentialsDir);
    credentialStore.setGithubToken("fixture-the-users-github-identity");
    credentialStore.setLinearToken("fixture-the-users-tracker-token");
    credentialStore.setAgentEnv("ANTHROPIC_API_KEY", "fixture-the-users-agent-token");
    credentialStore.setMcpOAuthTokens("notion", {
      accessToken: "mcp-oauth-access-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
    });

    // A plugin that asks for exactly those names — by the names ShipIt itself
    // uses. The consuming project's store is empty, which is the only store a
    // plugin's credentials can resolve from.
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

    // The platform store is genuinely populated — the gaps above are the
    // boundary holding, not an empty fixture.
    expect(credentialStore.getGithubToken()).toBeTruthy();
    expect(credentialStore.getLinearToken()).toBeTruthy();
    expect(credentialStore.getAllAgentEnv().ANTHROPIC_API_KEY).toBeTruthy();
    expect(credentialStore.getAllMcpOAuthTokens().notion?.accessToken).toBeTruthy();
  });

  it("a value the USER placed in the project store under a platform-ish name is theirs, and resolves", () => {
    // The boundary is about ShipIt's own credentials, not about names. A key
    // the user typed into Settings → Secrets is a user-placed plugin value
    // whatever it is called (req 23: "holds only values the user placed there").
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
    // A workspace that is NOT `<sessionDir>/workspace` has no derivable state
    // dir; a self repo must still read (req 27 — its manifest is this file).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-creds-flat-"));
    try {
      const selfExports = [
        { name: "probe", cli: {}, installInputs: [], depDirs: [], credentials: [{ name: "PROBE_KEY", optional: false }], hosts: [], settings: {} },
      ];
      const repos: DeclaredPluginRepo[] = [{ name: "dev", source: { kind: "self" } }];
      // A self repo reads without any generation being resolvable at all.
      const read = liveManifestReader(repos, selfExports, () => null);
      expect(read("dev")).toEqual(selfExports);
      expect(read("other")).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
