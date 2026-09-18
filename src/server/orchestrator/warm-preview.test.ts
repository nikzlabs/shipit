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
    const at = new Date(now - WARM_PREVIEW_RECENCY_DAYS * DAY_MS).toISOString();
    expect(isRecentlyUsedRepo(at, now)).toBe(true);
  });

  it("rejects a repo one second past the cutoff", () => {
    const at = new Date(now - WARM_PREVIEW_RECENCY_DAYS * DAY_MS - 1000).toISOString();
    expect(isRecentlyUsedRepo(at, now)).toBe(false);
  });

  it("rejects a missing or unparseable stamp", () => {
    expect(isRecentlyUsedRepo(undefined, now)).toBe(false);
    expect(isRecentlyUsedRepo("not a date", now)).toBe(false);
  });
});

describe("stopWarmPreview", () => {
  it("unregisters before stopping, and tolerates a stop that fails", async () => {
    const order: string[] = [];
    const registry = new Map<string, ServiceManager>();
    registry.set("warm-1", {
      stop: async () => {
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
    startImpl = () => Promise.reject(new Error("compose up exploded"));
    await run();
    expect(serviceManagers.has(SESSION)).toBe(false);
    expect(stops).toEqual([SESSION]);
  });

  it("registers before it awaits anything, so a claim cannot build a rival", async () => {
    let registeredDuringStart = false;
    startImpl = async () => { registeredDuringStart = serviceManagers.has(SESSION); };
    await run();
    expect(registeredDuringStart).toBe(true);
  });

  it("abandons a queued start whose manager changed hands", async () => {
    const overlayReached = { resolve: () => {} };
    const gate = new Promise<void>((r) => { overlayReached.resolve = r; });
    const d = deps({
      containerManager: {
        provisionedOverlayDepDirs: () => { overlayReached.resolve(); return []; },
      } as unknown as WarmPreviewDeps["containerManager"],
    });

    const run = preStartWarmPreview({ sessionId: SESSION, workspaceDir, repoUrl: REPO }, d);
    await gate;
    serviceManagers.delete(SESSION);
    await run;

    expect(starts).toEqual([]);
  });

  it("leaves a failed manager alone once a runner has adopted it", async () => {
    startImpl = () => Promise.reject(new Error("compose up exploded"));
    await preStartWarmPreview(
      { sessionId: SESSION, workspaceDir, repoUrl: REPO },
      deps({ isSessionActive: () => true }),
    );
    expect(serviceManagers.has(SESSION)).toBe(true);
    expect(stops).toEqual([]);
  });

  it("never rejects, whatever the store does", async () => {
    const broken = deps({
      repoStore: { get: () => { throw new Error("db closed"); } } as unknown as RepoStore,
    });
    await expect(
      preStartWarmPreview({ sessionId: SESSION, workspaceDir, repoUrl: REPO }, broken),
    ).resolves.toBeUndefined();
    expect(serviceManagers.has(SESSION)).toBe(false);
  });
});
