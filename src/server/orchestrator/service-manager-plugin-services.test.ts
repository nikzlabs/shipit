/**
 * docs/262 reqs 3, 16, 18 — plugin services inside a session's compose stack.
 *
 * The service path, exercised with the integration fakes rather than real Docker
 * (plan §5): a plugin service must be indistinguishable from the project's own
 * everywhere a session controls, lists, or previews one. Its port is the
 * consuming project's single number now (docs/266), so the cases that matter
 * are collisions and a plugin that ignores what it was given.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_PORT_PROBE_ATTEMPTS,
  PLUGIN_PORT_PROBE_DELAY_MS,
  ServiceManager,
  type ComposeQuery,
  type ComposeRunner,
} from "./service-manager.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { COMPOSE_OVERRIDE_FILE, SESSION_STATE_SUBDIR, SESSION_WORKSPACE_SUBDIR } from "./session-state-dir.js";

let sessionDir: string;

afterEach(() => {
  if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
});

function setup(projectCompose?: string): string {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-plugin-"));
  const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  if (projectCompose !== undefined) {
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), projectCompose);
  }
  return workspaceDir;
}

const emptyQuery: ComposeQuery = () => Promise.resolve("");

function pluginService(overrides: Partial<PluginComposeService> = {}): PluginComposeService {
  return {
    name: "probe",
    sourceName: "probe",
    alias: "probe",
    repo: "tools",
    plugin: "probe",
    preview: "auto",
    port: 4820,
    definition: { image: "node:22-alpine", command: "node server.mjs" },
    credentials: [],
    externalVolumes: [],
    self: false,
    ...overrides,
  };
}

function createManager(
  workspaceDir: string,
  opts: {
    composeRunner?: ComposeRunner;
    noProjectCompose?: boolean;
    /** The consuming project's own secret store, as `secretsLoader` sees it. */
    userSecrets?: () => Record<string, string>;
    /** ShipIt's account-level credentials — must never reach a plugin (req 23). */
    accountEnv?: Record<string, string>;
  } = {},
): ServiceManager {
  return new ServiceManager({
    sessionId: "11111111-2222-3333-4444-555555555555",
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    composeConfig: { file: "docker-compose.yml", dockerSocket: false },
    composeRunner: opts.composeRunner ?? (async () => {}),
    composeQuery: emptyQuery,
    pollIntervalMs: 0,
    ...(opts.userSecrets ? { secretsLoader: async () => opts.userSecrets!() } : {}),
    ...(opts.accountEnv ? { accountAgentEnvLoader: () => opts.accountEnv! } : {}),
    ...(opts.noProjectCompose ? { noProjectCompose: true } : {}),
  });
}

function readOverride(workspaceDir: string): { services: Record<string, Record<string, unknown>> } {
  const overridePath = path.join(workspaceDir, "..", SESSION_STATE_SUBDIR, COMPOSE_OVERRIDE_FILE);
  return parseYaml(fs.readFileSync(overridePath, "utf-8")) as {
    services: Record<string, Record<string, unknown>>;
  };
}

describe("plugin services in the compose stack", () => {
  it("lists a plugin service beside the project's own, carrying its origin (req 3)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(workspaceDir);
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    const names = mgr.getServices().map((s) => s.name).sort();
    expect(names).toEqual(["probe", "web"]);
    expect(mgr.getService("probe")).toMatchObject({
      preview: "auto",
      port: 4820,
      // A plugin's dependencies are its own — the consuming project's
      // `agent.install` has nothing it reads.
      dependsOnInstall: false,
      origin: { kind: "plugin", repo: "tools", alias: "probe", plugin: "probe", sourceName: "probe" },
    });
    expect(mgr.getService("web")?.origin).toBeUndefined();
    await mgr.stop();
  });

  it("writes the plugin's definition into the override, with ShipIt's policy on top", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    const probe = readOverride(workspaceDir).services.probe;
    expect(probe.image).toBe("node:22-alpine");
    expect(probe.labels).toMatchObject({ "shipit-service-name": "probe" });
    await mgr.stop();
  });

  it("starts an auto plugin service and holds a manual one (req 16)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const upCalls: string[][] = [];
    const mgr = createManager(workspaceDir, {
      composeRunner: async (args) => {
        if (args.includes("up")) upCalls.push(args.filter((a) => !a.startsWith("-") && a !== "compose"));
      },
    });
    mgr.setPluginServices([
      pluginService({ name: "auto-one" }),
      pluginService({ name: "manual-one", preview: "manual", port: 4821 }),
    ]);
    await mgr.start();

    const started = upCalls.flat();
    expect(started).toContain("auto-one");
    expect(started).not.toContain("manual-one");
    expect(mgr.getService("manual-one")?.status).toBe("stopped");
    await mgr.stop();
  });

  it("routes a plugin service by its one port — origin and container alike (docs/266-plugin-service-ports req 10)", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    mgr.setPluginServices([pluginService({ port: 5000 })]);
    await mgr.start();

    // The poller normally fills this in; the mapping is what is under test.
    mgr.getService("probe")!.containerIp = "172.20.0.9";
    expect(mgr.resolvePreviewTarget(5000)).toEqual({ containerIp: "172.20.0.9", port: 5000 });
    // There is no second, pinned number to address it by any more.
    expect(mgr.resolvePreviewTarget(4820)).toBeUndefined();
    await mgr.stop();
  });

  it("refuses a plugin service on one of the project's own ports, naming both (docs/266-plugin-service-ports req 7)", async () => {
    // #2325 was this pair resolving silently to the project's service. Both
    // numbers are the consumer's now — one in the compose file, one in
    // `plugins.use` — so it is refused and said out loud instead. It has to
    // reach the session's own logs and not just the orchestrator's stderr: the
    // person who has to act on it cannot read the latter.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const upCalls: string[][] = [];
      const mgr = createManager(workspaceDir, {
        composeRunner: async (args) => {
          if (args.includes("up")) upCalls.push(args.filter((a) => !a.startsWith("-") && a !== "compose"));
        },
      });
      const logs: { name: string; text: string }[] = [];
      mgr.on("service_log", (name: string, text: string) => logs.push({ name, text }));
      mgr.setPluginServices([pluginService({ port: 5173 })]);
      await mgr.start();

      // Refused: it is not started, and it carries the reason rather than
      // vanishing from the list with no explanation anywhere.
      expect(upCalls.flat()).not.toContain("probe");
      // Absent from the override itself, not merely left out of the `up` args —
      // a service still emitted as `manual` would pass the assertion above and
      // still be one `docker compose up` away from running (review finding).
      expect(readOverride(workspaceDir).services.probe).toBeUndefined();
      expect(readOverride(workspaceDir).services.web).toBeDefined();
      const refused = mgr.getService("probe");
      expect(refused?.status).toBe("error");
      expect(refused?.error).toContain("web");
      expect(refused?.error).toContain("5173");
      // The message names the key the fix goes under, in the consumer's file.
      expect(refused?.error).toContain("`plugins.use`");

      // On the refused service's own channel, so it lands beside it in the
      // Logs panel, and on operator stderr too.
      const line = logs.find((l) => l.text.includes("5173"));
      expect(line?.name).toBe("probe");
      expect(mgr.getLogBuffer("probe")).toContain("5173");
      expect(warn.mock.calls.map((args) => String(args[0]))
        .some((l) => l.includes("5173"))).toBe(true);

      // The project's own service is untouched and still routes.
      mgr.getService("web")!.containerIp = "172.20.0.2";
      expect(mgr.resolvePreviewTarget(5173)).toEqual({ containerIp: "172.20.0.2", port: 5173 });
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a user's Start of a refused service, keeping the actionable reason", async () => {
    // The row is `error`, and the client puts a Start button on every `error`
    // row. Without a guard the click reaches `docker compose up <name>` for a
    // service that is not in the override, and the catch replaces the
    // "change `port:`…" text with a raw "no such service" (review finding).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const upCalls: string[][] = [];
      const mgr = createManager(workspaceDir, {
        composeRunner: async (args) => {
          if (args.includes("up")) upCalls.push(args.filter((a) => !a.startsWith("-") && a !== "compose"));
        },
      });
      mgr.setPluginServices([pluginService({ port: 5173 })]);
      await mgr.start();
      const before = mgr.getService("probe")?.error;
      upCalls.length = 0;

      await expect(mgr.startService("probe")).rejects.toThrow(/5173/);
      await expect(mgr.restartService("probe")).rejects.toThrow(/plugins\.use/);

      // No compose call was made, and the reason on the row is untouched.
      expect(upCalls).toEqual([]);
      expect(mgr.getService("probe")?.error).toBe(before);
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("clears the refusal once the consumer moves the port (docs/266-plugin-service-ports req 7)", async () => {
    // The refusal is a row carrying a reason, not a latch. A reconcile rebuilds
    // the map from scratch, so fixing either number has to be enough — a stale
    // `error` surviving it would tell the user their fix did not work.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const mgr = createManager(workspaceDir);
      mgr.setPluginServices([pluginService({ port: 5173 })]);
      await mgr.start();
      expect(mgr.getService("probe")?.status).toBe("error");

      // The consumer edits `plugins.use` and the resolver re-runs.
      mgr.setPluginServices([pluginService({ port: 5174 })]);
      await mgr.reconcile();

      const fixed = mgr.getService("probe");
      expect(fixed?.status).not.toBe("error");
      expect(fixed?.error).toBeUndefined();
      expect(fixed?.port).toBe(5174);
      expect(fixed?.preview).toBe("auto");
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not refuse a plugin service whose port was the previous activation's own (nikzlabs/shipit#2379)", async () => {
	    // A plugin service registered in a previous start() call is still in
	    // the services map with origin set. The port clash check must skip
	    // entries with origin — they are plugin services, not the project's own.
	    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	    try {
	      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
	      const upCalls: string[][] = [];
	      const mgr = createManager(workspaceDir, {
	        composeRunner: async (args) => {
	          if (args.includes("up")) upCalls.push(args.filter((a) => !a.startsWith("-") && a !== "compose"));
	        },
	      });
	      // First start: the plugin is admitted and registered with origin.
	      mgr.setPluginServices([pluginService({ name: "probe", port: 4310 })]);
	      await mgr.start();
	      expect(mgr.getService("probe")?.status).not.toBe("error");
	      expect(mgr.getService("probe")?.origin).toBeDefined();
	      upCalls.length = 0;

	      // Second start without reconcile: stale plugin entry from the first
	      // start is still in the map. Without the #2379 fix it clashes with
	      // itself and is refused as "this project's own service".
	      mgr.setPluginServices([pluginService({ name: "probe", port: 4310 })]);
	      await mgr.start();
	      expect(mgr.getService("probe")?.status).not.toBe("error");
	      expect(mgr.getService("probe")?.error).toBeUndefined();
	      await mgr.stop();
	    } finally {
	      warn.mockRestore();
	    }
	  });

	  describe("a plugin that ignores the port it was given (docs/266-plugin-service-ports req 8)", () => {
    /** Reach the one-shot probe without waiting out its real delays. */
    interface Probe { armPluginPortProbe(name: string, attempt?: number): void }

    /** A port nothing is listening on: bind one, learn its number, release it. */
    async function freePort(): Promise<number> {
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as net.AddressInfo).port;
      await new Promise<void>((r) => srv.close(() => r()));
      return port;
    }

    /**
     * Arm the probe and run the clock through `rounds` of its retry schedule.
     * `onRound` runs between rounds, which is how the slow-start case binds its
     * port part-way through.
     */
    async function runProbe(
      port: number,
      opts: { rounds?: number; onRound?: (round: number) => Promise<void> } = {},
    ): Promise<{ name: string; text: string }[]> {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
      const mgr = createManager(workspaceDir);
      const logs: { name: string; text: string }[] = [];
      mgr.on("service_log", (name: string, text: string) => logs.push({ name, text }));
      mgr.setPluginServices([pluginService({ port })]);
      await mgr.start();

      // What the poller would have established before `onRunning` fires.
      const svc = mgr.getService("probe")!;
      svc.containerIp = "127.0.0.1";
      svc.status = "running";

      const rounds = opts.rounds ?? PLUGIN_PORT_PROBE_ATTEMPTS;
      vi.useFakeTimers();
      try {
        (mgr as unknown as Probe).armPluginPortProbe("probe");
        for (let round = 1; round <= rounds; round++) {
          await vi.advanceTimersByTimeAsync(PLUGIN_PORT_PROBE_DELAY_MS + 1_000);
          await opts.onRound?.(round);
        }
      } finally {
        vi.useRealTimers();
      }
      await mgr.stop();
      return logs;
    }

    it("says so, naming the variable the plugin should have read", async () => {
      const logs = await runProbe(await freePort());
      const line = logs.find((l) => l.text.includes("nothing is listening"));
      // On the service's own channel, beside it in the Logs panel.
      expect(line?.name).toBe("probe");
      // The consumer cannot fix the plugin's code — but they can only report it
      // if the message says what the plugin got wrong.
      expect(line?.text).toContain("SHIPIT_PLUGIN_PORT");
      expect(line?.text).toContain("tools");
    });

    it("says nothing when the plugin did bind the port it was given", async () => {
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as net.AddressInfo).port;
      try {
        const logs = await runProbe(port);
        expect(logs.find((l) => l.text.includes("nothing is listening"))).toBeUndefined();
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });

    it("says nothing about a plugin that is merely slow to bind (review finding)", async () => {
      // The case the probe delay exists for, and the one a single check at a
      // fixed deadline got WRONG: `npm ci` outruns the first check, the server
      // binds afterwards, and the preview is fine. A report here would be a
      // permanent, wrong diagnosis in the Logs panel.
      const port = await freePort();
      const srv = net.createServer();
      try {
        const logs = await runProbe(port, {
          onRound: async (round) => {
            // Two checks have already been refused by the time it binds.
            if (round !== 2) return;
            await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
          },
        });
        expect(logs.find((l) => l.text.includes("nothing is listening"))).toBeUndefined();
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });

    it("stops probing a service that answered, however many polls arrive", async () => {
      // `onRunning` fires on EVERY running poll, not just the transition, so a
      // settled service must refuse to re-arm or the steady state is a TCP
      // connect every poll for the session's life.
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as net.AddressInfo).port;
      try {
        const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
        const mgr = createManager(workspaceDir);
        mgr.setPluginServices([pluginService({ port })]);
        await mgr.start();
        const svc = mgr.getService("probe")!;
        svc.containerIp = "127.0.0.1";
        svc.status = "running";

        vi.useFakeTimers();
        try {
          (mgr as unknown as Probe).armPluginPortProbe("probe");
          await vi.advanceTimersByTimeAsync(PLUGIN_PORT_PROBE_DELAY_MS + 1_000);
          // Settled. Every later poll must be a no-op.
          for (let poll = 0; poll < 5; poll++) {
            (mgr as unknown as Probe).armPluginPortProbe("probe");
          }
          expect(
            (mgr as unknown as { portProbeTimers: Map<string, unknown> }).portProbeTimers.size,
          ).toBe(0);
        } finally {
          vi.useRealTimers();
        }
        await mgr.stop();
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });
  });

  it("routes a project service by its own port, unchanged", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(workspaceDir);
    await mgr.start();
    mgr.getService("web")!.containerIp = "172.20.0.2";
    expect(mgr.resolvePreviewTarget(3000)).toEqual({ containerIp: "172.20.0.2", port: 3000 });
    await mgr.stop();
  });

  it("reports whether the plugin service set actually changed", () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir);
    expect(mgr.setPluginServices([pluginService()])).toBe(true);
    expect(mgr.setPluginServices([pluginService()])).toBe(false);
    expect(mgr.setPluginServices([pluginService({ port: 5000 })])).toBe(true);
  });

  // A plugin service gets `/project` read-write (reqs 18, 21), so third-party
  // code can rewrite the project's own compose file — and every later `up`
  // re-reads it from disk. Validating only at start() would execute the
  // rewritten file with none of the checks it was admitted under.
  it("refuses a later `up` when the project's compose file stopped validating", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    x-shipit-preview: manual\n");
    const mgr = createManager(workspaceDir);
    await mgr.start();

    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    privileged: true\n",
    );
    await expect(mgr.startService("web")).rejects.toThrow(/privileged/);
    expect(mgr.getService("web")?.status).toBe("error");
    await mgr.stop();
  });

  // planning#386 — the same rewrite, with the payload that used to pass every
  // check: a host bind expressed as a top-level named volume. The service's own
  // `volumes:` list says `escape:/host`, which is indistinguishable from an
  // ordinary named-volume mount, and the block that carries the bind is not a
  // service — so `validateServiceSecurity` never saw it.
  it("refuses a later `up` when the rewrite hides a host bind in the volumes block", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    x-shipit-preview: manual\n");
    const mgr = createManager(workspaceDir);
    await mgr.start();

    fs.writeFileSync(
      path.join(workspaceDir, "docker-compose.yml"),
      "services:\n  web:\n    image: node:20\n    volumes:\n      - escape:/host\n"
      + "volumes:\n  escape:\n    driver_opts:\n      type: none\n      device: /\n      o: bind\n",
    );
    await expect(mgr.startService("web")).rejects.toThrow(/driver_opts/);
    expect(mgr.getService("web")?.status).toBe("error");
    await mgr.stop();
  });

  it("never runs a compose file the project did not declare", async () => {
    // A conventional `docker-compose.yml` that no `compose:` block names is not
    // this session's stack, and declaring a plugin must not turn it into one.
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    expect(mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    expect(commands.flat()).not.toContain("docker-compose.yml");
    await mgr.stop();
  });

  it("runs a stack made only of plugin services when the project declares no compose file (req 5)", async () => {
    const workspaceDir = setup(); // no docker-compose.yml at all
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    expect(mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
    // The absent project file is dropped from the argument vector rather than
    // failing every command.
    const up = commands.find((c) => c.includes("up"))!;
    expect(up).not.toContain("docker-compose.yml");
    expect(up.filter((a) => a === "-f")).toHaveLength(1);
    await mgr.stop();
  });

  it("starts nothing when there is neither a project compose file nor a plugin service", async () => {
    const workspaceDir = setup();
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    await mgr.start();
    expect(commands.some((c) => c.includes("up"))).toBe(false);
    expect(mgr.getServices()).toEqual([]);
  });
});

/**
 * docs/262 req 23 — the whole path, end to end: a plugin's manifest declares a
 * credential NAME, the consuming project's secret store holds the value, and
 * the container the daemon is asked to create has it.
 *
 * The defect this closes was a gap between the two halves — the Plugins card
 * reported the name satisfied while the compose path delivered nothing.
 */
describe("plugin credential delivery, end to end (req 23)", () => {
  function envOf(workspaceDir: string, service = "probe"): Record<string, string> {
    return (readOverride(workspaceDir).services[service].environment ?? {}) as Record<string, string>;
  }

  it("puts the project's stored value into the plugin service the daemon creates", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir, {
      userSecrets: () => ({ FAL_KEY: "sk-live", UNRELATED: "no" }),
    });
    mgr.setPluginServices([pluginService({ credentials: ["FAL_KEY", "OPENAI_API_KEY"] })]);
    await mgr.start();

    const env = envOf(workspaceDir);
    expect(env.FAL_KEY).toBe("sk-live");
    // Declared but unset → omitted, so the gap stays named on the card rather
    // than becoming an authentication error inside the plugin.
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Stored but never declared → not a plugin's to receive.
    expect(env.UNRELATED).toBeUndefined();
    await mgr.stop();
  });

  it("never gives a plugin ShipIt's own account-level credentials", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir, {
      userSecrets: () => ({}),
      accountEnv: { OPENAI_API_KEY: "platform-token" },
    });
    mgr.setPluginServices([pluginService({ credentials: ["OPENAI_API_KEY"] })]);
    await mgr.start();

    expect(JSON.stringify(readOverride(workspaceDir))).not.toContain("platform-token");
    await mgr.stop();
  });

  it("leaves the project's own services untouched", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir, { userSecrets: () => ({ FAL_KEY: "sk-live" }) });
    mgr.setPluginServices([pluginService({ credentials: ["FAL_KEY"] })]);
    await mgr.start();

    expect(envOf(workspaceDir, "web").FAL_KEY).toBeUndefined();
    await mgr.stop();
  });

  it("a saved key reaches a running plugin service", async () => {
    // The values live in the override itself, so a secret save has to rewrite
    // it — the env-file path this branch was written for only ever changed a
    // file the override already pointed at.
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    let stored: Record<string, string> = {};
    const upCalls: string[][] = [];
    const mgr = createManager(workspaceDir, {
      userSecrets: () => stored,
      composeRunner: async (args) => {
        if (args.includes("up")) upCalls.push(args);
      },
    });
    mgr.setPluginServices([pluginService({ credentials: ["FAL_KEY"] })]);
    await mgr.start();
    expect(envOf(workspaceDir).FAL_KEY).toBeUndefined();

    stored = { FAL_KEY: "sk-live" };
    await mgr.refreshSecrets();

    expect(envOf(workspaceDir).FAL_KEY).toBe("sk-live");
    // …and the auto service is re-upped, so the daemon reads the new value.
    expect(upCalls.length).toBeGreaterThan(1);
    await mgr.stop();
  });

  it("a secret save does not delete the plugin services from the stack", async () => {
    const workspaceDir = setup("services:\n  web:\n    image: node:20\n");
    const mgr = createManager(workspaceDir, { userSecrets: () => ({}) });
    mgr.setPluginServices([pluginService({ credentials: ["FAL_KEY"] })]);
    await mgr.start();

    await mgr.refreshSecrets();
    expect(Object.keys(readOverride(workspaceDir).services).sort()).toEqual(["probe", "web"]);
    await mgr.stop();
  });

  /**
   * The regression this file's own widening caused, and the reason it went a
   * day unnoticed: an absent environment variable produces no error anywhere.
   *
   * `refreshSecrets()` regenerates the override whenever the session surfaces a
   * plugin service — the branch directly above needs that. It built its own
   * option object and omitted `serviceEnvFiles`, which was harmless while the
   * branch was Docker-secrets-only (that mode doesn't use `env_file:`) and
   * silently fatal afterwards: saving ANY secret stripped the `env_file:` line
   * from every project service, so the whole stack lost its `x-shipit-secrets`
   * on the next start and kept losing them for the rest of the session.
   *
   * Asserted on the project service, on the save path, with a plugin present —
   * all three are required to reproduce it.
   *
   * The save also newly satisfies a credential the PLUGIN declared, so the
   * override provably gets rewritten between the two reads. Without that, a
   * `refreshSecrets()` that stopped regenerating the override at all would
   * leave `start()`'s correct `env_file:` in place and the test would pass for
   * the wrong reason.
   */
  it("a secret save keeps every project service's env_file — the plugin path must not strip it", async () => {
    const workspaceDir = setup(
      "services:\n  web:\n    image: node:20\n    x-shipit-secrets:\n      - GITHUB_TOKEN\n",
    );
    let stored: Record<string, string> = { GITHUB_TOKEN: "ghp_old" };
    const mgr = createManager(workspaceDir, { userSecrets: () => stored });
    mgr.setPluginServices([pluginService({ credentials: ["FAL_KEY"] })]);
    await mgr.start();

    const envFile = path.join(sessionDir, "service-env", "11111111-2222-3333-4444-555555555555", ".env.web");
    expect(readOverride(workspaceDir).services.web.env_file).toEqual([envFile]);
    expect(envOf(workspaceDir).FAL_KEY).toBeUndefined();

    stored = { GITHUB_TOKEN: "ghp_new", FAL_KEY: "sk-live" };
    await mgr.refreshSecrets();

    // The override was rewritten — the plugin's newly-satisfied credential is in it…
    expect(envOf(workspaceDir).FAL_KEY).toBe("sk-live");
    // …and that rewrite still points the project service at its env file…
    expect(readOverride(workspaceDir).services.web.env_file).toEqual([envFile]);
    // …whose contents carry the new value.
    expect(fs.readFileSync(envFile, "utf-8")).toContain("GITHUB_TOKEN=ghp_new");
    await mgr.stop();
  });
});
