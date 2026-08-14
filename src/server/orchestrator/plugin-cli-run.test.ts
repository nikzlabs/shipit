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
    createContainer: async (createOpts: Record<string, unknown>) => {
      containers.push({
        opts: createOpts,
        deniedAtCreate: isUntrustedContainerIp(CLI_SUBNET_ADDRESS),
      });
      return {
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
  return { docker: docker as unknown as Docker, containers, networks, volumes };
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
  it("runs a `repo: self` import against the working tree, with no commit set", async () => {
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
    const fake = fakeDocker();

    const result = await runPluginCommand(deps(fake.docker), { alias: "probe", command: "probe", args: [] });

    expect(result.error).toBeUndefined();
    const created = fake.containers[0].opts;
    expect(mountFor(created.HostConfig as { Mounts: Mount[] }, "/plugin"))
      .toMatchObject({ Type: "bind", Source: workspaceDir });
    expect((created.Env as string[]).some((e) => e.startsWith("SHIPIT_PLUGIN_COMMIT"))).toBe(false);
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
    const host = created.HostConfig as {
      Mounts: Mount[];
      Binds?: string[];
      VolumesFrom?: string[];
    };
    const mounts = host.Mounts;
    expect(mounts.map((m) => m.Target).sort()).toEqual(["/plugin", "/plugin-state", "/project"]);
    // `Mounts` is not the only way to hand a container a filesystem, and an
    // exhaustive claim about one field is not exhaustive if a sibling field can
    // carry the rest. `Binds` is the older spelling of the same thing (the
    // install container uses it), and `VolumesFrom` copies ANOTHER container's
    // mounts wholesale — pointed at the session container that would be
    // `/credentials`, in one line, with this file's mount assertion still green.
    expect(host.Binds ?? []).toEqual([]);
    expect(host.VolumesFrom ?? []).toEqual([]);
    // Nor a second network beside `NetworkMode`: a container attached to the
    // session's bridge as well would reach ShipIt's API from an address in no
    // registered untrusted subnet, which the guard reads as a browser caller.
    expect(created.NetworkingConfig).toBeUndefined();
    // Nothing named for a credential store on either side of any mount — not
    // the session's `/credentials` tree, and not the orchestrator's own.
    for (const m of mounts) {
      expect(`${m.Source} ${m.Target}`).not.toMatch(/credential/i);
    }
    // `/project` IS the workspace, so it necessarily carries `.git` — and that
    // is not a way back to a fetch credential. Verified at the source rather
    // than assumed: the repo-local `credential.helper` written by
    // `github-auth.ts:392` is `CONTAINER_CREDENTIAL_HELPER`, a PATH to a broker
    // (`git-config.ts` — "this file NEVER contains the token"), and the broker
    // answers only over the session worker's loopback, which the next test
    // shows this container does not share.
    expect(mountFor(host, "/project")?.Source).toBe(workspaceDir);
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
    // The WHOLE environment: the contract's three names (settings is absent —
    // this import has no settings file), the two hygiene settings, and the one
    // credential name the plugin declared.
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

    await runPluginCommand(deps(fake.docker), call);

    const host = fake.containers[0].opts.HostConfig as {
      NetworkMode: string;
      ExtraHosts?: string[];
      Privileged?: boolean;
      CapAdd?: string[];
    };
    expect(host.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    // Spelled out as well as pinned, because the two namespace-sharing modes
    // are what the assertion above is really for, and a future change that
    // renames the network must not read as permission to use one of them.
    expect(host.NetworkMode).not.toBe("host");
    expect(host.NetworkMode.startsWith("container:")).toBe(false);
    // Nor a hand-written route back to the host, where ShipIt's own API is
    // published — the IP guard denies it, but a second lock costs nothing.
    expect(host.ExtraHosts ?? []).toEqual([]);
    expect(host.Privileged ?? false).toBe(false);
    expect(host.CapAdd ?? []).toEqual([]);
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
