/**
 * docs/288 — the warm pool's preview pre-start.
 *
 * The behaviour under test is "does a warm session end up with a RUNNING stack
 * registered under its own id, and does it decline in every case where it
 * should". The manager itself is faked through the `createManager` seam: a real
 * one needs a Docker daemon, and what makes the real construction shared is
 * `warm-preview-single-construction.test.ts`, not a double here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preStartWarmPreview,
  stopWarmPreview,
  isRecentlyUsedRepo,
  WARM_PREVIEW_RECENCY_DAYS,
} from "./warm-preview.js";
import type { WarmPreviewDeps } from "./warm-preview.js";
import type { ServiceManager } from "./service-manager.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REPO = "https://github.com/acme/app.git";
const SESSION = "warm-1";

describe("isRecentlyUsedRepo (docs/288 req 8)", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");

  it("accepts a repo opened just now", () => {
    expect(isRecentlyUsedRepo(new Date(now).toISOString(), now)).toBe(true);
  });

  it("accepts a repo opened exactly at the cutoff", () => {
    // The boundary is inclusive: a user returning after precisely a week is the
    // case req 9 is written for, and pushing them one session cold on a
    // rounding decision is the wrong side to err on.
    const at = new Date(now - WARM_PREVIEW_RECENCY_DAYS * DAY_MS).toISOString();
    expect(isRecentlyUsedRepo(at, now)).toBe(true);
  });

  it("rejects a repo one second past the cutoff", () => {
    const at = new Date(now - WARM_PREVIEW_RECENCY_DAYS * DAY_MS - 1000).toISOString();
    expect(isRecentlyUsedRepo(at, now)).toBe(false);
  });

  it("rejects a missing or unparseable stamp", () => {
    // "We cannot tell" must not spend a standing cost.
    expect(isRecentlyUsedRepo(undefined, now)).toBe(false);
    expect(isRecentlyUsedRepo("not a date", now)).toBe(false);
  });
});

/**
 * A pre-started manager is the only kind with NO RUNNER to own its teardown.
 * Every other stack leaves the registry through the runner's `disposed` handler;
 * a warm session never had a runner, so each path that ends a warm session
 * before it is claimed has to say so explicitly — or it strands a manager
 * polling Docker for a session that is gone.
 */
describe("stopWarmPreview", () => {
  it("unregisters before stopping, and tolerates a stop that fails", async () => {
    const order: string[] = [];
    const registry = new Map<string, ServiceManager>();
    registry.set("warm-1", {
      stop: async () => {
        // Registry membership is what every other path reads to decide whether
        // this session has a live stack, so it must already be false here.
        order.push(`stop(registered=${String(registry.has("warm-1"))})`);
        throw new Error("compose down failed");
      },
    } as unknown as ServiceManager);

    expect(() => stopWarmPreview(registry, "warm-1")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.has("warm-1")).toBe(false);
    expect(order).toEqual(["stop(registered=false)"]);
  });

  it("is a no-op for a session with no pre-started stack", () => {
    const registry = new Map<string, ServiceManager>();
    expect(() => stopWarmPreview(registry, "warm-1")).not.toThrow();
    expect(() => stopWarmPreview(undefined, "warm-1")).not.toThrow();
  });
});

describe("preStartWarmPreview", () => {
  let workspaceDir: string;
  let serviceManagers: Map<string, ServiceManager>;
  let starts: string[];
  let stops: string[];
  let lastUsedAt: string | undefined;
  let startImpl: () => Promise<void>;

  /** A manager double with just the surface the pre-start touches. */
  function fakeManager(sessionId: string): ServiceManager {
    return {
      start: async () => { starts.push(sessionId); await startImpl(); },
      stop: async () => { stops.push(sessionId); },
      setOverlayDepDirs: () => false,
    } as unknown as ServiceManager;
  }

  function deps(over: Partial<WarmPreviewDeps> = {}): WarmPreviewDeps {
    return {
      repoStore: { get: (url: string) => (url === REPO ? { url, lastUsedAt } : undefined) } as unknown as RepoStore,
      sessionManager: {
        get: (id: string) => (id === SESSION ? { id, remoteUrl: REPO } : undefined),
      } as unknown as SessionManager,
      serviceManagers,
      containerManager: null,
      serviceEnvDir: path.join(workspaceDir, ".env"),
      createManager: ({ sessionId }) => fakeManager(sessionId),
      ...over,
    } as WarmPreviewDeps;
  }

  const run = (): Promise<void> => preStartWarmPreview(
    { sessionId: SESSION, workspaceDir, repoUrl: REPO }, deps(),
  );

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "warm-preview-"));
    fs.writeFileSync(path.join(workspaceDir, "docker-compose.yml"), "services: {}\n");
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "compose:\n  file: docker-compose.yml\n");
    serviceManagers = new Map();
    starts = [];
    stops = [];
    lastUsedAt = new Date().toISOString();
    startImpl = async () => undefined;
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("registers the started manager under the warm session's own id", async () => {
    // The id is the whole handoff: `setupServiceManager` opens with
    // `serviceManagers.get(runner.sessionId)` and adopts what it finds, and a
    // warm claim keeps the session id it was warmed under.
    await run();
    expect(starts).toEqual([SESSION]);
    expect(serviceManagers.get(SESSION)).toBeDefined();
  });

  it("declines for a repo outside the recency window", async () => {
    lastUsedAt = new Date(Date.now() - (WARM_PREVIEW_RECENCY_DAYS + 1) * DAY_MS).toISOString();
    await run();
    expect(starts).toEqual([]);
    expect(serviceManagers.has(SESSION)).toBe(false);
  });

  it("declines when a manager is already registered for the session", async () => {
    // A claim raced us and activation built its own. Registering a second would
    // strand the first with the same compose project name.
    const existing = fakeManager("pre-existing");
    serviceManagers.set(SESSION, existing);
    await run();
    expect(starts).toEqual([]);
    expect(serviceManagers.get(SESSION)).toBe(existing);
  });

  it("declines when the project declares no compose stack", async () => {
    fs.writeFileSync(path.join(workspaceDir, "shipit.yaml"), "agent:\n  install: []\n");
    await run();
    expect(starts).toEqual([]);
    expect(serviceManagers.has(SESSION)).toBe(false);
  });

  it("unregisters and stops the manager when the start fails", async () => {
    // Leaving a failed manager registered is WORSE than never pre-starting:
    // activation adopts what it finds and never calls `start()` itself, so the
    // session would get no preview at all.
    startImpl = () => Promise.reject(new Error("compose up exploded"));
    await run();
    expect(serviceManagers.has(SESSION)).toBe(false);
    expect(stops).toEqual([SESSION]);
  });

  it("registers before it awaits anything, so a claim cannot build a rival", async () => {
    // The compose project name comes from the session id, so two managers for
    // one warm session are two owners of one stack. `setupServiceManager` only
    // adopts what is ALREADY in the registry — a check-then-await-then-set would
    // let an activation landing in that gap build a rival and then be clobbered.
    let registeredDuringStart = false;
    startImpl = async () => { registeredDuringStart = serviceManagers.has(SESSION); };
    await run();
    expect(registeredDuringStart).toBe(true);
  });

  it("abandons a queued start whose manager changed hands", async () => {
    // Every await before the start can outlive our ownership: the repair sweep,
    // a repo delete or tier 0 may have stopped this manager and unregistered
    // it. `ServiceManager.start()` RESETS `_disposed` and re-arms the poll loop,
    // so going ahead would resurrect a manager nobody owns, polling Docker for a
    // session nobody has, with nothing left that could stop it.
    const overlayReached = { resolve: () => {} };
    const gate = new Promise<void>((r) => { overlayReached.resolve = r; });
    const d = deps({
      // The one await between registration and the start. Standing in for it
      // lets the test take the manager away at exactly that moment.
      containerManager: {
        provisionedOverlayDepDirs: () => { overlayReached.resolve(); return []; },
      } as unknown as WarmPreviewDeps["containerManager"],
    });

    const run = preStartWarmPreview({ sessionId: SESSION, workspaceDir, repoUrl: REPO }, d);
    await gate;
    // Somebody else took the session's stack while we were queued.
    serviceManagers.delete(SESSION);
    await run;

    expect(starts).toEqual([]);
  });

  it("leaves a failed manager alone once a runner has adopted it", async () => {
    // The other order: a claim activated while our start was running, so
    // `setupServiceManager` adopted this manager and wired it to a runner.
    // Unregistering now would make the session's own manager invisible to every
    // `serviceManagers.get` — the preview routes, the service list, the idle
    // enforcer's `has` — and nothing here could start it again anyway.
    startImpl = () => Promise.reject(new Error("compose up exploded"));
    await preStartWarmPreview(
      { sessionId: SESSION, workspaceDir, repoUrl: REPO },
      deps({ isSessionActive: () => true }),
    );
    expect(serviceManagers.has(SESSION)).toBe(true);
    expect(stops).toEqual([]);
  });

  it("never rejects, whatever the store does", async () => {
    // Every caller discards this promise — it is the tail of a fire-and-forget
    // warm continuation — so a throw here is an unhandled rejection.
    const broken = deps({
      repoStore: { get: () => { throw new Error("db closed"); } } as unknown as RepoStore,
    });
    await expect(
      preStartWarmPreview({ sessionId: SESSION, workspaceDir, repoUrl: REPO }, broken),
    ).resolves.toBeUndefined();
    expect(serviceManagers.has(SESSION)).toBe(false);
  });
});
