import fs from "node:fs";
import path from "node:path";
import { ContainerSessionRunner, type InstallOutcome } from "./container-session-runner.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import { ServiceManager } from "./service-manager.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { SecretStore } from "./secret-store.js";
import type { CredentialStore } from "./credential-store.js";
import type { LogSource, SessionInfo } from "../shared/types.js";
import type { LogStore } from "./log-store.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { resolveDepsHashInputs } from "../shared/deps-hash.js";
import { evaluateContentKeyReport, type ContentKeyConfig } from "./install-content-key.js";
import { agentLogAppend } from "./log-emit.js";
import { collectAccountAgentEnv } from "./secret-resolver.js";
import { getErrorMessage } from "./validation.js";
import { formatOverlayMeasurement, type DepDirPublishOutcome } from "./overlay-publish.js";
import { isOverlayEligible } from "./overlay-session.js";
import { volumeExists } from "./overlay-volume.js";
import { clearActivationState } from "./services/plugin-activation.js";
import { collectPluginCredentialDeclarations } from "./plugin-credentials.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { serializeStackOp } from "./stack-op-queue.js";

/**
 * Route a `stack_error` from a session's ServiceManager to the per-session
 * Logs panel (via `broadcastLog`) and to attached viewers (via the runner's
 * emitMessage). Exported so the integration test in
 * `integration_tests/stack-error.test.ts` can verify the wiring without
 * needing real Docker or a real compose config.
 *
 * See docs/124-session-rescue-and-diagnostics §1.1.
 */
export function handleStackError(
  runner: SessionRunnerInterface,
  err: Error,
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void,
): void {
  const text = `[compose] Stack error: ${err.message}`;
  if (broadcastLog) broadcastLog(runner.sessionId, "server", text);
  runner.emitMessage(agentLogAppend("server", text));
  runner.emitMessage({
    type: "stack_error",
    sessionId: runner.sessionId,
    message: err.message,
  });
}

/**
 * nikzlabs/shipit#2426 — give the ServiceManager the dep-dir overlay volumes the
 * agent container actually has, so a compose service that mounts the workspace
 * nests the SAME overlay at `<service-target>/<dep-dir>` instead of resolving that
 * path to the plain directory underneath.
 *
 * Getting this wrong is invisible and unrecoverable from inside the session: the
 * `up` still succeeds, and the service simply gets a second, empty dependency
 * tree that its own install then fills. Nothing the agent does to `node_modules`
 * afterwards can reach it, and nothing says so. Hence two rules here.
 *
 * **The container record is the source of truth, not a re-derivation.** What the
 * agent has mounted was decided at container-create time. Re-deciding it now reads
 * the LIVE workspace — `shipit.yaml`'s `dep-dirs`, the pnpm signals, `git
 * check-ignore` — every one of which the agent can change mid-session, and any
 * disagreement yields zero mounts. Re-derivation survives only as the fallback for
 * a container we have no record of (rediscovered / re-adopted), where it is the
 * only answer available.
 *
 * **A dropped mount is announced.** The `volumeExists` filter stays — a stale
 * record naming a removed volume would fail the whole `compose up` on an
 * `external` reference, which is worse than one plain dep dir — but anything it
 * drops now reaches the session's Logs panel instead of only orchestrator stdout.
 *
 * Idempotent, and safe to call again on the adoption path: a new agent container
 * means a newly-created overlay volume set, and the manager that outlived the old
 * runner is still holding the old answer. Returns whether the manager's set
 * actually CHANGED — on a live stack that is the caller's signal to reconcile,
 * since nothing but `start()`/`reconcile()` rewrites the override.
 *
 * Exported for `service-manager-overlay-mounts.test.ts` — driving it through
 * `setupServiceManager` would need a whole container runtime to reach four lines
 * of decision.
 */
export async function applyOverlayDepDirs(
  runner: SessionRunnerInterface,
  mgr: ServiceManager,
  deps: {
    containerManager: SessionContainerManager | null;
    session?: SessionInfo;
    workspaceDir: string;
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  },
): Promise<boolean> {
  const { containerManager, session, workspaceDir, broadcastLog } = deps;
  // A pure env+session pre-gate, so flag-off / ineligible sessions leave the
  // override and the compose start timing byte-for-byte unchanged.
  if (!containerManager || !session || !isContainerRunner(runner) || !isOverlayEligible(session)) return false;

  const warn = (text: string): void => {
    console.warn(`[overlay:${runner.sessionId}] ${text}`);
    if (broadcastLog) broadcastLog(runner.sessionId, "server", `[compose] ${text}`);
  };

  try {
    // Orders us after container creation — the volumes are created just before
    // the container. `dispose()` also resolves it, hence the `disposed` re-check.
    await runner.whenWorkerReady();
    if (runner.disposed) return false;

    const provisioned = containerManager.provisionedOverlayDepDirs(runner.sessionId);
    const pairs = provisioned ?? (await containerManager.prepareOverlaySpecs({
      sessionId: runner.sessionId,
      workspaceDir,
      session,
      requireProvisioned: true,
    })).map((s) => ({ depDir: s.depDir, volumeName: s.volumeName }));

    // `[]` from the record is authoritative ("this container has no overlay"), so
    // it is applied as-is. `[]` from the fallback is a guess, and clobbering a
    // manager that already holds a good answer with a guess is the failure this
    // whole function exists to prevent.
    //
    // Both branches SAY so. The empty return used to be the only silent one, and
    // that is how a fleet-wide "0 of 35 compose services got an overlay mount"
    // regression survived a deploy with not one line to grep for: every other
    // branch here warns, so the log read exactly like a fleet with no overlay
    // sessions on it.
    if (pairs.length === 0) {
      if (provisioned) {
        mgr.setOverlayDepDirs([]);
        // Not a `warn`: legitimately empty for a pnpm repo (`prepareOverlaySpecs`
        // skips those by design) or a container built before the feature, and
        // those sessions must not get a scary Logs entry on every activation.
        console.log(
          `[overlay:${runner.sessionId}] agent container has no dependency overlay — ` +
          `compose services use the plain workspace directories`,
        );
      } else {
        warn(
          `could not tell which dependency overlays the agent container has (no container ` +
          `record, and re-derivation found none) — compose services may see different ` +
          `dependency directories than the agent.`,
        );
      }
      return false;
    }

    const docker = containerManager.dockerClient;
    const usable: { depDir: string; volumeName: string }[] = [];
    for (const pair of pairs) {
      if (await volumeExists(docker, pair.volumeName)) usable.push(pair);
      else {
        warn(
          `${pair.depDir} is overlay-mounted in the agent container but its volume ` +
          `(${pair.volumeName}) is gone, so compose services get the plain directory ` +
          `instead — they will not see the agent's installed dependencies there.`,
        );
      }
    }
    const changed = mgr.setOverlayDepDirs(usable);
    // The ops finding of 2026-08-19 — the set is not the only thing that can make
    // the running stack wrong. When the base generation rotated, container creation
    // removed the Compose siblings holding the old volumes so they could be
    // recreated over the new generation (`releaseOverlayVolumeHolders`). The set is
    // unchanged by that (the volume name is keyed on session + dep dir), so
    // `changed` says no reconcile is needed — but the service containers are gone,
    // and a container freezes its mounts at create time, so only a reconcile can
    // bring them back over the generation the agent is now on.
    const recreated = containerManager.consumeOverlayVolumesRecreated(runner.sessionId);
    if (recreated) {
      // Said in the session's own Logs panel, not just orchestrator stdout: the
      // reconcile below brings back auto and install-gated services, but a
      // `manual` service the user had started stays stopped, and "my dev server
      // vanished on restart" with no explanation anywhere is the worse half of
      // this trade. The alternative was leaving it running against an upper layer
      // that no longer exists on the host, where its writes ENOENT.
      warn(
        `the dependency base advanced, so the compose services holding the previous ` +
        `overlay were recreated over the new one. Services set to start automatically ` +
        `come back on their own; a manually-started service needs starting again.`,
      );
    }
    return changed || recreated;
  } catch (err) {
    warn(
      `could not resolve the dependency overlay (${getErrorMessage(err)}) — compose ` +
      `services may see different dependency directories than the agent.`,
    );
    return false;
  }
}

/** Typeguard for the ContainerSessionRunner subclass without an instanceof import here. */
function isContainerRunner(
  runner: SessionRunnerInterface,
): runner is SessionRunnerInterface & ContainerSessionRunner {
  return runner instanceof ContainerSessionRunner;
}

/**
 * Re-wire a freshly-created runner onto an orphaned ServiceManager that
 * survived the previous runner's `preserveComposeOnDispose` dispose. The
 * compose stack is still running — we only need to attach listeners,
 * reconnect the new agent container to the existing network, and re-arm
 * the install-running gate around the new container's install.
 *
 * Exported for unit-test coverage of the lifecycle handoff
 * (`integration_tests/service-manager-adoption.test.ts`). See
 * docs/127-restart-agent for the full design.
 */
export function adoptExistingServiceManager(
  runner: SessionRunnerInterface,
  mgr: ServiceManager,
  deps: {
    serviceManagers: Map<string, ServiceManager>;
    /** Same map as in setupServiceManager — see RunnerRegistryDeps doc. */
    composeStopPromises: Map<string, Promise<void>>;
    containerManager: SessionContainerManager | null;
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
    installPromise: Promise<InstallOutcome> | null;
    /**
     * Fresh closure that reads the session's latest secrets (the OLD
     * closure baked into `mgr` references the disposed runner; safe today
     * because both closures read by sessionId, but defensive in case a
     * future refactor makes the loader less idempotent — e.g. a per-runner
     * secret store wrapper, or a remoteUrl change between disposals).
     */
    secretsLoader?: () => Promise<Record<string, string>>;
    containServicesFn?: (serviceNames: string[]) => Promise<void>;
    containServiceDns?: boolean;
    containServiceProxy?: boolean;
    resetSessionNetwork?: () => Promise<void>;
    prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
    /**
     * #2426 — the session + its clone, so the adopted manager can be re-pointed at
     * the NEW agent container's overlay volumes. Optional only because the older
     * test doubles for this handoff predate it.
     */
    session?: SessionInfo;
    workspaceDir?: string;
  },
): void {
  const { serviceManagers, composeStopPromises, containerManager, broadcastLog, installPromise, secretsLoader } = deps;

  // 1. Attach the new runner's listeners. `setServiceManager` internally
  //    calls `clearServiceManager()` first, but on a freshly-created runner
  //    that's a no-op — there's nothing to clear.
  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  // 1b. Replace the manager's secrets loader with the fresh closure scoped
  //     to the new runner. Defensive — see field doc above.
  if (secretsLoader) {
    mgr.setSecretsLoader(secretsLoader);
  }

  // Bind errors before starting any asynchronous adoption work so a policy
  // transition failure is visible to the session.
  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  // Some injected test doubles predate this optional lifecycle seam.
  const containmentChanged = typeof mgr.updateEgressContainment === "function"
    ? mgr.updateEgressContainment(
        deps.containServicesFn,
        deps.containServiceDns ?? false,
        deps.containServiceProxy ?? false,
        deps.prepareContainedStartFn,
      )
    : false;
  // Stop the old-policy stack immediately. In particular, Open→Contained must
  // not leave repository services on their old NAT networks while a new worker
  // is still starting. `stop()` preserves volumes; reconcile starts the stack
  // again only after the network mode is reset.
  const policyTransition = containmentChanged
    ? mgr.stop().catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        mgr.emit("stack_error", normalized);
        throw normalized;
      })
    : Promise.resolve();
  // 2. Reconnect the new agent container to the existing compose network.
  //    The old container was destroyed; the network outlived it (compose
  //    only removes networks on `down`, which we deliberately skipped).
  //
  //    CRITICAL: we MUST wait for the new container to exist before
  //    calling connectToNetwork — `SessionContainerManager.connectToNetwork`
  //    looks the container up by sessionId and throws "No container found"
  //    if the entry hasn't been registered yet. The runner factory's
  //    container creation is async; the runner is returned synchronously
  //    with a placeholder workerUrl, and `setWorkerUrl()` is called once
  //    the IP resolves. `whenWorkerReady()` gates on that resolution.
  //
  //    Without this gate, the call fires immediately, throws, gets
  //    swallowed in `.catch()`, and the new agent container is NEVER
  //    joined to the compose network — silently breaking compose DNS for
  //    the agent. That's exactly the regression the feature is supposed
  //    to avoid, just from the other direction.
  if (containerManager && isContainerRunner(runner)) {
    const networkName = `shipit-session-${runner.sessionId}`;
    // Fire-and-forget — the connect must run after worker ready resolves
    // but the parent function returns synchronously. eslint-disable is
    // the documented escape for this pattern (see the lint rule's docs).
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget after async readiness signal
    void runner
      .whenWorkerReady()
      .then(async () => {
        // #2426 — BEFORE the reconcile below, which regenerates the compose
        // override. The manager outlived the previous runner, so it is still
        // holding whatever that runner resolved; the container it was resolved
        // from is gone.
        //
        // An UNCHANGED set needs no reconcile, and for a specific reason worth
        // stating: an overlay volume is named
        // `shipit-<sid12>_overlay-<hash(depDir)>` (`overlay-session.ts` →
        // `overlayVolumeName`), so the name depends on the SESSION and the dep
        // dir, never on the container. A recreate mints a new volume under the
        // same name, and the standing `external` reference keeps resolving — the
        // override the previous runner wrote is still correct.
        //
        // A CHANGED set does need one, which that reasoning does not cover: the
        // override is written by `start()`/`reconcile()` and by nothing else, so
        // re-pointing the manager alone leaves the stale file on disk and every
        // later `compose up` — the install gate releasing, a user pressing start
        // — keeps handing compose the old mounts. A service container freezes
        // its mount set at CREATE time, so those `up`s see an unchanged config
        // and merely `start` the container that has the wrong mounts, forever.
        let overlayChanged = false;
        if (deps.workspaceDir !== undefined) {
          overlayChanged = await applyOverlayDepDirs(runner, mgr, {
            containerManager,
            session: deps.session,
            workspaceDir: deps.workspaceDir,
            broadcastLog,
          });
          if (overlayChanged) {
            console.log(
              `[overlay:${runner.sessionId}] dependency overlay mounts changed for the new ` +
              `agent container — reconciling so compose services pick them up`,
            );
          }
        }
        if (containmentChanged) {
          await policyTransition;
          await deps.resetSessionNetwork?.();
        }
        if (containmentChanged || overlayChanged) {
          // On the stack queue, like every other reconcile. This is the one
          // that was left off it: the adopted stack is deliberately still
          // RUNNING (`preserveComposeOnDispose`), and the new container's
          // `agent.install` is in flight alongside — so this reconcile's
          // `compose up` can land in the middle of the install gate's release,
          // which is exactly the collision the queue exists to prevent
          // (review finding).
          await serializeStackOp(runner.sessionId, () => mgr.reconcile());
        }
        await containerManager.connectToNetwork(runner.sessionId, networkName);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("already exists")) return;
        const error = err instanceof Error ? err : new Error(msg);
        mgr.emit("stack_error", error);
      });
  } else if (containmentChanged) {
    void (async () => {
      await policyTransition;
      await deps.resetSessionNetwork?.();
      await serializeStackOp(runner.sessionId, () => mgr.reconcile());
    })().catch((error: unknown) => {
      mgr.emit("stack_error", error instanceof Error ? error : new Error(getErrorMessage(error)));
    });
  }

  // 3. Re-bind stack_error to the new runner so error logs route to the
  //    right place.

  // 4. Re-arm the install-running gate for the new container's install.
  //    Same race story as initial setup: a compose service that reads
  //    workspace `node_modules` while install is extracting can fail —
  //    the gate retries it instead of latching to `error`.
  if (installPromise) {
    mgr.setInstallRunning(true);
    const p = installPromise;
    void (async () => {
      const res = await p;
      mgr.setInstallRunning(false, { failed: !res.ok });
    })();
  }

  // 5. Disposed handler — same shape as the create path, including the
  //    preserve-compose escape hatch (chained restartAgent calls).
  runner.on("disposed", () => {
    if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
      mgr.off("stack_error", stackErrorListener);
      return;
    }
    mgr.off("stack_error", stackErrorListener);
    serviceManagers.delete(runner.sessionId);
    const removeVolumes = isContainerRunner(runner) && runner.removeVolumesOnDispose;
    trackComposeStop(composeStopPromises, runner.sessionId, mgr, { removeVolumes });
  });
}

/**
 * Maximum time we wait for a prior runner's `compose down` before letting
 * the next runner's `compose up` proceed. Compose down for a small stack
 * is usually 2-5 s; we cap at 15 s so a hung `docker compose down` can't
 * block agent restart forever. The race window we're protecting against
 * is bounded — once we've waited this long, the prior down has either
 * completed or is genuinely wedged, and forcing the new up forward is
 * preferable to never recovering.
 */
export const COMPOSE_STOP_WAIT_TIMEOUT_MS = 15_000;

/**
 * docs/262 — the placeholder compose configuration a project that declares only
 * plugins runs under. The manager is told there is NO project compose file, so
 * this path is never opened and never put on a command line; it exists because
 * `ComposeConfig` is not optional downstream, and it names the conventional file
 * only so a log line reads sensibly.
 *
 * It must NOT become "run `docker-compose.yml` if it happens to be there": a
 * repository that adds a plugin has not asked ShipIt to start a stack it never
 * declared, and the collision domain (req 20) would not know about those
 * services either (review finding).
 */
const DEFAULT_COMPOSE_CONFIG = { file: "docker-compose.yml", dockerSocket: false } as const;

/**
 * Register an in-flight `mgr.stop()` so the next `mgr.start()` for the
 * same session awaits it before issuing new compose commands. Without
 * this, the prior runner's `compose down -p shipit-{sid12}` can run in
 * parallel with the new runner's `compose up -p shipit-{sid12}` — same
 * project name = same docker resources, so the old down tears down what
 * the new up just built.
 *
 * The stop promise is cleared from the map when it settles. Exported
 * for unit-test coverage.
 */
export function trackComposeStop(
  composeStopPromises: Map<string, Promise<void>>,
  sessionId: string,
  mgr: { stop: (opts?: { removeVolumes?: boolean }) => Promise<void> },
  opts: { removeVolumes?: boolean } = {},
): void {
  const stopPromise = mgr.stop(opts)
    .catch((err: unknown) => {
      console.error(`[compose:${sessionId}] Failed to stop compose stack:`, err);
    })
    .finally(() => {
      // Only clear our entry — a fresh stop may have replaced it.
      if (composeStopPromises.get(sessionId) === stopPromise) {
        composeStopPromises.delete(sessionId);
      }
    });
  composeStopPromises.set(sessionId, stopPromise);
}

/**
 * Wait for any in-flight `compose down` for this session, bounded by
 * COMPOSE_STOP_WAIT_TIMEOUT_MS. Exported for tests.
 */
export async function awaitComposeStop(
  composeStopPromises: Map<string, Promise<void>>,
  sessionId: string,
): Promise<void> {
  const pending = composeStopPromises.get(sessionId);
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[compose:${sessionId}] Prior stop did not complete within ${COMPOSE_STOP_WAIT_TIMEOUT_MS}ms — proceeding with new start anyway`,
      );
      resolve();
    }, COMPOSE_STOP_WAIT_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([pending, timeout]);
  if (timer) clearTimeout(timer);
}

/**
 * Everything `setupServiceManager` (and the incremental
 * {@link applyShipitConfigChange}) needs to stand a session's compose stack up.
 * Extracted so both entry points share one dependency shape — the change
 * applier must be callable with the exact deps the initial setup was wired with.
 */
export interface ServiceSetupDeps {
  sessionManager: SessionManager;
  /**
   * docs/178 — repo trust store. A repo-backed session whose remote has not
   * been trusted defers all repo-declared auto-execution (agent.install +
   * compose command:/build:). Required so the gate has an authority to
   * consult; tests pass a store whose `isTrusted` returns true.
   */
  repoStore: RepoStore;
  serviceManagers: Map<string, ServiceManager>;
  composeStopPromises: Map<string, Promise<void>>;
  composeWarnings: Map<string, string>;
  composeNotConfigured: Set<string>;
  containerManager: SessionContainerManager | null;
  secretStore?: SecretStore;
  dockerSecretsConfig?: { internalDir: string; hostDir?: string; entrypointSourcePath: string };
  /**
   * docs/183 — orchestrator-private root for per-service compose env files,
   * outside the agent's workspace mount. Passed to `ServiceManager`, which
   * requires it (planning#292): there is no in-clone fallback to omit it in favour of.
   */
  serviceEnvDir: string;
  /** docs/192 — durable log store, forwarded to `ServiceManager` for service-log persistence. */
  logStore?: LogStore;
  /**
   * docs/262 — bring the session's declared plugin repositories to their
   * declared versions (checkout + activation + atomic activation). Called on the
   * same two triggers as compose configuration: session activation and a
   * `shipit.yaml` edit. Fire-and-forget, so a slow plugin fetch never delays
   * the session opening (req 13). Constructed in `bootstrap-managers.ts`,
   * where the bare-cache helpers are in scope; absent in test setups.
   */
  activatePluginRepos?: (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (sessionId: string) => void,
  ) => void;
  /**
   * docs/262 reqs 3, 5, 16 — resolve the plugin services this session surfaces
   * (`services/plugin-services.ts`). Constructed in `bootstrap-managers.ts`,
   * where Docker and the daemon-side path roots are in scope; absent in test
   * setups and in local mode, which has no Compose at all.
   */
  resolvePluginServices?: (
    sessionId: string,
    workspaceDir: string,
  ) => Promise<PluginComposeService[]>;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  /** docs/088 — account-level MCP secrets store. */
  credentialStore?: CredentialStore;
  /**
   * docs/183 Phase 4b — publish-after-install hook. Called once after this
   * session's `agent.install` resolves to publish each declared dep dir's
   * merged snapshot as the next rolling overlay base. Optional; the store is ON
   * by default, so the hook is inert only when the `OVERLAY_DEP_STORE=0`/`false`
   * kill switch is set or the session is overlay-ineligible.
   */
  publishOverlayBases?: (args: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    /** The exact `agent.install` commands the install ran — recorded on the
     *  base pointer for the base-hit marker pre-stamp (docs/183). */
    installCommands?: string[];
  }) => Promise<DepDirPublishOutcome[]>;
}

/**
 * Create and wire a ServiceManager for a runner's session if compose config
 * is detected. Fire-and-forget — compose stack start is async.
 */
export function setupServiceManager(
  runner: SessionRunnerInterface,
  deps: ServiceSetupDeps,
): void {
  const {
    sessionManager,
    repoStore,
    serviceManagers,
    composeStopPromises,
    composeWarnings,
    composeNotConfigured,
    containerManager,
    secretStore,
    dockerSecretsConfig,
    serviceEnvDir,
    logStore,
    broadcastLog,
    credentialStore,
    publishOverlayBases,
  } = deps;
  const session = sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;

  // docs/178 — trust gate. Defer ALL repo-declared auto-execution
  // (`agent.install` + compose `command:`/`build:`) until the user trusts the
  // remote once. A session with no remote is authored locally by the user, so
  // it is trusted by construction. The clone, file tree, diffs, and agent chat
  // still work while untrusted; only foreign-code execution is gated. The
  // trust endpoint re-invokes this setup (via `runner.rerunServiceSetup`) on
  // acceptance, at which point install fires and the compose stack starts.
  const remoteUrl = session?.remoteUrl;
  if (remoteUrl && !repoStore.isTrusted(remoteUrl)) {
    console.log(`[trust] Deferring install + compose for untrusted remote ${remoteUrl} (session ${runner.sessionId})`);
    return;
  }

  let shipitConfig;
  try {
    shipitConfig = resolveShipitConfig(workspaceDir);
  } catch {
    return; // Invalid config — skip compose setup
  }

  // Surface config migration warnings in the preview panel.
  // Store in composeWarnings map for replay on viewer attach — at this point
  // (first call) the WS listener may not yet be connected so emitMessage
  // would be lost. On subsequent calls (config re-evaluation), emitMessage
  // works and we also update the map.
  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: text });
    runner.on("disposed", () => composeWarnings.delete(runner.sessionId));
  } else if (composeWarnings.has(runner.sessionId)) {
    // Warnings cleared (config was fixed) — remove stale warning
    composeWarnings.delete(runner.sessionId);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: "" });
  }

  // docs/262 — bring declared plugin repositories to their declared versions.
  // Runs beside install for the same reason install runs regardless of compose
  // config: a project can declare plugins without declaring a stack. Sits
  // BELOW the trust gate on purpose — fetching and activating a repository a
  // `shipit.yaml` names is repo-declared behaviour exactly like `agent.install`,
  // so an untrusted remote must not get it (docs/178). Activation itself runs
  // no plugin-authored code; when install lands it will run in its own
  // container, and this gate is what keeps an untrusted remote from reaching
  // even the fetch.
  deps.activatePluginRepos?.(runner.sessionId, workspaceDir, emitPluginReposUpdated(runner, deps));
  // The activation state map is process-lived and keyed by session; drop this
  // session's entries when its runner goes away so session churn can't grow it.
  runner.on("disposed", () => clearActivationState(runner.sessionId));

  // Fire install on the agent container regardless of compose config — projects
  // without a compose stack (like ShipIt itself) still need their dependencies
  // installed. Non-blocking; progress streams via SSE.
  //
  // The returned promise resolves when install fully completes (success,
  // skipped, or error). We bracket the ServiceManager's `installRunning`
  // window around it below so dev servers that race install on a shared
  // bind mount get retried instead of latching to `error`.
  const installCommands = shipitConfig.agent.install;
  let installPromise: Promise<InstallOutcome> | null = null;
  // docs/183 — orchestrator-observed install wall-clock for the overlay
  // measurement line below. Captured at kickoff; a marker-skip resolves in ~ms,
  // a real install in seconds, so duration classifies the warm-vs-cold scenario.
  const installStartedAt = Date.now();
  if (runner instanceof ContainerSessionRunner) {
    // #1622 — record the install commands + the dependency input files
    // (lockfiles/manifests) so the runner can auto-reinstall when one of them
    // changes mid-session (e.g. a git reset that pulls in new deps). A
    // non-content-keyable install resolves to `null` → empty set → no
    // auto-reinstall, the safe default.
    //
    // Recorded even for an EMPTY command list: it is also the record of which
    // `agent.install` this session is currently running, which
    // `applyShipitConfigChange` diffs against when `shipit.yaml` changes. An
    // empty list still means "no auto-reinstall", exactly as before.
    //
    // docs/271 — this records the config's list, which the gate below may then
    // withhold, so `appliedInstallCommands` means "what `shipit.yaml` declares",
    // NOT "what ran". That is the right meaning for its one consumer (the
    // config-change diff): recording the withheld list is what stops the same
    // change re-triggering on every read, and a revert to an accepted list still
    // differs from it and so re-runs.
    runner.setDepReinstallInputs(
      installCommands,
      resolveDepsHashInputs(installCommands, shipitConfig.agent.installInputs) ?? [],
    );
    // An input set that resolved to nothing means the content key is off — no
    // install skip across commits, and no dependency re-check after a rewrite
    // ShipIt performs. Both are the right defaults; being told only once
    // something has already failed is not. Recorded here, the same place the
    // input set is resolved.
    reportContentKeyState(runner.sessionId, workspaceDir, shipitConfig.agent);
  }
  if (installCommands.length > 0 && runner instanceof ContainerSessionRunner) {
    installPromise = runner.runInstall(installCommands).catch((err: unknown) => {
      console.error(`[install:${runner.sessionId}] Install failed:`, getErrorMessage(err));
      return { ok: false };
    });
  }

  // docs/183 Phase 4b — once install resolves, publish each declared dep dir's
  // merged snapshot as the next rolling overlay base. Placed here (before the
  // compose/adoption branches) so it runs for every session, including projects
  // with no compose stack that still install deps. Best-effort and fully gated:
  // the store is ON by default, so the hook no-ops only when the
  // `OVERLAY_DEP_STORE=0`/`false` kill switch is set or the session is
  // overlay-ineligible, and a publish failure never affects the install or session.
  if (installPromise && publishOverlayBases && session && runner instanceof ContainerSessionRunner) {
    const p = installPromise;
    const r = runner;
    const s = session;
    void (async () => {
      const res = await p;
      // docs/271 — a WITHHELD install ran nothing, so publishing would stamp the
      // rolling base pointer's `markerStamp.installCommands` with a command list
      // that never executed (`overlay-publish.ts:200-212`). A later fresh session
      // at the same commit would then get a pre-stamped marker asserting those
      // commands installed — which is precisely the anchor this gate reads, so
      // the gate would launder the plugin's list into its own accepted list.
      if (res.withheld) return;
      // ...and an UNVERIFIED one observed no install either, which the publisher
      // cannot tell from a real success: it takes `installOk` at face value and
      // stamps the pointer's `markerStamp.installCommands` with the declared
      // list. Three paths resolve `ok: true` having watched nothing happen —
      // dispose, dispose-before-worker-ready, and the reconnect resync that
      // cannot tell success from failure — so without this a dropped SSE stream
      // could snapshot a missing or half-installed dep tree, publish it as the
      // SHARED base for the whole scope, and hand every later session at this
      // commit a pre-stamped marker asserting those commands installed.
      if (res.unverified) return;
      try {
        const outcomes = await publishOverlayBases({
          runner: r,
          session: s,
          installOk: res.ok,
          installCommands,
        });
        // docs/183 — emit one greppable measurement line per overlay session so the
        // warm-vs-cold + depth-cap data can be tabulated off service logs. A
        // non-empty outcome list means overlay was active (flag on + eligible), so
        // this is inert for non-overlay sessions.
        if (outcomes.length > 0 && s.remoteUrl) {
          console.log(formatOverlayMeasurement({
            sessionId: r.sessionId,
            repoUrl: s.remoteUrl,
            installOk: res.ok,
            installDurationMs: Date.now() - installStartedAt,
            outcomes,
          }));
        }
      } catch (err) {
        console.error(`[overlay-publish:${r.sessionId}] publish failed:`, getErrorMessage(err));
      }
    })();
  }

  // docs/088 — install npm packages for enabled stdio MCP servers at session
  // activation, alongside `agent.install`. Fire-and-forget; per-package
  // failures surface as `mcp_server_status` events from the worker.
  if (credentialStore && runner instanceof ContainerSessionRunner) {
    const mcpPackages = Object.values(credentialStore.getAllMcpServers())
      .filter((s) => s.enabled && s.type === "stdio" && s.npmPackage)
      .map((s) => (s as { npmPackage?: string }).npmPackage)
      .filter((p): p is string => !!p);
    if (mcpPackages.length > 0) {
      void runner.installMcpPackages(mcpPackages).catch((err: unknown) => {
        console.error(`[mcp-install:${runner.sessionId}] failed:`, getErrorMessage(err));
      });
    }
  }

  // docs/262 req 5 — a project that declares plugins gets their services whether
  // or not it declares a stack of its own: wiring a plugin in costs ONE
  // declaration, and requiring an otherwise-empty `compose:` block plus a
  // docker-compose.yml to hang it on would be exactly the per-project
  // boilerplate that requirement rules out. The manager is created for the
  // declaration, not for the services — which repository has been fetched, and
  // what it exports, is not knowable here (activation is fire-and-forget), so
  // `start()` is what finds nothing to run and says so.
  const pluginsMayProvideServices = shipitConfig.plugins.uses.length > 0;
  if (!shipitConfig.compose && !pluginsMayProvideServices) {
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    runner.on("disposed", () => composeNotConfigured.delete(runner.sessionId));
    return;
  }
  // Compose is now configured — clear stale not-configured flag
  composeNotConfigured.delete(runner.sessionId);
  const composeConfig = shipitConfig.compose ?? DEFAULT_COMPOSE_CONFIG;

  // Workspace volume info for compose volume rewriting: user `.:/workspace`
  // bind mounts must map to the same storage as the agent container.
  const wsVolume = process.env.WORKSPACE_VOLUME;
  const wsSubpath = wsVolume ? workspaceDir.replace(/^\/workspace\//, "") : undefined;

  // Secrets loader — resolves to the user-saved secrets for this session's
  // repo. Each session activation reads the latest values from the database,
  // so secrets edited while the session was idle are picked up on next start.
  // Sessions without a remoteUrl (e.g. brand-new local-only ones) get an
  // empty record — services that declare `x-shipit-secrets` will start with
  // those env vars unset until the user configures them.
  const secretsLoader = secretStore
    ? async () => {
        const s = sessionManager.get(runner.sessionId);
        const remoteUrl = s?.remoteUrl;
        if (!remoteUrl) return {};
        return secretStore.loadSecrets(remoteUrl);
      }
    : undefined;

  // docs/088 — account-level MCP secrets (`mcp__*` keys), and docs/252 phase 2
  // — the user's stored service credentials under their catalogue `storageEnv`
  // names. Read fresh from CredentialStore on every compose start/reconcile so
  // anything added while the session was idle is picked up on the next sync.
  //
  // The service credentials are the half that was MISSING: this loader used to
  // be `mcp__*`-only, which is precisely why a key saved in Settings reached a
  // compose-less session and not a compose-backed one (Appendix A).
  const accountAgentEnvLoader = credentialStore
    ? () => collectAccountAgentEnv(credentialStore)
    : undefined;

  // docs/262 req 23 — the credential NAMES this session's activated plugins
  // declare. Read fresh on every secrets pass, from each repository's LIVE
  // manifest, so a `shipit plugin refresh` that adds a credential shows up
  // without recreating the session. Names only: satisfaction is decided
  // against `secretsLoader`'s map — the consuming project's own store — and
  // never against `accountAgentEnvLoader`, which holds ShipIt's platform
  // credentials (req 23's boundary).
  const pluginCredentialsLoader = () => collectPluginCredentialDeclarations(workspaceDir);

  // ---- Adoption path: orphaned ServiceManager from a previous runner ----
  //
  // When a `restartAgent` recovery flow disposes the runner with
  // `preserveComposeOnDispose = true`, the previous runner's `disposed`
  // handler leaves the ServiceManager in `serviceManagers` so it can
  // be re-wired onto the freshly-created runner. The compose stack is
  // still running — we just need to:
  //   1. Hook the new runner's event listeners onto the existing manager.
  //   2. Re-connect the NEW agent container to the still-existing
  //      `shipit-session-{sid}` network (old container was destroyed).
  //   3. Re-arm the install-running gate around the new container's
  //      install (the workspace volume persists, but a service that
  //      races install on the new container still needs the retry
  //      treatment).
  //   4. Re-bind the `stack_error` listener to the new runner so logs
  //      reach the right place.
  //
  // See docs/127-restart-agent for the full flow.
  const existing = serviceManagers.get(runner.sessionId);
  if (existing) {
    const containServicesFn = containerManager?.isEgressContained(runner.sessionId)
      ? async (serviceNames: string[]) => containerManager.containComposeServices(runner.sessionId, serviceNames)
      : undefined;
    adoptExistingServiceManager(runner, existing, {
      serviceManagers,
      composeStopPromises,
      containerManager,
      broadcastLog,
      installPromise,
      secretsLoader,
      containServicesFn,
      containServiceDns: containerManager?.isEgressDnsContained(runner.sessionId) ?? false,
      containServiceProxy: containerManager?.isEgressProxyContained(runner.sessionId) ?? false,
      resetSessionNetwork: containerManager
        ? async () => containerManager.resetSessionNetwork(runner.sessionId)
        : undefined,
      prepareContainedStartFn: containerManager?.isEgressContained(runner.sessionId)
        ? async (serviceNames: string[]) => containerManager.prepareComposeServiceStart(runner.sessionId, serviceNames)
        : undefined,
      // #2426 — what the re-point needs to reach the new container's overlay.
      session,
      workspaceDir,
    });
    // Clear any stale migration warning — compose is now set up (still).
    composeWarnings.delete(runner.sessionId);
    return;
  }

  const mgr = new ServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    composeConfig,
    ...(shipitConfig.compose ? {} : { noProjectCompose: true }),
    workspaceVolume: wsVolume,
    workspaceSubpath: wsSubpath,
    stackName: process.env.DOCKER_STACK,
    opsSession: session?.kind === "ops",
    secretsLoader,
    accountAgentEnvLoader,
    pluginCredentialsLoader,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    serviceEnvDir,
    ...(logStore ? { logStore } : {}),
    networkJoinFn: containerManager
      ? async (networkName: string) => {
          // Connect agent container to compose network
          await containerManager.connectToNetwork(runner.sessionId, networkName);
          // Connect orchestrator container so the preview proxy can reach services
          try {
            const orchestratorId = (await import("node:os")).hostname();
            const docker = containerManager.getDockerClient();
            const network = docker.getNetwork(networkName);
            await network.connect({ Container: orchestratorId });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes("already exists")) {
              console.warn(`[compose] Failed to connect orchestrator to ${networkName}:`, msg);
            }
          }
        }
      : undefined,
    // docs/128 — periodic self-heal of the agent's compose-network attachment.
    // The agent (unlike the orchestrator, re-attached via networkJoinFn on every
    // compose op) can be stranded on a dead bridge when the ops docker-socket-proxy
    // is recreated by its own restart policy without the orchestrator running
    // `compose up`. This re-attaches it on the poll heartbeat; membership-gated so
    // it's a cheap no-op while the agent is correctly attached.
    networkHealFn: containerManager
      ? async (networkName: string) => {
          await containerManager.ensureConnectedToSessionNetwork(runner.sessionId, networkName);
        }
      : undefined,
    containServicesFn: containerManager?.isEgressContained(runner.sessionId)
      ? async (serviceNames: string[]) => {
          await containerManager.containComposeServices(runner.sessionId, serviceNames);
      }
      : undefined,
    containServiceDns: containerManager?.isEgressDnsContained(runner.sessionId) ?? false,
    containServiceProxy: containerManager?.isEgressProxyContained(runner.sessionId) ?? false,
    ensureSessionNetworkModeFn: containerManager
      ? async (internal: boolean) => containerManager.ensureSessionNetworkMode(runner.sessionId, internal)
      : undefined,
    prepareContainedStartFn: containerManager?.isEgressContained(runner.sessionId)
      ? async (serviceNames: string[]) => containerManager.prepareComposeServiceStart(runner.sessionId, serviceNames)
      : undefined,
  });

  serviceManagers.set(runner.sessionId, mgr);
  // Clear any stale migration warning — compose is now set up
  composeWarnings.delete(runner.sessionId);

  // Wire ServiceManager to runner for event relay to WS clients
  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  // Pipe `stack_error` into the per-session Logs panel for diagnostic
  // visibility. The throw path inside `mgr.start()` already emits a
  // `compose_error` WS banner (see the `void (async () => …)` block
  // below); the Logs entry here is *additional* — it preserves the
  // failure on the per-session ring buffer so a viewer that connects
  // after the error still sees what went wrong, and so the diagnostics
  // panel (Part 3 of feature 124) has it as one of its sources.
  // We also push a live `log_entry` to currently-attached viewers via
  // `runner.emitMessage`, since the persistent ring buffer alone wouldn't
  // surface to clients that are already connected (their WS handler's
  // wrapped `sessionBroadcastLog` is per-connection and we don't have a
  // reference to it here).
  // See docs/124-session-rescue-and-diagnostics §1.1.
  //
  // Store the bound listener so the runner's dispose handler can detach
  // it without stopping the manager (used by the `preserveComposeOnDispose`
  // adoption path).
  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  // Open the install-running gate while agent.install is in flight: a service
  // that exits non-zero during this window is retried with backoff instead
  // of being marked `error`. Once install resolves, the gate closes and the
  // manager does one explicit restart pass on services still in `error` /
  // pending-retry state. Skip when there's nothing to wait for.
  //
  // The ops finding of 2026-08-20 asked whether a withheld reinstall on a session
  // whose packages ShipIt discarded should close this gate as a FAILURE, holding
  // the gated services rather than starting them into an exit 127. It should
  // not, and the deciding evidence is in the finding itself: a second session
  // took the same rotation and the same withhold and came up SERVING, because
  // the shared base already satisfied its checkout.
  //
  // ShipIt cannot tell those two apart. The tempting proof — "the reaped overlay
  // upper was empty, so nothing was lost" — is not one: an empty upper says the
  // OLD lower satisfied this checkout and says nothing about the NEW generation
  // being mounted, which may have been published from a tree that dropped the
  // very package this branch needs. The signal is "unverified", full stop.
  //
  // Latching on an unverified means definite outages for healthy sessions, at
  // the scale of every session pinned to a superseded generation (34 on that
  // host), and it takes the diagnosis down with them — a service latched before
  // it ever starts produces no failure for anyone to read. Starting it costs a
  // crash loop in the genuinely-broken case — and by then ShipIt has usually
  // REPAIRED it instead: a withhold landing on an unvouched tree re-runs the
  // already-accepted list. The two states that reach here without a repair say
  // so through `ok`: a replay that failed, and a tree whose accepted list is
  // unknown and therefore unrepairable, both return `ok: false` and latch with a
  // cause attached.
  if (installPromise) {
    mgr.setInstallRunning(true);
    const p = installPromise;
    void (async () => {
      const res = await p;
      mgr.setInstallRunning(false, { failed: !res.ok });
    })();
  }

  // Clean up on runner dispose
  runner.on("disposed", () => {
    // Adoption path: the runner was disposed by a `restartAgent` recovery
    // flow that wants the compose stack preserved for the next runner. Detach
    // ONLY this runner's listeners (the new runner will re-attach via
    // adoptExistingServiceManager) and leave the manager in the map.
    if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
      mgr.off("stack_error", stackErrorListener);
      return;
    }
    serviceManagers.delete(runner.sessionId);
    // Track the in-flight stop so the NEXT setupServiceManager for this
    // session awaits it before calling mgr.start(). Same project name
    // (shipit-{sid12}) means an old `compose down` running in parallel
    // with the new `compose up` would tear down the new agent container.
    const removeVolumes = isContainerRunner(runner) && runner.removeVolumesOnDispose;
    trackComposeStop(composeStopPromises, runner.sessionId, mgr, { removeVolumes });
  });

  // Start the compose stack asynchronously — the full sequence (compose up →
  // network join → IP resolution → event flush) is handled inside mgr.start().
  // Install was already fired above (runs in parallel with compose).
  void (async () => {
    // Gate on any prior runner's pending compose-stop for this session.
    // Bounded to avoid hanging start() forever if `compose down` wedges.
    await awaitComposeStop(composeStopPromises, runner.sessionId);
    // docs/183 Phase 5 — hand the session's overlay dep-dir volumes to the
    // manager BEFORE the first start(), so compose services that share the
    // workspace also mount each dep dir's overlay volume nested at
    // `<service-target>/<dep-dir>`.
    await applyOverlayDepDirs(runner, mgr, { containerManager, session, workspaceDir, broadcastLog });
    // docs/262 — resolve the plugin services this session surfaces before the
    // first `start()`, so a plugin whose repository is already checked out comes
    // up with the project's own stack rather than one reconcile later. A
    // repository still being fetched settles afterwards and reaches the stack
    // through `emitPluginReposUpdated`.
    // Resolution AND the start go through the session's stack queue together
    // (see `serializeStackOp`): a plugin round that settles between them would
    // otherwise reconcile into a start that is still running.
    await serializeStackOp(runner.sessionId, async () => {
      await resolvePluginServicesInto(runner.sessionId, workspaceDir, mgr, deps);
      // The awaits above (a prior stack's `compose down`, worker readiness) can
      // each outlive the runner. Its `disposed` handler has by then dropped the
      // manager from `serviceManagers` and stopped it — but `start()` resets
      // `_disposed` and re-arms the poll loop, so going ahead here would leave an
      // orphaned manager polling Docker for a session nobody owns, with nothing
      // left to stop it. Checked as late as possible, immediately before the call.
      if (runner instanceof ContainerSessionRunner && runner.disposed) {
        console.log(`[compose:${runner.sessionId}] runner disposed before compose start — skipping`);
        return;
      }
      try {
        await mgr.start();
        console.log(`[compose:${runner.sessionId}] Compose stack started`);
      } catch (err) {
        const errMsg = getErrorMessage(err);
        console.error(`[compose:${runner.sessionId}] Failed to start compose stack:`, errMsg);
        mgr.startError = errMsg;
        runner.emitMessage({
          type: "compose_error",
          sessionId: runner.sessionId,
          message: errMsg,
        });
        // Also record into the per-session log ring so the Logs panel and the
        // future diagnostics endpoint (docs/124-session-rescue-and-diagnostics)
        // see the failure. Without this, the user gets the PreviewFrame banner
        // but the Logs panel is silent — a viewer who attaches after the fact
        // (or files a bug report) has no record of why the stack didn't come
        // up.
        if (broadcastLog) {
          broadcastLog(runner.sessionId, "server", `[compose] Failed to start: ${errMsg}`);
        }
      }
    });
  })();
}

/** Order-insensitive-free list comparison for `agent.install` command lists. */
function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cmd, i) => cmd === b[i]);
}

/**
 * Distinguish "the repo genuinely declares no `compose:`" from "we couldn't
 * read `shipit.yaml` just now".
 *
 * `resolveShipitConfig` conflates the two: a missing OR unreadable file both
 * fall back to defaults, which carry `compose: undefined`. For the initial
 * setup that conflation is harmless (nothing is running yet), but the mid-
 * session applier reads `compose: undefined` as "the block was removed — tear
 * the stack down". A transient read failure while git is rewriting the working
 * tree would then kill a perfectly good preview.
 *
 * So the teardown is gated on the file being genuinely absent, or present and
 * readable. Anything else means "don't know" — keep the stack and let the next
 * re-evaluation decide.
 */
function composeRemovalIsTrustworthy(workspaceDir: string): boolean {
  const yamlPath = path.join(workspaceDir, "shipit.yaml");
  try {
    fs.readFileSync(yamlPath, "utf-8");
    return true; // readable and parsed to no `compose:` — a real removal
  } catch (err) {
    // ENOENT is a real removal (no shipit.yaml at all ⇒ no compose declared).
    // Any other errno (EACCES, EIO, …) is "can't tell right now".
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Re-read `shipit.yaml` for a LIVE session and apply whatever changed.
 *
 * This is the single entry point for "the workspace's config may have moved
 * under us" — invoked from the config-file watcher AND from orchestrator-side
 * workspace rewrites (a rebase/sync onto the latest base can bring in a whole
 * new `shipit.yaml` and compose file; see `runRebaseFlow`).
 *
 * Why not just `mgr.reconcile()`? Because `reconcile()` only re-parses the
 * COMPOSE file. Everything `shipit.yaml` contributes — which compose file to
 * read, whether services get the Docker socket, what `agent.install` runs — is
 * captured once at session setup and was then frozen for the session's whole
 * life. A session created before the repo declared `compose:` (or before it
 * added an install step) would never pick it up short of a container restart,
 * which is exactly the "I rebased onto main and the new service never showed
 * up" report this closes.
 *
 * Deltas handled, in order:
 *  - **No manager yet** → delegate to `setupServiceManager`, which re-reads the
 *    config from scratch and does everything (including firing install). This
 *    is the compose-was-just-added case.
 *  - **Parse error** → surface it and keep the running stack. A half-written
 *    `shipit.yaml` (mid-edit, or conflict markers from a merge) must not tear
 *    down a working preview.
 *  - **`agent.install` changed** → re-record the dep-reinstall inputs and run
 *    the new commands, bracketed by the install gate. The worker's marker gate
 *    makes a no-op re-run cheap.
 *  - **`compose:` removed** → stop the stack and report not-configured.
 *  - **`compose:` changed / unchanged** → adopt the new block (if any) and
 *    reconcile, which re-parses the compose file and brings up new services.
 */
/**
 * docs/262 — tell attached viewers an activation round settled. `emitMessage`
 * (not `ctx.send`) so every viewer sees it and a reconnecting one replays it.
 */
/**
 * What a settled activation round needs to reach the rest of the session: the
 * session's ServiceManager (req 23 — a round can change WHICH credential names
 * the plugins declare, and `secrets_status` samples that only inside its own
 * sync pass) and the resolver that says what its plugin services now are
 * (reqs 3, 12).
 */
export type PluginServiceRefreshDeps = Pick<
  ServiceSetupDeps,
  "sessionManager" | "serviceManagers" | "resolvePluginServices"
>;

export function emitPluginReposUpdated(
  runner: SessionRunnerInterface,
  deps: PluginServiceRefreshDeps,
): (sessionId: string) => void {
  return (sessionId: string) => {
    runner.emitMessage({ type: "plugin_repos_updated", sessionId });
    // req 23 — without this the Secrets rows keep the previous declaration
    // until an unrelated reconcile. Container-free — see `refreshSecretsStatus`.
    void deps.serviceManagers.get(sessionId)?.refreshSecretsStatus().catch((err: unknown) => {
      console.warn(`[plugins:${sessionId}] secrets status resync failed:`, getErrorMessage(err));
    });
    // The generation is published by the time this fires, so the container can
    // safely link it. Optional call, not an `in` guard: local
    // mode has no container to prepare, and that is the correct answer there
    // rather than a missing capability to work around.
    const container = runner as SessionRunnerInterface & { preparePlugins?: () => Promise<void> };
    void container.preparePlugins?.();
    // docs/262 reqs 3, 12 — and the same for the session's SERVICES. This is
    // what makes `shipit plugin refresh` reach a running plugin service: the
    // round has just published a new generation, so the fragment, its overlay
    // volume and its commit env are all different from what the stack is
    // running. Reconciling only on an actual change keeps an ordinary round —
    // one fires on every session activation and every `shipit.yaml` edit — from
    // restarting containers that nothing happened to.
    void refreshPluginServices(runner, deps);
  };
}

/**
 * Bring a live stack's plugin services up to date with what is now activated.
 *
 * Fire-and-forget and never throws: the activation round is already over, the
 * card already reports what happened, and a session whose plugin services could
 * not be reconciled still has its own (req 13).
 */
async function refreshPluginServices(
  runner: SessionRunnerInterface,
  deps: PluginServiceRefreshDeps,
): Promise<void> {
  const mgr = deps.serviceManagers.get(runner.sessionId);
  if (!mgr || !deps.resolvePluginServices) return;
  const session = deps.sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;
  try {
    // Inside the queue, not before it: this rounds's answer must be compared
    // against what the stack has ACTUALLY consumed. Resolving first and queueing
    // second would compare against a `start()` that has not read the services
    // yet, and then reconcile a stack that already has them.
    await serializeStackOp(runner.sessionId, async () => {
      const { changed, count } = await resolvePluginServicesInto(
        runner.sessionId, workspaceDir, mgr, deps,
      );
      if (!changed) return;
      console.log(
        `[plugins:${runner.sessionId}] plugin services changed (${count}) — reconciling`,
      );
      await mgr.reconcile();
    });
  } catch (err) {
    console.error(`[plugins:${runner.sessionId}] plugin service reconcile failed:`, getErrorMessage(err));
  }
}

/**
 * Re-resolve the plugin services this session surfaces and hand them to its
 * manager. Reports whether the surfaced set actually changed, and how many
 * services it now holds.
 *
 * **The caller must already hold the session's stack op** ({@link
 * serializeStackOp}, which is not reentrant). The answer is only worth as much
 * as its adjacency to the `start()` that consumes it: resolved outside the
 * queue, it is compared against a stack that may not have read the previous
 * answer yet.
 *
 * A resolution that throws leaves the previous set in place. This is the LAST
 * resort, not the failure policy: the resolver's own contract is that it never
 * fails a session, and its one daemon round-trip degrades to a per-repository
 * reason on the card instead of throwing (`resolveSessionPluginServices`), so
 * reaching this catch means a fault nothing can attribute. Then the previous set
 * is the least-bad answer — refusing the project's own reconcile over a plugin
 * fault inverts req 14, and dropping every repository's services over a fault
 * none of them can be blamed for takes working siblings away, which is the
 * asymmetry `plugin-preflight.ts` already establishes. `changed: false` likewise
 * when no resolver is wired at all: local mode has no Compose, and most unit
 * setups have no Docker.
 */
async function resolvePluginServicesInto(
  sessionId: string,
  workspaceDir: string,
  mgr: ServiceManager,
  deps: Pick<ServiceSetupDeps, "resolvePluginServices">,
): Promise<{ changed: boolean; count: number }> {
  if (!deps.resolvePluginServices) return { changed: false, count: 0 };
  try {
    const services = await deps.resolvePluginServices(sessionId, workspaceDir);
    return { changed: mgr.setPluginServices(services), count: services.length };
  } catch (err) {
    console.error(`[plugins:${sessionId}] service resolution failed:`, getErrorMessage(err));
    return { changed: false, count: 0 };
  }
}

/**
 * Bring the session's content-key record up to date, and log when the state is
 * newly reportable. Detection and reporting only — nothing here changes which
 * installs run (`install-content-key.ts`).
 *
 * Called from both config paths, so the log line is one per *distinct*
 * `agent.install`, not one per container recreate or activation.
 */
function reportContentKeyState(
  sessionId: string,
  workspaceDir: string,
  agent: ContentKeyConfig,
): void {
  if (!evaluateContentKeyReport(workspaceDir, agent)) return;
  console.warn(
    `[install:${sessionId}] agent.install is not content-keyable and agent.install-inputs is ` +
      "not declared — the cross-commit install skip and the post-rewrite dependency re-check " +
      "are both off for this session (see session diagnostics)",
  );
}

export function applyShipitConfigChange(
  runner: SessionRunnerInterface,
  deps: ServiceSetupDeps,
): void {
  const {
    sessionManager,
    serviceManagers,
    composeStopPromises,
    composeWarnings,
    composeNotConfigured,
  } = deps;

  const mgr = serviceManagers.get(runner.sessionId);
  if (!mgr) {
    // Compose was never configured for this session (or the trust gate deferred
    // setup). The full setup path re-reads everything and owns install too.
    setupServiceManager(runner, deps);
    return;
  }

  const session = sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;

  let shipitConfig;
  try {
    shipitConfig = resolveShipitConfig(workspaceDir);
  } catch (err) {
    const message = `shipit.yaml is invalid — keeping the previous configuration:\n${getErrorMessage(err)}`;
    composeWarnings.set(runner.sessionId, message);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message });
    return;
  }

  // Mirror `setupServiceManager`'s warning handling so a migration hint added
  // (or fixed) by the incoming config lands in the preview panel either way.
  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: text });
  } else if (composeWarnings.has(runner.sessionId)) {
    composeWarnings.delete(runner.sessionId);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: "" });
  }

  // ---- plugin declarations delta (docs/262) ----
  // Unconditional: activation is a no-op when the resolved commit is already
  // live, so the cheap check lives there rather than in a config diff here.
  // Trust is inherited — this path only runs once a ServiceManager exists,
  // which `setupServiceManager` creates only past the gate.
  deps.activatePluginRepos?.(runner.sessionId, workspaceDir, emitPluginReposUpdated(runner, deps));

  // ---- agent.install delta ----
  if (runner instanceof ContainerSessionRunner) {
    const nextCommands = shipitConfig.agent.install;
    // Outside the delta below on purpose: adding `agent.install-inputs` is the
    // remedy the diagnostics notice names, and it leaves `agent.install`
    // untouched — so gating this on a changed command list would leave the
    // panel reporting a state the user has just fixed.
    reportContentKeyState(runner.sessionId, workspaceDir, shipitConfig.agent);
    if (!sameCommands(runner.appliedInstallCommands, nextCommands)) {
      console.log(
        `[install:${runner.sessionId}] agent.install changed — re-running (${nextCommands.length} command(s))`,
      );
      runner.setDepReinstallInputs(
        nextCommands,
        resolveDepsHashInputs(nextCommands, shipitConfig.agent.installInputs) ?? [],
      );
      // Bracketed by the install gate + the shared reinstall cooldown, so a
      // burst of config rewrites (a rebase touching several files) coalesces
      // into one trailing install rather than a storm.
      runner.requestDepReinstall();
    }
  }

  // ---- compose delta ----
  if (!shipitConfig.compose && shipitConfig.plugins.uses.length === 0) {
    if (!composeRemovalIsTrustworthy(workspaceDir)) {
      console.warn(
        `[compose:${runner.sessionId}] shipit.yaml unreadable — keeping the running stack`,
      );
      return;
    }
    // The `compose:` block was removed. Tear the stack down rather than leaving
    // orphaned containers running against a definition the repo no longer has.
    console.log(`[compose:${runner.sessionId}] compose config removed — stopping stack`);
    serviceManagers.delete(runner.sessionId);
    runner.setServiceManager?.(null);
    trackComposeStop(composeStopPromises, runner.sessionId, mgr);
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    return;
  }

  composeNotConfigured.delete(runner.sessionId);
  // docs/262 — with the `compose:` block gone but plugins still declared, the
  // stack is the plugin services alone; the project's own file is then allowed
  // to be absent (req 5, see `setupServiceManager`).
  const nextComposeConfig = shipitConfig.compose ?? DEFAULT_COMPOSE_CONFIG;
  if (mgr.updateComposeConfig(nextComposeConfig, { noProjectCompose: !shipitConfig.compose })) {
    console.log(
      `[compose:${runner.sessionId}] compose config changed — reconciling against ${nextComposeConfig.file}`,
    );
  }
  // Through the same queue as the first start and the plugin-settled reconcile:
  // `reconcile()` clears the service map, the poller, the log followers and the
  // in-flight bookkeeping before calling `start()`, so two of them overlapping
  // is not a harmless duplicate refresh (review finding). A burst of file events
  // is coalesced into an ordered sequence.
  void serializeStackOp(runner.sessionId, async () => {
    // docs/262 req 20 — the project's OWN service names are an input to the
    // plugin service set (`collectPluginFragments` seeds the name domain with
    // them, and they always win), and this is the one moment they can change.
    // Without this the reconcile below would merge the plugin set resolved
    // against the PREVIOUS project file with the file it is about to run, so a
    // service name the project just took would be handed to Compose as two
    // definitions of one name — the plugin's overlaying the user's — and the
    // collision would only be computed when some later activation round
    // happened to settle, which for a repository that has to be fetched is
    // network-far away. Req 20 asks for the report BEFORE the ambiguous one
    // runs, so the computation has to run before the override is generated,
    // not after it is up. It is the existing computation, not a second one:
    // this re-resolves through `resolveSessionPluginServices`, whose collision
    // domain is seeded by a fresh read of the project's compose file.
    if ((await resolvePluginServicesInto(runner.sessionId, workspaceDir, mgr, deps)).changed) {
      // The withholding without the report is half of req 20 — a plugin's
      // service would simply vanish from the list. The Plugins card recomputes
      // the collision itself on every snapshot (`api-routes-plugin-repos.ts`),
      // so telling viewers to refetch is what makes the reason arrive with the
      // change rather than whenever the fetch behind the next round finishes.
      runner.emitMessage({ type: "plugin_repos_updated", sessionId: runner.sessionId });
    }
    await mgr.reconcile();
  }).catch((err: unknown) => {
    const errMsg = getErrorMessage(err);
    console.error(`[compose:${runner.sessionId}] Reconcile after config change failed:`, errMsg);
    mgr.startError = errMsg;
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: errMsg });
    deps.broadcastLog?.(runner.sessionId, "server", `[compose] Reconcile failed: ${errMsg}`);
  });
}
