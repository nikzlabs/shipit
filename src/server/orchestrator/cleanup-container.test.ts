import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CleanupContainerManager,
  CLEANUP_CONTAINER_SESSION_ID,
  MAX_REVIVE_ATTEMPTS,
  CREATE_INTERVAL_MS,
} from "./cleanup-container.js";
import { SUB_AGENT_HOME_SUBDIR } from "./session-credentials-scaffold.js";
import { ANTIGRAVITY_TOOLS_OFF_REFUSAL } from "../shared/agent-tools-off.js";
import type { SessionContainer, SessionContainerManager } from "./session-container.js";

const posts: {
  url: string; path: string; body: Record<string, unknown>; timeoutMs?: number | undefined;
}[] = [];
let spawnReply: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Spawns still awaiting a worker, so the fixture can take their container away. */
const inFlight: { url: string; reject: (err: Error) => void }[] = [];
/** Workers whose container is gone: a later request must not reach them either. */
const deadWorkers = new Set<string>();

/** What a request sees when the container it is running in is destroyed. */
function killWorker(url: string): void {
  deadWorkers.add(url);
  for (const entry of inFlight.splice(0)) {
    if (entry.url === url) entry.reject(new Error("socket hang up"));
    else inFlight.push(entry);
  }
}

// Reproduces the real workerPost's abort behaviour: an aborted signal rejects
// the request at once. Without that, a fixture cannot see a caller that gives up
// on the transport and unwinds while the worker is still running the spawn.
vi.mock("./worker-http.js", () => ({
  workerPost: async (
    url: string,
    p: string,
    body: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ) => {
    posts.push({ url, path: p, body, timeoutMs: opts?.timeoutMs });
    if (deadWorkers.has(url)) throw new Error("connect ECONNREFUSED");
    if (p !== "/agent/spawn") return { cancelled: true };
    const racers: Promise<unknown>[] = [
      spawnReply(body, opts?.signal),
      new Promise((_r, reject) => { inFlight.push({ url, reject }); }),
    ];
    if (opts?.signal) {
      racers.push(new Promise((_r, reject) => {
        opts.signal!.addEventListener(
          "abort", () => reject(new Error("Worker request aborted")), { once: true },
        );
      }));
    }
    return Promise.race(racers);
  },
}));

class FakeContainerManager extends EventEmitter {
  containers = new Map<string, SessionContainer>();
  createCalls: { sessionId: string; workspaceDir: string }[] = [];
  createError: Error | null = null;
  destroyed: string[] = [];
  /** Undefined means Docker could not answer, which is not proof of death. */
  trackedRunning: boolean | undefined = true;
  gone: string[] = [];
  /** A running container that outlived the orchestrator process, if Docker has one. */
  survivor: { id: string; workerBuildId?: string } | null = null;
  /** Holds an adoption open after it has published its entry, as the real one does. */
  adoptGate: Promise<void> | null = null;
  /** Holds a teardown open after it has marked the entry stopping, as the real one does. */
  destroyGate: Promise<void> | null = null;

  async isTrackedContainerRunning(): Promise<boolean | undefined> { return this.trackedRunning; }

  async adoptRunningContainer(sessionId: string): Promise<boolean> {
    if (!this.survivor || this.containers.has(sessionId)) return false;
    this.containers.set(sessionId, {
      id: this.survivor.id,
      sessionId,
      workerUrl: "http://survivor:9100",
      status: "running",
      workerBuildId: this.survivor.workerBuildId,
    } as unknown as SessionContainer);
    this.survivor = null;
    if (this.adoptGate) await this.adoptGate;
    return true;
  }

  async markContainerGone(sessionId: string, expectedId: string): Promise<boolean> {
    if (this.containers.get(sessionId)?.id !== expectedId) return false;
    this.containers.delete(sessionId);
    this.gone.push(expectedId);
    return true;
  }

  buildConfig(opts: { sessionId: string; sessionDir: string; workspaceDir: string; credentialsDir: string }) {
    return opts;
  }

  get(sessionId: string): SessionContainer | undefined { return this.containers.get(sessionId); }

  async create(config: { sessionId: string; workspaceDir: string }): Promise<SessionContainer> {
    this.createCalls.push({ sessionId: config.sessionId, workspaceDir: config.workspaceDir });
    if (this.createError) throw this.createError;
    const sc = {
      id: `c${this.createCalls.length}`,
      sessionId: config.sessionId,
      workerUrl: `http://worker-${this.createCalls.length}:9100`,
      status: "running",
    } as unknown as SessionContainer;
    this.containers.set(config.sessionId, sc);
    return sc;
  }

  async destroy(sessionId: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    this.destroyed.push(sessionId);
    // The real teardown marks the entry stopping and then awaits Docker
    // (container-lifecycle.ts:966); deleting it at once hides everything that
    // can arrive in between, including a second teardown.
    if (sc) (sc as { status: string }).status = "stopping";
    if (this.destroyGate) await this.destroyGate;
    this.containers.delete(sessionId);
    // Destroying the container takes every request running inside it; a fixture
    // that skipped this could not fail on a replacement made mid-flight.
    if (sc) killWorker(sc.workerUrl);
  }
}

function makeManager(root: string): {
  mgr: CleanupContainerManager;
  cm: FakeContainerManager;
  clock: { now: number };
} {
  const cm = new FakeContainerManager();
  const clock = { now: 1_000_000 };
  const mgr = new CleanupContainerManager({
    containerManager: cm as unknown as SessionContainerManager,
    sessionsRoot: path.join(root, "sessions"),
    credentialsDir: path.join(root, "credentials"),
    now: () => clock.now,
    retryDelayMs: 2,
  });
  return { mgr, cm, clock };
}

function spawnHomesRoot(root: string): string {
  return path.join(root, "credentials", "sessions", CLEANUP_CONTAINER_SESSION_ID, SUB_AGENT_HOME_SUBDIR);
}

describe("CleanupContainerManager", () => {
  let root: string;

  beforeEach(() => {
    posts.length = 0;
    inFlight.length = 0;
    deadWorkers.clear();
    spawnReply = async () => ({ status: "success", text: "cleaned", truncated: false, durationMs: 5, costUsd: 0 });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-container-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * A container that outlived the orchestrator process is the container req 8
   * wants. `create()` would rebuild it — it force-removes whatever holds the
   * container name — so the first dictation after a restart would pay the start
   * the requirement forbids.
   */
  it("adopts a container this orchestrator built that outlived the process", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();

    const result = await mgr.run({ harnessId: "claude", prompt: "clean this up", model: "haiku" });
    mgr.stop();

    expect(cm.createCalls).toHaveLength(0);
    expect(result.text).toBe("cleaned");
    expect(posts.find((p) => p.path === "/agent/spawn")!.url).toBe("http://survivor:9100");
  });

  // Never stopped, so anything but an exact match would carry another
  // orchestrator's worker, and the configuration it was created with, for the
  // life of the install.
  it.each([
    ["a previous deploy built it", "build-1"],
    ["its build cannot be established", undefined],
  ])("replaces a survivor when %s", async (_case, workerBuildId) => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-2");
    const { mgr, cm } = makeManager(root);
    cm.survivor = { id: "survivor-1", ...(workerBuildId ? { workerBuildId } : {}) };
    await mgr.start();
    mgr.stop();

    expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]);
    expect(cm.createCalls).toHaveLength(1);
  });

  /**
   * Adoption publishes the survivor's entry before its build is checked, so a
   * dictation reading that entry could be dispatched to a worker this manager is
   * about to destroy.
   */
  it("holds a dictation arriving mid-adoption until the container is settled", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-2");
    const { mgr, cm } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    let release: (() => void) | null = null;
    cm.adoptGate = new Promise<void>((r) => { release = r; });

    const started = mgr.start();
    await vi.waitFor(() => {
      expect(cm.get(CLEANUP_CONTAINER_SESSION_ID)?.id).toBe("survivor-1");
    });
    const run = mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    release!();
    await started;
    const result = await run;
    mgr.stop();

    expect(result.text).toBe("cleaned");
    expect(posts.find((p) => p.path === "/agent/spawn")!.url).toBe("http://worker-1:9100");
  });

  it("creates the container at start under the reserved session id", async () => {
    const { mgr, cm } = makeManager(root);
    await mgr.start();
    mgr.stop();

    expect(cm.createCalls).toHaveLength(1);
    expect(cm.createCalls[0]!.sessionId).toBe(CLEANUP_CONTAINER_SESSION_ID);
    // The clone-shaped layout is required: sessionStateDirForWorkspace rejects anything else.
    expect(path.basename(cm.createCalls[0]!.workspaceDir)).toBe("workspace");
    expect(fs.existsSync(cm.createCalls[0]!.workspaceDir)).toBe(true);
  });

  it("recreates it when the health monitor reports its container exited", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();
    cm.containers.delete(CLEANUP_CONTAINER_SESSION_ID);
    clock.now += 60_000;

    cm.emit("container_exited", CLEANUP_CONTAINER_SESSION_ID, 137, "Out of memory");
    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(2); });
    mgr.stop();
  });

  // The loop detector deliberately ignores this container, so nothing else caps it.
  it("does not recreate faster than the create interval when it dies at once", async () => {
    const { mgr, cm } = makeManager(root);
    await mgr.start();

    for (let i = 0; i < 3; i++) {
      cm.containers.delete(CLEANUP_CONTAINER_SESSION_ID);
      cm.emit("container_exited", CLEANUP_CONTAINER_SESSION_ID, 1, undefined);
      await new Promise((r) => setTimeout(r, 5));
    }
    mgr.stop();

    expect(cm.createCalls).toHaveLength(1);
  });

  it("ignores another session's container exit", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();
    // Nothing but the session-id filter stops this exit recreating the
    // container: its entry is gone and the create interval has passed.
    cm.containers.delete(CLEANUP_CONTAINER_SESSION_ID);
    clock.now += CREATE_INTERVAL_MS + 1_000;

    cm.emit("container_exited", "11111111-1111-4111-8111-111111111111", 1, undefined);
    await new Promise((r) => setTimeout(r, 10));
    mgr.stop();

    expect(cm.createCalls).toHaveLength(1);
  });

  /**
   * "Running", under this orchestrator's build, does not establish that the
   * worker still answers or that its egress sidecars outlived the gap — and a
   * wedged container stays running for ever, so nothing else repairs it.
   */
  it("replaces an adopted container that does not answer", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;
    expect(cm.createCalls).toHaveLength(0);

    // Docker still reports it running, so the liveness check finds nothing.
    spawnReply = async () => { throw new Error("connect ECONNREFUSED"); };
    const failed = await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    expect(failed.status).toBe("error");

    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(1); });
    mgr.stop();

    expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]);
    expect(cm.gone).toEqual([]);
  });

  /**
   * The wedge this exists for: a worker whose harness cannot reach the provider
   * answers the spawn perfectly well, with HTTP 200 carrying a failed run
   * (`session/agent-controller.ts`). Taking that reply as proof of health let
   * the container mark itself verified on its first failure and stay wedged for
   * the life of the install, with Docker reporting it running throughout.
   * `cancelled` is the same wedge seen from the other side: egress that
   * blackholes answers nothing, so the orchestrator's deadline ends the run.
   */
  it.each(["timeout", "error", "cancelled"])(
    "replaces an adopted container whose worker answers with status %s",
    async (status) => {
      vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
      const { mgr, cm, clock } = makeManager(root);
      cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
      await mgr.start();
      clock.now += CREATE_INTERVAL_MS + 1_000;

      spawnReply = async () => ({ status, text: "", truncated: false, durationMs: 1, costUsd: 0 });
      const failed = await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
      expect(failed.status).toBe(status);

      await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(1); });
      mgr.stop();

      expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]);
    },
  );

  /**
   * Replacing an adopted container mid-flight destroys the harness another
   * dictation is running in, so that dictation gets a raw transcript and a
   * warning for work that was going fine. Enforcing one dictation's deadline
   * must disturb no other work in flight (req 9).
   */
  it("waits for the container to be idle before replacing it", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((r) => { releaseSlow = r; });
    spawnReply = async (body) => {
      if (body.prompt === "fast") throw new Error("connect ECONNREFUSED");
      await slow;
      return { status: "success", text: "cleaned", truncated: false, durationMs: 1, costUsd: 0 };
    };

    const slowRun = mgr.run({ harnessId: "claude", prompt: "slow", model: "haiku" });
    await vi.waitFor(() => { expect(posts.filter((p) => p.path === "/agent/spawn")).toHaveLength(1); });
    const fast = await mgr.run({ harnessId: "claude", prompt: "fast", model: "haiku" });
    expect(fast.status).toBe("error");

    // The failure must not have taken the slow dictation's harness with it.
    await new Promise((r) => setTimeout(r, 20));
    expect(cm.destroyed).toEqual([]);
    releaseSlow!();

    expect((await slowRun).text).toBe("cleaned");
    mgr.stop();
  });

  /**
   * Deferring the replacement must not discard it: when every dictation in the
   * container has failed, the container is still unproven and still has to go,
   * or waiting for idle would be a way of never replacing a busy wedge.
   */
  it("replaces the container once the dictations that deferred it have drained", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    let releaseSecond: (() => void) | null = null;
    const second = new Promise<void>((r) => { releaseSecond = r; });
    spawnReply = async (body) => {
      if (body.prompt === "second") await second;
      throw new Error("connect ECONNREFUSED");
    };

    const secondRun = mgr.run({ harnessId: "claude", prompt: "second", model: "haiku" });
    await vi.waitFor(() => { expect(posts.filter((p) => p.path === "/agent/spawn")).toHaveLength(1); });
    await mgr.run({ harnessId: "claude", prompt: "first", model: "haiku" });

    await new Promise((r) => setTimeout(r, 20));
    expect(cm.destroyed).toEqual([]);

    releaseSecond!();
    await secondRun;
    await vi.waitFor(() => { expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]); });
    await new Promise((r) => setTimeout(r, 20));
    mgr.stop();

    // Exactly one replacement, not one per failed dictation.
    expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]);
    expect(cm.createCalls).toHaveLength(1);
  });

  /**
   * `destroyContainer` marks the entry stopping and then awaits Docker
   * (`container-lifecycle.ts:966`). A dictation arriving inside that window used
   * to start a second teardown, and the first one then reaped the second's
   * replacement — its resource cleanup and its `containers.delete` are both
   * unconditional (`:993`, `:1016`).
   */
  it("holds a dictation arriving mid-replacement until the replacement is ready", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    let releaseDestroy: (() => void) | null = null;
    cm.destroyGate = new Promise<void>((r) => { releaseDestroy = r; });
    spawnReply = async (body) => {
      if (body.prompt === "doomed") throw new Error("connect ECONNREFUSED");
      return { status: "success", text: "cleaned", truncated: false, durationMs: 1, costUsd: 0 };
    };

    await mgr.run({ harnessId: "claude", prompt: "doomed", model: "haiku" });
    await vi.waitFor(() => { expect(cm.destroyed).toHaveLength(1); });

    const during = mgr.run({ harnessId: "claude", prompt: "during", model: "haiku" });
    await new Promise((r) => setTimeout(r, 20));
    releaseDestroy!();
    const result = await during;
    mgr.stop();

    expect(result.text).toBe("cleaned");
    expect(cm.destroyed).toEqual([CLEANUP_CONTAINER_SESSION_ID]);
    expect(cm.createCalls).toHaveLength(1);
    expect(posts.find((p) => p.path === "/agent/spawn" && p.body.prompt === "during")!.url)
      .toBe("http://worker-1:9100");
  });

  // The teardown awaits Docker, so shutdown lands inside a replacement the same
  // way it lands inside an acquisition — and a container built then has nothing
  // left to manage it.
  it("does not rebuild when shutdown lands inside a replacement", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    let releaseDestroy: (() => void) | null = null;
    cm.destroyGate = new Promise<void>((r) => { releaseDestroy = r; });
    spawnReply = async () => { throw new Error("connect ECONNREFUSED"); };

    await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    await vi.waitFor(() => { expect(cm.destroyed).toHaveLength(1); });

    mgr.stop();
    releaseDestroy!();
    await new Promise((r) => setTimeout(r, 20));

    expect(cm.createCalls).toHaveLength(0);
  });

  /**
   * An adopted container that dies before any run succeeds is recreated by this
   * process, and what this process built needs no proving. A flag rather than
   * the adopted container's id would condemn that replacement on its first
   * ordinary provider error.
   */
  it("does not treat the container it built after an adoption as unproven", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    // The adopted container dies with nothing having run in it yet.
    cm.containers.delete(CLEANUP_CONTAINER_SESSION_ID);
    cm.emit("container_exited", CLEANUP_CONTAINER_SESSION_ID, 1, undefined);
    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(1); });

    spawnReply = async () => ({ status: "error", text: "", truncated: false, durationMs: 1, costUsd: 0 });
    await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    await new Promise((r) => setTimeout(r, 20));
    mgr.stop();

    expect(cm.destroyed).toEqual([]);
    expect(cm.createCalls).toHaveLength(1);
  });

  it("keeps an adopted container that has answered once", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-1");
    const { mgr, cm, clock } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;
    await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });

    spawnReply = async () => { throw new Error("socket hang up"); };
    await mgr.run({ harnessId: "claude", prompt: "b", model: "haiku" });
    await new Promise((r) => setTimeout(r, 20));
    mgr.stop();

    expect(cm.destroyed).toEqual([]);
    expect(cm.createCalls).toHaveLength(0);
  });

  // stop() drops the listeners and clears the timer, but an acquisition already
  // awaiting Docker runs on, and would leave a container nothing manages.
  it("does not create or destroy when shutdown lands mid-acquisition", async () => {
    vi.stubEnv("SHIPIT_BUILD_ID", "build-2");
    const { mgr, cm } = makeManager(root);
    cm.survivor = { id: "survivor-1", workerBuildId: "build-1" };
    let release: (() => void) | null = null;
    cm.adoptGate = new Promise<void>((r) => { release = r; });

    const started = mgr.start();
    await vi.waitFor(() => { expect(cm.get(CLEANUP_CONTAINER_SESSION_ID)).toBeDefined(); });
    mgr.stop();
    release!();
    await started;

    expect(cm.createCalls).toHaveLength(0);
    expect(cm.destroyed).toEqual([]);
  });

  it("refuses a harness whose tools cannot be turned off, without starting a container", async () => {
    // Antigravity's adapter reads no toolsOff flag, so spawning it would run the
    // full tool set. Refusing before ensure() also keeps an unusable run from
    // creating the container.
    const { mgr, cm } = makeManager(root);

    const result = await mgr.run({ harnessId: "antigravity", prompt: "clean this up", model: "gemini-3-pro" });

    expect(result.status).toBe("error");
    expect(result.error).toBe(ANTIGRAVITY_TOOLS_OFF_REFUSAL);
    expect(posts.find((p) => p.path === "/agent/spawn")).toBeUndefined();
    expect(cm.createCalls).toHaveLength(0);
  });

  it("spawns one-shot with tools off into a private home, and releases it", async () => {
    const { mgr } = makeManager(root);
    await mgr.start();

    const result = await mgr.run({ harnessId: "claude", prompt: "clean this up", model: "haiku" });
    mgr.stop();

    expect(result.text).toBe("cleaned");
    const spawn = posts.find((p) => p.path === "/agent/spawn")!;
    expect(spawn.body.toolsOff).toBe(true);
    // The worker's own timer has to settle the run first, or a timed-out run
    // comes back as a socket error instead of the partial text it produced.
    expect(spawn.timeoutMs!).toBeGreaterThan(Number(spawn.body.timeoutMs));
    expect(spawn.body.agentId).toBe("claude");
    expect(spawn.body.model).toBe("haiku");
    // Concurrent requests share this container, so each needs its own home.
    expect(String(spawn.body.homeDir)).toContain(`/${SUB_AGENT_HOME_SUBDIR}/`);
    expect(String(spawn.body.homeDir)).toContain(String(spawn.body.spawnId));
    expect(fs.readdirSync(spawnHomesRoot(root))).toEqual([]);
  });

  it("gives concurrent runs separate homes", async () => {
    const { mgr } = makeManager(root);
    await mgr.start();

    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    spawnReply = async () => {
      await gate;
      return { status: "success", text: "ok", truncated: false, durationMs: 1, costUsd: 0 };
    };
    const both = Promise.all([
      mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" }),
      mgr.run({ harnessId: "claude", prompt: "b", model: "haiku" }),
    ]);
    await vi.waitFor(() => { expect(posts.filter((p) => p.path === "/agent/spawn")).toHaveLength(2); });
    const homes = posts.filter((p) => p.path === "/agent/spawn").map((p) => p.body.homeDir);
    expect(new Set(homes).size).toBe(2);

    release!();
    await both;
    mgr.stop();
  });

  it("cancels the run by spawn id, and keeps the home until the worker answers", async () => {
    const { mgr } = makeManager(root);
    await mgr.start();

    const controller = new AbortController();
    let finishSpawn: ((v: unknown) => void) | null = null;
    spawnReply = async () => new Promise((resolve) => { finishSpawn = resolve; });

    const run = mgr.run({ harnessId: "claude", prompt: "clean this up", model: "haiku", signal: controller.signal });
    await vi.waitFor(() => { expect(posts.some((p) => p.path === "/agent/spawn")).toBe(true); });
    const spawnId = posts.find((p) => p.path === "/agent/spawn")!.body.spawnId;
    controller.abort();

    let settled = false;
    void (async () => { try { await run; } catch { /* ignore */ } settled = true; })();

    await vi.waitFor(() => { expect(posts.some((p) => p.path === "/agent/spawn/cancel")).toBe(true); });
    const cancel = posts.find((p) => p.path === "/agent/spawn/cancel")!;
    expect(cancel.body.spawnId).toBe(spawnId);
    // Never the whole container: that would interrupt every other request in flight.
    expect(posts.some((p) => p.path === "/agent/kill")).toBe(false);

    // The CLI may still be shutting down and may still rotate a token, so this
    // request must keep waiting: giving up on the transport here would release
    // the spawn home while the worker is still using it.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(fs.readdirSync(spawnHomesRoot(root))).toHaveLength(1);

    finishSpawn!({ status: "cancelled", text: "", truncated: false, durationMs: 1, costUsd: 0 });
    await run;
    mgr.stop();
    expect(fs.readdirSync(spawnHomesRoot(root))).toEqual([]);
  });

  it("does not spawn at all when the abort lands while the container is starting", async () => {
    const { mgr, cm } = makeManager(root);
    const controller = new AbortController();
    // Abort exactly during ensure(): the listener installed afterwards would
    // never fire, since an abort event is not replayed.
    const originalCreate = cm.create.bind(cm);
    cm.create = async (config) => { controller.abort(); return originalCreate(config); };

    const result = await mgr.run({
      harnessId: "claude", prompt: "clean this up", model: "haiku", signal: controller.signal,
    });
    mgr.stop();

    expect(result.status).toBe("error");
    expect(posts).toHaveLength(0);
  });

  it("forwards the routed credential, which this container has no environment for", async () => {
    const { mgr } = makeManager(root);
    await mgr.start();

    await mgr.run({
      harnessId: "claude",
      prompt: "clean this up",
      model: "haiku",
      serviceRouting: { credentialSourceEnv: "SHIPIT_CRED_ANTHROPIC" } as never,
      credentialSecret: "sk-secret",
    });
    mgr.stop();

    expect(posts.find((p) => p.path === "/agent/spawn")!.body.credentialSecret).toBe("sk-secret");
  });

  // Req 8 is about the container being up before the NEXT dictation, so leaving
  // recreation to the next request is the container start the requirement forbids.
  it("keeps retrying after a failed start until one succeeds", async () => {
    const { mgr, cm, clock } = makeManager(root);
    cm.createError = new Error("docker busy");
    await mgr.start();
    expect(cm.createCalls).toHaveLength(1);

    cm.createError = null;
    clock.now += 60_000;
    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(2); });
    mgr.stop();

    expect(cm.get(CLEANUP_CONTAINER_SESSION_ID)).toBeDefined();
  });

  // A container that starts and then dies at once creates successfully every
  // time, so a cap that resets on a successful create would never engage.
  it("stops recreating a container that keeps dying the moment it starts", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();

    for (let i = 0; i < 12; i++) {
      // Die inside the create interval, then let the retry become due.
      cm.containers.delete(CLEANUP_CONTAINER_SESSION_ID);
      cm.emit("container_exited", CLEANUP_CONTAINER_SESSION_ID, 1, undefined);
      clock.now += CREATE_INTERVAL_MS + 1_000;
      await new Promise((r) => setTimeout(r, 10));
    }
    mgr.stop();

    // Both bounds: an upper one alone is satisfied by never retrying at all.
    expect(cm.createCalls.length).toBeGreaterThan(1);
    expect(cm.createCalls.length).toBeLessThanOrEqual(MAX_REVIVE_ATTEMPTS + 1);
  });

  it("gives up retrying once a host plainly cannot start it", async () => {
    const { mgr, cm, clock } = makeManager(root);
    cm.createError = new Error("no docker here");
    await mgr.start();

    for (let i = 0; i < 12; i++) {
      clock.now += 60_000;
      await new Promise((r) => setTimeout(r, 5));
    }
    mgr.stop();

    expect(cm.createCalls.length).toBeGreaterThan(1);
    expect(cm.createCalls.length).toBeLessThanOrEqual(MAX_REVIVE_ATTEMPTS);
  });

  /**
   * A `die` missed during a Docker event-stream gap leaves the cached entry
   * reading "running" forever, and the missing-container reconciler cannot help:
   * it walks session runners and this container has none.
   */
  it("recreates after a missed exit event rather than failing every request", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();
    // The container has been up longer than the create interval, so pacing a
    // crash loop is not what is being measured here.
    clock.now += CREATE_INTERVAL_MS + 1_000;

    cm.trackedRunning = false;
    spawnReply = async () => { throw new Error("connect ECONNREFUSED"); };
    const first = await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    expect(first.status).toBe("error");
    expect(cm.gone).toEqual(["c1"]);

    cm.trackedRunning = true;
    spawnReply = async () => ({ status: "success", text: "cleaned", truncated: false, durationMs: 1, costUsd: 0 });
    const second = await mgr.run({ harnessId: "claude", prompt: "b", model: "haiku" });
    mgr.stop();

    expect(second.text).toBe("cleaned");
    expect(cm.createCalls).toHaveLength(2);
  });

  /**
   * The dictation that discovers the missed exit has already failed. Leaving the
   * recreate to the next one costs that one a container start too, so both
   * dictations either side of an event-stream gap break req 8.
   */
  it("recreates after a missed exit event without waiting for the next dictation", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    cm.trackedRunning = false;
    spawnReply = async () => { throw new Error("connect ECONNREFUSED"); };
    const failed = await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    expect(failed.status).toBe("error");
    expect(cm.gone).toEqual(["c1"]);

    // No second run: the container must be back before the next dictation asks.
    cm.trackedRunning = true;
    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(2); });

    // One recreate, not a loop: the revive is scheduled once and settles.
    await new Promise((r) => setTimeout(r, 30));
    mgr.stop();

    expect(cm.createCalls).toHaveLength(2);
    expect(cm.get(CLEANUP_CONTAINER_SESSION_ID)).toBeDefined();
  });

  /**
   * A `die` lost to an event-stream gap is otherwise noticed only when a
   * dictation fails, so the first user back after the gap gets no cleanup at all.
   */
  it("reconciles a missed exit when the event stream recovers, with no dictation", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();
    clock.now += CREATE_INTERVAL_MS + 1_000;

    cm.trackedRunning = false;
    cm.emit("health_monitor_resumed", { gapMs: 30_000 });

    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(2); });
    mgr.stop();

    expect(cm.gone).toEqual(["c1"]);
    expect(posts).toHaveLength(0);
  });

  /**
   * A death discovered by a probe is still a death inside the create interval,
   * and that interval is what paces a container dying the moment it starts. The
   * death time being unknown does not make the last create time unknown.
   */
  it("paces a missed exit discovered inside the create interval", async () => {
    const { mgr, cm, clock } = makeManager(root);
    await mgr.start();

    cm.trackedRunning = false;
    spawnReply = async () => { throw new Error("connect ECONNREFUSED"); };
    await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });

    await new Promise((r) => setTimeout(r, 30));
    expect(cm.createCalls).toHaveLength(1);

    clock.now += CREATE_INTERVAL_MS + 1_000;
    await vi.waitFor(() => { expect(cm.createCalls).toHaveLength(2); });
    mgr.stop();
  });

  it("keeps a container Docker could not answer for", async () => {
    const { mgr, cm } = makeManager(root);
    await mgr.start();

    cm.trackedRunning = undefined;
    spawnReply = async () => { throw new Error("socket hang up"); };
    await mgr.run({ harnessId: "claude", prompt: "a", model: "haiku" });
    mgr.stop();

    expect(cm.gone).toEqual([]);
    expect(cm.get(CLEANUP_CONTAINER_SESSION_ID)).toBeDefined();
  });

  it("reports the reason when the container cannot start, without throwing", async () => {
    const { mgr, cm } = makeManager(root);
    cm.createError = new Error("no docker here");
    await mgr.start();

    const result = await mgr.run({ harnessId: "claude", prompt: "clean this up", model: "haiku" });
    mgr.stop();

    expect(result.status).toBe("error");
    expect(result.error).toContain("no docker here");
    expect(posts).toHaveLength(0);
  });
});
