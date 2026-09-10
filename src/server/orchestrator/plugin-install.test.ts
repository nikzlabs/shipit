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
  PLUGIN_INSTALL_NETWORK,
} from "./plugin-install.js";
import {
  PLUGIN_BROWSERS_DIR,
  PLUGIN_NPM_PREFIX_DIR,
  PLUGIN_TOOLCHAIN_DIR_NAME,
} from "./plugin-container-env.js";
import { pluginBasePinDir } from "./plugin-dep-store.js";
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";
import { handPluginCheckoutToWorker, chownTreeToSessionWorker } from "./session-worker-uid.js";
import { readInstallRecord } from "./plugin-install-record.js";
import { pluginWorkDir } from "./plugin-overlay.js";
import type { PluginInstallJob } from "./plugin-generations.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { UNCONTAINED_PLUGIN_EGRESS, type PluginEgressPolicy } from "./plugin-egress.js";

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

// Both ownership helpers no-op below root, so file modes cannot distinguish them.
vi.mock("./session-worker-uid.js", async (load) => ({
  // eslint-disable-next-line no-restricted-syntax -- Vitest partial-module mock typing
  ...(await load<typeof import("./session-worker-uid.js")>()),
  handPluginCheckoutToWorker: vi.fn(),
  chownTreeToSessionWorker: vi.fn(),
}));

const CONTAINED_EGRESS: PluginEgressPolicy = {
  contained: true,
  config: { contained: true, extraHosts: [] },
  sidecarImage: "egress-sidecar:test",
  dnsEnabled: true,
  proxyEnabled: true,
};

function exportWith(name: string, install?: string): PluginExport {
  return {
    name,
    cli: {},
    installInputs: [],
    depDirs: [],
    credentials: [],
    hosts: [],
    settings: {},
    ...(install ? { install } : {}),
  };
}

interface CreatedContainer {
  id: string;
  opts: Record<string, unknown>;
  killed: boolean;
  removed: boolean;
}

function fakeDocker(opts: {
  exit?: number | "hang";
  logs?: string | Buffer;
  heldVolume?: boolean;
  onStart?: () => void;
  removeError?: string;
} = {}) {
  const containers: CreatedContainer[] = [];
  const logCalls: Record<string, unknown>[] = [];
  const createdVolumes: { Name: string; DriverOpts?: Record<string, string> }[] = [];
  const removedVolumes: string[] = [];
  // Treat the workspace volume as present without creating it in this fake.
  const deleted = new Set<string>();
  const live = new Set<string>();
  const volumeOpts = new Map<string, Record<string, string>>();
  const networksCreated: string[] = [];

  const notFound = (): never => {
    throw Object.assign(new Error("no such thing"), { statusCode: 404 });
  };

  const docker = {
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!networksCreated.includes(name)) notFound();
        return { IPAM: { Config: [{ Subnet: "172.28.0.0/16" }] } };
      },
    }),
    createNetwork: async (spec: { Name: string }) => {
      networksCreated.push(spec.Name);
    },
    createVolume: async (spec: { Name: string; DriverOpts?: Record<string, string> }) => {
      createdVolumes.push(spec);
      deleted.delete(spec.Name);
      live.add(spec.Name);
      // Docker ignores new options when the named volume already exists.
      if (!volumeOpts.has(spec.Name)) volumeOpts.set(spec.Name, spec.DriverOpts ?? {});
    },
    listVolumes: async () => ({
      Volumes: [...live].filter((n) => !deleted.has(n)).map((Name) => ({ Name })),
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        if (deleted.has(name)) notFound();
        return {
          Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
          Options: volumeOpts.get(name),
        };
      },
      remove: async () => {
        removedVolumes.push(name);
        // Model an accepted removal that leaves the volume mounted.
        if (opts.heldVolume) return;
        live.delete(name);
        deleted.add(name);
        volumeOpts.delete(name);
      },
    }),
    listContainers: async () => [],
    getContainer: (_id: string) => ({ remove: async () => undefined }),
    getImage: (_name: string) => ({
      inspect: async () => ({
        Config: {
          Env: [
            "PATH=/home/shipit/.npm-global/bin:/opt/agent-cli/node_modules/.bin:/usr/bin:/bin",
            "PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers",
            "NPM_CONFIG_PREFIX=/home/shipit/.npm-global",
          ],
        },
      }),
    }),
    createContainer: async (createOpts: Record<string, unknown>) => {
      const record: CreatedContainer = {
        id: `c-${containers.length + 1}`,
        opts: createOpts,
        killed: false,
        removed: false,
      };
      containers.push(record);
      let finish: (v: { StatusCode: number }) => void = () => undefined;
      const waited = new Promise<{ StatusCode: number }>((resolve) => { finish = resolve; });
      return {
        id: record.id,
        start: async () => { opts.onStart?.(); },
        wait: async () => {
          if (opts.exit === "hang") return waited;
          return { StatusCode: opts.exit ?? 0 };
        },
        kill: async () => {
          record.killed = true;
          finish({ StatusCode: 137 });
        },
        logs: async (logOpts: Record<string, unknown>) => {
          logCalls.push(logOpts);
          return Buffer.isBuffer(opts.logs) ? opts.logs : Buffer.from(opts.logs ?? "");
        },
        remove: async () => {
          if (opts.removeError) throw new Error(opts.removeError);
          record.removed = true;
        },
      };
    },
  };
  return {
    docker: docker as unknown as Docker,
    containers,
    createdVolumes,
    removedVolumes,
    networksCreated,
    logCalls,
  };
}

let stateDir: string;
let stagingDir: string;
const COMMIT = "c".repeat(40);

function job(exports: PluginExport[]): PluginInstallJob {
  return {
    repoName: "tools",
    source: "acme/tools",
    commit: COMMIT,
    generationId: COMMIT,
    stagingDir,
    exports,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-install-"));
  stagingDir = path.join(stateDir, "plugins", "tools", "generations", `${COMMIT}.staging-1234`);
  fs.mkdirSync(stagingDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  clearUntrustedContainerNetworks();
  vi.unstubAllEnvs();
});

function run2(docker: Docker) {
  return createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });
}

describe("installCommands", () => {
  it("keeps only exports that declare a non-empty install", () => {
    expect(installCommands([exportWith("a", "npm ci"), exportWith("b"), exportWith("c", "  ")]))
      .toEqual([{ plugin: "a", command: "npm ci" }]);
  });
});

describe("createPluginInstallRunner", () => {
  it("runs nothing when no selected export declares an install", async () => {
    const { docker, containers, createdVolumes } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe")]))).toEqual({ ok: true });
    expect(containers).toHaveLength(0);
    expect(createdVolumes).toHaveLength(0);
  });

  it("gives the install container the overlay volume and NOTHING else", async () => {
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
    expect(opts.HostConfig.Binds).toHaveLength(1);
    expect(opts.HostConfig.Binds[0]).toMatch(new RegExp(`^shipit-.*:${PLUGIN_INSTALL_DIR}$`));
    const env = opts.Env.join("\n");
    expect(env).not.toContain("ghp-should-never-be-inherited");
    expect(env).not.toContain("GITHUB_TOKEN");
    expect(env).not.toMatch(/WORKER|CREDENTIAL|SHIPIT_SESSION/i);
    expect(opts.Env).toContain(`SHIPIT_PLUGIN_COMMIT=${COMMIT}`);
    expect(opts.HostConfig.NetworkMode).toBe(PLUGIN_INSTALL_NETWORK);
    expect(opts.Entrypoint).toEqual(["/bin/sh", "-c"]);
    expect(opts.Cmd).toEqual([
      `umask 002; mkdir -p ${PLUGIN_BROWSERS_DIR} ${PLUGIN_NPM_PREFIX_DIR}; npm ci`,
    ]);
    expect(opts.WorkingDir).toBe(PLUGIN_INSTALL_DIR);
  });

  it("overrides the image's worker-owned ENV paths with writable ones", async () => {
    const { docker, containers } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npx playwright install chromium")]))).toEqual({ ok: true });

    const env = (containers[0]!.opts as { Env: string[] }).Env;
    expect(env).toContain(`PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`);
    expect(env).toContain(`NPM_CONFIG_PREFIX=${PLUGIN_NPM_PREFIX_DIR}`);
    for (const dir of [PLUGIN_BROWSERS_DIR, PLUGIN_NPM_PREFIX_DIR]) {
      expect(dir.startsWith(`${PLUGIN_INSTALL_DIR}/`)).toBe(true);
    }
    expect(env).not.toContain("PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers");
    expect(env).not.toContain("NPM_CONFIG_PREFIX=/home/shipit/.npm-global");
    expect(env.filter((e) => !e.startsWith("PATH=")).join("\n")).not.toContain("/home/shipit");
    expect(env).toContain(
      `PATH=${PLUGIN_NPM_PREFIX_DIR}/bin:/home/shipit/.npm-global/bin:/opt/agent-cli/node_modules/.bin:/usr/bin:/bin`,
    );
  });

  it("still overrides the writable paths when the image cannot be inspected", async () => {
    const { docker, containers } = fakeDocker();
    (docker as unknown as Record<string, unknown>).getImage = () => {
      throw new Error("daemon says no");
    };
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });

    const env = (containers[0]!.opts as { Env: string[] }).Env;
    expect(env).toContain(`PLAYWRIGHT_BROWSERS_PATH=${PLUGIN_BROWSERS_DIR}`);
    expect(env.some((e) => e.startsWith("PATH="))).toBe(false);
  });

  it("creates the writable layer, and releases the volume when install ends", async () => {
    const { docker, createdVolumes, removedVolumes, containers } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });

    const work = pluginWorkDir(stateDir, "tools", COMMIT);
    expect(fs.existsSync(path.join(work, "upper"))).toBe(true);
    expect(fs.existsSync(path.join(work, "work"))).toBe(true);
    expect(createdVolumes[0]!.DriverOpts!.o).toContain(`lowerdir=${stagingDir}`);
    expect(removedVolumes).toContain(createdVolumes[0]!.Name);
    expect(containers[0]!.removed).toBe(true);
  });

  it("hands the staging checkout over object-aware, never with the plain recursive chown", async () => {
    const { docker } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(await run(job([exportWith("probe", "npm ci")]))).toEqual({ ok: true });

    expect(vi.mocked(handPluginCheckoutToWorker)).toHaveBeenCalledWith(stagingDir);
    expect(vi.mocked(chownTreeToSessionWorker)).not.toHaveBeenCalled();
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
    expect(removedVolumes).toContain(createdVolumes[0]!.Name);
  });

  it("strips Docker's stream framing from the reported output", async () => {
    const payload = Buffer.from("npm ERR! code E404\n");
    const header = Buffer.alloc(8);
    header[0] = 2; // stderr
    header.writeUInt32BE(payload.length, 4);
    const { docker } = fakeDocker({ exit: 1, logs: Buffer.concat([header, payload]) });
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    const result = await run(job([exportWith("probe", "npm ci")]));
    expect(result.reason).toContain("npm ERR! code E404");
    // eslint-disable-next-line no-control-regex -- the framing bytes are the point
    expect(result.reason).not.toMatch(/[\u0000-\u0008]/);
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

  it("reaps every kind of plugin container a previous process left behind", async () => {
    const removed: string[] = [];
    const byLabel: Record<string, string> = {
      "shipit-plugin-install": "install-1",
      "shipit-plugin-cli": "cli-1",
      "shipit-plugin-netns": "netns-1",
    };
    const docker = {
      listContainers: async (opts: { filters: { label: string[] } }) => {
        const id = byLabel[opts.filters.label[0]];
        return id ? [{ Id: id }] : [];
      },
      getContainer: (id: string) => ({
        remove: async () => {
          removed.push(id);
        },
      }),
    } as unknown as Docker;

    expect(await reapOrphanPluginInstalls(docker)).toBe(3);
    expect(removed).toEqual(["install-1", "cli-1", "netns-1"]);
  });

  it("denies its own subnet at the orchestrator API before any container joins", async () => {
    clearUntrustedContainerNetworks();
    const { docker, networksCreated } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(isUntrustedContainerIp("172.28.0.7")).toBe(false);
    await run(job([exportWith("probe", "npm ci")]));

    expect(networksCreated).toEqual([PLUGIN_INSTALL_NETWORK]);
    expect(isUntrustedContainerIp("172.28.0.7")).toBe(true);
    expect(isUntrustedContainerIp("172.18.0.4")).toBe(false);
  });

  it("runs a contained session's install in a holder on the install network", async () => {
    const { docker, containers } = fakeDocker();

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([exportWith("probe", "npm ci")]));

    expect(result).toEqual({ ok: true });
    const [holder, install] = containers;
    expect((install!.opts.HostConfig as { NetworkMode: string }).NetworkMode)
      .toBe(`container:${holder!.id}`);
    const holderHost = holder!.opts.HostConfig as Record<string, unknown>;
    expect(holderHost.NetworkMode).toBe(PLUGIN_INSTALL_NETWORK);
    expect(holderHost.Binds ?? []).toEqual([]);
    expect(holder!.opts.Env ?? []).toEqual([]);
    expect(holder!.removed).toBe(true);
  });

  it("shares one namespace across a generation's install commands", async () => {
    const { docker, containers } = fakeDocker();

    await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([exportWith("a", "npm ci"), exportWith("b", "npm run build")]));

    const [holder, ...installs] = containers;
    expect(installs).toHaveLength(2);
    for (const one of installs) {
      expect((one.opts.HostConfig as { NetworkMode: string }).NetworkMode)
        .toBe(`container:${holder!.id}`);
    }
  });

  it("fails a contained session's install when containment cannot be installed", async () => {
    const { docker, containers } = fakeDocker();

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => ({ ...CONTAINED_EGRESS, sidecarImage: undefined }),
    })(job([exportWith("probe", "npm ci")]));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SESSION_EGRESS_SIDECAR_IMAGE");
    expect(containers).toHaveLength(0);
  });

  it("names the declared hosts the session blocks when a contained install fails", async () => {
    const { docker } = fakeDocker({ exit: 1, logs: "npm ERR! getaddrinfo EAI_AGAIN\n" });
    const probe = { ...exportWith("probe", "npm ci"), hosts: [{ name: "downloads.vendor.example", optional: false }] };

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([probe]));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("downloads.vendor.example");
    expect(result.reason).toContain("egress allowlist");
    expect(result.reason).toContain("EAI_AGAIN");
  });

  it("does not blame egress for a failure that is not a network failure", async () => {
    const { docker } = fakeDocker({
      exit: 1,
      logs: "Error: EACCES: permission denied, mkdir '/opt/playwright-browsers/__dirlock'\n",
    });
    const probe = {
      ...exportWith("probe", "npm ci"),
      hosts: [{ name: "api.vendor.example", optional: false }],
    };

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([probe]));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Separately —");
    expect(result.reason).toContain("If the failure above is a network error");
    expect(result.reason).toContain("api.vendor.example");
    expect(result.reason).toContain("egress allowlist");
  });

  it("says nothing about an OPTIONAL declared host the session blocks", async () => {
    const { docker } = fakeDocker({ exit: 1, logs: "npm ERR! syntax error\n" });
    const probe = {
      ...exportWith("probe", "npm ci"),
      hosts: [{ name: "pixellab.ai", optional: true }],
    };

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([probe]));

    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("pixellab.ai");
    expect(result.reason).not.toContain("egress allowlist");
    const required = {
      ...exportWith("probe", "npm ci"),
      hosts: [{ name: "pixellab.ai", optional: false }],
    };
    const strict = await createPluginInstallRunner({
      docker: fakeDocker({ exit: 1, logs: "npm ERR! syntax error\n" }).docker,
      image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([required]));
    expect(strict.ok).toBe(false);
    expect(strict.reason).toContain("pixellab.ai");
  });

  it("says nothing about egress when the declared host is already allowed", async () => {
    const { docker } = fakeDocker({ exit: 1, logs: "npm ERR! syntax error\n" });
    const probe = { ...exportWith("probe", "npm ci"), hosts: [{ name: "ok.example", optional: false }] };

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => ({
        ...CONTAINED_EGRESS,
        config: { contained: true, extraHosts: ["ok.example"] },
      }),
    })(job([probe]));

    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("egress allowlist");
  });

  it("leaves an uncontained session's install on the plugin network unchanged", async () => {
    const { docker, containers } = fakeDocker();

    await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => UNCONTAINED_PLUGIN_EGRESS,
    })(job([exportWith("probe", "npm ci")]));

    expect(containers).toHaveLength(1);
    expect((containers[0]!.opts.HostConfig as { NetworkMode: string }).NetworkMode)
      .toBe(PLUGIN_INSTALL_NETWORK);
  });

  it("refuses to install when its network has no subnet it can deny", async () => {
    clearUntrustedContainerNetworks();
    const { docker, containers } = fakeDocker();
    (docker as unknown as { getNetwork: (n: string) => unknown }).getNetwork = () => ({
      inspect: async () => ({ IPAM: { Config: [] } }),
    });

    const result = await run2(docker)(job([exportWith("probe", "npm ci")]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no IPv4 subnet");
    expect(containers).toHaveLength(0);
  });

  it("fails the install when the layer's volume cannot be released", async () => {
    const { docker } = fakeDocker({ heldVolume: true });
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
    })(job([exportWith("probe", "npm ci")]));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("could not be released");
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(false);
  });

  it("stops a running install when its session goes away", async () => {
    const { docker, containers } = fakeDocker({ exit: "hang" });
    let gone = false;
    const run = createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, timeoutMs: 60_000,
    });
    const running = run({ ...job([exportWith("probe", "sleep 9999")]), isCancelled: () => gone });
    // Let the wait loop take at least one poll slice.
    await new Promise((r) => setTimeout(r, 30));
    gone = true;

    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("session went away");
    expect(containers[0]!.killed).toBe(true);
  });

  it("does not start the next export's install once the session is gone", async () => {
    const { docker, containers } = fakeDocker();
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
    })({
      ...job([exportWith("a", "npm ci"), exportWith("b", "npm ci")]),
      isCancelled: () => containers.length >= 1,
    });

    expect(containers).toHaveLength(1);
    expect(result.ok).toBe(false);
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

  it("logs a removal the daemon refused, and still reports the install's own outcome", async () => {
    const { docker, containers } = fakeDocker({ removeError: "device or resource busy" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await createPluginInstallRunner({
        docker, image: "worker:test", sessionId: "s1", stateDir,
      })(job([exportWith("probe", "npm ci")]));

      expect(result).toEqual({ ok: true });
      const line = warn.mock.calls.map((c) => c.join(" ")).find((c) => c.includes(containers[0]!.id));
      expect(line).toBeDefined();
      expect(line).toContain("tools");
      expect(line).toContain("device or resource busy");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createPluginInstallRunner and the shared dependency store", () => {
  function npmExport(): PluginExport {
    fs.writeFileSync(path.join(stagingDir, "package.json"), `{"name":"probe"}`);
    fs.writeFileSync(path.join(stagingDir, "package-lock.json"), `{"lockfileVersion":3}`);
    return { ...exportWith("probe", "npm ci"), depDirs: ["node_modules"] };
  }

  function upper(commit = COMMIT): string {
    return path.join(pluginWorkDir(stateDir, "tools", commit), "upper");
  }

  function installs(commit = COMMIT): () => void {
    return () => {
      fs.mkdirSync(path.join(upper(commit), "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(upper(commit), "node_modules", "left-pad", "index.js"), "1");
      const browsers = path.join(upper(commit), PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers");
      fs.mkdirSync(browsers, { recursive: true });
      fs.writeFileSync(path.join(browsers, "chromium-1194"), "a browser this install downloaded");
    };
  }

  it("promotes what it installed, so the next commit does not install it again", async () => {
    const first = fakeDocker({ onStart: installs() });
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const cold = await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    expect(first.containers).toHaveLength(1);
    expect(cold.basePins).toHaveLength(2);
    expect(fs.existsSync(path.join(upper(), "node_modules"))).toBe(false);

    const nextCommit = "e".repeat(40);
    const next = fakeDocker({ onStart: installs(nextCommit) });
    const warm = await createPluginInstallRunner({ ...runner, docker: next.docker })({
      ...job([npmExport()]), commit: nextCommit, generationId: nextCommit,
    });

    expect(next.containers).toHaveLength(0);
    expect(next.createdVolumes).toHaveLength(0);
    expect(warm.ok).toBe(true);
    expect(warm.basePins).toEqual(cold.basePins);
    const stored = warm.basePins!
      .map((pin) => pluginBasePinDir(stateDir, pin)!)
      .map((dir) => path.join(dir, PLUGIN_TOOLCHAIN_DIR_NAME, "playwright-browsers", "chromium-1194"));
    expect(stored.some((f) => fs.existsSync(f))).toBe(true);
  });

  it("docs/266 — a forced retry installs even when the shared store has a hit", async () => {
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const first = fakeDocker({ onStart: installs() });
    await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    const nextCommit = "e".repeat(40);
    const warm = fakeDocker({ onStart: installs(nextCommit) });
    await createPluginInstallRunner({ ...runner, docker: warm.docker })({
      ...job([npmExport()]), commit: nextCommit, generationId: nextCommit,
    });
    expect(warm.containers).toHaveLength(0);

    const forced = fakeDocker({ onStart: installs(nextCommit) });
    const result = await createPluginInstallRunner({ ...runner, docker: forced.docker })({
      ...job([npmExport()]), commit: nextCommit, generationId: nextCommit, force: true,
    });

    expect(result.ok).toBe(true);
    expect(forced.containers).toHaveLength(1);
  });

  it("installs cold when the dependency inputs move, and shares the new tree", async () => {
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const first = fakeDocker({ onStart: installs() });
    const cold = await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    const movedCommit = "f".repeat(40);
    const second = fakeDocker({ onStart: installs(movedCommit) });
    const exp = npmExport();
    fs.writeFileSync(path.join(stagingDir, "package-lock.json"), `{"lockfileVersion":4}`);
    const moved = await createPluginInstallRunner({ ...runner, docker: second.docker })({
      ...job([exp]), commit: movedCommit, generationId: movedCommit,
    });

    expect(second.containers).toHaveLength(1);
    expect(moved.basePins).toHaveLength(2);
    expect(moved.basePins).not.toEqual(cold.basePins);
  });

  it("never mounts the store into the container that runs plugin code (req 19)", async () => {
    const { docker, containers, createdVolumes } = fakeDocker({ onStart: installs() });
    await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    const o = createdVolumes[0]!.DriverOpts!.o;
    expect(o.split(",")[0]).toBe(`lowerdir=${stagingDir}`);
    const host = containers[0]!.opts.HostConfig as {
      Binds: string[];
      Mounts?: { Source: string; Target: string; ReadOnly?: boolean }[];
    };
    expect(host.Binds).toHaveLength(1);
    expect(host.Mounts).toHaveLength(1);
    expect(host.Mounts![0]!.Target).toBe("/dep-cache");
    expect(host.Mounts![0]!.Source).toContain(path.join(stateDir, "dep-cache"));
    expect(host.Mounts![0]!.ReadOnly).toBe(false);
    const env = (containers[0]!.opts as { Env: string[] }).Env;
    expect(env).toContain("npm_config_cache=/dep-cache/npm");
  });

  it("keeps the download cache in this repository's own subtree (req 15)", async () => {
    const one = fakeDocker({ onStart: installs() });
    const two = fakeDocker({ onStart: installs() });
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    await createPluginInstallRunner({ ...runner, docker: one.docker })(job([npmExport()]));
    const otherCommit = "a".repeat(40);
    two.containers.length = 0;
    await createPluginInstallRunner({ ...runner, docker: two.docker })({
      ...job([npmExport()]), source: "acme/other", commit: otherCommit, generationId: otherCommit,
    });

    const sourceOf = (d: typeof one) =>
      (d.containers[0]!.opts.HostConfig as { Mounts: { Source: string }[] }).Mounts[0]!.Source;
    expect(sourceOf(one)).not.toBe(sourceOf(two));
  });

  it("re-installs when a base the stamp recorded is gone", async () => {
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const first = fakeDocker({ onStart: installs() });
    const cold = await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    fs.rmSync(path.join(stateDir, "overlay-base"), { recursive: true, force: true });
    const again = fakeDocker({ onStart: installs() });
    const redone = await createPluginInstallRunner({ ...runner, docker: again.docker })(job([npmExport()]));

    expect(again.containers).toHaveLength(1);
    expect(redone.basePins).toEqual(cold.basePins);
  });

  it("fails the activation when install output reached neither the layer nor the store", async () => {
    const { docker, containers } = fakeDocker({ onStart: installs() });
    // Fail pointer publication after the base rename has emptied the layer.
    fs.writeFileSync(path.join(stateDir, "overlay-base-meta"), "not a directory");

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    expect(containers).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("its output was lost");
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(false);
  });

  const installRecord = () => readInstallRecord(path.join(stateDir, "plugins"), "tools");

  it("records why an install ShipIt cannot content-key shares nothing", async () => {
    const { docker, containers } = fakeDocker({ onStart: installs() });
    const exp: PluginExport = {
      ...exportWith("probe", "pip install --no-cache-dir --target vendor/py -r requirements.txt"),
      depDirs: ["vendor/py"],
    };
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([exp]));

    expect(containers).toHaveLength(1);
    expect(result).toEqual({ ok: true });
    const record = installRecord();
    expect(record?.outcome).toBe("succeeded");
    expect(record?.depStoreReason).toContain("installed from scratch in every session");
    expect(record?.depStoreReason).toContain("--target vendor/py");
    expect(record?.depStoreReason).toContain("`install-inputs:`");
  });

  it("says nothing when the tree IS shared", async () => {
    const { docker } = fakeDocker({ onStart: installs() });
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    expect(result.basePins).toHaveLength(2);
    expect(installRecord()?.depStoreReason).toBeUndefined();
  });

  it("records a dep dir the install left empty, which no plan could have predicted", async () => {
    const { docker, containers } = fakeDocker();
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    expect(containers).toHaveLength(1);
    expect(result).toEqual({ ok: true });
    const reason = installRecord()?.depStoreReason ?? "";
    expect(installRecord()?.outcome).toBe("succeeded");
    expect(reason).toContain("`node_modules`");
    expect(reason).toContain(`\`${PLUGIN_TOOLCHAIN_DIR_NAME}\``);
  });

  it("keeps the reason when the same commit re-stages and skips the install", async () => {
    const exp: PluginExport = {
      ...exportWith("probe", "pip install --target vendor/py -r requirements.txt"),
      depDirs: ["vendor/py"],
    };
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    await createPluginInstallRunner({ ...runner, docker: fakeDocker().docker })(job([exp]));
    await createPluginInstallRunner({ ...runner, docker: fakeDocker().docker })(job([exp]));

    const record = installRecord();
    expect(record?.outcome).toBe("skipped-stamp");
    expect(record?.depStoreReason).toContain("installed from scratch in every session");
  });

  it("does nothing different without a store configured", async () => {
    const { docker, containers } = fakeDocker({ onStart: installs() });
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
    })(job([npmExport()]));

    expect(containers).toHaveLength(1);
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(path.join(upper(), "node_modules"))).toBe(true);
  });
});

describe("createPluginInstallRunner — forced retry and the install record", () => {
  const pluginsDir = (): string => path.join(stateDir, "plugins");

  it("runs the install again for a generation the stamp calls done", async () => {
    const first = fakeDocker();
    await run2(first.docker)(job([exportWith("probe", "npm ci")]));
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(true);

    const skipped = fakeDocker();
    await run2(skipped.docker)(job([exportWith("probe", "npm ci")]));
    expect(skipped.containers).toHaveLength(0);

    const forced = fakeDocker();
    const result = await run2(forced.docker)({ ...job([exportWith("probe", "npm ci")]), force: true });
    expect(result.ok).toBe(true);
    expect(forced.containers).toHaveLength(1);
  });

  it("records a successful install, and the commit it was for", async () => {
    await run2(fakeDocker().docker)(job([exportWith("probe", "npm ci")]));
    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record).toMatchObject({ outcome: "succeeded", commit: COMMIT });
  });

  it("records what a SUCCESSFUL install printed", async () => {
    const docker = fakeDocker({ logs: "added 41 packages\nbuilt dist/index.js" }).docker;
    await run2(docker)(job([exportWith("probe", "npm ci && npm run build")]));

    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("succeeded");
    expect(record?.output).toContain("built dist/index.js");
  });

  it("asks the daemon for a bounded number of lines, not the whole log", async () => {
    const { docker, logCalls } = fakeDocker({ logs: "added 41 packages" });
    await run2(docker)(job([exportWith("probe", "npm ci")]));

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({ tail: 40, stdout: true, stderr: true });
  });

  it("bounds a successful install's output exactly as a failure's is bounded", async () => {
    const docker = fakeDocker({ logs: `${"x".repeat(9000)}\nTAIL-MARKER` }).docker;
    await run2(docker)(job([exportWith("probe", "npm ci")]));

    const output = readInstallRecord(pluginsDir(), "tools")?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(2001);
    expect(output.startsWith("…")).toBe(true);
    expect(output).toContain("TAIL-MARKER");
  });

  it("bounds the whole run, not each command, when several exports install", async () => {
    const docker = fakeDocker({ logs: "y".repeat(1800) }).docker;
    await run2(docker)(job([exportWith("a", "npm ci"), exportWith("b", "npm ci")]));

    const output = readInstallRecord(pluginsDir(), "tools")?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(2001);
    expect(output).toContain("--- b");
  });

  it("does not erase the output when the same commit re-stages and skips", async () => {
    await run2(fakeDocker({ logs: "built dist/index.js" }).docker)(job([exportWith("probe", "npm ci")]));
    await run2(fakeDocker({ logs: "ignored" }).docker)(job([exportWith("probe", "npm ci")]));

    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("skipped-stamp");
    expect(record?.output).toContain("built dist/index.js");
    expect(record?.output).not.toContain("ignored");
  });

  it("does not carry an output forward onto a different commit", async () => {
    await run2(fakeDocker({ logs: "built dist/index.js" }).docker)(job([exportWith("probe", "npm ci")]));
    const other = { ...job([exportWith("probe", "npm ci")]), commit: "d".repeat(40) };
    await run2(fakeDocker({ logs: "added 3 packages" }).docker)(other);

    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.commit).toBe("d".repeat(40));
    expect(record?.output).toContain("added 3 packages");
    expect(record?.output).not.toContain("built dist/index.js");
  });

  it("keeps a hung install's partial output instead of losing it with the container", async () => {
    const { docker } = fakeDocker({ exit: "hang", logs: "compiling src/index.ts" });
    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, timeoutMs: 10,
    })(job([exportWith("probe", "npm run build")]));

    expect(result.ok).toBe(false);
    expect(readInstallRecord(pluginsDir(), "tools")?.output).toContain("compiling src/index.ts");
  });

  it("records a FAILED install with its output — the evidence that had nowhere to live", async () => {
    const failing = fakeDocker({ exit: 1, logs: "npm ERR! missing script: build" });
    const result = await run2(failing.docker)(job([exportWith("probe", "npm run build")]));

    expect(result.ok).toBe(false);
    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("failed");
    expect(record?.detail).toContain("npm ERR! missing script: build");
    expect(record?.output).toContain("npm ERR! missing script: build");
  });

  it("records a skip as a skip, not as a success", async () => {
    await run2(fakeDocker().docker)(job([exportWith("probe", "npm ci")]));
    await run2(fakeDocker().docker)(job([exportWith("probe", "npm ci")]));
    expect(readInstallRecord(pluginsDir(), "tools")?.outcome).toBe("skipped-stamp");
  });

  it("writes nothing for a repository whose exports declare no install", async () => {
    await run2(fakeDocker().docker)(job([exportWith("probe")]));
    expect(readInstallRecord(pluginsDir(), "tools")).toBeNull();
  });
});
