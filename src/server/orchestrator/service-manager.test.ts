import { describe, it, expect, afterEach, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ServiceManager,
  NETWORK_JOIN_TIMEOUT_MS,
  STARTING_WATCHDOG_MS,
  STARTING_TIMEOUT_MESSAGE,
  GATED_TEARDOWN_GRACE_MARGIN_MS,
  UP_SILENCE_TIMEOUT_MS,
  UP_STALLED_MESSAGE,
  COMPOSE_LOG_PREFIX,
  MAX_COMPOSE_LOG_LINE,
  type ComposeRunner,
  type ComposeQuery,
  type SecretsStatusInternalSnapshot,
} from "./service-manager.js";
import { DEFAULT_STOP_GRACE_PERIOD_MS } from "./compose-generator.js";
import { SESSION_WORKSPACE_SUBDIR, SESSION_STATE_SUBDIR } from "./session-state-dir.js";
import { serializeStackOp } from "./stack-op-queue.js";
import type { PluginCredentialDeclaration } from "../shared/plugin-credentials.js";
import { markPreviewReachable, forgetStackUp } from "./preview-timing.js";

function makeSessionDir(prefix: string): string {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(sessionDir, SESSION_WORKSPACE_SUBDIR), { recursive: true });
  return sessionDir;
}

function stateOf(workspaceDir: string): string {
  return path.resolve(workspaceDir, "..", SESSION_STATE_SUBDIR);
}

function serviceEnvOf(workspaceDir: string): string {
  return path.resolve(workspaceDir, "..", "service-env");
}

function serviceEnvFile(workspaceDir: string, sessionId: string, svc: string): string {
  return path.join(serviceEnvOf(workspaceDir), sessionId, `.env.${svc}`);
}

// Stubbing composeRunner alone leaves queries connected to the real Docker daemon.
const emptyComposeQuery: ComposeQuery = () => Promise.resolve("");

describe("ServiceManager", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  const fakeComposeRunner: ComposeRunner = () =>
    Promise.reject(new Error("docker not available in test"));

  function createManager(dir: string, composeRunner: ComposeRunner = fakeComposeRunner) {
    return new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
    });
  }

  it("initializes with no services", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(dir);
    expect(mgr.getServices()).toEqual([]);
    expect(mgr.started).toBe(false);
  });

  it("reports whether setOverlayDepDirs changed the set (#2426)", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n");
    const mgr = createManager(dir);
    const pairs = [{ depDir: "node_modules", volumeName: "shipit-abc_overlay-aaaa" }];

    expect(mgr.setOverlayDepDirs(pairs)).toBe(true);
    expect(mgr.setOverlayDepDirs([...pairs])).toBe(false);
    expect(mgr.setOverlayDepDirs([])).toBe(true);
    expect(mgr.setOverlayDepDirs([])).toBe(false);
  });

  it("detaches stale egress before up and contains the service after up", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    user: \"1001:1001\"\n    x-shipit-preview: manual\n");
    const events: string[] = [];
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: async (args) => {
        if (args.includes("up")) events.push("up");
      },
      composeQuery: emptyComposeQuery,
      pollIntervalMs: 0,
      prepareContainedStartFn: async () => { events.push("prepare"); },
      containServicesFn: async () => { events.push("contain"); },
    });
    await mgr.start();
    await mgr.startService("web");
    expect(events).toEqual(["prepare", "up", "contain"]);
    await mgr.stop();
  });

  it("rejects invalid compose files during start", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
    const mgr = createManager(dir);
    await expect(mgr.start()).rejects.toThrow("privileged");
  });

  it("generates override file on start attempt", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(dir);
    try { await mgr.start(); } catch { /* expected */ }
    const overridePath = path.join(stateOf(dir), "compose.override.yml");
    expect(fs.existsSync(overridePath)).toBe(true);
    const content = fs.readFileSync(overridePath, "utf-8");
    expect(content).toContain("shipit-parent-session: test-session");
    expect(content).toContain("shipit-service-name: web");
  });

  it("classifies services correctly based on ports and x-shipit-preview", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["5173:5173"]
  db:
    image: postgres:16
    x-shipit-preview: manual
  worker:
    image: node:20
`);
    const mgr = createManager(dir);
    try { await mgr.start(); } catch { /* expected — no docker */ }

    const services = mgr.getServices();
    const web = services.find(s => s.name === "web");
    const db = services.find(s => s.name === "db");
    const worker = services.find(s => s.name === "worker");

    expect(web?.preview).toBe("auto");
    expect(web?.port).toBe(5173);
    expect(db?.preview).toBe("manual");
    expect(worker?.preview).toBe("manual");
  });

  it("allows the ops session proxy socket mount and starts it automatically", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.3.0
    x-shipit-preview: auto
    x-shipit-depends-on-install: false
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);

    const composeCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      composeCalls.push(args);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "inspect") {
        return Promise.resolve(JSON.stringify([{
          NetworkSettings: { Networks: { "shipit-session-test-session": { IPAddress: "172.20.0.9" } } },
        }]));
      }
      return Promise.resolve(JSON.stringify({
        Service: "docker-socket-proxy",
        ID: "proxy-container",
        State: "running",
        ExitCode: 0,
      }));
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      opsSession: true,
      pollIntervalMs: 0,
    });

    await mgr.start();

    expect(mgr.getService("docker-socket-proxy")).toMatchObject({
      preview: "auto",
      status: "running",
      dependsOnInstall: false,
    });
    expect(composeCalls.some((args) =>
      args.includes("up") && args.includes("docker-socket-proxy"),
    )).toBe(true);
  });

  it("rejects the ops proxy socket mount for ordinary sessions", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:0.3.0
    x-shipit-preview: auto
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
`);

    const mgr = createManager(dir);

    await expect(mgr.start()).rejects.toThrow("server-created ops sessions");
    expect(mgr.getServices()).toEqual([]);
  });

  it("extracts host port from port mapping", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["8080:80"]
`);
    const mgr = createManager(dir);
    try { await mgr.start(); } catch { /* expected */ }
    const web = mgr.getService("web");
    expect(web?.port).toBe(80);
  });

  it("extracts container port from IP:host:container format", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["127.0.0.1:5173:5173"]
`);
    const mgr = createManager(dir);
    try { await mgr.start(); } catch { /* expected */ }
    const web = mgr.getService("web");
    expect(web?.port).toBe(5173);
  });

  it("extracts host port from port/protocol format", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ["3000:3000/tcp"]
`);
    const mgr = createManager(dir);
    try { await mgr.start(); } catch { /* expected */ }
    const web = mgr.getService("web");
    expect(web?.port).toBe(3000);
  });

  it("emits service_status events", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(dir);

    const events: { name: string; status: string }[] = [];
    mgr.on("service_status", (svc) => {
      events.push({ name: svc.name, status: svc.status });
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(events.some(e => e.name === "web" && e.status === "error")).toBe(true);
  });

  it("does not run `compose up` when every service is manual", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  dev:
    image: node:22
    ports: ["3000:3000"]
    x-shipit-preview: manual
`);

    const composeCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      composeCalls.push(args);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = () => Promise.resolve("");

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();

    expect(mgr.getService("dev")?.preview).toBe("manual");
    expect(mgr.getService("dev")?.status).toBe("stopped");
    expect(mgr.started).toBe(true);

    const upCalls = composeCalls.filter((args) => args.includes("up"));
    expect(upCalls).toHaveLength(0);
  });

  it("joins the orchestrator to the session network when the first manual service starts (all-manual stack)", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  dev:
    image: node:22
    ports: ["3000:3000"]
    x-shipit-preview: manual
`);

    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = () => Promise.resolve("");
    const networkJoinCalls: string[] = [];

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
      networkJoinFn: (name) => {
        networkJoinCalls.push(name);
        return Promise.resolve();
      },
    });

    await mgr.start();

    const callsAfterStart = networkJoinCalls.length;
    expect(callsAfterStart).toBeGreaterThanOrEqual(1);

    await mgr.startService("dev");

    expect(networkJoinCalls.length).toBeGreaterThan(callsAfterStart);
    expect(networkJoinCalls[networkJoinCalls.length - 1]).toBe(
      "shipit-session-test-session",
    );
  });

  it("throws for unknown service in startService", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n");
    const mgr = createManager(dir);
    await expect(mgr.startService("nonexistent")).rejects.toThrow("Unknown service");
  });

  it("throws for unknown service in stopService", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n");
    const mgr = createManager(dir);
    await expect(mgr.stopService("nonexistent")).rejects.toThrow("Unknown service");
  });

  it("throws for unknown service in restartService", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n");
    const mgr = createManager(dir);
    await expect(mgr.restartService("nonexistent")).rejects.toThrow("Unknown service");
  });

  it("registers an 'error' listener on the log follower so a failed docker exec can't crash the process", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = mgr.streamLogs("web");
    const logProcesses = (mgr as unknown as { logProcesses: Map<string, ChildProcess> }).logProcesses;
    const proc = logProcesses.get("web");
    expect(proc).toBeDefined();
    expect(proc!.listenerCount("error")).toBeGreaterThan(0);

    expect(() => proc!.emit("error", new Error("spawn docker ENOENT"))).not.toThrow();
    expect(logProcesses.has("web")).toBe(false);

    cleanup();
    warn.mockRestore();
  });
});

describe("ServiceManager lifecycle (mocked docker)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-lc-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  function createMockedManager(
    dir: string,
    queryResponses: Record<string, string> = {},
  ) {
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      return Promise.resolve(queryResponses[key] ?? "");
    };
    return new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
  }

  it("full start lifecycle emits stack_ready", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const psOutput = JSON.stringify({
      Service: "web", ID: "abc123", State: "running", ExitCode: 0,
    });
    const inspectOutput = JSON.stringify([{
      NetworkSettings: {
        Networks: { "shipit-session-test-session": { IPAddress: "172.20.0.2" } },
      },
    }]);

    const mgr = createMockedManager(dir, { ps: psOutput, inspect: inspectOutput });
    let stackReady = false;
    mgr.on("stack_ready", () => { stackReady = true; });

    await mgr.start();

    expect(mgr.started).toBe(true);
    expect(stackReady).toBe(true);
    const web = mgr.getService("web");
    expect(web?.status).toBe("running");
    expect(web?.containerIp).toBe("172.20.0.2");
  });

  it("getServices derives an agent-reachable url for running services with a known IP+port (GH #1509)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const psOutput = JSON.stringify({
      Service: "web", ID: "abc123", State: "running", ExitCode: 0,
    });
    const inspectOutput = JSON.stringify([{
      NetworkSettings: {
        Networks: { "shipit-session-test-session": { IPAddress: "172.20.0.2" } },
      },
    }]);

    const mgr = createMockedManager(dir, { ps: psOutput, inspect: inspectOutput });
    await mgr.start();

    const running = mgr.getServices().find((s) => s.name === "web");
    expect(running?.url).toBe("http://172.20.0.2:5173/");

    expect(mgr.getService("web")).not.toHaveProperty("url");
  });

  it("getServices omits url when a service has a port but no detected IP (GH #1509)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const mgr = createMockedManager(dir, {});
    try { await mgr.start(); } catch { /* no real docker — registration is enough */ }

    const web = mgr.getServices().find((s) => s.name === "web");
    expect(web?.port).toBe(5173);
    expect(web?.status).not.toBe("running");
    expect(web?.url).toBeUndefined();
  });

  it("pollStatus maps exited with non-zero to error", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const psRunning = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
    const psCrashed = JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 1 });
    let psResponse = psRunning;

    const mgr = createMockedManager(dir, {
      get ps() { return psResponse; },
      inspect: JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
    });

    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("running");

    psResponse = psCrashed;
    const events: string[] = [];
    mgr.on("service_status", (svc) => events.push(svc.status));

    await mgr.reconcile();
    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
  });

  it("stop kills log processes and runs compose down", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const psOutput = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
    const mgr = createMockedManager(dir, {
      ps: psOutput,
      inspect: JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
    });

    await mgr.start();
    expect(mgr.started).toBe(true);

    await mgr.stop();
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("stop({ removeVolumes: true }) appends --volumes to compose down", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const composeCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      composeCalls.push(args);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find((a) => a === "ps" || a === "inspect") ?? args[0];
      if (key === "ps") {
        return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    composeCalls.length = 0;

    await mgr.stop({ removeVolumes: true });

    const downCall = composeCalls.find((args) => args.includes("down"));
    expect(downCall).toBeDefined();
    expect(downCall).toContain("--remove-orphans");
    expect(downCall).toContain("--volumes");
  });

  it("stop() omits --volumes by default (resumable)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const composeCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      composeCalls.push(args);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find((a) => a === "ps" || a === "inspect") ?? args[0];
      if (key === "ps") {
        return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    composeCalls.length = 0;

    await mgr.stop();

    const downCall = composeCalls.find((args) => args.includes("down"));
    expect(downCall).toBeDefined();
    expect(downCall).not.toContain("--volumes");
  });

  it("reconcile clears startError on success", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const psOutput = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
    const mgr = createMockedManager(dir, {
      ps: psOutput,
      inspect: JSON.stringify([{ NetworkSettings: { Networks: {} } }]),
    });

    mgr.startError = "previous error";
    await mgr.start();
    mgr.startError = "stale error";
    await mgr.reconcile();
    expect(mgr.startError).toBeNull();
  });

  describe("projectComposeFailure", () => {
    it("is null while the compose file parses", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      const mgr = createMockedManager(dir);
      await mgr.start();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("records a REFUSED file with the rule's own message", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);

      await expect(mgr.start()).rejects.toThrow(/privileged/);

      expect(mgr.getServices()).toEqual([]);
      expect(mgr.projectComposeFailure?.kind).toBe("refused");
      expect(mgr.projectComposeFailure?.message).toContain("web");
      expect(mgr.projectComposeFailure?.message).toContain("privileged");
    });

    it("records a file it could not parse as MALFORMED, not refused", async () => {
      const dir = setup();
      writeCompose(dir, "not-a-compose-file: true\n");
      const mgr = createMockedManager(dir);

      await expect(mgr.start()).rejects.toThrow();
      expect(mgr.projectComposeFailure?.kind).toBe("malformed");
    });

    it("retracts the failure once the file parses again", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();
      expect(mgr.projectComposeFailure).not.toBeNull();

      writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      await mgr.reconcile();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("drops a stale failure when the project stops declaring a compose file", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();

      mgr.updateComposeConfig(
        { file: "other-compose.yml", dockerSocket: false },
        { noProjectCompose: true },
      );
      await mgr.reconcile();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("drops the failure the moment the compose config changes, before any reconcile", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();
      expect(mgr.projectComposeFailure).not.toBeNull();

      mgr.updateComposeConfig({ file: "deploy/compose.yml", dockerSocket: false });
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("keeps the failure when a reconcile dies before it reaches the parse", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      let networkCalls = 0;
      const mgr = new ServiceManager({
        sessionId: "test-session",
        workspaceDir: dir,
        serviceEnvDir: serviceEnvOf(dir),
        composeConfig: { file: "docker-compose.yml", dockerSocket: false },
        composeRunner: () => Promise.resolve(),
        composeQuery: () => Promise.resolve(""),
        pollIntervalMs: 0,
        ensureSessionNetworkModeFn: () =>
          ++networkCalls > 1 ? Promise.reject(new Error("daemon unreachable")) : Promise.resolve(),
      });

      await expect(mgr.start()).rejects.toThrow(/privileged/);
      const recorded = mgr.projectComposeFailure;
      expect(recorded?.kind).toBe("refused");

      await expect(mgr.reconcile()).rejects.toThrow("daemon unreachable");
      expect(mgr.projectComposeFailure).toEqual(recorded);
    });

    it("retracts the failure when the secrets-status refresh re-reads a fixed file", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();
      expect(mgr.projectComposeFailure).not.toBeNull();

      writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      await mgr.refreshSecretsStatus();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("records a refusal the secrets-status refresh is the first to see", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      const mgr = createMockedManager(dir);
      await mgr.start();
      expect(mgr.projectComposeFailure).toBeNull();

      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      await mgr.refreshSecretsStatus();
      expect(mgr.projectComposeFailure?.kind).toBe("refused");
    });

    it("files no reason against a project that declares no compose file at all", async () => {
      const dir = setup();
      const mgr = createMockedManager(dir);
      mgr.updateComposeConfig(
        { file: "docker-compose.yml", dockerSocket: false },
        { noProjectCompose: true },
      );
      await mgr.refreshSecretsStatus();
      expect(mgr.projectComposeFailure).toBeNull();
    });
  });

  it("getLogBuffer returns empty string for unknown service", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n");
    const mgr = createMockedManager(dir);
    expect(mgr.getLogBuffer("nonexistent")).toBe("");
  });

  it("restartService stops then starts a service", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");

    const psOutput = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
    const commands: string[] = [];
    const composeRunner: ComposeRunner = (args) => {
      const subcommand = args.find(a => a === "up" || a === "stop" || a === "down");
      if (subcommand) commands.push(subcommand);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psOutput);
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    commands.length = 0;

    await mgr.restartService("web");

    expect(commands).toEqual(["stop", "up"]);
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("getContainerIpForPort returns IP for matching service", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const psOutput = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
    const mgr = createMockedManager(dir, {
      ps: psOutput,
      inspect: JSON.stringify([{
        NetworkSettings: { Networks: { "shipit-session-test-session": { IPAddress: "172.20.0.5" } } },
      }]),
    });

    await mgr.start();
    expect(mgr.getContainerIpForPort(5173)).toBe("172.20.0.5");
    expect(mgr.getContainerIpForPort(9999)).toBeUndefined();
  });
});

describe("ServiceManager secret injection", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-secrets-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  it("writes per-service env files when x-shipit-secrets is declared", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - STRIPE_KEY
  api:
    image: node:20
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk_test_123", DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected — no docker */ }

    const webEnv = fs.readFileSync(serviceEnvFile(dir, "test-session", "web"), "utf-8");
    const apiEnv = fs.readFileSync(serviceEnvFile(dir, "test-session", "api"), "utf-8");
    expect(webEnv).toContain("STRIPE_KEY=sk_test_123");
    expect(apiEnv).toContain("DATABASE_URL=postgres://x");

    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);

    expect(webEnv).not.toContain("DATABASE_URL");
    expect(apiEnv).not.toContain("STRIPE_KEY");
  });

  it("skips env files for services that don't declare secrets", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - STRIPE_KEY
  db:
    image: postgres:16
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(serviceEnvFile(dir, "test-session", "web"))).toBe(true);
    expect(fs.existsSync(serviceEnvFile(dir, "test-session", "db"))).toBe(false);
  });

  it("does nothing when no secretsLoader is provided", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - STRIPE_KEY
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    const webEnv = fs.readFileSync(serviceEnvFile(dir, "test-session", "web"), "utf-8");
    expect(webEnv).not.toContain("STRIPE_KEY=");
    expect(webEnv).toContain("# Generated by ShipIt");
  });

  it("refreshSecrets rewrites env files with new values", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    let secrets: Record<string, string> = { DATABASE_URL: "postgres://old" };
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") {
        return Promise.resolve(JSON.stringify({
          Service: "api", ID: "abc", State: "running", ExitCode: 0,
        }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      secretsLoader: async () => ({ ...secrets }),
      pollIntervalMs: 0,
    });

    await mgr.start();
    expect(fs.readFileSync(serviceEnvFile(dir, "test-session", "api"), "utf-8"))
      .toContain("DATABASE_URL=postgres://old");

    secrets = { DATABASE_URL: "postgres://new" };
    await mgr.refreshSecrets();
    expect(fs.readFileSync(serviceEnvFile(dir, "test-session", "api"), "utf-8"))
      .toContain("DATABASE_URL=postgres://new");
  });

  it("refreshSecrets rewrites secrets without starting an all-manual stack", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  worker:
    image: node:20
    x-shipit-preview: manual
    x-shipit-secrets:
      - API_KEY
`);
    let secret = "old";
    const composeRunner = vi.fn<ComposeRunner>(() => Promise.resolve());
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery: emptyComposeQuery,
      secretsLoader: async () => ({ API_KEY: secret }),
      pollIntervalMs: 0,
    });

    await mgr.start();
    secret = "new";
    await mgr.refreshSecrets();

    expect(fs.readFileSync(serviceEnvFile(dir, "test-session", "worker"), "utf-8"))
      .toContain("API_KEY=new");
    expect(composeRunner.mock.calls.some(([args]) => args.includes("up"))).toBe(false);
  });

  it("refreshSecrets restarts only auto services in a mixed stack", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - API_KEY
  worker:
    image: node:20
    x-shipit-preview: manual
    x-shipit-secrets:
      - API_KEY
`);
    const composeRunner = vi.fn<ComposeRunner>(() => Promise.resolve());
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery: emptyComposeQuery,
      secretsLoader: async () => ({ API_KEY: "value" }),
      pollIntervalMs: 0,
    });

    await mgr.start();
    composeRunner.mockClear();
    await mgr.refreshSecrets();

    const upCall = composeRunner.mock.calls.find(([args]) => args.includes("up"));
    expect(upCall?.[0]).toContain("api");
    expect(upCall?.[0]).not.toContain("worker");
  });

  it("override file references env_file for services with secrets", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain("env_file:");
    expect(override).toContain(serviceEnvFile(dir, "test-session", "api"));
    expect(override).not.toContain(".shipit/.env.api");
  });

  it("getDeclaredSecretNames returns the union across services", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - STRIPE_KEY
  api:
    image: node:20
    x-shipit-secrets:
      - DATABASE_URL
      - STRIPE_KEY
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({}),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(mgr.getDeclaredSecretNames()).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });

  it("writes the state dir's .env.agent for `agent: true` declarations", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - name: DATABASE_URL
        agent: true
      - STRIPE_KEY
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x", STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(true);
    const agentEnv = fs.readFileSync(path.join(stateOf(dir), ".env.agent"), "utf-8");
    expect(agentEnv).toContain("DATABASE_URL=postgres://x");
    expect(agentEnv).not.toContain("STRIPE_KEY");

    const snap = mgr.getSecretsSnapshot();
    expect(snap.agentNames).toEqual(["DATABASE_URL"]);
    expect(snap.agentValues).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("removes the state dir's .env.agent when no agent: true declarations remain", async () => {
    const dir = setup();
    fs.mkdirSync(stateOf(dir), { recursive: true });
    fs.writeFileSync(path.join(stateOf(dir), ".env.agent"), "OLD=1\n");

    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - STRIPE_KEY
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(false);
  });

  it("Docker-secrets mode writes per-secret files outside the workspace and skips env_file", async () => {
    const dir = setup();
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-root-"));
    const entrypointPath = path.join(secretsRoot, "secrets-entrypoint.sh");
    fs.writeFileSync(entrypointPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });

    try { await mgr.start(); } catch { /* expected */ }

    const secretFile = path.join(secretsRoot, "test-session", "DATABASE_URL");
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile, "utf-8")).toBe("postgres://x");

    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    const stagedWrapper = path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh");
    expect(fs.existsSync(stagedWrapper)).toBe(true);
    expect(fs.statSync(stagedWrapper).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(dir, ".shipit/secrets-entrypoint.sh"))).toBe(false);

    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).toContain("/shipit/secrets-entrypoint.sh");
    expect(override).toContain(stagedWrapper);
    expect(override).not.toContain("env_file");

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  it("Docker-secrets mode writes nothing into the clone", async () => {
    const dir = setup();
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-root-"));
    const entrypointPath = path.join(secretsRoot, "baked-secrets-entrypoint.sh");
    fs.writeFileSync(entrypointPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.readdirSync(dir).sort()).toEqual(["docker-compose.yml"]);

    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain(path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh"));

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  it("Docker-secrets mode maps the staged wrapper through hostDir", async () => {
    const dir = setup();
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-root-"));
    const entrypointPath = path.join(secretsRoot, "baked-secrets-entrypoint.sh");
    fs.writeFileSync(entrypointPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        hostDir: "/var/lib/shipit/secrets",
        entrypointSourcePath: entrypointPath,
      },
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh"))).toBe(true);
    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain("/var/lib/shipit/secrets/_entrypoint/secrets-entrypoint.sh");
    expect(override).toContain("/var/lib/shipit/secrets/test-session/DATABASE_URL");
    expect(override).not.toContain(secretsRoot);

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });


  it("Docker-secrets mode removes the internal secrets dir on stop({ removeVolumes: true }) but keeps it otherwise", async () => {
    const dir = setup();
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-root-"));
    const entrypointPath = path.join(secretsRoot, "secrets-entrypoint.sh");
    fs.writeFileSync(entrypointPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const make = () => new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });
    const sessionDir = path.join(secretsRoot, "test-session");

    const mgr1 = make();
    try { await mgr1.start(); } catch { /* expected */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr1.stop();
    expect(fs.existsSync(sessionDir)).toBe(true);

    const mgr2 = make();
    try { await mgr2.start(); } catch { /* expected */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr2.stop({ removeVolumes: true });
    expect(fs.existsSync(sessionDir)).toBe(false);

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  it("serviceEnvDir writes service env files outside the workspace and references them in the override", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected — no docker */ }

    const externalEnv = path.join(serviceEnvRoot, "test-session", ".env.api");
    expect(fs.existsSync(externalEnv)).toBe(true);
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://x");

    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain("env_file:");
    expect(override).toContain(externalEnv);
    expect(override).not.toContain(".shipit/.env.api");

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });

  it("regression: dogfood-style service-only secrets stay out of the workspace (.shipit/.env.dev absent)", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    writeCompose(dir, `
services:
  dev:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - ANTHROPIC_API_KEY
      - GITHUB_TOKEN
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ ANTHROPIC_API_KEY: "sk-ant-xxx", GITHUB_TOKEN: "ghp_xxx" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(dir, ".shipit/.env.dev"))).toBe(false);
    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(false);

    const externalEnv = path.join(serviceEnvRoot, "test-session", ".env.dev");
    const body = fs.readFileSync(externalEnv, "utf-8");
    expect(body).toContain("ANTHROPIC_API_KEY=sk-ant-xxx");
    expect(body).toContain("GITHUB_TOKEN=ghp_xxx");

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });


  it("refreshSecrets in serviceEnvDir mode rewrites the external file and leaves the override's absolute path intact", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    let secrets: Record<string, string> = { DATABASE_URL: "postgres://old" };
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") {
        return Promise.resolve(JSON.stringify({ Service: "api", ID: "abc", State: "running", ExitCode: 0 }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      secretsLoader: async () => ({ ...secrets }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    await mgr.start();
    const externalEnv = path.join(serviceEnvRoot, "test-session", ".env.api");
    const overrideBefore = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://old");
    expect(overrideBefore).toContain(externalEnv);

    secrets = { DATABASE_URL: "postgres://new" };
    await mgr.refreshSecrets();

    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://new");
    const overrideAfter = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(overrideAfter).toContain(externalEnv);
    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });

  it("removes the external service-env dir on stop({ removeVolumes: true }) but keeps it otherwise", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - DATABASE_URL
`);
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = () => Promise.resolve("");
    const make = () => new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });
    const sessionDir = path.join(serviceEnvRoot, "test-session");

    const mgr1 = make();
    try { await mgr1.start(); } catch { /* ok */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr1.stop();
    expect(fs.existsSync(sessionDir)).toBe(true);

    const mgr2 = make();
    try { await mgr2.start(); } catch { /* ok */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr2.stop({ removeVolumes: true });
    expect(fs.existsSync(sessionDir)).toBe(false);

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });

  it("emits secrets_status with declared + missingRequired + agentNames", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
    x-shipit-secrets:
      - name: DATABASE_URL
        description: Postgres URL
        required: true
        agent: true
      - SENTRY_DSN
`);
    const fakeRunner: ComposeRunner = () => Promise.reject(new Error("no docker"));
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({}),
      pollIntervalMs: 0,
    });

    const events: { declared: { name: string }[]; missingRequired: string[]; agentNames: string[] }[] = [];
    mgr.on("secrets_status", (snap: SecretsStatusInternalSnapshot) => {
      events.push({
        declared: snap.declared.map((d) => ({ name: d.name })),
        missingRequired: snap.missingRequired,
        agentNames: snap.agentNames,
      });
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.declared.map((d) => d.name).sort()).toEqual(["DATABASE_URL", "SENTRY_DSN"]);
    expect(last.missingRequired).toEqual(["DATABASE_URL"]);
    expect(last.agentNames).toEqual([]);
  });

  it("refreshSecretsStatus re-publishes plugin needs without touching containers", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
`);
    let declarations: PluginCredentialDeclaration[] = [];
    const composeCalls: string[][] = [];
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: (args: string[]) => {
        composeCalls.push(args);
        return Promise.reject(new Error("no docker"));
      },
      secretsLoader: async () => ({}),
      pluginCredentialsLoader: () => declarations,
      pollIntervalMs: 0,
    });

    const snapshots: SecretsStatusInternalSnapshot[] = [];
    mgr.on("secrets_status", (snap: SecretsStatusInternalSnapshot) => snapshots.push(snap));

    try { await mgr.start(); } catch { /* expected — no docker */ }
    expect(snapshots.at(-1)?.plugins).toEqual([]);

    declarations = [{ repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] }];
    const callsBefore = composeCalls.length;
    await mgr.refreshSecretsStatus();

    expect(snapshots.at(-1)?.plugins).toEqual([
      {
        repo: "art-kit",
        plugin: "palette",
        alias: "artk",
        credentials: [{ name: "FAL_KEY", satisfied: false, optional: false }],
      },
    ]);
    expect(composeCalls.length).toBe(callsBefore);
  });

  it("refreshSecretsStatus leaves the snapshot alone when the compose file will not parse", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  api:\n    image: node:20\n");
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
      composeRunner: () => Promise.reject(new Error("no docker")),
      secretsLoader: async () => ({}),
      pluginCredentialsLoader: () => [
        { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] },
      ],
      pollIntervalMs: 0,
    });

    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "services: [unclosed\n  - broken");
    const seen: SecretsStatusInternalSnapshot[] = [];
    mgr.on("secrets_status", (snap: SecretsStatusInternalSnapshot) => seen.push(snap));
    await mgr.refreshSecretsStatus();
    expect(seen).toEqual([]);
  });
});

describe("ServiceManager install-running retry gate", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-install-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  function makeManager(dir: string) {
    const composeUpCalls: string[][] = [];
    const composeStopCalls: string[] = [];
    let psResponse = "";
    let oomKilled: boolean | undefined = false;

    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        composeUpCalls.push(args.slice(upIdx));
      }
      const stopIdx = args.indexOf("stop");
      if (stopIdx >= 0) composeStopCalls.push(args.slice(stopIdx + 1).join(" "));
      return Promise.resolve();
    };

    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") {
        return Promise.resolve(JSON.stringify([{
          ...(oomKilled === undefined ? {} : { State: { OOMKilled: oomKilled } }),
          NetworkSettings: { Networks: {} },
        }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    return {
      mgr,
      composeUpCalls,
      composeStopCalls,
      setPsResponse: (s: string) => { psResponse = s; },
      setOomKilled: (v: boolean | undefined) => { oomKilled = v; },
    };
  }

  function exitedPs(exitCode = 1): string {
    return JSON.stringify({
      Service: "web", ID: "abc", State: "exited", ExitCode: exitCode,
    });
  }

  function runningPs(): string {
    return JSON.stringify({
      Service: "web", ID: "abc", State: "running", ExitCode: 0,
    });
  }

  it("retries while install is running instead of marking error", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);

    await mgr.start();

    const web = mgr.getService("web");
    expect(web?.status).toBe("starting");
    expect(web?.error).toBeUndefined();

    // Cancel the real retry timer before later tests switch to fake timers.
    await mgr.stop();
  });

  it("marks error when install has already finished", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    await mgr.start();

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("Exited with code 1");
  });

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  it("restarts errored services when install finishes", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("error");

    const upCallsBeforeFlush = composeUpCalls.length;

    mgr.setInstallRunning(true);
    setPsResponse(runningPs());
    mgr.setInstallRunning(false);

    await flushMicrotasks();

    expect(composeUpCalls.length).toBeGreaterThan(upCallsBeforeFlush);
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("backoff retry restarts the service via composeUpService", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    const upCallsBefore = composeUpCalls.length;

    setPsResponse(runningPs());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(composeUpCalls.length).toBeGreaterThan(upCallsBefore);
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("does not retry manual services even while install is running", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: postgres:16
    x-shipit-preview: manual
`);
    const { mgr, setPsResponse } = makeManager(dir);

    expect(mgr.installRunning).toBe(false);
    mgr.setInstallRunning(true);
    expect(mgr.installRunning).toBe(true);
    mgr.setInstallRunning(false);
    expect(mgr.installRunning).toBe(false);

    setPsResponse("");
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("setInstallRunning is idempotent — repeating the same value is a no-op", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr } = makeManager(dir);

    mgr.setInstallRunning(false);
    expect(mgr.installRunning).toBe(false);
    mgr.setInstallRunning(true);
    mgr.setInstallRunning(true);
    expect(mgr.installRunning).toBe(true);
  });

  it("stop() cancels pending retry timers", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    const upCallsBefore = composeUpCalls.length;
    await mgr.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(composeUpCalls.length).toBe(upCallsBefore);
  });

  it("auto-retries on OOM (exit 137) after install has finished", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, composeUpCalls, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(true);
    await mgr.start();

    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    const upCallsBefore = composeUpCalls.length;
    setPsResponse(runningPs());
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(composeUpCalls.length).toBeGreaterThan(upCallsBefore);
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("latches to error after MAX_OOM_AUTO_RETRIES consecutive OOMs", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTimersAsync();
    }

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("OOMKilled");
    expect(web?.error).toContain("gave up");
  });

  it("does not auto-retry manual services on OOM (user-initiated)", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  worker:
    image: node:20
    x-shipit-preview: manual
`);
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    await mgr.start();
    expect(mgr.getService("worker")?.status).toBe("stopped");

    setPsResponse(JSON.stringify({
      Service: "worker", ID: "abc", State: "exited", ExitCode: 137,
    }));
    setOomKilled(true);
    await mgr.startService("worker");

    const worker = mgr.getService("worker");
    expect(worker?.status).toBe("error");
    expect(worker?.error).toContain("Exited with code 137 (OOMKilled)");
  });

  it("resets OOM counter when user explicitly calls startService", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(true);
    await mgr.start();
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTimersAsync();
    }
    expect(mgr.getService("web")?.status).toBe("error");

    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");
  });

  it("does not treat exit 137 as OOM when the daemon reports OOMKilled: false", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(false);
    await mgr.start();

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe("Exited with code 137 (SIGKILL — not an OOM kill)");
    expect(web?.error).not.toContain("memory");

    const upCallsBefore = composeUpCalls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();
    expect(composeUpCalls.length).toBe(upCallsBefore);
  });

  it("keeps the hedged 137 message when OOMKilled is unknown", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(undefined);
    await mgr.start();

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe("Exited with code 137 (likely OOMKilled)");
  });

  it("an unconfirmed 137 inside the post-gate window takes the docs/137 recovery path", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();

    setPsResponse(exitedPs(137));
    setOomKilled(false);
    mgr.setInstallRunning(false);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);

    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.runAllTimersAsync();
    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe("Exited with code 137 (SIGKILL — not an OOM kill)");
  });

  it("non-137 exits still latch to error post-install (no auto-retry)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("error");
    expect(mgr.getService("web")?.error).toContain("Exited with code 1");
  });

  it("startService recovers from a container-name conflict by removing the squatter and retrying", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  dev:\n    image: node:20\n    x-shipit-preview: manual\n");

    const composeUpCalls: string[][] = [];
    const rmCalls: string[][] = [];
    let firstUpFails = true;

    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        composeUpCalls.push(args.slice(upIdx));
        if (firstUpFails) {
          firstUpFails = false;
          return Promise.reject(new Error(
            `docker compose compose failed (exit 1): Container shipit-test-session-dev-1 Creating ` +
            `\n Container shipit-test-session-dev-1 Error response from daemon: Conflict. ` +
            `The container name "/shipit-test-session-dev-1" is already in use by container ` +
            `"6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631". ` +
            `You have to remove (or rename) that container to be able to reuse that name.`,
          ));
        }
      }
      return Promise.resolve();
    };

    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "rm") {
        rmCalls.push(args.slice());
        return Promise.resolve("");
      }
      if (args.includes("ps") && args.includes("--format")) {
        return Promise.resolve(JSON.stringify({
          Service: "dev", ID: "newid", State: "running", ExitCode: 0,
        }));
      }
      if (args[0] === "ps") return Promise.resolve("");
      if (args.includes("inspect")) {
        return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    await mgr.startService("dev");

    expect(composeUpCalls.length).toBe(2);
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0]).toEqual([
      "rm", "-f",
      "6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631",
    ]);
    expect(mgr.getService("dev")?.status).toBe("running");
  });

  it("killStaleContainers removes stale compose containers but spares the Tier B resolver + Tier C proxy", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  dev:\n    image: node:20\n    x-shipit-preview: manual\n");

    const rmCalls: string[][] = [];
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "rm") {
        rmCalls.push(args.slice());
        return Promise.resolve("");
      }
      if (args[0] === "ps") {
        if (args.some((a) => a.includes("shipit-egress-resolver=test-session"))) return Promise.resolve("resolver-id\n");
        if (args.some((a) => a.includes("shipit-egress-proxy=test-session"))) return Promise.resolve("proxy-id\n");
        if (args.includes("--format")) return Promise.resolve("");
        return Promise.resolve("resolver-id\nproxy-id\nstale-compose-id\n");
      }
      if (args.includes("inspect")) {
        return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();

    const sweepRm = rmCalls.find((c) => c.includes("stale-compose-id"));
    expect(sweepRm).toEqual(["rm", "-f", "stale-compose-id"]);
    expect(rmCalls.flat()).not.toContain("proxy-id");
    expect(rmCalls.flat()).not.toContain("resolver-id");
  });

  it("reconcile of a running stack does not sweep its own healthy containers", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  dev:\n    image: node:20\n    x-shipit-preview: manual\n");

    const rmCalls: string[][] = [];
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "rm") {
        rmCalls.push(args.slice());
        return Promise.resolve("");
      }
      if (args[0] === "ps") {
        if (args.some((a) => a.includes("shipit-egress-"))) return Promise.resolve("");
        if (args.includes("--format")) return Promise.resolve("");
        return Promise.resolve("live-preview-id\n");
      }
      if (args.includes("inspect")) {
        return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    expect(rmCalls.find((c) => c.includes("live-preview-id"))).toEqual([
      "rm", "-f", "live-preview-id",
    ]);

    rmCalls.length = 0;
    await mgr.reconcile();
    expect(rmCalls).toEqual([]);

    await mgr.stop();
  });

  it("startService surfaces the original error if the squatter can't be removed", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  dev:\n    image: node:20\n    x-shipit-preview: manual\n");

    const conflictMsg =
      `docker compose compose failed (exit 1): Container shipit-test-session-dev-1 Error response from daemon: ` +
      `Conflict. The container name "/shipit-test-session-dev-1" is already in use by container ` +
      `"6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631". `;

    const composeRunner: ComposeRunner = (args) => {
      if (args.includes("up")) return Promise.reject(new Error(conflictMsg));
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "rm") return Promise.reject(new Error("docker rm failed: no such container"));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    await expect(mgr.startService("dev")).rejects.toThrow(/already in use by container/);
    expect(mgr.getService("dev")?.status).toBe("error");
  });

  it("non-conflict compose-up errors are not retried", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  dev:\n    image: node:20\n    x-shipit-preview: manual\n");

    const upCalls: string[][] = [];
    const rmCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      if (args.includes("up")) {
        upCalls.push(args.slice());
        return Promise.reject(new Error("docker compose compose failed (exit 1): image not found"));
      }
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      if (args[0] === "rm") { rmCalls.push(args.slice()); return Promise.resolve(""); }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    await expect(mgr.startService("dev")).rejects.toThrow(/image not found/);
    expect(upCalls.length).toBe(1);
    expect(rmCalls.length).toBe(0);
  });
});

describe("ServiceManager install gate (x-shipit-depends-on-install)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-gate-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  // Tests that hold the shared stack queue need separate session IDs to isolate failures.
  function makeManager(dir: string, sessionId = "test-session") {
    const upCalls: string[][] = [];
    const stopCalls: string[] = [];
    let psResponse = "";

    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      const stopIdx = args.indexOf("stop");
      if (stopIdx >= 0) stopCalls.push(args[stopIdx + 1]);
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId,
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    return {
      mgr,
      upCalls,
      stopCalls,
      setPsResponse: (s: string) => { psResponse = s; },
    };
  }

  function upNames(upCalls: string[][]): string[] {
    const names: string[] = [];
    for (const call of upCalls) {
      for (const a of call) {
        if (a === "up" || a.startsWith("-")) continue;
        names.push(a);
      }
    }
    return names;
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  it("does not start a gated service while install is running", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();

    expect(mgr.getService("web")?.status).toBe("starting");
    expect(upNames(upCalls)).not.toContain("web");
  });

  it("starts the gated service after install succeeds", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(upNames(upCalls)).not.toContain("web");

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    expect(upNames(upCalls)).toContain("web");
    expect(mgr.getService("web")?.status).toBe("running");
  });

  async function timingLines(run: () => Promise<void> | void): Promise<string[]> {
    const seen: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.startsWith("[timing]")) seen.push(msg);
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it("reports how long the install gate held the preview services", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir, "test-session-gate-timing");

    mgr.setInstallRunning(true);
    await mgr.start();
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));

    const seen = await timingLines(async () => {
      mgr.setInstallRunning(false);
      await flushMicrotasks();
    });

    const gate = seen.filter(l => l.includes("install-gate"));
    expect(gate).toHaveLength(1);
    expect(gate[0]).toContain("install-gate for test-session-gate-timing");
    expect(gate[0]).toMatch(/held=\d+ms/);
    expect(gate[0]).toContain("services=1 outcome=started");
  });

  it("starts the preview-ready clock for the port the gated service serves", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const sessionId = "test-session-gate-clock";
    const { mgr, setPsResponse } = makeManager(dir, sessionId);

    mgr.setInstallRunning(true);
    await mgr.start();
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));

    const seen = await timingLines(async () => {
      mgr.setInstallRunning(false);
      await flushMicrotasks();
      markPreviewReachable(sessionId, 5173);
    });
    forgetStackUp(sessionId);

    const first = seen.filter(l => l.includes("preview.first-connect"));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(`port=5173`);
    expect(first[0]).toContain("service=web");
  });

  it("reports the gate wait as install-failed when the install fails", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr } = makeManager(dir, "test-session-gate-timing-failed");

    mgr.setInstallRunning(true);
    await mgr.start();

    const seen = await timingLines(async () => {
      mgr.setInstallRunning(false, { failed: true });
      await flushMicrotasks();
    });

    const gate = seen.filter(l => l.includes("install-gate"));
    expect(gate).toHaveLength(1);
    expect(gate[0]).toContain("outcome=install-failed");
  });

  it("says nothing about a gate that held no service", async () => {
    const dir = setup();
    writeCompose(
      dir,
      "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n",
    );
    const { mgr } = makeManager(dir, "test-session-gate-timing-none");

    const seen = await timingLines(async () => {
      mgr.setInstallRunning(true);
      await mgr.start();
      mgr.setInstallRunning(false);
      await flushMicrotasks();
    });

    expect(seen.filter(l => l.includes("install-gate"))).toHaveLength(0);
  });

  it("holds the gated start behind an in-flight stack op instead of racing it", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const sessionId = "test-session-gate-queue";
    const { mgr, upCalls, setPsResponse } = makeManager(dir, sessionId);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(upNames(upCalls)).not.toContain("web");

    let release!: () => void;
    const reconcile = new Promise<void>((r) => { release = r; });
    const queued = serializeStackOp(sessionId, () => reconcile);

    try {
      setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      mgr.setInstallRunning(false);
      await flushMicrotasks();

      expect(mgr.getService("web")?.status).toBe("starting");
      expect(upNames(upCalls)).not.toContain("web");
    } finally {
      release();
    }
    await queued;
    await flushMicrotasks();

    expect(upNames(upCalls)).toContain("web");
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("latches the gated service to error when install fails", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();

    mgr.setInstallRunning(false, { failed: true });
    await flushMicrotasks();

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("agent.install failed");
    expect(upNames(upCalls)).not.toContain("web");
  });

  it("starts immediately when no install is in flight (vacuous open)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    await mgr.start();

    expect(upNames(upCalls)).toContain("web");
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("starts an opted-out service even while install is running", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  web:
    image: node:20
    ports: ['5173:5173']
    x-shipit-depends-on-install: false
`);
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(true);
    await mgr.start();

    expect(upNames(upCalls)).toContain("web");
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("starts non-gated services immediately while holding gated ones", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  gated:
    image: node:20
    ports: ['5173:5173']
  free:
    image: node:20
    ports: ['4000:4000']
    x-shipit-depends-on-install: false
`);
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    setPsResponse(JSON.stringify({ Service: "free", ID: "f1", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(true);
    await mgr.start();

    expect(upNames(upCalls)).toContain("free");
    expect(upNames(upCalls)).not.toContain("gated");
    expect(mgr.getService("gated")?.status).toBe("starting");
  });

  it("tears down and restarts gated services on a mid-session re-install", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, stopCalls, setPsResponse } = makeManager(dir);

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(mgr.getService("web")?.status).toBe("running");

    const upCountBefore = upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await flushMicrotasks();
    expect(stopCalls).toContain("web");
    expect(mgr.getService("web")?.status).toBe("starting");

    mgr.setInstallRunning(false);
    await flushMicrotasks();
    const upCountAfter = upNames(upCalls).filter(n => n === "web").length;
    expect(upCountAfter).toBe(upCountBefore + 1);
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("batches multiple gated services into a single up after install", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  a:
    image: node:20
    ports: ['3001:3001']
  b:
    image: node:20
    ports: ['3002:3002']
`);
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    const upCallCountBefore = upCalls.length;

    setPsResponse(
      `${JSON.stringify({ Service: "a", ID: "a1", State: "running", ExitCode: 0 })}\n${JSON.stringify({ Service: "b", ID: "b1", State: "running", ExitCode: 0 })}`,
    );
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    expect(upCalls.length).toBe(upCallCountBefore + 1);
    const lastUp = upCalls[upCalls.length - 1];
    expect(lastUp).toContain("a");
    expect(lastUp).toContain("b");
  });

  it("holds gated services until the re-install teardown's SIGKILL has landed", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    let releaseStop = (): void => {};
    const stopLanded = new Promise<void>((resolve) => { releaseStop = resolve; });
    const upCalls: string[][] = [];
    let psResponse = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });

    const composeRunner: ComposeRunner = async (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      if (args.includes("stop")) await stopLanded;
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") {
        return Promise.resolve(JSON.stringify([{
          State: { OOMKilled: false },
          NetworkSettings: { Networks: {} },
        }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const poll = () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();
    const webUps = () => upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(mgr.getService("web")?.status).toBe("running");
    const upsBefore = webUps();

    mgr.setInstallRunning(true);
    psResponse = JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 137 });
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    expect(webUps()).toBe(upsBefore);
    await poll();
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    releaseStop();
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore + 1);

    // Cancel the real retry timer before later tests switch to fake timers.
    await mgr.stop();
  });

  it("reopens the gate when the teardown's compose stop never returns (docs/283)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const upCalls: string[][] = [];
    const composeRunner: ComposeRunner = async (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      if (args.includes("stop")) await new Promise<void>(() => { /* never settles */ });
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "gate-hung-teardown",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const webUps = () => upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(mgr.getService("web")?.status).toBe("running");
    const upsBefore = webUps();

    vi.useFakeTimers();
    mgr.setInstallRunning(true);
    mgr.setInstallRunning(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(webUps()).toBe(upsBefore);
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(DEFAULT_STOP_GRACE_PERIOD_MS + GATED_TEARDOWN_GRACE_MARGIN_MS);
    expect(webUps()).toBe(upsBefore + 1);

    await mgr.stop();
  });

  it("waits out a long declared stop_grace_period before abandoning the teardown (docs/283)", async () => {
    const dir = setup();
    writeCompose(dir,
      "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    stop_grace_period: 1m30s\n");

    const upCalls: string[][] = [];
    let releaseStop = (): void => {};
    const stopLanded = new Promise<void>((resolve) => { releaseStop = resolve; });
    const composeRunner: ComposeRunner = async (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      if (args.includes("stop")) await stopLanded;
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "gate-long-grace",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const webUps = () => upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    const upsBefore = webUps();

    vi.useFakeTimers();
    mgr.setInstallRunning(true);
    mgr.setInstallRunning(false);

    await vi.advanceTimersByTimeAsync(75_000);
    expect(webUps()).toBe(upsBefore);
    expect(mgr.getService("web")?.status).toBe("starting");

    releaseStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(webUps()).toBe(upsBefore + 1);

    await mgr.stop();
  });

  it("drops a queued gated start that a newer gate cycle has superseded (docs/283)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const upCalls: string[][] = [];
    let releaseQueueHolder = (): void => {};
    const queueHeld = new Promise<void>((resolve) => { releaseQueueHolder = resolve; });
    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const sessionId = "gate-stale-queued-batch";
    const mgr = new ServiceManager({
      sessionId,
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const webUps = () => upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    const upsBefore = webUps();

    const holder = serializeStackOp(sessionId, () => queueHeld);
    await flushMicrotasks();

    mgr.setInstallRunning(true);
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore);

    mgr.setInstallRunning(true);
    await flushMicrotasks();

    releaseQueueHolder();
    await holder;
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore);

    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore + 1);

    await mgr.stop();
  });

  it("does not let an older teardown open a newer cycle's gate (docs/283)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    const upCalls: string[][] = [];
    const stopReleases: (() => void)[] = [];
    const composeRunner: ComposeRunner = async (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      if (args.includes("stop")) await new Promise<void>((r) => stopReleases.push(r));
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "gate-teardown-generations",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });
    const webUps = () => upNames(upCalls).filter(n => n === "web").length;

    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    const upsBefore = webUps();

    mgr.setInstallRunning(true);
    await flushMicrotasks();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(stopReleases.length).toBe(1);

    mgr.setInstallRunning(true);
    await flushMicrotasks();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(stopReleases.length).toBe(2);

    stopReleases[0]();
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore);

    stopReleases[1]();
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore + 1);

    await mgr.stop();
  });

  it("retries instead of latching when a gated service crashes just after the gate opens", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(upNames(upCalls)).not.toContain("web");

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 127 }));
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    expect(upNames(upCalls)).toContain("web");
    const web = mgr.getService("web");
    expect(web?.status).toBe("starting");
    expect(web?.error).toBeUndefined();

    // Cancel the real retry timer before later tests switch to fake timers.
    await mgr.stop();
  });

  it("recovers a post-gate crash once deps finish landing", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    let webUps = 0;
    const upCalls: string[][] = [];
    const composeRunner: ComposeRunner = (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        const call = args.slice(upIdx);
        if (call.some(a => a === "web")) webUps++;
        upCalls.push(call);
      }
      return Promise.resolve();
    };
    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") {
        const running = webUps >= 2;
        return Promise.resolve(JSON.stringify({
          Service: "web", ID: "abc",
          State: running ? "running" : "exited",
          ExitCode: running ? 0 : 127,
        }));
      }
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(webUps).toBe(0);

    mgr.setInstallRunning(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mgr.getService("web")?.status).toBe("running");
    expect(webUps).toBeGreaterThanOrEqual(2);
  });

  it("keeps the post-gate window open while the service establishes — a crash after first `running` is retried", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);
    const poll = () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();

    mgr.setInstallRunning(true);
    await mgr.start();

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(10_000);
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 1 }));
    await poll();

    const web = mgr.getService("web");
    expect(web?.status).toBe("starting");
    expect(web?.error).toBeUndefined();
  });

  it("closes the post-gate window once the service has been stably running", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);
    const poll = () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();

    mgr.setInstallRunning(true);
    await mgr.start();
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(61_000);

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 1 }));
    await poll();
    expect(mgr.getService("web")?.status).toBe("error");
  });

  it("latches to error after exhausting the post-gate retry budget", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 127 }));
    mgr.setInstallRunning(false);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("Exited with code 127");
  });
});

describe("ServiceManager stuck-starting recovery (#2044)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-stuck-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  const MANUAL_COMPOSE =
    "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n    x-shipit-preview: manual\n";

  interface ManagerOpts {
    up?: () => Promise<void>;
    networkJoinFn?: (networkName: string) => Promise<void>;
    pollIntervalMs?: number;
  }

  function makeManager(dir: string, opts: ManagerOpts = {}) {
    let psResponse = "";
    let containerIp: string | null = "172.16.0.9";
    let psCalls = 0;

    const composeRunner: ComposeRunner = (args) =>
      args.includes("up") ? (opts.up?.() ?? Promise.resolve()) : Promise.resolve();

    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") {
        psCalls += 1;
        return Promise.resolve(psResponse);
      }
      if (key === "inspect") {
        return Promise.resolve(JSON.stringify([{
          State: { OOMKilled: false },
          NetworkSettings: {
            Networks: containerIp ? { "shipit-session-test-session": { IPAddress: containerIp } } : {},
          },
        }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: opts.pollIntervalMs ?? 0,
      ...(opts.networkJoinFn ? { networkJoinFn: opts.networkJoinFn } : {}),
    });

    return {
      mgr,
      setPsResponse: (s: string) => { psResponse = s; },
      setContainerIp: (ip: string | null) => { containerIp = ip; },
      psCalls: () => psCalls,
    };
  }

  const createdPs = JSON.stringify({ Service: "web", ID: "abc", State: "created", ExitCode: 0 });
  const runningPs = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
  const exitedPs = JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 0 });

  it("publishes url while still `starting`, as soon as the container has an address", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(createdPs);
    await mgr.startService("web");

    const web = mgr.getServices().find(s => s.name === "web");
    expect(web?.status).toBe("starting");
    expect(web?.containerIp).toBe("172.16.0.9");
    expect(web?.url).toBe("http://172.16.0.9:3000/");
  });

  it("withholds url once the container is known to be gone", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir);
    const poll = () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    expect(mgr.getServices().find(s => s.name === "web")?.url).toBe("http://172.16.0.9:3000/");

    setPsResponse(exitedPs);
    await poll();
    const web = mgr.getServices().find(s => s.name === "web");
    expect(web?.status).toBe("stopped");
    expect(web?.url).toBeUndefined();
  });

  it("marks a service that never leaves `starting` as error, with a reason", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse("");
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS + 1_000);

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe(STARTING_TIMEOUT_MESSAGE);
    expect(web?.error).toContain("may in fact be running");
    expect(web?.error).toContain("restart loop");
  });

  it("does not fire the watchdog while a compose up is still in flight", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let releaseUp: (() => void) | undefined;
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => { releaseUp = resolve; }),
    });

    await mgr.start();
    setPsResponse(runningPs);
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS * 2 + 1_000);
    expect(mgr.getService("web")?.status).toBe("starting");

    releaseUp?.();
    await startPromise;
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("does not fire the watchdog while the install gate holds the service", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS * 2 + 1_000);
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();
  });

  it("stop() cancels pending starting watchdogs", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse("");
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");

    await mgr.stop();
    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS + 1_000);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("starts the poll loop even when start() throws", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, psCalls } = makeManager(dir, {
      up: () => Promise.reject(new Error("docker daemon is unhappy")),
      pollIntervalMs: 5_000,
    });

    await expect(mgr.start()).rejects.toThrow("docker daemon is unhappy");
    const before = psCalls();

    await vi.advanceTimersByTimeAsync(11_000);
    expect(psCalls()).toBeGreaterThan(before);

    await mgr.stop();
  });

  it("resolves status and address even when the network join never returns", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir, {
      networkJoinFn: () => new Promise<void>(() => { /* never settles */ }),
    });

    const stackPromise = mgr.start();
    await vi.advanceTimersByTimeAsync(NETWORK_JOIN_TIMEOUT_MS + 1_000);
    await stackPromise;

    setPsResponse(runningPs);
    const startPromise = mgr.startService("web");

    await vi.advanceTimersByTimeAsync(NETWORK_JOIN_TIMEOUT_MS + 1_000);
    await startPromise;

    const web = mgr.getServices().find(s => s.name === "web");
    expect(web?.status).toBe("running");
    expect(web?.url).toBe("http://172.16.0.9:3000/");
  });
});

describe("ServiceManager starting-state address hygiene (#2044)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-addr-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  const MANUAL_COMPOSE =
    "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n    x-shipit-preview: manual\n";

  function makeManager(dir: string, opts: { up?: () => Promise<void> } = {}) {
    let psResponse = "";
    let ip = "172.16.0.9";

    const composeRunner: ComposeRunner = (args) =>
      args.includes("up") ? (opts.up?.() ?? Promise.resolve()) : Promise.resolve();

    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") {
        return Promise.resolve(JSON.stringify([{
          State: { OOMKilled: false },
          NetworkSettings: { Networks: { "shipit-session-test-session": { IPAddress: ip } } },
        }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    return {
      mgr,
      setPsResponse: (s: string) => { psResponse = s; },
      setIp: (v: string) => { ip = v; },
      url: () => mgr.getServices().find(s => s.name === "web")?.url,
    };
  }

  const runningPs = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });

  it("does not republish the previous container's address across a stop/start", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse, setIp, url } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    expect(url()).toBe("http://172.16.0.9:3000/");

    await mgr.stopService("web");
    expect(mgr.getService("web")?.containerIp).toBeUndefined();

    setIp("172.16.0.42");
    setPsResponse("");
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(url()).toBeUndefined();

    setPsResponse(runningPs);
    await (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();
    expect(url()).toBe("http://172.16.0.42:3000/");
  });

  it("gives the watchdog a fresh window once the compose up finishes", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let releaseUp: (() => void) | undefined;
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => { releaseUp = resolve; }),
    });

    await mgr.start();
    setPsResponse("");
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS - 5_000);
    releaseUp?.();
    await startPromise;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS);
    expect(mgr.getService("web")?.status).toBe("error");
  });

  it("reconcile() drops a stale in-flight exemption", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>(() => { /* never settles */ }),
    });

    await mgr.start();
    setPsResponse("");
    void mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("starting");

    await mgr.reconcile();

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "restarting", ExitCode: 0 }));
    await (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS + 1_000);
    expect(mgr.getService("web")?.status).toBe("error");

    await mgr.stop();
  });
});

describe("ServiceManager — compose up output reaches the service log", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const MANUAL_COMPOSE = `
services:
  dev:
    image: node:24
    ports: ["3000:3000"]
    x-shipit-preview: manual
`;

  function makeBuildingManager(dir: string) {
    const logs: { name: string; text: string }[] = [];
    const stored: string[] = [];
    let bufferDuringUp = "";
    let snapshotDuringUp = "";

    const composeRunner: ComposeRunner = async (args, _cwd, onOutput) => {
      if (!args.includes("up")) return;
      onOutput?.("#4 [2/9] RUN apt-get update\n#4 sha256:abc 0.4s done\n");
      onOutput?.("#5 [3/9] RUN playwright ");
      onOutput?.("install-deps chromium\n");
      onOutput?.("#5 DONE 92.1s");
      bufferDuringUp = mgr.getLogBuffer("dev");
      snapshotDuringUp = await mgr.snapshotLogs("dev");
    };

    const logStore = {
      hasChannel: () => false,
      append: (_sid: string, _channel: string, text: string) => { stored.push(text); },
      snapshotText: () => "",
    } as unknown as ConstructorParameters<typeof ServiceManager>[0]["logStore"];

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery: emptyComposeQuery,
      pollIntervalMs: 0,
      ...(logStore ? { logStore } : {}),
    });
    mgr.on("service_log", (name: string, text: string) => { logs.push({ name, text }); });

    return {
      mgr, logs, stored,
      getBufferDuringUp: () => bufferDuringUp,
      getSnapshotDuringUp: () => snapshotDuringUp,
    };
  }

  it("relays build progress line by line while the container does not exist yet", async () => {
    tmpDir = makeSessionDir("service-mgr-");
    const dir = path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), MANUAL_COMPOSE);
    const { mgr, logs, getBufferDuringUp, getSnapshotDuringUp } = makeBuildingManager(dir);

    await mgr.start();
    logs.length = 0;
    await mgr.startService("dev");

    expect(logs.map(l => l.text)).toEqual([
      "[compose] #4 [2/9] RUN apt-get update\n",
      "[compose] #4 sha256:abc 0.4s done\n",
      "[compose] #5 [3/9] RUN playwright install-deps chromium\n",
      "[compose] #5 DONE 92.1s\n",
    ]);
    expect(logs.every(l => l.name === "dev")).toBe(true);
    expect(getBufferDuringUp()).toContain("[compose] #5 [3/9] RUN playwright install-deps chromium");
    expect(getSnapshotDuringUp()).toContain("[compose] #4 [2/9] RUN apt-get update");

    await mgr.stop();
  }, 15_000);

  it("emits a record that never ends, instead of buffering it without bound", async () => {
    tmpDir = makeSessionDir("service-mgr-");
    const dir = path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), MANUAL_COMPOSE);

    const logs: string[] = [];
    const composeRunner: ComposeRunner = (args, _cwd, onOutput) => {
      if (args.includes("up")) {
        for (let i = 0; i < 5; i++) onOutput?.("x".repeat(MAX_COMPOSE_LOG_LINE / 2));
      }
      return Promise.resolve();
    };
    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery: emptyComposeQuery,
      pollIntervalMs: 0,
    });
    mgr.on("service_log", (_name: string, text: string) => { logs.push(text); });

    await mgr.start();
    logs.length = 0;
    await mgr.startService("dev");

    expect(logs.length).toBe(2);
    expect(logs.every(t => t.startsWith(COMPOSE_LOG_PREFIX))).toBe(true);
    expect(logs.reduce((n, t) => n + t.length, 0)).toBeGreaterThan(MAX_COMPOSE_LOG_LINE);

    await mgr.stop();
  });

  it("does not persist compose output to the durable log store", async () => {
    tmpDir = makeSessionDir("service-mgr-");
    const dir = path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), MANUAL_COMPOSE);
    const { mgr, logs, stored } = makeBuildingManager(dir);

    await mgr.start();
    await mgr.startService("dev");

    expect(logs.filter(l => l.text.includes("[compose]")).length).toBeGreaterThan(0);
    // Persisting build output would make the first follower skip the container's backlog.
    expect(stored.filter(t => t.includes("[compose]"))).toEqual([]);

    await mgr.stop();
  });
});

describe("ServiceManager service-lifecycle resilience (docs/121)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = makeSessionDir("service-mgr-121-");
    return path.join(tmpDir, SESSION_WORKSPACE_SUBDIR);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  const MANUAL_COMPOSE =
    "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n    x-shipit-preview: manual\n";

  interface ManagerOpts {
    up?: (onOutput?: (chunk: string) => void) => Promise<void>;
    stop?: () => Promise<void>;
    pollIntervalMs?: number;
  }

  function makeManager(dir: string, opts: ManagerOpts = {}) {
    let psResponse = "";
    const upCalls: string[][] = [];
    const stopCalls: string[] = [];

    const composeRunner: ComposeRunner = (args, _cwd, onOutput) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        upCalls.push(args.slice(upIdx));
        return opts.up?.(onOutput) ?? Promise.resolve();
      }
      const stopIdx = args.indexOf("stop");
      if (stopIdx >= 0) {
        stopCalls.push(args[stopIdx + 1]);
        return opts.stop?.() ?? Promise.resolve();
      }
      return Promise.resolve();
    };

    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") {
        return Promise.resolve(JSON.stringify([{
          State: { OOMKilled: false },
          NetworkSettings: { Networks: { "shipit-session-test-session": { IPAddress: "172.16.0.9" } } },
        }]));
      }
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: opts.pollIntervalMs ?? 0,
    });

    return {
      mgr,
      upCalls,
      stopCalls,
      poll: () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce(),
      logProcesses: () =>
        (mgr as unknown as { logProcesses: Map<string, ChildProcess> }).logProcesses,
      setPsResponse: (s: string) => { psResponse = s; },
    };
  }

  const runningPs = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
  const exitedPs = (exitCode: number) =>
    JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: exitCode });

  it("reports a compose up that has gone silent and never returned", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr } = makeManager(dir, { up: () => new Promise<void>(() => {}) });

    await mgr.start();
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS + STARTING_WATCHDOG_MS);

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe(UP_STALLED_MESSAGE);
    expect(mgr.getServices().find(s => s.name === "web")?.url).toBeUndefined();
    void startPromise;
  });

  it("never bounds a build that is still producing output", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let emit: ((chunk: string) => void) | undefined;
    const { mgr } = makeManager(dir, {
      up: (onOutput) => new Promise<void>(() => { emit = onOutput; }),
    });

    await mgr.start();
    void mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS / 2);
      emit?.(`#${i} [2/9] RUN npm ci\n`);
    }
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS + STARTING_WATCHDOG_MS);
    expect(mgr.getService("web")?.status).toBe("error");
    expect(mgr.getService("web")?.error).toBe(UP_STALLED_MESSAGE);
  });

  it("recovers on its own if the slow up eventually succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let finishUp: (() => void) | undefined;
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => { finishUp = resolve; }),
    });

    await mgr.start();
    setPsResponse(runningPs);
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS + STARTING_WATCHDOG_MS);
    expect(mgr.getService("web")?.status).toBe("error");

    finishUp?.();
    await startPromise;
    expect(mgr.getService("web")?.status).toBe("running");
    expect(mgr.getService("web")?.error).toBeUndefined();
  });

  it("re-attaches a log follower when a service comes back on its own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, logProcesses, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    const first = logProcesses().get("web");
    expect(first).toBeDefined();

    first!.emit("close", 0);
    expect(logProcesses().has("web")).toBe(false);

    setPsResponse(exitedPs(1));
    await poll();
    setPsResponse(runningPs);
    await poll();

    const second = logProcesses().get("web");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("re-attaches even when the follower dies after the recovery poll", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, logProcesses, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    const first = logProcesses().get("web");

    setPsResponse(exitedPs(1));
    await poll();
    setPsResponse(runningPs);
    await poll();
    first!.emit("close", 0);

    await poll();
    const second = logProcesses().get("web");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("does not replace a follower that is still alive", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, logProcesses, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    const follower = logProcesses().get("web");

    setPsResponse(exitedPs(0));
    await poll();
    setPsResponse(runningPs);
    await poll();

    expect(logProcesses().get("web")).toBe(follower);
  });

  it("retires a follower that exits so its liveness answer stays honest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, logProcesses } = makeManager(dir);

    await mgr.start();
    const cleanup = mgr.streamLogs("web");
    const proc = logProcesses().get("web");
    expect(proc).toBeDefined();
    expect(proc!.listenerCount("close")).toBeGreaterThan(0);

    proc!.emit("close", 0);
    expect(logProcesses().has("web")).toBe(false);
    cleanup();
  });

  it("leaves a service stopped when the stop lands during an in-flight start", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let finishUp: (() => void) | undefined;
    const { mgr, stopCalls, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => { finishUp = resolve; }),
    });

    await mgr.start();
    setPsResponse(runningPs);
    const startPromise = mgr.startService("web");
    await Promise.resolve();

    const stopPromise = mgr.stopService("web");
    await Promise.resolve();
    expect(stopCalls).toEqual(["web"]);

    await stopPromise;
    expect(mgr.getService("web")?.status).toBe("stopped");

    finishUp?.();
    await startPromise;

    await vi.waitFor(() => expect(stopCalls).toEqual(["web", "web"]));
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("does not hang the stop on an up that never returns", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, stopCalls } = makeManager(dir, { up: () => new Promise<void>(() => {}) });

    await mgr.start();
    void mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    await mgr.stopService("web");

    expect(stopCalls).toEqual(["web"]);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("waits out every overlapping up, not just the last one", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const events: string[] = [];
    const releases: (() => void)[] = [];
    const { mgr } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => {
        const idx = releases.length;
        releases.push(() => { events.push(`up${idx}-done`); resolve(); });
      }),
      stop: () => { events.push("stop"); return Promise.resolve(); },
    });

    await mgr.start();
    const firstUp = mgr.startService("web");
    await Promise.resolve();
    const secondUp = mgr.startService("web");
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    await mgr.stopService("web");

    releases[1]();
    await secondUp;
    releases[0]();
    await firstUp;

    await vi.waitFor(() => expect(events.filter(e => e === "stop")).toHaveLength(2));
    expect(events).toEqual(["stop", "up1-done", "up0-done", "stop"]);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("abandons a restart when the stop lands during its own compose stop", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    let releaseStop: (() => void) | undefined;
    let stopSeen = 0;
    const { mgr, upCalls, setPsResponse } = makeManager(dir, {
      stop: () => {
        stopSeen += 1;
        return stopSeen === 1
          ? new Promise<void>((resolve) => { releaseStop = resolve; })
          : Promise.resolve();
      },
    });

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    const upsBefore = upCalls.length;

    const restartPromise = mgr.restartService("web");
    await Promise.resolve();
    const stopPromise = mgr.stopService("web");
    releaseStop?.();
    await restartPromise;
    await stopPromise;

    expect(upCalls.length).toBe(upsBefore);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("leaves a gated service the user stopped alone when the gate opens", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    await mgr.stopService("web");
    const upsBefore = upCalls.length;

    mgr.setInstallRunning(false);
    await new Promise((r) => setTimeout(r, 10));

    expect(upCalls.length).toBe(upsBefore);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("does not report the stop's own SIGKILL as a crash", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    await mgr.stopService("web");

    setPsResponse(exitedPs(137));
    await poll();
    expect(mgr.getService("web")?.status).toBe("stopped");
    expect(mgr.getService("web")?.error).toBeUndefined();

    setPsResponse(exitedPs(143));
    await poll();
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("corrects a running claim that raced the stop", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    await mgr.stopService("web");

    await poll();
    expect(mgr.getService("web")?.status).toBe("running");

    setPsResponse(exitedPs(137));
    await poll();
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("does not let an already-scheduled retry undo the stop", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(
      dir,
      "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n",
    );
    const { mgr, upCalls, poll, setPsResponse } = makeManager(dir);

    mgr.setInstallRunning(true);
    await mgr.start();
    setPsResponse(exitedPs(1));
    await poll();
    expect(mgr.getService("web")?.status).toBe("starting");

    await mgr.stopService("web");
    const upsAtStop = upCalls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(upCalls.length).toBe(upsAtStop);
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("treats a later start as the newest instruction", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, poll, setPsResponse } = makeManager(dir);

    await mgr.start();
    setPsResponse(runningPs);
    await mgr.startService("web");
    await mgr.stopService("web");
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("running");

    setPsResponse(exitedPs(1));
    await poll();
    expect(mgr.getService("web")?.status).toBe("error");
    expect(mgr.getService("web")?.error).toContain("Exited with code 1");
  });
});
