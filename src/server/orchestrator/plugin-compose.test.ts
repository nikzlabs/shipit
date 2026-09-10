import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveLiveGenerations } from "./plugin-generations.js";
import {
  buildPluginComposeServices,
  collectPluginFragments,
  toComposeService,
  type PluginFragmentService,
} from "./plugin-compose.js";
import { generateComposeOverride } from "./compose-generator.js";
import { parsePluginRepos, parsePluginExports } from "../shared/plugin-repos.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";

let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

const FRAGMENT = `
services:
  probe:
    image: node:22-alpine
    user: "1000:1000"
    working_dir: /app
    command: node /app/service/server.mjs
    environment:
      PROBE_PORT: "4820"
    volumes:
      - .:/app:ro
    x-shipit-preview: auto
`;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-compose-"));
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  fs.mkdirSync(path.join(workspaceDir, "tools", "probe"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeFragment(FRAGMENT);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeFragment(body: string): void {
  fs.writeFileSync(path.join(workspaceDir, "tools", "probe", "docker-compose.yml"), body);
}

function declare(consumer: string, manifest = defaultManifest()): {
  plugins: PluginReposConfig;
  selfExports: PluginExport[];
} {
  const warnings: string[] = [];
  const plugins = parsePluginRepos(parseYaml(consumer), [], warnings);
  const selfExports = parsePluginExports(parseYaml(manifest), warnings);
  return { plugins, selfExports };
}

function defaultManifest(): string {
  return `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
`;
}

const SELF_USE = `
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4820
`;

function collect(consumer: string, manifest = defaultManifest(), opts: {
  projectServiceNames?: string[];
  containEgress?: boolean;
} = {}): ReturnType<typeof collectPluginFragments> {
  const { plugins, selfExports } = declare(consumer, manifest);
  return collectPluginFragments({
    workspaceDir,
    live: resolveLiveGenerations(stateDir, plugins.repos),
    plugins,
    selfExports,
    projectServiceNames: opts.projectServiceNames ?? [],
    containEgress: opts.containEgress ?? false,
  });
}

function build(fragments: PluginFragmentService[], overrides: {
  workspaceVolume?: string;
  workspaceSubpath?: string;
  sessionSubpath?: string;
} = {}): ReturnType<typeof buildPluginComposeServices> {
  return buildPluginComposeServices(fragments, {
    sessionDir,
    workspaceDir,
    ...overrides,
    pluginVolumes: new Map(),
  });
}

function trackedVolumes(fragment: PluginFragmentService): Record<string, unknown>[] {
  const built = buildPluginComposeServices([{ ...fragment, self: false, commit: "abc123" }], {
    sessionDir,
    workspaceDir,
    pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
  });
  return built.services[0].definition.volumes as Record<string, unknown>[];
}

describe("collectPluginFragments", () => {
  it("surfaces a self-declared plugin's services (reqs 3, 27)", () => {
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(issuesByRepo.size).toBe(0);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: "probe",
      sourceName: "probe",
      alias: "probe",
      repo: "mine",
      plugin: "probe",
      preview: "auto",
      port: 4820,
      fragmentDir: "tools/probe",
      self: true,
    });
    expect(services[0].definition.ports).toBeUndefined();
    expect(services[0].definition["x-shipit-preview"]).toBeUndefined();
  });

  it("refuses a fragment that still declares `ports:` (docs/266-plugin-service-ports reqs 1, 6)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    ports:
      - "4820:4820"
`);
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("`ports:`");
    expect(issues[0]).toContain("Remove the `ports:` line.");
    expect(issues[0]).toContain("`plugins.use`");
  });

  it("is not previewable when the consuming project names no port (docs/266-plugin-service-ports req 9)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services).toHaveLength(1);
    expect(services[0].port).toBeUndefined();
  });

  it("defaults a portless service to manual when the fragment says nothing", () => {
    writeFragment("services:\n  probe:\n    image: node:22-alpine\n");
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services[0].preview).toBe("manual");
  });

  it("still starts a portless service the consumer asked to autostart (req 16)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          autostart: true
`);
    expect(services[0].port).toBeUndefined();
    expect(services[0].preview).toBe("auto");
  });

  it("refuses two plugin services given one port, naming both (docs/266-plugin-service-ports req 7)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
        worker:
          port: 4300
`);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("4300");
    expect(issues[0]).toContain("probe");
    expect(issues[0]).toContain("worker");
  });

  it("refuses one port claimed across TWO imports, naming both (docs/266-plugin-service-ports req 7)", () => {
    fs.mkdirSync(path.join(workspaceDir, "tools", "other"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "tools", "other", "docker-compose.yml"),
      "services:\n  other:\n    image: node:22-alpine\n");
    const manifest = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
  other:
    compose: tools/other/docker-compose.yml
`;
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
  - plugin: other
    from: mine
    alias: other
    overrides:
      services:
        other:
          port: 4300
`, manifest);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("4300");
    expect(issues[0]).toContain("other");
    expect(issues[0]).toContain("probe");
  });

  it("withholds the REST of an import whose port collides — never half a plugin", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4300
        worker:
          port: 4300
`);
    expect(services.map((s) => s.name)).toEqual([]);
  });

  it("keeps an explicit `x-shipit-preview` on a portless service (no silent drop)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    x-shipit-preview: auto
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    expect(services[0].port).toBeUndefined();
    expect(services[0].preview).toBe("auto");
  });

  it("applies the consumer's autostart override (req 16)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        probe:
          port: 4820
          autostart: false
`);
    expect(services[0].preview).toBe("manual");
  });

  it("renames a service through `as`, and follows it in depends_on (req 20)", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    depends_on: [worker]
  worker:
    image: node:22-alpine
`);
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        worker:
          as: probe-worker
`);
    expect(services.map((s) => s.name).sort()).toEqual(["probe", "probe-worker"]);
    expect(services.find((s) => s.name === "probe")!.definition.depends_on).toEqual(["probe-worker"]);
  });

  it("reports a collision with a project service and surfaces nothing (req 20)", () => {
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), {
      projectServiceNames: ["probe"],
    });
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("collides with a service this project");
    expect(issues[0]).toContain("overrides.services.probe.as");
  });

  it("drops every service of a plugin when one collides — never half a plugin", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
  worker:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), {
      projectServiceNames: ["worker"],
    });
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")).toHaveLength(1);
  });

  it("withholds a repository's OTHER imports too — a stack activates as a unit", () => {
    fs.mkdirSync(path.join(workspaceDir, "tools", "other"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "tools", "other", "docker-compose.yml"),
      "services:\n  other:\n    image: node:22-alpine\n");
    const manifest = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
  other:
    compose: tools/other/docker-compose.yml
`;
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
  - plugin: other
    from: mine
`, manifest, { projectServiceNames: ["probe"] });
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")).toHaveLength(1);
  });

  it("reports an override naming a service the plugin does not define", () => {
    const { services, issuesByRepo } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
    overrides:
      services:
        gone:
          autostart: false
`);
    expect(services).toHaveLength(0);
    expect(issuesByRepo.get("mine")?.[0]).toContain("names a service this plugin does not define");
  });

  it("says nothing about a repository whose export declares no compose fragment", () => {
    const { services, issuesByRepo } = collect(SELF_USE, `
plugins:
  probe:
    cli:
      probe: cli/probe.mjs
`);
    expect(services).toHaveLength(0);
    expect(issuesByRepo.size).toBe(0);
  });
});

describe("fragment validation (req 20)", () => {
  const reject = (body: string, opts: { containEgress?: boolean } = {}): string => {
    writeFragment(body);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), opts);
    expect(services).toHaveLength(0);
    const issues = issuesByRepo.get("mine") ?? [];
    expect(issues).toHaveLength(1);
    return issues[0];
  };

  it("refuses a service key it does not understand", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    privileged: true
`)).toContain("`privileged:`");
  });

  it("refuses `build:` and says what to do instead", () => {
    expect(reject(`
services:
  probe:
    build: .
`)).toContain("declare an `image:` instead");
  });

  it("refuses a named volume and points at /plugin-state", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - plugin-data:/data
`)).toContain("/plugin-state");
  });

  it("refuses an absolute bind source", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - /etc:/host-etc
`)).toContain("Absolute bind mount path");
  });

  it("refuses a `./` source that climbs out of the plugin with ..", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./../../../etc:/host-etc
`)).toContain("Path traversal");
  });

  it("refuses a .. buried mid-path, not just a leading one", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./lib/../../../etc:/host-etc
`)).toContain("Path traversal");
  });

  it("refuses the same traversal in the long form's `source`", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - type: bind
        source: ./../..
        target: /host
`)).toContain("Path traversal");
  });

  it("still accepts an ordinary nested path containing no .. segment", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - ./lib/assets:/assets
`);
    const { services, issuesByRepo } = collect(SELF_USE, defaultManifest());
    expect(services).toHaveLength(1);
    expect(issuesByRepo.size).toBe(0);
  });

  it("refuses a pass-through environment entry, which would read the orchestrator's env", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    environment:
      - GITHUB_TOKEN
`)).toContain("has no value");
  });

  it("refuses the Docker socket even when the project granted itself one", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`)).toContain("Docker socket mount is not allowed");
  });

  it("refuses top-level blocks ShipIt owns", () => {
    expect(reject(`
volumes:
  data: {}
services:
  probe:
    image: node:22-alpine
`)).toContain("ShipIt owns the session's networks");
  });

  it("refuses a depends_on that reaches outside the plugin", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    depends_on: [web]
`)).toContain("not a service in the same plugin");
  });

  it("refuses a value carrying ShipIt's own override sentinel", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    command: "echo __RESET_PORTS__"
`)).toContain("reserved by ShipIt");
  });

  it("refuses a service with no image", () => {
    expect(reject(`
services:
  probe:
    command: sleep 1
`)).toContain("declares no `image:`");
  });

  it("applies the contained-egress rules a contained session applies to the project", () => {
    expect(reject(`
services:
  probe:
    image: node:22-alpine
    user: "0"
`, { containEgress: true })).toContain("numeric, non-root `user:`");
  });

  it("accepts the same fragment in an open session", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
`);
    const { services, issuesByRepo } = collect(SELF_USE);
    expect(issuesByRepo.size).toBe(0);
    expect(services).toHaveLength(1);
  });

  describe("an undeclared user: under containment (github#2374)", () => {
    const orig = process.env.SHIPIT_SESSION_WORKER_UID;
    afterEach(() => {
      if (orig === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
      else process.env.SHIPIT_SESSION_WORKER_UID = orig;
    });

    it("is accepted when ShipIt has an identity to fill in", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      writeFragment(`
services:
  probe:
    image: node:22-alpine
`);
      const { services, issuesByRepo } = collect(SELF_USE, defaultManifest(), { containEgress: true });
      expect(issuesByRepo.size).toBe(0);
      expect(services).toHaveLength(1);
      const built = build(services);
      expect(built.issuesByRepo.size).toBe(0);
      expect(toComposeService(built.services[0]!).user).toBeUndefined();
    });

    it("is still refused when there is no worker uid to fill in", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(reject(`
services:
  probe:
    image: node:22-alpine
`, { containEgress: true })).toContain("numeric, non-root `user:`");
    });
  });
});

describe("buildPluginComposeServices", () => {
  it("rewrites the fragment's relative mount against the plugin's own directory (req 5)", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "bind",
      source: path.join(workspaceDir, "tools/probe"),
      target: "/app",
      read_only: true,
    });
  });

  it("uses the workspace volume with a subpath when the orchestrator is containerized", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      sessionSubpath: "sessions/abc",
    });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/app",
      volume: { subpath: "sessions/abc/workspace/tools/probe" },
      read_only: true,
    });
  });

  it("mounts the plugin's own tree at /plugin, read-write for a self import", () => {
    const { services } = collect(SELF_USE);
    const volumes = build(services).services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "bind",
      source: workspaceDir,
      target: "/plugin",
    });
  });

  it("mounts a tracked generation's tree read-only at /plugin", () => {
    const { services } = collect(SELF_USE);
    const volumes = trackedVolumes(services[0]);
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/plugin",
      read_only: true,
    });
  });

  it("forces a tracked fragment's own relative mount read-only, whatever it declared", () => {
    writeFragment(FRAGMENT.replace("- .:/app:ro", "- .:/app\n      - ./service:/srv"));
    const { services } = collect(SELF_USE);
    const volumes = trackedVolumes(services[0]);

    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/app",
      volume: { subpath: "tools/probe" },
      read_only: true,
    });
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/srv",
      volume: { subpath: "tools/probe/service" },
      read_only: true,
    });
    for (const volume of volumes) {
      if (volume.source === "shipit-x_plugin-mine") expect(volume.read_only).toBe(true);
    }
  });

  it("leaves a self import's own relative mount writable when it declared none", () => {
    writeFragment(FRAGMENT.replace("- .:/app:ro", "- .:/app"));
    const { services } = collect(SELF_USE);
    const volumes = build(services).services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "bind",
      source: path.join(workspaceDir, "tools/probe"),
      target: "/app",
    });
  });

  it("mounts the project at /project and the import's state dir read-write (reqs 18, 21)", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({ type: "bind", source: workspaceDir, target: "/project" });
    expect(volumes).toContainEqual({
      type: "bind",
      source: path.join(sessionDir, "plugin-data", "probe", "state"),
      target: "/plugin-state",
    });
    expect(fs.existsSync(path.join(sessionDir, "plugin-data", "probe", "state"))).toBe(true);
  });

  it("mounts the settings file read-only, and only once it exists (req 26)", () => {
    const { services } = collect(SELF_USE);
    expect((build(services).services[0].definition.volumes as unknown[])
      .some((v) => (v as { target?: string }).target === "/plugin-settings.json")).toBe(false);

    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const withSettings = build(services).services[0];
    expect(withSettings.definition.volumes as unknown[]).toContainEqual({
      type: "bind",
      source: path.join(sessionDir, "plugin-data", "probe", "settings.json"),
      target: "/plugin-settings.json",
      read_only: true,
    });
    expect(withSettings.definition.environment)
      .toMatchObject({ SHIPIT_SETTINGS: "/plugin-settings.json" });
  });

  it("mounts the state dir and settings file through the workspace volume, not as binds", () => {
    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const { services } = collect(SELF_USE);
    const built = buildPluginComposeServices(services, {
      sessionDir,
      sessionSubpath: "sessions/abc",
      workspaceDir,
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      pluginVolumes: new Map(),
      });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-state",
      volume: { subpath: "sessions/abc/plugin-data/probe/state" },
    });
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-settings.json",
      volume: { subpath: "sessions/abc/plugin-data/probe/settings.json" },
      read_only: true,
    });
  });

  it("leaves no bind and no subpath-less volume in the production layout", () => {
    fs.mkdirSync(path.join(sessionDir, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plugin-data", "probe", "settings.json"), "{}\n");
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit_workspace",
      workspaceSubpath: "sessions/abc/workspace",
      sessionSubpath: "sessions/abc",
    });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];

    for (const volume of volumes) {
      expect(volume.type).toBe("volume");
      expect(volume.volume).toMatchObject({ subpath: expect.any(String) });
    }
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/project",
      volume: { subpath: "sessions/abc/workspace" },
    });
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin",
      volume: { subpath: "sessions/abc/workspace" },
    });
  });

  it("drops the services with a reason when the session cannot be located in the volume", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, { workspaceVolume: "shipit_workspace" });

    expect(built.services).toEqual([]);
    expect(built.issuesByRepo.get("mine")?.[0]).toContain("could not locate this session");
  });

  it("fingerprints the settings so a change recreates the container (req 26)", () => {
    const settings = path.join(sessionDir, "plugin-data", "probe", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `{"greeting":"hi"}\n`);
    const { services } = collect(SELF_USE);
    const first = build(services).services[0].settingsFingerprint;
    expect(first).toBeTruthy();

    fs.writeFileSync(settings, `{"greeting":"hello"}\n`);
    const second = build(collect(SELF_USE).services).services[0].settingsFingerprint;
    expect(second).not.toBe(first);

    const yaml = generateComposeOverride([toComposeService(build(services).services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as { services: Record<string, { labels: Record<string, string> }> };
    expect(doc.services.probe.labels["shipit-plugin-settings"]).toBe(second);
  });

  it("gates a `repo: self` service on the project's install, and a tracked one not (docs/137, req 27)", () => {
    const { services } = collect(SELF_USE);
    expect(toComposeService(build(services).services[0]).dependsOnInstall).toBe(true);

    const tracked = buildPluginComposeServices([{ ...services[0], self: false, commit: "abc123" }], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    expect(toComposeService(tracked.services[0]).dependsOnInstall).toBe(false);
  });

  it("names the contract in the environment, without a commit for a self import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const env = build(services).services[0].definition.environment as Record<string, string>;
    expect(env).toMatchObject({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
      SHIPIT_PLUGIN_PORT: "4820",
    });
    expect(env.SHIPIT_PLUGIN_COMMIT).toBeUndefined();
  });

  it("sets no port variable for a service the project named no port for (docs/266-plugin-service-ports req 9)", () => {
    const { services } = collect(`
repos:
  - repo: self
    name: mine
use:
  - plugin: probe
    from: mine
`);
    const env = build(services).services[0].definition.environment as Record<string, string>;
    expect(env.SHIPIT_PLUGIN_PORT).toBeUndefined();
  });

  it("carries the commit for a tracked import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    const env = built.services[0].definition.environment as Record<string, string>;
    expect(env.SHIPIT_PLUGIN_COMMIT).toBe("abc123");
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes[0]).toEqual({
      type: "volume",
      source: "shipit-x_plugin-mine",
      target: "/app",
      volume: { subpath: "tools/probe" },
      read_only: true,
    });
    expect(built.services[0].externalVolumes).toEqual(["shipit-x_plugin-mine"]);
  });

  it("drops a tracked plugin whose runtime layer is missing, with a reason", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map(),
      });
    expect(built.services).toHaveLength(0);
    expect(built.issuesByRepo.get("mine")?.[0]).toContain("writable layer is not available");
  });

  it("escapes `$` so nothing in a fragment interpolates the orchestrator's environment", () => {
    writeFragment(`
services:
  probe:
    image: node:22-alpine
    command: sh -c 'echo $HOME'
    environment:
      LEAK: "\${GITHUB_TOKEN}"
`);
    const { services } = collect(SELF_USE);
    const definition = build(services).services[0].definition;
    expect(definition.command).toBe("sh -c 'echo $$HOME'");
    // eslint-disable-next-line no-template-curly-in-string -- the escaped form is the assertion
    expect((definition.environment as Record<string, string>).LEAK).toBe("$${GITHUB_TOKEN}");
  });
});

describe("override emission", () => {
  it("emits a plugin service with ShipIt's own policy layered over its definition", () => {
    const { services } = collect(SELF_USE);
    const built = build(services);
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as {
      services: Record<string, Record<string, unknown>>;
      volumes?: Record<string, unknown>;
    };
    const probe = doc.services.probe;
    expect(probe.image).toBe("node:22-alpine");
    expect(probe.command).toBe("node /app/service/server.mjs");
    expect(probe.labels).toMatchObject({ "shipit-parent-session": "session-1" });
    expect(probe.networks).toEqual(["shipit-session"]);
    expect(probe.cap_drop).toEqual(["NET_RAW"]);
    expect(probe.user).toBe("1000:1000");
    expect(probe.ports).toBeUndefined();
  });

  it("nests the session's overlay dep dirs under a `repo: self` plugin's tree", () => {
    const { services } = collect(SELF_USE);
    const built = build(services, {
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/s1/workspace",
      sessionSubpath: "sessions/s1",
    });
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      workspaceVolume: "shipit-ws",
      workspaceSubpath: "sessions/s1/workspace",
      overlayDepDirs: [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }],
    });
    const doc = parseYaml(yaml) as {
      services: Record<string, { volumes: Record<string, unknown>[] }>;
      volumes: Record<string, unknown>;
    };
    const targets = doc.services.probe.volumes.map((v) => v.target);
    expect(targets).toContain("/plugin/node_modules");
    expect(targets).toContain("/project/node_modules");
    expect(targets).not.toContain("/app/node_modules");
    expect(targets).not.toContain("/plugin-state/node_modules");
    expect(doc.volumes["shipit-s1_overlay-aaaa"]).toEqual({
      name: "shipit-s1_overlay-aaaa",
      external: true,
    });
  });

  it("declares the plugin's overlay volume external so compose only references it", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      });
    const yaml = generateComposeOverride([toComposeService(built.services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as { volumes: Record<string, unknown> };
    expect(doc.volumes["shipit-x_plugin-mine"]).toEqual({
      name: "shipit-x_plugin-mine",
      external: true,
    });
  });
});

describe("declared credential names on the compose surface (req 23)", () => {
  const WITH_CREDENTIALS = `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
    credentials: [FAL_KEY, FAL_KEY, OPENAI_API_KEY]
`;

  it("carries the manifest's names onto the service, de-duplicated", () => {
    const { services } = collect(SELF_USE, WITH_CREDENTIALS);
    expect(services[0].credentials).toEqual(["FAL_KEY", "OPENAI_API_KEY"]);
    expect(build(services).services[0].credentials).toEqual(["FAL_KEY", "OPENAI_API_KEY"]);
  });

  it("carries an OPTIONAL name too — delivery does not read the flag (reqs 23, 24)", () => {
    const { services } = collect(SELF_USE, `
plugins:
  probe:
    compose: tools/probe/docker-compose.yml
    credentials: [FAL_KEY, { name: PIXELLAB_KEY, optional: true }]
`);
    expect(services[0].credentials).toEqual(["FAL_KEY", "PIXELLAB_KEY"]);
    expect(build(services).services[0].credentials).toEqual(["FAL_KEY", "PIXELLAB_KEY"]);
  });

  it("a plugin that declares none carries none", () => {
    const { services } = collect(SELF_USE);
    expect(services[0].credentials).toEqual([]);
    expect(build(services).services[0].credentials).toEqual([]);
  });

  it("resolves no value here — this module carries names only", () => {
    const { services } = collect(SELF_USE, WITH_CREDENTIALS);
    const definition = build(services).services[0].definition;
    expect(JSON.stringify(definition)).not.toContain("FAL_KEY");
    expect(definition.env_file).toBeUndefined();
    expect(Object.keys(definition.environment as Record<string, string>)).toEqual(
      expect.not.arrayContaining(["FAL_KEY", "OPENAI_API_KEY"]),
    );
  });

  it("a changed credential set is a changed service, so the container is recreated", () => {
    const before = build(collect(SELF_USE).services).services[0];
    const after = build(collect(SELF_USE, WITH_CREDENTIALS).services).services[0];
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });
});
