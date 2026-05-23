import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { UsageManager } from "./usage.js";
import type { SessionContainerManager } from "./session-container.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { CredentialStore } from "./credential-store.js";
import type { WsLogEntry } from "../shared/types.js";
import type { SessionLoopDetector } from "./loop-detector.js";
import type { SessionOomCircuitBreaker } from "./oom-circuit-breaker.js";
import { createSessionLoopDetector } from "./loop-detector.js";
import { deleteSession } from "./services/session.js";
import { refreshExpiredMcpOAuthTokens } from "./services/mcp-oauth.js";
import { getErrorMessage } from "./validation.js";

// ---- Migration + startup ----

/** Dependencies for startup tasks. */
export interface StartupDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  chatHistoryManager: ChatHistoryManager;
  usageManager: UsageManager;
  containerManager: SessionContainerManager | null;
  getBareCacheDir: (repoUrl: string) => string;
  warmSessionForRepo: (repoUrl: string) => Promise<void>;
  /**
   * Optional — when provided, triggers a one-shot MCP OAuth token refresh
   * sweep at startup (docs/088 Phase 2 follow-up). Tokens whose `expiresAt`
   * is within the 5-minute safety margin are refreshed proactively so the
   * first agent turn after a restart doesn't fail on a stale token.
   *
   * Optional rather than required so existing tests that don't exercise the
   * OAuth surface don't have to thread a `CredentialStore` through.
   */
  credentialStore?: CredentialStore;
}

/**
 * Run repo store migration (derive from existing sessions) and return
 * the list of migrated URLs.
 */
export async function runRepoMigration(
  migrationDeps: { repoStore: RepoStore; sessionManager: SessionManager; getSharedRepoDir: (repoUrl: string) => string },
): Promise<string[]> {
  const { repoStore, sessionManager, getSharedRepoDir } = migrationDeps;
  const migratedRepoUrls: string[] = [];

  if (repoStore.list().length === 0) {
    const allSessions = sessionManager.list();
    const seenUrls = new Set<string>();
    for (const session of allSessions) {
      if (session.remoteUrl && !seenUrls.has(session.remoteUrl)) {
        seenUrls.add(session.remoteUrl);
        const repoDir = getSharedRepoDir(session.remoteUrl);
        // eslint-disable-next-line no-restricted-syntax -- stat existence-check idiom
        const exists = await fs.stat(repoDir).then(() => true, () => false);
        if (exists) {
          repoStore.add(session.remoteUrl);
          repoStore.setReady(session.remoteUrl);
          migratedRepoUrls.push(session.remoteUrl);
          console.log(`[migration] Added repo from session: ${session.remoteUrl}`);
        }
      }
    }
  }

  return migratedRepoUrls;
}

/**
 * docs/088 Phase 2 follow-up: refresh any MCP OAuth tokens whose access
 * tokens are within the safety margin of expiry.
 *
 * The per-turn refresh path in `ws-handlers/agent-execution.ts` covers
 * active sessions, but a long-idle session whose token expired while the
 * orchestrator was down would otherwise carry the stale token into the
 * first turn after restart — the worker would emit a `needs-auth` failure
 * on the next MCP tool call. The startup sweep closes that gap.
 *
 * Fault-tolerant by design: any failures are logged and leave the stale
 * token in place so the worker still surfaces a meaningful
 * `mcp_server_status` failure on use rather than silently dropping the
 * server. Exported so `app-lifecycle.test.ts` can exercise it directly
 * without spinning up the rest of `scheduleStartupTasks`.
 */
export async function runMcpOAuthStartupRefresh(opts: {
  credentialStore: CredentialStore;
  /** Injectable for tests; defaults to global `fetch` via the service. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const result = await refreshExpiredMcpOAuthTokens({
      credentialStore: opts.credentialStore,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (result.refreshed.length > 0) {
      console.log(
        `[mcp-oauth] startup refresh rotated ${result.refreshed.length} token(s): ${result.refreshed.join(", ")}`,
      );
    }
    if (result.failed.length > 0) {
      const details = result.failed.map((f) => `${f.source} (${f.error})`).join(", ");
      console.warn(
        `[mcp-oauth] startup refresh failed for ${result.failed.length} source(s): ${details}`,
      );
    }
  } catch (err) {
    console.warn("[mcp-oauth] startup refresh sweep failed:", getErrorMessage(err));
  }
}

/**
 * Schedule startup tasks: validate warm sessions, re-warm missing, clean up zombies.
 * Returns the timer handle so it can be cleared on shutdown.
 */
export function scheduleStartupTasks(
  startupDeps: StartupDeps,
  migratedRepoUrls: string[],
): ReturnType<typeof setTimeout> {
  const {
    repoStore, sessionManager, chatHistoryManager, usageManager,
    containerManager, warmSessionForRepo, credentialStore,
  } = startupDeps;

  // docs/088 Phase 2 follow-up: refresh any MCP OAuth tokens whose access
  // tokens are within the safety margin of expiry. Fire-and-forget — the
  // returned promise is for tests only.
  if (credentialStore) {
    void runMcpOAuthStartupRefresh({ credentialStore });
  }

  return setTimeout(() => {
    // Collect current warm session IDs so we can clean up zombies.
    const activeWarmIds = new Set<string>();
    for (const repo of repoStore.list()) {
      if (repo.warmSessionId) activeWarmIds.add(repo.warmSessionId);
    }

    // Delete zombie warm sessions — previously-claimed warm sessions that were
    // never graduated (user clicked "New Session" but never sent a message).
    // Without this, `findUngraduatedWarm()` returns these zombies instead of
    // claiming from the warm pool, preventing re-warming + standby.
    // Also cleans up already-unflagged zombies (title "Warm session", no messages).
    let zombieCount = 0;
    for (const id of sessionManager.allIds()) {
      if (activeWarmIds.has(id)) continue;
      const s = sessionManager.get(id);
      if (s?.warm || (s?.title === "Warm session" && !s.archived)) {
        deleteSession(sessionManager, id, chatHistoryManager, usageManager);
        zombieCount++;
      }
    }
    if (zombieCount > 0) {
      console.log(`[warm] Deleted ${zombieCount} stale ungraduated warm session(s)`);
    }

    for (const repo of repoStore.list()) {
      if (repo.warmSessionId && repo.status === "ready") {
        const ws = sessionManager.get(repo.warmSessionId);
        if (!ws?.workspaceDir || !existsSync(ws.workspaceDir)) {
          console.log(`[warm] Stale warm session ${repo.warmSessionId} — clone missing, re-warming`);
          if (containerManager?.isStandby(repo.warmSessionId)) {
            containerManager.destroy(repo.warmSessionId).catch((err: unknown) => {
              console.error(`[warm] Failed to destroy stale standby:`, getErrorMessage(err));
            });
          }
          repoStore.setWarmSessionId(repo.url, undefined);
          void warmSessionForRepo(repo.url);
        } else {
          console.log(`[warm] Warm session ${repo.warmSessionId} validated (clone exists)`);
        }
      }
    }
    // Re-warm repos that have no warm session at all (+ migrated repos).
    for (const url of migratedRepoUrls) {
      void warmSessionForRepo(url);
    }
    for (const repo of repoStore.list()) {
      if (!repo.warmSessionId && repo.status === "ready"
          && !migratedRepoUrls.includes(repo.url)) {
        void warmSessionForRepo(repo.url);
      }
    }
  }, 0);
}

// ---- Container health monitoring ----

/**
 * Handle a `container_exited` event for the agent container. Extracted from
 * the inline subscriber in `setupContainerHealthMonitoring` so tests can
 * exercise the wiring without spinning up Docker.
 *
 * Writes a breadcrumb to the per-session log ring BEFORE disposing the
 * runner. `runner.emitMessage` buffers into the turn-event log which is
 * discarded on dispose, and `console.error` doesn't surface in the
 * diagnostics endpoint — so without `broadcastLog`, the diagnostic
 * snapshot 70 minutes later shows only "Agent process started" and no
 * trace of the failure.
 */
export function handleContainerExited(
  sessionId: string,
  exitCode: number | undefined,
  error: string | undefined,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
): void {
  console.error(`[container] Session ${sessionId} container exited: ${error ?? "unknown"}`);
  const exitDetail = error
    ? `: ${error}`
    : exitCode !== undefined && exitCode !== 0
      ? ` (exit ${exitCode}${exitCode === 137 ? ", likely OOMKilled" : ""})`
      : "";
  if (broadcastLog) {
    broadcastLog(sessionId, "server", `Session container exited unexpectedly${exitDetail}.`);
  }
  const runner = runnerRegistry.get(sessionId);
  if (runner) {
    runner.emitMessage({
      type: "session_status",
      sessionId,
      running: false,
      error: `Session container exited unexpectedly${exitDetail}`,
    });
    // Forced — the underlying container is gone, so the agent process is
    // already dead. We must tear down the runner to release resources.
    runner.dispose({ force: true });
  }
}

/**
 * Wire container health monitoring — notify viewers and clean up when
 * a container dies unexpectedly (OOM, crash).
 */
export function setupContainerHealthMonitoring(
  containerManager: SessionContainerManager,
  runnerRegistry: SessionRunnerRegistry,
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
  loopDetector: SessionLoopDetector = createSessionLoopDetector(),
  oomBreaker?: SessionOomCircuitBreaker,
): void {
  // Shared "breaker just tripped" emission — sends the WS message to
  // attached viewers and the per-session log ring + journalctl line.
  // Idempotent: `trip.justTripped` is true exactly once, so a duplicate
  // call (e.g. exit + loop alert in the same window) no-ops cleanly.
  const emitBreakerTrip = (
    trip: { justTripped: boolean; countInWindow: number; windowMs: number; threshold: number },
    sessionId: string,
    summary: string,
  ): void => {
    if (!trip.justTripped) return;
    const msg = `Session disabled — ${summary}. Increase \`agent.memory\` in shipit.yaml and use "Rescue session" to retry.`;
    console.error(`[oom-breaker] ${msg} (session=${sessionId})`);
    if (broadcastLog) broadcastLog(sessionId, "server", msg);
    const runner = runnerRegistry.get(sessionId);
    runner?.emitMessage({
      type: "session_memory_exhausted",
      sessionId,
      countInWindow: trip.countInWindow,
      windowMs: trip.windowMs,
      threshold: trip.threshold,
    });
  };

  containerManager.on("container_exited", (sessionId, exitCode, error) => {
    // Record agent-container OOM kills BEFORE disposing the runner — the
    // dispose tears down the WS channel, so a `session_memory_exhausted`
    // emit afterwards never reaches attached viewers.
    //
    // Two signals trigger the OOM count, because Docker is unreliable
    // here:
    //   1. error === "Out of memory" — `container-health.ts` set this
    //      from a Docker `oom` event.
    //   2. exitCode === 137 — the cgroup OOM-killer's SIGKILL signature.
    //      Docker emits both `oom` and `die` on an OOM, but event
    //      ordering is daemon-dependent; with cgroup v2 the `oom`
    //      event is sometimes not emitted at all. When `die` arrives
    //      first our handler deletes the container from the map and
    //      the subsequent `oom` event hits the "container not found"
    //      early-out, losing the OOM signal. 137 with no other emitter
    //      means an external SIGKILL, which inside a memory-limited
    //      cgroup is overwhelmingly the kernel OOM-killer.
    //
    // Compose-child OOMs go through the `service_exited` path and are
    // not the breaker's concern.
    if (oomBreaker && (error === "Out of memory" || exitCode === 137)) {
      const trip = oomBreaker.recordOom(sessionId);
      const windowLabel = `${Math.round(trip.windowMs / 1000)}s`;
      emitBreakerTrip(
        trip,
        sessionId,
        `agent container OOM-killed ${trip.countInWindow} times in last ${windowLabel}`,
      );
    }
    handleContainerExited(sessionId, exitCode, error, runnerRegistry, broadcastLog);
  });

  // SIGTERM/recreate loop detector. Field reports show occasional
  // intermittent loops where the same session's container is destroyed
  // and recreated every 30-60s for many minutes. The loop is hard to
  // investigate because it's not reproducible and often clears after
  // an orchestrator restart. We emit a uniquely greppable
  // `LOOP DETECTED` line on both console and the per-session log ring
  // so post-hoc journalctl grep can confirm whether the loop occurred,
  // even after a restart.
  //
  // Belt-and-suspenders for the breaker: if the loop is happening but
  // individual exits aren't reaching the breaker as OOMs (event
  // ordering, exit code 0 from a SIGTERM-handler, etc.), `forceTrip`
  // catches it. After this trips, the runner factory refuses the next
  // create — the loop stops even when no signal cleanly identifies the
  // failure mode.
  containerManager.on("container_started", (sessionId) => {
    const alert = loopDetector.recordContainerStarted(sessionId);
    if (!alert) return;
    const windowLabel = `${Math.round(alert.windowMs / 1000)}s`;
    const msg = `LOOP DETECTED: session ${sessionId} container created ${alert.countInWindow} times in last ${windowLabel} (threshold ${alert.threshold}).`;
    console.error(`[loop-detector] ${msg}`);
    if (broadcastLog) {
      broadcastLog(
        sessionId,
        "server",
        `${msg} Orchestrator is in a destroy/recreate loop — check journalctl for destroyContainer/dispose stack traces around this timestamp.`,
      );
    }
    if (oomBreaker) {
      const trip = oomBreaker.forceTrip(sessionId);
      emitBreakerTrip(
        trip,
        sessionId,
        `${alert.countInWindow} container creation attempts in last ${windowLabel}`,
      );
    }
  });

  // Docker events stream reconnected after a gap. Any die/oom events
  // during the gap were lost — leave a breadcrumb on every active
  // session so anyone diagnosing a "container vanished" report can see
  // the window when events may have been missed. We log to every
  // session because the gap isn't attributable to a specific one.
  containerManager.on("health_monitor_resumed", ({ gapMs }) => {
    const gapLabel = gapMs >= 1000 ? `${Math.round(gapMs / 1000)}s` : `${gapMs}ms`;
    console.warn(`[container-health] Docker events stream resumed after ${gapLabel} gap`);
    if (!broadcastLog) return;
    for (const sc of containerManager.getAll()) {
      broadcastLog(
        sc.sessionId,
        "server",
        `Docker events stream resumed after ${gapLabel} gap — die/oom events during this window may have been missed.`,
      );
    }
  });

  /**
   * Compose-child exit (user service crashed or OOM-killed). Emit a
   * `service_oom` runner message when OOM, and always log to the per-session
   * Logs panel + ring buffer so the user sees the failure immediately
   * instead of waiting ~5 s for `pollStatus` to flip the service to
   * `error` with a generic "Exited with code N" message.
   *
   * We intentionally do NOT touch the runner's lifecycle here — the agent
   * container is fine; only one of its compose siblings died. The
   * ServiceManager's own `pollStatus` handles the status flip and (where
   * applicable) retry-during-install backoff. Our job is just visibility.
   * See docs/124-session-rescue-and-diagnostics §1.2.
   */
  containerManager.on("service_exited", (sessionId, info) => {
    const svcName = info.serviceName ?? "service";
    if (info.oom) {
      console.warn(
        `[container] Session ${sessionId} compose ${svcName} OOM-killed (container=${info.containerId}, exit=${info.exitCode})`,
      );
    } else {
      console.log(
        `[container] Session ${sessionId} compose ${svcName} exited (container=${info.containerId}, exit=${info.exitCode})`,
      );
    }
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    if (info.oom) {
      runner.emitMessage({
        type: "service_oom",
        sessionId,
        ...(info.serviceName ? { serviceName: info.serviceName } : {}),
        containerId: info.containerId,
      });
    }
    const logText = info.oom
      ? `[compose] ${svcName} was OOM-killed (exit ${info.exitCode}). Increase memory limits in docker-compose.yml or reduce service workload.`
      : `[compose] ${svcName} exited with code ${info.exitCode}.`;
    if (broadcastLog) broadcastLog(sessionId, "server", logText);
    runner.emitMessage({
      type: "log_entry",
      source: "server",
      text: logText,
      timestamp: new Date().toISOString(),
    });
  });
}
