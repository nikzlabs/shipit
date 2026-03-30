import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ServiceManager, type ComposeRunner, type ComposeQuery } from "./service-manager.js";

describe("ServiceManager", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mgr-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  /** A compose runner that rejects immediately (no real Docker needed). */
  const fakeComposeRunner: ComposeRunner = () =>
    Promise.reject(new Error("docker not available in test"));

  function createManager(dir: string, composeRunner: ComposeRunner = fakeComposeRunner) {
    return new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
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

  it("rejects invalid compose files during start", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
    const mgr = createManager(dir);
    // start() will parse and hit the privileged validation
    await expect(mgr.start()).rejects.toThrow("privileged");
  });

  it("generates override file on start attempt", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
    const mgr = createManager(dir);
    // start() will fail because docker compose isn't available in test,
    // but the override file should be written before the compose up call
    try { await mgr.start(); } catch { /* expected */ }
    const overridePath = path.join(dir, ".shipit", "compose.override.yml");
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

    // Events are batched — startup emits final state only (error since compose up fails in test)
    expect(events.some(e => e.name === "web" && e.status === "error")).toBe(true);
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
});

describe("ServiceManager lifecycle (mocked docker)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mgr-lc-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  /** Creates a manager with fully mocked compose runner + query. */
  function createMockedManager(
    dir: string,
    queryResponses: Record<string, string> = {},
  ) {
    const composeRunner: ComposeRunner = () => Promise.resolve();
    const composeQuery: ComposeQuery = (args) => {
      // Route based on subcommand
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      return Promise.resolve(queryResponses[key] ?? "");
    };
    return new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0, // disable periodic polling
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

    // Simulate crash
    psResponse = psCrashed;
    // Trigger a manual poll via reconcile-like path — call pollStatus indirectly
    // by tracking status events
    const events: string[] = [];
    mgr.on("service_status", (svc) => events.push(svc.status));

    // We can't call pollStatus directly (private), but stop+start will re-poll
    // Instead, let's test via the public reconcile path
    await mgr.reconcile();
    // After reconcile, it re-starts and polls — web should be in error state now
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
    // startError should be cleared during reconcile but start doesn't clear it
    // reconcile does
    mgr.startError = "stale error";
    await mgr.reconcile();
    expect(mgr.startError).toBeNull();
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
      // Track subcommands (up, stop, etc.)
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    commands.length = 0; // Clear startup commands

    await mgr.restartService("web");

    // Should have called stop then up
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
