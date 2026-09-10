import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseManager } from "../shared/database.js";
import { RepoStore } from "./repo-store.js";
import { applyShipitConfigChange, emitPluginReposUpdated, setupServiceManager } from "./service-manager-setup.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { installContentKeyDiagnostic } from "./install-content-key.js";
import { isOpsSafeLine } from "./services/host-session-logs.js";
import type { DepDirPublishOutcome } from "./overlay-publish.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionManager } from "./sessions.js";
import { expectInvalidShipitConfig } from "../shared/shipit-config-test-guard.js";

const REMOTE = "https://github.com/owner/repo.git";

let dbManager: DatabaseManager;
let repoStore: RepoStore;
let tmpDir: string;

beforeEach(() => {
  dbManager = new DatabaseManager(":memory:");
  repoStore = new RepoStore(dbManager);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-gate-test-"));
});

afterEach(() => {
  dbManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRunner(): SessionRunnerInterface & { emitMessage: ReturnType<typeof vi.fn> } {
  return {
    sessionId: "s1",
    sessionDir: tmpDir,
    emitMessage: vi.fn(),
    on: vi.fn(),
    setServiceManager: vi.fn(),
  } as unknown as SessionRunnerInterface & { emitMessage: ReturnType<typeof vi.fn> };
}

function makeDeps(remoteUrl: string | undefined) {
  const sessionManager = {
    get: () => ({ workspaceDir: tmpDir, remoteUrl }),
  } as unknown as SessionManager;
  return {
    sessionManager,
    repoStore,
    serviceManagers: new Map<string, ServiceManager>(),
    composeStopPromises: new Map<string, Promise<void>>(),
    composeWarnings: new Map<string, string>(),
    composeNotConfigured: new Set<string>(),
    containerManager: null,
    serviceEnvDir: path.join(tmpDir, "..", "service-env"),
  };
}

describe("setupServiceManager trust gate (docs/178)", () => {
  it("defers setup for an untrusted remote — nothing is emitted", () => {
    repoStore.add(REMOTE);
    const runner = makeRunner();
    const deps = makeDeps(REMOTE);

    setupServiceManager(runner, deps);

    expect(runner.emitMessage).not.toHaveBeenCalled();
    expect(deps.composeNotConfigured.has("s1")).toBe(false);
  });

  it("proceeds once the remote is trusted", () => {
    repoStore.add(REMOTE);
    repoStore.setTrusted(REMOTE, true);
    const runner = makeRunner();
    const deps = makeDeps(REMOTE);

    setupServiceManager(runner, deps);

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("treats a session with no remote as trusted (locally authored)", () => {
    const runner = makeRunner();
    const deps = makeDeps("");

    setupServiceManager(runner, deps);

    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
  });
});

describe("setupServiceManager — overlay publish gate", () => {
  function runnerWithInstall(): ContainerSessionRunner {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), "agent:\n  install:\n    - npm ci\n");
    return new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://127.0.0.1:1",
    });
  }

  async function publishCallsFor(outcome: {
    ok: boolean; unverified?: boolean;
  }): Promise<number> {
    repoStore.add(REMOTE);
    repoStore.setTrusted(REMOTE, true);
    const runner = runnerWithInstall();
    vi.spyOn(runner, "runInstall").mockResolvedValue(outcome);
    vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);
    const publishOverlayBases = vi.fn(async () => []);
    setupServiceManager(runner, { ...makeDeps(REMOTE), publishOverlayBases });
    await vi.waitFor(() => expect(runner.runInstall).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    return publishOverlayBases.mock.calls.length;
  }

  it("publishes when the install genuinely ran", async () => {
    expect(await publishCallsFor({ ok: true })).toBe(1);
  });

  it("does NOT publish an install that was never observed", async () => {
    expect(await publishCallsFor({ ok: true, unverified: true })).toBe(0);
  });

  async function logsForOutcomes(outcomes: DepDirPublishOutcome[]): Promise<
    { sessionId: string; source: string; text: string }[]
  > {
    repoStore.add(REMOTE);
    repoStore.setTrusted(REMOTE, true);
    const runner = runnerWithInstall();
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    vi.spyOn(runner, "emitMessage").mockImplementation(() => undefined);
    const broadcastLog = vi.fn();
    const publishOverlayBases = vi.fn(async () => outcomes);
    setupServiceManager(runner, { ...makeDeps(REMOTE), publishOverlayBases, broadcastLog });
    await vi.waitFor(() => expect(publishOverlayBases).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    return broadcastLog.mock.calls
      .map((c) => ({ sessionId: String(c[0]), source: String(c[1]), text: String(c[2]) }))
      .filter((e) => e.text.startsWith("Dependency cache:"));
  }

  it("reports a failed dep-dir publish on a line an ops session may read", async () => {
    const lines = await logsForOutcomes([
      { depDir: "node_modules", outcome: "error", error: "tar exited with code 1" },
      { depDir: "tools/debug/node_modules", outcome: "error", error: "tar exited with code 1" },
      { depDir: "game/node_modules", outcome: "advanced", depth: 2, generation: 5 },
    ]);
    expect(lines).toEqual([{
      sessionId: "s1",
      source: "server",
      text: "Dependency cache: 2 of 3 dependency directories could not be snapshotted as a shared base."
        + " Later sessions of this repository reinstall instead of reusing it.",
    }]);
    expect(isOpsSafeLine(lines[0]?.text ?? "")).toBe(true);
    expect(lines[0]?.text).not.toMatch(/node_modules/);
  });

  it("stays quiet when every dep dir published or skipped for an ordinary reason", async () => {
    expect(await logsForOutcomes([
      { depDir: "node_modules", outcome: "skipped-equal" },
      { depDir: "game/node_modules", outcome: "created", depth: 1, generation: 1 },
    ])).toEqual([]);
  });
});

describe("applyShipitConfigChange", () => {
  function makeFakeManager() {
    return {
      composeFile: "docker-compose.yml",
      dockerSocket: false,
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null as string | null,
      updateComposeConfig: vi.fn(function (this: { composeFile: string; dockerSocket: boolean }, next: { file: string; dockerSocket: boolean }) {
        const changed = next.file !== this.composeFile || next.dockerSocket !== this.dockerSocket;
        this.composeFile = next.file;
        this.dockerSocket = next.dockerSocket;
        return changed;
      }),
    };
  }

  function writeConfig(yaml: string): void {
    fs.writeFileSync(path.join(tmpDir, "shipit.yaml"), yaml);
  }

  function makeLiveDeps(mgr: unknown) {
    const deps = makeDeps("");
    deps.serviceManagers.set("s1", mgr as ServiceManager);
    return deps;
  }

  describe("plugin services on an activation round (docs/262)", () => {
    function makePluginManager(services: unknown[]) {
      return {
        ...makeFakeManager(),
        setPluginServices: vi.fn((next: unknown[]) =>
          JSON.stringify(next) !== JSON.stringify(services)),
        refreshSecretsStatus: vi.fn(async () => { /* no secrets store in tests */ }),
      };
    }

    it("reconciles once when the round changes the plugin services", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const mgr = makePluginManager([]);
      const deps = {
        ...makeLiveDeps(mgr),
        resolvePluginServices: vi.fn(async () => [{ name: "probe" }] as never),
      };

      emitPluginReposUpdated(runner, deps)("s1");
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalledTimes(1));
      expect(deps.resolvePluginServices).toHaveBeenCalledWith("s1", tmpDir);
    });

    it("does not reconcile when the round changes nothing", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const mgr = makePluginManager([]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      emitPluginReposUpdated(runner, deps)("s1");
      await vi.waitFor(() => expect(deps.resolvePluginServices).toHaveBeenCalled());
      expect(mgr.reconcile).not.toHaveBeenCalled();
    });

    it("still tells viewers the round settled when there is no manager", () => {
      const runner = makeRunner();
      const deps = { ...makeDeps(""), resolvePluginServices: vi.fn(async () => [] as never) };

      emitPluginReposUpdated(runner, deps)("s1");
      expect(runner.emitMessage).toHaveBeenCalledWith({ type: "plugin_repos_updated", sessionId: "s1" });
      expect(deps.resolvePluginServices).not.toHaveBeenCalled();
    });
  });

  describe("plugin services on a project config change (docs/262 req 20)", () => {
    function makeRecordingManager(surfacedLastRound: unknown[]) {
      const calls: string[] = [];
      const mgr = {
        ...makeFakeManager(),
        reconcile: vi.fn(async () => { calls.push("reconcile"); }),
        setPluginServices: vi.fn((next: unknown[]) => {
          calls.push("setPluginServices");
          return JSON.stringify(next) !== JSON.stringify(surfacedLastRound);
        }),
      };
      return { mgr, calls };
    }

    it("re-resolves the plugin services before the reconcile runs the new file", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr, calls } = makeRecordingManager([{ name: "probe" }]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      expect(deps.resolvePluginServices).toHaveBeenCalledWith("s1", tmpDir);
      expect(calls).toEqual(["setPluginServices", "reconcile"]);
    });

    it("tells viewers to refetch when the re-resolution changed the set", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([{ name: "probe" }]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      expect(runner.emitMessage).toHaveBeenCalledWith({
        type: "plugin_repos_updated",
        sessionId: "s1",
      });
    });

    it("says nothing extra when the set is unchanged, and still reconciles", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([]);
      const deps = { ...makeLiveDeps(mgr), resolvePluginServices: vi.fn(async () => [] as never) };

      applyShipitConfigChange(runner, deps);
      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

      expect(runner.emitMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "plugin_repos_updated" }),
      );
    });

    it("reconciles anyway when the resolution itself fails", async () => {
      writeConfig("compose: docker-compose.yml\n");
      const runner = makeRunner();
      const { mgr } = makeRecordingManager([]);
      const deps = {
        ...makeLiveDeps(mgr),
        resolvePluginServices: vi.fn(async () => { throw new Error("docker is away"); }),
      };

      applyShipitConfigChange(runner, deps);

      await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());
      expect(mgr.setPluginServices).not.toHaveBeenCalled();
    });
  });

  it("reconciles when only the compose file's contents changed", async () => {
    writeConfig("compose: docker-compose.yml\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));
    await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

    expect(mgr.updateComposeConfig).toHaveBeenCalledWith(
      { file: "docker-compose.yml", dockerSocket: false },
      { noProjectCompose: false },
    );
    expect(mgr.composeFile).toBe("docker-compose.yml");
  });

  it("adopts a new compose path from shipit.yaml before reconciling", async () => {
    writeConfig("compose:\n  file: deploy/compose.yml\n  docker-socket: true\n");
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));
    await vi.waitFor(() => expect(mgr.reconcile).toHaveBeenCalled());

    expect(mgr.composeFile).toBe("deploy/compose.yml");
    expect(mgr.dockerSocket).toBe(true);
  });

  it("tears the stack down when the compose block is removed", () => {
    writeConfig("agent:\n  install: npm ci\n");
    const runner = makeRunner();
    const deps = makeLiveDeps(makeFakeManager());

    applyShipitConfigChange(runner, deps);

    expect(deps.serviceManagers.has("s1")).toBe(false);
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "compose_not_configured", sessionId: "s1" }),
    );
  });

  it("keeps the running stack when the incoming shipit.yaml is invalid", () => {
    expectInvalidShipitConfig(() => {
      writeConfig("compose: [not, a, path]\n");
    });
    const runner = makeRunner();
    const mgr = makeFakeManager();

    applyShipitConfigChange(runner, makeLiveDeps(mgr));

    expect(mgr.reconcile).not.toHaveBeenCalled();
    expect(runner.emitMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compose_error",
        message: expect.stringContaining("keeping the previous configuration") as unknown as string,
      }),
    );
  });

  it("falls back to full setup when no ServiceManager exists yet", () => {
    writeConfig("agent:\n  install: npm ci\n");
    const runner = makeRunner();
    const deps = makeDeps("");

    applyShipitConfigChange(runner, deps);

    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("re-runs agent.install when the command list changes", () => {
    writeConfig("compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npx prisma generate\n");
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    runner.setDepReinstallInputs(["npm ci"], ["package-lock.json"]);
    const requestDepReinstall = vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });

    applyShipitConfigChange(runner, makeLiveDeps(makeFakeManager()));

    expect(runner.appliedInstallCommands).toEqual(["npm ci", "npx prisma generate"]);
    expect(requestDepReinstall).toHaveBeenCalled();
    runner.dispose({ force: true });
  });

  it("does not re-run agent.install when the command list is unchanged", () => {
    writeConfig("compose: docker-compose.yml\nagent:\n  install: npm ci\n");
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: tmpDir,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    runner.setDepReinstallInputs(["npm ci"], ["package-lock.json"]);
    const requestDepReinstall = vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });

    applyShipitConfigChange(runner, makeLiveDeps(makeFakeManager()));

    expect(requestDepReinstall).not.toHaveBeenCalled();
    runner.dispose({ force: true });
  });
});

describe("applyShipitConfigChange — compose-removal is gated on a trustworthy read", () => {
  function makeFakeManager() {
    return {
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null as string | null,
      updateComposeConfig: vi.fn(() => false),
    };
  }

  it("tears down when shipit.yaml is genuinely absent", () => {
    const runner = makeRunner();
    const deps = makeDeps("");
    deps.serviceManagers.set("s1", makeFakeManager() as unknown as ServiceManager);

    applyShipitConfigChange(runner, deps);

    expect(deps.serviceManagers.has("s1")).toBe(false);
    expect(deps.composeNotConfigured.has("s1")).toBe(true);
  });

  it("keeps the stack when shipit.yaml exists but cannot be read", () => {
    const runner = makeRunner();
    const deps = makeDeps("");
    const mgr = makeFakeManager();
    deps.serviceManagers.set("s1", mgr as unknown as ServiceManager);

    const yamlPath = path.join(tmpDir, "shipit.yaml");
    fs.writeFileSync(yamlPath, "compose: docker-compose.yml\n");
    const realReadFileSync = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === "string" && p === yamlPath) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realReadFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as unknown as typeof fs.readFileSync);

    try {
      applyShipitConfigChange(runner, deps);
    } finally {
      spy.mockRestore();
    }

    expect(deps.serviceManagers.has("s1")).toBe(true);
    expect(deps.composeNotConfigured.has("s1")).toBe(false);
    expect(mgr.stop).not.toHaveBeenCalled();
    expect(mgr.reconcile).not.toHaveBeenCalled();
  });
});

describe("setupServiceManager threads serviceEnvDir to the secrets resolver (planning#292)", () => {
  it("writes service env files under the deps' root, never into the clone", async () => {
    const sessionDir = path.join(tmpDir, "session");
    const clone = path.join(sessionDir, "workspace");
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(
      path.join(clone, "docker-compose.yml"),
      "services:\n  api:\n    image: node:20\n    x-shipit-secrets:\n      - DATABASE_URL\n",
    );
    fs.writeFileSync(path.join(clone, "shipit.yaml"), "compose: docker-compose.yml\n");
    const serviceEnvDir = path.join(tmpDir, "service-env");

    const runner = makeRunner();
    const deps = {
      ...makeDeps(""),
      sessionManager: {
        get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
      } as unknown as SessionManager,
      serviceEnvDir,
    };

    setupServiceManager(runner, deps);

    const mgr = deps.serviceManagers.get("s1");
    expect(mgr).toBeDefined();
    await mgr!.refreshSecrets();

    expect(fs.existsSync(path.join(serviceEnvDir, "s1", ".env.api"))).toBe(true);
    expect(fs.existsSync(path.join(clone, ".shipit"))).toBe(false);
  });
});

describe("content-key reporting (install-content-key.ts)", () => {
  function makeClone(): string {
    const clone = path.join(tmpDir, "session", "workspace");
    fs.mkdirSync(clone, { recursive: true });
    return clone;
  }

  function makeContainerRunner(clone: string): ContainerSessionRunner {
    const runner = new ContainerSessionRunner({
      sessionId: "s1",
      sessionDir: clone,
      defaultAgentId: "claude",
      workerUrl: "http://0.0.0.0:0",
    });
    vi.spyOn(runner, "requestDepReinstall").mockImplementation(() => { /* no worker */ });
    return runner;
  }

  function makeCloneDeps(clone: string) {
    const deps = makeDeps("");
    deps.sessionManager = {
      get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
    } as unknown as SessionManager;
    deps.serviceManagers.set("s1", {
      reconcile: vi.fn(async () => { /* no compose stack in tests */ }),
      stop: vi.fn(async () => { /* no compose stack in tests */ }),
      startError: null,
      updateComposeConfig: vi.fn(() => false),
    } as unknown as ServiceManager);
    return deps;
  }

  it("records a non-content-keyable install so diagnostics can report it", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npm run build\n",
    );
    const runner = makeContainerRunner(clone);

    applyShipitConfigChange(runner, makeCloneDeps(clone));

    expect(installContentKeyDiagnostic(clone)?.commands).toEqual(["npm ci", "npm run build"]);
    runner.dispose({ force: true });
  });

  it("stops reporting when install-inputs is added, though agent.install is unchanged", () => {
    const clone = makeClone();
    const install = "compose: docker-compose.yml\nagent:\n  install:\n    - npm ci\n    - npx prisma generate\n";
    fs.writeFileSync(path.join(clone, "shipit.yaml"), install);
    const runner = makeContainerRunner(clone);
    const deps = makeCloneDeps(clone);

    applyShipitConfigChange(runner, deps);
    expect(installContentKeyDiagnostic(clone)).not.toBeNull();

    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      `${install}  install-inputs: [package.json, package-lock.json, prisma/schema.prisma]\n`,
    );
    applyShipitConfigChange(runner, deps);

    expect(installContentKeyDiagnostic(clone)).toBeNull();
    runner.dispose({ force: true });
  });

  it("detects at first setup, not only on a later config change", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "agent:\n  install:\n    - npm ci\n    - npm run build\n",
    );
    const runner = makeContainerRunner(clone);
    vi.spyOn(runner, "runInstall").mockResolvedValue({ ok: true });
    const deps = makeDeps("");
    deps.sessionManager = {
      get: () => ({ workspaceDir: clone, remoteUrl: undefined }),
    } as unknown as SessionManager;

    setupServiceManager(runner, deps);

    expect(installContentKeyDiagnostic(clone)?.commands).toEqual(["npm ci", "npm run build"]);
    runner.dispose({ force: true });
  });

  it("says nothing for a pure dependency install", () => {
    const clone = makeClone();
    fs.writeFileSync(
      path.join(clone, "shipit.yaml"),
      "compose: docker-compose.yml\nagent:\n  install: npm ci\n",
    );
    const runner = makeContainerRunner(clone);

    applyShipitConfigChange(runner, makeCloneDeps(clone));

    expect(installContentKeyDiagnostic(clone)).toBeNull();
    runner.dispose({ force: true });
  });
});

describe("trackComposeStop — onStopped", () => {
  it("does not fire while the stop is still in flight", async () => {
    const { trackComposeStop } = await import("./service-manager-setup.js");
    let release!: () => void;
    const mgr = { stop: () => new Promise<void>((resolve) => { release = resolve; }) };
    const onStopped = vi.fn();

    trackComposeStop(new Map(), "sess-x", mgr, { onStopped });
    await Promise.resolve();
    expect(onStopped).not.toHaveBeenCalled();

    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the stop fails, because the previews are still up", async () => {
    const { trackComposeStop } = await import("./service-manager-setup.js");
    const mgr = { stop: () => Promise.reject(new Error("compose down failed")) };
    const onStopped = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    trackComposeStop(new Map(), "sess-x", mgr, { onStopped });
    await new Promise((r) => setTimeout(r, 0));

    expect(onStopped).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not report a throwing callback as a failed stop", async () => {
    const { trackComposeStop } = await import("./service-manager-setup.js");
    const mgr = { stop: () => Promise.resolve() };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    trackComposeStop(new Map(), "sess-x", mgr, {
      onStopped: () => { throw new Error("broadcast blew up"); },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      "[compose:sess-x] onStopped callback threw:",
    ]);
    errors.mockRestore();
  });

  it("clears its entry from the in-flight map once settled", async () => {
    const { trackComposeStop } = await import("./service-manager-setup.js");
    const promises = new Map<string, Promise<void>>();
    trackComposeStop(promises, "sess-x", { stop: () => Promise.resolve() });

    expect(promises.has("sess-x")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(promises.has("sess-x")).toBe(false);
  });
});
