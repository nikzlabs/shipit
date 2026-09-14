import fs from "node:fs";
import path from "node:path";
import type { SessionContainer, SessionContainerManager } from "./session-container.js";
import { SESSION_WORKSPACE_SUBDIR, sessionStateDir } from "./session-state-dir.js";
import { allocateAndSealSessionDir } from "./session-uid-allocator.js";
import { chownTreeToSessionWorker } from "./session-worker-uid.js";
import { subAgentSpawnHomeContainerDir } from "./session-credentials.js";
import { workerPost } from "./worker-http.js";
import { getContainerFreshness } from "./container-freshness.js";
import { getErrorMessage } from "./validation.js";
import { CLEANUP_CONTAINER_SESSION_ID } from "./shipit-own-sessions.js";
import type { SubAgentRunResult } from "../shared/sub-agent-run.js";
import {
  BACKGROUND_HARNESS_MAX_OUTPUT_CHARS,
  BACKGROUND_HARNESS_TIMEOUT_MS,
  failedRun,
  refuseIfToolsStayOn,
  withSpawnHome,
  type BackgroundHarnessRun,
  type BackgroundHarnessRunner,
} from "./background-harness-run.js";

export { CLEANUP_CONTAINER_SESSION_ID };

/**
 * Caps create attempts. A container that dies immediately would otherwise be
 * recreated immediately, and the loop detector deliberately ignores this
 * container, so nothing else would notice.
 */
export const CREATE_INTERVAL_MS = 15_000;

export const MAX_REVIVE_ATTEMPTS = 5;

/** Lets the worker's own timer settle a slow run before the socket gives up. */
const SPAWN_TRANSPORT_HEADROOM_MS = 10_000;

export interface CleanupContainerDeps {
  containerManager: SessionContainerManager;
  /** Parent of the per-session directories; the reserved id gets one of its own. */
  sessionsRoot: string;
  credentialsDir: string;
  now?: () => number;
  /** Overrides the wait before a retry; tests pace it without a real interval. */
  retryDelayMs?: number;
}

/**
 * One container per install, holding no repository and no resident harness
 * process (docs/299 req 8). It is never stopped, so a sweep that treats an id
 * the session store has never heard of as abandoned takes it; those sweeps ask
 * `isShipItOwnSession` (`shipit-own-sessions.ts`) instead.
 *
 * It talks to the worker directly rather than through `spawnSubAgent`, which
 * lives on a session runner this container does not have.
 */
export class CleanupContainerManager implements BackgroundHarnessRunner {
  private ensuring: Promise<SessionContainer | null> | null = null;
  private nextAttemptAt = 0;
  private consecutiveFailures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastFailure: string | null = null;
  private stopped = false;
  private readonly onContainerExited: (sessionId: string) => void;
  private readonly onHealthMonitorResumed: () => void;

  constructor(private readonly deps: CleanupContainerDeps) {
    this.onContainerExited = (sessionId: string): void => {
      if (sessionId !== CLEANUP_CONTAINER_SESSION_ID || this.stopped) return;
      console.warn("[cleanup-container] container exited — recreating");
      this.noteContainerGone();
    };
    // A `die` lost to an event-stream gap is otherwise noticed only by a
    // dictation failing, so the first user back after the gap gets no cleanup.
    this.onHealthMonitorResumed = (): void => {
      if (this.stopped) return;
      const sc = this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID);
      if (sc) void this.forgetIfGone(sc);
    };
  }

  /** Create the container now and keep recreating it when its container dies. */
  async start(): Promise<void> {
    this.deps.containerManager.on("container_exited", this.onContainerExited);
    this.deps.containerManager.on("health_monitor_resumed", this.onHealthMonitorResumed);
    await this.ensure().catch(() => { /* ensure() records its own failure */ });
    if (!this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID)) this.reviveSoon();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deps.containerManager.off("container_exited", this.onContainerExited);
    this.deps.containerManager.off("health_monitor_resumed", this.onHealthMonitorResumed);
  }

  /**
   * The one path from "the container is gone" to a recreate. A `die` event and
   * the liveness check that catches a missed one both land here, so recovery
   * cannot depend on which of the two noticed it.
   *
   * `retryNow` is for the liveness check: the death time is unknown, so the
   * remaining create interval says nothing and must not delay the recreate.
   */
  private noteContainerGone(opts?: { retryNow: boolean }): void {
    if (this.stopped) return;
    // Dying inside the create interval counts against the cap in reviveSoon;
    // without that a crash loop recreates for ever, since nothing else watches
    // this id.
    if ((this.deps.now?.() ?? Date.now()) < this.nextAttemptAt) this.consecutiveFailures += 1;
    if (opts?.retryNow) this.nextAttemptAt = 0;
    this.reviveSoon();
  }

  /**
   * Keep trying, because req 8 is about the container being up *before* the next
   * dictation — leaving it to the next request is exactly the container start
   * the requirement forbids. Capped so a host that cannot start containers at
   * all stops retrying and lets the next request report the real reason.
   */
  private reviveSoon(): void {
    if (this.stopped || this.retryTimer) return;
    if (this.consecutiveFailures >= MAX_REVIVE_ATTEMPTS) {
      console.error(
        `[cleanup-container] giving up after ${this.consecutiveFailures} failed starts; `
        + "the next cleanup request will try again and report why",
      );
      return;
    }
    const delay = this.deps.retryDelayMs
      ?? Math.max(0, this.nextAttemptAt - (this.deps.now?.() ?? Date.now()));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void (async () => {
        try {
          if (!await this.ensure()) this.reviveSoon();
        } catch {
          this.reviveSoon();
        }
      })();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Null means the container is unavailable right now, with the reason logged. */
  async ensure(): Promise<SessionContainer | null> {
    // Join an acquisition already under way rather than reading the tracked
    // entry: adoption publishes a container before its build is checked, so a
    // caller reading that entry can be handed one this manager is replacing.
    if (this.ensuring) return this.ensuring;
    const existing = this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID);
    if (existing?.status === "running") {
      // Surviving to be found running is what clears the cap. Clearing it on a
      // successful create instead would reset on every turn of a crash loop.
      this.consecutiveFailures = 0;
      return existing;
    }
    this.ensuring ??= this.acquire().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async acquire(): Promise<SessionContainer | null> {
    return await this.adoptSurvivor() ?? this.create();
  }

  /**
   * Nothing else adopts this container: `rediscoverContainers` walks the session
   * store, which has no row for its id. Without this, `create()` rebuilds a
   * survivor — it force-removes whatever holds the container name — and the
   * first dictation after a restart pays the start req 8 forbids.
   *
   * Only an exact build match is adopted, because this container is never
   * stopped: anything else would carry another orchestrator's worker, and the
   * configuration it was created with, for the life of the install.
   */
  private async adoptSurvivor(): Promise<SessionContainer | null> {
    try {
      const workspaceDir = path.join(
        this.deps.sessionsRoot, CLEANUP_CONTAINER_SESSION_ID, SESSION_WORKSPACE_SUBDIR,
      );
      const adopted = await this.deps.containerManager.adoptRunningContainer(
        CLEANUP_CONTAINER_SESSION_ID,
        () => ({ workspaceDir, dockerAccess: false }),
      );
      if (!adopted) return null;
      const sc = this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID);
      if (!sc) return null;
      if (getContainerFreshness(sc.workerBuildId, process.env.SHIPIT_BUILD_ID).state !== "current") {
        console.log("[cleanup-container] replacing a container this orchestrator did not build");
        await this.deps.containerManager.destroy(
          CLEANUP_CONTAINER_SESSION_ID, { replacementFollows: true },
        );
        return null;
      }
      console.log(`[cleanup-container] adopted the running container at ${sc.workerUrl}`);
      this.lastFailure = null;
      return sc;
    } catch (err) {
      console.warn("[cleanup-container] could not adopt a running container:", getErrorMessage(err));
      return null;
    }
  }

  private async create(): Promise<SessionContainer | null> {
    const now = this.deps.now?.() ?? Date.now();
    if (now < this.nextAttemptAt) return null;
    this.nextAttemptAt = now + CREATE_INTERVAL_MS;
    try {
      const sessionDir = path.join(this.deps.sessionsRoot, CLEANUP_CONTAINER_SESSION_ID);
      const workspaceDir = path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(sessionStateDir(sessionDir), { recursive: true });
      // Ownership before content, exactly as a session directory is built.
      if (allocateAndSealSessionDir(sessionDir) !== null) chownTreeToSessionWorker(sessionDir);

      // A stale entry from a previous container blocks create(); clear it first.
      if (this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID)) {
        await this.deps.containerManager.destroy(CLEANUP_CONTAINER_SESSION_ID, { replacementFollows: true });
      }
      const config = this.deps.containerManager.buildConfig({
        sessionId: CLEANUP_CONTAINER_SESSION_ID,
        sessionDir,
        workspaceDir,
        credentialsDir: this.deps.credentialsDir,
      });
      const sc = await this.deps.containerManager.create(config);
      this.lastFailure = null;
      console.log(`[cleanup-container] ready at ${sc.workerUrl}`);
      return sc;
    } catch (err) {
      this.lastFailure = getErrorMessage(err);
      this.consecutiveFailures += 1;
      console.error("[cleanup-container] could not start:", this.lastFailure);
      return null;
    }
  }

  async run(req: BackgroundHarnessRun): Promise<SubAgentRunResult> {
    const startedAt = Date.now();
    if (req.signal?.aborted) {
      return failedRun("The cleanup run was abandoned before it started.", startedAt);
    }
    // Before ensure(), so an unusable harness never starts a container for a run
    // that cannot happen.
    const refusal = refuseIfToolsStayOn(req.harnessId, startedAt);
    if (refusal) return refusal;
    const sc = await this.ensure();
    if (!sc) {
      return failedRun(
        this.lastFailure
          ? `The cleanup container is not running: ${this.lastFailure}`
          : "The cleanup container is not running.",
        startedAt,
      );
    }
    // An abort event is not replayed, so a signal that fired while ensure() was
    // awaited would otherwise reach the listener below already spent.
    if (req.signal?.aborted) {
      return failedRun("The cleanup run was abandoned before it started.", startedAt);
    }
    try {
      return await withSpawnHome(
        this.deps.credentialsDir,
        CLEANUP_CONTAINER_SESSION_ID,
        req.harnessId,
        req.accountId,
        async (spawnId) => this.spawn(sc, spawnId, req, startedAt),
      );
    } catch (err) {
      return failedRun(getErrorMessage(err), startedAt);
    }
  }

  private async spawn(
    sc: SessionContainer,
    spawnId: string,
    req: BackgroundHarnessRun,
    startedAt: number,
  ): Promise<SubAgentRunResult> {
    const timeoutMs = req.timeoutMs ?? BACKGROUND_HARNESS_TIMEOUT_MS;
    // Abandoning the run cancels it by spawn id, disturbing no other request in
    // this shared container. The transport is deliberately NOT aborted: the
    // caller's own deadline is what returns early, and this request must keep
    // waiting so the spawn home is released only once the CLI has actually gone.
    const onAbort = (): void => { void this.cancelSpawn(sc, spawnId); };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await workerPost(
        sc.workerUrl,
        "/agent/spawn",
        {
          agentId: req.harnessId,
          prompt: req.prompt,
          spawnId,
          depth: 0,
          model: req.model,
          homeDir: subAgentSpawnHomeContainerDir(spawnId),
          toolsOff: true,
          maxOutputChars: req.maxOutputChars ?? BACKGROUND_HARNESS_MAX_OUTPUT_CHARS,
          timeoutMs,
          ...(req.serviceRouting !== undefined ? { serviceRouting: req.serviceRouting } : {}),
          ...(req.credentialSecret !== undefined ? { credentialSecret: req.credentialSecret } : {}),
          ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
        },
        // The worker's own timer settles the run; the transport outlives it so a
        // timed-out run still returns its partial text rather than a socket error.
        { timeoutMs: timeoutMs + SPAWN_TRANSPORT_HEADROOM_MS },
      );
      return result as SubAgentRunResult;
    } catch (err) {
      await this.forgetIfGone(sc);
      return failedRun(getErrorMessage(err), startedAt);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * A `die` event missed during a Docker event-stream gap would otherwise leave
   * the manager pointed at a dead container for the rest of the process: the
   * missing-container reconciler walks runners and this container has none. Run
   * when the gap closes, and when a request finds the worker unreachable.
   */
  private async forgetIfGone(sc: SessionContainer): Promise<void> {
    try {
      // Undefined means Docker could not answer, which is not proof of death.
      if (await this.deps.containerManager.isTrackedContainerRunning(CLEANUP_CONTAINER_SESSION_ID) !== false) return;
      if (await this.deps.containerManager.markContainerGone(CLEANUP_CONTAINER_SESSION_ID, sc.id)) {
        // Leaving the recreate to the next request costs that request a
        // container start, and this one has already failed (req 8).
        console.warn("[cleanup-container] container is gone — recreating");
        this.noteContainerGone({ retryNow: true });
      }
    } catch (err) {
      console.warn("[cleanup-container] liveness check failed:", getErrorMessage(err));
    }
  }

  private async cancelSpawn(sc: SessionContainer, spawnId: string): Promise<void> {
    try {
      await workerPost(sc.workerUrl, "/agent/spawn/cancel", { spawnId }, { timeoutMs: 5_000 });
    } catch (err) {
      console.warn(`[cleanup-container] cancel spawn=${spawnId} failed:`, getErrorMessage(err));
    }
  }
}
