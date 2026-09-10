// Compose is faked; these tests check generated config and runner events.

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
  clearActivationState(SESSION_ID);
});

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const FRAGMENT = `
services:
  probe:
    image: node:22-alpine
    command: node /app/service/server.mjs
    environment:
      PROBE_PORT: "4820"
    volumes:
      - .:/app:ro
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

const PLAIN_USE = "    - plugin: probe\n      from: mine\n"
  + "      overrides:\n        services:\n          probe:\n            port: 4820\n";

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

interface Stack {
  mgr: ServiceManager;
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

function startedNames(commands: string[][]): string[] {
  return commands
    .filter((args) => args.includes("up"))
    .flatMap((args) => args.slice(args.indexOf("up") + 1).filter((a) => !a.startsWith("-")));
}

describe("plugin services in a session's stack (docs/262)", () => {
  it("merges a plugin's fragment into the session's own stack (reqs 3, 5)", async () => {
    writeFixture();
    const stack = makeStack();

    await startStack(stack);

    expect(stack.mgr.getServices().map((s) => s.name).sort())
      .toEqual(["probe", "probe-worker", "web"]);
    const override = readOverride();

    expect(override.probe).toMatchObject({
      image: "node:22-alpine",
      command: "node /app/service/server.mjs",
    });
    expect(override.probe.ports).toBeUndefined();
    expect(override.probe.environment).toMatchObject({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
      SHIPIT_PLUGIN_PORT: "4820",
    });
    const targets = (override.probe.volumes as { target: string }[]).map((m) => m.target).sort();
    expect(targets).toEqual(["/app", "/plugin", "/plugin-state", "/project"]);
    expect(override.web.environment).toBeUndefined();
    await stack.mgr.stop();
  });

  it("starts an auto plugin service and holds a manual one (req 16)", async () => {
    writeFixture();
    const stack = makeStack();

    await startStack(stack);

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

    expect(stack.mgr.getServices().map((s) => s.name).sort())
      .toEqual(["probe-worker", "reqs-probe", "web"]);
    expect(readOverride()["reqs-probe"]).toBeDefined();
    expect(startedNames(stack.commands)).toContain("probe-worker");
    expect(readOverride()["probe-worker"].depends_on).toEqual(["reqs-probe"]);
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
    // No automatic service depends on probe; Compose would start dependencies too.
    const started = startedNames(stack.commands);
    expect(started).not.toContain("probe");
    expect(started).not.toContain("probe-worker");
    expect(started).toContain("web");
    await stack.mgr.stop();
  });

  it("carries the plugin origin on the service messages the runner broadcasts (req 3)", async () => {
    writeFixture();
    const stack = makeStack();
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir,
      defaultAgentId: "claude",
      // Defer worker readiness without connecting to a worker.
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
    expect(listed.find((s) => s.name === "web")).not.toHaveProperty("origin");

    const statuses = emitted.filter((m) => m.type === "service_status") as {
      name: string; origin?: unknown; port?: number;
    }[];
    expect(statuses.find((s) => s.name === "probe")?.origin)
      .toEqual({ kind: "plugin", repo: "mine", alias: "probe", plugin: "probe" });
    expect(statuses.find((s) => s.name === "probe")?.port)
      .toBe(stack.mgr.getService("probe")?.port);

    runner.setServiceManager(null);
    await stack.mgr.stop();
  });

  it("withholds a whole repository's services when one name collides (req 20)", async () => {
    writeFixture({
      projectCompose: "services:\n  probe:\n    image: node:20\n    ports: ['3000:3000']\n",
    });
    const stack = makeStack();

    await startStack(stack);

    expect(stack.mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    expect(stack.mgr.getService("probe")?.origin).toBeUndefined();
    expect(readOverride()["probe-worker"]).toBeUndefined();
    expect(startedNames(stack.commands)).toContain("probe");
    await stack.mgr.stop();
  });

  it("still sends the service list when the stack fails to start (#2325)", async () => {
    writeFixture();
    const commands: string[][] = [];
    const mgr = new ServiceManager({
      sessionId: SESSION_ID,
      workspaceDir,
      serviceEnvDir: path.join(sessionDir, "service-env"),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: (async (args: string[]) => {
        commands.push(args);
        if (args.includes("up")) throw new Error("compose up failed");
      }) as ComposeRunner,
      composeQuery: (async () => "") as ComposeQuery,
      pollIntervalMs: 0,
    });
    const runner = new ContainerSessionRunner({
      sessionId: SESSION_ID,
      sessionDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    const emitted: WsServerMessage[] = [];
    runner.on("message", (msg: WsServerMessage) => emitted.push(msg));
    runner.setServiceManager(mgr);

    const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
    });
    mgr.setPluginServices(services);
    await expect(mgr.start()).rejects.toThrow("compose up failed");

    const list = emitted.find((m) => m.type === "service_list") as
      { services: { name: string; port?: number }[] } | undefined;
    expect(list).toBeDefined();
    expect((list?.services ?? []).map((s) => s.name).sort())
      .toEqual(["probe", "probe-worker", "web"]);
    expect(list?.services.find((s) => s.name === "probe")?.port)
      .toBe(mgr.getService("probe")?.port);

    // The client clears errors on service_list, so the error must follow it.
    const order = emitted.map((m) => m.type);
    expect(order.indexOf("compose_error")).toBeGreaterThan(order.indexOf("service_list"));
    expect((emitted.find((m) => m.type === "compose_error") as { message: string }).message)
      .toContain("compose up failed");

    runner.setServiceManager(null);
    await mgr.stop();
  });

  it("keeps the project's stack running when a plugin cannot be mounted (req 13)", async () => {
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
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("`probe`");
    expect(issues[0]).toContain("could not locate this session inside the workspace volume");
  });

  it("clears the failure once the next round succeeds", async () => {
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
