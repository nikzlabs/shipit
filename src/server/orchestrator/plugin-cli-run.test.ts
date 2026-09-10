import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import {
  mapWorkingDir,
  runPluginCommand,
  PLUGIN_CLI_LABEL,
  PLUGIN_CLI_NETWORK,
  type PluginCliDeps,
} from "./plugin-cli-run.js";
import { OVERLAY_VERIFY_FAILURE } from "./overlay-volume.js";
import { PLUGIN_BROWSERS_DIR, PLUGIN_NPM_PREFIX_DIR } from "./plugin-container-env.js";
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";
import {
  claimGenerationDeletion,
  generationHoldCount,
  releaseSessionGenerationHolds,
} from "./plugin-leases.js";
import { UNCONTAINED_PLUGIN_EGRESS, type PluginEgressPolicy } from "./plugin-egress.js";

// Stub privileged setup; keep the namespace decision on the production path.
vi.mock("./egress-firewall-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-firewall-install.js")>()),
  buildTierAEgressInputs: vi.fn(async () => ({ hosts: [], cidrs: [] })),
  installEgressFirewall: vi.fn(async () => undefined),
}));
vi.mock("./egress-dns-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-dns-install.js")>()),
  launchEgressResolver: vi.fn(async () => "resolver-id"),
}));
vi.mock("./egress-proxy-install.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./egress-proxy-install.js")>()),
  launchEgressProxy: vi.fn(async () => "proxy-id"),
}));

const CONTAINED_EGRESS: PluginEgressPolicy = {
  contained: true,
  config: { contained: true, extraHosts: [] },
  sidecarImage: "egress-sidecar:test",
  dnsEnabled: true,
  proxyEnabled: true,
};

const COMMIT = "d".repeat(40);

const CLI_SUBNET_ADDRESS = "172.29.0.7";
const SESSION_BRIDGE_ADDRESS = "172.18.0.4";

let sessionDir: string;
let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cli-run-"));
  workspaceDir = path.join(sessionDir, "workspace");
  stateDir = path.join(sessionDir, "state");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  clearUntrustedContainerNetworks();
  vi.unstubAllEnvs();
});

const CONSUMER = `
plugins:
  repos:
    - repo: acme/tools
      name: tools
  use:
    - plugin: requirements
      from: tools
      alias: reqs
`;

const MANIFEST = `
exports:
  plugins:
    requirements:
      cli:
        reqs: cli/index.mjs
      credentials: [FAL_KEY]
`;

function declareConsumer(yaml = CONSUMER): void {
  fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), yaml);
}

function declareSelfUse(): void {
  declareConsumer(`
plugins:
  repos:
    - repo: self
      name: here
  use:
    - plugin: probe
      from: here
exports:
  plugins:
    probe:
      cli:
        probe: tools/probe
`);
}

function publishGeneration(manifest = MANIFEST, source = "acme/tools"): void {
  const dir = path.join(stateDir, "plugins", "tools", "generations", COMMIT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName: "tools", source, commit: COMMIT, ref: "branch main",
      activatedAt: new Date(0).toISOString(), exports: ["requirements"], manifestWarnings: [],
    }),
  );
  fs.symlinkSync(dir, path.join(stateDir, "plugins", "tools", "active"));
}

interface Created {
  id: string;
  opts: Record<string, unknown>;
  deniedAtCreate: boolean;
}

interface Mount {
  Type: string;
  Source: string;
  Target: string;
  ReadOnly?: boolean;
  VolumeOptions?: { Subpath?: string };
}

function mountFor(host: { Mounts: Mount[] }, target: string): Mount | undefined {
  return host.Mounts.find((m) => m.Target === target);
}

function fakeDocker(opts: {
  exit?: number;
  stdout?: string;
  stderr?: string;
  vanishNamedVolumesOnCreate?: boolean;
  removeError?: string;
} = {}) {
  const containers: Created[] = [];
  const started: string[] = [];
  const removedContainers: string[] = [];
  const volumes = new Set<string>(["shipit-ws"]);
  const volumeOpts = new Map<string, Record<string, string> | null>();
  const networks: string[] = [];
  const connected: unknown[] = [];
  const notFound = (): never => {
    throw Object.assign(new Error("no such thing"), { statusCode: 404 });
  };

  const docker = {
    modem: {
      demuxStream: (_s: NodeJS.ReadableStream, out: NodeJS.WritableStream, err: NodeJS.WritableStream) => {
        if (opts.stdout) out.write(opts.stdout);
        if (opts.stderr) err.write(opts.stderr);
      },
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!networks.includes(name)) notFound();
        return { IPAM: { Config: [{ Subnet: "172.29.0.0/16" }] } };
      },
      connect: async (spec: unknown) => { connected.push(spec); },
    }),
    createNetwork: async (spec: { Name: string }) => { networks.push(spec.Name); },
    createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string> }) => {
      volumes.add(spec.Name);
      volumeOpts.set(spec.Name, spec.DriverOpts ?? {});
    },
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) notFound();
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Options: volumeOpts.get(name) };
      },
      remove: async () => { volumes.delete(name); volumeOpts.delete(name); },
    }),
    listContainers: async () => [],
    getContainer: (_id: string) => ({ remove: async () => undefined }),
    createContainer: async (createOpts: Record<string, unknown>) => {
      if (opts.vanishNamedVolumesOnCreate) {
        for (const name of volumes) {
          if (name === "shipit-ws") continue;
          volumeOpts.set(name, null);
        }
      }
      const id = `c-${containers.length + 1}`;
      containers.push({
        id,
        opts: createOpts,
        deniedAtCreate: isUntrustedContainerIp(CLI_SUBNET_ADDRESS),
      });
      return {
        id,
        attach: async () => {
          // Consume the stream as dockerode's demuxer would, so end/close can fire.
          const s = new PassThrough();
          s.resume();
          return s;
        },
        start: async () => { started.push(id); },
        wait: async () => ({ StatusCode: opts.exit ?? 0 }),
        kill: async () => undefined,
        remove: async () => {
          if (opts.removeError) throw new Error(opts.removeError);
          removedContainers.push(id);
        },
      };
    },
  };
  return {
    docker: docker as unknown as Docker,
    containers, networks, volumes, connected, started, removedContainers,
  };
}

function expectBoundaryHolds(
  created: Record<string, unknown>,
  expectedTargets: string[],
  expectedNetworkMode: string = PLUGIN_CLI_NETWORK,
): void {
  const host = created.HostConfig as {
    Mounts: Mount[];
    Binds?: string[];
    VolumesFrom?: string[];
    NetworkMode: string;
  };
  expect(host.Mounts.map((m) => m.Target).sort()).toEqual([...expectedTargets].sort());
  expect(host.Binds ?? []).toEqual([]);
  expect(host.VolumesFrom ?? []).toEqual([]);
  expect(created.NetworkingConfig).toBeUndefined();
  expect(host.NetworkMode).toBe(expectedNetworkMode);
  for (const m of host.Mounts) {
    expect(`${m.Source} ${m.Target}`).not.toMatch(/credential/i);
  }
  const env = created.Env as string[];
  for (const e of env) {
    expect(e).not.toMatch(/^(GITHUB_TOKEN|GH_TOKEN|WORKER_URL|WORKER_PORT|SHIPIT_AGENT_OPS_URL|ORCHESTRATOR_URL|PATH)=/);
  }
  expect(env.join("\n")).not.toContain("should-never-be-inherited");
}

function deps(docker: Docker, over: Partial<PluginCliDeps> = {}): PluginCliDeps {
  return {
    docker,
    image: "worker:test",
    sessionId: "s1",
    workspaceDir,
    consumerRepoUrl: "https://github.com/acme/project",
    secretStore: { loadSecrets: () => ({ FAL_KEY: "secret-value", OTHER: "not-declared" }) },
    ...over,
  };
}

const call = { alias: "reqs", command: "reqs", args: ["list", "--json"] };

describe("runPluginCommand — the container it builds", () => {
  it("mounts the generation's tree, /project, and the import's state dir", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker({ stdout: "ok\n" });

    const result = await runPluginCommand(deps(fake.docker), call);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");

    const created = fake.containers[0].opts;
    const host = created.HostConfig as { Mounts: Mount[]; NetworkMode: string; CapDrop: string[] };
    expect(mountFor(host, "/plugin")?.Type).toBe("volume");
    expect(mountFor(host, "/project")).toMatchObject({ Type: "bind", Source: workspaceDir });
    expect(mountFor(host, "/plugin")?.ReadOnly).toBe(true);
    // Project output must be writable; this does not require writable control files.
    expect(mountFor(host, "/project")?.ReadOnly).toBe(false);
    expect(mountFor(host, "/plugin-state")).toMatchObject({
      Type: "bind", Source: path.join(sessionDir, "plugin-data", "reqs", "state"),
    });
    expect(created.Entrypoint).toEqual(["/plugin/cli/index.mjs"]);
    expect(created.Cmd).toEqual(["list", "--json"]);
    expect(created.WorkingDir).toBe("/project");
    expect(host.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect((created.Labels as Record<string, string>)[PLUGIN_CLI_LABEL]).toBe("s1");
  });

  it("refuses to start when Docker implicitly created a plain overlay volume mid-window", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker({ vanishNamedVolumesOnCreate: true });

    const result = await runPluginCommand(deps(fake.docker), call);

    expect(result.error).toContain(OVERLAY_VERIFY_FAILURE);
    expect(result.exitCode).toBe(126);
    expect(fake.started).toEqual([]);
    expect(fake.containers).toHaveLength(1);
  });

  it("translates session paths onto the workspace volume in the production layout", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const stateRoot = path.dirname(sessionDir);
    const rel = path.basename(sessionDir);
    await runPluginCommand(
      deps(fake.docker, { workspaceVolume: "shipit-ws", stateRoot }),
      call,
    );

    const host = fake.containers[0]?.opts.HostConfig as { Mounts: Mount[] } | undefined;
    expect(host).toBeDefined();
    expect(mountFor(host!, "/project")).toMatchObject({
      Type: "volume", Source: "shipit-ws", VolumeOptions: { Subpath: `${rel}/workspace` },
    });
    expect(mountFor(host!, "/plugin-state")).toMatchObject({
      Type: "volume", Source: "shipit-ws",
      VolumeOptions: { Subpath: `${rel}/plugin-data/reqs/state` },
    });
    expect(mountFor(host!, "/plugin")?.Type).toBe("volume");
  });

  it("leaves no session path as a bind in the production layout, settings file included", async () => {
    declareConsumer();
    publishGeneration();
    const settings = path.join(sessionDir, "plugin-data", "reqs", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `{"root":"docs"}\n`);
    const fake = fakeDocker();

    const stateRoot = path.dirname(sessionDir);
    const rel = path.basename(sessionDir);
    await runPluginCommand(deps(fake.docker, { workspaceVolume: "shipit-ws", stateRoot }), call);

    const host = fake.containers[0].opts.HostConfig as { Mounts: Mount[] };
    expect(host.Mounts.map((m) => m.Type)).not.toContain("bind");
    expect(mountFor(host, "/plugin-settings.json")).toMatchObject({
      Type: "volume",
      Source: "shipit-ws",
      ReadOnly: true,
      VolumeOptions: { Subpath: `${rel}/plugin-data/reqs/settings.json` },
    });
  });

  it("translates a `repo: self` plugin tree too", async () => {
    declareConsumer(`
plugins:
  repos:
    - repo: self
      name: mine
  use:
    - plugin: requirements
      from: mine
      alias: reqs
exports:
  plugins:
    requirements:
      cli:
        reqs: cli/index.mjs
`);
    const fake = fakeDocker();

    const stateRoot = path.dirname(sessionDir);
    const rel = path.basename(sessionDir);
    const result = await runPluginCommand(
      deps(fake.docker, { workspaceVolume: "shipit-ws", stateRoot }),
      call,
    );

    expect(result.error).toBeUndefined();
    const host = fake.containers[0].opts.HostConfig as { Mounts: Mount[] };
    expect(mountFor(host, "/plugin")).toMatchObject({
      Type: "volume",
      Source: "shipit-ws",
      ReadOnly: false,
      VolumeOptions: { Subpath: `${rel}/workspace` },
    });
    expect(host.Mounts.map((m) => m.Type)).not.toContain("bind");
  });

  it("refuses rather than binding when a session path is outside the volume root", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(
      deps(fake.docker, { workspaceVolume: "shipit-ws", stateRoot: "/some/other/root" }),
      call,
    );

    expect(result.exitCode).toBe(126);
    expect(result.error).toContain("could not be mounted");
    expect(result.error).toContain("/project");
    expect(fake.containers).toHaveLength(0);
  });

  it("hands the plugin no ShipIt credential, worker URL, or inherited environment", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    const mounts = (fake.containers[0].opts.HostConfig as { Mounts: Mount[] }).Mounts;
    expect(mounts.some((m) => m.Source.includes("/credentials") || m.Target.includes("/credentials"))).toBe(false);
    for (const name of ["GITHUB_TOKEN", "WORKER_URL", "SHIPIT_AGENT_OPS_URL", "ORCHESTRATOR_URL", "PATH"]) {
      expect(env.some((e) => e.startsWith(`${name}=`))).toBe(false);
    }
    expect(env).toContain("SHIPIT_PROJECT_DIR=/project");
    expect(env).toContain("SHIPIT_PLUGIN_STATE=/plugin-state");
    expect(env).toContain(`SHIPIT_PLUGIN_COMMIT=${COMMIT}`);
  });

  it("injects only the credential names the plugin declared", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    expect(env).toContain("FAL_KEY=secret-value");
    expect(env.some((e) => e.startsWith("OTHER="))).toBe(false);
  });

  it("injects an optional credential the project has a value for", async () => {
    declareConsumer();
    publishGeneration(`
exports:
  plugins:
    requirements:
      cli:
        reqs: cli/index.mjs
      credentials: [{ name: FAL_KEY, optional: true }]
`);
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    expect(fake.containers[0].opts.Env as string[]).toContain("FAL_KEY=secret-value");
  });

  it("treats an empty stored value as missing, the same bar the card applies", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(
      deps(fake.docker, { secretStore: { loadSecrets: () => ({ FAL_KEY: "" }) } }),
      call,
    );

    expect((fake.containers[0].opts.Env as string[]).some((e) => e.startsWith("FAL_KEY"))).toBe(false);
  });

  it("omits a declared credential that has no stored value", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker, { secretStore: { loadSecrets: () => ({}) } }), call);

    const env = fake.containers[0].opts.Env as string[];
    expect(env.some((e) => e.startsWith("FAL_KEY"))).toBe(false);
  });

  it("mounts the validated settings file read-only when the import has one", async () => {
    declareConsumer();
    publishGeneration();
    const settings = path.join(sessionDir, "plugin-data", "reqs", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "{}\n");
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const host = fake.containers[0].opts.HostConfig as { Mounts: Mount[] };
    expect(mountFor(host, "/plugin-settings.json")).toMatchObject({
      Type: "bind", Source: settings, ReadOnly: true,
    });
    expect(fake.containers[0].opts.Env as string[]).toContain("SHIPIT_SETTINGS=/plugin-settings.json");
  });

  it("follows the target repository's `active` exactly once per invocation", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker({ stdout: "ok\n" });
    const activeLink = path.join(stateDir, "plugins", "tools", "active");

    const spy = vi.spyOn(fs, "realpathSync");
    const result = await runPluginCommand(deps(fake.docker), call);
    const follows = spy.mock.calls.filter(([p]) => String(p) === activeLink);
    spy.mockRestore();

    expect(result.error).toBeUndefined();
    expect(follows.length).toBe(1);
  });

  it("runs a `repo: self` import against the working tree, with no commit set", async () => {
    declareSelfUse();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), { alias: "probe", command: "probe", args: [] });

    expect(result.error).toBeUndefined();
    const created = fake.containers[0].opts;
    expect(mountFor(created.HostConfig as { Mounts: Mount[] }, "/plugin"))
      .toMatchObject({ Type: "bind", Source: workspaceDir });
    expect((created.Env as string[]).some((e) => e.startsWith("SHIPIT_PLUGIN_COMMIT"))).toBe(false);
  });

  it("leaves the image's toolchain paths alone under `repo: self`", async () => {
    declareSelfUse();
    const fake = fakeDocker();
    (fake.docker as unknown as Record<string, unknown>).getImage = () => ({
      inspect: async () => ({ Config: { Env: ["PATH=/usr/bin:/bin"] } }),
    });

    await runPluginCommand(deps(fake.docker), { alias: "probe", command: "probe", args: [] });

    const env = fake.containers[0].opts.Env as string[];
    for (const name of ["PLAYWRIGHT_BROWSERS_PATH=", "NPM_CONFIG_PREFIX=", "PATH="]) {
      expect(env.some((e) => e.startsWith(name))).toBe(false);
    }
    expect(env.join("\n")).not.toContain(PLUGIN_BROWSERS_DIR);
    expect(env).toContain("HOME=/tmp");
  });

  describe("the session's overlay dep dirs (docs/183)", () => {
    const overlayDepDirs = async (): Promise<{ depDir: string; volumeName: string }[]> => [
      { depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" },
    ];

    it("nests them under BOTH working-tree mounts of a `repo: self` import", async () => {
      declareSelfUse();
      const fake = fakeDocker();

      const result = await runPluginCommand(
        deps(fake.docker, { overlayDepDirs }),
        { alias: "probe", command: "probe", args: [] },
      );

      expect(result.error).toBeUndefined();
      const created = fake.containers[0].opts;
      const host = created.HostConfig as { Mounts: Mount[] };
      for (const target of ["/project/node_modules", "/plugin/node_modules"]) {
        expect(mountFor(host, target)).toMatchObject({
          Type: "volume",
          Source: "shipit-s1_overlay-aaaa",
        });
      }
      expectBoundaryHolds(created, [
        "/plugin", "/plugin/node_modules", "/plugin-state", "/project", "/project/node_modules",
      ]);
      expect(fake.connected).toEqual([]);
    });

    it("adds nothing for a tracked generation — its dependencies are its own", async () => {
      declareConsumer();
      publishGeneration();
      const fake = fakeDocker();

      await runPluginCommand(deps(fake.docker, { overlayDepDirs }), call);

      const host = fake.containers[0].opts.HostConfig as { Mounts: Mount[] };
      expect(mountFor(host, "/plugin/node_modules")).toBeUndefined();
      expect(mountFor(host, "/project/node_modules")).toBeUndefined();
    });

    it("degrades to the mounts it has always had when they cannot be resolved", async () => {
      declareSelfUse();
      const fake = fakeDocker({ stdout: "ok\n" });

      const result = await runPluginCommand(
        deps(fake.docker, { overlayDepDirs: () => Promise.reject(new Error("daemon down")) }),
        { alias: "probe", command: "probe", args: [] },
      );

      expect(result.error).toBeUndefined();
      expectBoundaryHolds(fake.containers[0].opts, ["/plugin", "/plugin-state", "/project"]);
    });
  });

  describe("when the daemon refuses to remove the container", () => {
    it("logs the failure and still returns the command's own exit code and output", async () => {
      declareConsumer();
      publishGeneration();
      const fake = fakeDocker({ exit: 3, stdout: "out\n", stderr: "err\n", removeError: "device or resource busy" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const result = await runPluginCommand(deps(fake.docker), call);

        expect(result.error).toBeUndefined();
        expect(result.exitCode).toBe(3);
        expect(result.stdout).toBe("out\n");
        expect(result.stderr).toBe("err\n");
        const line = warn.mock.calls.map((c) => c.join(" ")).find((c) => c.includes(fake.containers[0].id));
        expect(line).toBeDefined();
        expect(line).toContain("s1");
        expect(line).toContain("device or resource busy");
      } finally {
        warn.mockRestore();
      }
    });

    it("says nothing when the removal succeeds", async () => {
      declareConsumer();
      publishGeneration();
      const fake = fakeDocker({ stdout: "ok\n" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const result = await runPluginCommand(deps(fake.docker), call);

        expect(result.exitCode).toBe(0);
        expect(fake.removedContainers).toEqual([fake.containers[0].id]);
        // Exclude unrelated fixture warnings about chown and the image's missing PATH.
        expect(warn.mock.calls.map((c) => c.join(" ")).filter((c) => c.includes(fake.containers[0].id)))
          .toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("runPluginCommand — the fetch-authority boundary (req 19)", () => {
  it("mounts EXACTLY the in-session usage contract, and nothing else", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const created = fake.containers[0].opts;
    const host = created.HostConfig as { Mounts: Mount[] };
    expectBoundaryHolds(created, ["/plugin", "/plugin-state", "/project"]);
    expect(fake.connected).toEqual([]);
    // Git config token checks live in repo-git.test.ts and startup-tasks.test.ts.
    expect(mountFor(host, "/project")?.Source).toBe(workspaceDir);
  });

  it("holds the same boundary when the overlay dep dirs are offered to a tracked import", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(
      deps(fake.docker, {
        overlayDepDirs: () => Promise.resolve([
          { depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" },
        ]),
      }),
      call,
    );

    expectBoundaryHolds(fake.containers[0].opts, ["/plugin", "/plugin-state", "/project"]);
    expect(fake.connected).toEqual([]);
  });

  it("holds the same boundary on the settings branch", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    declareConsumer();
    publishGeneration();
    const settings = path.join(sessionDir, "plugin-data", "reqs", "settings.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, "{}\n");
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    expectBoundaryHolds(fake.containers[0].opts, [
      "/plugin", "/plugin-settings.json", "/plugin-state", "/project",
    ]);
    expect(fake.connected).toEqual([]);
  });

  it("holds the same boundary on the `repo: self` branch", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    declareSelfUse();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), { alias: "probe", command: "probe", args: [] });

    expectBoundaryHolds(fake.containers[0].opts, ["/plugin", "/plugin-state", "/project"]);
    expect(fake.connected).toEqual([]);
  });

  it("carries no ShipIt credential, and nothing from the orchestrator's own environment", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    vi.stubEnv("GH_TOKEN", "gh-should-never-be-inherited");
    vi.stubEnv("SHIPIT_AGENT_OPS_URL", "http://127.0.0.1:9100");
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    // Submitted variables only: Docker also inherits the image's ENV.
    expect([...env].sort()).toEqual([
      "AGENT_HOME=/tmp",
      "FAL_KEY=secret-value",
      "HOME=/tmp",
      `NPM_CONFIG_PREFIX=${PLUGIN_NPM_PREFIX_DIR}`,
      `PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`,
      `SHIPIT_PLUGIN_COMMIT=${COMMIT}`,
      "SHIPIT_PLUGIN_STATE=/plugin-state",
      "SHIPIT_PROJECT_DIR=/project",
      "npm_config_update_notifier=false",
    ]);
    expect(env.join("\n")).not.toContain("should-never-be-inherited");
    expect(env.some((e) => e.startsWith("WORKER_PORT="))).toBe(false);
  });

  it("resolves the toolchain paths to the same overlay directories install wrote", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();
    (fake.docker as unknown as Record<string, unknown>).getImage = () => ({
      inspect: async () => ({
        Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers"] },
      }),
    });

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    expect(env).toContain(`PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`);
    expect(env).toContain(`NPM_CONFIG_PREFIX=${PLUGIN_NPM_PREFIX_DIR}`);
    for (const dir of [PLUGIN_BROWSERS_DIR, PLUGIN_NPM_PREFIX_DIR]) {
      expect(dir.startsWith("/plugin/")).toBe(true);
    }
    expect(env.join("\n")).not.toContain("/opt/playwright-browsers");
    expect(env).toContain(`PATH=${PLUGIN_NPM_PREFIX_DIR}/bin:/usr/local/bin:/usr/bin:/bin`);
  });

  it("keeps its own network namespace, where the worker's token broker does not listen", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker, { egress: () => UNCONTAINED_PLUGIN_EGRESS }), call);

    const host = fake.containers[0].opts.HostConfig as {
      NetworkMode: string;
      ExtraHosts?: string[];
      Privileged?: boolean;
      CapAdd?: string[];
    };
    expect(host.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(host.NetworkMode).not.toBe("host");
    expect(host.NetworkMode.startsWith("container:")).toBe(false);
    expect(host.ExtraHosts ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
    expect(host.CapAdd ?? []).toEqual([]);
  });

  it("joins a ShipIt-owned holder on the plugin network when the session is contained", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(
      deps(fake.docker, { egress: () => CONTAINED_EGRESS }),
      call,
    );

    expect(result.error).toBeUndefined();
    const [holder, workload] = fake.containers;
    expect((workload.opts.HostConfig as { NetworkMode: string }).NetworkMode)
      .toBe(`container:${holder.id}`);
    const holderHost = holder.opts.HostConfig as Record<string, unknown>;
    expect(holderHost.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(holderHost.Mounts ?? []).toEqual([]);
    expect(holderHost.Binds ?? []).toEqual([]);
    expect(holder.opts.Env ?? []).toEqual([]);
    expectBoundaryHolds(
      workload.opts, ["/plugin", "/project", "/plugin-state"], `container:${holder.id}`,
    );
  });

  it("refuses to run a contained session's CLI when containment cannot be installed", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(
      deps(fake.docker, { egress: () => ({ ...CONTAINED_EGRESS, sidecarImage: undefined }) }),
      call,
    );

    expect(result.exitCode).toBe(126);
    expect(result.error).toContain("network policy could not be applied");
    expect(fake.containers).toHaveLength(0);
  });

  it("denies its own subnet at ShipIt's API before the container is created", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    expect(isUntrustedContainerIp(CLI_SUBNET_ADDRESS)).toBe(false);
    await runPluginCommand(deps(fake.docker), call);

    expect(fake.networks).toEqual([PLUGIN_CLI_NETWORK]);
    expect(fake.containers[0].deniedAtCreate).toBe(true);
    expect(isUntrustedContainerIp(CLI_SUBNET_ADDRESS)).toBe(true);
    expect(isUntrustedContainerIp(SESSION_BRIDGE_ADDRESS)).toBe(false);
  });

  it("refuses to run on a network whose second subnet cannot be denied", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();
    (fake.docker as unknown as { getNetwork: (n: string) => unknown }).getNetwork = () => ({
      inspect: async () => ({
        IPAM: { Config: [{ Subnet: "172.29.0.0/16" }, { Subnet: "fd00:dead:beef::/64" }] },
      }),
    });

    const result = await runPluginCommand(deps(fake.docker), call);
    expect(result.error).toContain("plugin network could not be prepared");
    expect(fake.containers).toHaveLength(0);
  });
});

describe("runPluginCommand — what it refuses", () => {
  it("refuses an alias the project does not import", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), { ...call, alias: "ghost" });
    expect(result.error).toContain("is not a plugin this project imports");
    expect(fake.containers).toHaveLength(0);
  });

  it("refuses when the repository has no active generation yet", async () => {
    declareConsumer();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), call);
    expect(result.error).toContain("has no active version in this session yet");
    expect(fake.containers).toHaveLength(0);
  });

  it("refuses to run a generation built from a repository the declaration no longer names", async () => {
    declareConsumer();
    publishGeneration(MANIFEST, "acme/previous");
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), call);

    expect(result.error).toContain("has no active version in this session yet");
    expect(fake.containers).toHaveLength(0);
  });

  it("re-checks the collision at the run boundary and refuses", async () => {
    declareConsumer(`
plugins:
  repos:
    - repo: acme/tools
      name: tools
    - repo: self
      name: here
  use:
    - plugin: requirements
      from: tools
      alias: reqs
    - plugin: rival
      from: here
      alias: rival
exports:
  plugins:
    rival:
      cli:
        reqs: other/cli
`);
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), call);
    expect(result.error).toContain("claimed by more than one plugin");
    expect(result.exitCode).not.toBe(0);
    expect(fake.containers).toHaveLength(0);
  });

  it("refuses a command the live manifest does not export", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), { ...call, command: "gone" });
    expect(result.error).toContain("is not a command");
    expect(fake.containers).toHaveLength(0);
  });

  it("refuses when its network cannot be declared untrusted", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();
    (fake.docker as unknown as { getNetwork: (n: string) => unknown }).getNetwork = () => ({
      inspect: async () => ({ IPAM: { Config: [] } }),
    });

    const result = await runPluginCommand(deps(fake.docker), call);
    expect(result.error).toContain("plugin network could not be prepared");
    expect(fake.containers).toHaveLength(0);
  });
});

describe("mapWorkingDir", () => {
  it("carries a cwd inside the workspace across to /project", () => {
    fs.mkdirSync(path.join(workspaceDir, "docs", "sub"), { recursive: true });
    expect(mapWorkingDir(workspaceDir, "/workspace/docs/sub")).toBe("/project/docs/sub");
  });

  it("falls back to the project root for anything else", () => {
    expect(mapWorkingDir(workspaceDir, "/workspace/absent")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, "/tmp")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, "/workspace/../etc")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, undefined)).toBe("/project");
  });
});

describe("runPluginCommand — the consumer lease", () => {
  const GENERATION = { sessionId: "s1", repoName: "tools", generationId: COMMIT };

  afterEach(() => releaseSessionGenerationHolds("s1"));

  it("holds the generation for the whole call and lets go at the end", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker({ stdout: "ok\n" });
    let heldDuringRun = -1;
    const docker = {
      ...(fake.docker as unknown as Record<string, unknown>),
      createContainer: async (opts: Record<string, unknown>) => {
        heldDuringRun = generationHoldCount(GENERATION);
        return (fake.docker as unknown as {
          createContainer: (o: Record<string, unknown>) => Promise<unknown>;
        }).createContainer(opts);
      },
    } as unknown as Docker;

    const result = await runPluginCommand(deps(docker), call);

    expect(result.exitCode).toBe(0);
    expect(heldDuringRun).toBe(1);
    expect(generationHoldCount(GENERATION)).toBe(0);
  });

  it("lets go on a refusal too — the lease has one exit, not one per branch", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), { ...call, command: "nope" });

    expect(result.error).toBeTruthy();
    expect(fake.containers).toHaveLength(0);
    expect(generationHoldCount(GENERATION)).toBe(0);
  });

  it("refuses to run a generation that is being pruned right now", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();
    const done = claimGenerationDeletion(GENERATION)!;
    try {
      const result = await runPluginCommand(deps(fake.docker), call);
      expect(result.error).toContain("replaced mid-call");
      expect(fake.containers).toHaveLength(0);
    } finally {
      done();
    }
  });
});
