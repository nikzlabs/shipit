/**
 * Pre-start a warm session's Compose stack (planning#501, docs/288).
 *
 * The warm pool pre-pays the clone, the standby container and `agent.install`,
 * and then stops. The dev server — `docker compose up`, the image build, the
 * server's own boot and first compile — is still paid on the user's clock on
 * every session, warm or cold. That is what a user reported as "I never seem to
 * get benefit of a warm session, all the preview still start for ages", and an
 * ops trace confirmed: a standby lived 41 minutes with no compose container, and
 * the first one was created 20 seconds AFTER the claim.
 *
 * The handoff needed no inventing. `setupServiceManager` already opens with
 * `serviceManagers.get(runner.sessionId)` and adopts what it finds
 * (docs/127-restart-agent's agent-restart path). So warming registers its
 * manager under the warm session's id, and activation adopts it with no new
 * branch — which is why this module builds the manager through the ONE shared
 * `buildServiceManager` and wires nothing runner-shaped itself.
 */

import type { ServiceManager } from "./service-manager.js";
import type { RepoStore } from "./repo-store.js";
import type { SessionManager } from "./sessions.js";
import {
  buildServiceManager,
  applyOverlayDepDirsForSession,
  type ServiceManagerBuildDeps,
} from "./service-manager-setup.js";
import { serializeStackOp } from "./stack-op-queue.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "./validation.js";

/**
 * How recently a repo must have been used for ShipIt to pre-start its warm
 * preview (docs/288 req 8).
 *
 * A warm *session* still costs a container that is created either way; a warm
 * *preview* costs a dev server per imported repo, standing, so it is the half
 * that needs a bound. Seven days is the smallest window that clears a long
 * weekend plus a public holiday with room to spare, and it sits inside the 30
 * days after which the steady-state janitor drops a repo's bare cache and it
 * cannot be warmed at all — so this gate only ever chooses among repos that are
 * still cached.
 *
 * Req 9 — an ordinary break must not change what a user comes back to — holds
 * because of WHERE the gate is evaluated, not because of the number. It is
 * asked when ShipIt WARMS (boot re-warm, repo add, repo trust, the claim
 * re-warm, graduation, the periodic sweep), never when the user claims: last
 * night's claim re-warmed the next session and pre-started its preview, and
 * that stack is what this morning's claim adopts. And every claim re-stamps
 * `lastUsedAt`, so an absence longer than the cutoff costs exactly ONE cold
 * preview before the repo is recent again. Both properties have to stay true if
 * the number is ever changed.
 */
export const WARM_PREVIEW_RECENCY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Is this repo recent enough to deserve a standing pre-started preview?
 *
 * An unparseable or missing stamp answers `false`: the gate exists to bound a
 * standing cost, so "we cannot tell" must not spend it.
 */
export function isRecentlyUsedRepo(lastUsedAt: string | undefined, now = Date.now()): boolean {
  if (!lastUsedAt) return false;
  const ms = Date.parse(lastUsedAt);
  if (Number.isNaN(ms)) return false;
  return now - ms <= WARM_PREVIEW_RECENCY_DAYS * DAY_MS;
}

export interface WarmPreviewDeps extends ServiceManagerBuildDeps {
  repoStore: RepoStore;
  sessionManager: SessionManager;
  /** The same registry `setupServiceManager` adopts from. */
  serviceManagers: Map<string, ServiceManager>;
  /**
   * Test seam ONLY — production must leave this unset so the manager comes from
   * the one shared `buildServiceManager`. Standing up a real one here would need
   * a Docker daemon to reach four lines of decision;
   * `warm-preview-single-construction.test.ts` is what holds the real property
   * (no second construction site anywhere in the server).
   */
  createManager?: typeof buildServiceManager;
}

/**
 * Build, register and start the Compose stack for an already-prepared warm
 * session. Best-effort throughout: every failure path leaves the session exactly
 * as warm as it was, paying the cold preview cost this was trying to remove.
 *
 * The caller must have finished the pre-install first. `start()` partitions the
 * auto services on the install gate, and a gate closed at that moment holds them
 * until something reopens it — sequencing after the install is what makes the
 * pre-started stack a *started* one rather than a held one. (The gate on a
 * freshly-built manager is open by construction: `_installRunning` and
 * `_installFailed` both start `false`. There is deliberately no
 * `setInstallRunning(false)` call here — it would be a same-value no-op reading
 * as though it were load-bearing.)
 *
 * Never rejects.
 */
export async function preStartWarmPreview(
  opts: { sessionId: string; workspaceDir: string; repoUrl: string },
  deps: WarmPreviewDeps,
): Promise<void> {
  const { sessionId, workspaceDir, repoUrl } = opts;
  const { repoStore, sessionManager, serviceManagers } = deps;
  try {
    // docs/288 req 8 — only a recently-opened repo carries a standing preview.
    const repo = repoStore.get(repoUrl);
    if (!isRecentlyUsedRepo(repo?.lastUsedAt)) {
      console.log(
        `[warm-preview:${sessionId}] Skipping pre-start — ${repoUrl} was last opened `
        + `${repo?.lastUsedAt ?? "never"}, outside the ${WARM_PREVIEW_RECENCY_DAYS}-day window`,
      );
      return;
    }

    // Somebody already owns this session's stack — the claim raced us and
    // activation built one. Registering a second would strand the first.
    if (serviceManagers.has(sessionId)) return;

    let shipitConfig;
    try {
      shipitConfig = resolveShipitConfig(workspaceDir);
    } catch {
      return; // Invalid config — activation reports it; warming stays quiet.
    }
    // Only a project that declares its own stack. A plugins-only project gets
    // its services from repositories that are fetched and activated on the
    // RUNNER path (`activatePluginRepos`), so there is nothing here to start —
    // and activation's own `emitPluginReposUpdated` is what reconciles them in.
    if (!shipitConfig.compose) return;

    const session = sessionManager.get(sessionId);
    const build = deps.createManager ?? buildServiceManager;
    const mgr = build({ sessionId, workspaceDir, session, shipitConfig, deps });

    // BEFORE the first `start()`, exactly as the runner path does it (docs/183
    // Phase 5) and for a reason specific to this path: a manager started
    // holding no overlay set makes the adopting claim resolve a CHANGED set,
    // and its reconcile recreates every container we just started — spending
    // the whole saving at the moment it was supposed to arrive.
    if (deps.containerManager && session) {
      await applyOverlayDepDirsForSession(sessionId, mgr, {
        containerManager: deps.containerManager,
        session,
        workspaceDir,
      });
    }

    // Registered BEFORE the start, so a claim landing mid-start adopts this
    // manager rather than building a second one for the same project name. The
    // start goes through the session's stack queue for the same reason every
    // other compose op does — an adoption's reconcile must not land inside it.
    serviceManagers.set(sessionId, mgr);
    const startedAt = Date.now();
    try {
      await serializeStackOp(sessionId, () => mgr.start());
      console.log(
        `[warm-preview:${sessionId}] Compose stack pre-started for ${repoUrl} in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      // Leaving a failed manager registered would be worse than never having
      // pre-started: activation adopts what it finds and never calls `start()`,
      // so the session would get no preview at all. Drop it and let the claim
      // build its own, which is exactly today's behaviour.
      serviceManagers.delete(sessionId);
      console.warn(
        `[warm-preview:${sessionId}] Pre-start failed for ${repoUrl}: ${getErrorMessage(err)}`
        + " — the session stays warm and its preview starts on activation",
      );
      await mgr.stop().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[warm-preview:${sessionId}] Pre-start aborted: ${getErrorMessage(err)}`);
  }
}

/**
 * Drop a warm session's pre-started stack: out of the registry first, then
 * stopped.
 *
 * A pre-started manager is the one kind with **no runner to own its teardown**.
 * Every other stack is dropped by the runner's `disposed` handler
 * (`serviceManagers.delete` + `trackComposeStop`); a warm session never had a
 * runner, so anything that ends a warm session before it is claimed — the
 * periodic repair rebuilding its standby, a repo being deleted — has to say so
 * here, or it leaves a manager polling Docker for a session that is gone.
 *
 * Fire-and-forget: the caller is usually about to destroy the container anyway,
 * and a `compose down` that fails must not fail the operation that asked.
 */
export function stopWarmPreview(
  serviceManagers: Map<string, ServiceManager> | undefined,
  sessionId: string,
): void {
  const mgr = serviceManagers?.get(sessionId);
  if (!mgr) return;
  serviceManagers?.delete(sessionId);
  void mgr.stop().catch((err: unknown) => {
    console.warn(`[warm-preview:${sessionId}] Stopping the pre-started stack failed: ${getErrorMessage(err)}`);
  });
}

/**
 * Adapt {@link preStartWarmPreview} to the hook the warm pool calls. Built in
 * `bootstrap-managers.ts`, where the registry and the compose collaborators are
 * in scope — the warm pool itself stays free of them.
 */
export function createWarmPreviewStarter(
  deps: WarmPreviewDeps,
): (opts: { sessionId: string; workspaceDir: string; repoUrl: string }) => Promise<void> {
  return (opts) => preStartWarmPreview(opts, deps);
}
