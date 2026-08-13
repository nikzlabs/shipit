import fs from "node:fs";
import path from "node:path";
import { ContainerSessionRunner } from "./container-session-runner.js";
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
import { agentLogAppend } from "./log-emit.js";
import { collectAccountAgentEnv } from "./secret-resolver.js";
import { getErrorMessage } from "./validation.js";
import { formatOverlayMeasurement, type DepDirPublishOutcome } from "./overlay-publish.js";
import { isOverlayEligible } from "./overlay-session.js";
import { clearActivationState } from "./services/plugin-activation.js";
import { collectPluginCredentialDeclarations } from "./plugin-credentials.js";
import type { PluginComposeService } from "./plugin-compose.js";

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
    installPromise: Promise<{ ok: boolean }> | null;
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
        if (containmentChanged) {
          await policyTransition;
          await deps.resetSessionNetwork?.();
          await mgr.reconcile();
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
      await mgr.reconcile();
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
 * docs/262 — the compose configuration a project that declares only plugins
 * runs under. The file name is conventional and, in this case, deliberately
 * expected NOT to exist: the manager is told the project file is optional, so
 * the generated override (which is where plugin services live) is the whole
 * stack. Naming the conventional file rather than a sentinel means a project
 * that later adds a `docker-compose.yml` without a `compose:` block still picks
 * it up, which is what someone writing that file expects to happen.
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
  let installPromise: Promise<{ ok: boolean }> | null = null;
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
    runner.setDepReinstallInputs(
      installCommands,
      resolveDepsHashInputs(installCommands, shipitConfig.agent.installInputs) ?? [],
    );
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
    });
    // Clear any stale migration warning — compose is now set up (still).
    composeWarnings.delete(runner.sessionId);
    return;
  }

  const mgr = new ServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    composeConfig,
    ...(shipitConfig.compose ? {} : { composeFileOptional: true }),
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
    // docs/183 Phase 5 — resolve the session's overlay dep-dir volumes and hand
    // them to the manager BEFORE the first start(), so compose services that
    // share the workspace also mount each dep dir's overlay volume nested at
    // `<service-target>/<dep-dir>`. The `isOverlayEligible` pre-gate is a pure
    // env+session check, so for flag-off / ineligible sessions this block is
    // inert and the override (and compose start timing) is byte-for-byte
    // unchanged.
    //
    // The override references each overlay volume as `external: true`, and the
    // volumes are created at agent-container-create time — so compose may only
    // mount what that container was actually built with. Re-deriving
    // eligibility here can disagree with the provisioned state (observed live:
    // a container created before OVERLAY_DEP_STORE was enabled has no overlay
    // volumes, and the recomputed reference failed the whole `compose up` with
    // "external volume not found"). `whenWorkerReady()` orders us after
    // container creation (volumes are created just before the container — and
    // dispose also resolves it, hence the `disposed` re-check), then
    // `requireProvisioned` keeps only specs whose volume really exists.
    if (
      containerManager && session && runner instanceof ContainerSessionRunner &&
      isOverlayEligible(session)
    ) {
      try {
        await runner.whenWorkerReady();
        if (!runner.disposed) {
          const specs = await containerManager.prepareOverlaySpecs({
            sessionId: runner.sessionId,
            workspaceDir,
            session,
            requireProvisioned: true,
          });
          if (specs.length > 0) {
            mgr.setOverlayDepDirs(specs.map((s) => ({ depDir: s.depDir, volumeName: s.volumeName })));
          }
        }
      } catch (err) {
        console.error(`[overlay:${runner.sessionId}] dep-dir spec resolution failed:`, getErrorMessage(err));
      }
    }
    // docs/262 — resolve the plugin services this session surfaces before the
    // first `start()`, so a plugin whose repository is already checked out comes
    // up with the project's own stack rather than one reconcile later. A
    // repository still being fetched settles afterwards and reaches the stack
    // through `emitPluginReposUpdated`.
    if (deps.resolvePluginServices) {
      try {
        mgr.setPluginServices(await deps.resolvePluginServices(runner.sessionId, workspaceDir));
      } catch (err) {
        console.error(`[plugins:${runner.sessionId}] service resolution failed:`, getErrorMessage(err));
      }
    }
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
    const services = await deps.resolvePluginServices(runner.sessionId, workspaceDir);
    if (!mgr.setPluginServices(services)) return;
    console.log(
      `[plugins:${runner.sessionId}] plugin services changed (${services.length}) — reconciling`,
    );
    await mgr.reconcile();
  } catch (err) {
    console.error(`[plugins:${runner.sessionId}] plugin service reconcile failed:`, getErrorMessage(err));
  }
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
  if (mgr.updateComposeConfig(nextComposeConfig, { fileOptional: !shipitConfig.compose })) {
    console.log(
      `[compose:${runner.sessionId}] compose config changed — reconciling against ${nextComposeConfig.file}`,
    );
  }
  void mgr.reconcile().catch((err: unknown) => {
    const errMsg = getErrorMessage(err);
    console.error(`[compose:${runner.sessionId}] Reconcile after config change failed:`, errMsg);
    mgr.startError = errMsg;
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: errMsg });
    deps.broadcastLog?.(runner.sessionId, "server", `[compose] Reconcile failed: ${errMsg}`);
  });
}
