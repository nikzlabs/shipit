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
  trackComposeStop,
  awaitComposeStop,
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
   * The same in-flight-`stop()` map the runner path uses. A warm start must wait
   * on any outstanding `compose down` for this session before issuing its own
   * `compose up`, because both address the project name `shipit-{sid12}`.
   */
  composeStopPromises?: Map<string, Promise<void>>;
  /**
   * Does this session have a runner right now? Asked only on the failure path,
   * to tell "our pre-start failed and nobody is watching" from "a claim adopted
   * this manager while the start was running" — the second of which makes the
   * manager the runner's, not ours to unregister.
   *
   * Absent = "we cannot tell", and the cleanup then goes ahead: an orphaned
   * failed manager is the more likely and the more harmful of the two.
   */
  isSessionActive?: (sessionId: string) => boolean;
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
  const composeStopPromises = deps.composeStopPromises ?? new Map<string, Promise<void>>();
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
    // Tell the adopting claim this stack was built against a tree the claim is
    // about to move. See `ServiceManager.preStartedWarm`.
    mgr.preStartedWarm = true;
    // Registered in the SAME synchronous run as the `has` check above, and
    // before either await below. The compose project name is derived from the
    // session id, so two managers for one warm session are two owners of one
    // stack; the registry entry is what makes an activation landing underneath
    // us adopt this one instead of building a rival. Straddling an await with
    // the check and the set is how that rival gets built.
    serviceManagers.set(sessionId, mgr);

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

    // A prior stack's `compose down` for this session must finish first. Same
    // project name (`shipit-{sid12}`) means the same Docker resources, so an
    // outstanding down running beside our up tears down what we just built —
    // and the warm tier makes this reachable, because the periodic repair stops
    // a dead session's stack and immediately rebuilds it. The runner path has
    // gated on this since docs/127; this one has to as well. Raised by review.
    await awaitComposeStop(composeStopPromises, sessionId);

    const startedAt = Date.now();
    try {
      // On the session's stack queue like every other compose op: an adopting
      // claim's reconcile must not land inside this start.
      await serializeStackOp(sessionId, async () => {
        // Checked as late as possible, immediately before the call, exactly as
        // the runner path re-checks `runner.disposed` there. Every await above
        // can outlive our ownership: the repair sweep, a repo delete or tier 0
        // may have stopped this manager and dropped it from the registry. And
        // `start()` RESETS `_disposed` and re-arms the poll loop, so going ahead
        // would resurrect a manager nobody owns, polling Docker for a session
        // nobody has, with nothing left that could stop it. Raised by review.
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
      // Leaving a FAILED manager registered is worse than never having
      // pre-started: activation adopts what it finds and never calls `start()`
      // itself, so the session would get no preview and no error. Drop it and
      // let the claim build its own — which is exactly today's behaviour.
      //
      // Unless a runner already adopted it during the start. Then it is that
      // runner's, and unregistering would leave the session's own manager
      // invisible to every `serviceManagers.get` — the preview routes, the
      // service list, the idle enforcer's `has`. Nothing here can start it
      // again either; the runner owns its lifecycle from adoption on.
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

/**
 * Drop a warm session's pre-started stack: out of the registry first, then
 * stopped, with the stop RECORDED so the next start for this session waits on
 * it.
 *
 * A pre-started manager is the one kind with **no runner to own its teardown**.
 * Every other stack is dropped by the runner's `disposed` handler
 * (`serviceManagers.delete` + `trackComposeStop`); a warm session never had a
 * runner, so anything that ends a warm session before it is claimed — the
 * periodic repair rebuilding its standby, a repo being deleted — has to say so
 * here, or it leaves a manager polling Docker for a session that is gone.
 *
 * `composeStopPromises` is what makes the repair safe rather than merely tidy.
 * The sweep stops a dead warm session's stack and rebuilds it moments later, and
 * both use the compose project name `shipit-{sid12}` — so a discarded stop
 * promise means the old `compose down` can be running beside the new `compose
 * up` and tear down what it just built. This is the same handshake
 * `trackComposeStop`/`awaitComposeStop` give the runner path. Raised by review.
 *
 * Fire-and-forget for the caller: it is usually about to destroy the container
 * anyway, and a `compose down` that fails must not fail the operation that
 * asked.
 */
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
