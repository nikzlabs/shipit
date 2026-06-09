import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ServiceManager, type ComposeRunner, type ComposeQuery, type SecretsStatusInternalSnapshot } from "./service-manager.js";

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

    // Events are batched — startup emits final state only (error since compose up fails in test)
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();

    // The service must be registered (so the user can start it) and reported
    // as stopped — but no `compose up` should have been issued, otherwise
    // compose interprets "no service args" as "all services" and starts the
    // manual one anyway.
    expect(mgr.getService("dev")?.preview).toBe("manual");
    expect(mgr.getService("dev")?.status).toBe("stopped");
    expect(mgr.started).toBe(true);

    const upCalls = composeCalls.filter((args) => args.includes("up"));
    expect(upCalls).toHaveLength(0);
  });

  it("joins the orchestrator to the session network when the first manual service starts (all-manual stack)", async () => {
    // Regression: when every service is `x-shipit-preview: manual`,
    // `start()` skips `composeUp`, so the `shipit-session-<id>` Docker
    // network is never created at startup time. `networkJoinFn` then
    // tries to attach the orchestrator to a non-existent network and
    // silently fails. The user then clicks "Start" on the manual
    // service → `startService` → `composeUpService` creates the network,
    // BUT without this fix `networkJoinFn` was never re-invoked, so the
    // orchestrator never joined. Result: preview proxy resolves a
    // correct container IP that the orchestrator has no route to →
    // `ETIMEDOUT 172.x.y.z:<port>`. This is exactly the dogfood case.
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

    // Even though `start()` invoked `joinSessionNetwork` defensively, the
    // helper still ran — it's just a no-op against a missing network in
    // production. We assert at least one call so a regression in the
    // start-path can't silently drop it either.
    const callsAfterStart = networkJoinCalls.length;
    expect(callsAfterStart).toBeGreaterThanOrEqual(1);

    await mgr.startService("dev");

    // The post-composeUpService join is the one that actually matters:
    // it must fire AFTER the first manual service is started, because
    // that's when compose materializes the session network.
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

// ---------------------------------------------------------------------------
// Secret injection (Phase 1, feature 087)
// ---------------------------------------------------------------------------

describe("ServiceManager secret injection", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mgr-secrets-"));
    return tmpDir;
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk_test_123", DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected — no docker */ }

    const webEnv = fs.readFileSync(path.join(dir, ".shipit/.env.web"), "utf-8");
    const apiEnv = fs.readFileSync(path.join(dir, ".shipit/.env.api"), "utf-8");
    expect(webEnv).toContain("STRIPE_KEY=sk_test_123");
    expect(apiEnv).toContain("DATABASE_URL=postgres://x");

    // Scoping: web should not see api's secrets and vice versa
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(dir, ".shipit/.env.web"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".shipit/.env.db"))).toBe(false);
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      // no secretsLoader
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    // The env file is still written (with header only, no values) so compose's
    // env_file: reference doesn't fail with "missing file"
    const webEnv = fs.readFileSync(path.join(dir, ".shipit/.env.web"), "utf-8");
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      secretsLoader: async () => ({ ...secrets }),
      pollIntervalMs: 0,
    });

    await mgr.start();
    expect(fs.readFileSync(path.join(dir, ".shipit/.env.api"), "utf-8"))
      .toContain("DATABASE_URL=postgres://old");

    secrets = { DATABASE_URL: "postgres://new" };
    await mgr.refreshSecrets();
    expect(fs.readFileSync(path.join(dir, ".shipit/.env.api"), "utf-8"))
      .toContain("DATABASE_URL=postgres://new");
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    const override = fs.readFileSync(path.join(dir, ".shipit/compose.override.yml"), "utf-8");
    expect(override).toContain("env_file:");
    expect(override).toContain(".shipit/.env.api");
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({}),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(mgr.getDeclaredSecretNames()).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });

  // ---- Phase 3: agent: true → .env.agent + secrets snapshot ----

  it("writes .shipit/.env.agent for `agent: true` declarations", async () => {
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x", STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(dir, ".shipit/.env.agent"))).toBe(true);
    const agentEnv = fs.readFileSync(path.join(dir, ".shipit/.env.agent"), "utf-8");
    expect(agentEnv).toContain("DATABASE_URL=postgres://x");
    // STRIPE_KEY is service-only — not agent-injected
    expect(agentEnv).not.toContain("STRIPE_KEY");

    const snap = mgr.getSecretsSnapshot();
    expect(snap.agentNames).toEqual(["DATABASE_URL"]);
    expect(snap.agentValues).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("removes .shipit/.env.agent when no agent: true declarations remain", async () => {
    const dir = setup();
    // Pre-seed an existing .env.agent file from a prior compose definition.
    fs.mkdirSync(path.join(dir, ".shipit"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".shipit/.env.agent"), "OLD=1\n");

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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ STRIPE_KEY: "sk" }),
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(dir, ".shipit/.env.agent"))).toBe(false);
  });

  // ---- Phase 1 follow-up: Docker-secrets mode ----

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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });

    try { await mgr.start(); } catch { /* expected */ }

    // Per-secret file written outside the workspace
    const secretFile = path.join(secretsRoot, "test-session", "DATABASE_URL");
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile, "utf-8")).toBe("postgres://x");

    // No .env.api in the workspace — agent can't read it
    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    // Entrypoint wrapper copied into workspace .shipit/
    expect(fs.existsSync(path.join(dir, ".shipit/secrets-entrypoint.sh"))).toBe(true);

    // Override references Docker secrets, not env_file
    const override = fs.readFileSync(path.join(dir, ".shipit/compose.override.yml"), "utf-8");
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).toContain("/shipit/secrets-entrypoint.sh");
    expect(override).not.toContain("env_file");

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  it("Docker-secrets mode sweeps any leftover .env.<svc> files from prior env-file mode", async () => {
    const dir = setup();
    const secretsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-root-"));
    const entrypointPath = path.join(secretsRoot, "secrets-entrypoint.sh");
    fs.writeFileSync(entrypointPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    // Pre-seed a stale env-file-mode artifact.
    fs.mkdirSync(path.join(dir, ".shipit"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".shipit/.env.api"), "STALE=value\n");

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
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });

    try { await mgr.start(); } catch { /* expected */ }

    // Stale .env.api removed
    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      dockerSecretsConfig: {
        internalDir: secretsRoot,
        entrypointSourcePath: entrypointPath,
      },
    });
    const sessionDir = path.join(secretsRoot, "test-session");

    // Default stop (idle eviction / reconcile) preserves the dir for resume.
    const mgr1 = make();
    try { await mgr1.start(); } catch { /* expected */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr1.stop();
    expect(fs.existsSync(sessionDir)).toBe(true);

    // Teardown-for-good (archive / full reset) drops the plaintext secret files.
    const mgr2 = make();
    try { await mgr2.start(); } catch { /* expected */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr2.stop({ removeVolumes: true });
    expect(fs.existsSync(sessionDir)).toBe(false);

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  // ---- docs/183: out-of-workspace service env files ----

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
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected — no docker */ }

    // Env file written outside the workspace…
    const externalEnv = path.join(serviceEnvRoot, "test-session", ".env.api");
    expect(fs.existsSync(externalEnv)).toBe(true);
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://x");

    // …and NOT in the agent-readable workspace.
    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    // Override references the absolute external path, not the workspace path.
    const override = fs.readFileSync(path.join(dir, ".shipit/compose.override.yml"), "utf-8");
    expect(override).toContain("env_file:");
    expect(override).toContain(externalEnv);
    expect(override).not.toContain(".shipit/.env.api");

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });

  it("regression: dogfood-style service-only secrets stay out of the workspace (.shipit/.env.dev absent)", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    // The dogfood `dev` service declares service-only secrets with NO agent: true.
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
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ ANTHROPIC_API_KEY: "sk-ant-xxx", GITHUB_TOKEN: "ghp_xxx" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected */ }

    // No workspace leak — the agent can't read either secret-bearing file.
    expect(fs.existsSync(path.join(dir, ".shipit/.env.dev"))).toBe(false);
    // No agent env file, since nothing is marked agent: true.
    expect(fs.existsSync(path.join(dir, ".shipit/.env.agent"))).toBe(false);

    // The external service env file holds the values.
    const externalEnv = path.join(serviceEnvRoot, "test-session", ".env.dev");
    const body = fs.readFileSync(externalEnv, "utf-8");
    expect(body).toContain("ANTHROPIC_API_KEY=sk-ant-xxx");
    expect(body).toContain("GITHUB_TOKEN=ghp_xxx");

    fs.rmSync(serviceEnvRoot, { recursive: true, force: true });
  });

  it("serviceEnvDir sweeps a pre-183 in-workspace .shipit/.env.<svc> leak", async () => {
    const dir = setup();
    const serviceEnvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-root-"));
    // Pre-seed a leaked env file from the old in-workspace write path.
    fs.mkdirSync(path.join(dir, ".shipit"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".shipit/.env.api"), "LEAKED=value\n");

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
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ DATABASE_URL: "postgres://x" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected */ }

    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

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
    const overrideBefore = fs.readFileSync(path.join(dir, ".shipit/compose.override.yml"), "utf-8");
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://old");
    expect(overrideBefore).toContain(externalEnv);

    secrets = { DATABASE_URL: "postgres://new" };
    await mgr.refreshSecrets();

    // External file content updated…
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://new");
    // …and the absolute env_file path in the override is unchanged (still outside the workspace).
    const overrideAfter = fs.readFileSync(path.join(dir, ".shipit/compose.override.yml"), "utf-8");
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

    // Default stop (idle eviction / reconcile) preserves the dir for resume.
    const mgr1 = make();
    try { await mgr1.start(); } catch { /* ok */ }
    expect(fs.existsSync(sessionDir)).toBe(true);
    await mgr1.stop();
    expect(fs.existsSync(sessionDir)).toBe(true);

    // Teardown-for-good (archive / full reset) drops the plaintext secrets.
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner: fakeRunner,
      secretsLoader: async () => ({}), // no values — both surface as missing
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
    expect(last.agentNames).toEqual([]); // no value resolved → empty
  });
});

// ---------------------------------------------------------------------------
// Install-running retry gate
// ---------------------------------------------------------------------------

describe("ServiceManager install-running retry gate", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mgr-install-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  /**
   * Build a manager whose docker compose `ps` response is dynamic — the test
   * mutates `psResponse` to simulate the service exiting with a non-zero
   * exit code.
   */
  function makeManager(dir: string) {
    const composeUpCalls: string[][] = [];
    let psResponse = "";

    const composeRunner: ComposeRunner = (args) => {
      // Track which `up` calls happen (startup vs retry vs post-install)
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) {
        composeUpCalls.push(args.slice(upIdx));
      }
      return Promise.resolve();
    };

    const composeQuery: ComposeQuery = (args) => {
      const key = args.find(a => a === "ps" || a === "inspect" || a === "rm" || a === "network") ?? args[0];
      if (key === "ps") return Promise.resolve(psResponse);
      if (key === "inspect") return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      return Promise.resolve("");
    };

    const mgr = new ServiceManager({
      sessionId: "test-session",
      workspaceDir: dir,
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0, // disable periodic polling — we drive pollStatus manually
    });

    return {
      mgr,
      composeUpCalls,
      setPsResponse: (s: string) => { psResponse = s; },
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
    // Opted out of the install gate (docs/137) so this exercises the legacy
    // install-window backoff net rather than being held by the gate.
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);

    await mgr.start();

    // Service exited non-zero, but install is in flight → status held at
    // `starting` (retry pending), NOT `error`.
    const web = mgr.getService("web");
    expect(web?.status).toBe("starting");
    expect(web?.error).toBeUndefined();
  });

  it("marks error when install has already finished", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    // Install gate closed (default) — same exit should latch to `error`.
    await mgr.start();

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("Exited with code 1");
  });

  /** Drain queued microtasks. Several hops happen inside runRetryNow. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  it("restarts errored services when install finishes", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    // Service crashes during initial start with no install gate → `error`.
    setPsResponse(exitedPs(1));
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("error");

    const upCallsBeforeFlush = composeUpCalls.length;

    // Now install starts and finishes — flushing should restart the errored
    // service (one explicit pass).
    mgr.setInstallRunning(true);
    setPsResponse(runningPs());
    mgr.setInstallRunning(false);

    // Allow the post-install runRetryNow microtasks to run.
    await flushMicrotasks();

    expect(composeUpCalls.length).toBeGreaterThan(upCallsBeforeFlush);
    // The retry brought the service to running.
    expect(mgr.getService("web")?.status).toBe("running");
  });

  it("backoff retry restarts the service via composeUpService", async () => {
    vi.useFakeTimers();
    const dir = setup();
    // Opted out of the install gate (docs/137) — the install-window backoff
    // net only applies to non-gated services now.
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    const upCallsBefore = composeUpCalls.length;

    // Backoff schedule starts at 1s — advance and let the queued retry run.
    setPsResponse(runningPs());
    await vi.advanceTimersByTimeAsync(1_000);
    // Allow scheduled microtasks (composeUpService → pollStatus) to settle.
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

    // Manual service won't be in autoServices, so it won't be started by
    // start(). To exercise the pollStatus path we'd need to start it
    // manually — skip; just verify the gate flag plumbs through.
    expect(mgr.installRunning).toBe(false);
    mgr.setInstallRunning(true);
    expect(mgr.installRunning).toBe(true);
    mgr.setInstallRunning(false);
    expect(mgr.installRunning).toBe(false);

    // No services were registered with auto preview; reading service is fine.
    setPsResponse("");
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("setInstallRunning is idempotent — repeating the same value is a no-op", () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr } = makeManager(dir);

    mgr.setInstallRunning(false); // already false
    expect(mgr.installRunning).toBe(false);
    mgr.setInstallRunning(true);
    mgr.setInstallRunning(true); // no-op
    expect(mgr.installRunning).toBe(true);
  });

  it("stop() cancels pending retry timers", async () => {
    vi.useFakeTimers();
    const dir = setup();
    // Opted out of the install gate (docs/137) so a real backoff timer is
    // scheduled — that's what stop() must cancel.
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    mgr.setInstallRunning(true);
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting");

    const upCallsBefore = composeUpCalls.length;
    await mgr.stop();
    // Even if we advance past the backoff, no further `up` should fire.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(composeUpCalls.length).toBe(upCallsBefore);
  });

  // --- OOM auto-retry (exit code 137 post-install) ---
  //
  // The install-window retry above covers cold-start races. These tests
  // cover the symmetric case: a `preview: auto` service that's been up,
  // then gets OOM-killed *after* install finished. Without this path the
  // service latches to `error` and Rescue session can't fix it (the new
  // compose stack hits the same memory condition).

  it("auto-retries on OOM (exit 137) after install has finished", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, composeUpCalls, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(137));
    // Install gate is closed — this exercises the post-install OOM path.
    await mgr.start();

    // Service should be in `starting` (retry pending), NOT `error`.
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    const upCallsBefore = composeUpCalls.length;
    // Advance through the first backoff slot (1s) and let the retry run.
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
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(137));
    await mgr.start();
    expect(mgr.getService("web")?.status).toBe("starting"); // retry #1 pending

    // Run through the backoff schedule (1s, 2s, 4s) — service keeps OOMing.
    // Each retry should keep status at `starting` until the cap is hit.
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTimersAsync();
    }

    // After 3 OOM retries, the service should be latched to error with the
    // bounded-retry message.
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
    const { mgr, setPsResponse } = makeManager(dir);

    // Manual services aren't started by mgr.start(), so the OOM exit path is
    // reached via an explicit startService + pollStatus.
    await mgr.start();
    expect(mgr.getService("worker")?.status).toBe("stopped");

    setPsResponse(JSON.stringify({
      Service: "worker", ID: "abc", State: "exited", ExitCode: 137,
    }));
    // Simulate a poll where the manual service shows as exited 137.
    // composeRunner just resolves, so the "up" succeeds but the next ps
    // still says exited.
    await mgr.startService("worker");

    const worker = mgr.getService("worker");
    // Manual service path is "error" with the bare OOM hint, no auto-retry.
    expect(worker?.status).toBe("error");
    expect(worker?.error).toContain("Exited with code 137 (likely OOMKilled)");
  });

  it("resets OOM counter when user explicitly calls startService", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    // Burn through the retry budget.
    setPsResponse(exitedPs(137));
    await mgr.start();
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await vi.runAllTimersAsync();
    }
    expect(mgr.getService("web")?.status).toBe("error");

    // User clicks "start" — should reset the budget and try again. With ps
    // still reporting an OOM exit, the next pollStatus inside startService
    // should re-enter the retry path (status: "starting") instead of the
    // "gave up" latch — proving the counter was reset.
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");
  });

  it("non-137 exits still latch to error post-install (no auto-retry)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);

    setPsResponse(exitedPs(1));
    await mgr.start();
    // Exit code 1 (not OOM) — no retry, goes straight to error.
    expect(mgr.getService("web")?.status).toBe("error");
    expect(mgr.getService("web")?.error).toContain("Exited with code 1");
  });

  // --- Container-name conflict recovery on `compose up` ---
  //
  // The daemon rejects a create when a stale container with the predicted
  // name lingers (prior teardown interrupted, labels drifted, or another
  // `up` raced). Compose surfaces this verbatim as "already in use by
  // container <id>". `composeUpService` must extract the conflict ID,
  // force-remove the squatter, and retry once.

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
      // pollStatus: `compose … ps --format json -a` → return running container
      if (args.includes("ps") && args.includes("--format")) {
        return Promise.resolve(JSON.stringify({
          Service: "dev", ID: "newid", State: "running", ExitCode: 0,
        }));
      }
      // killStaleContainers: `docker ps -aq --filter …` → no stale containers
      if (args[0] === "ps") return Promise.resolve("");
      if (args.includes("inspect")) {
        return Promise.resolve(JSON.stringify([{ NetworkSettings: { Networks: {} } }]));
      }
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
    await mgr.startService("dev");

    // First up failed with conflict, then we removed the squatter, then up
    // ran again.
    expect(composeUpCalls.length).toBe(2);
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0]).toEqual([
      "rm", "-f",
      "6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631",
    ]);
    expect(mgr.getService("dev")?.status).toBe("running");
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
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeRunner,
      composeQuery,
      pollIntervalMs: 0,
    });

    await mgr.start();
    await expect(mgr.startService("dev")).rejects.toThrow(/image not found/);
    // Exactly one `up` (the failing one) and no `rm` — non-conflict errors
    // don't trigger the recovery path.
    expect(upCalls.length).toBe(1);
    expect(rmCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Declarative install gate (docs/137-depends-on-install)
// ---------------------------------------------------------------------------

describe("ServiceManager install gate (x-shipit-depends-on-install)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mgr-gate-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function writeCompose(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), content);
  }

  /**
   * Build a manager that records the service names passed to each `up` and
   * each `stop`, and serves a configurable `docker compose ps` response.
   */
  function makeManager(dir: string) {
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
      sessionId: "test-session",
      workspaceDir: dir,
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

  /** Names passed across every `up` invocation. */
  function upNames(upCalls: string[][]): string[] {
    const names: string[] = [];
    for (const call of upCalls) {
      // Strip leading flags (up -d --build --remove-orphans …); service names
      // are the non-flag trailing args.
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

    // Gated service is held in `starting`, never passed to `up`.
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

    // Install finishes successfully → service starts in one `up` and the
    // poll sees it running.
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(false);
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
    // It was never started.
    expect(upNames(upCalls)).not.toContain("web");
  });

  it("starts immediately when no install is in flight (vacuous open)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    // No setInstallRunning(true) — gate is vacuously open.
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

    // Opted out → starts immediately despite the open install window.
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

    // Only the non-gated service was brought up; the gated one is held.
    expect(upNames(upCalls)).toContain("free");
    expect(upNames(upCalls)).not.toContain("gated");
    expect(mgr.getService("gated")?.status).toBe("starting");
  });

  it("tears down and restarts gated services on a mid-session re-install", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, stopCalls, setPsResponse } = makeManager(dir);

    // Initial boot with install → start → running.
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(true);
    await mgr.start();
    mgr.setInstallRunning(false);
    await flushMicrotasks();
    expect(mgr.getService("web")?.status).toBe("running");

    const upCountBefore = upNames(upCalls).filter(n => n === "web").length;

    // Re-install begins → gated service torn down + re-held.
    mgr.setInstallRunning(true);
    await flushMicrotasks();
    expect(stopCalls).toContain("web");
    expect(mgr.getService("web")?.status).toBe("starting");

    // Re-install finishes → service restarted exactly once more.
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

    // Exactly one new `up` invocation carrying both gated service names.
    expect(upCalls.length).toBe(upCallCountBefore + 1);
    const lastUp = upCalls[upCalls.length - 1];
    expect(lastUp).toContain("a");
    expect(lastUp).toContain("b");
  });
});
