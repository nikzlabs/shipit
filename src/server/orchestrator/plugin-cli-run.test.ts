/**
 * docs/262 reqs 17, 20, 23 — the companion-CLI invocation container.
 *
 * The assertions that matter are boundary assertions. A companion CLI is
 * third-party code the agent invokes by name, so what this container does NOT
 * hold is as load-bearing as what it does: no `/credentials`, no worker URL, no
 * inherited environment, no session network, and none of the consuming
 * project's secrets beyond the names the plugin declared.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { clearUntrustedContainerNetworks } from "./api-container-guard.js";

const COMMIT = "d".repeat(40);

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

/** Publish a live generation of `tools`, the way activation would. */
function publishGeneration(manifest = MANIFEST): void {
  const dir = path.join(stateDir, "plugins", "tools", "generations", COMMIT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "shipit.yaml"), manifest);
  fs.writeFileSync(
    path.join(dir, ".shipit-generation.json"),
    JSON.stringify({
      repoName: "tools", commit: COMMIT, ref: "branch main",
      activatedAt: new Date(0).toISOString(), exports: ["requirements"], manifestWarnings: [],
    }),
  );
  fs.symlinkSync(dir, path.join(stateDir, "plugins", "tools", "active"));
}

interface Created { opts: Record<string, unknown> }

function fakeDocker(opts: { exit?: number; stdout?: string; stderr?: string } = {}) {
  const containers: Created[] = [];
  const volumes = new Set<string>();
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
      containers.push({ opts: createOpts });
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
    const host = created.HostConfig as { Binds: string[]; NetworkMode: string; CapDrop: string[] };
    expect(host.Binds.some((b) => b.endsWith(":/plugin"))).toBe(true);
    expect(host.Binds).toContain(`${workspaceDir}:/project`);
    expect(host.Binds).toContain(`${path.join(sessionDir, "plugin-data", "reqs", "state")}:/plugin-state`);
    // The plugin's own entrypoint, resolved inside its own tree — and its args
    // handed over untouched.
    expect(created.Entrypoint).toEqual(["/plugin/cli/index.mjs"]);
    expect(created.Cmd).toEqual(["list", "--json"]);
    expect(created.WorkingDir).toBe("/project");
    expect(host.NetworkMode).toBe(PLUGIN_CLI_NETWORK);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect((created.Labels as Record<string, string>)[PLUGIN_CLI_LABEL]).toBe("s1");
  });

  // req 19 — the whole reason a companion CLI does not run in the agent
  // container. This is the assertion that keeps it true.
  it("hands the plugin no ShipIt credential, worker URL, or inherited environment", async () => {
    declareConsumer();
    publishGeneration();
    const fake = fakeDocker();

    await runPluginCommand(deps(fake.docker), call);

    const env = fake.containers[0].opts.Env as string[];
    const binds = (fake.containers[0].opts.HostConfig as { Binds: string[] }).Binds;
    expect(binds.some((b) => b.includes("/credentials"))).toBe(false);
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

    const host = fake.containers[0].opts.HostConfig as { Binds: string[] };
    expect(host.Binds).toContain(`${settings}:/plugin-settings.json:ro`);
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
    expect((created.HostConfig as { Binds: string[] }).Binds).toContain(`${workspaceDir}:/plugin`);
    expect((created.Env as string[]).some((e) => e.startsWith("SHIPIT_PLUGIN_COMMIT"))).toBe(false);
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
    expect(result.error).toContain("no live plugin version");
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
