/**
 * The Plugins card never claims a state the enforcement side would contradict
 * (docs/262 req 24 — "enforcement and the card must not disagree").
 *
 * Three shipped defects are instances of that ONE property, and the reason they
 * belong in one file is that each was found by a different route and NONE was
 * found by the tests. They differ only in what the reporting side was optimistic
 * ABOUT:
 *
 *  - **planning#377** — a compose FILE: the card said "could not read" for a
 *    file ShipIt had read and deliberately refused, so the user hunted a syntax
 *    error that was never there.
 *  - **planning#380** — a SESSION: a durably-added host read as allowed in a
 *    Network-off sandbox, whose own resolver had never heard of it.
 *  - **planning#383** — a DEPLOYMENT: two grant buttons on an install where no
 *    grant can take effect, either of which wrote a durable entry that changed
 *    nothing.
 *
 * Each case below asserts the USER-VISIBLE claim against the enforcement truth
 * that contradicted it, and each is written so it would have failed before its
 * fix. The narrower mechanics live next to their own modules
 * (`egress-host-reach.test.ts`, `services/plugin-services.test.ts`); what this
 * file guards is the class, so a fourth surface has an obvious place to be
 * tested rather than a fourth special case to be written.
 */

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

/**
 * The card as the browser renders it, for one declared host — the last hop, so
 * a verdict that is right in the predicate and dropped on the way out still
 * fails here.
 */
function cardHost(reachOf: (host: string) => ReturnType<ReturnType<typeof egressHostReach>>, host: string) {
  const plugins = parsePluginRepos(
    { repos: [{ repo: "self", name: "dev" }], use: [{ plugin: "probe", from: "dev" }] },
    [],
    [],
  );
  const groups = resolvePluginHosts(
    [{ repo: "dev", plugin: "probe", alias: "probe", hosts: [host] }],
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
    // The enforcement truth: `SESSION_EGRESS_DNS=0` leaves the fixed Tier A IP
    // floor as the whole reach of a contained session — no resolver to pin the
    // name's IPs, no proxy to permit its SNI.
    const floorOnly = () =>
      egressHostReach({ contained: true, dnsControlDeployed: false, config: configFor(), sessionId: SESSION });

    expect(cardHost(floorOnly(), "fal.run").reach).toBe("blocked-by-deployment");

    // Both buttons wrote here. Neither changes the answer, which is the whole
    // complaint: the surface built to answer this question could not say so.
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    store.addHost(SESSION, "fal.run");
    expect(cardHost(floorOnly(), "fal.run").reach).toBe("blocked-by-deployment");

    // And the control: the same store, the same session, a deployment that runs
    // the resolver. The gap really was the deployment's.
    const withResolver = egressHostReach({
      contained: true,
      dnsControlDeployed: true,
      config: configFor(),
      sessionId: SESSION,
    });
    expect(cardHost(withResolver, "fal.run").reach).toBe("allowed");
  });
});

/**
 * The same claim as the case above, but through the REAL route the tab fetches:
 * a `shipit.yaml` on disk, the config parser, the snapshot projection, and the
 * verdict the browser would receive. The predicate-level case cannot see a
 * verdict dropped on the way out, and a card that renders a state nothing
 * produces end to end is what "found by a different route, never by the tests"
 * means (review finding).
 */
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
      // The deployment fact the card had no way to see (planning#383).
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
    // `fal.run` IS in this session's resolved extras — the state that used to
    // read "not yet allowed, here are two buttons" and now cannot.
    expect(await hosts()).toEqual([
      { host: "fal.run", reach: "blocked-by-deployment" },
      // And the installer's own resolve list is still reachable, so the fix
      // does not name a gap where there is none.
      { host: "registry.npmjs.org", reach: "allowed" },
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
    // Wiring the durable source is what made this case real: with it null the
    // fixture could not see the store re-entering through the allow-once layer.
    setEgressDurableSource((sessionId) => store.effectiveHosts(sessionId));
  });
  afterEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db.close();
  });

  it("calls a durably-added host a gap in a Network-off sandbox, and offers no grant", () => {
    store.addHost(EGRESS_GLOBAL_SCOPE, "fal.run");
    // The enforcement truth: `sandboxLifelineEgressConfig` ignores the allowlist
    // store outright, so this session's resolver was launched without the host.
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
    // The lifeline is untouched: this narrows nothing it should not.
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
    // A STOCK compose file: nothing is wrong with it, it simply does not declare
    // the numeric non-root `user:` a contained session requires (docs/263).
    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:22-alpine\n",
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
    // The sentence the user reads on the card. The defect was the opposite one.
    expect(reason).toContain("refuses this project's own compose file");
    expect(reason).not.toContain("could not read");
    // And it carries the one line that fixes it, which "unreadable" never could.
    expect(reason).toContain("`user:`");
  });

  it("does not refuse the same file where the rule does not apply", () => {
    // The file never changed — which is exactly why calling it unreadable
    // misled. An Open session parses it cleanly and the candidate passes.
    expect(gate(false)).toEqual({ ok: true });
  });
});
