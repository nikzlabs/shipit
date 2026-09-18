import type { ServiceManager } from "./service-manager.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import {
  buildServiceManager,
  applyOverlayDepDirsForSession,
  trackComposeStop,
  awaitComposeStop,
  type ServiceManagerBuildDeps,
} from "./service-manager-setup.js";
import { serializeStackOp } from "./stack-op-queue.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "./validation.js";

// Applied during warming, not claiming; a break does not discard an existing warm preview.
export const WARM_PREVIEW_RECENCY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRecentlyUsedRepo(lastUsedAt: string | undefined, now = Date.now()): boolean {
  if (!lastUsedAt) return false;
  const ms = Date.parse(lastUsedAt);
  if (Number.isNaN(ms)) return false;
  return now - ms <= WARM_PREVIEW_RECENCY_DAYS * DAY_MS;
}

export interface WarmPreviewDeps extends ServiceManagerBuildDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  serviceManagers: Map<string, ServiceManager>;
  composeStopPromises?: Map<string, Promise<void>>;
  isSessionActive?: (sessionId: string) => boolean;
  /** Test seam; production uses the shared buildServiceManager. */
  createManager?: typeof buildServiceManager;
}

/** Call after pre-install completes, before activation adopts the registered manager. */
export async function preStartWarmPreview(
  opts: { sessionId: string; workspaceDir: string; repoUrl: string },
  deps: WarmPreviewDeps,
): Promise<void> {
  const { sessionId, workspaceDir, repoUrl } = opts;
  const { repoStore, sessionManager, serviceManagers } = deps;
  const composeStopPromises = deps.composeStopPromises ?? new Map<string, Promise<void>>();
  try {
    const repo = repoStore.get(repoUrl);
    if (!isRecentlyUsedRepo(repo?.lastUsedAt)) {
      console.log(
        `[warm-preview:${sessionId}] Skipping pre-start — ${repoUrl} was last opened `
        + `${repo?.lastUsedAt ?? "never"}, outside the ${WARM_PREVIEW_RECENCY_DAYS}-day window`,
      );
      return;
    }

    if (serviceManagers.has(sessionId)) return;

    let shipitConfig;
    try {
      shipitConfig = resolveShipitConfig(workspaceDir);
    } catch {
      return;
    }
    // Plugin-only stacks are fetched and activated through the runner path.
    if (!shipitConfig.compose) return;

    const session = sessionManager.get(sessionId);
    const build = deps.createManager ?? buildServiceManager;
    const mgr = build({ sessionId, workspaceDir, session, shipitConfig, deps });
    mgr.preStartedWarm = true;
    // Register before any await so a concurrent claim adopts this manager.
    serviceManagers.set(sessionId, mgr);

    // Resolve overlays before start so activation does not recreate the warm stack.
    if (deps.containerManager && session) {
      await applyOverlayDepDirsForSession(sessionId, mgr, {
        containerManager: deps.containerManager,
        session,
        workspaceDir,
      });
    }

    // The old stop and new start address the same Compose project.
    await awaitComposeStop(composeStopPromises, sessionId);

    const startedAt = Date.now();
    try {
      await serializeStackOp(sessionId, async () => {
        // start() resets disposal; do not revive a manager whose ownership was revoked.
        if (serviceManagers.get(sessionId) !== mgr) {
          console.log(
            `[warm-preview:${sessionId}] Abandoning pre-start — the session's stack changed hands while it was queued`,
          );
          return;
        }
        await mgr.start();
      });
      console.log(
        `[warm-preview:${sessionId}] Compose stack pre-started for ${repoUrl} in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      console.warn(
        `[warm-preview:${sessionId}] Pre-start failed for ${repoUrl}: ${getErrorMessage(err)}`
        + " — the session stays warm and its preview starts on activation",
      );
      // A concurrent claim may now own this manager and its recovery.
      if (deps.isSessionActive?.(sessionId) === true) {
        console.warn(
          `[warm-preview:${sessionId}] A session was activated during the failed start —`
          + " leaving the manager to its runner rather than unregistering it",
        );
        return;
      }
      if (serviceManagers.get(sessionId) !== mgr) return;
      serviceManagers.delete(sessionId);
      await mgr.stop().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[warm-preview:${sessionId}] Pre-start aborted: ${getErrorMessage(err)}`);
  }
}

// Warm managers have no runner to own teardown; record the stop for the next start.
export function stopWarmPreview(
  serviceManagers: Map<string, ServiceManager> | undefined,
  sessionId: string,
  composeStopPromises?: Map<string, Promise<void>>,
): void {
  const mgr = serviceManagers?.get(sessionId);
  if (!mgr) return;
  serviceManagers?.delete(sessionId);
  if (composeStopPromises) {
    trackComposeStop(composeStopPromises, sessionId, mgr);
    return;
  }
  void mgr.stop().catch((err: unknown) => {
    console.warn(`[warm-preview:${sessionId}] Stopping the pre-started stack failed: ${getErrorMessage(err)}`);
  });
}

export function createWarmPreviewStarter(
  deps: WarmPreviewDeps,
): (opts: { sessionId: string; workspaceDir: string; repoUrl: string }) => Promise<void> {
  return (opts) => preStartWarmPreview(opts, deps);
}
