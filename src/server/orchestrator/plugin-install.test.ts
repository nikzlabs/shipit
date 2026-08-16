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
  PLUGIN_INSTALL_NETWORK,
} from "./plugin-install.js";
import { clearUntrustedContainerNetworks, isUntrustedContainerIp } from "./api-container-guard.js";
import { readInstallRecord } from "./plugin-install-record.js";
import { pluginWorkDir } from "./plugin-overlay.js";
import type { PluginInstallJob } from "./plugin-generations.js";
import type { PluginExport } from "../shared/plugin-repos.js";
import { UNCONTAINED_PLUGIN_EGRESS, type PluginEgressPolicy } from "./plugin-egress.js";

// docs/262 req 24 — the privileged tier launchers, stubbed at the same seam
// `compose-service-egress.test.ts` uses (they need a live host, and
// `buildTierAEgressInputs` fetches GitHub's meta endpoint). What stays real is
// the decision this file is about: which namespace the install container runs in.
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

// --- fixtures ---------------------------------------------------------------

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
  /** The daemon's id, so a `container:<holder>` namespace can be traced to one. */
  id: string;
  opts: Record<string, unknown>;
  killed: boolean;
  removed: boolean;
}

/**
 * A daemon that records what it was asked to build. `exit` decides how each
 * install container ends: a number is its status code, `"hang"` never finishes
 * on its own (so the timeout path has something to kill).
 */
function fakeDocker(opts: {
  exit?: number | "hang";
  logs?: string | Buffer;
  heldVolume?: boolean;
  /** What the install writes into the generation's writable layer. */
  onStart?: () => void;
} = {}) {
  const containers: CreatedContainer[] = [];
  const createdVolumes: { Name: string; DriverOpts?: Record<string, string> }[] = [];
  const removedVolumes: string[] = [];
  // A volume "exists" unless we removed it — so the workspace volume, which
  // this fake never creates, still inspects fine (the daemon-path translation
  // reads its mountpoint).
  const deleted = new Set<string>();
  const live = new Set<string>();
  const networksCreated: string[] = [];

  const notFound = (): never => {
    throw Object.assign(new Error("no such thing"), { statusCode: 404 });
  };

  const docker = {
    // The install network is created once and inspected for its subnet, which
    // is what gets declared untrusted.
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
    },
    listVolumes: async () => ({
      Volumes: [...live].filter((n) => !deleted.has(n)).map((Name) => ({ Name })),
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        if (deleted.has(name)) notFound();
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
      },
      remove: async () => {
        removedVolumes.push(name);
        // `heldVolume` models a container still holding it: the removal is
        // accepted and the volume is still there afterwards.
        if (opts.heldVolume) return;
        live.delete(name);
        deleted.add(name);
      },
    }),
    listContainers: async () => [],
    getContainer: (_id: string) => ({ remove: async () => undefined }),
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
        logs: async () => (Buffer.isBuffer(opts.logs) ? opts.logs : Buffer.from(opts.logs ?? "")),
        remove: async () => {
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
  };
}

let stateDir: string;
let stagingDir: string;
const COMMIT = "c".repeat(40);

function job(exports: PluginExport[]): PluginInstallJob {
  return { repoName: "tools", source: "acme/tools", commit: COMMIT, stagingDir, exports };
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

/** The runner over a hand-modified fake daemon. */
function run2(docker: Docker) {
  return createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });
}

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
    // Its own network, never a session's and never the default bridge — see
    // the dedicated test below for why that distinction is the security fix.
    expect(opts.HostConfig.NetworkMode).toBe(PLUGIN_INSTALL_NETWORK);
    // The worker entrypoint is bypassed: it prepares session mounts this
    // container deliberately does not have.
    expect(opts.Entrypoint).toEqual(["/bin/sh", "-c"]);
    // docs/270 — `umask 002` so everything the install writes into the SHARED
    // dep cache and the promoted dep base is group-writable; the session
    // entrypoint that normally sets it is bypassed for this container.
    expect(opts.Cmd).toEqual(["umask 002; npm ci"]);
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

  // A container without a TTY has its output multiplexed: an 8-byte header per
  // chunk. Read as text, that framing lands in the middle of the message the
  // degraded card shows the user.
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
      // req 24's netns holder. It matters MORE than the two above, not less: it
      // is the only one with `RestartPolicy` sidecars attached, so a leak keeps
      // a resolver and an SNI proxy alive for a call that ended at a crash.
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

    // An install is awaited inside one activation and a companion-CLI call
    // inside one request, so a survivor of either kind at boot is an orphan by
    // definition — and until it is removed it holds the generation's overlay
    // volume, which then cannot be removed either.
    expect(await reapOrphanPluginInstalls(docker)).toBe(3);
    expect(removed).toEqual(["install-1", "cli-1", "netns-1"]);
  });

  // The finding this encodes: on ANY unregistered network the orchestrator's
  // container-origin guard reads the source IP as a trusted browser/host
  // caller, so the install could have asked
  // /api/sessions/<id>/git/credential for a real GitHub token — more API
  // reach than the agent container it was isolated from.
  it("denies its own subnet at the orchestrator API before any container joins", async () => {
    clearUntrustedContainerNetworks();
    const { docker, networksCreated } = fakeDocker();
    const run = createPluginInstallRunner({ docker, image: "worker:test", sessionId: "s1", stateDir });

    expect(isUntrustedContainerIp("172.28.0.7")).toBe(false);
    await run(job([exportWith("probe", "npm ci")]));

    expect(networksCreated).toEqual([PLUGIN_INSTALL_NETWORK]);
    expect(isUntrustedContainerIp("172.28.0.7")).toBe(true);
    // A session container's own bridge address is untouched by this.
    expect(isUntrustedContainerIp("172.18.0.4")).toBe(false);
  });

  /**
   * docs/262 req 24 — an install is repo-authored code with outbound access
   * (`npm ci` fetches), and until this it had UNRESTRICTED outbound while the
   * project's own `agent.install` ran under the session's allowlist. Now it runs
   * in a ShipIt-owned holder carrying that same allowlist.
   *
   * The req-19 half is what the assertion is really about: the holder is on the
   * install network, whose subnet the guard denies, so the namespace change buys
   * the install no API reach. A SESSION container's namespace would have.
   */
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
    // Released when the install ends: the holder outlives every install
    // container by construction, so nothing else can remove it.
    expect(holder!.removed).toBe(true);
  });

  // One holder for the whole run, not one per command: a generation's install
  // commands are one logical install, and each namespace costs a holder plus its
  // sidecars.
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

  // Fail closed, and BEFORE the install container: a contained session whose
  // deployment cannot install containment gets a failed activation (which
  // degrades to the prior generation, req 15), never an install with
  // unrestricted egress.
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

  /**
   * req 24's guided-onboarding clause, at the one moment the Plugins card cannot
   * cover it. A plugin's FIRST activation has no live generation, so the card
   * resolves no declared hosts and shows no "Allow" buttons — and containing
   * `install` is what made that reachable, by turning a working install into a
   * failing one. Without this the user gets a package-manager DNS error and is
   * left to reverse-engineer the host, which is the phrase req 24 uses for what
   * must not happen.
   */
  it("names the declared hosts the session blocks when a contained install fails", async () => {
    const { docker } = fakeDocker({ exit: 1, logs: "npm ERR! getaddrinfo EAI_AGAIN\n" });
    const probe = { ...exportWith("probe", "npm ci"), hosts: ["downloads.vendor.example"] };

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir,
      egress: () => CONTAINED_EGRESS,
    })(job([probe]));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("downloads.vendor.example");
    expect(result.reason).toContain("egress allowlist");
    // The package manager's own output is still there — the clause is added to
    // the failure, not substituted for it.
    expect(result.reason).toContain("EAI_AGAIN");
  });

  // Saying "egress" about an install that failed for another reason points the
  // user at the wrong thing, so a declared host that IS allowed stays silent.
  it("says nothing about egress when the declared host is already allowed", async () => {
    const { docker } = fakeDocker({ exit: 1, logs: "npm ERR! syntax error\n" });
    const probe = { ...exportWith("probe", "npm ci"), hosts: ["ok.example"] };

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

  // The other half of req 24's sentence: an uncontained session's plugin code
  // must reach what its own code reaches, which there is everything.
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
    // A network that reports no IPv4 subnet — nothing to register, so
    // nothing may run: fail closed.
    (docker as unknown as { getNetwork: (n: string) => unknown }).getNetwork = () => ({
      inspect: async () => ({ IPAM: { Config: [] } }),
    });

    const result = await run2(docker)(job([exportWith("probe", "npm ci")]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no IPv4 subnet");
    expect(containers).toHaveLength(0);
  });

  it("fails the install when the layer's volume cannot be released", async () => {
    // Publishing here would produce a generation whose runtime mount cannot be
    // built: the kernel forbids a second mount over the held upperdir.
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
});

// ---------------------------------------------------------------------------
// req 28 — the shared dependency store
// ---------------------------------------------------------------------------

describe("createPluginInstallRunner and the shared dependency store", () => {
  /** An export whose install is content-keyable, over a checkout that has inputs. */
  function npmExport(): PluginExport {
    fs.writeFileSync(path.join(stagingDir, "package.json"), `{"name":"probe"}`);
    fs.writeFileSync(path.join(stagingDir, "package-lock.json"), `{"lockfileVersion":3}`);
    return { ...exportWith("probe", "npm ci"), depDirs: ["node_modules"] };
  }

  /** Where a generation's install output lands. */
  function upper(commit = COMMIT): string {
    return path.join(pluginWorkDir(stateDir, "tools", commit), "upper");
  }

  function installs(commit = COMMIT): () => void {
    return () => {
      fs.mkdirSync(path.join(upper(commit), "node_modules", "left-pad"), { recursive: true });
      fs.writeFileSync(path.join(upper(commit), "node_modules", "left-pad", "index.js"), "1");
    };
  }

  it("promotes what it installed, so the next commit does not install it again", async () => {
    const first = fakeDocker({ onStart: installs() });
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const cold = await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    expect(first.containers).toHaveLength(1);
    expect(cold.basePins).toHaveLength(1);
    // The tree left the writable layer: the store holds one copy, not two.
    expect(fs.existsSync(path.join(upper(), "node_modules"))).toBe(false);

    // A NEW commit of the same repository, whose dependency inputs did not
    // change — the case req 28 names. Nothing runs.
    const nextCommit = "e".repeat(40);
    const next = fakeDocker({ onStart: installs(nextCommit) });
    const warm = await createPluginInstallRunner({ ...runner, docker: next.docker })({
      ...job([npmExport()]), commit: nextCommit,
    });

    expect(next.containers).toHaveLength(0);
    expect(next.createdVolumes).toHaveLength(0);
    expect(warm.ok).toBe(true);
    expect(warm.basePins).toEqual(cold.basePins);
  });

  it("docs/266 — a forced retry installs even when the shared store has a hit", async () => {
    // The store hit is the second shortcut that would make `--force` a no-op
    // reporting success: it mounts a tree some other session produced and runs
    // nothing. For an ordinary activation that is req 28 working; for a
    // consumer retrying a version that is live and broken it is the failure
    // itself, dressed as a fix.
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const first = fakeDocker({ onStart: installs() });
    await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    const nextCommit = "e".repeat(40);
    const warm = fakeDocker({ onStart: installs(nextCommit) });
    await createPluginInstallRunner({ ...runner, docker: warm.docker })({
      ...job([npmExport()]), commit: nextCommit,
    });
    expect(warm.containers).toHaveLength(0);

    const forced = fakeDocker({ onStart: installs(nextCommit) });
    const result = await createPluginInstallRunner({ ...runner, docker: forced.docker })({
      ...job([npmExport()]), commit: nextCommit, force: true,
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
      ...job([exp]), commit: movedCommit,
    });

    expect(second.containers).toHaveLength(1);
    expect(moved.basePins).toHaveLength(1);
    // A different dep state is a different scope, never an overwrite of the one
    // an earlier commit's generations are still mounting.
    expect(moved.basePins).not.toEqual(cold.basePins);
  });

  it("never mounts the store into the container that runs plugin code (req 19)", async () => {
    const { docker, containers, createdVolumes } = fakeDocker({ onStart: installs() });
    await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    // The install's lowerdir is the staging checkout and nothing else: a base
    // stacked under it would make the upper layer a delta, and a delta cannot be
    // promoted by a rename. It is also what keeps the shared tree unreachable
    // from plugin-authored code while it runs.
    const o = createdVolumes[0]!.DriverOpts!.o;
    expect(o.split(",")[0]).toBe(`lowerdir=${stagingDir}`);
    // And the only thing the container holds besides that volume is the
    // repository's own download cache.
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
      ...job([npmExport()]), source: "acme/other", commit: otherCommit,
    });

    const sourceOf = (d: typeof one) =>
      (d.containers[0]!.opts.HostConfig as { Mounts: { Source: string }[] }).Mounts[0]!.Source;
    expect(sourceOf(one)).not.toBe(sourceOf(two));
  });

  it("re-installs when a base the stamp recorded is gone", async () => {
    const runner = { image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir };
    const first = fakeDocker({ onStart: installs() });
    const cold = await createPluginInstallRunner({ ...runner, docker: first.docker })(job([npmExport()]));

    // A sweep took the base. The stamp still claims this commit is installed,
    // and believing it would leave the plugin with no dependencies at all.
    fs.rmSync(path.join(stateDir, "overlay-base"), { recursive: true, force: true });
    const again = fakeDocker({ onStart: installs() });
    const redone = await createPluginInstallRunner({ ...runner, docker: again.docker })(job([npmExport()]));

    expect(again.containers).toHaveLength(1);
    // Republished into the same scope: the content key did not change, only the
    // tree went missing.
    expect(redone.basePins).toEqual(cold.basePins);
  });

  it("fails the activation when install output reached neither the layer nor the store", async () => {
    const { docker, containers } = fakeDocker({ onStart: installs() });
    // The pointer directory is a file, so `publishBase` fails AFTER the rename
    // has already emptied the writable layer. Publishing that generation would
    // give the plugin no dependencies at all, with nothing saying why.
    fs.writeFileSync(path.join(stateDir, "overlay-base-meta"), "not a directory");

    const result = await createPluginInstallRunner({
      docker, image: "worker:test", sessionId: "s1", stateDir, depStoreDir: stateDir,
    })(job([npmExport()]));

    expect(containers).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("its output was lost");
    // A failed install is a failed activation, so nothing is stamped as done.
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(false);
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

/**
 * docs/266 — the retry (`--force`) and the record that says what happened.
 *
 * Both exist because of one measured episode: a live version whose install had
 * left nothing behind, no way to see that from the session, and no way to run
 * the install again without the plugin's author publishing a new commit.
 */
describe("createPluginInstallRunner — forced retry and the install record", () => {
  const pluginsDir = (): string => path.join(stateDir, "plugins");

  it("runs the install again for a generation the stamp calls done", async () => {
    const first = fakeDocker();
    await run2(first.docker)(job([exportWith("probe", "npm ci")]));
    expect(fs.existsSync(installStampPath(stateDir, "tools", COMMIT))).toBe(true);

    // Without force this is the no-op the ordinary path wants...
    const skipped = fakeDocker();
    await run2(skipped.docker)(job([exportWith("probe", "npm ci")]));
    expect(skipped.containers).toHaveLength(0);

    // ...and a retry that reported success without running anything would be
    // exactly the failure this feature exists to break out of.
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

  /**
   * planning#416 — the half that had nowhere to live at all.
   *
   * A FAILED install's tail rides the failure reason (the test below), and that
   * is the case where the reader already knows something is wrong. The case
   * nikzlabs/shipit#2315 could not settle from a session is this one: the
   * install succeeded, so nothing anywhere says what it wrote, and the two
   * conclusions the reporter and their reviewer drew from the same documentation
   * had no artifact to be checked against.
   */
  it("records what a SUCCESSFUL install printed", async () => {
    const docker = fakeDocker({ logs: "added 41 packages\nbuilt dist/index.js" }).docker;
    await run2(docker)(job([exportWith("probe", "npm ci && npm run build")]));

    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("succeeded");
    expect(record?.output).toContain("built dist/index.js");
  });

  it("bounds a successful install's output exactly as a failure's is bounded", async () => {
    // The constraint is the point, not the number: this text is repo-authored
    // and lands in agent context and in the UI, so an install that SUCCEEDS may
    // not be allowed to say more than one that fails.
    const docker = fakeDocker({ logs: `${"x".repeat(9000)}\nTAIL-MARKER` }).docker;
    await run2(docker)(job([exportWith("probe", "npm ci")]));

    const output = readInstallRecord(pluginsDir(), "tools")?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(2001); // 2000 + the elision mark
    // Clipped from the FRONT, so the end of the run — where a build says what it
    // wrote — survives, and the mark says that something was dropped.
    expect(output.startsWith("…")).toBe(true);
    expect(output).toContain("TAIL-MARKER");
  });

  it("bounds the whole run, not each command, when several exports install", async () => {
    const docker = fakeDocker({ logs: "y".repeat(1800) }).docker;
    await run2(docker)(job([exportWith("a", "npm ci"), exportWith("b", "npm ci")]));

    const output = readInstallRecord(pluginsDir(), "tools")?.output ?? "";
    expect(output.length).toBeLessThanOrEqual(2001);
    // Which export produced what still has to be readable, or a two-plugin
    // repository's output is one undifferentiated wall.
    expect(output).toContain("--- b");
  });

  it("records no output for a skip, because nothing ran to produce any", async () => {
    // An empty `output` here would read as "it ran and printed nothing", which
    // is the wrong half of the one distinction this record exists to make.
    await run2(fakeDocker({ logs: "added 41 packages" }).docker)(job([exportWith("probe", "npm ci")]));
    await run2(fakeDocker({ logs: "added 41 packages" }).docker)(job([exportWith("probe", "npm ci")]));

    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("skipped-stamp");
    expect(record?.output).toBeUndefined();
  });

  it("records a FAILED install with its output — the evidence that had nowhere to live", async () => {
    // A failed install publishes no generation, so before docs/266 this text
    // was returned to the round and then existed nowhere a session could read.
    const failing = fakeDocker({ exit: 1, logs: "npm ERR! missing script: build" });
    const result = await run2(failing.docker)(job([exportWith("probe", "npm run build")]));

    expect(result.ok).toBe(false);
    const record = readInstallRecord(pluginsDir(), "tools");
    expect(record?.outcome).toBe("failed");
    expect(record?.detail).toContain("npm ERR! missing script: build");
    // planning#416 — and in `output` as well, so one field answers "what did the
    // install print" whatever the outcome. A reader that had to parse it back
    // out of a prose reason is a reader that will get it wrong.
    expect(record?.output).toContain("npm ERR! missing script: build");
  });

  it("records a skip as a skip, not as a success", async () => {
    // "The install succeeded" and "the install never ran" point at opposite
    // fixes; a record that flattened them would have settled nothing.
    await run2(fakeDocker().docker)(job([exportWith("probe", "npm ci")]));
    await run2(fakeDocker().docker)(job([exportWith("probe", "npm ci")]));
    expect(readInstallRecord(pluginsDir(), "tools")?.outcome).toBe("skipped-stamp");
  });

  /**
   * **What this block cannot fail on** (review finding, stated rather than
   * implied). `createPluginInstallRunner` now wraps its body so that an
   * unexpected THROW — from the shared-store plan, the promotion, the stamp
   * write, or the netns release, all of which sit outside every inner try —
   * still records `failed` before propagating. That wrapper is not exercised
   * here: every one of those code paths is itself defensive, so this fake
   * daemon cannot make one throw (a store directory that is a plain file, a
   * volume removal that rejects, and a daemon that answers 404 were each tried
   * and each returned cleanly). The wrapper is defence in depth against a
   * future path that is not defensive; the recorded outcomes below are what is
   * actually pinned.
   */
  it("writes nothing for a repository whose exports declare no install", async () => {
    // Nothing ran, and nothing pretends to have: `status` renders the absence
    // as "no install has run", which is the truth.
    await run2(fakeDocker().docker)(job([exportWith("probe")]));
    expect(readInstallRecord(pluginsDir(), "tools")).toBeNull();
  });
});
