import fs from "node:fs";
import path from "node:path";
import type { SessionContainer, SessionContainerManager } from "./session-container.js";
import { SESSION_WORKSPACE_SUBDIR, sessionStateDir } from "./session-state-dir.js";
import { allocateAndSealSessionDir } from "./session-uid-allocator.js";
import { chownTreeToSessionWorker } from "./session-worker-uid.js";
import { subAgentSpawnHomeContainerDir } from "./session-credentials.js";
import { workerPost } from "./worker-http.js";
import { getErrorMessage } from "./validation.js";
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

/**
 * UUID-shaped because every path, label and credential subtree ShipIt keys by
 * session id expects that shape; constant because the session store never holds
 * a row for it.
 */
export const CLEANUP_CONTAINER_SESSION_ID = "00000000-0000-4000-8000-00000c1ea409";

export function isCleanupContainerSession(sessionId: string): boolean {
  return sessionId === CLEANUP_CONTAINER_SESSION_ID;
}

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
 * process (docs/299 req 8). It is never stopped, so it is exempt from docs/284's
 * reclaim in `idle-enforcer.ts` and from the boot credential sweep in
 * `startup-janitor.ts` — both would otherwise take it, since it is idle between
 * dictations and the session store has never heard of its id.
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

  constructor(private readonly deps: CleanupContainerDeps) {
    this.onContainerExited = (sessionId: string): void => {
      if (!isCleanupContainerSession(sessionId) || this.stopped) return;
      // Dying inside the create interval counts against the cap below; without
      // that a crash loop recreates for ever, since nothing else watches this id.
      if ((this.deps.now?.() ?? Date.now()) < this.nextAttemptAt) this.consecutiveFailures += 1;
      console.warn("[cleanup-container] container exited — recreating");
      this.reviveSoon();
    };
  }

  /** Create the container now and keep recreating it when its container dies. */
  async start(): Promise<void> {
    this.deps.containerManager.on("container_exited", this.onContainerExited);
    await this.ensure().catch(() => { /* ensure() records its own failure */ });
    if (!this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID)) this.reviveSoon();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deps.containerManager.off("container_exited", this.onContainerExited);
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
    const existing = this.deps.containerManager.get(CLEANUP_CONTAINER_SESSION_ID);
    if (existing?.status === "running") {
      // Surviving to be found running is what clears the cap. Clearing it on a
      // successful create instead would reset on every turn of a crash loop.
      this.consecutiveFailures = 0;
      return existing;
    }
    this.ensuring ??= this.create().finally(() => { this.ensuring = null; });
    return this.ensuring;
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
   * the manager pointed at a dead container for the rest of the process: nothing
   * else reconciles it, because the missing-container reconciler walks runners
   * and this container has none.
   */
  private async forgetIfGone(sc: SessionContainer): Promise<void> {
    try {
      // Undefined means Docker could not answer, which is not proof of death.
      if (await this.deps.containerManager.isTrackedContainerRunning(CLEANUP_CONTAINER_SESSION_ID) !== false) return;
      if (await this.deps.containerManager.markContainerGone(CLEANUP_CONTAINER_SESSION_ID, sc.id)) {
        console.warn("[cleanup-container] container is gone — the next request recreates it");
        this.nextAttemptAt = 0;
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
