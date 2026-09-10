import { describe, it, expect, vi } from "vitest";
import { applyOverlayDepDirs } from "./service-manager-setup.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { isOverlayEligible } from "./overlay-session.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionInfo, LogSource } from "../shared/types.js";

const SESSION = { remoteUrl: "https://github.com/owner/repo.git", kind: "repo" } as unknown as SessionInfo;

// Pass the instanceof guard without starting a container.
function makeRunner(opts: { disposed?: boolean } = {}): SessionRunnerInterface {
  const runner = Object.create(ContainerSessionRunner.prototype) as Record<string, unknown>;
  runner.sessionId = "s1";
  runner.whenWorkerReady = () => Promise.resolve();
  Object.defineProperty(runner, "disposed", { value: opts.disposed ?? false, configurable: true });
  return runner as unknown as SessionRunnerInterface;
}

function makeDocker(existing: string[]) {
  return {
    getVolume: (name: string) => ({
      inspect: async () => {
        if (existing.includes(name)) return {};
        throw Object.assign(new Error("no such volume"), { statusCode: 404 });
      },
    }),
  };
}

function makeManager(opts: { changed?: boolean } = {}) {
  const applied: { depDir: string; volumeName: string }[][] = [];
  const mgr = {
    setOverlayDepDirs: (v: { depDir: string; volumeName: string }[]) => {
      applied.push(v);
      return opts.changed ?? false;
    },
  };
  return { mgr: mgr as unknown as ServiceManager, applied };
}

function makeContainerManager(opts: {
  provisioned: { depDir: string; volumeName: string }[] | null;
  existingVolumes: string[];
  prepareOverlaySpecs?: () => Promise<{ depDir: string; volumeName: string }[]>;
  volumesRecreated?: boolean;
}) {
  const prepareCalls: number[] = [];
  let recreated = opts.volumesRecreated ?? false;
  return {
    provisionedOverlayDepDirs: () => opts.provisioned,
    dockerClient: makeDocker(opts.existingVolumes),
    prepareOverlaySpecs: async () => {
      prepareCalls.push(1);
      return opts.prepareOverlaySpecs ? await opts.prepareOverlaySpecs() : [];
    },
    consumeOverlayVolumesRecreated: () => {
      const was = recreated;
      recreated = false;
      return was;
    },
    prepareCalls,
  } as unknown as SessionContainerManager & { prepareCalls: number[] };
}

function makeLog() {
  const lines: string[] = [];
  const broadcastLog = (_s: string, _src: LogSource, text: string) => { lines.push(text); };
  return { lines, broadcastLog };
}

describe("applyOverlayDepDirs (#2426)", () => {
  it("mounts exactly what the agent container was provisioned with", async () => {
    const provisioned = [
      { depDir: "game/node_modules", volumeName: "shipit-s1_overlay-aaaa" },
      { depDir: "node_modules", volumeName: "shipit-s1_overlay-bbbb" },
    ];
    const containerManager = makeContainerManager({
      provisioned,
      existingVolumes: provisioned.map((p) => p.volumeName),
    });
    const { mgr, applied } = makeManager();

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager,
      session: SESSION,
      workspaceDir: "/nonexistent",
      broadcastLog: makeLog().broadcastLog,
    });

    expect(applied).toEqual([provisioned]);
    expect(containerManager.prepareCalls).toEqual([]);
  });

  it("tells the session when a provisioned overlay volume has gone missing", async () => {
    const containerManager = makeContainerManager({
      provisioned: [
        { depDir: "node_modules", volumeName: "shipit-s1_overlay-live" },
        { depDir: "game/node_modules", volumeName: "shipit-s1_overlay-gone" },
      ],
      existingVolumes: ["shipit-s1_overlay-live"],
    });
    const { mgr, applied } = makeManager();
    const { lines, broadcastLog } = makeLog();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent", broadcastLog,
    });

    expect(applied).toEqual([[{ depDir: "node_modules", volumeName: "shipit-s1_overlay-live" }]]);
    expect(lines.some((l) => l.includes("game/node_modules"))).toBe(true);
    expect(lines.some((l) => l.includes("[compose]"))).toBe(true);
  });

  it("applies an authoritative empty answer, so a stale overlay is not kept", async () => {
    const containerManager = makeContainerManager({ provisioned: [], existingVolumes: [] });
    const { mgr, applied } = makeManager();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    });

    expect(applied).toEqual([[]]);
    expect(logSpy.mock.calls.flat().join(" ")).toContain("no dependency overlay");
    logSpy.mockRestore();
  });

  it("reports an unresolvable answer instead of returning silently", async () => {
    const containerManager = makeContainerManager({ provisioned: null, existingVolumes: [] });
    const { mgr } = makeManager();
    const { lines, broadcastLog } = makeLog();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent", broadcastLog,
    });

    expect(lines.some((l) => l.includes("could not tell which dependency overlays"))).toBe(true);
  });

  it("reports whether the manager's set actually changed", async () => {
    const provisioned = [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }];
    const args = {
      provisioned,
      existingVolumes: provisioned.map((p) => p.volumeName),
    };

    const unchanged = makeManager({ changed: false });
    expect(await applyOverlayDepDirs(makeRunner(), unchanged.mgr, {
      containerManager: makeContainerManager(args), session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(false);

    const changed = makeManager({ changed: true });
    expect(await applyOverlayDepDirs(makeRunner(), changed.mgr, {
      containerManager: makeContainerManager(args), session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(true);
  });

  it("asks for a reconcile when creation had to recreate the overlay volumes", async () => {
    const provisioned = [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }];
    const containerManager = makeContainerManager({
      provisioned,
      existingVolumes: provisioned.map((p) => p.volumeName),
      volumesRecreated: true,
    });
    const { mgr } = makeManager({ changed: false });

    expect(await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(true);

    expect(await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(false);
  });

  it("falls back to re-derivation only when the container is unknown", async () => {
    const containerManager = makeContainerManager({
      provisioned: null,
      existingVolumes: ["shipit-s1_overlay-aaaa"],
      prepareOverlaySpecs: async () => [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }],
    });
    const { mgr, applied } = makeManager();

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    });

    expect(containerManager.prepareCalls.length).toBe(1);
    expect(applied).toEqual([[{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }]]);
  });

  it("does not clobber a good answer with an empty guess", async () => {
    const containerManager = makeContainerManager({ provisioned: null, existingVolumes: [] });
    const { mgr, applied } = makeManager();

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    });

    expect(applied).toEqual([]);
  });

  it("reports a resolution failure to the session instead of silently mounting nothing", async () => {
    const containerManager = {
      provisionedOverlayDepDirs: () => { throw new Error("daemon down"); },
      dockerClient: makeDocker([]),
      prepareOverlaySpecs: async () => [],
      consumeOverlayVolumesRecreated: () => false,
    } as unknown as SessionContainerManager;
    const { mgr, applied } = makeManager();
    const { lines, broadcastLog } = makeLog();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent", broadcastLog,
    });

    expect(applied).toEqual([]);
    expect(lines.some((l) => l.includes("daemon down"))).toBe(true);
  });

  it("stays inert for a session that is not overlay-eligible", async () => {
    const containerManager = makeContainerManager({
      provisioned: [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }],
      existingVolumes: ["shipit-s1_overlay-aaaa"],
    });
    const { mgr, applied } = makeManager();

    const ineligible = { remoteUrl: undefined, kind: "repo" } as unknown as SessionInfo;
    expect(isOverlayEligible(ineligible)).toBe(false);

    await applyOverlayDepDirs(makeRunner(), mgr, {
      containerManager,
      session: ineligible,
      workspaceDir: "/nonexistent",
    });

    expect(applied).toEqual([]);
  });

  it("does nothing once the runner has been disposed", async () => {
    const containerManager = makeContainerManager({
      provisioned: [{ depDir: "node_modules", volumeName: "shipit-s1_overlay-aaaa" }],
      existingVolumes: ["shipit-s1_overlay-aaaa"],
    });
    const { mgr, applied } = makeManager();

    await applyOverlayDepDirs(makeRunner({ disposed: true }), mgr, {
      containerManager, session: SESSION, workspaceDir: "/nonexistent",
    });

    expect(applied).toEqual([]);
  });
});
