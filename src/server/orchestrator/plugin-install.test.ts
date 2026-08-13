/**
 * docs/262 — the plugin install container.
 *
 * Most of these tests exist because a REVIEWER, not a test, caught the
 * corresponding defect in the withdrawn PR #2202. Each blocking finding gets an
 * assertion here, so the same mistake fails a build instead of a review:
 *
 *  - install must not see `/credentials`, the worker URL, or this process's
 *    environment (the credential boundary — req 19);
 *  - install must not be able to reach the session's own network;
 *  - the volume must be released when install ends, or the runtime volume for
 *    the same generation cannot be created over the same upper layer;
 *  - a failed install must report why, and must not stamp itself as done.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import {
  createPluginInstallRunner,
  installCommands,
  installStampPath,
  reapOrphanPluginInstalls,
  PLUGIN_INSTALL_DIR,
} from "./plugin-install.js";
import { pluginWorkDir } from "./plugin-overlay.js";
import type { PluginInstallJob } from "./plugin-generations.js";
import type { PluginExport } from "../shared/plugin-repos.js";

// --- fixtures ---------------------------------------------------------------

function exportWith(name: string, install?: string): PluginExport {
  return {
    name,
    cli: {},
    installInputs: [],
    credentials: [],
    hosts: [],
    settings: {},
    ...(install ? { install } : {}),
  };
}

interface CreatedContainer {
  opts: Record<string, unknown>;
  killed: boolean;
  removed: boolean;
}

/**
 * A daemon that records what it was asked to build. `exit` decides how each
 * install container ends: a number is its status code, `"hang"` never finishes
 * on its own (so the timeout path has something to kill).
 */
function fakeDocker(opts: { exit?: number | "hang"; logs?: string } = {}) {
  const containers: CreatedContainer[] = [];
  const createdVolumes: { Name: string; DriverOpts?: Record<string, string> }[] = [];
  const removedVolumes: string[] = [];

  const docker = {
    createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string> }) => {
      createdVolumes.push(spec);
    },
    getVolume: (name: string) => ({
      inspect: async () => ({ Mountpoint: `/var/lib/docker/volumes/${name}/_data` }),
      remove: async () => {
        removedVolumes.push(name);
      },
    }),
    createContainer: async (createOpts: Record<string, unknown>) => {
      const record: CreatedContainer = { opts: createOpts, killed: false, removed: false };
      containers.push(record);
      let finish: (v: { StatusCode: number }) => void = () => undefined;
      const waited = new Promise<{ StatusCode: number }>((resolve) => { finish = resolve; });
      return {
        start: async () => undefined,
        wait: async () => {
          if (opts.exit === "hang") return waited;
          return { StatusCode: opts.exit ?? 0 };
        },
        kill: async () => {
          record.killed = true;
          finish({ StatusCode: 137 });
        },
        logs: async () => Buffer.from(opts.logs ?? ""),
        remove: async () => {
          record.removed = true;
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, containers, createdVolumes, removedVolumes };
}

let stateDir: string;
let stagingDir: string;
const COMMIT = "c".repeat(40);

function job(exports: PluginExport[]): PluginInstallJob {
  return { repoName: "tools", commit: COMMIT, stagingDir, exports };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
  stagingDir = path.join(stateDir, "plugins", "tools", "generations", `${COMMIT}.staging-1234`);
  fs.mkdirSync(stagingDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// --- pure helpers -----------------------------------------------------------

describe("installCommands", () => {
  it("keeps only exports that declare a non-empty install", () => {
    expect(installCommands([exportWith("a", "npm ci"), exportWith("b"), exportWith("c", "  ")]))
      .toEqual([{ plugin: "a", command: "npm ci" }]);
  });
});

// --- the runner -------------------------------------------------------------

describe("createPluginInstallRunner", () => {
  it("runs nothing when no selected export declares an install", async () => {
    const { docker, containers, createdVolumes } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe")]))).toEqual({ ok: true });
    expect(containers).toHaveLength(0);
    expect(createdVolumes).toHaveLength(0);
  });

  it("gives the install container the overlay volume and NOTHING else", async () => {
    // The finding this encodes: in the agent container, install could read
    // /credentials and call the worker's loopback credential broker.
    vi.stubEnv("GITHUB_TOKEN", "ghp-should-never-be-inherited");
    const { docker, containers } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });

    expect(containers).toHaveLength(1);
    const opts = containers[0]!.opts as {
      Env: string[];
      HostConfig: { Binds: string[]; NetworkMode: string };
      Entrypoint: string[];
      Cmd: string[];
      WorkingDir: string;
    };
    // Exactly one mount, and it is the generation's own volume.
    expect(opts.HostConfig.Binds).toHaveLength(1);
    expect(opts.HostConfig.Binds[0]).toMatch(new RegExp(`^shipit-.*:${PLUGIN_INSTALL_DIR}$`));
    // Nothing of the session, and nothing of this process.
    const env = opts.Env.join("\n");
    expect(env).not.toContain("ghp-should-never-be-inherited");
    expect(env).not.toContain("GITHUB_TOKEN");
    expect(env).not.toMatch(/WORKER|CREDENTIAL|SHIPIT_SESSION/i);
    expect(opts.Env).toContain(`SHIPIT_PLUGIN_COMMIT=${COMMIT}`);
    // Never the session's network — a plugin's install cannot reach its
    // services or its worker.
    expect(opts.HostConfig.NetworkMode).toBe("bridge");
    // The worker entrypoint is bypassed: it prepares session mounts this
    // container deliberately does not have.
    expect(opts.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(opts.Cmd).toEqual(["npm ci"]);
    expect(opts.WorkingDir).toBe(PLUGIN_INSTALL_DIR);
  });

  it("creates the writable layer, and releases the volume when install ends", async () => {
    const { docker, createdVolumes, removedVolumes, containers } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });

    const work = pluginWorkDir(stateDir, "tools", COMMIT);
    expect(fs.existsSync(path.join(work, "upper"))).toBe(true);
    expect(fs.existsSync(path.join(work, "work"))).toBe(true);
    // The lowerdir is the STAGING tree — install runs before publish.
    expect(createdVolumes[0]!.DriverOpts!.o).toContain(`lowerdir=${stagingDir}`);
    // Released on the way out: publish renames the lowerdir, and the runtime
    // volume is created over the same upper layer, which the kernel forbids
    // while another mount holds it.
    expect(removedVolumes).toContain(createdVolumes[0]!.Name);
    expect(containers[0]!.removed).toBe(true);
  });

  it("wipes a half-populated layer from an earlier failed install", async () => {
    const work = pluginWorkDir(stateDir, "tools", COMMIT);
    fs.mkdirSync(path.join(work, "upper", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(work, "upper", "node_modules", "half"), "x");

    const { docker } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });
    await run(job([exportWith("probe", "npm ci")]));

    expect(fs.existsSync(path.join(work, "upper", "node_modules"))).toBe(false);
  });

  it("fails with the command's own output, and stamps nothing", async () => {
    const { docker, removedVolumes, createdVolumes } = fakeDocker({ exit: 1, logs: "npm ERR! 404 no-such-pkg" });
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    const result = await run(job([exportWith("probe", "npm ci")]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("`probe`");
    expect(result.reason).toContain("no-such-pkg");
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(false);
    // Still released — a failed install must not strand the volume.
    expect(removedVolumes).toContain(createdVolumes[0]!.Name);
  });

  it("stops at the first failing export rather than installing the rest", async () => {
    const { docker, containers } = fakeDocker({ exit: 2 });
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    await run(job([exportWith("a", "false"), exportWith("b", "npm ci")]));
    expect(containers).toHaveLength(1);
  });

  it("kills an install that outstays the timeout", async () => {
    const { docker, containers, removedVolumes, createdVolumes } = fakeDocker({ exit: "hang" });
    const run = createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, timeoutMs: 10,
    });

    const result = await run(job([exportWith("probe", "sleep 9999")]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("did not finish");
    expect(containers[0]!.killed).toBe(true);
    expect(containers[0]!.removed).toBe(true);
    expect(removedVolumes).toContain(createdVolumes[0]!.Name);
  });

  it("skips a second install of the same generation and commands", async () => {
    const first = fakeDocker();
    const run1 = createPluginInstallRunner({
      docker: first.docker, image: "worker:test", sessionId: "s1", stateDir,
    });
    await run1(job([exportWith("probe", "npm ci")]));
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(true);

    const second = fakeDocker();
    const run2 = createPluginInstallRunner({
      docker: second.docker, image: "worker:test", sessionId: "s1", stateDir,
    });
    expect(await run2(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });
    expect(second.containers).toHaveLength(0);
  });

  it("re-runs when the install command changed", async () => {
    const first = fakeDocker();
    await createPluginInstallRunner({
      docker: first.docker, image: "worker:test", sessionId: "s1", stateDir,
    })(job([exportWith("probe", "npm ci")]));

    const second = fakeDocker();
    await createPluginInstallRunner({
      docker: second.docker, image: "worker:test", sessionId: "s1", stateDir,
    })(job([exportWith("probe", "npm ci --foreground-scripts")]));
    expect(second.containers).toHaveLength(1);
  });

  it("reaps an install container a previous process left behind", async () => {
    const removed: string[] = [];
    const docker = {
      listContainers: async () => [{ Id: "abc123" }],
      getContainer: (id: string) => ({
        remove: async () => {
          removed.push(id);
        },
      }),
    } as unknown as Docker;

    // An install is awaited inside one activation, so a survivor at boot is an
    // orphan by definition — and until it is removed it holds the generation's
    // overlay volume, which then cannot be removed either.
    expect(await reapOrphanPluginInstalls(docker)).toBe(1);
    expect(removed).toEqual(["abc123"]);
  });

  it("translates the layer onto the daemon's view of the state volume", async () => {
    const { docker, createdVolumes } = fakeDocker();
    const run = createPluginInstallRunner({
      docker,
      image: "worker:test",
      sessionId: "s1",
      stateDir,
      workspaceVolume: "shipit-workspace",
      stateRoot: stateDir,
    });
    await run(job([exportWith("probe", "npm ci")]));

    const o = createdVolumes[0]!.DriverOpts!.o;
    for (const part of o.split(",")) {
      expect(part.split("=")[1]).toMatch(/^\/var\/lib\/docker\/volumes\/shipit-workspace\/_data\//);
    }
  });
});
