/**
 * nikzlabs/shipit#2426 — which dep-dir overlay volumes the compose stack mounts.
 *
 * A compose service that mounts the workspace must nest the SAME per-dep-dir
 * overlay the agent container has, or `<service-target>/<dep-dir>` resolves to the
 * plain directory underneath and the two containers get independent dependency
 * trees. The `up` still succeeds either way, which is what made the reported
 * failure invisible: the service's own `npm ci` filled its private tree, and no
 * amount of repairing `node_modules` from the agent side could reach it.
 *
 * These tests pin the three decisions that keep the two sides in agreement: the
 * answer comes from what the container was PROVISIONED with, a volume that has
 * gone missing is announced to the session rather than dropped silently, and a
 * failure to resolve at all does not pass for "this session has no overlay".
 */
import { describe, it, expect, vi } from "vitest";
import { applyOverlayDepDirs } from "./service-manager-setup.js";
import { ContainerSessionRunner } from "./container-session-runner.js";
import { isOverlayEligible } from "./overlay-session.js";
import type { SessionContainerManager } from "./session-container.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionInfo, LogSource } from "../shared/types.js";

/** An overlay-eligible session: repo-backed and not an ops session. */
const SESSION = { remoteUrl: "https://github.com/owner/repo.git", kind: "repo" } as unknown as SessionInfo;

/**
 * A runner that satisfies the `instanceof ContainerSessionRunner` gate without a
 * container runtime behind it. `Object.create` skips the constructor; the two
 * members the helper touches are supplied directly.
 */
function makeRunner(opts: { disposed?: boolean } = {}): SessionRunnerInterface {
  const runner = Object.create(ContainerSessionRunner.prototype) as Record<string, unknown>;
  runner.sessionId = "s1";
  runner.whenWorkerReady = () => Promise.resolve();
  Object.defineProperty(runner, "disposed", { value: opts.disposed ?? false, configurable: true });
  return runner as unknown as SessionRunnerInterface;
}

/** A Docker double where only the named volumes exist (404 otherwise). */
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
  /** Container creation had to remove Compose siblings to recreate a rotated volume. */
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
    // The live workspace is never consulted — re-reading `shipit.yaml`, the pnpm
    // signals or `git check-ignore` here is what let the compose side silently
    // disagree with the container in the first place. (`workspaceDir` above does
    // not even exist, so a re-derivation would have to fail.)
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

    // The surviving one is still mounted — a missing volume must not cost the
    // whole stack its overlay (an `external` reference to it fails `compose up`).
    expect(applied).toEqual([[{ depDir: "node_modules", volumeName: "shipit-s1_overlay-live" }]]);
    // And the drop reaches the Logs panel, not just orchestrator stdout. Without
    // this the user sees a service with its own empty `node_modules` and no
    // explanation anywhere in the product.
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

    // `[]` from the container record means "this container genuinely has no
    // overlay", so a manager adopted from an earlier container must drop what it
    // was holding.
    expect(applied).toEqual([[]]);
    // …and it SAYS so. This was the one silent branch, which is how a fleet-wide
    // "no compose service has an overlay mount" regression survived a deploy
    // with nothing in the orchestrator log to grep for.
    expect(logSpy.mock.calls.flat().join(" ")).toContain("no dependency overlay");
    logSpy.mockRestore();
  });

  it("reports an unresolvable answer instead of returning silently", async () => {
    // Unknown container AND a re-derivation that found nothing: not "no
    // overlay", but "cannot say" — the case that leaves compose services and
    // the agent on possibly different dependency trees.
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

    // The return value is what the `restartAgent` adoption path reconciles on:
    // nothing else rewrites the compose override, so an unchanged set must NOT
    // cost the stack a reconcile and a changed one must not be dropped.
    const unchanged = makeManager({ changed: false });
    expect(await applyOverlayDepDirs(makeRunner(), unchanged.mgr, {
      containerManager: makeContainerManager(args), session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(false);

    const changed = makeManager({ changed: true });
    expect(await applyOverlayDepDirs(makeRunner(), changed.mgr, {
      containerManager: makeContainerManager(args), session: SESSION, workspaceDir: "/nonexistent",
    })).toBe(true);
  });

  // The ops finding of 2026-08-19. A base-generation rotation recreates the volumes
  // but leaves the dep-dir SET identical (the name is keyed on session + dep dir),
  // so `setOverlayDepDirs` says "unchanged" — while container creation has just
  // removed the Compose siblings that were holding the old volumes. Without this
  // the stack would never be brought back up over the new generation.
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

    // Read-and-clear: one reconcile settles it, so a second call must not ask again.
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

    // Unknown container + a re-derivation that found nothing is a guess, not a
    // fact. Applying it would erase a correct set the manager already holds.
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
    // Asserted, not assumed: this test is only meaningful while the real gate
    // rejects this session, and it is the real gate the helper consults.
    expect(isOverlayEligible(ineligible)).toBe(false);

    // No remote → not overlay-eligible. The whole path must be byte-for-byte
    // unchanged for these sessions.
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
