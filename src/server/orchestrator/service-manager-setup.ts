import fs from "node:fs";
import path from "node:path";
import { ContainerSessionRunner, type InstallCompletion } from "./container-session-runner.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { SessionContainerManager } from "./session-container.js";
import { ServiceManager } from "./service-manager.js";
import type { SessionManager } from "./sessions.js";
import type { RepoStore } from "./repo-store.js";
import type { SecretStore } from "./secret-store.js";
import type { CredentialStore } from "./credential-store.js";
import type { LogSource, SessionInfo } from "../shared/types.js";
import type { LogStore } from "./log-store.js";
import { resolveShipitConfig, type ShipitConfig } from "../shared/shipit-config.js";
import { resolveDepsHashInputs } from "../shared/deps-hash.js";
import { evaluateContentKeyReport, type ContentKeyConfig } from "./install-content-key.js";
import { agentLogAppend, appendAgentLog } from "./log-emit.js";
import { collectAccountAgentEnv } from "./secret-resolver.js";
import { getErrorMessage } from "./validation.js";
import { formatOverlayMeasurement, type DepDirPublishOutcome } from "./overlay-publish.js";
import { isOverlayEligible } from "./overlay-session.js";
import { volumeExists } from "./overlay-volume.js";
import { clearActivationState } from "./services/plugin-activation.js";
import { collectPluginCredentialDeclarations } from "./plugin-credentials.js";
import type { PluginComposeService } from "./plugin-compose.js";
import { serializeStackOp } from "./stack-op-queue.js";

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
  if (!containerManager || !session || !isContainerRunner(runner) || !isOverlayEligible(session)) return false;

  // Volumes must exist first; disposal also resolves readiness.
  await runner.whenWorkerReady();
  if (runner.disposed) return false;

  return applyOverlayDepDirsForSession(runner.sessionId, mgr, {
    containerManager, session, workspaceDir,
    ...(broadcastLog ? { broadcastLog } : {}),
  });
}

export async function applyOverlayDepDirsForSession(
  sessionId: string,
  mgr: ServiceManager,
  deps: {
    containerManager: SessionContainerManager;
    session: SessionInfo;
    workspaceDir: string;
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  },
): Promise<boolean> {
  const { containerManager, session, workspaceDir, broadcastLog } = deps;
  if (!isOverlayEligible(session)) return false;

  const warn = (text: string): void => {
    console.warn(`[overlay:${sessionId}] ${text}`);
    if (broadcastLog) broadcastLog(sessionId, "server", `[compose] ${text}`);
  };

  try {
    // Match the provisioned container; workspace configuration may have changed since creation.
    const provisioned = containerManager.provisionedOverlayDepDirs(sessionId);
    const pairs = provisioned ?? (await containerManager.prepareOverlaySpecs({
      sessionId,
      workspaceDir,
      session,
      requireProvisioned: true,
    })).map((s) => ({ depDir: s.depDir, volumeName: s.volumeName }));

    // An empty record is authoritative; an empty fallback must not replace a known set.
    if (pairs.length === 0) {
      if (provisioned) {
        mgr.setOverlayDepDirs([]);
        console.log(
          `[overlay:${sessionId}] agent container has no dependency overlay — ` +
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
    // Rotating a volume can remove service containers without changing volume names.
    const recreated = containerManager.consumeOverlayVolumesRecreated(sessionId);
    if (recreated) {
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

function isContainerRunner(
  runner: SessionRunnerInterface,
): runner is SessionRunnerInterface & ContainerSessionRunner {
  return runner instanceof ContainerSessionRunner;
}

export type WorkerInstallDecision = "skipped" | "started";

export function adoptExistingServiceManager(
  runner: SessionRunnerInterface,
  mgr: ServiceManager,
  deps: {
    serviceManagers: Map<string, ServiceManager>;
    composeStopPromises: Map<string, Promise<void>>;
    containerManager: SessionContainerManager | null;
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
    installPromise: Promise<InstallCompletion> | null;
    onInstallDecision?: (fn: (decision: WorkerInstallDecision) => void) => void;
    composeConfig?: { file: string; dockerSocket: boolean };
    noProjectCompose?: boolean;
    secretsLoader?: () => Promise<Record<string, string>>;
    containServicesFn?: (serviceNames: string[]) => Promise<void>;
    containServiceDns?: boolean;
    containServiceProxy?: boolean;
    resetSessionNetwork?: () => Promise<void>;
    prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
    session?: SessionInfo;
    workspaceDir?: string;
  },
): void {
  const { serviceManagers, composeStopPromises, containerManager, broadcastLog, installPromise, secretsLoader } = deps;

  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  if (secretsLoader) {
    mgr.setSecretsLoader(secretsLoader);
  }

  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  // Claim refresh can change the warm stack's definition before its watcher starts.
  const wasPreStartedWarm = mgr.preStartedWarm;
  if (wasPreStartedWarm) {
    mgr.preStartedWarm = false;
    if (deps.composeConfig && typeof mgr.updateComposeConfig === "function") {
      mgr.updateComposeConfig(deps.composeConfig, { noProjectCompose: deps.noProjectCompose ?? false });
    }
  }

  const containmentChanged = typeof mgr.updateEgressContainment === "function"
    ? mgr.updateEgressContainment(
        deps.containServicesFn,
        deps.containServiceDns ?? false,
        deps.containServiceProxy ?? false,
        deps.prepareContainedStartFn,
      )
    : false;
  // Stop old-policy services before waiting for the worker, then reset their network.
  const policyTransition = containmentChanged
    ? mgr.stop().catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        mgr.emit("stack_error", normalized);
        throw normalized;
      })
    : Promise.resolve();
  // The new container must exist before reconnecting it to the surviving network.
  if (containerManager && isContainerRunner(runner)) {
    const networkName = `shipit-session-${runner.sessionId}`;
    // eslint-disable-next-line no-restricted-syntax -- fire-and-forget after async readiness signal
    void runner
      .whenWorkerReady()
      .then(async () => {
        // Refresh mounts before reconcile writes the override.
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
        if (containmentChanged || overlayChanged || wasPreStartedWarm) {
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
  } else if (containmentChanged || wasPreStartedWarm) {
    void (async () => {
      await policyTransition;
      await deps.resetSessionNetwork?.();
      await serializeStackOp(runner.sessionId, () => mgr.reconcile());
    })().catch((error: unknown) => {
      mgr.emit("stack_error", error instanceof Error ? error : new Error(getErrorMessage(error)));
    });
  }

  // A skipped install must not stop an already-running warm stack.
  if (installPromise) {
    const p = installPromise;
    // Close only a gate this call opened; another caller may already hold it.
    let opened = false;
    const openGate = (): void => {
      if (!opened) opened = mgr.setInstallRunning(true);
    };
    // Opening the gate clears this latch.
    const wasLatchedFailed = mgr.installGateFailed ?? false;
    if (deps.onInstallDecision) {
      deps.onInstallDecision((decision) => { if (decision === "started") openGate(); });
    } else {
      openGate();
    }
    void (async () => {
      const res = await p;
      // Latch failures; clear an earlier failure only with verified success.
      const provenGood = res.ok && !res.unverified;
      if (!res.ok || (wasLatchedFailed && provenGood)) openGate();
      if (opened) mgr.setInstallRunning(false, { failed: !res.ok });
    })();
  }

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

export const COMPOSE_STOP_WAIT_TIMEOUT_MS = 15_000;

// Placeholder only: noProjectCompose prevents loading an undeclared project file.
const DEFAULT_COMPOSE_CONFIG = { file: "docker-compose.yml", dockerSocket: false } as const;

export type ServiceManagerBuildDeps = Pick<
  ServiceSetupDeps,
  | "sessionManager"
  | "containerManager"
  | "secretStore"
  | "credentialStore"
  | "dockerSecretsConfig"
  | "serviceEnvDir"
  | "logStore"
>;

export function createSecretsLoader(
  sessionId: string,
  deps: Pick<ServiceManagerBuildDeps, "sessionManager" | "secretStore">,
): (() => Promise<Record<string, string>>) | undefined {
  const { sessionManager, secretStore } = deps;
  if (!secretStore) return undefined;
  return async () => {
    const remoteUrl = sessionManager.get(sessionId)?.remoteUrl;
    if (!remoteUrl) return {};
    return secretStore.loadSecrets(remoteUrl);
  };
}

/** Shared construction for activation and warm pre-start; callers attach listeners and start. */
export function buildServiceManager(args: {
  sessionId: string;
  workspaceDir: string;
  session: SessionInfo | undefined;
  shipitConfig: ShipitConfig;
  deps: ServiceManagerBuildDeps;
}): ServiceManager {
  const { sessionId, workspaceDir, session, shipitConfig, deps } = args;
  const { containerManager, credentialStore, dockerSecretsConfig, serviceEnvDir, logStore } = deps;

  const wsVolume = process.env.WORKSPACE_VOLUME;
  const wsSubpath = wsVolume ? workspaceDir.replace(/^\/workspace\//, "") : undefined;

  const accountAgentEnvLoader = credentialStore
    ? () => collectAccountAgentEnv(credentialStore)
    : undefined;

  return new ServiceManager({
    sessionId,
    workspaceDir,
    composeConfig: shipitConfig.compose ?? DEFAULT_COMPOSE_CONFIG,
    ...(shipitConfig.compose ? {} : { noProjectCompose: true }),
    workspaceVolume: wsVolume,
    workspaceSubpath: wsSubpath,
    stackName: process.env.DOCKER_STACK,
    opsSession: session?.kind === "ops",
    secretsLoader: createSecretsLoader(sessionId, deps),
    accountAgentEnvLoader,
    pluginCredentialsLoader: () => collectPluginCredentialDeclarations(workspaceDir),
    ...(dockerSecretsConfig ? { dockerSecretsConfig } : {}),
    serviceEnvDir,
    ...(logStore ? { logStore } : {}),
    networkJoinFn: containerManager
      ? async (networkName: string) => {
          await containerManager.connectToNetwork(sessionId, networkName);
          // The preview proxy needs the orchestrator on this network too.
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
    networkHealFn: containerManager
      ? async (networkName: string) => {
          await containerManager.ensureConnectedToSessionNetwork(sessionId, networkName);
        }
      : undefined,
    containServicesFn: containerManager?.isEgressContained(sessionId)
      ? async (serviceNames: string[]) => {
          await containerManager.containComposeServices(sessionId, serviceNames);
        }
      : undefined,
    containServiceDns: containerManager?.isEgressDnsContained(sessionId) ?? false,
    containServiceProxy: containerManager?.isEgressProxyContained(sessionId) ?? false,
    ensureSessionNetworkModeFn: containerManager
      ? async (internal: boolean) => containerManager.ensureSessionNetworkMode(sessionId, internal)
      : undefined,
    prepareContainedStartFn: containerManager?.isEgressContained(sessionId)
      ? async (serviceNames: string[]) => containerManager.prepareComposeServiceStart(sessionId, serviceNames)
      : undefined,
    // API trust must track new containers even when egress is unrestricted.
    ...(containerManager
      ? { onTopologyChange: () => containerManager.beginContainerTopologyChange() }
      : {}),
  });
}

/** Order stops before new starts: both operate on the same Compose project. */
export function trackComposeStop(
  composeStopPromises: Map<string, Promise<void>>,
  sessionId: string,
  mgr: { stop: (opts?: { removeVolumes?: boolean }) => Promise<void> },
  opts: {
    removeVolumes?: boolean;
    onStopped?: () => void;
  } = {},
): void {
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form: the success and failure arms must stay separate, so `onStopped` cannot run on a failed stop and a throw inside it cannot be logged as one
  const stopPromise = mgr.stop(opts)
    .then(
      () => {
        try {
          opts.onStopped?.();
        } catch (err: unknown) {
          console.error(`[compose:${sessionId}] onStopped callback threw:`, err);
        }
      },
      (err: unknown) => {
        console.error(`[compose:${sessionId}] Failed to stop compose stack:`, err);
      },
    )
    .finally(() => {
      // Only clear our entry — a fresh stop may have replaced it.
      if (composeStopPromises.get(sessionId) === stopPromise) {
        composeStopPromises.delete(sessionId);
      }
    });
  composeStopPromises.set(sessionId, stopPromise);
}

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

export interface ServiceSetupDeps {
  sessionManager: SessionManager;
  repoStore: RepoStore;
  serviceManagers: Map<string, ServiceManager>;
  composeStopPromises: Map<string, Promise<void>>;
  composeWarnings: Map<string, string>;
  composeNotConfigured: Set<string>;
  containerManager: SessionContainerManager | null;
  secretStore?: SecretStore;
  dockerSecretsConfig?: { internalDir: string; hostDir?: string; entrypointSourcePath: string };
  serviceEnvDir: string;
  logStore?: LogStore;
  activatePluginRepos?: (
    sessionId: string,
    workspaceDir: string,
    onSettled?: (sessionId: string) => void,
  ) => void;
  resolvePluginServices?: (
    sessionId: string,
    workspaceDir: string,
  ) => Promise<PluginComposeService[]>;
  broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  credentialStore?: CredentialStore;
  publishOverlayBases?: (args: {
    runner: ContainerSessionRunner;
    session: SessionInfo;
    installOk: boolean;
    installCommands?: string[];
  }) => Promise<DepDirPublishOutcome[]>;
}

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
    broadcastLog,
    credentialStore,
    publishOverlayBases,
  } = deps;
  const session = sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;

  const remoteUrl = session?.remoteUrl;
  if (remoteUrl && !repoStore.isTrusted(remoteUrl)) {
    console.log(`[trust] Deferring install + compose for untrusted remote ${remoteUrl} (session ${runner.sessionId})`);
    return;
  }

  let shipitConfig;
  try {
    shipitConfig = resolveShipitConfig(workspaceDir);
  } catch {
    return;
  }

  // Store warnings for viewers that attach after setup emits them.
  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: text });
    runner.on("disposed", () => composeWarnings.delete(runner.sessionId));
  } else if (composeWarnings.has(runner.sessionId)) {
    composeWarnings.delete(runner.sessionId);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: "" });
  }

  deps.activatePluginRepos?.(runner.sessionId, workspaceDir, emitPluginReposUpdated(runner, deps));
  runner.on("disposed", () => clearActivationState(runner.sessionId));

  const installCommands = shipitConfig.agent.install;
  let installPromise: Promise<InstallCompletion> | null = null;
  const installStartedAt = Date.now();
  if (runner instanceof ContainerSessionRunner) {
    runner.setDepReinstallInputs(
      installCommands,
      resolveDepsHashInputs(installCommands, shipitConfig.agent.installInputs) ?? [],
    );
    reportContentKeyState(runner.sessionId, workspaceDir, shipitConfig.agent);
  }
  // Adoption subscribes synchronously; replay the worker's decision if it arrived first.
  const decisionListeners: ((d: WorkerInstallDecision) => void)[] = [];
  let observedDecision: WorkerInstallDecision | undefined;
  const onInstallDecision = (fn: (d: WorkerInstallDecision) => void): void => {
    if (observedDecision) fn(observedDecision);
    else decisionListeners.push(fn);
  };
  if (installCommands.length > 0 && runner instanceof ContainerSessionRunner) {
    installPromise = runner.runInstall(installCommands, {
      onWorkerDecision: (decision) => {
        observedDecision = decision;
        for (const fn of decisionListeners) fn(decision);
      },
    }).catch((err: unknown) => {
      console.error(`[install:${runner.sessionId}] Install failed:`, getErrorMessage(err));
      return { ok: false };
    });
  }

  if (installPromise && publishOverlayBases && session && runner instanceof ContainerSessionRunner) {
    const p = installPromise;
    const r = runner;
    const s = session;
    void (async () => {
      const res = await p;
      // Unverified completion cannot certify a shared dependency base.
      if (res.unverified) return;
      try {
        const outcomes = await publishOverlayBases({
          runner: r,
          session: s,
          installOk: res.ok,
          installCommands,
        });
        if (outcomes.length > 0 && s.remoteUrl) {
          console.log(formatOverlayMeasurement({
            sessionId: r.sessionId,
            repoUrl: s.remoteUrl,
            installOk: res.ok,
            installDurationMs: Date.now() - installStartedAt,
            outcomes,
          }));
        }
        // Counts keep repo-declared path names out of the ops-readable log.
        const failed = outcomes.filter((o) => o.outcome === "error").length;
        if (failed > 0) {
          appendAgentLog(
            broadcastLog,
            r.sessionId,
            r,
            "server",
            `Dependency cache: ${failed} of ${outcomes.length} dependency directories could not be snapshotted as a shared base. Later sessions of this repository reinstall instead of reusing it.`,
          );
        }
      } catch (err) {
        console.error(`[overlay-publish:${r.sessionId}] publish failed:`, getErrorMessage(err));
      }
    })();
  }

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

  const pluginsMayProvideServices = shipitConfig.plugins.uses.length > 0;
  if (!shipitConfig.compose && !pluginsMayProvideServices) {
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    runner.on("disposed", () => composeNotConfigured.delete(runner.sessionId));
    return;
  }
  composeNotConfigured.delete(runner.sessionId);

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
      onInstallDecision,
      secretsLoader: createSecretsLoader(runner.sessionId, deps),
      containServicesFn,
      containServiceDns: containerManager?.isEgressDnsContained(runner.sessionId) ?? false,
      containServiceProxy: containerManager?.isEgressProxyContained(runner.sessionId) ?? false,
      resetSessionNetwork: containerManager
        ? async () => containerManager.resetSessionNetwork(runner.sessionId)
        : undefined,
      prepareContainedStartFn: containerManager?.isEgressContained(runner.sessionId)
        ? async (serviceNames: string[]) => containerManager.prepareComposeServiceStart(runner.sessionId, serviceNames)
        : undefined,
      session,
      workspaceDir,
      composeConfig: shipitConfig.compose ?? DEFAULT_COMPOSE_CONFIG,
      noProjectCompose: !shipitConfig.compose,
    });
    composeWarnings.delete(runner.sessionId);
    return;
  }

  const mgr = buildServiceManager({
    sessionId: runner.sessionId,
    workspaceDir,
    session,
    shipitConfig,
    deps,
  });

  serviceManagers.set(runner.sessionId, mgr);
  composeWarnings.delete(runner.sessionId);

  if (runner.setServiceManager) {
    runner.setServiceManager(mgr);
  }

  const stackErrorListener = (err: Error) => {
    handleStackError(runner, err, broadcastLog);
  };
  mgr.on("stack_error", stackErrorListener);

  if (installPromise) {
    mgr.setInstallRunning(true);
    const p = installPromise;
    void (async () => {
      const res = await p;
      mgr.setInstallRunning(false, { failed: !res.ok });
    })();
  }

  runner.on("disposed", () => {
    if (isContainerRunner(runner) && runner.preserveComposeOnDispose) {
      mgr.off("stack_error", stackErrorListener);
      return;
    }
    serviceManagers.delete(runner.sessionId);
    const removeVolumes = isContainerRunner(runner) && runner.removeVolumesOnDispose;
    trackComposeStop(composeStopPromises, runner.sessionId, mgr, { removeVolumes });
  });

  void (async () => {
    await awaitComposeStop(composeStopPromises, runner.sessionId);
    await applyOverlayDepDirs(runner, mgr, { containerManager, session, workspaceDir, broadcastLog });
    // Resolve and start under one stack operation so activation cannot reconcile between them.
    await serializeStackOp(runner.sessionId, async () => {
      await resolvePluginServicesInto(runner.sessionId, workspaceDir, mgr, deps);
      // Readiness waits can outlive the runner; start() would revive an orphaned manager.
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
        if (broadcastLog) {
          broadcastLog(runner.sessionId, "server", `[compose] Failed to start: ${errMsg}`);
        }
      }
    });
  })();
}

function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((cmd, i) => cmd === b[i]);
}

/** Config resolution defaults on read errors; those must not trigger stack removal. */
function composeRemovalIsTrustworthy(workspaceDir: string): boolean {
  const yamlPath = path.join(workspaceDir, "shipit.yaml");
  try {
    fs.readFileSync(yamlPath, "utf-8");
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

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
    void deps.serviceManagers.get(sessionId)?.refreshSecretsStatus().catch((err: unknown) => {
      console.warn(`[plugins:${sessionId}] secrets status resync failed:`, getErrorMessage(err));
    });
    const container = runner as SessionRunnerInterface & { preparePlugins?: () => Promise<void> };
    void container.preparePlugins?.();
    void refreshPluginServices(runner, deps);
  };
}

async function refreshPluginServices(
  runner: SessionRunnerInterface,
  deps: PluginServiceRefreshDeps,
): Promise<void> {
  const mgr = deps.serviceManagers.get(runner.sessionId);
  if (!mgr || !deps.resolvePluginServices) return;
  const session = deps.sessionManager.get(runner.sessionId);
  const workspaceDir = session?.workspaceDir ?? runner.sessionDir;
  try {
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

/** Caller must hold the non-reentrant stack operation through resolution and start/reconcile. */
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

  if (shipitConfig.warnings.length > 0) {
    const text = `shipit.yaml needs migration:\n${shipitConfig.warnings.map(w => `• ${w}`).join("\n")}`;
    composeWarnings.set(runner.sessionId, text);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: text });
  } else if (composeWarnings.has(runner.sessionId)) {
    composeWarnings.delete(runner.sessionId);
    runner.emitMessage({ type: "compose_error", sessionId: runner.sessionId, message: "" });
  }

  deps.activatePluginRepos?.(runner.sessionId, workspaceDir, emitPluginReposUpdated(runner, deps));

  if (runner instanceof ContainerSessionRunner) {
    const nextCommands = shipitConfig.agent.install;
    // install-inputs can change without changing the commands.
    reportContentKeyState(runner.sessionId, workspaceDir, shipitConfig.agent);
    if (!sameCommands(runner.appliedInstallCommands, nextCommands)) {
      console.log(
        `[install:${runner.sessionId}] agent.install changed — re-running (${nextCommands.length} command(s))`,
      );
      runner.setDepReinstallInputs(
        nextCommands,
        resolveDepsHashInputs(nextCommands, shipitConfig.agent.installInputs) ?? [],
      );
      runner.requestDepReinstall();
    }
  }

  if (!shipitConfig.compose && shipitConfig.plugins.uses.length === 0) {
    if (!composeRemovalIsTrustworthy(workspaceDir)) {
      console.warn(
        `[compose:${runner.sessionId}] shipit.yaml unreadable — keeping the running stack`,
      );
      return;
    }
    console.log(`[compose:${runner.sessionId}] compose config removed — stopping stack`);
    serviceManagers.delete(runner.sessionId);
    runner.setServiceManager?.(null);
    trackComposeStop(composeStopPromises, runner.sessionId, mgr);
    composeNotConfigured.add(runner.sessionId);
    runner.emitMessage({ type: "compose_not_configured", sessionId: runner.sessionId });
    return;
  }

  composeNotConfigured.delete(runner.sessionId);
  const nextComposeConfig = shipitConfig.compose ?? DEFAULT_COMPOSE_CONFIG;
  if (mgr.updateComposeConfig(nextComposeConfig, { noProjectCompose: !shipitConfig.compose })) {
    console.log(
      `[compose:${runner.sessionId}] compose config changed — reconciling against ${nextComposeConfig.file}`,
    );
  }
  void serializeStackOp(runner.sessionId, async () => {
    // Recheck name collisions against the edited project file before generating its override.
    if ((await resolvePluginServicesInto(runner.sessionId, workspaceDir, mgr, deps)).changed) {
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
