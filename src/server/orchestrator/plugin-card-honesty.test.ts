import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import { setEgressDurableSource, _resetEgressPolicies } from "./egress-policy.js";
import { composeEgressExtraHosts, sandboxLifelineBase, type ResolvedEgressConfig } from "./egress-allowlist.js";
import { egressHostReach } from "./egress-host-reach.js";
import { resolvePluginHosts } from "../shared/plugin-hosts.js";
import { buildPluginReposSnapshot, parsePluginRepos } from "../shared/plugin-repos.js";
import { createStagedGenerationGate } from "./services/plugin-preflight.js";
import Fastify, { type FastifyInstance } from "fastify";
import { registerPluginRepoRoutes } from "./api-routes-plugin-repos.js";
import type { ApiDeps } from "./api-routes.js";
import type { PluginReposSnapshot } from "../shared/plugin-repos.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";
import type { CredentialStore } from "./credential-store.js";

const SESSION = "sess-a";

function cardHost(reachOf: (host: string) => ReturnType<ReturnType<typeof egressHostReach>>, host: string) {
  const plugins = parsePluginRepos(
    { repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] },
    [],
    [],
  );
  const groups = resolvePluginHosts(
    [{ repo: "dev", plugin: "probe", alias: "probe", hosts: [{ name: host, optional: false }] }],
    reachOf,
  );
  const card = buildPluginReposSnapshot(plugins, [], null, [], {}, [], groups).repos[0];
  return card.uses[0].hosts[0];
}

describe("the card is not optimistic about a DEPLOYMENT (planning#383)", () => {
  let db: DatabaseManager;
  let store: EgressAllowlistStore;

  const stubCredentialStore = {
    getAllMcpServers: () => ({}),
    getAllMcpOAuthTokens: () => ({}),
  } as unknown as CredentialStore;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    _resetEgressPolicies();
    setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
  });
  afterEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db.close();
  });

  const configFor = (): ResolvedEgressConfig => ({
    contained: true,
    extraHosts: composeEgressExtraHosts({
      env: {},
      credentialStore: stubCredentialStore,
      durableHosts: store.effectiveHosts(SESSION),
    }),
    base: store.effectiveBase(),
  });

  it("offers no grant where no grant can work, before OR after the user tries one", () => {
    const floorOnly = () =>
      egressHostReach({ contained: true, dnsControlDeployed: false, config: configFor(), sessionId: SESSION });

    expect(cardHost(floorOnly(), "fal.run").reach).toBe("blocked-by-deployment");

    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost(SESSION, "fal.run");
    expect(cardHost(floorOnly(), "fal.run").reach).toBe("blocked-by-deployment");

    const withResolver = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: configFor(),
      sessionId: SESSION,
    });
    expect(cardHost(withResolver, "fal.run").reach).toBe("allowed");
  });
});

describe("and the route the tab fetches says the same (planning#383)", () => {
  let app: FastifyInstance;
  let workspaceDir: string;
  let tmpDir: string;
  let contained: boolean;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-card-route-"));
    workspaceDir = path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
    fs.mkdirSync(path.join(tmpDir, SESSION_STATE_SUBDIR), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "exports:\n  plugins:\n    probe:\n      hosts: [fal.run, registry.npmjs.org]\nplugins:\n  repos:\n    - repo: self\n      name: dev\n  use:\n    - plugin: probe\n      from: dev\n",
    );
    contained = true;
    app = Fastify();
    await registerPluginRepoRoutes(app, {
      sessionManager: {
        get: (id: string) => (id === "sess" ? { id, workspaceDir, remoteUrl: null } : undefined),
      },
      egressDnsControlDeployed: false,
      containerManager: {
        isEgressContained: () => contained,
        resolveEgress: () => ({ contained, extraHosts: ["fal.run"] }),
      },
    } as unknown as ApiDeps);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const hosts = async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugin-repos?sessionId=sess" });
    expect(res.statusCode).toBe(200);
    return (res.json() as PluginReposSnapshot).repos[0].uses[0].hosts;
  };

  it("hands the browser a verdict no button may sit on, even for an allowlisted host", async () => {
    expect(await hosts()).toEqual([
      { host: "fal.run", reach: "blocked-by-deployment", optional: false },
      { host: "registry.npmjs.org", reach: "allowed", optional: false },
    ]);
  });

  it("says nothing of the sort on an Open session, which is denied nothing", async () => {
    contained = false;
    expect((await hosts()).every((h) => h.reach === "allowed")).toBe(true);
  });
});

describe("the card is not optimistic about a SESSION (planning#380)", () => {
  let db: DatabaseManager;
  let store: EgressAllowlistStore;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    _resetEgressPolicies();
    // Include durable hosts in the allow-once lookup, as production does.
    setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
  });
  afterEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db.close();
  });

  it("calls a durably-added host a gap in a Network-off sandbox, and offers no grant", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    const sandbox = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: {
        contained: true,
        extraHosts: [],
        base: sandboxLifelineBase({ git: false }),
        userHostsExcluded: true,
      },
      sessionId: SESSION,
    });
    expect(cardHost(sandbox, "fal.run").reach).toBe("blocked-by-session");
    expect(cardHost(sandbox, "api.anthropic.com").reach).toBe("allowed");
  });
});

describe("the card is not optimistic about a COMPOSE FILE (planning#377)", () => {
  let sessionDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-card-honesty-"));
    workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
    fs.mkdirSync(path.join(sessionDir, SESSION_STATE_SUBDIR), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      "compose: docker-compose.yml\nplugins:\n  repos:\n    - repo: acme/tools\n      name: tools\n      branch: main\n  use:\n    - plugin: probe\n      from: tools\n",
    );
    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      'services:\n  web:\n    image: node:22-alpine\n    user: "0"\n',
    );
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  const gate = (containEgress: boolean) =>
    createStagedGenerationGate({ workspaceDir, containEgress: () => containEgress })({
      repoName: "tools",
      source: "acme/tools",
      commit: "a".repeat(40),
      stagingDir: path.join(sessionDir, SESSION_STATE_SUBDIR, "staging"),
    });

  it("says it REFUSED the file it read, never that it could not read it", () => {
    const verdict = gate(true);
    expect(verdict.ok).toBe(false);
    const reason = verdict.ok ? "" : verdict.reason;
    expect(reason).toContain("refuses this project's own compose file");
    expect(reason).not.toContain("could not read");
    expect(reason).toContain("`user:`");
  });

  it("does not refuse the same file where the rule does not apply", () => {
    expect(gate(false)).toEqual({ ok: true });
  });
});
