/**
 * docs/262 reqs 17, 20, 23 — the companion-CLI invocation container.
 *
 * The assertions that matter are boundary assertions. A companion CLI is
 * third-party code the agent invokes by name, so what this container does NOT
 * hold is as load-bearing as what it does: no `/credentials`, no worker URL, no
 * inherited environment, no session network, and none of the consuming
 * project's secrets beyond the names the plugin declared.
 */

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
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";
import {
  claimGenerationDeletion,
  generationHoldCount,
  releaseSessionGenerationHolds,
} from "./plugin-leases.js";
import { UNCONTAINED_PLUGIN_EGRESS, type PluginEgressPolicy } from "./plugin-egress.js";

// docs/262 req 24 — the tier launchers shell out to a privileged sidecar on a
// live host and `buildTierAEgressInputs` fetches GitHub's meta endpoint, so the
// contained branch below stubs them at the same seam
// `compose-service-egress.test.ts` does. Everything from `runPluginCommand` down
// to the namespace decision is the production path; what these stub is the
// privileged work the namespace decision leads to.
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

/** A contained session's posture, as `ContainerSessionManager` would report it. */
const CONTAINED_EGRESS: PluginEgressPolicy = {
  contained: true,
  config: { contained: true, extraHosts: [] },
  sidecarImage: "egress-sidecar:test",
  dnsEnabled: true,
  proxyEnabled: true,
};

const COMMIT = "d".repeat(40);

/** An address inside the subnet the fake daemon reports for the CLI network. */
const CLI_SUBNET_ADDRESS = "172.29.0.7";
/** A session container's own bridge address — a different network entirely. */
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

/** req 27 — the repository consuming its OWN export: no generation, no commit,
 * and the working tree as the plugin's tree. `probe`/`probe` throughout. */
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

/**
 * Publish a live generation of `tools`, the way activation would — including
 * `source`. A real activation always records it, and this path REFUSES a
 * generation whose source it cannot match: the pinned directory is what the
 * invocation container mounts and executes, so an unprovable tree is not one to
 * run. `source` is therefore part of the fixture, not decoration.
 */
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
  /** The daemon's id, so a `container:<holder>` namespace can be traced to one. */
  id: string;
  opts: Record<string, unknown>;
  /**
   * Whether this container's own subnet was already denied at ShipIt's API when
   * the daemon was asked to create it. Recorded at creation rather than checked
   * afterwards because the ordering IS the control: an address registered once
   * the container is running leaves its first request — the one worth making —
   * unguarded.
   */
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

function fakeDocker(opts: { exit?: number; stdout?: string; stderr?: string } = {}) {
  const containers: Created[] = [];
  // The workspace volume already exists in production; the overlay's daemon-path
  // translation inspects it for its mountpoint.
  const volumes = new Set<string>(["shipit-ws"]);
  const networks: string[] = [];
  const connected: unknown[] = [];
  const notFound = (): never => {
    throw Object.assign(new Error("no such thing"), { statusCode: 404 });
  };

  const docker = {
    modem: {
      // The real modem splits Docker's framed stream; the fake just delivers
      // what the test scripted onto the two sinks.
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
      // Recorded, never stubbed away: attaching a running container to a second
      // network is a real pattern in this codebase (`service-manager-setup.ts`),
      // and it is invisible to every create-time assertion below.
      connect: async (spec: unknown) => { connected.push(spec); },
    }),
    createNetwork: async (spec: { Name: string }) => { networks.push(spec.Name); },
    createVolume: async (spec: { Name: string }) => { volumes.add(spec.Name); },
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) notFound();
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
      },
      remove: async () => { volumes.delete(name); },
    }),
    listContainers: async () => [],
    getContainer: (_id: string) => ({ remove: async () => undefined }),
    createContainer: async (createOpts: Record<string, unknown>) => {
      containers.push({
        id: `c-${containers.length + 1}`,
        opts: createOpts,
        deniedAtCreate: isUntrustedContainerIp(CLI_SUBNET_ADDRESS),
      });
      return {
        id: `c-${containers.length}`,
        attach: async () => {
          // Flowing, so `end()` actually reaches `end`/`close` — the real
          // hijacked stream is consumed by dockerode's demuxer.
          const s = new PassThrough();
          s.resume();
          return s;
        },
        start: async () => undefined,
        wait: async () => ({ StatusCode: opts.exit ?? 0 }),
        kill: async () => undefined,
        remove: async () => undefined,
      };
    },
  };
  return { docker: docker as unknown as Docker, containers, networks, volumes, connected };
}

/**
 * The req-19 properties that must hold on EVERY branch of `runPluginCommand`,
 * not just the one the main fixture takes.
 *
 * Written as a helper because the branches are where a boundary erodes: a
 * credential mount or a broker variable added inside the settings branch or the
 * `repo: self` branch would evade an assertion made once, on the pinned
 * no-settings path (review finding).
 */
function expectBoundaryHolds(
  created: Record<string, unknown>,
  expectedTargets: string[],
  /**
   * The namespace this container may run in. Defaults to the plugin network —
   * an uncontained session, and every branch below except the contained one. A
   * PARAMETER rather than a fixed value because req 24 made a second correct
   * answer possible (`container:<holder>`), and the wrong one — a session
   * container's namespace — is neither: see the contained test for why.
   */
  expectedNetworkMode: string = PLUGIN_CLI_NETWORK,
): void {
  const host = created.HostConfig as {
    Mounts: Mount[];
    Binds?: string[];
    VolumesFrom?: string[];
    NetworkMode: string;
  };
  expect(host.Mounts.map((m) => m.Target).sort()).toEqual([...expectedTargets].sort());
  // `Mounts` is not the only way to hand a container a filesystem, and an
  // exhaustive claim about one field is not exhaustive if a sibling field can
  // carry the rest. `Binds` is the older spelling of the same thing (the
  // install container uses it), and `VolumesFrom` copies ANOTHER container's
  // mounts wholesale — pointed at the session container that would be
  // `/credentials`, in one line, with the mount assertion still green.
  expect(host.Binds ?? []).toEqual([]);
  expect(host.VolumesFrom ?? []).toEqual([]);
  // Nor a second network beside `NetworkMode`: a container attached to the
  // session's bridge as well would reach ShipIt's API from an address in no
  // registered untrusted subnet, which the guard reads as a browser caller.
  expect(created.NetworkingConfig).toBeUndefined();
  expect(host.NetworkMode).toBe(expectedNetworkMode);
  for (const m of host.Mounts) {
    expect(`${m.Source} ${m.Target}`).not.toMatch(/credential/i);
  }
  // No ShipIt credential, no worker URL, no port that aims the brokering git
  // helper at anything, and nothing inherited from this process.
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
    // reqs 7, 15 — a generation is read-only to everything that runs at
    // runtime, and the answer does not depend on which surface asks: a plugin
    // SERVICE attaches this very volume read-only (`plugin-compose.ts`). This
    // mount was read-write until the two surfaces were reconciled, which let a
    // command copy-up into the generation's layer and change the code its own
    // services ran, for the rest of the session, under a SHIPIT_PLUGIN_COMMIT
    // that no longer described it. `install` is the one writer, and it runs
    // before publication.
    expect(mountFor(host, "/plugin")?.ReadOnly).toBe(true);
    expect(mountFor(host, "/plugin-state")).toMatchObject({
      Type: "bind", Source: path.join(sessionDir, "plugin-data", "reqs", "state"),
    });
    // The plugin's own entrypoint, resolved inside its own tree — and its args
    // handed over untouched.
    expect(created.Entrypoint).toEqual(["/plugin/cli/index.mjs"]);
    expect(created.Cmd).toEqual(["list", "--json"]);
    expect(created.WorkingDir).toBe("/project");
    expect(host.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect((created.Labels as Record<string, string>)[PLUGIN_CLI_LABEL]).toBe("s1");
  });

  // The defect a review found: the orchestrator sees a session under its own
  // `/workspace/...`, which in production lives INSIDE a named volume the
  // daemon knows nothing about. Handing those paths over as bind sources
  // creates empty, root-owned directories — `/project` would not be the project
  // and `/plugin-state` would not be the state a plugin service writes to.
  it("translates session paths onto the workspace volume in the production layout", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    // `stateRoot` is the orchestrator-visible root of the named volume; the
    // temp session tree stands in for a session under it.
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
    // The plugin's own tree is a NAMED volume either way — a name needs no
    // translation, which is why `install`'s single mount could be a bind.
    expect(mountFor(host!, "/plugin")?.Type).toBe("volume");
  });

  // The sweeping form of the assertion above, and the one that catches a mount
  // added later: in the production layout NOTHING may be a bind. A bind here
  // does not fail — it starts a container in which the path exists and is
  // empty, which is the whole reason this defect survived dev and dogfood.
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
    // req 26 — mounted AS A FILE, which the daemon supports (it stats the
    // resolved path and binds a file as a file). Its parent is the plugin's
    // writable state directory, so mounting that instead would hand the plugin
    // its own settings to rewrite.
    expect(mountFor(host, "/plugin-settings.json")).toMatchObject({
      Type: "volume",
      Source: "shipit-ws",
      ReadOnly: true,
      VolumeOptions: { Subpath: `${rel}/plugin-data/reqs/settings.json` },
    });
  });

  // req 27 — a `repo: self` import's `/plugin` IS the session's working tree, so
  // it is the one plugin-tree mount that is a session path rather than a named
  // volume, and the one that needs the same translation.
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
      // Read-WRITE: under `repo: self` the plugin is deliberately live and
      // editable, which is req 27's whole point — and it is the same tree this
      // container already has read-write at `/project`, so the plugin service
      // that mounts it gets the same rights (`plugin-compose.ts`).
      ReadOnly: false,
      VolumeOptions: { Subpath: `${rel}/workspace` },
    });
    expect(host.Mounts.map((m) => m.Type)).not.toContain("bind");
  });

  // Fail closed. With a volume runtime there is no bind to degrade to: one would
  // start the command against an empty `/project` and a `/plugin-state` nothing
  // else writes to, and report success. Refusing is the only honest answer.
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

  // req 19 — the whole reason a companion CLI does not run in the agent
  // container. This is the assertion that keeps it true.
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
    // req 15 — the running commit, readable by the plugin itself.
    expect(env).toContain(`SHIPIT_PLUGIN_COMMIT=${COMMIT}`);
  });

  // req 23 — the plugin's DECLARED names, from the consuming project's store,
  // and nothing else that happens to be in it.
  it("injects only the credential names the plugin declared", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    expect(env).toContain("FAL_KEY=secret-value");
    expect(env.some((e) => e.startsWith("OTHER="))).toBe(false);
  });

  // req 23's last sentence, as an assertion: a plugin's store can never resolve
  // ShipIt's own platform credentials. The dep is typed as `loadSecrets` alone,
  // and satisfaction is decided by the credential slice's single definition —
  // so an empty stored value is "missing" here exactly as it is on the card.
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

  // A missing key must stay a named gap on the Plugins tab, not an empty
  // string that surfaces as a third-party authentication error.
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

  // req 27 — there the plugin IS the working tree, live and editable, and
  // there is no commit for it to correspond to.
  // The skew this whole path exists to prevent needs the target's `active`
  // followed ONCE — `pinGeneration` names the volume, the lowerdir and the
  // entrypoint out of that one answer. A review found the collision verdict's
  // lookup following it a second time for a manifest it then discarded.
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

  /**
   * nikzlabs/shipit#2298 — on an overlay-backed session the clone's dep dirs are
   * empty mount points and the content lives only in the per-session overlay
   * volumes. An invocation container attached none, so `/project` — and, under
   * `repo: self`, `/plugin` with it — held an empty `node_modules` and no entry
   * point could load a dependency the working tree plainly has.
   */
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
      // req 19 — the branch that ADDS mounts is exactly the branch where an
      // exhaustive claim earns its keep, and the two exhaustive tests below
      // cover self-without-overlays and tracked-with-overlays but not this
      // combination (independent review, this branch).
      expectBoundaryHolds(created, [
        "/plugin", "/plugin/node_modules", "/plugin-state", "/project", "/project/node_modules",
      ]);
      expect(fake.connected).toEqual([]);
    });

    // The gate is the reason: a tracked service starts with
    // `dependsOnInstall: false` because its dependencies are its own, so handing
    // it the project's `node_modules` would let it read them while
    // `agent.install` writes them. One rule for both surfaces — see
    // `compose-generator.ts`'s `overlayMountsForPluginService`.
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
      // On the SELF branch, because that is where degrading actually costs
      // something: it restores the empty `node_modules` this feature exists to
      // fix. Asserted deliberately rather than left to the tracked path, where
      // the branch does nothing either way.
      declareSelfUse();
      const fake = fakeDocker({ stdout: "ok\n" });

      const result = await runPluginCommand(
        deps(fake.docker, { overlayDepDirs: () => Promise.reject(new Error("daemon down")) }),
        { alias: "probe", command: "probe", args: [] },
      );

      // A refusal here would withhold every companion CLI in the session,
      // including the many with no dependencies at all, over a daemon hiccup.
      expect(result.error).toBeUndefined();
      expectBoundaryHolds(fake.containers[0].opts, ["/plugin", "/plugin-state", "/project"]);
    });
  });
});

/**
 * docs/262 req 19, the fetch-authority half: "credentials used to fetch
 * repositories are never exposed to plugin code".
 *
 * The tests above assert the container ShipIt MEANT to build. These assert the
 * complement — that it holds nothing else — because that is the half a later
 * change breaks by addition rather than by edit. Each one is written as an
 * exhaustive claim (the whole mount list, the whole environment) rather than a
 * denylist of today's known-bad names: a denylist passes a mount nobody thought
 * to forbid, which is precisely how the withdrawn PR #2202 shipped an install
 * container that could read `/credentials`.
 */
describe("runPluginCommand — the fetch-authority boundary (req 19)", () => {
  it("mounts EXACTLY the in-session usage contract, and nothing else", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const created = fake.containers[0].opts;
    const host = created.HostConfig as { Mounts: Mount[] };
    expectBoundaryHolds(created, ["/plugin", "/plugin-state", "/project"]);
    // …and it is never attached to a second network after the fact, which no
    // create-time field would record.
    expect(fake.connected).toEqual([]);
    // `/project` IS the workspace, so it necessarily carries `.git`.
    //
    // **Half of that was safe and half of it was an open req-19 gap, and the
    // difference was worth checking rather than asserting.** The repo-local
    // `credential.helper` is safe: `github-auth.ts` writes
    // `CONTAINER_CREDENTIAL_HELPER`, a PATH to a broker (`git-config.ts` —
    // "this file NEVER contains the token"), and that broker answers only over
    // the session worker's loopback, which the next test shows this container
    // does not share. `remote.origin.url` was NOT: `addRepo`
    // (`services/repos.ts`) trimmed and expanded shorthand but never called
    // `stripUrlCredentials`, `RepoStore.add` persisted the string verbatim, and
    // `RepoGit.cloneFromCache` ran `git remote set-url origin <that string>`
    // — so a repository added as
    // `https://x-access-token:<pat>@github.com/o/r.git` put a live token in
    // this container's `/project/.git/config`, where no mount, environment or
    // network assertion in this file can see it. Found by an independent
    // review of this branch, and CLOSED under req 19's own rule — a credential a
    // user types into a repository URL is not kept, and fetches are credentialed
    // by a helper scoped to that remote. It is stripped where a repository is
    // added and at every write of a remote URL, with the recorded cost that a
    // remote whose only working auth is that URL stops working on the helper
    // path. The guard lives where the file is written,
    // not here — `repo-git.test.ts` → "no credential is recorded in a git
    // config", plus the legacy sweep in `startup-tasks.test.ts`.
    expect(mountFor(host, "/project")?.Source).toBe(workspaceDir);
  });

  // The two branches the fixture above does not take. A boundary erodes at a
  // branch: a credential mount added "just for settings", or a broker variable
  // added "just for self-use", would pass every assertion made once on the
  // pinned no-settings path (review finding).
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

    // Unchanged, because a tracked import takes none of them — and stated as an
    // EXHAUSTIVE list rather than an absent-mount check, since a dep dir is a
    // directory name out of a repository's own `shipit.yaml` (`..` is refused
    // where it is parsed, `normalizeLiteralRelPath`, and this is what would
    // notice if that stopped being true).
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
    // The failure this rules out is a one-word one: `...process.env` in the Env
    // array. The orchestrator process holds the fetch token these values stand
    // in for, so a leak is req 19's exact violation.
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    vi.stubEnv("GH_TOKEN", "gh-should-never-be-inherited");
    vi.stubEnv("SHIPIT_AGENT_OPS_URL", "http://127.0.0.1:9100");
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    // Everything ShipIt SUBMITS, exactly: the contract's three names (settings
    // is absent — this import has no settings file), the two hygiene settings,
    // and the one credential name the plugin declared.
    //
    // Not the container's *effective* environment, and the distinction is not
    // pedantic (review finding): Docker merges this array with the image's own
    // `ENV`, and the image here is the session-worker image, which already
    // supplies `PATH` and `AGENT_HOME`. An `ENV GITHUB_TOKEN=…` added to that
    // Dockerfile would reach plugin code with this assertion still green. That
    // is the image's contract to hold, not this call's — but it IS a second
    // surface, and nothing in this file guards it.
    expect([...env].sort()).toEqual([
      "FAL_KEY=secret-value",
      "HOME=/tmp",
      `SHIPIT_PLUGIN_COMMIT=${COMMIT}`,
      "SHIPIT_PLUGIN_STATE=/plugin-state",
      "SHIPIT_PROJECT_DIR=/project",
      "npm_config_update_notifier=false",
    ]);
    expect(env.join("\n")).not.toContain("should-never-be-inherited");
    // `WORKER_PORT` matters as much as an explicit URL: the brokering credential
    // helper falls back to `http://127.0.0.1:${WORKER_PORT|9100}`, so an
    // inherited port would aim it at whatever answers on this container's own
    // loopback rather than merely being inert.
    expect(env.some((e) => e.startsWith("WORKER_PORT="))).toBe(false);
  });

  /**
   * The non-obvious one, and the reason the env assertion above is not enough.
   *
   * This container runs the SESSION WORKER IMAGE for its toolchain, so
   * `/usr/local/bin/shipit-git-credential` is present in it, and `/project`'s
   * git config names that helper. The helper needs no token and no URL: it
   * POSTs to `http://127.0.0.1:9100/agent-ops/git/credential`, unauthenticated,
   * and the worker brokers a real GitHub token back. What makes that harmless
   * here is ONLY that `127.0.0.1` is this container's own loopback. A
   * `NetworkMode` of `host` or `container:<session>` would share the worker's
   * network namespace and turn `git -C /project fetch` into a token read — with
   * no mount and no environment variable changed, so nothing else in this file
   * would notice.
   */
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
    // Spelled out as well as pinned, because the namespace-sharing modes are
    // what the assertion above is really for, and a future change that renames
    // the network must not read as permission to use one of them.
    expect(host.NetworkMode).not.toBe("host");
    expect(host.NetworkMode.startsWith("container:")).toBe(false);
    // Nor a hand-written route back to the host, where ShipIt's own API is
    // published — the IP guard denies it, but a second lock costs nothing.
    expect(host.ExtraHosts ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
    expect(host.CapAdd ?? []).toEqual([]);
  });

  /**
   * docs/262 req 24 — and the reason the assertion above is stated as "not a
   * SESSION container's namespace" rather than "not a `container:` mode at all".
   *
   * A contained session's companion CLI DOES run in a shared namespace now, so
   * that it reaches exactly what the agent reaches. What makes that safe is
   * WHOSE namespace: a holder ShipIt created for this call, on the same
   * untrusted plugin network, running nothing. The session's container is on the
   * session bridge and serves `/agent-ops/*` on its loopback, so joining it
   * instead would turn `git -C /project fetch` into a token read — with the
   * mount and environment assertions in this file still green.
   */
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
    // The holder is created FIRST and is the namespace the workload joins.
    expect((workload.opts.HostConfig as { NetworkMode: string }).NetworkMode)
      .toBe(`container:${holder.id}`);
    // …and the holder itself is on the untrusted plugin network, holding
    // nothing: no repository code, no mounts, no environment. Everything it can
    // reach, plugin code can reach.
    const holderHost = holder.opts.HostConfig as Record<string, unknown>;
    expect(holderHost.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(holderHost.Mounts ?? []).toEqual([]);
    expect(holderHost.Binds ?? []).toEqual([]);
    expect(holder.opts.Env ?? []).toEqual([]);
    // The workload's own boundary is unchanged by any of this — it did not
    // acquire a mount or a capability along with a namespace.
    expectBoundaryHolds(
      workload.opts, ["/plugin", "/project", "/plugin-state"], `container:${holder.id}`,
    );
  });

  // Fail closed, and at the surface: a contained session whose deployment cannot
  // install containment gets a refusal, not a plugin container with unrestricted
  // egress. Nothing is created — not even the holder, since the missing image is
  // what would have contained it.
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

  /**
   * The ordering is the control, not a detail. `api-container-guard.ts` reads an
   * unrecognised source IP as a trusted browser/host caller, so between "the
   * container can send a packet" and "its subnet is registered" it is MORE
   * privileged at ShipIt's API than the agent container it is isolated from —
   * and `/api/sessions/<id>/git/credential` is one request. `plugin-install.ts`
   * carries the same assertion; this is the CLI surface's copy of it, because
   * the two register different networks and neither implies the other.
   */
  it("denies its own subnet at ShipIt's API before the container is created", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    expect(isUntrustedContainerIp(CLI_SUBNET_ADDRESS)).toBe(false);
    await runPluginCommand(deps(fake.docker), call);

    expect(fake.networks).toEqual([PLUGIN_CLI_NETWORK]);
    expect(fake.containers[0].deniedAtCreate).toBe(true);
    expect(isUntrustedContainerIp(CLI_SUBNET_ADDRESS)).toBe(true);
    // Scoped to this network: a session container's own bridge address keeps
    // the treatment the guard's own layers give it.
    expect(isUntrustedContainerIp(SESSION_BRIDGE_ADDRESS)).toBe(false);
  });

  // The dual-stack hole, at the surface that has to survive it: an IPv6 subnet
  // is one the IPv4-only guard cannot deny, so the container must not start.
  // Without this, the run proceeds and the plugin reaches ShipIt's API over
  // IPv6 as an unrecognised — therefore trusted — caller.
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

  /**
   * The identity check lives in the readers that follow the `active` symlink
   * themselves. This path resolves the link ITSELF and then reads through the
   * directory-scoped readers, which carry no check by design — so without its
   * own comparison it opts out by construction, and no compiler sweep over
   * those wrappers can find it. It is also the worst place to miss: the pinned
   * directory is what the container mounts, so it feeds the entrypoint, the
   * lowerdir, the volume name and `SHIPIT_PLUGIN_COMMIT`. Between a `repos:`
   * entry being re-pointed and the activation round that republishes it,
   * `active` still resolves to the PREVIOUS repository's tree.
   */
  it("refuses to run a generation built from a repository the declaration no longer names", async () => {
    declareConsumer();
    publishGeneration(MANIFEST, "acme/previous");
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), call);

    expect(result.error).toContain("has no active version in this session yet");
    // Nothing was mounted, and nothing ran.
    expect(fake.containers).toHaveLength(0);
  });

  // req 20 — the wrapper is a file, and the declaration can change under it.
  // "Reports the collision before running the ambiguous one" has to hold here,
  // not only where the wrapper was written.
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

  // Fail closed: a container ShipIt cannot deny at its own API is not one to
  // start (`plugin-container.ts`).
  it("refuses when its network cannot be declared untrusted", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();
    // A network with no IPv4 subnet — the guard's CIDR match is IPv4-only.
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
    // Docker CREATES a missing WorkingDir, so a path that does not exist would
    // otherwise write a stray directory into the user's repository.
    expect(mapWorkingDir(workspaceDir, "/workspace/absent")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, "/tmp")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, "/workspace/../etc")).toBe("/project");
    expect(mapWorkingDir(workspaceDir, undefined)).toBe("/project");
  });
});

/**
 * docs/262 req 15 — the consumer lease (`plugin-leases.ts`).
 *
 * An invocation container mounts the generation's overlay volume, whose lowerdir
 * is the checkout on disk. A refresh landing mid-command used to prune that
 * checkout, and docs/183's spike records what that does to a live overlay:
 * merged `readdir` comes back empty while path lookups still resolve, so the
 * command misbehaves instead of failing. The lease is the same one a plugin
 * service takes — one mechanism, because both surfaces attach one volume per
 * generation.
 */
describe("runPluginCommand — the consumer lease", () => {
  const GENERATION = { sessionId: "s1", repoName: "tools", commit: COMMIT };

  afterEach(() => releaseSessionGenerationHolds("s1"));

  it("holds the generation for the whole call and lets go at the end", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker({ stdout: "ok\n" });
    // Observed at container-creation time, which is inside the call and after
    // the volume has been ensured — the exact window a prune must not win.
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
    // A publish has superseded this commit and its prune has the tree claimed:
    // `active` still resolved to it a moment ago, and the directory is going
    // away. Mounting it now is the corruption case, so the answer is "run it
    // again", not a container.
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
