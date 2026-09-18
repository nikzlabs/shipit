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
    userSecrets?: () => Record<string, string>;
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

    mgr.getService("probe")!.containerIp = "172.20.0.9";
    expect(mgr.resolvePreviewTarget(5000)).toEqual({ containerIp: "172.20.0.9", port: 5000 });
    expect(mgr.resolvePreviewTarget(4820)).toBeUndefined();
    await mgr.stop();
  });

  it("refuses a plugin service on one of the project's own ports, naming both (docs/266-plugin-service-ports req 7)", async () => {
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

      expect(upCalls.flat()).not.toContain("probe");
      expect(readOverride(workspaceDir).services.probe).toBeUndefined();
      expect(readOverride(workspaceDir).services.web).toBeDefined();
      const refused = mgr.getService("probe");
      expect(refused?.status).toBe("error");
      expect(refused?.error).toContain("web");
      expect(refused?.error).toContain("5173");
      expect(refused?.error).toContain("`plugins.use`");

      const line = logs.find((l) => l.text.includes("5173"));
      expect(line?.name).toBe("probe");
      expect(mgr.getLogBuffer("probe")).toContain("5173");
      expect(warn.mock.calls.map((args) => String(args[0]))
        .some((l) => l.includes("5173"))).toBe(true);

      mgr.getService("web")!.containerIp = "172.20.0.2";
      expect(mgr.resolvePreviewTarget(5173)).toEqual({ containerIp: "172.20.0.2", port: 5173 });
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a user's Start of a refused service, keeping the actionable reason", async () => {
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

      expect(upCalls).toEqual([]);
      expect(mgr.getService("probe")?.error).toBe(before);
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("clears the refusal once the consumer moves the port (docs/266-plugin-service-ports req 7)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const mgr = createManager(workspaceDir);
      mgr.setPluginServices([pluginService({ port: 5173 })]);
      await mgr.start();
      expect(mgr.getService("probe")?.status).toBe("error");

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

  it("does not count a plugin service's own outgoing instance as an occupant (nikzlabs/shipit#2379)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      const mgr = createManager(workspaceDir);
      mgr.setPluginServices([pluginService({ port: 4310 })]);
      await mgr.start();
      expect(mgr.getService("probe")?.status).not.toBe("error");
      expect(mgr.getService("probe")?.origin).toBeDefined();

      mgr.setPluginServices([pluginService({ port: 4310 })]);
      await mgr.start();

      const again = mgr.getService("probe");
      expect(again?.status).not.toBe("error");
      expect(again?.error).toBeUndefined();
      expect(again?.port).toBe(4310);
      expect(readOverride(workspaceDir).services.probe).toBeDefined();
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not count a project service the compose file no longer declares (nikzlabs/shipit#2379)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['4310:4310']\n");
      const mgr = createManager(workspaceDir);
      mgr.setPluginServices([]);
      await mgr.start();
      expect(mgr.getService("web")?.port).toBe(4310);

      fs.writeFileSync(
        path.join(workspaceDir, "docker-compose.yml"),
        "services:\n  api:\n    image: node:20\n    ports: ['3000:3000']\n",
      );
      mgr.setPluginServices([pluginService({ port: 4310 })]);
      await mgr.start();

      expect(mgr.getService("probe")?.status).not.toBe("error");
      expect(mgr.getService("probe")?.error).toBeUndefined();
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("names the occupant and where each port is written (nikzlabs/shipit#2379)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const mgr = createManager(workspaceDir);
      mgr.setPluginServices([pluginService({ sourceName: "server", alias: "probe", port: 5173 })]);
      await mgr.start();

      const error = mgr.getService("probe")?.error ?? "";
      expect(error).toContain("this project's own service `web` (`docker-compose.yml`)");
      expect(error).toContain("change `port:` for `server` under the `plugins.use` entry in `shipit.yaml` whose alias is `probe`");
      expect(error).toContain("give `web` a different port in `docker-compose.yml`");
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

  it("tells each side of an ambiguous preview port where its own number lives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const workspaceDir = setup("services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
      const mgr = createManager(workspaceDir);
      const logs: { name: string; text: string }[] = [];
      mgr.on("service_log", (name: string, text: string) => logs.push({ name, text }));
      // Inject the collision after admission, which would otherwise reject it.
      mgr.setPluginServices([]);
      await mgr.start();
      mgr.getService("web")!.port = 5173;
      (mgr as unknown as { warnOnAmbiguousPreviewPorts(): void }).warnOnAmbiguousPreviewPorts();
      expect(logs).toEqual([]);

      mgr.setPluginServices([pluginService({ sourceName: "server", alias: "probe", port: 4310 })]);
      await mgr.start();
      mgr.getService("probe")!.port = 5173;
      (mgr as unknown as { warnOnAmbiguousPreviewPorts(): void }).warnOnAmbiguousPreviewPorts();

      const text = logs.map((l) => l.text).join("");
      expect(text).toContain("this project's own service `web` (`docker-compose.yml`)");
      expect(text).toContain("the plugin service `probe` (the `plugins.use` entry in `shipit.yaml` whose alias is `probe`)");
      expect(text).toContain("change `port:` for `server` under the `plugins.use` entry in `shipit.yaml` whose alias is `probe`");
      expect(text).toContain("give `web` a different port in `docker-compose.yml`");
      await mgr.stop();
    } finally {
      warn.mockRestore();
    }
  });

	  describe("a plugin that ignores the port it was given (docs/266-plugin-service-ports req 8)", () => {
    interface Probe { armPluginPortProbe(name: string, attempt?: number): void }

    async function freePort(): Promise<number> {
      const srv = net.createServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as net.AddressInfo).port;
      await new Promise<void>((r) => srv.close(() => r()));
      return port;
    }

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
      expect(line?.name).toBe("probe");
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
      const port = await freePort();
      const srv = net.createServer();
      try {
        const logs = await runProbe(port, {
          onRound: async (round) => {
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
    const workspaceDir = setup();
    const commands: string[][] = [];
    const mgr = createManager(workspaceDir, {
      noProjectCompose: true,
      composeRunner: async (args) => { commands.push(args); },
    });
    mgr.setPluginServices([pluginService()]);
    await mgr.start();

    expect(mgr.getServices().map((s) => s.name)).toEqual(["probe"]);
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
    expect(env.OPENAI_API_KEY).toBeUndefined();
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

    expect(envOf(workspaceDir).FAL_KEY).toBe("sk-live");
    expect(readOverride(workspaceDir).services.web.env_file).toEqual([envFile]);
    expect(fs.readFileSync(envFile, "utf-8")).toContain("GITHUB_TOKEN=ghp_new");
    await mgr.stop();
  });
});
