/**
 * docs/262 reqs 3, 16, 18 — plugin services inside a session's compose stack.
 *
 * The service path, exercised with the integration fakes rather than real Docker
 * (plan §5): a plugin service must be indistinguishable from the project's own
 * everywhere a session controls, lists, or previews one, and its published port
 * must survive a fragment that moves.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ServiceManager, type ComposeQuery, type ComposeRunner } from "./service-manager.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { COMPOSE_OVERRIDE_FILE, SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";

let sessionDir: string;

afterEach(() => {
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
});

function setup(projectCompose?: string): string {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-plugin-"));
  const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (projectCompose !== undefined) {
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), projectCompose);
  }
  return workspaceDir;
}

const emptyQuery: ComposeQuery = () => Promise.resolve("");

function pluginService(overrides: Partial<PluginComposeService> = {}): PluginComposeService {
  return {
    name: "probe",
    sourceName: "probe",
    alias: "probe",
    repo: "tools",
    plugin: "probe",
    preview: "auto",
    port: 4820,
    publishedPort: 4820,
    definition: { image: "node:22-alpine", command: "node server.mjs" },
    externalVolumes: [],
    ...overrides,
  };
}

function createManager(
  workspaceDir: string,
  opts: { composeRunner?: ComposeRunner; noProjectCompose?: boolean } = {},
): ServiceManager {
  return new ServiceManager({
    sessionId: "11111111-2222-3333-4444-555555555555",
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: opts.composeRunner ?? (async () => {}),
    composeQuery: emptyQuery,
    pollIntervalMs: 0,
    ...(opts.noProjectCompose ? { noProjectCompose: true } : {}),
  });
}

function readOverride(workspaceDir: string): { services: Record<string, Record<string, unknown>> } {
  const overridePath = path.join(workspaceDir, "..", SESSION_STATE_SUBDIR, COMPOSE_OVERRIDE_FILE);
  return parseYaml(fs.readFileSync(overridePath, "utf-8")) as {
    services: Record<string, Record<string, unknown>>;
  };
}

describe("plugin services in the compose stack", () => {
  it("lists a plugin service beside the project's own, carrying its origin (req 3)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(workspaceDir);
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    const names = mgr.getServices().map((s) => s.name).sort();
    expect(names).toEqual(["probe", "web"]);
    expect(mgr.getService("probe")).toMatchObject({
      preview: "auto",
      port: 4820,
      publishedPort: 4820,
      // A plugin's dependencies are its own — the consuming project's
      // `agent.install` has nothing it reads.
      dependsOnInstall: false,
      origin: { kind: "plugin", repo: "tools", alias: "probe", plugin: "probe", sourceName: "probe" },
    });
    expect(mgr.getService("web")?.origin).toBeUndefined();
    await mgr.stop();
  });

  it("writes the plugin's definition into the override, with ShipIt's policy on top", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    const probe = readOverride(workspaceDir).services.probe;
    expect(probe.image).toBe("node:22-alpine");
    expect(probe.labels).toMatchObject({ "shipit-service-name": "probe" });
    await mgr.stop();
  });

  it("starts an auto plugin service and holds a manual one (req 16)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const upCalls: string[][] = [];
    const mgr = createManager(workspaceDir, {
      composeRunner: async (args) => {
        if (args.includes("up")) upCalls.push(args.filter((a) => !a.startsWith("-") && a !== "compose"));
      },
    });
    mgr.setPluginServices([
      pluginService({ name: "auto-one" }),
      pluginService({ name: "manual-one", preview: "manual", publishedPort: 4821 }),
    ]);
    await mgr.start();

    const started = upCalls.flat();
    expect(started).toContain("auto-one");
    expect(started).not.toContain("manual-one");
    expect(mgr.getService("manual-one")?.status).toBe("stopped");
    await mgr.stop();
  });

  it("keeps the preview origin's port while the fragment's port moves (req 18)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    // The pin says 4820; a tracked commit has since moved the container to 5000.
    mgr.setPluginServices([pluginService({ port: 5000, publishedPort: 4820 })]);
    await mgr.start();

    // The poller normally fills this in; the mapping is what is under test.
    mgr.getService("probe")!.containerIp = "172.20.0.9";
    expect(mgr.resolvePreviewTarget(4820)).toEqual({ containerIp: "172.20.0.9", port: 5000 });
    // The moved container port is NOT an origin — only the pin is addressable.
    expect(mgr.resolvePreviewTarget(5000)).toBeUndefined();
    await mgr.stop();
  });

  it("routes a project service by its own port, unchanged", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(workspaceDir);
    await mgr.start();
    mgr.getService("web")!.containerIp = "172.20.0.2";
    expect(mgr.resolvePreviewTarget(3000)).toEqual({ containerIp: "172.20.0.2", port: 3000 });
    await mgr.stop();
  });

  it("reports whether the plugin service set actually changed", () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    expect(mgr.setPluginServices([pluginService()])).toBe(true);
    expect(mgr.setPluginServices([pluginService()])).toBe(false);
    expect(mgr.setPluginServices([pluginService({ port: 5000 })])).toBe(true);
  });

  // A plugin service gets `/project` read-write (reqs 18, 21), so third-party
  // code can rewrite the project's own compose file — and every later `up`
  // re-reads it from disk. Validating only at start() would execute the
  // rewritten file with none of the checks it was admitted under.
  it("refuses a later `up` when the project's compose file stopped validating", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    x-shipit-preview: manual\n");
    const mgr = createManager(workspaceDir);
    await mgr.start();

    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    privileged: true\n",
    );
    await expect(mgr.startService("web")).rejects.toThrow(/privileged/);
    expect(mgr.getService("web")?.status).toBe("error");
    await mgr.stop();
  });

  it("never runs a compose file the project did not declare", async () => {
    // A conventional `docker-compose.yml` that no `compose:` block names is not
    // this session's stack, and declaring a plugin must not turn it into one.
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    expect(mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    expect(commands.flat()).not.toContain("docker-compose.yml");
    await mgr.stop();
  });

  it("runs a stack made only of plugin services when the project declares no compose file (req 5)", async () => {
    const workspaceDir = setup(); // no docker-compose.yml at all
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    expect(mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    // The absent project file is dropped from the argument vector rather than
    // failing every command.
    const up = commands.find((c) => c.includes("up"))!;
    expect(up).not.toContain("docker-compose.yml");
    expect(up.filter((a) => a === "-f")).toHaveLength(1);
    await mgr.stop();
  });

  it("starts nothing when there is neither a project compose file nor a plugin service", async () => {
    const workspaceDir = setup();
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    await mgr.start();
    expect(commands.some((c) => c.includes("up"))).toBe(false);
    expect(mgr.getServices()).toEqual([]);
  });
});
