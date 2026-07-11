import type { FastifyInstance } from "fastify";
import { isUnderEvictionPressure } from "./memory-pressure.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import {
  createMissingContainerReconciler,
  setupContainerHealthMonitoring,
  registerShutdownHook,
} from "./app-lifecycle.js";
import { resolveAgentDockerLimits } from "./session-container.js";
import { runDiskJanitor, runSteadyStateReclaim, pruneSessionVolumes, escalateDiskTiers, statfsFreeBytes, statfsTotalBytes, resolveDiskWatermarks, COLD_ARTIFACT_RETENTION_DAYS } from "./disk-janitor.js";
import { liveOverlayScopeHashes, depDirsForSession, isOverlayEnabled, overlayRuntimeKey, pnpmStoreHash } from "./overlay-session.js";
import { DEFAULT_DISK_LADDER, assertDiskLadderOrdering, type DiskLadderThresholds } from "./sessions.js";
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

  // ---- Disk janitor (startup-only CRASH-RECOVERY sweep) ----
  // Reclaims orphan ShipIt-labeled compose volumes/networks, the archived
  // session workspace crash-recovery backstop, the one-time nm-store migration
  // leftover, per-session credential/log dirs, and merged-PR branches. Every
  // item is recovering from a failure earlier in the lifecycle (teardown
  // crashed, fs.rm failed, the per-merge branch-delete hook didn't fire) — none
  // accumulate steadily, so we run once at boot rather than on a timer. The
  // STEADY-GROWTH sweeps (repo/dep caches, repo-memory, overlay bases, pnpm
  // stores) moved onto the periodic escalation pass below (SHI-196). Skipped in
  // test mode so unit tests don't shell out to docker.
  //
  // SHI-197 — one knob for every cold artifact: the archived-workspace
  // crash-recovery backstop swept here PLUS the repo/dep/pnpm/repo-memory caches
  // swept by the steady-state reclaim below, replacing the two coincidental 30d
  // knobs (`DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS` + `DISK_JANITOR_CACHE_DAYS`).
  // Parsed once here because both consumers (boot janitor + periodic reclaim)
  // read it.
  const coldArtifactRetentionRaw = parseFloat(process.env.DISK_JANITOR_COLD_ARTIFACT_RETENTION_DAYS ?? "");
  const coldArtifactRetentionDays = Number.isFinite(coldArtifactRetentionRaw)
    ? coldArtifactRetentionRaw
    : COLD_ARTIFACT_RETENTION_DAYS;
  if (!isTestMode) {
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
      // SHI-222 — orphan egress-sidecar sweep. Reuses the container manager's
      // OWN Docker client so we hit the same daemon/socket it was configured
      // with; without a container manager there are no sidecars to reap.
      ...(containerManager ? { docker: containerManager.dockerClient } : {}),
    });
  }

  // docs/161 Part 2 — disk-tier escalation. Fired async after each session
  // activation (never on the start critical path). This is the PRIMARY
  // steady-state reclaim of the idle node_modules tail: prod deploys manually,
  // so the startup janitor above runs rarely, but session starts are frequent
  // and are exactly when disk gets consumed. Guarded + fire-and-forget;
  // `escalateDiskTiers` swallows its own errors.
  // SHI-197 — the disk-idle ladder as one ordered, unit-consistent config (ms).
  // Env overrides fall back to the in-code defaults per-field; the ordering
  // invariant (`lightAfter ≤ evictMerged ≤ evictUnmerged`) is asserted once here
  // so an incoherent override (e.g. merged clock below the light clock) fails
  // fast at boot instead of silently misbehaving at runtime.
  const ladder: DiskLadderThresholds = {
    lightAfterMs: parseFloat(process.env.DISK_IDLE_LIGHT_MS ?? "") || DEFAULT_DISK_LADDER.lightAfterMs,
    evictMergedAfterMs: parseFloat(process.env.DISK_IDLE_EVICT_MERGED_MS ?? "") || DEFAULT_DISK_LADDER.evictMergedAfterMs,
    evictUnmergedAfterMs: parseFloat(process.env.DISK_IDLE_EVICT_MS ?? "") || DEFAULT_DISK_LADDER.evictUnmergedAfterMs,
  };
  assertDiskLadderOrdering(ladder);
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
  // SHI-196 — in-flight guard for the steady-state disk-reclaim pass. It fires
  // from three triggers (startup, per-activation, hourly timer); without this,
  // two passes can race on the same session's tier descent (mirrors the
  // missing-container reconciler's `reconcileInFlight` above). It matters more
  // now the pass also runs the slower steady-state cache sweeps below.
  let escalationInFlight = false;
  const kickDiskEscalation = (excludeSessionId?: string): void => {
    if (isTestMode || !containerManager) return;
    if (escalationInFlight) return;
    escalationInFlight = true;
    void (async () => {
      try {
        await escalateDiskTiers(
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
        // SHI-196 — steady-growth disk reclaim (repo/dep caches, repo-memory,
        // obsolete overlay bases, stale pnpm stores) rides this periodic pass: it
        // grows with the clock, not with a crashed teardown, so it must NOT be
        // boot-only (it used to live in the startup `runDiskJanitor`). Boot
        // coverage is preserved because this same kick fires once at startup.
        // Both calls swallow their own errors and always resolve. SHI-197 — the
        // cache cutoff is the single cold-artifact retention shared with the
        // boot janitor's archived-workspace backstop.
        await runSteadyStateReclaim({
          stateDir,
          repoStore,
          credentialsDir,
          cacheDays: coldArtifactRetentionDays,
          paceMs: escalationPaceMs,
          // Resolved at sweep time (not boot) so each reflects the current session
          // set / runtime; both return an empty/null live-set under the
          // `OVERLAY_DEP_STORE` kill switch, keeping their sweeps inert when off.
          liveOverlayScopeHashes: () =>
            liveOverlayScopeHashes(sessionManager.listAll(), depDirsForSession),
          pnpmStoreRuntimeHash: () =>
            isOverlayEnabled() ? pnpmStoreHash(overlayRuntimeKey()) : null,
        });
      } catch (err) {
        console.error("[disk-janitor] steady-state reclaim pass failed:", err);
      } finally {
        escalationInFlight = false;
      }
    })();
  };
  // Startup safety net: run one pass now so a long-idle tail left by a
  // manually-deployed (rarely-restarted) prod box gets reclaimed even before
  // the first session activation. The per-activation kicks above are the
  // primary steady-state reclaim.
  kickDiskEscalation();

  // ---- Periodic disk-tier escalation (issue #1049) ----
  // The escalation pass is the single steady-state disk-reclaim entry point: the
  // tier ladder (idle node_modules → hot/light/evicted) + its disk-pressure LRU
  // descent, AND — since SHI-196 — the steady-growth cache sweeps
  // (`runSteadyStateReclaim`). All grow with the clock, not with a failed
  // teardown. The startup `runDiskJanitor` failure-recovery sweeps correctly stay
  // startup-only (see the disk-janitor.ts module docstring) because those orphans
  // only appear when teardown crashed, so a timer there would mostly burn cycles.
  //
  // Until now escalation only fired at orchestrator boot and after each session
  // start, which created a self-heal feedback trap: once the disk fills, new
  // session starts FAIL → the per-start kick never fires → the reclaim that
  // would free space never runs. A quiet period with no starts also let idle
  // node_modules sit well past the 24h `hot → light` step unreclaimed. This
  // low-frequency timer makes the age-based reclaim, the disk-pressure check, AND
  // the steady-state cache sweeps run even when the instance is quiet or wedged,
  // independent of session activity. Mirrors `kickDiskEscalation`'s own
  // `!isTestMode && containerManager` no-op guard, so in test mode the interval is
  // never created.
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
