import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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

/**
 * A session layout with a `repo: self` declaration, which is the fixture shape
 * that needs no fetch: the "checkout" is the workspace itself (req 27), so the
 * whole path — locate, validate, rename, mount — runs without Docker.
 */
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
    ports:
      - "4820:4820"
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

/** Parse a consumer + manifest pair the way `shipit-config.ts` does. */
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
`;

function collect(consumer: string, manifest = defaultManifest(), opts: {
  projectServiceNames?: string[];
  containEgress?: boolean;
} = {}): ReturnType<typeof collectPluginFragments> {
  const { plugins, selfExports } = declare(consumer, manifest);
  return collectPluginFragments({
    workspaceDir,
    stateDir,
    plugins,
    selfExports,
    projectServiceNames: opts.projectServiceNames ?? [],
    containEgress: opts.containEgress ?? false,
  });
}

function build(fragments: PluginFragmentService[], overrides: {
  workspaceVolume?: string;
  workspaceSubpath?: string;
} = {}): ReturnType<typeof buildPluginComposeServices> {
  return buildPluginComposeServices(fragments, {
    sessionDir,
    workspaceDir,
    ...overrides,
    pluginVolumes: new Map(),
    publishedPorts: new Map(fragments.map((f) => [f.name, f.port ?? 40_000])),
  });
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
    // `ports:` is read, never re-emitted — ShipIt publishes no host ports.
    expect(services[0].definition.ports).toBeUndefined();
    expect(services[0].definition["x-shipit-preview"]).toBeUndefined();
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
    // The message has to name the key the fix goes under.
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
    // `other` is perfectly valid on its own; it is withheld because the
    // repository it comes from cannot activate as a whole.
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
    // Unresolvable is a PROJECT problem — Compose refuses the whole document —
    // and resolvable would be a plugin ordering a repository it knows nothing
    // about.
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

  it("mounts the plugin's own tree read-only at /plugin, the path every surface uses", () => {
    const { services } = collect(SELF_USE);
    const volumes = build(services).services[0].definition.volumes as Record<string, unknown>[];
    // A `cli:` entrypoint is declared relative to the repository ROOT, so this
    // is the repo root — not the fragment's directory, which is what the
    // fragment's own `.` resolves to.
    expect(volumes).toContainEqual({
      type: "bind",
      source: workspaceDir,
      target: "/plugin",
      read_only: true,
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

  // In production the session tree lives inside a named volume, so a plain bind
  // of the orchestrator's path makes Docker create an empty, root-owned
  // directory — `/plugin-state` would not be the state the CLI writes to, and
  // dev would work perfectly the whole time.
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
      publishedPorts: new Map(),
    });
    const volumes = built.services[0].definition.volumes as Record<string, unknown>[];
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-state",
      volume: { subpath: "sessions/abc/plugin-data/probe/state" },
    });
    // A FILE subpath, which the daemon supports (it stats the resolved path and
    // binds a file as a file). Its parent is the plugin's writable state, so
    // mounting that instead would hand the plugin its own settings to rewrite.
    expect(volumes).toContainEqual({
      type: "volume",
      source: "shipit-workspace",
      target: "/plugin-settings.json",
      volume: { subpath: "sessions/abc/plugin-data/probe/settings.json" },
      read_only: true,
    });
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

    // It rides a label, which is what makes Compose treat the service as
    // changed — the mount PATH is identical either way.
    const yaml = generateComposeOverride([toComposeService(build(services).services[0])], {
      sessionId: "session-1",
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    });
    const doc = parseYaml(yaml) as { services: Record<string, { labels: Record<string, string> }> };
    expect(doc.services.probe.labels["shipit-plugin-settings"]).toBe(second);
  });

  it("names the contract in the environment, without a commit for a self import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const env = build(services).services[0].definition.environment as Record<string, string>;
    expect(env).toMatchObject({
      PROBE_PORT: "4820",
      SHIPIT_PROJECT_DIR: "/project",
      SHIPIT_PLUGIN_STATE: "/plugin-state",
    });
    expect(env.SHIPIT_PLUGIN_COMMIT).toBeUndefined();
  });

  it("carries the commit for a tracked import (req 15)", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      publishedPorts: new Map(),
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
      publishedPorts: new Map(),
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
    // ShipIt's own keys win over anything the fragment could have declared.
    expect(probe.labels).toMatchObject({ "shipit-parent-session": "session-1" });
    expect(probe.networks).toEqual(["shipit-session"]);
    expect(probe.cap_drop).toEqual(["NET_RAW"]);
    // The fragment's `user:` is honored rather than replaced.
    expect(probe.user).toBe("1000:1000");
    // No host publishing — the preview proxy reaches it on the session network.
    expect(probe.ports).toBeUndefined();
  });

  it("declares the plugin's overlay volume external so compose only references it", () => {
    const { services } = collect(SELF_USE);
    const tracked = { ...services[0], self: false, commit: "abc123" };
    const built = buildPluginComposeServices([tracked], {
      sessionDir,
      workspaceDir,
      pluginVolumes: new Map([["mine", "shipit-x_plugin-mine"]]),
      publishedPorts: new Map(),
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
