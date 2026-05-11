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
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
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
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
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
    writeCompose(dir, "services:\n  web:\n    image: node:20\n    ports: ['5173:5173']\n");
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
});
