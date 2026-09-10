import type { FastifyInstance } from "fastify";
import { isUnderEvictionPressure, resolveMemoryTargets } from "./memory-pressure.js";
import { resolveDeploymentMode } from "./deployment-mode.js";
import { readDockerMemoryStats } from "./docker-memory.js";
import {
  createMissingContainerReconciler,
  setupContainerHealthMonitoring,
  registerShutdownHook,
} from "./app-lifecycle.js";
import { resolveAgentDockerLimits } from "./session-container.js";
import { runDiskJanitor, runSteadyStateReclaim, pruneSessionVolumes, escalateDiskTiers, statfsFreeBytes, statfsTotalBytes, resolveDiskWatermarks, COLD_ARTIFACT_RETENTION_DAYS } from "./disk-janitor.js";
import { isOverlayEnabled, overlayRuntimeKey, pnpmStoreHash } from "./overlay-session.js";
import { overlayLiveScopeSource, pluginLiveArtifactSource } from "./disk-liveness-sources.js";
import { DEFAULT_DISK_LADDER, assertDiskLadderOrdering, type DiskLadderThresholds } from "./sessions.js";
import type { OrchestratorRuntime } from "./bootstrap-managers.js";
import { createKeepPreviewRestartSupervisor, restoreReservedPreviews } from "./keep-preview-running.js";
import { downComposeStackByProject, reapSurvivingComposeStacks } from "./compose-stack-reaper.js";
import { liveWorkAfterRestart, unprobedAfterRestart } from "./restart-turn-reattach.js";
import { serializeStackOp } from "./stack-op-queue.js";
import { startWarmTierSweep } from "./warm-tier-sweep.js";
import { stopWarmPreview } from "./warm-preview.js";

export interface StartupMonitors {
  kickDiskEscalation: (excludeSessionId?: string) => void;
}

export async function startStartupMonitors(
  app: FastifyInstance,
  rt: OrchestratorRuntime,
): Promise<StartupMonitors> {
  const {
    dockerForStats, latestMemoryStats, sseBroadcast, enforceIdleContainerLimit,
    containerManager, runnerRegistry, broadcastLog, sessionManager,
    credentialStore,
    isTestMode, stateDir, repoStore, credentialsDir, githubAuthManager,
    createRepoGit, getBareCacheDir, serviceManagers, composeStopPromises, createGitManager,
    loopDetector, oomBreaker, chatHistoryManager,
    repoPrefetcher, claudeOAuthRefresherRef, codexOAuthRefresherRef,
    startupTimer, authManagers, dockerProxyServer, databaseManager,
    mergeWatchManager, autoPushScheduler, agentMergeExecutor,
  } = rt;

  const deployment = resolveDeploymentMode();
  // Docker reads can outlast the interval; overlapping reads publish stale snapshots.
  let memoryReadInFlight = false;
  const pollMemory = async (): Promise<void> => {
    if (memoryReadInFlight) return;
    memoryReadInFlight = true;
    try {
      const raw = await readDockerMemoryStats(dockerForStats!);
      if (!raw) return;
      // The client and enforcer consume the same resolved budget.
      const stats = {
        ...raw,
        ...resolveMemoryTargets(raw.totalBytes, credentialStore.getMemoryBudgetMb(), deployment),
      };
      const wasUnderPressure = isUnderEvictionPressure(latestMemoryStats.value);
      latestMemoryStats.value = stats;
      sseBroadcast("docker_memory", stats);
      const nowUnderPressure = isUnderEvictionPressure(stats);
      if (nowUnderPressure && !wasUnderPressure) {
        try { enforceIdleContainerLimit(); }
        catch (err) { console.error("[memory-pressure] immediate eviction failed:", err); }
      }
    } finally {
      memoryReadInFlight = false;
    }
  };
  // Seed pressure data before the first timer tick without blocking boot on Docker.
  if (dockerForStats) void pollMemory().catch(() => {});
  const memoryStatsInterval = dockerForStats
    ? setInterval(() => { void pollMemory().catch(() => {}); }, 10_000)
    : null;

  // Enforcement is independent of WebSocket activity.
  const reconcileMissingContainers = containerManager
    ? createMissingContainerReconciler({
        containerManager,
        runnerRegistry,
        broadcastLog,
        chatHistoryManager,
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
  // Concurrent reconciliation could race disposal against adoption of the same runner.
  let reconcileInFlight = false;
  const idleEnforcementInterval = containerManager ? setInterval(() => {
    try {
      enforceIdleContainerLimit();
    } catch (err) {
      console.error("[idle-cleanup] periodic enforcement failed:", err);
    }
    if (reconcileMissingContainers && !reconcileInFlight) {
      reconcileInFlight = true;
      void reconcileMissingContainers()
        .catch((err: unknown) => {
          console.error("[orphan-runner] periodic reconciliation failed:", err);
        })
        .finally(() => { reconcileInFlight = false; });
    }
  }, 30_000) : null;
  if (idleEnforcementInterval && typeof idleEnforcementInterval.unref === "function") {
    idleEnforcementInterval.unref();
  }

  // Standbys have no runner, so missing-container reconciliation cannot repair them.
  const warmSweepInterval = containerManager && !isTestMode
    ? startWarmTierSweep({
        repoStore, sessionManager, containerManager,
        warmSessionForRepo: rt.warmSessionForRepo,
        ensureStandbyForWarmSession: rt.ensureStandbyForWarmSession,
        waitForWarmSession: rt.waitForWarmSession,
        stopPreview: (sessionId: string) => stopWarmPreview(serviceManagers, sessionId, composeStopPromises),
        ...(rt.preStartWarmPreview ? { repairPreview: rt.preStartWarmPreview } : {}),
        getMemoryStats: () => latestMemoryStats.value,
      })
    : null;

  const coldArtifactRetentionRaw = parseFloat(process.env.DISK_JANITOR_COLD_ARTIFACT_RETENTION_DAYS ?? "");
  const coldArtifactRetentionDays = Number.isFinite(coldArtifactRetentionRaw)
    ? coldArtifactRetentionRaw
    : COLD_ARTIFACT_RETENTION_DAYS;
  if (!isTestMode) {
    const janitorPaceMs = parseFloat(process.env.DISK_JANITOR_PACE_MS ?? "");
    // Recover failed teardown at boot; ongoing cache growth is handled below.
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
      ...(containerManager ? { docker: containerManager.dockerClient } : {}),
    });
  }

  const ladder: DiskLadderThresholds = {
    lightAfterMs: parseFloat(process.env.DISK_IDLE_LIGHT_MS ?? "") || DEFAULT_DISK_LADDER.lightAfterMs,
    evictMergedAfterMs: parseFloat(process.env.DISK_IDLE_EVICT_MERGED_MS ?? "") || DEFAULT_DISK_LADDER.evictMergedAfterMs,
    evictUnmergedAfterMs: parseFloat(process.env.DISK_IDLE_EVICT_MS ?? "") || DEFAULT_DISK_LADDER.evictUnmergedAfterMs,
  };
  assertDiskLadderOrdering(ladder);
  const escalationPaceMsRaw = parseFloat(process.env.DISK_ESCALATION_PACE_MS ?? "");
  const escalationPaceMs = Number.isFinite(escalationPaceMsRaw) ? escalationPaceMsRaw : 500;
  const diskTotalBytes = isTestMode ? null : await statfsTotalBytes(stateDir);
  const { diskFreeLow, diskFreeHigh } = resolveDiskWatermarks({
    lowBytes: parseFloat(process.env.DISK_FREE_LOW_BYTES ?? "") || undefined,
    highBytes: parseFloat(process.env.DISK_FREE_HIGH_BYTES ?? "") || undefined,
    lowPct: parseFloat(process.env.DISK_FREE_LOW_PCT ?? "") || undefined,
    highPct: parseFloat(process.env.DISK_FREE_HIGH_PCT ?? "") || undefined,
    totalBytes: diskTotalBytes,
  });
  if (!isTestMode && (diskFreeLow === undefined || diskFreeHigh === undefined)) {
    console.warn(
      "[disk-janitor] disk-pressure eviction is DISABLED — set DISK_FREE_LOW_PCT/DISK_FREE_HIGH_PCT "
      + "(or DISK_FREE_LOW_BYTES/DISK_FREE_HIGH_BYTES) to enable the under-pressure LRU descent. "
      + "Age-based tier escalation still runs.",
    );
  }
  // Startup, activation, and hourly triggers share this guard.
  let escalationInFlight = false;
  const notifiedEvictBlocked = new Set<string>();
  const evictStuckLog = new Map<string, string>();
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
            // Find stacks from earlier processes and serialize teardown with concurrent starts.
            stopComposeStack: (sid) => serializeStackOp(
              sid, () => downComposeStackByProject(containerManager.dockerClient, sid),
            ),
            createGitManager,
            ladder,
            chatHistory: chatHistoryManager,
            notifiedEvictBlocked,
            evictStuckLog,
            paceMs: escalationPaceMs,
            diskFreeLow,
            diskFreeHigh,
            getFreeDiskBytes: () => statfsFreeBytes(stateDir),
          },
          excludeSessionId,
        );
        await runSteadyStateReclaim({
          stateDir,
          repoStore,
          credentialsDir,
          cacheDays: coldArtifactRetentionDays,
          paceMs: escalationPaceMs,
          // Resolve live mounts at sweep time, not from a boot snapshot.
          liveOverlayScopeHashes: overlayLiveScopeSource(sessionManager),
          livePluginStoreArtifacts: pluginLiveArtifactSource(sessionManager),
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
  kickDiskEscalation();

  // Reclaim must still run when a full disk prevents new session activations.
  const diskEscalationIntervalMs = parseFloat(process.env.DISK_ESCALATION_INTERVAL_MS ?? "")
    || 3_600_000;
  const diskEscalationInterval = (!isTestMode && containerManager)
    ? setInterval(() => { kickDiskEscalation(); }, diskEscalationIntervalMs)
    : null;
  if (diskEscalationInterval && typeof diskEscalationInterval.unref === "function") {
    diskEscalationInterval.unref();
  }

  if (containerManager) {
    const keepPreviewSupervisor = createKeepPreviewRestartSupervisor({
      sessionManager,
      runnerRegistry,
      containerManager,
      defaultAgentId: rt.defaultAgentId,
      broadcastLog,
    });
    const restored = restoreReservedPreviews({
      sessionManager,
      runnerRegistry,
      containerManager,
      defaultAgentId: rt.defaultAgentId,
      broadcastLog,
    });
    if (restored.length > 0) {
      console.log(`[keep-preview] Restoring ${restored.length} reserved preview runtime(s)`);
    }
    // Reap only after turn reattachment and preview restoration have registered their runners.
    if (!isTestMode) {
      void (async () => {
        const reaped = await reapSurvivingComposeStacks({
          docker: containerManager.dockerClient,
          sessionManager,
          runnerRegistry,
          serviceManagers,
          unprobed: unprobedAfterRestart,
          liveWork: liveWorkAfterRestart,
          paceMs: 500,
        });
        if (reaped > 0) {
          console.log(`[compose-reap] Took down ${reaped} compose stack(s) left by a previous orchestrator`);
        }
      })();
    }
    setupContainerHealthMonitoring(
      containerManager,
      runnerRegistry,
      broadcastLog,
      loopDetector,
      oomBreaker,
      chatHistoryManager,
      keepPreviewSupervisor.handleUnexpectedExit,
    );
    app.addHook("onClose", async () => keepPreviewSupervisor.dispose());
  }

  app.addHook("onClose", async () => {
    // Stop timers before shutdown closes the database they query.
    agentMergeExecutor.stop();
    if (memoryStatsInterval) clearInterval(memoryStatsInterval);
    if (idleEnforcementInterval) clearInterval(idleEnforcementInterval);
    if (diskEscalationInterval) clearInterval(diskEscalationInterval);
    if (warmSweepInterval) clearInterval(warmSweepInterval);
    if (repoPrefetcher) repoPrefetcher.stop();
    claudeOAuthRefresherRef.ref?.stop();
    codexOAuthRefresherRef.ref?.stop();
    mergeWatchManager?.stopRetryLoop();
  });
  registerShutdownHook(app, {
    startupTimer, authManagers, runnerRegistry, autoPushScheduler,
    dockerProxyServer, containerManager, databaseManager, serviceManagers,
  });

  return { kickDiskEscalation };
}
