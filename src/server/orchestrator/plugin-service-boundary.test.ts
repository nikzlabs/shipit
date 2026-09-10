/** Tests the generated override, not effective Compose merges or image ENV.
 * Secret loaders are injected; production credential wiring is tested separately.
 * The project mount is intentionally writable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type Docker from "dockerode";
import { resolveSessionPluginServices } from "./services/plugin-services.js";
import { ALLOWED_SERVICE_KEYS, parsePluginFragment } from "./plugin-compose.js";
import { ServiceManager, type ComposeQuery, type ComposeRunner } from "./service-manager.js";
import {
  COMPOSE_OVERRIDE_FILE,
  SESSION_STATE_SUBDIR,
  SESSION_WORKSPACE_SUBDIR,
} from "./session-state-dir.js";
import { LOOPBACK_ONLY_PREFIXES } from "../shared/worker-auth.js";
import { releaseSessionGenerationHolds } from "./plugin-leases.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMMIT = "c".repeat(40);

let stateRoot: string;
let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-svc-boundary-"));
  sessionDir = path.join(stateRoot, "sessions", SESSION_ID);
  workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  stateDir = path.join(sessionDir, SESSION_STATE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  // Pin the identity so group_add is emitted in CI as well as session containers.
  vi.stubEnv("SHIPIT_SESSION_WORKER_UID", "1000");
});

afterEach(() => {
  releaseSessionGenerationHolds(SESSION_ID);
  fs.rmSync(stateRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

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

const TRACKED_DECLARATION = `
compose: docker-compose.yml
plugins:
  repos:
    - repo: acme/tools
      name: tools
      branch: main
  use:
    - plugin: probe
      from: tools
      alias: probe
`;

const SELF_DECLARATION = `
compose: docker-compose.yml
exports:
  plugins:
    probe:
      compose: tools/probe/docker-compose.yml
      credentials: [FAL_KEY]
plugins:
  repos:
    - repo: self
      name: mine
  use:
    - plugin: probe
      from: mine
      alias: probe
`;

const TRACKED_MANIFEST = `
exports:
  plugins:
    probe:
      compose: probe/docker-compose.yml
      credentials: [FAL_KEY]
`;

function writeProject(declaration: string): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), declaration);
  fs.writeFileSync(
    path.join(workspaceDir, "docker-compose.yml"),
    "services:\n  web:\n    image: node:20\n    user: \"1000:1000\"\n",
  );
}

function writeSelfFixture(): void {
  writeProject(SELF_DECLARATION);
  fs.mkdirSync(path.join(workspaceDir, "tools", "probe"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "tools", "probe", "docker-compose.yml"), FRAGMENT);
}

function writeTrackedFixture(): void {
  writeProject(TRACKED_DECLARATION);
  const dir = path.join(stateDir, "plugins", "tools", "generations", COMMIT);
  fs.mkdirSync(path.join(dir, "probe"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), TRACKED_MANIFEST);
  fs.writeFileSync(path.join(dir, "probe", "docker-compose.yml"), FRAGMENT);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName: "tools",
      source: "acme/tools",
      commit: COMMIT,
      ref: "branch main",
      activatedAt: new Date(0).toISOString(),
      exports: ["probe"],
      manifestWarnings: [],
    }),
  );
  fs.symlinkSync(dir, path.join(stateDir, "plugins", "tools", "active"));
}

function fakeDocker(): { docker: Docker; volumes: Set<string> } {
  const volumes = new Set<string>(["shipit-ws"]);
  const volumeOpts = new Map<string, Record<string, string>>();
  const docker = {
    createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string> }) => {
      volumes.add(spec.Name);
      volumeOpts.set(spec.Name, spec.DriverOpts ?? {});
    },
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) throw Object.assign(new Error("no such volume"), { statusCode: 404 });
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Options: volumeOpts.get(name) };
      },
      remove: async () => { volumes.delete(name); volumeOpts.delete(name); },
    }),
  };
  return { docker: docker as unknown as Docker, volumes };
}

interface RunOptions {
  docker?: Docker;
  containEgress?: boolean;
  secrets?: Record<string, string>;
  workspaceVolume?: string;
}

async function emitProbeService(opts: RunOptions = {}): Promise<Record<string, unknown>> {
  const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
    ...(opts.docker ? { docker: opts.docker } : {}),
    ...(opts.workspaceVolume ? { workspaceVolume: opts.workspaceVolume, stateRoot } : {}),
    containEgress: opts.containEgress ?? false,
  });
  const mgr = new ServiceManager({
    sessionId: SESSION_ID,
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: (async () => { /* no compose CLI in tests */ }) as ComposeRunner,
    composeQuery: (async () => "") as ComposeQuery,
    pollIntervalMs: 0,
    ...(opts.workspaceVolume
      ? {
        workspaceVolume: opts.workspaceVolume,
        workspaceSubpath: path.posix.join("sessions", SESSION_ID, SESSION_WORKSPACE_SUBDIR),
      }
      : {}),
    ...(opts.containEgress ? { containServicesFn: async () => { /* contained */ } } : {}),
    secretsLoader: async () => opts.secrets ?? {},
  });
  mgr.setPluginServices(services);
  await mgr.start();
  await mgr.stop();

  const override = parseYaml(
    fs.readFileSync(path.join(stateDir, COMPOSE_OVERRIDE_FILE), "utf-8"),
  ) as { services: Record<string, Record<string, unknown>> };
  expect(Object.keys(override.services).sort()).toEqual(["probe", "web"]);
  return override.services.probe;
}

interface MountEntry {
  type: string;
  source: string;
  target: string;
  read_only?: boolean;
  volume?: { subpath?: string };
}

function mounts(entry: Record<string, unknown>): MountEntry[] {
  return (entry.volumes ?? []) as MountEntry[];
}

function fragmentSource(): string {
  return path.join(workspaceDir, "tools", "probe");
}

function pluginStateSource(): string {
  return path.join(sessionDir, "plugin-data", "probe", "state");
}

function settingsSource(): string {
  return path.join(sessionDir, "plugin-data", "probe", "settings.json");
}

function expectBoundaryHolds(
  entry: Record<string, unknown>,
  expected: {
    targets: string[];
    env: Record<string, string>;
    sources: string[];
    contained?: boolean;
  },
): void {
  expect(Object.keys(entry).sort()).toEqual([
    "cap_drop", "command", "environment", "group_add", "image", "labels", "networks",
    ...(expected.contained ? ["restart", "security_opt"] : []),
    "user", "volumes", "working_dir",
  ].sort());

  for (const key of [
    "network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup", "privileged",
    "cap_add", "extra_hosts", "devices", "device_cgroup_rules", "volumes_from",
    "env_file", "secrets", "configs", "build", "external_links", "links",
  ]) {
    expect(entry[key]).toBeUndefined();
  }

  expect(entry.networks).toEqual(["shipit-session"]);
  expect(entry.cap_drop).toEqual(
    expected.contained ? ["NET_RAW", "SETUID", "SETGID"] : ["NET_RAW"],
  );

  expect(mounts(entry).map((m) => m.target).sort()).toEqual([...expected.targets].sort());
  for (const mount of mounts(entry)) {
    expect(expected.sources).toContain(mount.source);
  }

  expect(entry.environment).toEqual(expected.env);
}

describe("plugin services — the fetch-authority boundary (req 19)", () => {
  it("mounts EXACTLY the in-session usage contract for a tracked plugin, and nothing else", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    vi.stubEnv("SHIPIT_AGENT_OPS_URL", "http://127.0.0.1:9100");
    writeTrackedFixture();
    const { docker, volumes } = fakeDocker();

    const probe = await emitProbeService({ docker });

    const generationVolume = [...volumes].find((v) => v !== "shipit-ws")!;
    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      sources: [generationVolume, workspaceDir, pluginStateSource(), settingsSource()],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        SHIPIT_PLUGIN_COMMIT: COMMIT,
      },
    });
    expect(JSON.stringify(probe)).not.toContain("should-never-be-inherited");
    expect(Object.keys(probe.environment as object)).not.toContain("WORKER_PORT");

    const pluginTree = mounts(probe).find((m) => m.target === "/plugin")!;
    expect(pluginTree).toMatchObject({ type: "volume", source: generationVolume, read_only: true });
    expect(mounts(probe).find((m) => m.target === "/app")).toMatchObject({
      type: "volume", source: generationVolume, read_only: true,
    });
    for (const mount of mounts(probe)) {
      if (mount.type === "volume") continue;
      expect(mount.source.startsWith(`${sessionDir}${path.sep}`)).toBe(true);
    }
  });

  it("holds the same boundary on the `repo: self` branch (req 27)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();

    const probe = await emitProbeService();

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      sources: [workspaceDir, fragmentSource(), pluginStateSource()],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
      },
    });
    expect(JSON.stringify(probe)).not.toContain("should-never-be-inherited");
  });

  it("holds the same boundary on the settings branch (req 26)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();
    const settings = path.join(sessionDir, "plugin-data", "probe", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ greeting: "hi" }));

    const probe = await emitProbeService();

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-settings.json", "/plugin-state", "/project"],
      sources: [workspaceDir, fragmentSource(), pluginStateSource(), settingsSource()],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        SHIPIT_SETTINGS: "/plugin-settings.json",
      },
    });
    expect(mounts(probe).find((m) => m.target === "/plugin-settings.json")?.read_only).toBe(true);
    expect(mounts(probe).find((m) => m.target === "/plugin-state")?.read_only).toBeUndefined();
  });

  it("holds the same boundary in a contained session (req 24, docs/263)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    writeSelfFixture();

    const probe = await emitProbeService({ containEgress: true });

    expectBoundaryHolds(probe, {
      contained: true,
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      sources: [workspaceDir, fragmentSource(), pluginStateSource()],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
      },
    });
    expect(probe.security_opt).toEqual(["no-new-privileges"]);
    expect(probe.restart).toBe("no");
    // A merged bridge would bypass containment; replace the network list.
    expect(fs.readFileSync(path.join(stateDir, COMPOSE_OVERRIDE_FILE), "utf-8"))
      .toContain("networks: !override");
  });

  it("mounts session paths as volume subpaths in the production layout, never as binds", async () => {
    writeSelfFixture();

    const probe = await emitProbeService({ workspaceVolume: "shipit-ws" });

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      sources: ["shipit-workspace"],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
      },
    });
    expect(mounts(probe).map((m) => m.type)).not.toContain("bind");
    for (const mount of mounts(probe)) {
      expect(mount.source).toBe("shipit-workspace");
      expect(mount.volume?.subpath).toBeTruthy();
    }
    const sessionSubpath = path.posix.join("sessions", SESSION_ID);
    expect(mounts(probe).find((m) => m.target === "/project")?.volume?.subpath)
      .toBe(`${sessionSubpath}/${SESSION_WORKSPACE_SUBDIR}`);
    expect(mounts(probe).find((m) => m.target === "/plugin-state")?.volume?.subpath)
      .toBe(`${sessionSubpath}/plugin-data/probe/state`);
  });

  it("delivers the plugin's OWN declared credential, and nothing else the store holds", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-orchestrator-fetch-token");
    writeSelfFixture();

    const probe = await emitProbeService({
      secrets: { FAL_KEY: "sk-declared", GITHUB_TOKEN: "ghp-stored-but-undeclared" },
    });

    expectBoundaryHolds(probe, {
      targets: ["/app", "/plugin", "/plugin-state", "/project"],
      sources: [workspaceDir, fragmentSource(), pluginStateSource()],
      env: {
        PROBE_PORT: "4820",
        SHIPIT_PROJECT_DIR: "/project",
        SHIPIT_PLUGIN_STATE: "/plugin-state",
        FAL_KEY: "sk-declared",
      },
    });
    expect(JSON.stringify(probe)).not.toContain("ghp-stored-but-undeclared");
    expect(JSON.stringify(probe)).not.toContain("ghp-orchestrator-fetch-token");
  });

  it("writes no session id into the service — hygiene, not the boundary", async () => {
    writeSelfFixture();

    const probe = await emitProbeService();

    expect(JSON.stringify(probe.environment)).not.toContain(SESSION_ID);
    expect(JSON.stringify(probe.command)).not.toContain(SESSION_ID);
    for (const mount of mounts(probe)) {
      expect(mount.target).not.toContain(SESSION_ID);
    }
  });

  it("labels every plugin service with its session, which is what ShipIt's API guard reads", async () => {
    writeSelfFixture();

    const probe = await emitProbeService();

    expect(probe.labels).toMatchObject({
      "shipit-parent-session": SESSION_ID,
      "shipit-service-name": "probe",
      "shipit-trusted-ops-proxy": "false",
    });
  });

  it("refuses a fragment that asks to share another container's namespace", async () => {
    writeSelfFixture();
    fs.writeFileSync(
      path.join(workspaceDir, "tools", "probe", "docker-compose.yml"),
      FRAGMENT.replace("    working_dir: /app\n", "    network_mode: host\n"),
    );

    const services = await resolveSessionPluginServices(SESSION_ID, workspaceDir, {
      containEgress: false,
    });

    expect(services).toEqual([]);
    expect(() => parsePluginFragment(
      path.join(workspaceDir, "tools", "probe", "docker-compose.yml"),
      false,
    )).toThrow(/`network_mode:`/);
  });

  it("pins the set of keys a plugin fragment may declare at all", () => {
    expect([...ALLOWED_SERVICE_KEYS].sort()).toEqual([
      "command", "cpus", "depends_on", "entrypoint", "environment", "expose",
      "healthcheck", "image", "init", "mem_limit", "mem_reservation",
      "pids_limit", "read_only", "shm_size", "stop_grace_period",
      "stop_signal", "tmpfs", "ulimits", "user", "volumes", "working_dir",
      "x-shipit-preview",
    ]);
  });

  it("keeps the worker's credential broker loopback-only, which is what makes the shared network safe", () => {
    expect(LOOPBACK_ONLY_PREFIXES).toContain("/agent-ops/");
  });
});
