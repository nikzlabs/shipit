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

const posts: { url: string; path: string; body: Record<string, unknown> }[] = [];
let spawnReply: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

// Reproduces the real workerPost's abort behaviour: an aborted signal rejects
// the request at once. Without that, a fixture cannot see a caller that gives up
// on the transport and unwinds while the worker is still running the spawn.
vi.mock("./worker-http.js", () => ({
  workerPost: async (url: string, p: string, body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
    posts.push({ url, path: p, body });
    const reply = p === "/agent/spawn" ? spawnReply(body, opts?.signal) : Promise.resolve({ cancelled: true });
    if (!opts?.signal) return reply;
    return Promise.race([
      reply,
      new Promise((_r, reject) => {
        opts.signal!.addEventListener(
          "abort", () => reject(new Error("Worker request aborted")), { once: true },
        );
      }),
    ]);
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

  async isTrackedContainerRunning(): Promise<boolean | undefined> { return this.trackedRunning; }

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
    this.destroyed.push(sessionId);
    this.containers.delete(sessionId);
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
    spawnReply = async () => ({ status: "success", text: "cleaned", truncated: false, durationMs: 5, costUsd: 0 });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-container-"));
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

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
    const { mgr, cm } = makeManager(root);
    await mgr.start();
    cm.emit("container_exited", "11111111-1111-4111-8111-111111111111", 1, undefined);
    await new Promise((r) => setTimeout(r, 10));
    mgr.stop();

    expect(cm.createCalls).toHaveLength(1);
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

    expect(cm.createCalls.length).toBeLessThanOrEqual(MAX_REVIVE_ATTEMPTS);
  });

  /**
   * A `die` missed during a Docker event-stream gap leaves the cached entry
   * reading "running" forever, and the missing-container reconciler cannot help:
   * it walks session runners and this container has none.
   */
  it("recreates after a missed exit event rather than failing every request", async () => {
    const { mgr, cm } = makeManager(root);
    await mgr.start();

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
