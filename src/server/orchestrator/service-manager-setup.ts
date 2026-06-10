import { ContainerSessionRunner } from "./container-session-runner.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import { ServiceManager } from "./service-manager.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { SecretStore } from "./secret-store.js";
import type { CredentialStore } from "./credential-store.js";
import type { WsLogEntry } from "../shared/types.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { collectMcpAgentEnv } from "./secret-resolver.js";
import { getErrorMessage } from "./validation.js";

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
  broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void,
): void {
  const text = `[compose] Stack error: ${err.message}`;
  if (broadcastLog) broadcastLog(runner.sessionId, "server", text);
  runner.emitMessage({
    type: "log_entry",
    source: "server",
    text,
    timestamp: new Date().toISOString(),
  });
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
    broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
    installPromise: Promise<{ ok: boolean }> | null;
    /**
     * Fresh closure that reads the session's latest secrets (the OLD
     * closure baked into `mgr` references the disposed runner; safe today
     * because both closures read by sessionId, but defensive in case a
     * future refactor makes the loader less idempotent — e.g. a per-runner
     * secret store wrapper, or a remoteUrl change between disposals).
     */
    secretsLoader?: () => Promise<Record<string, string>>;
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
      .then(() => containerManager.connectToNetwork(runner.sessionId, networkName))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          console.warn(
            `[compose:${runner.sessionId}] reconnect to ${networkName} failed:`,
            msg,
          );
        }
      });
  }

  // 3. Re-bind stack_error to the new runner so error logs route to the
  //    right place.
  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

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
 * Create and wire a ServiceManager for a runner's session if compose config
 * is detected. Fire-and-forget — compose stack start is async.
 */
export function setupServiceManager(
  runner: SessionRunnerInterface,
  deps: {
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
     * outside the agent's workspace mount. Passed to `ServiceManager`.
     */
    serviceEnvDir?: string;
    broadcastLog?: (sessionId: string, source: WsLogEntry["source"], text: string) => void;
    /** docs/088 — account-level MCP secrets store. */
    credentialStore?: CredentialStore;
  },
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
    broadcastLog,
    credentialStore,
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
  if (installCommands.length > 0 && runner instanceof ContainerSessionRunner) {
    installPromise = runner.runInstall(installCommands).catch((err: unknown) => {
      console.error(`[install:${runner.sessionId}] Install failed:`, getErrorMessage(err));
      return { ok: false };
    });
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

  if (!shipitConfig.compose) {
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    runner.on("disposed", () => composeNotConfigured.delete(runner.sessionId));
    return;
  }
  // Compose is now configured — clear stale not-configured flag
  composeNotConfigured.delete(runner.sessionId);

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

  // docs/088 — account-level MCP secrets (`mcp__*` keys). Read fresh from
  // CredentialStore on every compose start/reconcile so a server added while
  // the session was idle is picked up on next sync.
  const mcpAgentEnvLoader = credentialStore
    ? () => collectMcpAgentEnv(credentialStore)
    : undefined;

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
    adoptExistingServiceManager(runner, existing, {
      serviceManagers,
      composeStopPromises,
      containerManager,
      broadcastLog,
      installPromise,
      secretsLoader,
    });
    // Clear any stale migration warning — compose is now set up (still).
    composeWarnings.delete(runner.sessionId);
    return;
  }

  const mgr = new ServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    composeConfig: shipitConfig.compose,
    workspaceVolume: wsVolume,
    workspaceSubpath: wsSubpath,
    stackName: process.env.DOCKER_STACK,
    opsSession: session?.kind === "ops",
    secretsLoader,
    mcpAgentEnvLoader,
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    ...(serviceEnvDir ? { serviceEnvDir } : {}),
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
