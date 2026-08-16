/**
 * docs/262 reqs 3, 5, 13, 16, 18, 20 — the plugin SERVICE path, exercised
 * through the code a session actually runs (plan §5).
 *
 * The declaration is a real `shipit.yaml`, the fragment is a real file, and the
 * chain under test is the production one:
 *
 *   shipit.yaml → `resolveSessionPluginServices` (what `bootstrap-managers.ts`
 *   wires as `resolvePluginServices`) → `ServiceManager` → the generated compose
 *   override, and → `ContainerSessionRunner.setServiceManager` → the WS messages
 *   a browser receives.
 *
 * Two things are injected, and the level is deliberate. **Docker and the compose
 * CLI** are faked, because there is neither in the test environment — so nothing
 * here proves a container starts; that is the "one real-instance end-to-end"
 * item on the checklist, and it is not this. **The glue between the resolver and
 * the manager** — that `setupServiceManager` calls the resolver at all, under
 * the docs/178 trust gate — is `service-manager-setup.test.ts`'s subject and is
 * not re-proved here; this file starts where its fake manager ends, with a real
 * one.
 *
 * A `repo: self` declaration (req 27) is the fixture shape wherever a generation
 * is not the point: its "checkout" is the session's own workspace, so the whole
 * path runs with no fetch and no overlay volume, and the surface it exercises is
 * the same one a consumer's tracked import takes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { resolveSessionPluginServices } from "../services/plugin-services.js";
import { clearActivationState } from "../services/plugin-activation.js";
import { ServiceManager, type ComposeQuery, type ComposeRunner } from "../service-manager.js";
import {
  COMPOSE_OVERRIDE_FILE,
  SESSION_STATE_SUBDIR,
  SESSION_WORKSPACE_SUBDIR,
} from "../session-state-dir.js";
import { GitManager } from "../../shared/git.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import type { PluginReposSnapshot } from "../../shared/plugin-repos.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";

const SESSION_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

let stateRoot: string;
let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-svc-path-"));
  sessionDir = path.join(stateRoot, "sessions", SESSION_ID);
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // What a round could not recompute is remembered per session, in a map that
  // outlives one test (it is process-wide by design — a session's entries go
  // when the session is disposed). Each test here IS a fresh session.
  clearActivationState(SESSION_ID);
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Two services, so "a repository's services are all-or-nothing" is observable. */
const FRAGMENT = `
services:
  probe:
    image: node:22-alpine
    command: node /app/service/server.mjs
    environment:
      PROBE_PORT: "4820"
    volumes:
      - .:/app:ro
    ports:
      - "4820:4820"
    x-shipit-preview: auto
  probe-worker:
    image: node:22-alpine
    command: node /app/service/worker.mjs
    depends_on:
      - probe
`;

const PROJECT_COMPOSE = "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n";

function declaration(uses: string): string {
  return `
compose: docker-compose.yml
exports:
  plugins:
    probe:
      compose: tools/probe/docker-compose.yml
plugins:
  repos:
    - repo: self
      name: mine
  use:
${uses}
`;
}

const PLAIN_USE = "    - plugin: probe\n      from: mine\n";

function writeFixture(opts: { uses?: string; fragment?: string; projectCompose?: string } = {}): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), declaration(opts.uses ?? PLAIN_USE));
  fs.writeFileSync(
    path.join(workspaceDir, "docker-compose.yml"),
    opts.projectCompose ?? PROJECT_COMPOSE,
  );
  fs.mkdirSync(path.join(workspaceDir, "tools", "probe"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "tools", "probe", "docker-compose.yml"),
    opts.fragment ?? FRAGMENT,
  );
}

// ---------------------------------------------------------------------------
// Harness — a real ServiceManager over a fake compose CLI
// ---------------------------------------------------------------------------

interface Stack {
  mgr: ServiceManager;
  /** Every compose command the manager issued, in order. */
  commands: string[][];
}

function makeStack(): Stack {
  const commands: string[][] = [];
  const mgr = new ServiceManager({
    sessionId: SESSION_ID,
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: (async (args: string[]) => { commands.push(args); }) as ComposeRunner,
    composeQuery: (async () => "") as ComposeQuery,
    pollIntervalMs: 0,
  });
  return { mgr, commands };
}

/** Resolve the session's plugin services and bring the stack up over them. */
async function startStack(stack: Stack): Promise<void> {
  const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
    containEgress: false,
  });
  stack.mgr.setPluginServices(services);
  await stack.mgr.start();
}

function readOverride(): Record<string, Record<string, unknown>> {
  return (parseYaml(fs.readFileSync(path.join(stateDir, COMPOSE_OVERRIDE_FILE), "utf-8")) as {
    services: Record<string, Record<string, unknown>>;
  }).services;
}

/** The service names a `compose up` was asked to start (flags dropped). */
function startedNames(commands: string[][]): string[] {
  return commands
    .filter((args) => args.includes("up"))
    .flatMap((args) => args.slice(args.indexOf("up") + 1).filter((a) => !a.startsWith("-")));
}

// ---------------------------------------------------------------------------

describe("plugin services in a session's stack (docs/262)", () => {
  it("merges a plugin's fragment into the session's own stack (reqs 3, 5)", async () => {
    writeFixture();
    const stack = makeStack();

    await startStack(stack);

    // One stack, one name domain: the plugin's services sit beside the
    // project's and are addressed the same way.
    expect(stack.mgr.getServices().map((s) => s.name).sort())
      .toEqual(["probe", "probe-worker", "web"]);
    const override = readOverride();

    // The fragment's own lines survive verbatim…
    expect(override.probe).toMatchObject({
      image: "node:22-alpine",
      command: "node /app/service/server.mjs",
    });
    // …its `ports:` does not: ShipIt publishes no host ports and reaches
    // containers over the session network.
    expect(override.probe.ports).toBeUndefined();
    // …and ShipIt's half of the in-session contract is added (plan §2), which
    // the fragment deliberately never declares.
    expect(override.probe.environment).toMatchObject({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
    });
    const targets = (override.probe.volumes as { target: string }[]).map((m) => m.target).sort();
    expect(targets).toEqual(["/app", "/plugin", "/plugin-state", "/project"]);
    // The project's own service is untouched by any of it.
    expect(override.web.environment).toBeUndefined();
    await stack.mgr.stop();
  });

  it("starts an auto plugin service and holds a manual one (req 16)", async () => {
    writeFixture();
    const stack = makeStack();

    await startStack(stack);

    // `x-shipit-preview: auto` on the fragment's `probe`; `probe-worker`
    // declares no port and no preview, so it is manual.
    const started = startedNames(stack.commands);
    expect(started).toContain("probe");
    expect(started).not.toContain("probe-worker");
    expect(stack.mgr.getService("probe-worker")?.preview).toBe("manual");
    expect(stack.mgr.getService("probe-worker")?.status).toBe("stopped");
    await stack.mgr.stop();
  });

  it("renames a plugin service and starts one the plugin left manual (reqs 16, 20)", async () => {
    writeFixture({
      uses:
        "    - plugin: probe\n      from: mine\n      overrides:\n        services:\n"
        + "          probe:\n            as: reqs-probe\n"
        + "          probe-worker:\n            autostart: true\n",
    });
    const stack = makeStack();

    await startStack(stack);

    // The rename is what the session addresses it by, everywhere.
    expect(stack.mgr.getServices().map((s) => s.name).sort())
      .toEqual(["probe-worker", "reqs-probe", "web"]);
    expect(readOverride()["reqs-probe"]).toBeDefined();
    // `probe-worker` is manual in the fragment (no port, no `x-shipit-preview`)
    // and the consuming project asked for it automatically — so ShipIt names it.
    expect(startedNames(stack.commands)).toContain("probe-worker");
    // The rename follows the plugin's own `depends_on` — a plugin's internal
    // ordering must not break because a consumer renamed a service.
    expect(readOverride()["probe-worker"].depends_on).toEqual(["reqs-probe"]);
    // …and the plugin's own name for it is kept, so the card and the collision
    // message can name the override that produced it.
    expect(stack.mgr.getService("reqs-probe")?.origin).toMatchObject({ sourceName: "probe" });
    await stack.mgr.stop();
  });

  it("keeps an automatic plugin service manual when the project says so (req 16)", async () => {
    writeFixture({
      uses:
        "    - plugin: probe\n      from: mine\n      overrides:\n        services:\n"
        + "          probe:\n            autostart: false\n",
    });
    const stack = makeStack();

    await startStack(stack);

    expect(stack.mgr.getService("probe")?.preview).toBe("manual");
    // Neither plugin service is named to `compose up`, and — the reason this
    // case is written with nothing auto depending on `probe` — nothing brings it
    // up behind ShipIt's back either: `compose up <name>` starts the named
    // service's DEPENDENCIES unless `--no-deps` is passed, and ShipIt passes
    // none (`compose-cli.ts`). So an override that holds a service the plugin
    // marked automatic is only honoured while nothing automatic depends on it —
    // a real property of Compose, not of this test (review finding).
    const started = startedNames(stack.commands);
    expect(started).not.toContain("probe");
    expect(started).not.toContain("probe-worker");
    expect(started).toContain("web");
    await stack.mgr.stop();
  });

  it("carries the plugin origin on the service messages the runner broadcasts (req 3)", async () => {
    // The runner's emitted messages, not a browser: this asserts what
    // `setServiceManager` puts on the wire, and stops there. Nothing about WS
    // transport or the client's rendering of the badge is proved here.
    writeFixture();
    const stack = makeStack();
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir,
      defaultAgentId: "claude",
      // A placeholder worker URL defers `whenWorkerReady()`; nothing here talks
      // to a worker. Same shape as `service-manager-adoption.test.ts`.
      workerUrl: "http://0.0.0.0:0",
    });
    const emitted: WsServerMessage[] = [];
    runner.on("message", (msg: WsServerMessage) => emitted.push(msg));
    runner.setServiceManager(stack.mgr);

    await startStack(stack);

    const list = emitted.find((m) => m.type === "service_list");
    expect(list).toBeDefined();
    const listed = (list as { services: { name: string; origin?: unknown }[] }).services;
    expect(listed.find((s) => s.name === "probe")?.origin)
      .toEqual({ kind: "plugin", repo: "mine", alias: "probe", plugin: "probe" });
    // A project service has no origin at all — the field is what marks a
    // service as a plugin's, so an empty object would be a different claim.
    expect(listed.find((s) => s.name === "web")).not.toHaveProperty("origin");

    // …and the per-service channel carries it too. `service_status` is what a
    // running browser updates from; a `service_list` that carried the origin
    // while status updates dropped it would lose the badge on the first change.
    const statuses = emitted.filter((m) => m.type === "service_status") as {
      name: string; origin?: unknown; port?: number;
    }[];
    expect(statuses.find((s) => s.name === "probe")?.origin)
      .toEqual({ kind: "plugin", repo: "mine", alias: "probe", plugin: "probe" });
    // The port on the wire is the PUBLISHED one (req 18) — the routing key the
    // preview origin is built from, not the container's own port.
    expect(statuses.find((s) => s.name === "probe")?.port)
      .toBe(stack.mgr.getService("probe")?.publishedPort);

    runner.setServiceManager(null);
    await stack.mgr.stop();
  });

  it("withholds a whole repository's services when one name collides (req 20)", async () => {
    // The project's own `probe` wins: it is the thing the consumer did not
    // import and cannot be asked to rename.
    writeFixture({
      projectCompose: "services:\n  probe:\n    image: node:20\n    ports: ['3000:3000']\n",
    });
    const stack = makeStack();

    await startStack(stack);

    // Not just the colliding service — a compose stack is not a set of
    // independent services, so half a plugin is the partial state req 15
    // forbids.
    //
    // The check runs when services are RESOLVED. A plugin that is already
    // running has `/project` read-write, and a later `compose up` re-reads the
    // project file without re-checking collisions — planning#371.
    expect(stack.mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    expect(stack.mgr.getService("probe")?.origin).toBeUndefined();
    expect(readOverride()["probe-worker"]).toBeUndefined();
    // The project's own stack comes up regardless (reqs 13, 14).
    expect(startedNames(stack.commands)).toContain("probe");
    await stack.mgr.stop();
  });

  it("gives a plugin its own preview origin when it picks the project's port (#2325)", async () => {
    // 5173 is the Vite default, so a plugin and its consuming project picking it
    // is ordinary rather than exotic — and the consuming project cannot fix it:
    // the container port comes from the plugin's fragment, and `overrides` offer
    // `autostart` and `as`, neither of which is a port.
    writeFixture({
      projectCompose: "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n",
      fragment: FRAGMENT.replace(/4820/g, "5173"),
    });
    const stack = makeStack();

    await startStack(stack);

    const web = stack.mgr.getService("web")!;
    const probe = stack.mgr.getService("probe")!;
    // Both serve on 5173 inside their own containers, and neither number is the
    // other's origin.
    expect(web.port).toBe(5173);
    expect(probe.port).toBe(5173);
    expect(web.publishedPort).toBe(5173);
    expect(probe.publishedPort).not.toBe(5173);

    // The proxy asks by origin; each answer is that service's OWN container.
    web.containerIp = "172.20.0.2";
    probe.containerIp = "172.20.0.9";
    expect(stack.mgr.resolvePreviewTarget(5173))
      .toEqual({ containerIp: "172.20.0.2", port: 5173 });
    expect(stack.mgr.resolvePreviewTarget(probe.publishedPort!))
      .toEqual({ containerIp: "172.20.0.9", port: 5173 });
    await stack.mgr.stop();
  });

  it("keeps two same-port services apart on the wire the browser reads (#2325)", async () => {
    // The browser routes by the number on these messages: two services reporting
    // one port is a preview pane that cannot address either of them separately.
    writeFixture({
      projectCompose: "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n",
      fragment: FRAGMENT.replace(/4820/g, "5173"),
    });
    const stack = makeStack();
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    const emitted: WsServerMessage[] = [];
    runner.on("message", (msg: WsServerMessage) => emitted.push(msg));
    runner.setServiceManager(stack.mgr);

    await startStack(stack);

    const list = emitted.find((m) => m.type === "service_list") as
      { services: { name: string; port?: number }[] } | undefined;
    const ports = (list?.services ?? []).filter((s) => s.port !== undefined);
    expect(ports.length).toBe(2);
    expect(new Set(ports.map((s) => s.port)).size).toBe(2);
    expect(ports.find((s) => s.name === "web")?.port).toBe(5173);

    runner.setServiceManager(null);
    await stack.mgr.stop();
  });

  it("keeps the project's stack running when a plugin cannot be mounted (req 13)", async () => {
    // The Docker-dependent half: a workspace volume whose root does not contain
    // this session has no correct mount, and a bind of the orchestrator's path
    // would silently give the container an empty `/project` in production. Every
    // service of the repository is dropped instead.
    writeFixture();
    const stack = makeStack();
    const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
      workspaceVolume: "shipit-ws",
      stateRoot: path.join(stateRoot, "elsewhere"),
    });

    expect(services).toEqual([]);
    stack.mgr.setPluginServices(services);
    await stack.mgr.start();
    expect(stack.mgr.getServices().map((s) => s.name)).toEqual(["web"]);
    await stack.mgr.stop();
  });
});

/**
 * The other end of that failure: it has to be VISIBLE (req 13). A mount problem
 * is the one class the snapshot route cannot recompute — it depends on Docker
 * and on the session's layout, not on the declaration — so the resolver records
 * it and the route merges it into the repository's card.
 *
 * Driven through `buildApp` because the route is the surface the Plugins tab
 * actually fetches, and the record travels between two modules to get there.
 */
describe("a plugin service failure reaches the Plugins card (docs/262 req 13)", () => {
  let app: FastifyInstance;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    initGlobalGitConfig(stateRoot);
    sessionManager = new SessionManager(dbManager);
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore: new CredentialStore(stateRoot),
      databaseManager: dbManager,
      workspaceDir: stateRoot,
      serveStatic: false,
    });
    sessionManager.track(SESSION_ID, "Session", workspaceDir);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
  });

  const snapshot = async (): Promise<PluginReposSnapshot> => {
    const res = await app.inject({ method: "GET", url: `/api/plugin-repos?sessionId=${SESSION_ID}` });
    expect(res.statusCode).toBe(200);
    return res.json() as PluginReposSnapshot;
  };

  it("names the import whose services could not be started", async () => {
    writeFixture();
    expect((await snapshot()).repos[0].issues).toEqual([]);

    await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
      workspaceVolume: "shipit-ws",
      stateRoot: path.join(stateRoot, "elsewhere"),
    });

    const issues = (await snapshot()).repos[0].issues;
    // One import, one fact: the message is per import even though the round
    // walks every service of it.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("`probe`");
    expect(issues[0]).toContain("could not locate this session inside the workspace volume");
  });

  it("clears the failure once the next round succeeds", async () => {
    // Nothing else can reconstruct "the mount could not be built", so it is
    // remembered — which makes clearing it the other half of the contract: a
    // card that keeps reporting a fixed failure is the same lie as one that
    // never reported it.
    writeFixture();
    await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
      workspaceVolume: "shipit-ws",
      stateRoot: path.join(stateRoot, "elsewhere"),
    });
    expect((await snapshot()).repos[0].issues).toHaveLength(1);

    await resolveSessionPluginServices(SESSION_ID, workspaceDir, { containEgress: false });

    expect((await snapshot()).repos[0].issues).toEqual([]);
  });
});
