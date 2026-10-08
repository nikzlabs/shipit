import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { ComposeServiceOriginView } from "../shared/types/ws-server-messages/service.js";
import { killChild } from "../shared/kill-child.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import type { LogStore } from "./log-store.js";
import {
  classifyComposeFailure,
  composeBuildModel,
  ComposeValidationError,
  declaresHome,
  extractContainerPort,
  generateComposeOverride,
  mountProjectFileCopies,
  normalizedUser,
  parseComposeContent,
  pluginStubModel,
  resolvedPersistUse,
  requestsGpu,
  rewriteResolvedModel,
  serializeComposeModel,
  unescapeComposeDollars,
  validateResolvedModel,
  writeRootOnlyFile,
  DEFAULT_STOP_GRACE_PERIOD_MS,
  type ComposeFailure,
  type ComposeOverrideOptions,
  type ComposeParseOptions,
  type ComposeService,
  type ComposeServiceOrigin,
  type DockerSocketGrant,
  type OverlayDepDirVolume,
  type PersistVolume,
  type ProjectFileCopy,
  type SnapshotRewrite,
} from "./compose-generator.js";
import { preparePersistDir } from "./compose-persist.js";
import { noGpuWhy, type SessionGpu } from "./session-gpu.js";
import { toComposeService, type PluginComposeService } from "./plugin-compose.js";
import { PLUGIN_PORT_ENV } from "../shared/plugin-contract.js";
import {
  COMPOSE_OVERRIDE_FILE,
  composeStateDirForWorkspace,
  sessionScratchDirForWorkspace,
  sessionStateDirForWorkspace,
} from "./session-state-dir.js";
import { ComposeHelperError, ConfinedCompose, type ConfinedComposeApi } from "./compose-helper.js";
import { ComposeStartRecord } from "./compose-start-record.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import {
  ServiceSecretsResolver,
  type SecretsStatusInternalSnapshot,
  type DockerSecretsConfig,
} from "./service-secrets-resolver.js";
import type { PluginCredentialDeclaration } from "../shared/plugin-credentials.js";
import type { EgressPolicy } from "./egress-firewall-install.js";
import { ServicePoller } from "./service-poller.js";
import { ServiceRetryManager } from "./service-retry-manager.js";
import { serializeStackOp } from "./stack-op-queue.js";
import { markStackUp, forgetStackUp } from "./preview-timing.js";
import { removeSessionServiceEnvDir, removeSessionSecretsDir } from "./secret-resolver.js";
import {
  ComposeCli,
  composeSpawnEnv,
  type ComposeBuild,
  type ComposeRunner,
  type ComposeQuery,
  type ComposeOutputSink,
  type ComposeStartModel,
} from "./compose-cli.js";

export type {
  SecretsStatusSnapshot,
  SecretsStatusInternalSnapshot,
} from "./service-secrets-resolver.js";

export type { ComposeRunner, ComposeQuery, ComposeOutputSink } from "./compose-cli.js";

export type ServiceStatus = "stopped" | "starting" | "running" | "error";

export interface ManagedService {
  name: string;
  /** Container port, also used in the preview subdomain. */
  port?: number;
  preview: "auto" | "manual";
  status: ServiceStatus;
  error?: string;
  origin?: ComposeServiceOrigin;
  /** Defaults to true for auto-preview services. */
  dependsOnInstall: boolean;
  stopGracePeriodMs?: number;
  containerIp?: string;
  /** Direct agent URL; a starting container can have an address before it is ready. */
  url?: string;
}

type PortHolder = Pick<ManagedService, "name" | "origin">;

export function originView(origin: ComposeServiceOrigin): ComposeServiceOriginView {
  return { kind: "plugin", repo: origin.repo, alias: origin.alias, plugin: origin.plugin };
}

export const INSTALL_FAILED_GATE_MESSAGE =
  "agent.install failed — dependent service not started";

export const COMPOSE_LOG_PREFIX = "[compose] ";

export const MAX_COMPOSE_LOG_LINE = 8_000;

export const PLUGIN_PORT_PROBE_DELAY_MS = 45_000;

// Retry because a running container may still be installing before it binds a port.
export const PLUGIN_PORT_PROBE_ATTEMPTS = 8;

export const PLUGIN_PORT_PROBE_TIMEOUT_MS = 2_000;

function tcpAccepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export const NETWORK_JOIN_TIMEOUT_MS = 30_000;

// Independent of the poll loop, which can fail while a service remains "starting".
export const STARTING_WATCHDOG_MS = 120_000;

// Added to each service's declared stop grace period, not a fixed total timeout.
export const GATED_TEARDOWN_GRACE_MARGIN_MS = 60_000;

export const GATE_WATCHDOG_SETTLE_MS = 60_000;

/** A timeout stops waiting without cancelling work; rejections still propagate. */
async function settleOrTimeout(work: Promise<void>, ms: number): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = async (): Promise<"settled"> => {
    await work;
    return "settled";
  };
  const expire = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([settle(), expire]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const STARTING_TIMEOUT_MESSAGE =
  `Stuck in "starting" for over ${Math.round(STARTING_WATCHDOG_MS / 1000)}s with no compose up ` +
  "in flight — readiness was never confirmed. The service may in fact be running, or its " +
  "container may be stuck in a restart loop: check `shipit service logs <name>`, then restart " +
  "the service to re-probe.";

// Bound silence, not total build time; a late successful build can still recover.
export const UP_SILENCE_TIMEOUT_MS = 300_000;

export const UP_STALLED_MESSAGE =
  `\`docker compose up\` has produced no output for over ${Math.round(UP_SILENCE_TIMEOUT_MS / 60_000)} minutes ` +
  "and has not returned — Docker may be unresponsive. The command has not been cancelled, so a build that is " +
  "merely slow will still finish and the service will recover on its own; check `shipit service logs <name>` " +
  "for build output, or restart the service to retry.";

/** Rejects on timeout without cancelling the underlying work. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface ServiceManagerOptions {
  sessionId: string;
  workspaceDir: string;
  composeConfig: ComposeConfig;
  composeRunner?: ComposeRunner;
  composeQuery?: ComposeQuery;
  /** Opens a topology-change bracket and returns its closing callback. */
  onTopologyChange?: () => () => void;
  /** 0 disables polling. Default: 5000. */
  pollIntervalMs?: number;
  gateWatchdogSettleMs?: number;
  workspaceVolume?: string;
  workspaceSubpath?: string;
  /** Daemon-side path of the workspace, which roots the volume its subdirectory mounts use. */
  resolveWorkspaceDevice?: () => Promise<string>;
  stackName?: string;
  /** No project compose file is declared; missing declared files still fail. */
  noProjectCompose?: boolean;
  /** Server-authoritative: the ops template's proxy may mount the socket read-only without the grant. */
  opsSession?: boolean;
  /** Read at each parse (docs/318 req 8); absent means not granted. */
  dockerSocketGrant?: () => DockerSocketGrant;
  /**
   * The agent container's GPU state, awaited at a start whose services ask for a GPU, since Compose
   * can start before the container decides it (docs/325-session-gpu-access req 3).
   */
  sessionGpu?: () => Promise<SessionGpu | undefined>;
  networkJoinFn?: (networkName: string) => Promise<void>;
  networkHealFn?: (networkName: string) => Promise<void>;
  containServicesFn?: (serviceNames: string[]) => Promise<void>;
  /** What `containServicesFn` installs; omitted means contained. */
  firewallPolicy?: EgressPolicy;
  /** Use the containment sidecar's loopback DNS upstream. */
  containServiceDns?: boolean;
  containServiceProxy?: boolean;
  prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
  ensureSessionNetworkModeFn?: (internal: boolean) => Promise<void>;
  secretsLoader?: () => Promise<Record<string, string>>;
  accountAgentEnvLoader?: () => Record<string, string>;
  pluginCredentialsLoader?: () => PluginCredentialDeclaration[];
  dockerSecretsConfig?: DockerSecretsConfig;
  /** Must resolve outside the agent-readable workspace. */
  serviceEnvDir: string;
  overlayDepDirs?: OverlayDepDirVolume[];
  logStore?: LogStore;
  /** Maps the session's /persist directory to the daemon's path for it; identity when absent. */
  persistDevicePath?: (hostPath: string) => Promise<string>;
  /**
   * Runs the Compose commands that read project files, confined to this session
   * (docs/318-compose-remaining-escapes, Mechanism 1).
   */
  confinedCompose?: ConfinedComposeApi;
}

export interface ServiceManagerEvents {
  service_status: [service: ManagedService];
  service_log: [serviceName: string, text: string];
  stack_ready: [];
  stack_error: [error: Error];
  secrets_status: [snapshot: SecretsStatusInternalSnapshot];
}

export class ServiceManager extends EventEmitter<ServiceManagerEvents> {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private composeConfig: ComposeConfig;

  private static readonly MAX_LOG_BUFFER = 80_000;
  private static readonly MAX_LOG_SNAPSHOT = 500_000;

  private services = new Map<string, ManagedService>();
  private logProcesses = new Map<string, ChildProcess>();
  private logBuffers = new Map<string, string>();
  private followerSince = new Map<string, string>();
  private readonly logStore?: LogStore;
  private readonly gateWatchdogSettleMs: number;
  private _started = false;
  private readonly compose: ComposeCli;
  private readonly workspaceVolume?: string;
  private readonly workspaceSubpath?: string;
  private readonly resolveWorkspaceDevice?: () => Promise<string>;
  private overlayDepDirs: OverlayDepDirVolume[];
  private pluginServices: PluginComposeService[] = [];
  // The project parse the service-env files were last written for.
  private _syncedProjectServices: string | null = null;
  // Preserve start()'s admission decision for every later start.
  private _overrideAdmittedPlugins: PluginComposeService[] = [];
  private pendingPortRefusals: { service: string; message: string }[] = [];
  private portRefusals = new Map<string, string>();
  private portProbeTimers = new Map<string, NodeJS.Timeout>();
  // Both success and exhausted retries settle the probe; this is not a health check.
  private portProbeSettled = new Set<string>();
  private readonly stackName?: string;
  private readonly opsSession: boolean;
  private readonly dockerSocketGrant: () => DockerSocketGrant;
  private readonly sessionGpu: () => Promise<SessionGpu | undefined>;
  // The services the last snapshot started without the GPU they asked for, with why.
  private gpuRemovals = new Map<string, string>();
  private noProjectCompose: boolean;
  private readonly networkJoinFn?: (networkName: string) => Promise<void>;
  private readonly networkHealFn?: (networkName: string) => Promise<void>;
  private containServicesFn?: (serviceNames: string[]) => Promise<void>;
  private firewallPolicy: EgressPolicy;
  private containServiceDns: boolean;
  private containServiceProxy: boolean;
  private readonly ensureSessionNetworkModeFn?: (internal: boolean) => Promise<void>;
  private prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
  private readonly serviceEnvDir: string;
  private readonly stateDir: string;
  private readonly composeStateDir: string;
  private readonly secretsInternalDir?: string;
  private readonly persistDevicePath: (hostPath: string) => Promise<string>;
  private readonly confined: ConfinedComposeApi;
  private readonly startRecord: ComposeStartRecord;
  private legacyOverrideRemoved = false;

  private readonly secrets: ServiceSecretsResolver;
  private readonly poller: ServicePoller;
  private readonly retry: ServiceRetryManager;

  private _startupComplete = false;
  startError: string | null = null;
  // Last parse/validation failure, separate from failures to run the stack.
  private _projectComposeFailure: ComposeFailure | null = null;
  private _disposed = false;

  private _installRunning = false;

  private _installFailed = false;

  /** Check before skipping an install bracket: only a new bracket clears a failed gate. */
  get installGateFailed(): boolean {
    return this._installFailed;
  }

  // Polling and exit handling defer to the gate for these services.
  private gatedServices = new Set<string>();

  private postGateServices = new Set<string>();

  // Count overlapping starts so one completion cannot remove another's poll exemption.
  private upInFlight = new Map<string, number>();

  private upLastOutputAt = new Map<string, number>();

  // Non-rejecting settlements let a stop follow every overlapping start.
  private upSettled = new Map<string, Set<Promise<void>>>();

  private stoppedByUser = new Set<string>();

  private readonly startingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  private _gatedTeardown: Promise<void> | null = null;

  // An older teardown must not release a newer install gate.
  private _gateGeneration = 0;
  private _gatedTeardownGeneration = 0;

  private _gateHeldSince: number | null = null;

  // Releases clear _gatedTeardown before awaiting it; count all overlapping waits for the watchdog.
  private _gateReleasesInFlight = 0;

  private _gateWedgedSince: number | null = null;

  constructor(opts: ServiceManagerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeConfig = opts.composeConfig;
    this.stateDir = sessionStateDirForWorkspace(opts.workspaceDir);
    this.composeStateDir = composeStateDirForWorkspace(opts.workspaceDir);
    this.confined = opts.confinedCompose ?? new ConfinedCompose({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      ...(opts.workspaceVolume ? { workspaceVolume: opts.workspaceVolume } : {}),
      daemonPath: (p) => Promise.resolve(p),
      ...(opts.stackName ? { stackName: opts.stackName } : {}),
    });
    this.startRecord = new ComposeStartRecord(this.composeStateDir);
    this.compose = new ComposeCli({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      confined: this.confined,
      composeStateDir: this.composeStateDir,
      ...(opts.composeRunner ? { composeRunner: opts.composeRunner } : {}),
      ...(opts.composeQuery ? { composeQuery: opts.composeQuery } : {}),
      ...(opts.onTopologyChange ? { onTopologyChange: opts.onTopologyChange } : {}),
      rejoinSessionNetwork: () => this.joinSessionNetwork(),
    });
    this.workspaceVolume = opts.workspaceVolume;
    this.workspaceSubpath = opts.workspaceSubpath;
    this.resolveWorkspaceDevice = opts.resolveWorkspaceDevice;
    this.overlayDepDirs = opts.overlayDepDirs ?? [];
    this.stackName = opts.stackName;
    this.opsSession = opts.opsSession ?? false;
    this.dockerSocketGrant = opts.dockerSocketGrant ?? (() => "not_granted");
    this.sessionGpu = opts.sessionGpu ?? (() => Promise.resolve(undefined));
    this.noProjectCompose = opts.noProjectCompose ?? false;
    this.networkJoinFn = opts.networkJoinFn;
    this.networkHealFn = opts.networkHealFn;
    this.containServicesFn = opts.containServicesFn;
    this.firewallPolicy = opts.firewallPolicy ?? "contained";
    this.containServiceDns = opts.containServiceDns ?? false;
    this.containServiceProxy = opts.containServiceProxy ?? false;
    this.ensureSessionNetworkModeFn = opts.ensureSessionNetworkModeFn;
    this.prepareContainedStartFn = opts.prepareContainedStartFn;
    this.serviceEnvDir = opts.serviceEnvDir;
    this.secretsInternalDir = opts.dockerSecretsConfig?.internalDir;
    this.persistDevicePath = opts.persistDevicePath ?? ((hostPath) => Promise.resolve(hostPath));
    this.logStore = opts.logStore;
    this.gateWatchdogSettleMs = opts.gateWatchdogSettleMs ?? GATE_WATCHDOG_SETTLE_MS;

    this.secrets = new ServiceSecretsResolver({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      ...(opts.secretsLoader ? { secretsLoader: opts.secretsLoader } : {}),
      ...(opts.accountAgentEnvLoader ? { accountAgentEnvLoader: opts.accountAgentEnvLoader } : {}),
      ...(opts.pluginCredentialsLoader ? { pluginCredentialsLoader: opts.pluginCredentialsLoader } : {}),
      ...(opts.dockerSecretsConfig ? { dockerSecretsConfig: opts.dockerSecretsConfig } : {}),
      serviceEnvDir: opts.serviceEnvDir,
      onSnapshot: (snapshot) => this.emit("secrets_status", snapshot),
      onServiceWarning: (serviceName, text) => this.appendShipitLog(serviceName, text),
    });

    this.retry = new ServiceRetryManager({
      sessionId: opts.sessionId,
      isDisposed: () => this._disposed,
      updateServiceStatus: (name, status, error) =>
        this.updateServiceStatus(name, status, error),
      runRetryNow: (name) => this.runRetryNow(name),
    });

    this.poller = new ServicePoller({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      queryCwd: () => this.compose.modelFreeDir(),
      composeQuery: this.compose.query,
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      composeArgs: (...extra) => this.compose.modelFreeArgs(...extra),
      isGated: (name) => this.gatedServices.has(name),
      getService: (name) => this.services.get(name),
      listServices: () => [...this.services.values()],
      isStartInFlight: (name) => this.upInFlight.has(name),
      setContainerIp: (name, ip) => {
        const svc = this.services.get(name);
        if (!svc) return;
        if (ip) svc.containerIp = ip;
        else delete svc.containerIp;
      },
      updateServiceStatus: (name, status, error) =>
        this.updateServiceStatus(name, status, error),
      onRunning: (name) => {
        // Check every poll: the old follower can exit after the running transition.
        this.ensureLogFollower(name);
        this.retry.clearRetryState(name);
        // Require stable uptime before retiring recovery budgets, so flapping still reaches a cap.
        if (this.postGateServices.has(name)) {
          this.retry.armPostGateStableClear(name, () => {
            this.postGateServices.delete(name);
          });
        }
        this.retry.armOomStableResetIfNeeded(name);
        this.armPluginPortProbe(name);
      },
      onLeftRunning: (name) => {
        this.retry.cancelOomStableTimer(name);
        this.retry.cancelPostGateStableTimer(name);
        this.cancelPluginPortProbe(name);
      },
      onExitedCleanly: (name) => {
        this.retry.clearRetryState(name);
        this.retry.clearOomBudget(name);
      },
      onExitedWithError: (name, exitCode, oomKilled) => {
        this.handleNonZeroExit(name, exitCode, oomKilled);
      },
      afterPoll: async () => {
        // A slow network heal must not delay the gate check.
        this.checkInstallGateLiveness();
        await this.healSessionNetwork();
      },
    });
  }

  private async healSessionNetwork(): Promise<void> {
    if (!this.networkHealFn) return;
    const networkName = `shipit-session-${this.sessionId}`;
    try {
      await this.networkHealFn(networkName);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] network heal failed:`, (err as Error).message);
    }
  }

  /** Returns true when the caller must reconcile to apply changed mounts. */
  setOverlayDepDirs(overlayDepDirs: OverlayDepDirVolume[]): boolean {
    const changed = JSON.stringify(this.overlayDepDirs) !== JSON.stringify(overlayDepDirs);
    this.overlayDepDirs = overlayDepDirs;
    return changed;
  }

  /** Returns true when the caller must reconcile to apply changed services. */
  setPluginServices(services: PluginComposeService[]): boolean {
    const changed = JSON.stringify(this.pluginServices) !== JSON.stringify(services);
    this.pluginServices = services;
    return changed;
  }

  get composeFilePath(): string {
    return this.composeConfig.file;
  }

  // Warm adoption must reconcile because claiming the workspace can change its stack definition.
  preStartedWarm = false;

  updateEgressContainment(
    containServicesFn: ((serviceNames: string[]) => Promise<void>) | undefined,
    containServiceDns: boolean,
    containServiceProxy: boolean,
    prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>,
    firewallPolicy: EgressPolicy = "contained",
  ): boolean {
    const wasContained = this.egressContained();
    const changed = Boolean(this.containServicesFn) !== Boolean(containServicesFn)
      || this.containServiceDns !== containServiceDns
      || this.containServiceProxy !== containServiceProxy;
    this.containServicesFn = containServicesFn;
    this.firewallPolicy = firewallPolicy;
    this.containServiceDns = containServiceDns;
    this.containServiceProxy = containServiceProxy;
    this.prepareContainedStartFn = prepareContainedStartFn;
    return changed || wasContained !== this.egressContained();
  }

  private egressContained(): boolean {
    return Boolean(this.containServicesFn) && this.firewallPolicy === "contained";
  }

  private handleNonZeroExit(name: string, exitCode: number, oomKilled?: boolean): void {
    const svc = this.services.get(name);
    if (!svc) return;

    if (this.stoppedByUser.has(name)) {
      // Our stop can exit non-zero; also correct a running status written by a racing poll.
      // Requirement 3 outranks staying quiet.
      if (svc.status !== "stopped") this.updateServiceStatus(name, "stopped");
      return;
    }

    if (this.gatedServices.has(name)) {
      return;
    }

    if (this._installRunning && svc.preview === "auto") {
      this.retry.scheduleRetryWhileInstalling(name, exitCode);
      return;
    }

    if (exitCode === 137 && oomKilled === true && svc.preview === "auto") {
      // Exit 137 alone is SIGKILL; our own teardown can cause it without an OOM.
      this.retry.scheduleOomRetry(name);
      return;
    }

    if (this.postGateServices.has(name) && svc.preview === "auto") {
      if (this.retry.schedulePostGateRetry(name)) return;
      this.postGateServices.delete(name);
    }

    this.updateServiceStatus(name, "error", describeExit(exitCode, oomKilled));
  }

  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this.secrets.setSecretsLoader(loader);
  }

  /** Returns false for an unchanged state; that caller did not open a new bracket. */
  setInstallRunning(running: boolean, opts: { failed?: boolean } = {}): boolean {
    if (this._installRunning === running) return false;
    const wasRunning = this._installRunning;
    this._installRunning = running;

    if (!wasRunning && running) {
      this._installFailed = false;
      this.holdGatedServicesForReinstall();
      return true;
    }

    if (wasRunning && !running) {
      this._installFailed = opts.failed ?? false;
      this.releaseInstallGate();
      this.flushPostInstallRetries();
    }
    return true;
  }

  // Keep teardown exits gated and prevent the new start from racing the old stop.
  private releaseInstallGate(): void {
    const teardown = this._gatedTeardown;
    const generation = this._gatedTeardownGeneration;
    this._gatedTeardown = null;

    const open = (): void => {
      if (this._disposed) {
        console.log(
          `[compose:${this.sessionId}] install gate not opened — the manager was disposed while the teardown ran`,
        );
        return;
      }
      if (this._installRunning) {
        console.log(
          `[compose:${this.sessionId}] install gate not opened — a newer install is already running; its completion owns the next open`,
        );
        return;
      }
      if (this._installFailed) {
        this.latchGatedServicesToError();
      } else {
        this.startGatedServices();
      }
    };

    if (!teardown) {
      open();
      return;
    }
    this._gateReleasesInFlight++;
    void (async () => {
      try {
        await teardown;
        if (this._gateGeneration !== generation) {
          console.log(
            `[compose:${this.sessionId}] install gate not opened — this teardown belongs to gate ` +
            `generation ${generation}, superseded by ${this._gateGeneration}`,
          );
          return;
        }
        open();
      } finally {
        this._gateReleasesInFlight--;
      }
    })();
  }

  get installRunning(): boolean {
    return this._installRunning;
  }

  getDeclaredSecretNames(): string[] {
    return this.secrets.getDeclaredNames();
  }

  getMissingSecretsByService(): Record<string, string[]> {
    return this.secrets.getMissingByService();
  }

  getSecretsSnapshot(): SecretsStatusInternalSnapshot {
    return this.secrets.getSnapshot();
  }

  /** An empty snapshot means "nothing declared" only after the first sync. */
  get secretsSynced(): boolean {
    return this.secrets.hasSynced;
  }

  get started(): boolean {
    return this._started;
  }

  getServices(): ManagedService[] {
    return [...this.services.values()].map((svc) =>
      hasLiveAddress(svc)
        ? { ...svc, url: `http://${svc.containerIp}:${svc.port}/` }
        : { ...svc },
    );
  }

  get projectComposeFailure(): ComposeFailure | null {
    return this._projectComposeFailure;
  }

  getService(name: string): ManagedService | undefined {
    return this.services.get(name);
  }

  getContainerIpForPort(port: number): string | undefined {
    return this.resolvePreviewTarget(port)?.containerIp;
  }

  resolvePreviewTarget(port: number): { containerIp: string; port: number } | undefined {
    for (const svc of this.services.values()) {
      if (svc.port === port && svc.containerIp) {
        return { containerIp: svc.containerIp, port };
      }
    }
    return undefined;
  }

  getLogBuffer(name: string): string {
    return this.logBuffers.get(name) ?? "";
  }

  async snapshotLogs(name: string, lines = 2000): Promise<string> {
    if (!this.services.has(name)) return "";

    // Prefer persisted history: Docker only retains logs for the current container.
    const channel = `service:${name}`;
    if (this.logStore?.hasChannel(this.sessionId, channel)) {
      return this.logStore.snapshotText(this.sessionId, channel, ServiceManager.MAX_LOG_SNAPSHOT);
    }

    const tail = Number.isFinite(lines) && lines > 0 ? String(Math.floor(lines)) : "2000";
    const args = this.compose.modelFreeArgs("logs", "--no-log-prefix", "--tail", tail, name);

    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (val: string) => {
        if (settled) return;
        settled = true;
        const out = val.length > ServiceManager.MAX_LOG_SNAPSHOT
          ? truncateTerminalBuffer(val, ServiceManager.MAX_LOG_SNAPSHOT)
          : val;
        resolve(out.length > 0 ? out : this.getLogBuffer(name));
      };
      try {
        const proc = spawn("docker", args, {
          cwd: this.compose.modelFreeDir(),
          env: composeSpawnEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        const onData = (chunk: Buffer) => { out += chunk.toString(); };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", () => finish(this.getLogBuffer(name)));
        proc.on("close", () => finish(out));
      } catch {
        finish(this.getLogBuffer(name));
      }
    });
  }

  private warnOnAmbiguousPreviewPorts(): void {
    const claimedBy = new Map<number, PortHolder>();
    for (const svc of this.services.values()) {
      if (svc.port === undefined) continue;
      const first = claimedBy.get(svc.port);
      if (first === undefined) {
        claimedBy.set(svc.port, svc);
        continue;
      }
      const message = `${this.describePortHolder(first)} and ${this.describePortHolder(svc)}`
        + ` both preview on port ${svc.port} — the preview pane can only reach ${first.name} there.`
        + ` Give one of them a different port: ${this.portChangeAdvice(svc)},`
        + ` or ${this.portChangeAdvice(first)}.`;
      this.reportPortConflict(svc.name, message);
    }
  }

  private describePortHolder(svc: PortHolder): string {
    if (!svc.origin) return `this project's own service \`${svc.name}\` (\`${this.composeConfig.file}\`)`;
    return `the plugin service \`${svc.name}\` (the \`plugins.use\` entry in \`shipit.yaml\``
      + ` whose alias is \`${svc.origin.alias}\`)`;
  }

  private portChangeAdvice(svc: PortHolder): string {
    if (!svc.origin) return `give \`${svc.name}\` a different port in \`${this.composeConfig.file}\``;
    return `change \`port:\` for \`${svc.origin.sourceName}\` under the \`plugins.use\` entry`
      + ` in \`shipit.yaml\` whose alias is \`${svc.origin.alias}\``;
  }

  // Keep refused services visible as manual/error rows, but exclude them from the override.
  private refusePluginPortCollision(svc: PluginComposeService, projectService: string): void {
    const origin: ComposeServiceOrigin = {
      kind: "plugin",
      repo: svc.repo,
      alias: svc.alias,
      plugin: svc.plugin,
      sourceName: svc.sourceName,
      self: svc.self,
    };
    const occupant: PortHolder = { name: projectService };
    const message = `${svc.name} is given port ${svc.port}. That port is already served by `
      + `${this.describePortHolder(occupant)}. Two services cannot preview on one port, so `
      + `${svc.name} was not started. Either ${this.portChangeAdvice({ name: svc.name, origin })}, `
      + `or ${this.portChangeAdvice(occupant)}.`;
    // Followers clear their ring buffers on attachment, so report these afterwards.
    this.pendingPortRefusals.push({ service: svc.name, message });
    this.portRefusals.set(svc.name, message);
    this.services.set(svc.name, {
      name: svc.name,
      preview: "manual",
      status: "error",
      error: message,
      dependsOnInstall: false,
      origin,
    });
  }

  private armPluginPortProbe(name: string, attempt = 1): void {
    const svc = this.services.get(name);
    if (!svc?.origin || svc.port === undefined) return;
    if (this.portProbeSettled.has(name) || this.portProbeTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.portProbeTimers.delete(name);
      void this.probePluginPort(name, attempt);
    }, PLUGIN_PORT_PROBE_DELAY_MS);
    timer.unref();
    this.portProbeTimers.set(name, timer);
  }

  private cancelPluginPortProbe(name: string): void {
    const timer = this.portProbeTimers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.portProbeTimers.delete(name);
  }

  private async probePluginPort(name: string, attempt: number): Promise<void> {
    const svc = this.services.get(name);
    if (!svc?.origin || svc.port === undefined || !svc.containerIp) return;
    if (svc.status !== "running" || this.portProbeSettled.has(name)) return;
    // Ignore results for an address replaced while the probe was pending.
    const { containerIp, port } = svc;
    const accepted = await tcpAccepts(containerIp, port, PLUGIN_PORT_PROBE_TIMEOUT_MS);
    if (this._disposed) return;
    const now = this.services.get(name);
    if (now?.containerIp !== containerIp || now.port !== port || now.status !== "running") return;
    if (accepted) {
      this.portProbeSettled.add(name);
      return;
    }
    if (attempt < PLUGIN_PORT_PROBE_ATTEMPTS) {
      this.armPluginPortProbe(name, attempt + 1);
      return;
    }
    this.portProbeSettled.add(name);
    this.reportPortConflict(
      name,
      `${name} is running but nothing is listening on port ${port}, so its preview will be `
      + `empty. That port is this project's to choose and ShipIt passes it to the container as `
      + `${PLUGIN_PORT_ENV}; a plugin whose server binds a port of its own instead will not be `
      + `reachable. Report it to the \`${svc.origin.repo}\` plugin's authors.`,
    );
  }

  // Preserve the actionable refusal instead of replacing it with Compose's "no such service".
  private refusePluginPortStart(name: string): void {
    const reason = this.portRefusals.get(name);
    if (reason) throw new Error(reason);
  }

  private reportPortRefusals(): void {
    const pending = this.pendingPortRefusals;
    this.pendingPortRefusals = [];
    for (const { service, message } of pending) this.reportPortConflict(service, message);
  }

  private reportGpuRemovals(started: string[]): void {
    for (const name of started) {
      const message = this.gpuRemovals.get(name);
      if (message) this.appendShipitLog(name, message);
    }
  }

  private reportPortConflict(service: string, message: string): void {
    console.warn(`[compose:${this.sessionId}] ${message}`);
    this.appendShipitLog(service, message);
  }

  // Persisted, so the line is still there when someone opens the log later.
  private appendShipitLog(service: string, message: string): void {
    const line = `[shipit] ${message}\n`;
    this.logStore?.append(this.sessionId, `service:${service}`, line);
    this.bufferServiceLog(service, line);
  }

  async start(opts: { sweepStaleContainers?: boolean } = {}): Promise<void> {
    this._disposed = false;
    // Invalidate old gate releases before an await lets one act on partially rebuilt state.
    this._gateGeneration++;
    await this.ensureSessionNetworkModeFn?.(Boolean(this.containServicesFn));
    if (opts.sweepStaleContainers ?? true) {
      try {
        await this.compose.killStaleContainers();
      } catch {
        // Best-effort cleanup
      }
    }

    if (this.noProjectCompose) this._projectComposeFailure = null;

    if (this.noProjectCompose && this.pluginServices.length === 0) {
      console.log(`[compose:${this.sessionId}] no project compose file and no plugin services — nothing to start`);
      this._startupComplete = true;
      return;
    }

    const parsedServices = this.noProjectCompose ? [] : await this.readProjectCompose();

    // Judge port collisions against this parse; the service map can still contain old rows.
    this.portRefusals.clear();
    const projectPorts = new Map<number, string>();
    for (const svc of parsedServices) {
      const preview = svc.shipitPreview ?? (svc.ports?.length ? "auto" : "manual");
      const port = svc.ports?.[0] ? extractContainerPort(svc.ports[0]) : undefined;
      if (port !== undefined && !projectPorts.has(port)) projectPorts.set(port, svc.name);
      this.services.set(svc.name, {
        name: svc.name,
        port,
        preview,
        status: "stopped",
        dependsOnInstall: svc.dependsOnInstall ?? (preview === "auto"),
        ...(svc.stopGracePeriodMs !== undefined ? { stopGracePeriodMs: svc.stopGracePeriodMs } : {}),
      });
    }
    const admittedPlugins = this.pluginServices.filter((svc) => {
      const clash = svc.port !== undefined ? projectPorts.get(svc.port) : undefined;
      if (clash === undefined) return true;
      this.refusePluginPortCollision(svc, clash);
      return false;
    });

    // Self plugins use agent.install's tree; external plugin generations are already installed.
    for (const svc of admittedPlugins) {
      this.services.set(svc.name, {
        name: svc.name,
        ...(svc.port !== undefined ? { port: svc.port } : {}),
        preview: svc.preview,
        status: "stopped",
        dependsOnInstall: svc.self,
        origin: {
          kind: "plugin",
          repo: svc.repo,
          alias: svc.alias,
          plugin: svc.plugin,
          sourceName: svc.sourceName,
          self: svc.self,
        },
      });
    }
    await this.syncSecrets(parsedServices, admittedPlugins);
    this._overrideAdmittedPlugins = admittedPlugins;

    const autoServices = [...this.services.values()].filter(s => s.preview === "auto");
    for (const svc of autoServices) {
      this.updateServiceStatus(svc.name, "starting");
    }

    this.gatedServices.clear();
    this.postGateServices.clear();
    this.stoppedByUser.clear();
    this._gatedTeardown = null;
    const gateOpen = !this._installRunning && !this._installFailed;
    const startNow: ManagedService[] = [];
    for (const svc of autoServices) {
      if (svc.dependsOnInstall && !gateOpen) {
        if (this._installFailed) {
          this.updateServiceStatus(svc.name, "error", INSTALL_FAILED_GATE_MESSAGE);
          this.gatedServices.add(svc.name);
        } else {
          this.gatedServices.add(svc.name);
        }
      } else {
        startNow.push(svc);
      }
    }
    this._gateHeldSince = this.gatedServices.size > 0 && !this._installFailed ? Date.now() : null;

    try {
      // Compose starts every service when given no names; skip an empty batch.
      const autoNames = startNow.map(s => s.name);
      if (autoNames.length > 0) {
        await this.withUpInFlight(autoNames, async (start, names) => {
          await this.prepareContainedStartFn?.(names);
          this.armLogFollowerSince(names);
          await this.buildAndUp(start, names);
          markStackUp(this.sessionId, startNow.filter((svc) => names.includes(svc.name)));
          await this.containServicesFn?.([...this.services.keys()]);
        }, { removeOrphans: true });
      }
      this._started = true;

      await this.joinSessionNetwork();

      await this.poller.pollOnce();

      this._startupComplete = true;
      for (const svc of this.services.values()) {
        this.emit("service_status", { ...svc });
      }

      // Keep followers the poll already attached; replacing them clears their buffers.
      for (const svc of this.services.values()) {
        this.ensureLogFollower(svc.name);
      }
      this.disarmLogFollowerSince([...this.services.keys()]);

      // Persist refusals after followers decide whether to replay the container backlog.
      this.reportPortRefusals();
      this.reportGpuRemovals(autoNames);
      this.warnOnAmbiguousPreviewPorts();

      this.emit("stack_ready");
    } catch (err) {
      this._startupComplete = true;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const svc of startNow) {
        this.updateServiceStatus(svc.name, "error", error.message);
      }
      this.reportPortRefusals();
      this.emit("stack_error", error);
      throw err;
    } finally {
      // Keep polling after a failed start so services can recover their status and address.
      if (!this._disposed) this.poller.start();
    }
  }

  async startService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);
    this.refusePluginPortStart(name);

    this.retry.resetOomBudget(name);
    this.stoppedByUser.delete(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.withUpInFlight([name], async (start, names) => {
        await this.prepareContainedStartFn?.(names);
        this.armLogFollowerSince(names);
        await this.buildAndUp(start, names);
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // A later Stop owns the result of this start.
      if (this.stoppedByUser.has(name)) return;
      // Attach before the poll can consume the replay anchor with a follower we would replace.
      this.streamLogs(name);
      this.reportGpuRemovals([name]);
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
  }

  async restartService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);
    this.refusePluginPortStart(name);

    this.retry.resetOomBudget(name);
    this.stoppedByUser.delete(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.stopContainer(name);
      // A Stop during the shutdown wait has no in-flight up to chase; check before starting one.
      if (this.stoppedByUser.has(name)) return;
      await this.withUpInFlight([name], async (start, names) => {
        await this.prepareContainedStartFn?.(names);
        this.armLogFollowerSince(names);
        await this.buildAndUp(start, names);
        await this.containServicesFn?.([...this.services.keys()]);
      });
      if (this.stoppedByUser.has(name)) return;
      this.streamLogs(name);
      this.reportGpuRemovals([name]);
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
  }

  // Stop now, then stop anything a racing up creates after this call returns.
  async stopService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);

    this.stoppedByUser.add(name);
    this.retry.clearRetryState(name);
    // Capture before awaiting stop; a start that settles during it removes its own entry.
    const pendingUps = [...(this.upSettled.get(name) ?? [])];
    try {
      await this.stopContainer(name);
      this.updateServiceStatus(name, "stopped");
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
    // Do not make Stop wait for a hung build.
    if (pendingUps.length > 0) void this.stopAfterPendingUps(name, pendingUps);
  }

  private async stopAfterPendingUps(name: string, pendingUps: Promise<void>[]): Promise<void> {
    await Promise.all(pendingUps);
    if (this._disposed) return;
    if (!this.stoppedByUser.has(name)) return;
    try {
      await this.stopContainer(name);
      this.updateServiceStatus(name, "stopped");
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] follow-up stop for ${name} failed:`,
        (err as Error).message,
      );
    }
  }

  streamLogs(name: string): () => void {
    const existing = this.logProcesses.get(name);
    if (existing) {
      killChild(existing);
      this.logProcesses.delete(name);
    }

    this.logBuffers.delete(name);

    // Once history is persisted, replay only the gap since up began, or follow new lines.
    const channel = `service:${name}`;
    const seeded = this.logStore?.hasChannel(this.sessionId, channel) ?? false;
    const since = this.followerSince.get(name);
    this.followerSince.delete(name);
    const window = this.logStore && seeded
      ? (since ? ["--since", since, "--tail", "1000"] : ["--tail", "0"])
      : ["--tail", "1000"];

    const args = this.compose.modelFreeArgs("logs", "-f", ...window, "--no-log-prefix", name);
    let cwd: string;
    try {
      cwd = this.compose.modelFreeDir();
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] log follower for ${name} not started:`, (err as Error).message);
      return () => {};
    }
    const proc = spawn("docker", args, {
      cwd,
      env: composeSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleData = (chunk: Buffer) => {
      const text = chunk.toString();
      this.logStore?.append(this.sessionId, channel, text);
      this.bufferServiceLog(name, text);
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    proc.on("error", (err: Error) => {
      console.warn(`[compose:${this.sessionId}] log follower for ${name} failed to start:`, err.message);
      if (this.logProcesses.get(name) === proc) this.logProcesses.delete(name);
    });

    proc.on("close", () => {
      if (this.logProcesses.get(name) === proc) this.logProcesses.delete(name);
    });

    this.logProcesses.set(name, proc);

    return () => {
      killChild(proc);
      this.logProcesses.delete(name);
    };
  }

  private ensureLogFollower(name: string): void {
    if (this.logProcesses.has(name)) return;
    this.streamLogs(name);
  }

  // Millisecond precision avoids replaying the outgoing container's final second of logs.
  private armLogFollowerSince(names: readonly string[]): void {
    const at = new Date().toISOString();
    for (const name of names) this.followerSince.set(name, at);
  }

  // Clear after polling gives replacement followers a chance to claim the anchor.
  private disarmLogFollowerSince(names: readonly string[]): void {
    for (const name of names) this.followerSince.delete(name);
  }

  /** Call before reconcile; returns whether the config changed. */
  updateComposeConfig(next: ComposeConfig, opts: { noProjectCompose?: boolean } = {}): boolean {
    const noProjectCompose = opts.noProjectCompose ?? false;
    const changed =
      next.file !== this.composeConfig.file ||
      next.dockerSocket !== this.composeConfig.dockerSocket ||
      noProjectCompose !== this.noProjectCompose;
    if (!changed) return false;
    this.composeConfig = next;
    this.noProjectCompose = noProjectCompose;
    // The old failure describes a different file or policy; clear it before queued reconciliation.
    this._projectComposeFailure = null;
    return true;
  }

  // Let Compose reconcile changed services; the cold-start sweep would kill healthy previews.
  async reconcile(): Promise<void> {
    for (const [, proc] of this.logProcesses) killChild(proc);
    this.logProcesses.clear();
    this.poller.stop();
    this.retry.cancelAll();
    this.cancelStartingWatchdogs();
    this.cancelPluginPortProbes();
    // Old starts must not exempt same-named services in the new definition indefinitely.
    this.upInFlight.clear();
    this.upLastOutputAt.clear();
    this.upSettled.clear();

    this.services.clear();
    this.logBuffers.clear();
    this._started = false;
    this._startupComplete = false;
    this.startError = null;
    // Preserve projectComposeFailure until a new parse answers; start can fail before parsing.
    await this.start({ sweepStaleContainers: false });
  }

  /** removeVolumes also deletes isolated secret files; use it only for permanent teardown. */
  async stop(opts: { removeVolumes?: boolean } = {}): Promise<void> {
    this._disposed = true;
    this.poller.stop();
    this.retry.cancelAll();
    this.cancelStartingWatchdogs();
    this.cancelPluginPortProbes();
    this.postGateServices.clear();
    this._gatedTeardown = null;
    this._gateHeldSince = null;
    forgetStackUp(this.sessionId);

    for (const [name, proc] of this.logProcesses) {
      killChild(proc);
      this.logProcesses.delete(name);
    }

    await this.stopRunningServices();
    try {
      await this.compose.downModelFree({ removeVolumes: opts.removeVolumes ?? false });
      this.startRecord.clear();
    } catch {
      // Best-effort cleanup
    }

    if (opts.removeVolumes) {
      removeSessionServiceEnvDir({ rootDir: this.serviceEnvDir, sessionId: this.sessionId });
      fs.rmSync(this.projectFileCopiesDir(), { recursive: true, force: true });
    }

    if (opts.removeVolumes && this.secretsInternalDir) {
      removeSessionSecretsDir({ internalDir: this.secretsInternalDir, sessionId: this.sessionId });
    }

    for (const [name] of this.services) {
      this.updateServiceStatus(name, "stopped");
    }
    this.logBuffers.clear();
    this._started = false;
  }

  /** Refresh declarations and values without restarting containers. */
  async refreshSecretsStatus(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      parsedServices = this.noProjectCompose ? [] : await this.readProjectCompose();
    } catch {
      // An empty sync would delete env files belonging to services still running.
      return;
    }
    await this.syncSecrets(parsedServices, this.pluginServices);
  }

  async refreshSecrets(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      parsedServices = this.noProjectCompose ? [] : await this.readProjectCompose();
    } catch {
      return;
    }
    // Each start writes its own override from the resolver's values.
    await this.syncSecrets(parsedServices, this.pluginServices);

    if (!this._started) return;
    // Manual services retain their old values until explicitly restarted.
    const autoNames = [...this.services.values()]
      .filter(s => s.preview === "auto")
      .map(s => s.name);
    if (autoNames.length === 0) return;
    try {
      await this.withUpInFlight(autoNames, async (start, names) => {
        await this.prepareContainedStartFn?.(names);
        this.armLogFollowerSince(names);
        await this.buildAndUp(start, names);
        await this.containServicesFn?.([...this.services.keys()]);
      }, { removeOrphans: true });
      await this.poller.pollOnce();
      for (const name of autoNames) this.ensureLogFollower(name);
      this.disarmLogFollowerSince(autoNames);
      this.reportGpuRemovals(autoNames);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] refreshSecrets compose up failed:`, (err as Error).message);
    }
  }

  // A failure matters only to a stack that mounts a workspace subdirectory, so the generator decides.
  private async workspaceDevice(): Promise<string | undefined> {
    if (!this.resolveWorkspaceDevice) return undefined;
    try {
      return await this.resolveWorkspaceDevice();
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] could not resolve the workspace's path on the Docker host:`,
        (err as Error).message,
      );
      return undefined;
    }
  }

  // Share every override option across writers; resolver reads are not an atomic snapshot.
  private buildOverrideOptions(
    workspaceDevice: string | undefined,
    builtServices: readonly string[],
  ): ComposeOverrideOptions {
    const dockerSecretsBuild = this.secrets.getDockerSecretsBuild();
    const serviceEnvFiles = this.secrets.getServiceEnvFiles();
    const pluginServiceEnv = this.secrets.getPluginServiceEnv();
    return {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      ...(workspaceDevice ? { workspaceDevice } : {}),
      stackName: this.stackName,
      ...(this.egressContained() ? { containEgress: true } : {}),
      ...(this.containServicesFn ? { isolateNetwork: true } : {}),
      ...(this.containServiceDns ? { containDns: true } : {}),
      ...(this.containServiceProxy ? { containProxy: true } : {}),
      ...(builtServices.length > 0 ? { builtServices } : {}),
      ...(dockerSecretsBuild ? { dockerSecrets: dockerSecretsBuild } : {}),
      ...(serviceEnvFiles ? { serviceEnvFiles } : {}),
      ...(pluginServiceEnv ? { pluginServiceEnv } : {}),
      ...(this.overlayDepDirs.length > 0 ? { overlayDepDirs: this.overlayDepDirs } : {}),
    };
  }

  private parseOptions(): ComposeParseOptions {
    return {
      dockerSocket: this.composeConfig.dockerSocket,
      dockerSocketGrant: this.dockerSocketGrant(),
      containEgress: this.egressContained(),
      isolateNetwork: Boolean(this.containServicesFn),
      trustedOpsProxy: this.opsSession,
    };
  }

  // A fresh confined read for each operation: the agent can change the file at any time.
  private async readProjectCompose(): Promise<ComposeService[]> {
    let raw: Buffer;
    try {
      raw = await this.confined.readProjectFile(this.composeConfig.file);
    } catch (err) {
      throw this.recordComposeFailure(projectFileError(err));
    }
    return this.parseProjectCompose(raw, this.parseOptions());
  }

  private parseProjectCompose(raw: Buffer, opts: ComposeParseOptions): ComposeService[] {
    const parsed = this.checked(() => parseComposeContent(raw, opts));
    this._projectComposeFailure = null;
    return parsed;
  }

  // List readers need the reason too; throwing only informs the initiating caller.
  private recordComposeFailure(err: unknown): unknown {
    this._projectComposeFailure = classifyComposeFailure(err);
    return err;
  }

  private checked<T>(check: () => T): T {
    try {
      return check();
    } catch (err) {
      throw this.recordComposeFailure(err);
    }
  }

  // Sync even with no secrets declared, to clear obsolete env files.
  private async syncSecrets(
    projectServices: ComposeService[],
    plugins: readonly PluginComposeService[],
  ): Promise<void> {
    await this.secrets.sync(projectServices, plugins);
    this._syncedProjectServices = JSON.stringify(projectServices);
  }

  /**
   * The before-`up` sequence (docs/318-compose-remaining-escapes, Mechanism 2): a confined `config`
   * of the named project services, the raw gate on the bytes it read, validation and rewrite of the
   * resolved model, and this start's snapshot and override. A start of plugin services only, and a
   * stack with no project file, start from the override alone.
   */
  private async prepareStart(names: string[]): Promise<PreparedStart> {
    const admitted = this._overrideAdmittedPlugins;
    const pluginNames = new Set(admitted.map((svc) => svc.name));
    const projectNames = names.filter((name) => !pluginNames.has(name));
    const files = this.startRecord.allocate();
    try {
      this.removeLegacyOverride();
      if (this.noProjectCompose || projectNames.length === 0) {
        await this.writeStartOverride(files.overrideFile, admitted.map(toComposeService), []);
        return {
          id: files.id,
          model: { overrideFile: files.overrideFile },
          snapshotServices: [],
          ...(this.noProjectCompose ? { projectServiceNames: [] } : {}),
          ...this.serviceEnvMount(),
        };
      }

      const opts = this.parseOptions();
      const stubs = pluginStubModel(admitted);
      let resolved: { stdout: string; projectFile: Buffer };
      try {
        resolved = await this.confined.config({
          projectFile: this.composeConfig.file,
          services: projectNames,
          ...(admitted.length > 0 ? { stdin: serializeComposeModel(stubs) } : {}),
        });
      } catch (err) {
        // The raw gate's refusal is clearer than Compose's failure on the same bytes.
        if (err instanceof ComposeHelperError && err.projectFile) this.parseProjectCompose(err.projectFile, opts);
        throw this.recordComposeFailure(projectFileError(err));
      }
      const projectServices = this.parseProjectCompose(resolved.projectFile, opts);
      const clash = projectServices.find((svc) => pluginNames.has(svc.name));
      if (clash) {
        throw this.recordComposeFailure(new ComposeValidationError(
          `Service \`${clash.name}\` has the name of an imported plugin service. Rename the project's service.`,
        ));
      }
      const model = this.checked(() => parseResolvedModel(resolved.stdout));
      // `up` gets the real plugin services from the override.
      const services = Object.fromEntries(Object.entries(model.services as Record<string, Record<string, unknown>>)
        .filter(([name]) => !pluginNames.has(name)));
      model.services = services;
      const check = this.checked(() => validateResolvedModel(model, {
        ...opts,
        project: composeProjectName(this.sessionId),
        workspaceDir: this.workspaceDir,
      }));

      const persistUse = this.checked(() => resolvedPersistUse(model));
      let persist: PersistVolume | undefined;
      if (persistUse.used) {
        // A volume subpath must exist when mounted, and the agent can delete one.
        const scratchDir = sessionScratchDirForWorkspace(this.workspaceDir);
        preparePersistDir(scratchDir, persistUse.subpaths);
        persist = { device: await this.persistDevicePath(scratchDir) };
      }
      const workspaceDevice = await this.workspaceDevice();
      const gpu = Object.values(services).some(requestsGpu) ? await this.sessionGpu() : undefined;
      const rewrite = rewriteResolvedModel(model, {
        sessionId: this.sessionId,
        workspaceDir: this.workspaceDir,
        ...(this.workspaceVolume ? { workspaceVolume: this.workspaceVolume } : {}),
        ...(this.workspaceSubpath ? { workspaceSubpath: this.workspaceSubpath } : {}),
        ...(workspaceDevice ? { workspaceDevice } : {}),
        ...(persist ? { persist } : {}),
        ...(this.stackName ? { stackName: this.stackName } : {}),
        gpuGranted: gpu?.state === "granted",
      });
      this.gpuRemovals = new Map(rewrite.gpuRemoved.map((name) => [
        name,
        `${name} asks for a GPU. ShipIt started it without one, because ${noGpuWhy(gpu)}.`,
      ]));
      const buildModel = serializeComposeModel(composeBuildModel(rewrite.model, rewrite.projectFiles, stubs));
      await this.copyProjectFiles(rewrite);
      writeRootOnlyFile(files.snapshotFile, serializeComposeModel(rewrite.model));

      if (JSON.stringify(projectServices) !== this._syncedProjectServices) {
        console.log(`[compose:${this.sessionId}] compose file changed since the last start — refreshing service secrets`);
        await this.syncSecrets(projectServices, admitted);
      }
      const snapshotServices = Object.keys(services);
      const overrideServices = snapshotServices.map((name) => {
        const raw = projectServices.find((svc) => svc.name === name) ?? { name };
        const { volumes: _volumes, persistSubpaths: _persistSubpaths, ...rest } = raw;
        const mounts = rewrite.workspaceMounts.get(name);
        return {
          ...rest,
          user: normalizedUser(services[name]?.user),
          declaresHome: declaresHome(services[name]?.environment),
          trustedOpsProxy: check.trustedOpsProxies.has(name),
          ...(mounts ? { workspaceMounts: mounts } : {}),
        };
      });
      await this.writeStartOverride(
        files.overrideFile,
        [...overrideServices, ...admitted.map(toComposeService)],
        rewrite.builtServices,
      );
      return {
        id: files.id,
        model: { snapshotFile: files.snapshotFile, overrideFile: files.overrideFile },
        ...(rewrite.builtServices.length > 0
          ? { build: { model: buildModel, services: rewrite.builtServices } }
          : {}),
        snapshotServices,
        projectServiceNames: projectServices.map((svc) => svc.name),
        ...this.serviceEnvMount(),
      };
    } catch (err) {
      this.startRecord.discard(files.id);
      throw err;
    }
  }

  private async writeStartOverride(
    file: string,
    services: ComposeService[],
    builtServices: readonly string[],
  ): Promise<void> {
    const options = this.buildOverrideOptions(await this.workspaceDevice(), builtServices);
    writeRootOnlyFile(file, generateComposeOverride(services, options));
  }

  private serviceEnvMount(): { serviceEnvDir?: string } {
    const files = this.secrets.getServiceEnvFiles();
    return files && Object.keys(files).length > 0
      ? { serviceEnvDir: path.join(this.serviceEnvDir, this.sessionId) }
      : {};
  }

  private projectFileCopiesDir(): string {
    return path.join(this.composeStateDir, "secrets");
  }

  // The daemon would bind a project secret or config from the workspace on the Docker host, where
  // it follows symlinks; it mounts ShipIt's copy instead, read through the confined helper. The
  // copy is in the workspace volume, so a service gets it from the volume and not by a host path.
  private async copyProjectFiles(rewrite: SnapshotRewrite): Promise<void> {
    if (rewrite.projectFiles.length === 0) return;
    const copies: ProjectFileCopy[] = [];
    const dir = this.projectFileCopiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    for (const ref of rewrite.projectFiles) {
      const kind = ref.kind === "secrets" ? "Secret" : "Config";
      if (!PROJECT_FILE_KEY.test(ref.name)) {
        throw this.recordComposeFailure(new ComposeValidationError(
          `${kind} \`${ref.name}\`: ShipIt copies a \`file:\` only for a name of letters, digits, \`.\`, \`_\`, and \`-\`. Rename it.`,
        ));
      }
      const bytes = await this.confined.readWorkspaceFile(ref.file);
      const copy = path.join(dir, `${ref.kind}-${ref.name}`);
      const tmp = `${copy}.${randomBytes(4).toString("hex")}`;
      // The directory is root-only; the file keeps a mode a service's own user can read.
      fs.writeFileSync(tmp, bytes, { mode: 0o644 });
      fs.renameSync(tmp, copy);
      const block = rewrite.model[ref.kind] as Record<string, Record<string, unknown>>;
      block[ref.name].file = copy;
      if (this.workspaceVolume) copies.push({ kind: ref.kind, name: ref.name, subpath: this.volumeSubpathOf(copy) });
    }
    if (this.workspaceVolume) mountProjectFileCopies(rewrite.model, copies, this.workspaceVolume);
  }

  // Never fall back to a host path: Docker mounts an empty directory for one it cannot find.
  private volumeSubpathOf(file: string): string {
    const subpath = this.workspaceSubpath
      ? path.posix.join(this.workspaceSubpath, path.posix.relative(this.workspaceDir, file))
      : "..";
    if (subpath.startsWith("..")) {
      throw this.recordComposeFailure(new ComposeValidationError(
        `ShipIt could not locate ${file} inside the workspace volume, so it cannot mount it into a service.`,
      ));
    }
    return subpath;
  }

  // The override lived in the state directory before each start wrote its own; it holds credentials.
  private removeLegacyOverride(): void {
    if (this.legacyOverrideRemoved) return;
    this.legacyOverrideRemoved = true;
    fs.rmSync(path.join(this.stateDir, COMPOSE_OVERRIDE_FILE), { force: true });
  }

  /**
   * Resolves the start before counting it as in flight, so a refused start gets no polling
   * exemption; registers it with `upSettled` first, so a Stop during the resolve follows it.
   */
  private async withUpInFlight(
    names: string[],
    fn: (start: PreparedStart, names: string[]) => Promise<void>,
    opts: { removeOrphans?: boolean } = {},
  ): Promise<void> {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    for (const name of names) {
      const pending = this.upSettled.get(name) ?? new Set<Promise<void>>();
      pending.add(settled);
      this.upSettled.set(name, pending);
    }
    let counted: string[] = [];
    let start: PreparedStart | null = null;
    try {
      start = await this.prepareStart(names);
      const live = names.filter((name) => !this.stoppedByUser.has(name));
      if (live.length === 0) {
        console.log(`[compose:${this.sessionId}] ${names.join(", ")} stopped while the start resolved — not starting`);
        return;
      }
      for (const name of live) {
        this.upInFlight.set(name, (this.upInFlight.get(name) ?? 0) + 1);
        // Do not publish the outgoing container's address while its replacement starts.
        this.clearContainerIp(name);
        this.upLastOutputAt.set(name, Date.now());
      }
      counted = live;
      if (opts.removeOrphans && start.projectServiceNames) {
        const keep = new Set([...start.projectServiceNames, ...this._overrideAdmittedPlugins.map((svc) => svc.name)]);
        try {
          await this.compose.removeOrphanContainers(keep);
        } catch (err) {
          console.warn(`[compose:${this.sessionId}] orphan removal failed:`, (err as Error).message);
        }
      }
      await fn(start, live);
    } finally {
      for (const name of counted) {
        const next = (this.upInFlight.get(name) ?? 1) - 1;
        if (next > 0) this.upInFlight.set(name, next);
        else {
          this.upInFlight.delete(name);
          this.upLastOutputAt.delete(name);
        }
      }
      for (const name of names) {
        const pending = this.upSettled.get(name);
        if (!pending) continue;
        pending.delete(settled);
        if (pending.size === 0) this.upSettled.delete(name);
      }
      settle();
      if (start) {
        this.startRecord.release(start.id);
        this.startRecord.prune();
      }
      // Give the network join and first poll a full window after up settles.
      for (const name of counted) {
        if (!this.upInFlight.has(name) && this.services.get(name)?.status === "starting") {
          this.armStartingWatchdog(name);
        }
      }
    }
  }

  private async buildAndUp(start: PreparedStart, names: string[]): Promise<void> {
    const sink = this.composeLogSink(names);
    await this.compose.build(start.build, sink);
    // Before `up`: a failed `up` can still have created containers, which `stop` must find.
    this.startRecord.record(
      [...new Set([...start.snapshotServices, ...names])],
      { id: start.id, snapshot: start.model.snapshotFile !== undefined },
    );
    await this.compose.up(names, start, sink);
  }

  /** From the model the service was started from, so Compose runs its `pre_stop` hook. */
  private async stopContainer(name: string): Promise<void> {
    const recorded = this.startRecord.lookup(name);
    if (recorded.recorded) {
      await this.compose.stopFrom(name, recorded.model);
      return;
    }
    if (!(await this.compose.hasContainer(name))) {
      console.log(`[compose:${this.sessionId}] ${name} has no container — recorded the stop only`);
      return;
    }
    await this.compose.stopFrom(name, null);
  }

  private async stopRunningServices(): Promise<void> {
    let running: string[];
    try {
      running = await this.compose.runningServices();
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] could not list running services before down:`, (err as Error).message);
      return;
    }
    await Promise.all(running.map(async (name) => {
      try {
        await this.stopContainer(name);
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] stopping ${name} before down failed:`, (err as Error).message);
      }
    }));
  }

  private bufferServiceLog(name: string, text: string): void {
    let buf = (this.logBuffers.get(name) ?? "") + text;
    if (buf.length > ServiceManager.MAX_LOG_BUFFER) {
      buf = truncateTerminalBuffer(buf, ServiceManager.MAX_LOG_BUFFER);
    }
    this.logBuffers.set(name, buf);
    this.emit("service_log", name, text);
  }

  // Do not seed durable history with build output: it would suppress the first container backlog.
  // Compose output is stack-wide, so each named service receives every line.
  private composeLogSink(names: string[]): ComposeOutputSink {
    let pending = "";
    const emit = (line: string): void => {
      if (!line.trim()) return;
      const text = `${COMPOSE_LOG_PREFIX}${line}\n`;
      for (const name of names) this.bufferServiceLog(name, text);
    };
    const sink: ComposeOutputSink = (chunk: string) => {
      // Count partial lines as progress too.
      const now = Date.now();
      for (const name of names) this.upLastOutputAt.set(name, now);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
      if (pending.length > MAX_COMPOSE_LOG_LINE) {
        emit(pending);
        pending = "";
      }
    };
    sink.flush = () => {
      const rest = pending;
      pending = "";
      emit(rest);
    };
    return sink;
  }

  private async runRetryNow(name: string): Promise<void> {
    if (this._disposed) return;
    const svc = this.services.get(name);
    if (!svc) return;
    if (this.stoppedByUser.has(name)) return;
    try {
      await this.withUpInFlight([name], async (start, names) => {
        await this.prepareContainedStartFn?.(names);
        this.armLogFollowerSince(names);
        await this.buildAndUp(start, names);
        await this.containServicesFn?.([...this.services.keys()]);
      });
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
      this.disarmLogFollowerSince([name]);
      this.reportGpuRemovals([name]);
    } catch (err) {
      const msg = (err as Error).message;
      if (this._installRunning) {
        this.retry.scheduleRetryWhileInstalling(name, -1);
      } else {
        this.updateServiceStatus(name, "error", msg);
      }
    }
  }

  private flushPostInstallRetries(): void {
    if (this._disposed) return;

    const errorServices: string[] = [];
    for (const svc of this.services.values()) {
      if (this.gatedServices.has(svc.name)) continue;
      if (svc.preview === "auto" && svc.status === "error") {
        errorServices.push(svc.name);
      }
    }
    const targets = this.retry.collectPostInstallRetryTargets(errorServices);

    if (targets.size === 0) return;
    console.log(
      `[compose:${this.sessionId}] install finished — restarting ${targets.size} service(s): ${[...targets].join(", ")}`,
    );

    for (const name of targets) {
      this.retry.resetInstallAttempts(name);
      this.updateServiceStatus(name, "starting");
      void this.runRetryNow(name);
    }
  }

  // Recover a lost release, never an unfinished or failed install or a pending teardown.
  private checkInstallGateLiveness(now = Date.now()): void {
    const wedged =
      !this._disposed &&
      this.gatedServices.size > 0 &&
      !this._installRunning &&
      !this._installFailed &&
      this._gateReleasesInFlight === 0;

    if (!wedged) {
      this._gateWedgedSince = null;
      return;
    }

    if (this._gateWedgedSince === null) {
      this._gateWedgedSince = now;
      return;
    }

    const heldMs = now - this._gateWedgedSince;
    if (heldMs < this.gateWatchdogSettleMs) return;

    this._gateWedgedSince = null;
    console.warn(
      `[compose:${this.sessionId}] install gate watchdog: ${this.gatedServices.size} service(s) ` +
      `(${[...this.gatedServices].join(", ")}) have been held for ${Math.round(heldMs / 1000)}s with no ` +
      `install running, no failed install, and no teardown pending — the gate's release was lost, and no ` +
      `gate event will arrive to open it. Reopening it.`,
    );
    this.startGatedServices();
  }

  private startGatedServices(): void {
    if (this._disposed) return;
    if (this.gatedServices.size === 0) {
      if (this._started) {
        console.log(
          `[compose:${this.sessionId}] install gate open skipped — no services are held`,
        );
      }
      return;
    }
    const names = [...this.gatedServices].filter(n => !this.stoppedByUser.has(n));
    const held = this.gatedServices.size - names.length;
    this.gatedServices.clear();
    if (names.length === 0) {
      console.log(
        `[compose:${this.sessionId}] install finished — all ${held} gated service(s) were stopped by the user; ` +
        `clearing the gate and starting nothing`,
      );
      this._gateHeldSince = null;
      return;
    }
    const heldNote = held > 0 ? ` (${held} left stopped at the user's request)` : "";
    console.log(
      `[compose:${this.sessionId}] install finished — starting ${names.length} gated service(s): ${names.join(", ")}${heldNote}`,
    );
    this.reportGateHeld("started", names.length);
    for (const name of names) {
      this.updateServiceStatus(name, "starting");
      this.postGateServices.add(name);
    }
    // Serialize against reconciliation and carry the generation across the queue wait.
    const generation = this._gateGeneration;
    void serializeStackOp(this.sessionId, () => this.startGatedBatch(names, generation));
  }

  private async startGatedBatch(requested: string[], generation: number): Promise<void> {
    if (this._disposed) return;
    if (this._gateGeneration !== generation) {
      console.log(
        `[compose:${this.sessionId}] dropping stale gated start for ${requested.join(", ")} — ` +
        `a newer install gate cycle owns them`,
      );
      return;
    }
    // A service can be removed or stopped while this batch waits in the queue.
    const names = requested.filter(n => this.services.has(n) && !this.stoppedByUser.has(n));
    if (names.length === 0) return;
    try {
      await this.withUpInFlight(names, async (start, live) => {
        await this.prepareContainedStartFn?.(live);
        this.armLogFollowerSince(live);
        await this.buildAndUp(start, live);
        markStackUp(this.sessionId, live.flatMap(n => this.services.get(n) ?? []));
        await this.containServicesFn?.([...this.services.keys()]);
      }, { removeOrphans: true });
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
      this.disarmLogFollowerSince(names);
      this.reportGpuRemovals(names);
    } catch (err) {
      const msg = (err as Error).message;
      for (const name of names) {
        this.updateServiceStatus(name, "error", msg);
      }
    }
  }

  private latchGatedServicesToError(): void {
    if (this.gatedServices.size === 0) return;
    console.log(
      `[compose:${this.sessionId}] install failed — ${this.gatedServices.size} gated service(s) not started`,
    );
    this.reportGateHeld("install-failed", this.gatedServices.size);
    for (const name of this.gatedServices) {
      this.updateServiceStatus(name, "error", INSTALL_FAILED_GATE_MESSAGE);
    }
  }

  private reportGateHeld(outcome: "started" | "install-failed", services: number): void {
    const since = this._gateHeldSince;
    this._gateHeldSince = null;
    if (since === null) return;
    console.log(
      `[timing] install-gate for ${this.sessionId} held=${Date.now() - since}ms ` +
        `services=${services} outcome=${outcome}`,
    );
  }

  private holdGatedServicesForReinstall(): void {
    if (this._disposed) return;
    const gated = [...this.services.values()].filter(
      s => s.preview === "auto" && s.dependsOnInstall,
    );
    if (gated.length === 0) return;
    this.gatedServices = new Set(gated.map(s => s.name));
    this._gateHeldSince = Date.now();
    console.log(
      `[compose:${this.sessionId}] install re-running — holding ${gated.length} gated service(s): ${gated.map(s => s.name).join(", ")}`,
    );
    for (const svc of gated) {
      this.updateServiceStatus(svc.name, "starting");
      this.postGateServices.delete(svc.name);
      this.retry.clearPostGateState(svc.name);
      this.retry.cancelPostGateStableTimer(svc.name);
      // Reinstall can interrupt the stable-uptime reset, so grant a fresh OOM budget here.
      this.retry.resetOomBudget(svc.name);
    }
    this._gatedTeardownGeneration = ++this._gateGeneration;
    this._gatedTeardown = this.stopGatedForReinstall([...this.gatedServices]);
  }

  private gatedTeardownTimeoutMs(name: string): number {
    const declared = this.services.get(name)?.stopGracePeriodMs;
    return (declared ?? DEFAULT_STOP_GRACE_PERIOD_MS) + GATED_TEARDOWN_GRACE_MARGIN_MS;
  }

  // Bound parallel stops so a hung daemon cannot hold the install gate forever.
  private async stopGatedForReinstall(names: string[]): Promise<void> {
    await Promise.all(names.map(async (name) => {
      if (this._disposed) return;
      const timeoutMs = this.gatedTeardownTimeoutMs(name);
      try {
        const outcome = await settleOrTimeout(this.stopContainer(name), timeoutMs);
        if (outcome === "timeout") {
          console.warn(
            `[compose:${this.sessionId}] gated teardown: 'compose stop ${name}' still running after ` +
            `${Math.round(timeoutMs / 1000)}s (grace period + margin) — abandoning the wait so the ` +
            `install gate can reopen`,
          );
        }
      } catch (err) {
        console.warn(
          `[compose:${this.sessionId}] failed to stop gated service ${name} for re-install:`,
          (err as Error).message,
        );
      }
    }));
  }

  // Retry after each up: an all-manual stack has no network until its first service starts.
  // Bound the wait so a hung join does not block status and address polling.
  private async joinSessionNetwork(): Promise<void> {
    if (!this.networkJoinFn) return;
    const networkName = `shipit-session-${this.sessionId}`;
    try {
      await withTimeout(
        this.networkJoinFn(networkName),
        NETWORK_JOIN_TIMEOUT_MS,
        `network join for ${networkName} did not complete within ${NETWORK_JOIN_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] joinSessionNetwork failed:`,
        (err as Error).message,
      );
    }
  }

  private armStartingWatchdog(name: string): void {
    this.clearStartingWatchdog(name);
    if (this._disposed) return;
    const timer = setTimeout(() => {
      this.startingWatchdogs.delete(name);
      this.onStartingWatchdogFired(name);
    }, STARTING_WATCHDOG_MS);
    timer.unref?.();
    this.startingWatchdogs.set(name, timer);
  }

  private clearStartingWatchdog(name: string): void {
    const timer = this.startingWatchdogs.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.startingWatchdogs.delete(name);
  }

  private cancelPluginPortProbes(): void {
    for (const timer of this.portProbeTimers.values()) clearTimeout(timer);
    this.portProbeTimers.clear();
    // Keep settled verdicts to avoid repeating diagnostics after each reconcile.
  }

  private cancelStartingWatchdogs(): void {
    for (const timer of this.startingWatchdogs.values()) clearTimeout(timer);
    this.startingWatchdogs.clear();
  }

  private onStartingWatchdogFired(name: string): void {
    if (this._disposed) return;
    const svc = this.services.get(name);
    if (svc?.status !== "starting") return;
    if (this.upInFlight.has(name)) {
      const silentFor = Date.now() - (this.upLastOutputAt.get(name) ?? 0);
      if (silentFor < UP_SILENCE_TIMEOUT_MS) {
        this.armStartingWatchdog(name);
        return;
      }
      console.warn(
        `[compose:${this.sessionId}] compose up for "${name}" has produced no output for ` +
        `${Math.round(silentFor / 1000)}s and has not returned — marking error`,
      );
      this.updateServiceStatus(name, "error", UP_STALLED_MESSAGE);
      return;
    }
    if (this.gatedServices.has(name)) {
      this.armStartingWatchdog(name);
      return;
    }
    console.warn(
      `[compose:${this.sessionId}] service "${name}" has been starting for ` +
      `${Math.round(STARTING_WATCHDOG_MS / 1000)}s with no compose up in flight — marking error`,
    );
    this.updateServiceStatus(name, "error", STARTING_TIMEOUT_MESSAGE);
  }

  private clearContainerIp(name: string): void {
    const svc = this.services.get(name);
    if (svc) delete svc.containerIp;
  }

  private updateServiceStatus(name: string, status: ServiceStatus, error?: string): void {
    const svc = this.services.get(name);
    if (!svc) return;
    svc.status = status;
    svc.error = error;
    // Keep addresses during starting: the poller may have just resolved a restarting container.
    if (status === "stopped" || status === "error") delete svc.containerIp;
    if (status === "starting") {
      this.armStartingWatchdog(name);
    } else {
      this.clearStartingWatchdog(name);
    }
    if (this._startupComplete) {
      this.emit("service_status", { ...svc });
    }
  }

}

function hasLiveAddress(svc: ManagedService): svc is ManagedService & { containerIp: string; port: number } {
  return (
    !!svc.containerIp &&
    !!svc.port &&
    (svc.status === "running" || svc.status === "starting")
  );
}

/** One start's files, from the before-`up` sequence (docs/318-compose-remaining-escapes, Mechanism 2). */
interface PreparedStart {
  id: string;
  model: ComposeStartModel;
  build?: ComposeBuild;
  /** The services the snapshot holds: the named project services and their dependencies. */
  snapshotServices: string[];
  /** Every service of the project file, for orphan removal; absent when this start did not read it. */
  projectServiceNames?: string[];
  serviceEnvDir?: string;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Compose's own rule for a secret or config key; the copy is named after it.
const PROJECT_FILE_KEY = /^[A-Za-z0-9._-]+$/;

// Compose could not read or resolve the project file: the start is refused with its message (req 6).
function projectFileError(err: unknown): unknown {
  if (err instanceof ComposeHelperError && err.kind === "failed") {
    return new ComposeValidationError(err.message, "malformed");
  }
  return err;
}

function parseResolvedModel(stdout: string): Record<string, unknown> {
  let model: unknown;
  try {
    model = parseYaml(stdout);
  } catch (err) {
    throw new ComposeValidationError(
      `ShipIt could not read the model Compose resolved: ${(err as Error).message}`,
      "malformed",
    );
  }
  if (!isMapping(model) || !isMapping(model.services)) {
    throw new ComposeValidationError("Compose's resolved model has no `services` section.", "malformed");
  }
  return unescapeComposeDollars(model) as Record<string, unknown>;
}

function describeExit(exitCode: number, oomKilled?: boolean): string {
  if (exitCode !== 137) return `Exited with code ${exitCode}`;
  if (oomKilled === true) return "Exited with code 137 (OOMKilled)";
  if (oomKilled === false) return "Exited with code 137 (SIGKILL — not an OOM kill)";
  return "Exited with code 137 (likely OOMKilled)";
}
