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
  UP_SILENCE_TIMEOUT_MS,
  UP_STALLED_MESSAGE,
  COMPOSE_LOG_PREFIX,
  MAX_COMPOSE_LOG_LINE,
  type ComposeRunner,
  type ComposeQuery,
  type SecretsStatusInternalSnapshot,
} from "./service-manager.js";
import { SESSION_WORKSPACE_SUBDIR, SESSION_STATE_SUBDIR } from "./session-state-dir.js";
import { serializeStackOp } from "./stack-op-queue.js";

/**
 * Create a real session layout in a temp dir: the clone at
 * `<sessionDir>/workspace`, ShipIt's state dir at its `state/` sibling.
 *
 * `ServiceManager` resolves the state dir from the clone path (docs/246), and
 * since planning#288 it REFUSES a clone that doesn't sit at `workspace/` rather than
 * falling back to writing into the clone — so a bare temp dir is no longer a
 * valid workspace. Returns the session dir; the clone is its `workspace/` child.
 */
function makeSessionDir(prefix: string): string {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(sessionDir, SESSION_WORKSPACE_SUBDIR), { recursive: true });
  return sessionDir;
}

/** The session state dir for a clone produced by {@link makeSessionDir}. */
function stateOf(workspaceDir: string): string {
  return path.resolve(workspaceDir, "..", SESSION_STATE_SUBDIR);
}

/**
 * The orchestrator-private service-env root for a clone produced by
 * {@link makeSessionDir} — a sibling of `workspace/`, so it is outside the
 * clone. `ServiceManager` requires one (planning#292): there is no longer an
 * in-clone `.shipit/.env.<svc>` fallback, and a root that resolves inside the
 * clone is refused outright.
 */
function serviceEnvOf(workspaceDir: string): string {
  return path.resolve(workspaceDir, "..", "service-env");
}

/** Where `<svc>`'s env file lands for a manager built with {@link serviceEnvOf}. */
function serviceEnvFile(workspaceDir: string, sessionId: string, svc: string): string {
  return path.join(serviceEnvOf(workspaceDir), sessionId, `.env.${svc}`);
}

/**
 * A `composeQuery` that answers every query with empty stdout.
 *
 * Stubbing `composeRunner` alone is NOT enough to keep a test off the real
 * Docker daemon: `ComposeCli` falls back to `defaultComposeQuery` — a live
 * `spawn("docker", …)` — whenever `composeQuery` is omitted. `start()` opens
 * with `killStaleContainers()` (a `docker ps`), and the poller then re-queries
 * on `pollIntervalMs`, which these tests set to 0. On a machine with no docker
 * binary each spawn fails instantly and the test passes; on a CI runner where
 * the daemon exists, the same test awaits real daemon round-trips in a ~1ms
 * loop and blows the 5s timeout. That environment split is what made two
 * `refreshSecrets` tests pass locally and time out in CI.
 *
 * Empty output is the right answer for a test that never asserts on compose
 * state: no stale containers to sweep, no containers for the poller to find.
 */
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

  /** A compose runner that rejects immediately (no real Docker needed). */
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

    // The adoption path reconciles on this answer, so an identical re-point must
    // read as unchanged (no stack restart on every agent restart) and a real
    // change must not be swallowed (the override on disk is otherwise stale).
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
      serviceEnvDir: serviceEnvOf(dir),
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

  /**
   * `streamLogs` is the one docker spawn that bypasses the injectable compose
   * runner, so it execs for real even when a test has stubbed every other
   * docker call. Inside a ShipIt session container there is no `docker` binary
   * at all, so the spawn emits ENOENT asynchronously — and an 'error' event
   * with no listener is rethrown as an uncaughtException that killed the
   * vitest worker, taking the whole `npm test` run down with it.
   */
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

    // The exact failure a docker-less container produces must be absorbed,
    // not rethrown, and must retire the dead follower from the registry.
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
      serviceEnvDir: serviceEnvOf(dir),
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

    // Running + IP + port → ready-to-use direct URL the agent's curl/browser can hit.
    const running = mgr.getServices().find((s) => s.name === "web");
    expect(running?.url).toBe("http://172.20.0.2:5173/");

    // `url` is derived on read, never stored on the internal model.
    expect(mgr.getService("web")).not.toHaveProperty("url");
  });

  it("getServices omits url when a service has a port but no detected IP (GH #1509)", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    // start() registers the service (with its declared port) but, with empty
    // docker query responses, it never reaches `running` with a container IP.
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
    // startError should be cleared during reconcile but start doesn't clear it
    // reconcile does
    mgr.startError = "stale error";
    await mgr.reconcile();
    expect(mgr.startError).toBeNull();
  });

  /**
   * planning#382 — an empty service list must be able to say WHY.
   *
   * The defect these pin: a compose file ShipIt declines throws out of
   * `start()`, which reaches the Preview pane as `compose_error` and reaches
   * every reader of the service list as nothing at all. So the list read as
   * "this project declares no services" when the truth was "refused, here is
   * the line to change" — and docs/263's containment rules decline a STOCK
   * compose file, so that was a project's FIRST answer, not an edge case.
   */
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

      // The list is empty, and this is the whole of what makes that empty list
      // legible: the classification says the file was understood and declined,
      // and the message is the parser's own — it names the service and the fix.
      expect(mgr.getServices()).toEqual([]);
      expect(mgr.projectComposeFailure?.kind).toBe("refused");
      expect(mgr.projectComposeFailure?.message).toContain("web");
      expect(mgr.projectComposeFailure?.message).toContain("privileged");
    });

    it("records a file it could not parse as MALFORMED, not refused", async () => {
      const dir = setup();
      // Valid YAML, not a compose document — the "could not understand it"
      // half, which must NOT claim its message names a fix.
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

      // The user fixes the file and the stack reconciles. A stale refusal here
      // would keep telling the agent to edit a line it has already edited.
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['3000:3000']\n");
      await mgr.reconcile();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    it("drops a stale failure when the project stops declaring a compose file", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();

      // `noProjectCompose` means `start()` never parses, so nothing else would
      // clear the record — the session would report a refusal against a stack
      // that no longer exists.
      mgr.updateComposeConfig(
        { file: "other-compose.yml", dockerSocket: false },
        { noProjectCompose: true },
      );
      await mgr.reconcile();
      expect(mgr.projectComposeFailure).toBeNull();
    });

    /**
     * Review finding — the config change drops it IMMEDIATELY, not one
     * reconcile later. Its production caller queues the reconcile
     * asynchronously (`service-manager-setup.ts`), so anything in between
     * would read a rule quoted against a file this session has stopped
     * declaring.
     */
    it("drops the failure the moment the compose config changes, before any reconcile", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      const mgr = createMockedManager(dir);
      await expect(mgr.start()).rejects.toThrow();
      expect(mgr.projectComposeFailure).not.toBeNull();

      mgr.updateComposeConfig({ file: "deploy/compose.yml", dockerSocket: false });
      expect(mgr.projectComposeFailure).toBeNull();
    });

    /**
     * Review finding — the mirror image, and the reason `reconcile()` does NOT
     * clear the record itself. `start()` can throw before it ever reaches the
     * parse; clearing optimistically at the top of the reconcile would erase a
     * refusal that is still true, and the list would go back to reading as an
     * empty project with no reason at all.
     */
    it("keeps the failure when a reconcile dies before it reaches the parse", async () => {
      const dir = setup();
      writeCompose(dir, "services:\n  web:\n    image: node:20\n    privileged: true\n");
      // `ensureSessionNetworkModeFn` runs first thing in `start()`, before the
      // compose file is read at all — so the second call models a daemon that
      // goes away between the first start and the reconcile.
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

    /**
     * Review finding — `refreshSecretsStatus` was a SECOND inline copy of the
     * same parse, so it neither recorded a refusal it discovered nor retracted
     * one the user had since fixed. It runs whenever a plugin activation round
     * settles, so a stale reason there had nothing to clear it.
     */
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

      // Third-party plugin code has the workspace read-write (docs/262), so the
      // file really can change under a running stack.
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
      // No file on disk. Parsing the path anyway would file a `malformed`
      // reason against a plugin-only project, which declares no stack.
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
      serviceEnvDir: serviceEnvOf(dir),
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

    // planning#292 — and nowhere near the user's clone.
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);

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
      // no secretsLoader
      pollIntervalMs: 0,
    });

    try { await mgr.start(); } catch { /* expected */ }

    // The env file is still written (with header only, no values) so compose's
    // env_file: reference doesn't fail with "missing file"
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
    // planning#292 — the reference is the absolute out-of-clone path, never
    // `.shipit/.env.api` inside the user's repository.
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

  // ---- Phase 3: agent: true → .env.agent + secrets snapshot ----

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
    // STRIPE_KEY is service-only — not agent-injected
    expect(agentEnv).not.toContain("STRIPE_KEY");

    const snap = mgr.getSecretsSnapshot();
    expect(snap.agentNames).toEqual(["DATABASE_URL"]);
    expect(snap.agentValues).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("removes the state dir's .env.agent when no agent: true declarations remain", async () => {
    const dir = setup();
    // Pre-seed an existing .env.agent file from a prior compose definition.
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

    // Per-secret file written outside the workspace
    const secretFile = path.join(secretsRoot, "test-session", "DATABASE_URL");
    expect(fs.existsSync(secretFile)).toBe(true);
    expect(fs.readFileSync(secretFile, "utf-8")).toBe("postgres://x");

    // No .env.api in the workspace — agent can't read it
    expect(fs.existsSync(path.join(dir, ".shipit/.env.api"))).toBe(false);

    // planning#287 — the entrypoint wrapper is staged in the secrets root, NOT in
    // the clone, where the post-turn `git add -A` would commit it into the
    // user's repository (docs/246-shipit-state-out-of-clone req 1).
    const stagedWrapper = path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh");
    expect(fs.existsSync(stagedWrapper)).toBe(true);
    expect(fs.statSync(stagedWrapper).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(dir, ".shipit/secrets-entrypoint.sh"))).toBe(false);

    // Override references Docker secrets, not env_file, and mounts the wrapper
    // from its absolute staged path.
    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain("shipit-DATABASE_URL");
    expect(override).toContain("/shipit/secrets-entrypoint.sh");
    expect(override).toContain(stagedWrapper);
    expect(override).not.toContain("env_file");

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  // planning#287 / docs/246-shipit-state-out-of-clone req 1 — the whole point: a Docker-secrets session leaves
  // the git clone untouched. Before the fix this test failed on
  // `.shipit/secrets-entrypoint.sh`.
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

    // The clone holds exactly what the user put there.
    expect(fs.readdirSync(dir).sort()).toEqual(["docker-compose.yml"]);

    // Everything ShipIt generated is elsewhere, and the override points the
    // service at the staged wrapper by absolute path.
    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
    expect(override).toContain(path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh"));

    fs.rmSync(secretsRoot, { recursive: true, force: true });
  });

  // The staged wrapper is bind-mounted by the DAEMON, so a containerized
  // orchestrator must express its path in host terms — the same `hostDir`
  // mapping the top-level `secrets: file:` references already use.
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

    // Written where the orchestrator can reach it...
    expect(fs.existsSync(path.join(secretsRoot, "_entrypoint", "secrets-entrypoint.sh"))).toBe(true);
    // ...referenced where the daemon can, alongside the secret files themselves.
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
      composeQuery: emptyComposeQuery,
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
    const override = fs.readFileSync(path.join(stateOf(dir), "compose.override.yml"), "utf-8");
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
      composeQuery: emptyComposeQuery,
      composeRunner: fakeRunner,
      secretsLoader: async () => ({ ANTHROPIC_API_KEY: "sk-ant-xxx", GITHUB_TOKEN: "ghp_xxx" }),
      pollIntervalMs: 0,
      serviceEnvDir: serviceEnvRoot,
    });

    try { await mgr.start(); } catch { /* expected */ }

    // No workspace leak — the agent can't read either secret-bearing file.
    expect(fs.existsSync(path.join(dir, ".shipit/.env.dev"))).toBe(false);
    // No agent env file, since nothing is marked agent: true.
    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(false);

    // The external service env file holds the values.
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

    // External file content updated…
    expect(fs.readFileSync(externalEnv, "utf-8")).toContain("DATABASE_URL=postgres://new");
    // …and the absolute env_file path in the override is unchanged (still outside the workspace).
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
      serviceEnvDir: serviceEnvOf(dir),
      composeConfig: { file: "docker-compose.yml", dockerSocket: false },
      composeQuery: emptyComposeQuery,
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

  // docs/262 req 23 — a settled plugin activation changes WHICH credential
  // names are declared, and `secrets_status` samples that only in its own sync.
  it("refreshSecretsStatus re-publishes plugin needs without touching containers", async () => {
    const dir = setup();
    writeCompose(dir, `
services:
  api:
    image: node:20
    ports: ['3000:3000']
`);
    // The first sync sees no live generation; the second sees one.
    let declarations: { repo: string; plugin: string; alias: string; credentials: string[] }[] = [];
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

    declarations = [{ repo: "art-kit", plugin: "palette", alias: "artk", credentials: ["FAL_KEY"] }];
    const callsBefore = composeCalls.length;
    await mgr.refreshSecretsStatus();

    expect(snapshots.at(-1)?.plugins).toEqual([
      {
        repo: "art-kit",
        plugin: "palette",
        alias: "artk",
        credentials: [{ name: "FAL_KEY", satisfied: false }],
      },
    ]);
    // The whole point of the narrow method: no `compose up`, so a plugin
    // refresh never restarts the user's services.
    expect(composeCalls.length).toBe(callsBefore);
  });

  it("refreshSecretsStatus leaves the snapshot alone when the compose file will not parse", async () => {
    // Syncing an empty service list would sweep the env files of services that
    // are still running.
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
        { repo: "art-kit", plugin: "palette", alias: "artk", credentials: ["FAL_KEY"] },
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

// ---------------------------------------------------------------------------
// Install-running retry gate
// ---------------------------------------------------------------------------

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

  /**
   * Build a manager whose docker compose `ps` response is dynamic — the test
   * mutates `psResponse` to simulate the service exiting with a non-zero
   * exit code.
   */
  function makeManager(dir: string) {
    const composeUpCalls: string[][] = [];
    const composeStopCalls: string[] = [];
    let psResponse = "";
    // What `docker inspect` reports for `State.OOMKilled`. `undefined` models a
    // daemon that omits the field (the manager treats that as "unknown", not
    // "not an OOM"). Exit 137 alone no longer implies OOM — see docs/239.
    let oomKilled: boolean | undefined = false;

    const composeRunner: ComposeRunner = (args) => {
      // Track which `up` calls happen (startup vs retry vs post-install)
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
      pollIntervalMs: 0, // disable periodic polling — we drive pollStatus manually
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

    // This assertion intentionally leaves an install-window backoff retry
    // pending. Dispose the manager so the real timer cannot leak into later
    // fake-timer tests and create an unbounded retry chain.
    await mgr.stop();
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
    const { mgr, composeUpCalls, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(true); // the daemon confirms the kernel OOM-killer did it
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
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(true);
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
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    // Manual services aren't started by mgr.start(), so the OOM exit path is
    // reached via an explicit startService + pollStatus.
    await mgr.start();
    expect(mgr.getService("worker")?.status).toBe("stopped");

    setPsResponse(JSON.stringify({
      Service: "worker", ID: "abc", State: "exited", ExitCode: 137,
    }));
    setOomKilled(true);
    // Simulate a poll where the manual service shows as exited 137.
    // composeRunner just resolves, so the "up" succeeds but the next ps
    // still says exited.
    await mgr.startService("worker");

    const worker = mgr.getService("worker");
    // Manual service path is "error" with the bare OOM hint, no auto-retry.
    expect(worker?.status).toBe("error");
    expect(worker?.error).toContain("Exited with code 137 (OOMKilled)");
  });

  it("resets OOM counter when user explicitly calls startService", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse, setOomKilled } = makeManager(dir);

    // Burn through the retry budget.
    setPsResponse(exitedPs(137));
    setOomKilled(true);
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

  // --- Exit 137 is SIGKILL, not proof of OOM (docs/239) ---
  //
  // Production incident: a cached ~35ms re-install looping every 30s SIGKILLed
  // the `dev` service via our own `compose stop` teardown. Every cycle exited
  // 137 with `OOMKilled: false` on a service using 110 MiB of a 3 GiB limit,
  // was auto-"OOM"-retried until the budget drained, and then latched to
  // `error` telling the user to raise a memory limit that was never binding.

  it("does not treat exit 137 as OOM when the daemon reports OOMKilled: false", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n    x-shipit-depends-on-install: false\n");
    const { mgr, composeUpCalls, setPsResponse, setOomKilled } = makeManager(dir);

    setPsResponse(exitedPs(137));
    setOomKilled(false); // authoritative: this was a plain SIGKILL
    await mgr.start();

    // No OOM auto-retry — latches immediately with an honest message that does
    // NOT advise raising a memory limit.
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
    setOomKilled(undefined); // daemon omitted State.OOMKilled
    await mgr.start();

    // Unconfirmed — we neither auto-retry as an OOM nor assert it happened.
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

    // Gate opens; the service crashes with 137 inside its first-boot window.
    // Before docs/239 the `exitCode === 137` branch sat above the post-gate
    // check and short-circuited it — the recovery path built for exactly this
    // ("crashed right after the gate opened") never ran. Confirming the OOM
    // first makes the ordering moot: an unconfirmed 137 now falls through.
    setPsResponse(exitedPs(137));
    setOomKilled(false);
    mgr.setInstallRunning(false);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);

    // Held in `starting` by the bounded post-gate retry, not latched to error.
    expect(mgr.getService("web")?.status).toBe("starting");

    // Drain the post-gate budget. The terminal message names which path owned
    // the crash: the OOM path would have said "gave up after 3 auto-retries"
    // and told the user to raise a memory limit.
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
      serviceEnvDir: serviceEnvOf(dir),
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
        // Each egress sidecar is excluded via its own AND-filtered keep-label query.
        if (args.some((a) => a.includes("shipit-egress-resolver=test-session"))) return Promise.resolve("resolver-id\n");
        if (args.some((a) => a.includes("shipit-egress-proxy=test-session"))) return Promise.resolve("proxy-id\n");
        // The broad parent-session query returns both sidecars and a real stale.
        if (args.includes("--format")) return Promise.resolve(""); // poll: no containers
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

    // Exactly one rm, targeting the stale compose container — both egress sidecars
    // (resolver-id, proxy-id) are excluded so they survive the pre-start sweep.
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
        // Keep-label queries for the egress sidecars — neither is present.
        if (args.some((a) => a.includes("shipit-egress-"))) return Promise.resolve("");
        if (args.includes("--format")) return Promise.resolve(""); // poll
        // The broad `shipit-parent-session` sweep query. Answering it with a
        // container id is the whole point: on a reconcile this is the session's
        // OWN live preview container, and `rm -f` on it is a SIGKILL with no
        // preceding SIGTERM — the exit 137 the user sees on every edit to
        // `docker-compose.yml`.
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

    // Cold start still sweeps: anything carrying this session's label there is
    // left over from a previous orchestrator run or agent-container incarnation.
    await mgr.start();
    expect(rmCalls.find((c) => c.includes("live-preview-id"))).toEqual([
      "rm", "-f", "live-preview-id",
    ]);

    // A reconcile is a config change against a LIVE stack. Compose's own
    // recreate (plus `--remove-orphans`, plus the surgical conflict recovery)
    // owns the transition; no broad `rm -f` may run.
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

  /**
   * Build a manager that records the service names passed to each `up` and
   * each `stop`, and serves a configurable `docker compose ps` response.
   *
   * `sessionId` is overridable because the stack queue (`serializeStackOp`) is a
   * module-level map keyed on it, shared by every test in this file. A test that
   * holds the queue — or fails before releasing it — would otherwise stall every
   * later test that opens the install gate. Any test that touches the queue
   * takes an id of its own.
   */
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

  it("holds the gated start behind an in-flight stack op instead of racing it", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    // Its own session id: this test parks the module-level stack queue, and a
    // failure before `release()` would otherwise stall every later test that
    // opens the install gate.
    const sessionId = "test-session-gate-queue";
    const { mgr, upCalls, setPsResponse } = makeManager(dir, sessionId);

    mgr.setInstallRunning(true);
    await mgr.start();
    expect(upNames(upCalls)).not.toContain("web");

    // Stand in for the plugin-service reconcile a session activation runs
    // concurrently with `agent.install`: it holds the session's stack op, which
    // in production is a `docker compose up` mid-recreate.
    let release!: () => void;
    const reconcile = new Promise<void>((r) => { release = r; });
    const queued = serializeStackOp(sessionId, () => reconcile);

    try {
      setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
      mgr.setInstallRunning(false);
      await flushMicrotasks();

      // The gate is open — the service reads as `starting` — but no compose
      // command has gone out, because the queue is busy. Unserialized, this `up`
      // landed inside the reconcile's recreate: compose failed with "removal of
      // container … is already in progress", the container was force-removed
      // (exit 137), and the service walked to `stopped` 30s later.
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

  it("holds gated services until the re-install teardown's SIGKILL has landed", async () => {
    // Regression for docs/239. `compose stop` SIGTERMs and then SIGKILLs when
    // the 10s grace period expires — and a `command: sh -c "npm install && npm
    // run dev"` service never forwards SIGTERM, so the kill always lands. The
    // gate used to reopen ~35ms after the hold (a cached no-op re-install),
    // i.e. ~10s BEFORE that kill, so the poller saw the exit with the service
    // no longer gated and reported OUR teardown to the user as an OOM crash.
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    let releaseStop = (): void => {};
    const stopLanded = new Promise<void>((resolve) => { releaseStop = resolve; });
    const upCalls: string[][] = [];
    let psResponse = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });

    const composeRunner: ComposeRunner = async (args) => {
      const upIdx = args.indexOf("up");
      if (upIdx >= 0) upCalls.push(args.slice(upIdx));
      // Model the grace period: the stop only resolves when the test says the
      // container has actually died.
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

    // Mid-session re-install: hold + tear down, then the (cached, instant)
    // install completes while the container is still shutting down.
    mgr.setInstallRunning(true);
    psResponse = JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 137 });
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    // Gate still closed — nothing was relaunched into a container we're still
    // killing, and the poll that sees the 137 is skipped as gated, so the
    // service stays held in `starting` instead of surfacing as a crash.
    expect(webUps()).toBe(upsBefore);
    await poll();
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    // Teardown lands → gate opens → the service relaunches exactly once.
    releaseStop();
    await flushMicrotasks();
    expect(webUps()).toBe(upsBefore + 1);

    // The gate-open `up` scheduled a post-gate backoff retry (ps still says
    // exited) — dispose so that timer can't leak into later tests.
    await mgr.stop();
  });

  // -------------------------------------------------------------------------
  // Post-gate recovery — a gated service that crashes shortly AFTER the gate
  // opens (e.g. the install-complete signal led the dependency tree on a
  // warm/reused fast-install path, so `node_modules/.bin/astro` wasn't on disk
  // yet → exit 127). Previously this latched to `error` forever with zero
  // retries; now it gets a bounded post-gate restart pass. See docs/137.
  // -------------------------------------------------------------------------

  it("retries instead of latching when a gated service crashes just after the gate opens", async () => {
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, upCalls, setPsResponse } = makeManager(dir);

    // Install in flight → web held by the gate, never started.
    mgr.setInstallRunning(true);
    await mgr.start();
    expect(upNames(upCalls)).not.toContain("web");

    // Gate opens; the service is brought up but crashes on first boot. The
    // single poll inside startGatedBatch observes the exit-127 transition.
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 127 }));
    mgr.setInstallRunning(false);
    await flushMicrotasks();

    // It WAS brought up (gate opened) …
    expect(upNames(upCalls)).toContain("web");
    // … but the post-gate crash is held in `starting` (retry pending), NOT
    // latched to `error`. This is the regression: pre-fix it sat in `error`
    // with no owner until a manual restart.
    const web = mgr.getService("web");
    expect(web?.status).toBe("starting");
    expect(web?.error).toBeUndefined();

    // This test runs on real timers and just scheduled a 1s backoff retry.
    // Dispose so that pending timer is cancelled instead of firing after the
    // test and leaking a retry chain into the rest of the suite.
    await mgr.stop();
  });

  it("recovers a post-gate crash once deps finish landing", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");

    // Drive recovery off the number of times `web` has actually been brought
    // up rather than a manual timer dance: it crashes on its first boot (the
    // gate-open `up`) and comes up healthy on the second (a backoff retry),
    // simulating deps landing during the backoff window. This is fully
    // deterministic under `runAllTimersAsync` and structurally cannot loop —
    // the second `up` flips `ps` to running, so the retry succeeds.
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
    expect(webUps).toBe(0); // gated — not brought up during install

    // Gate opens → first boot (webUps→1) crashes 127 → bounded post-gate
    // retry. The retry's `up` (webUps→2) flips `ps` to running → recovered.
    mgr.setInstallRunning(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mgr.getService("web")?.status).toBe("running");
    expect(webUps).toBeGreaterThanOrEqual(2);
  });

  it("keeps the post-gate window open while the service establishes — a crash after first `running` is retried", async () => {
    // Regression for the live docs/183 finding: a `command: npm install && npm
    // run dev` service is `running` a minute before the dev server exists; an
    // ETXTBSY crash in that establishment phase used to land OUTSIDE the
    // post-gate window (it closed at the first `running` poll) and latch to
    // `error` with zero retries. The window must now stay open until the
    // service has been stably running.
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
    const { mgr, setPsResponse } = makeManager(dir);
    const poll = () => (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();

    mgr.setInstallRunning(true);
    await mgr.start();

    // Gate opens onto a service that boots `running` immediately…
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 }));
    mgr.setInstallRunning(false);
    await vi.advanceTimersByTimeAsync(0); // flush the gate-open up→poll chain
    expect(mgr.getService("web")?.status).toBe("running");

    // …then crashes during establishment, well before the 60s stable window.
    await vi.advanceTimersByTimeAsync(10_000);
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 1 }));
    await poll();

    // Held in `starting` with a bounded retry pending — NOT latched to error.
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
    await vi.advanceTimersByTimeAsync(0); // flush the gate-open up→poll chain
    expect(mgr.getService("web")?.status).toBe("running");

    // Stays up past the stable window (60s) → the recovery window closes.
    await vi.advanceTimersByTimeAsync(61_000);

    // A later, unrelated crash gets normal error handling.
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

    // Service is genuinely broken — every boot crashes 127.
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 127 }));
    mgr.setInstallRunning(false);
    // Run the bounded post-gate backoff slots to exhaustion without draining
    // unrelated timers that may exist elsewhere in the test process.
    for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toContain("Exited with code 127");
  });
});

/**
 * #2044 — a manual service that started successfully sat at `status: "starting"`
 * indefinitely and never published an address, so the agent had no supported way
 * to reach a service it had just brought up.
 *
 * Three independent guarantees, each of which alone would have unblocked that
 * report:
 *   1. the address is published as soon as a container has one, whatever the
 *      readiness verdict says;
 *   2. `starting` is bounded — nothing can pin a service there forever without
 *      a reason landing on it;
 *   3. the poll loop, which is the only thing that ever resolves `starting`,
 *      always ends up running.
 */
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
    /** Resolves the `docker compose up` — override to hang or reject. */
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

  /** A `ps` row for a container that exists but whose state tells us nothing. */
  const createdPs = JSON.stringify({ Service: "web", ID: "abc", State: "created", ExitCode: 0 });
  const runningPs = JSON.stringify({ Service: "web", ID: "abc", State: "running", ExitCode: 0 });
  const exitedPs = JSON.stringify({ Service: "web", ID: "abc", State: "exited", ExitCode: 0 });

  it("publishes url while still `starting`, as soon as the container has an address", async () => {
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    const { mgr, setPsResponse } = makeManager(dir);

    await mgr.start();
    // The container exists (so `docker inspect` answers with an IP) but its
    // state doesn't confirm readiness — exactly the reported situation.
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

    // Clean exit → `stopped`. The IP we last resolved now describes a dead
    // container, so it must not be advertised as an address.
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
    // `ps` never reports this service — the status probe is blind to it.
    setPsResponse("");
    await mgr.startService("web");
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS + 1_000);

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe(STARTING_TIMEOUT_MESSAGE);
    // The message must not claim the service failed — we only know readiness
    // was never confirmed, and it must stay true for the `restarting` route in
    // as well as the never-observed one.
    expect(web?.error).toContain("may in fact be running");
    expect(web?.error).toContain("restart loop");
  });

  it("does not fire the watchdog while a compose up is still in flight", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // An image build has no upper bound — the up simply hasn't returned yet.
    let releaseUp: (() => void) | undefined;
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>((resolve) => { releaseUp = resolve; }),
    });

    await mgr.start();
    setPsResponse(runningPs);
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    // Two full windows of a legitimately slow build.
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

    // A long `agent.install` is not a wedged service.
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
    // stop() already walked everything to `stopped`; the watchdog must not
    // have resurrected it as an error afterwards.
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
    // Without the periodic poller, nothing would ever re-read Docker and the
    // stack would be frozen at whatever `start()` left behind.
    expect(psCalls()).toBeGreaterThan(before);

    await mgr.stop();
  });

  it("resolves status and address even when the network join never returns", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // The join reaches Docker over dockerode and can run a sidecar container —
    // both can hang. It is best-effort, so it must not hold up the poll behind it.
    const { mgr, setPsResponse } = makeManager(dir, {
      networkJoinFn: () => new Promise<void>(() => { /* never settles */ }),
    });

    // `start()` joins too — it has to time out before the stack is up at all.
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

/**
 * #2044 follow-ups from cross-backend review — the corners where publishing an
 * address for a `starting` service, or exempting one from the watchdog, could
 * be actively wrong.
 */
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

    // A restart lands on a different IP. Until the poll resolves it, the
    // service must advertise no address rather than the old one — Docker may
    // well have handed 172.16.0.9 to someone else by now.
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
    // A build that eats almost the whole window, then a slow network join and
    // poll behind it — the healthy-but-slow case that must not be errored.
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

    // The original deadline passes moments later; the exemption released just
    // before it, so without a re-arm the service would flip to `error` here.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mgr.getService("web")?.status).toBe("starting");

    // …but the fresh window still expires if it really is stuck.
    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS);
    expect(mgr.getService("web")?.status).toBe("error");
  });

  it("reconcile() drops a stale in-flight exemption", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // This `up` never returns — the old generation's call is wedged forever.
    const { mgr, setPsResponse } = makeManager(dir, {
      up: () => new Promise<void>(() => { /* never settles */ }),
    });

    await mgr.start();
    setPsResponse("");
    void mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("starting");

    await mgr.reconcile();

    // The same-named service in the rebuilt registry must not inherit the dead
    // call's exemption, or it is watchdog-proof for the rest of the session.
    // Reached here the way it is in production: a container looping in Docker's
    // `restarting` state is reported as `starting`.
    setPsResponse(JSON.stringify({ Service: "web", ID: "abc", State: "restarting", ExitCode: 0 }));
    await (mgr as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(STARTING_WATCHDOG_MS + 1_000);
    expect(mgr.getService("web")?.status).toBe("error");

    await mgr.stop();
  });
});

/**
 * Compose-up output reaches the service's log stream.
 *
 * `startService` writes `starting`, awaits `docker compose up -d --build`, and
 * only then spawns the log follower. With a cold layer cache that `up` is a full
 * image build — minutes during which the service sat at `starting` with an empty
 * log panel and no diagnostic anywhere, because the runner dropped its own
 * output and `withUpInFlight` (correctly) exempts an in-flight `up` from both
 * the missing-container reconciliation and the `starting` watchdog. The user
 * reads that as "Start does nothing".
 */
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

  /**
   * A manager whose `up` emits build-shaped progress, plus a log store spy. The
   * chunk boundaries deliberately split a line — compose writes in arbitrary
   * chunks and the sink has to buffer to whole lines before prefixing.
   */
  function makeBuildingManager(dir: string) {
    const logs: { name: string; text: string }[] = [];
    const stored: string[] = [];
    /** Ring-buffer contents sampled WHILE the `up` is still running. */
    let bufferDuringUp = "";
    /** What a panel opened mid-build would be served. */
    let snapshotDuringUp = "";

    const composeRunner: ComposeRunner = async (args, _cwd, onOutput) => {
      if (!args.includes("up")) return;
      onOutput?.("#4 [2/9] RUN apt-get update\n#4 sha256:abc 0.4s done\n");
      onOutput?.("#5 [3/9] RUN playwright ");
      onOutput?.("install-deps chromium\n");
      // Compose's last record often has no trailing newline. `ComposeCli.run`
      // flushes at the process boundary so it isn't dropped.
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
      // Flushed at the process boundary — the command never wrote its last "\n".
      "[compose] #5 DONE 92.1s\n",
    ]);
    expect(logs.every(l => l.name === "dev")).toBe(true);
    expect(getBufferDuringUp()).toContain("[compose] #5 [3/9] RUN playwright install-deps chromium");
    // A panel opened mid-build is served the same lines: with no persisted
    // history for this channel yet — the cold-build case — `snapshotLogs` falls
    // back to the ring buffer while `docker compose logs` has no container to
    // answer for.
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
        // No newline anywhere. The sink's buffer lives outside MAX_LOG_BUFFER's
        // cap, so without a bound this grows for the length of the build.
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

    // One emit when the buffer passed the cap mid-stream, one on the flush —
    // rather than 10 KB sitting in `pending` until the command ended.
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

    // Non-vacuous: output DID flow (otherwise "nothing was persisted" would be
    // true for the uninteresting reason).
    expect(logs.filter(l => l.text.includes("[compose]")).length).toBeGreaterThan(0);
    // docs/192: `streamLogs` picks `--tail 1000` vs `--tail 0` by asking whether
    // the store already holds this channel. Seeding it with build output would
    // flip that predicate before the container was ever followed, losing the
    // container's first lines for good.
    expect(stored.filter(t => t.includes("[compose]"))).toEqual([]);

    await mgr.stop();
  });
});

/**
 * docs/121 — the three remaining service-lifecycle gaps, all of them about a
 * service that ends up in a state the user cannot get out of by any means the
 * UI offers.
 *
 *   - requirement 2: a `docker compose up` that never returns pinned the
 *     service at `starting` forever, because the (correct) exemption an
 *     in-flight `up` gets from the watchdog had no outer bound.
 *   - requirement 4: the log follower dies with the container it follows, and
 *     nothing re-attached it on the AUTOMATIC recreate paths — so a service
 *     that recovered on its own showed an empty log panel until the user
 *     restarted it by hand.
 *   - requirement 5: `stopService` ran `docker compose stop` while an earlier
 *     `startService`'s `up` was still running, so the container came back after
 *     the user asked for it to be gone.
 */
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
    /**
     * Runs in place of `docker compose up`. Receives the output sink, so a test
     * can model a build that talks as well as one that has gone silent.
     */
    up?: (onOutput?: (chunk: string) => void) => Promise<void>;
    /** Runs in place of `docker compose stop`. */
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

  // -------------------------------------------------------------------------
  // Requirement 2 — an in-flight `up` is exempt only while it is talking
  // -------------------------------------------------------------------------

  it("reports a compose up that has gone silent and never returned", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // A wedged daemon: the `up` neither returns nor says anything.
    const { mgr } = makeManager(dir, { up: () => new Promise<void>(() => {}) });

    await mgr.start();
    const startPromise = mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);
    expect(mgr.getService("web")?.status).toBe("starting");

    await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS + STARTING_WATCHDOG_MS);

    const web = mgr.getService("web");
    expect(web?.status).toBe("error");
    expect(web?.error).toBe(UP_STALLED_MESSAGE);
    // No address may survive it — the container it described is unverifiable.
    expect(mgr.getServices().find(s => s.name === "web")?.url).toBeUndefined();
    void startPromise;
  });

  it("never bounds a build that is still producing output", async () => {
    vi.useFakeTimers();
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // A cold image build: minutes long, but talking the whole way through.
    // Requirement 2's non-requirements rule out putting a clock on this.
    let emit: ((chunk: string) => void) | undefined;
    const { mgr } = makeManager(dir, {
      up: (onOutput) => new Promise<void>(() => { emit = onOutput; }),
    });

    await mgr.start();
    void mgr.startService("web");
    await vi.advanceTimersByTimeAsync(0);

    // Four silence windows' worth of build, with progress arriving throughout.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(UP_SILENCE_TIMEOUT_MS / 2);
      emit?.(`#${i} [2/9] RUN npm ci\n`);
    }
    expect(mgr.getService("web")?.status).toBe("starting");
    expect(mgr.getService("web")?.error).toBeUndefined();

    // The moment it stops talking, the bound applies.
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

    // The `up` was never cancelled — the error is a report, not a verdict.
    finishUp?.();
    await startPromise;
    expect(mgr.getService("web")?.status).toBe("running");
    expect(mgr.getService("web")?.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Requirement 4 — the log follower survives an automatic recovery
  // -------------------------------------------------------------------------

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

    // The container is recreated by an automatic path (a retry, an OOM
    // recovery, the gated batch): the follower dies with its predecessor.
    first!.emit("close", 0);
    expect(logProcesses().has("web")).toBe(false);

    // The service leaves and re-enters `running` — the transition every
    // automatic recovery route ends at.
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

    // The replacement container is observed running BEFORE the old follower's
    // `close` arrives. A check gated on the non-running -> running transition
    // would no-op here and never get another chance.
    setPsResponse(exitedPs(1));
    await poll();
    setPsResponse(runningPs);
    await poll();
    first!.emit("close", 0);

    // The next ordinary poll of a still-running service re-attaches.
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

    // Replacing a live follower would clear the ring buffer `streamLogs` wipes
    // on every spawn — throwing away the very backlog requirement 4 is about.
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

  // -------------------------------------------------------------------------
  // Requirement 5 — the user's last instruction is the one that holds
  // -------------------------------------------------------------------------

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

    // Stop arrives while the `up` is still running — the exact moment a user
    // reaches for Stop, because the service looks wedged.
    const stopPromise = mgr.stopService("web");
    await Promise.resolve();
    // It does not wait for the build before acting.
    expect(stopCalls).toEqual(["web"]);

    // The stop reports its verdict without waiting for the build.
    await stopPromise;
    expect(mgr.getService("web")?.status).toBe("stopped");

    finishUp?.();
    await startPromise;

    // A second stop follows in the background, against whatever the `up`
    // created or restarted.
    await vi.waitFor(() => expect(stopCalls).toEqual(["web", "web"]));
    expect(mgr.getService("web")?.status).toBe("stopped");
  });

  it("does not hang the stop on an up that never returns", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = setup();
    writeCompose(dir, MANUAL_COMPOSE);
    // The wedged-daemon case requirement 2 is about. Awaiting this `up` before
    // reporting the stop would turn it into a requirement 5 failure too: Stop
    // would never return and the service would never be reported stopped.
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
    // A user-initiated start racing a retry attempt: two `up` calls in flight
    // for one service. The follow-up stop has to come after the LAST of them —
    // if the shorter call's completion retired the record, the stop would fire
    // early and the longer call would put the container back unopposed.
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

    // The second (shorter) call settles first.
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
    // `compose stop` can burn the full 10s SIGTERM grace, and a Stop arriving in
    // that window registers no in-flight `up` to chase — so the restart has to
    // check for itself before recreating the container.
    let releaseStop: (() => void) | undefined;
    let stopSeen = 0;
    const { mgr, upCalls, setPsResponse } = makeManager(dir, {
      stop: () => {
        stopSeen += 1;
        // Only the restart's own leading stop blocks.
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

    // The restart must not have brought the container back.
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

    // Stopped while the install gate held it.
    await mgr.stopService("web");
    const upsBefore = upCalls.length;

    // The gate opening is an automatic lifecycle event, not a newer instruction
    // from the user, so it must not undo the stop.
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

    // `docker compose stop` SIGTERMs and then SIGKILLs a service that doesn't
    // forward the signal, so the container exits 137/143. Read at face value
    // that walked the service the user just stopped straight to `error`.
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

    // A poll that landed before compose had finished killing the container
    // writes `running` back over the stop.
    await poll();
    expect(mgr.getService("web")?.status).toBe("running");

    // The exit is now the ONLY thing that can correct that claim, and it is the
    // exit our own stop produced — so ignoring it outright would leave a
    // stopped service reporting `running` forever (requirement 3).
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
    // Crash during the install window → a backoff retry is scheduled.
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

    // The suppression is gone with the stop that armed it: a genuine crash
    // after the restart is reported normally.
    setPsResponse(exitedPs(1));
    await poll();
    expect(mgr.getService("web")?.status).toBe("error");
    expect(mgr.getService("web")?.error).toContain("Exited with code 1");
  });
});
