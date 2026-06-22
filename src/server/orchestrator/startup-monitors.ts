import type { FastifyInstance } from "fastify";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import {
  createMissingContainerReconciler,
  setupContainerHealthMonitoring,
  registerShutdownHook,
} from "./app-lifecycle.js";
import { resolveAgentDockerLimits } from "./session-container.js";
import { runDiskJanitor, pruneSessionVolumes, escalateDiskTiers, statfsFreeBytes, statfsTotalBytes, resolveDiskWatermarks } from "./disk-janitor.js";
import { liveOverlayScopeHashes, depDirsForSession, isOverlayEnabled, overlayRuntimeKey, pnpmStoreHash } from "./overlay-session.js";
import { resolveDiskIdleLadder } from "./sessions.js";
import type { OrchestratorRuntime } from "./bootstrap-managers.js";

/** Functions produced by {@link startStartupMonitors} that later steps need. */
export interface StartupMonitors {
  /**
   * Kick a background disk-tier escalation pass (issue #1049). Created here
   * because it closes over the resolved disk watermarks / pacing config, and
   * consumed by the WS `activateSession` path in `route-registry.ts`.
   */
  kickDiskEscalation: (excludeSessionId?: string) => void;
}

/**
 * Start the orchestrator's periodic monitors and register the
 * process-lifecycle hooks: the Docker memory-stats broadcast, the idle
 * container enforcer + missing-container reconciler, the startup disk-janitor
 * sweep, disk-tier escalation (startup + periodic), container health
 * monitoring, and the graceful-shutdown / interval-cleanup `onClose` hooks.
 *
 * Extracted from `index.ts` for the P4 split (docs/201) with no behavior
 * change. The two `onClose` hooks registered here are the only ones in the app
 * (route registration uses `onError`/`onRequest`, never `onClose`), so
 * registering them at monitor-startup time preserves their relative order:
 * interval-cleanup first, then `registerShutdownHook`.
 */
export async function startStartupMonitors(
  app: FastifyInstance,
  rt: OrchestratorRuntime,
): Promise<StartupMonitors> {
  const {
    dockerForStats, latestMemoryStats, sseBroadcast, enforceIdleContainerLimit,
    containerManager, runnerRegistry, broadcastLog, sessionManager,
    isTestMode, stateDir, repoStore, credentialsDir, githubAuthManager,
    createRepoGit, getBareCacheDir, serviceManagers, createGitManager,
    loopDetector, oomBreaker, chatHistoryManager,
    repoPrefetcher, claudeOAuthRefresherRef, codexOAuthRefresherRef,
    startupTimer, authManagers, dockerProxyServer, databaseManager,
  } = rt;

  // ---- Docker memory stats broadcast (every 10s) ----
  // Also caches the latest reading for the pressure-aware idle enforcer
  // and triggers an immediate eviction pass when usage crosses the
  // eviction threshold. Without the immediate trigger, eviction would
  // wait for the next 30s idle-enforcement tick — long enough for the
  // host to OOM-kill containers underneath us.
  const memoryStatsInterval = dockerForStats ? setInterval(() => {
    void (async () => {
      const stats = await readDockerMemoryStats(dockerForStats);
      if (!stats) return;
      const wasUnderPressure = isUnderEvictionPressure(latestMemoryStats.value);
      latestMemoryStats.value = stats;
      sseBroadcast("docker_memory", stats);
      const nowUnderPressure = isUnderEvictionPressure(stats);
      if (nowUnderPressure && !wasUnderPressure) {
        // Edge-triggered: only fire once per pressure crossing so we don't
        // burn cycles on every poll while pressure persists. The periodic
        // 30s enforcer continues to run with pressure-aware semantics for
        // the duration.
        try { enforceIdleContainerLimit(); }
        catch (err) { console.error("[memory-pressure] immediate eviction failed:", err); }
      }
    })();
  }, 10_000) : null;

  // ---- Periodic idle container cleanup (every 30s) ----
  // Runs the idle enforcer on a fixed cadence so cleanup happens regardless
  // of WebSocket activity. WebSocket close handlers MUST NOT trigger this
  // synchronously — that would couple WS lifecycle to runner/container
  // lifecycle and let transient disconnects kill running agents. The
  // enforcer itself also enforces a grace period (IDLE_GRACE_PERIOD_MS) so
  // a runner whose viewer just detached is not immediately eligible for
  // disposal.
  //
  // The missing-container reconciler runs on the same cadence — it catches
  // runners whose container vanished without a `container_exited` event
  // (Docker daemon restart, missed die event during the health-monitor
  // reconnect window, external `docker rm`). Without it, the session
  // looks stuck forever from the client's perspective.
  const reconcileMissingContainers = containerManager
    ? createMissingContainerReconciler({
        containerManager,
        runnerRegistry,
        broadcastLog,
        // Lets the reconciler re-adopt a live-but-untracked container
        // instead of force-disposing its runner — same resolver shape as
        // the startup `rediscover` path.
        sessionInfoResolver: (sessionId) => {
          const session = sessionManager.get(sessionId);
          if (!session?.workspaceDir) return undefined;
          const limits = resolveAgentDockerLimits(session.workspaceDir);
          return {
            workspaceDir: session.workspaceDir,
            dockerAccess: limits.dockerAccess,
            resourceLimits: limits.dockerAccess ? {
              memory: limits.memoryLimit,
              cpuQuota: limits.cpuQuota,
              pidsLimit: limits.pidsLimit,
            } : undefined,
          };
        },
      })
    : null;
  // Guards against overlapping reconciler passes: the reconciler is async
  // (C3 awaits Docker queries to re-adopt orphaned containers) and a hung
  // Docker daemon can make a pass outlast the 30s interval. Two concurrent
  // passes over `runnerRegistry.ids()` could both decide the same runner is
  // orphaned and race dispose-vs-adopt — so a pass that's still running
  // skips the next tick entirely.
  let reconcileInFlight = false;
  const idleEnforcementInterval = containerManager ? setInterval(() => {
    try {
      enforceIdleContainerLimit();
    } catch (err) {
      console.error("[idle-cleanup] periodic enforcement failed:", err);
    }
    if (reconcileMissingContainers && !reconcileInFlight) {
      // Async since C3 — the reconciler may await a Docker query to
      // re-adopt an orphaned container. Fire-and-forget with a catch so a
      // hung Docker daemon can't wedge the idle-enforcement interval.
      reconcileInFlight = true;
      void reconcileMissingContainers()
        .catch((err: unknown) => {
          console.error("[orphan-runner] periodic reconciliation failed:", err);
        })
        .finally(() => { reconcileInFlight = false; });
    }
  }, 30_000) : null;
  // Don't keep the event loop alive just for idle enforcement — let process
  // shutdown proceed naturally.
  if (idleEnforcementInterval && typeof idleEnforcementInterval.unref === "function") {
    idleEnforcementInterval.unref();
  }

  // ---- Disk janitor (startup-only sweep) ----
  // Reclaims orphan ShipIt-labeled compose volumes, archived session
  // workspaces (opt-in), and unreferenced repo / dep caches. Each item
  // is recovering from a failure earlier in the lifecycle (archive
  // teardown crashed, fs.rm failed, repo removal didn't cascade) — none
  // accumulate steadily, so we run once at boot rather than on a timer.
  // Skipped in test mode so unit tests don't shell out to docker.
  if (!isTestMode) {
    // SHI-197 — one retention value covers every cold artifact: unreferenced
    // repo/dep caches, pnpm + repo-memory caches, AND the crash-recovery
    // archived-workspace backstop. Post-SHI-192 archiving frees the workspace
    // synchronously, so that sweep only catches a sync cleanup that crashed —
    // pure backstop, no longer an independently tunable day-threshold (the old
    // DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS knob is gone). Unset → runDiskJanitor's
    // built-in DEFAULT_COLD_ARTIFACT_RETENTION_DAYS.
    const coldArtifactRetentionDays =
      parseFloat(process.env.DISK_COLD_ARTIFACT_RETENTION_DAYS ?? "") || undefined;
    // Pace between destructive ops so the (fire-and-forget) sweep drips out
    // instead of bursting `docker` spawns + git pushes that contend with a
    // concurrent agent start for the Docker daemon / bare-cache git layer. This
    // is why we DON'T defer the sweep off the boot window — throttling flattens
    // the spike wherever it lands instead of relocating it to a later, more
    // disruptive moment mid-session.
    const janitorPaceMs = parseFloat(process.env.DISK_JANITOR_PACE_MS ?? "");
    // Fire-and-forget — we don't want the sweep to block first-request
    // latency, and `runDiskJanitor` swallows its own errors (see the
    // module docstring) so there's nothing to await for safety.
    void runDiskJanitor({
      sessionManager,
      repoStore,
      stateDir,
      sessionsRoot: rt.sessionsRoot,
      credentialsDir,
      coldArtifactRetentionDays,
      paceMs: Number.isFinite(janitorPaceMs) ? janitorPaceMs : 500,
      githubAuthManager,
      createRepoGit,
      getBareCacheDir,
      sweepOrphanBranches: process.env.DISK_JANITOR_ORPHAN_BRANCHES !== "false",
      // docs/183 Phase 3/4 — authoritative live-base source for the overlay-base
      // sweep. Resolved at sweep time (not boot) so it reflects the current
      // session set; returns an empty set when the `OVERLAY_DEP_STORE=0`/`false`
      // kill switch is set, keeping the sweep inert under the kill switch.
      liveOverlayScopeHashes: () =>
        liveOverlayScopeHashes(sessionManager.listAll(), depDirsForSession),
      // docs/197 Part 2 — the current runtime's pnpm store hash (the live store to
      // protect), or null when the kill switch disables the feature so stale stores
      // are reaped past the cutoff. Resolved at sweep time so a worker-image rebuild
      // rotates it.
      pnpmStoreRuntimeHash: () =>
        isOverlayEnabled() ? pnpmStoreHash(overlayRuntimeKey()) : null,
    });
  }

  // docs/161 Part 2 — disk-tier escalation. Fired async after each session
  // activation (never on the start critical path). This is the PRIMARY
  // steady-state reclaim of the idle node_modules tail: prod deploys manually,
  // so the startup janitor above runs rarely, but session starts are frequent
  // and are exactly when disk gets consumed. Guarded + fire-and-forget;
  // `escalateDiskTiers` swallows its own errors.
  // SHI-197 — resolve + validate the ordered idle ladder once at startup. A
  // misconfigured env (e.g. DISK_IDLE_EVICT_MERGED_MS < DISK_IDLE_LIGHT_MS) throws
  // here, failing the box loudly at boot rather than silently corrupting disk
  // reclaim with an incoherent ladder.
  const ladder = resolveDiskIdleLadder();
  // Pace between age-based tier descents for the same reason as the janitor:
  // keep the steady-state node_modules reclaim from monopolizing the Docker
  // daemon a concurrent agent start needs. Deliberately NOT applied to the
  // disk-pressure LRU descent — when the box is critically low and starts are
  // already failing, fast reclaim is the point.
  const escalationPaceMsRaw = parseFloat(process.env.DISK_ESCALATION_PACE_MS ?? "");
  const escalationPaceMs = Number.isFinite(escalationPaceMsRaw) ? escalationPaceMsRaw : 500;
  // Disk-pressure watermarks: explicit *_BYTES win (backward compat); otherwise
  // derive fraction-of-disk *_PCT × total host disk size (portable across host
  // disk sizes — self-hosters can't be expected to know the right byte count).
  // Total is a fixed property of the host filesystem, so probe it once here
  // rather than on every escalation pass.
  const diskTotalBytes = isTestMode ? null : await statfsTotalBytes(stateDir);
  const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
    lowBytes: parseFloat(process.env.DISK_FREE_LOW_BYTES ?? "") || undefined,
    highBytes: parseFloat(process.env.DISK_FREE_HIGH_BYTES ?? "") || undefined,
    lowPct: parseFloat(process.env.DISK_FREE_LOW_PCT ?? "") || undefined,
    highPct: parseFloat(process.env.DISK_FREE_HIGH_PCT ?? "") || undefined,
    totalBytes: diskTotalBytes,
  });
  // issue #1048 — surface that the disk-pressure safety net is off. When
  // neither watermark resolves (no *_BYTES / *_PCT configured, or a *_PCT
  // was set but the host total couldn't be probed), the LRU-under-pressure
  // descent in `escalateDiskTiers` no-ops, leaving only the age-based ladder.
  // One line at startup makes that visible instead of silently degraded.
  if (!isTestMode && (diskFreeLow === undefined || diskFreeHigh === undefined)) {
    console.warn(
      "[disk-janitor] disk-pressure eviction is DISABLED — set DISK_FREE_LOW_PCT/DISK_FREE_HIGH_PCT "
      + "(or DISK_FREE_LOW_BYTES/DISK_FREE_HIGH_BYTES) to enable the under-pressure LRU descent. "
      + "Age-based tier escalation still runs.",
    );
  }
  const kickDiskEscalation = (excludeSessionId?: string): void => {
    if (isTestMode || !containerManager) return;
    void escalateDiskTiers(
      {
        sessionManager,
        runnerRegistry,
        serviceManagers,
        containerManager,
        pruneVolumes: (sid) => pruneSessionVolumes(sid),
        createGitManager,
        ladder,
        paceMs: escalationPaceMs,
        diskFreeLow,
        diskFreeHigh,
        getFreeDiskBytes: () => statfsFreeBytes(stateDir),
      },
      excludeSessionId,
    );
  };
  // Startup safety net: run one pass now so a long-idle tail left by a
  // manually-deployed (rarely-restarted) prod box gets reclaimed even before
  // the first session activation. The per-activation kicks above are the
  // primary steady-state reclaim.
  kickDiskEscalation();

  // ---- Periodic disk-tier escalation (issue #1049) ----
  // The ESCALATION ladder (and its disk-pressure LRU descent) is the one disk
  // task that accumulates steadily — idle node_modules pile up with the clock,
  // not with a failure earlier in the lifecycle. The other side, the startup
  // `runDiskJanitor` failure-recovery sweeps, correctly stay startup-only (see
  // the disk-janitor.ts module docstring) because those orphans only appear
  // when teardown crashed, so a timer there would mostly burn cycles.
  //
  // Until now escalation only fired at orchestrator boot and after each session
  // start, which created a self-heal feedback trap: once the disk fills, new
  // session starts FAIL → the per-start kick never fires → the reclaim that
  // would free space never runs. A quiet period with no starts also let idle
  // node_modules sit well past the 24h `hot → light` step unreclaimed. This
  // low-frequency timer makes both the age-based reclaim AND the disk-pressure
  // check run even when the instance is quiet or wedged, independent of session
  // activity. Mirrors `kickDiskEscalation`'s own `!isTestMode && containerManager`
  // no-op guard, so in test mode the interval is never created.
  const diskEscalationIntervalMs = parseFloat(process.env.DISK_ESCALATION_INTERVAL_MS ?? "")
    || 3_600_000; // hourly
  const diskEscalationInterval = (!isTestMode && containerManager)
    ? setInterval(() => { kickDiskEscalation(); }, diskEscalationIntervalMs)
    : null;
  // Don't keep the event loop alive just for the periodic reclaim — match the
  // idle-enforcement / memory-stats intervals.
  if (diskEscalationInterval && typeof diskEscalationInterval.unref === "function") {
    diskEscalationInterval.unref();
  }

  // ---- Container health monitoring ----
  if (containerManager) {
    setupContainerHealthMonitoring(containerManager, runnerRegistry, broadcastLog, loopDetector, oomBreaker, chatHistoryManager);
  }

  // Graceful shutdown
  app.addHook("onClose", async () => {
    if (memoryStatsInterval) clearInterval(memoryStatsInterval);
    if (idleEnforcementInterval) clearInterval(idleEnforcementInterval);
    if (diskEscalationInterval) clearInterval(diskEscalationInterval);
    if (repoPrefetcher) repoPrefetcher.stop();
    claudeOAuthRefresherRef.ref?.stop();
    codexOAuthRefresherRef.ref?.stop();
  });
  registerShutdownHook(app, {
    startupTimer, authManagers, runnerRegistry,
    dockerProxyServer, containerManager, databaseManager,
  });

  return { kickDiskEscalation };
}
