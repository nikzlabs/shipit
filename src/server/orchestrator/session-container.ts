import type Docker from "dockerode";
import { createDockerClient } from "./docker-client.js";
import { EventEmitter } from "node:events";
import {
  createContainer,
  destroyContainer,
  buildContainerConfig,
  cleanupSessionDockerResources,
  type LifecycleDeps,
  type CreateContainerOpts,
} from "./container-lifecycle.js";
import {
  rediscoverContainers,
  adoptRunningContainer,
  isTrackedContainerRunning,
  cleanupOrphanContainers,
  reapStandbyContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";
import { reapSessionEgressSidecars } from "./egress-orphan-reaper.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
  createHealthMonitorState,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";
import { type HostMount } from "../shared/shipit-config.js";
import {
  resolveAgentDockerLimits,
  readAgentConfig,
} from "./container-config-builder.js";
import {
  resolveWorkerImageId as resolveWorkerImageIdFn,
  resolveWorkerBaseDigest as resolveWorkerBaseDigestFn,
  resolveWorkerNodeVersion as resolveWorkerNodeVersionFn,
  prepareOverlaySpecs as prepareOverlaySpecsFn,
  resolveSiblingOverlayDepDirs as resolveSiblingOverlayDepDirsFn,
  preparePnpmStore as preparePnpmStoreFn,
  type OverlayProvisionerDeps,
} from "./container-overlay-provisioner.js";
import type { DepDirOverlaySpec } from "./overlay-session.js";
import { egressEnforceEnabled, allowEgressToSubnets } from "./egress-firewall-install.js";
import { extractNetworkSubnets } from "./egress-firewall.js";
import {
  containComposeServices as applyComposeServiceEgress,
  invalidateComposeServiceContainment,
} from "./compose-service-egress.js";
import { egressDnsEnabled, orchestratorCallbackHost } from "./egress-dns-install.js";
import { egressProxyEnabled } from "./egress-proxy-install.js";
import {
  kernelRuntime,
  resolveSeccompSecurityOpt,
  readonlyRootfsEnabled,
} from "./container-hardening.js";
import { reloadEgressSidecars } from "./egress-reload.js";
import { listEgressAllowedHosts } from "./egress-policy.js";
import type { PluginEgressPolicy } from "./plugin-egress.js";
import type { ResolvedEgressConfig } from "./egress-allowlist.js";
import type { SessionCapabilities, SessionInfo } from "../shared/types.js";

export {
  buildMounts,
  buildEnv,
  DEP_CACHE_CONTAINER_PATH,
  waitForWorkerHealth,
  createContainer,
  cleanupSessionDockerResources,
  destroyContainer,
  buildContainerConfig,
  type LifecycleDeps,
} from "./container-lifecycle.js";

export {
  rediscoverContainers,
  adoptRunningContainer,
  isTrackedContainerRunning,
  cleanupOrphanContainers,
  reapStandbyContainers,
  getSessionByContainerIp,
  type DiscoveryDeps,
} from "./container-discovery.js";

export {
  startHealthMonitor,
  stopHealthMonitor,
  type HealthDeps,
  type HealthMonitorState,
} from "./container-health.js";

export {
  resolveAgentDockerLimits,
  readAgentConfig,
  deriveSessionMemorySizing,
  type AgentDockerLimits,
  type SessionMemorySizing,
} from "./container-config-builder.js";

export interface ContainerConfig {
  sessionId: string;
  sessionDir: string;
  /** Host clone path, mounted at /workspace; must be a child of sessionDir. */
  workspaceDir: string;
  depCacheDir?: string;
  /** Must share the workspace filesystem so pnpm can hardlink dependencies. */
  pnpmStoreDir?: string;
  uploadsDir?: string;
  /** Mounted at /persist, outside the clone. */
  scratchDir?: string;
  /** Mounted at /session-state; generated platform files must stay outside the clone. */
  sessionStateDir: string;
  credentialsDir: string;
  imageName: string;
  /** Bytes. */
  memoryLimit: number;
  /** Microseconds per 100ms period. */
  cpuQuota: number;
  pidsLimit: number;
  env?: Record<string, string>;
  extraLabels?: Record<string, string>;
  dockerAccess?: boolean;
  /** Derive from the server's session kind, never workspace files. */
  opsSession?: boolean;
  hostMounts?: HostMount[];
  overlaySpecs?: DepDirOverlaySpec[];
}

export interface SessionContainer {
  id: string;
  sessionId: string;
  containerIp: string;
  workerUrl: string;
  workerToken?: string;
  status: "starting" | "running" | "stopping" | "stopped";
  workerBuildId?: string;
  hostWorkspaceDir: string;
  dockerAccess: boolean;
  opsSession?: boolean;
  sessionNetworkName?: string;
  /** Child-container limits; bootedLimits describes the agent. */
  resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
  bootedLimits?: { memoryLimit: number; cpuQuota: number; pidsLimit: number };
  overlayVolumeNames?: string[];
  /** Actual container mounts; live workspace config may have changed since creation. */
  overlayDepDirs?: { depDir: string; volumeName: string }[];
  /** Removed Compose siblings need reconciliation even if dependency directory names stayed the same. */
  overlayVolumesRecreated?: boolean;
  /** Undefined means boot policy unknown, not uncontained. */
  egressContainedAtStart?: boolean;
  /** Separate from containment: both network-on and network-off sandboxes are contained. */
  capabilitiesAtStart?: SessionCapabilities;
  /** Subnet rules must wait until installation finishes flushing OUTPUT. */
  egressFirewallReady?: Promise<void>;
  joinedSessionNetworks?: Set<string>;
}

export interface SessionContainerManagerEvents {
  container_exited: [sessionId: string, exitCode: number, error?: string];
  container_started: [sessionId: string];
  /** Agent teardown does not necessarily stop previews. */
  container_destroyed: [sessionId: string, previewsStopped: boolean];
  service_exited: [sessionId: string, info: {
    serviceName: string;
    containerId: string;
    exitCode: number;
    oom: boolean;
  }];
  /** Operator signal; platform sidecar exits are not project service failures. */
  session_child_exited: [sessionId: string, info: {
    containerId: string;
    exitCode: number;
    oom: boolean;
    egressSidecar: boolean;
  }];
  health_monitor_resumed: [info: { gapMs: number }];
}

export interface SessionContainerManagerOpts {
  socketPath?: string;
  docker?: Docker;
  imageName?: string;
  networkName?: string;
  memoryLimit?: number;
  cpuQuota?: number;
  pidsLimit?: number;
  workerPort?: number;
  skipHealthCheck?: boolean;
  workspaceVolume?: string;
  /** Orchestrator-visible root; overlay specs otherwise contain daemon-visible paths. */
  stateDir?: string;
  credentialsVolume?: string;
  stackName?: string;
  dockerImageName?: string;
  dockerProxyHost?: string;
  dockerProxyPort?: number;
  resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
}

const DEFAULT_IMAGE = process.env.SESSION_WORKER_IMAGE;
const DEFAULT_NETWORK = process.env.DOCKER_NETWORK;
const DEFAULT_MEMORY_LIMIT = 1536 * 1024 * 1024;
const DEFAULT_CPU_QUOTA = 50_000;
const DEFAULT_PIDS_LIMIT = 4096;
const DEFAULT_WORKER_PORT = 9100;

export const CONTAINER_LABEL_KEY = "shipit-session";
export const CONTAINER_LABEL_VALUE = "true";
export const CONTAINER_SESSION_ID_LABEL = "shipit-session-id";
export const CONTAINER_STACK_LABEL = "shipit-stack";
export const CONTAINER_STANDBY_LABEL = "shipit-standby";
export const CONTAINER_BUILD_ID_LABEL = "shipit-build-id";

// An unknown origin receives browser trust; topology changes must invalidate cached absence.
const ORIGIN_INDEX_REFRESH_MS = 5_000;
const ORIGIN_INDEX_FRESH_MS = 15_000;
const ORIGIN_INDEX_TIMEOUT_MS = 8_000;
const ORIGIN_LOOKUP_DEADLINE_MS = 1_500;
const ORIGIN_INDEX_IDLE_STOP_MS = 60_000;
const SESSION_RANGE_REFRESH_MS = 30_000;
const SESSION_RANGE_TIMEOUT_MS = 10_000;

function toIpv4(value: string): number | null {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((result, part) => (result * 256) + part, 0) >>> 0;
}

function ipInSubnet(ip: string, subnet: string): boolean {
  const target = toIpv4(ip);
  const [baseText, prefixText] = subnet.split("/");
  const base = baseText ? toIpv4(baseText) : null;
  const prefix = Number(prefixText);
  if (target === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (target & mask) === (base & mask);
}

export class SessionContainerManager extends EventEmitter<SessionContainerManagerEvents> {
  private docker: Docker;
  private containers = new Map<string, SessionContainer>();
  private composeEgressRuns = new Map<string, Promise<void>>();
  private composeServiceNames = new Map<string, string[]>();
  private containerOriginSessions = new Map<string, string>();
  private containerOriginRefresh?: Promise<void>;
  private containerOriginRefreshStartedAt = 0;
  private containerOriginRefreshedAt = 0;
  private containerOriginRefreshBackoffUntil = 0;
  private containerOriginRefreshFailed = false;
  private sessionNetworkRanges = new Map<string, { subnet: string; gateway?: string }[]>();
  private sessionNetworkRangeRefresh?: Promise<void>;
  private sessionNetworkRangeRefreshBackoffUntil = 0;
  private originIndexTimer?: NodeJS.Timeout;
  private originIndexLastUsedAt = 0;
  private originRangeRefreshedAt = 0;
  // A generation avoids same-millisecond ties when invalidating snapshots.
  private containerTopologyGeneration = 0;
  private containerTopologyMutations = 0;
  private imageName: string;
  private networkName: string;
  private defaultMemoryLimit: number;
  private defaultCpuQuota: number;
  private defaultPidsLimit: number;
  private workerPort: number;
  private skipHealthCheck: boolean;
  private workspaceVolume?: string;
  private stateDir?: string;
  private credentialsVolume?: string;
  private stackName?: string;
  private dockerImageName?: string;
  private dockerProxyHost?: string;
  private dockerProxyPort?: number;
  private resolveEgressConfig?: (sessionId: string) => ResolvedEgressConfig;
  private workerImageId?: string;
  private workerBaseDigest?: string;
  private workerNodeVersion?: string;
  private standbySessionIds = new Set<string>();
  // Create and destroy must share this map across rebuilt dependency bundles.
  private destroyEpochs = new Map<string, number>();
  private healthMonitorState: HealthMonitorState = createHealthMonitorState();
  private _disposed = false;
  private lastCreateErrors = new Map<string, { error: string; at: number }>();

  constructor(opts: SessionContainerManagerOpts = {}) {
    super();
    this.docker = opts.docker ?? createDockerClient({ socketPath: opts.socketPath ?? "/var/run/docker.sock" });
    const imageName = opts.imageName ?? DEFAULT_IMAGE;
    if (!imageName) throw new Error("SESSION_WORKER_IMAGE env var is required when no imageName option is provided");
    this.imageName = imageName;

    const networkName = opts.networkName ?? DEFAULT_NETWORK;
    if (!networkName) throw new Error("DOCKER_NETWORK env var is required when no networkName option is provided");
    this.networkName = networkName;
    this.defaultMemoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.defaultCpuQuota = opts.cpuQuota ?? DEFAULT_CPU_QUOTA;
    this.defaultPidsLimit = opts.pidsLimit ?? DEFAULT_PIDS_LIMIT;
    this.workerPort = opts.workerPort ?? DEFAULT_WORKER_PORT;
    this.skipHealthCheck = opts.skipHealthCheck ?? false;
    this.workspaceVolume = opts.workspaceVolume;
    this.stateDir = opts.stateDir;
    this.credentialsVolume = opts.credentialsVolume;
    this.stackName = opts.stackName;
    this.dockerImageName = opts.dockerImageName;
    this.dockerProxyHost = opts.dockerProxyHost;
    this.dockerProxyPort = opts.dockerProxyPort;
    this.resolveEgressConfig = opts.resolveEgressConfig;
  }

  get dockerClient(): Docker {
    return this.docker;
  }

  /** Null means unknown; an empty array means no overlay mounts. */
  provisionedOverlayDepDirs(sessionId: string): { depDir: string; volumeName: string }[] | null {
    const sc = this.containers.get(sessionId);
    if (!sc) return null;
    return sc.overlayDepDirs ?? [];
  }

  consumeOverlayVolumesRecreated(sessionId: string): boolean {
    const sc = this.containers.get(sessionId);
    if (!sc?.overlayVolumesRecreated) return false;
    sc.overlayVolumesRecreated = false;
    return true;
  }

  recordCapabilitiesAtStart(sessionId: string, capabilities: SessionCapabilities): void {
    const sc = this.containers.get(sessionId);
    if (sc) sc.capabilitiesAtStart = capabilities;
  }

  capabilitiesAtStart(sessionId: string): SessionCapabilities | null {
    const sc = this.containers.get(sessionId);
    if (sc?.status !== "running") return null;
    return sc.capabilitiesAtStart ?? null;
  }

  isEgressContained(sessionId: string): boolean {
    if (!egressEnforceEnabled()) return false;
    const sc = this.containers.get(sessionId);
    return sc?.egressContainedAtStart ?? this.resolveEgressConfig?.(sessionId)?.contained ?? true;
  }

  resolveEgress(sessionId: string): ResolvedEgressConfig | undefined {
    return this.resolveEgressConfig?.(sessionId);
  }

  pluginEgressPolicy(sessionId: string): PluginEgressPolicy {
    const contained = this.isEgressContained(sessionId);
    const config = this.resolveEgressConfig?.(sessionId);
    return {
      contained,
      config,
      // A sealed sandbox must not gain user hosts through a plugin.
      allowOnceHosts: contained && !config?.userHostsExcluded ? listEgressAllowedHosts(sessionId) : [],
      sidecarImage: process.env.SESSION_EGRESS_SIDECAR_IMAGE,
      dnsEnabled: this.isEgressDnsContained(sessionId),
      proxyEnabled: this.isEgressProxyContained(sessionId),
    };
  }

  isEgressDnsContained(sessionId: string): boolean {
    return this.isEgressContained(sessionId) && egressDnsEnabled();
  }

  isEgressProxyContained(sessionId: string): boolean {
    return this.isEgressContained(sessionId) && egressProxyEnabled();
  }

  async resetSessionNetwork(sessionId: string): Promise<void> {
    const network = this.docker.getNetwork(`shipit-session-${sessionId}`);
    let info: Docker.NetworkInspectInfo;
    try { info = await network.inspect(); } catch { return; }
    for (const containerId of Object.keys(info.Containers ?? {})) {
      try { await network.disconnect({ Container: containerId, Force: true }); } catch { /* already detached */ }
    }
    try { await network.remove(); } catch (error) {
      const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
      if (code !== 404) throw error;
    }
  }

  async ensureSessionNetworkMode(sessionId: string, internal: boolean): Promise<void> {
    const network = this.docker.getNetwork(`shipit-session-${sessionId}`);
    let info: Docker.NetworkInspectInfo;
    try { info = await network.inspect(); } catch { return; }
    if ((info.Internal ?? false) === internal) return;
    await this.resetSessionNetwork(sessionId);
  }

  async prepareComposeServiceStart(sessionId: string, _serviceNames: string[]): Promise<void> {
    if (!this.isEgressContained(sessionId)) return;
    // Learn subnets before services can send requests to the API guard.
    await this.recordSessionNetworkRanges(sessionId);
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`shipit-parent-session=${sessionId}`] },
    });
    const network = this.docker.getNetwork(`shipit-egress-${sessionId}`);
    for (const entry of containers) {
      const serviceName = entry.Labels?.["shipit-service-name"];
      if (!serviceName || entry.State === "running" || entry.State === "paused") continue;
      invalidateComposeServiceContainment(sessionId, entry.Id);
      try {
        await network.disconnect({ Container: entry.Id, Force: true });
      } catch (error) {
        const code = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
        const message = error instanceof Error ? error.message : String(error);
        if (code !== 404 && !/not connected|no such network|not found/i.test(message)) throw error;
      }
    }
  }

  async containComposeServices(sessionId: string, serviceNames: string[], refresh = false): Promise<void> {
    // Attaching a running service creates a new address after Compose's own bracket closes.
    const endTopologyChange = this.beginContainerTopologyChange();
    try {
      await this.containComposeServicesInner(sessionId, serviceNames, refresh);
    } finally {
      endTopologyChange();
    }
  }

  private async containComposeServicesInner(
    sessionId: string,
    serviceNames: string[],
    refresh: boolean,
  ): Promise<void> {
    if (!egressEnforceEnabled()) return;
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    const sc = this.containers.get(sessionId);
    const config = this.resolveEgressConfig?.(sessionId) ?? { contained: true, extraHosts: [] };
    const contained = sc?.egressContainedAtStart ?? config.contained;
    if (!contained) return;
    if (serviceNames.length > 0) this.composeServiceNames.set(sessionId, [...serviceNames]);
    if (!sidecarImage) {
      throw new Error(
        "Compose egress containment is on but SESSION_EGRESS_SIDECAR_IMAGE is not set",
      );
    }
    const prior = this.composeEgressRuns.get(sessionId) ?? Promise.resolve();
    const run = (async () => {
      try { await prior; } catch { /* a failed predecessor must not poison the queue */ }
      await applyComposeServiceEgress({
        docker: this.docker,
        sessionId,
        sidecarImage,
        config: { ...config, contained },
        serviceNames,
        dnsEnabled: egressDnsEnabled(),
        proxyEnabled: egressProxyEnabled(),
        labels: this.baseLabels(),
        orchestratorHost: orchestratorCallbackHost(),
        refresh,
      });
    })();
    this.composeEgressRuns.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.composeEgressRuns.get(sessionId) === run) this.composeEgressRuns.delete(sessionId);
    }
  }

  get workerImageName(): string {
    return this.imageName;
  }

  get workspaceVolumeName(): string | undefined {
    return this.workspaceVolume;
  }

  /** Returns whether the agent was reloaded. Throws if any sidecar replacement fails. */
  async reloadEgress(sessionId: string): Promise<boolean> {
    if (!egressEnforceEnabled()) return false;
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    if (!sidecarImage) return false;
    const sc = this.containers.get(sessionId);
    const cfg = this.resolveEgressConfig?.(sessionId) ?? { contained: true, extraHosts: [] };
    if (!cfg.contained) return false;
    const reloadResolver = egressDnsEnabled();
    const reloadProxy = egressProxyEnabled();
    if (!reloadResolver && !reloadProxy) return false;
    const agentRunning = sc?.status === "running" && Boolean(sc.id);
    if (agentRunning && sc?.id) {
      await reloadEgressSidecars({
        docker: this.docker,
        agentContainerId: sc.id,
        sessionId,
        sidecarImage,
        opsSession: sc.opsSession ?? false,
        extraHosts: cfg.extraHosts,
        ...(cfg.base ? { base: cfg.base } : {}),
        ...(cfg.identityRules ? { identityRules: cfg.identityRules } : {}),
        baseLabels: this.baseLabels(),
        reloadResolver,
        reloadProxy,
      });
    }
    try {
      await this.containComposeServices(sessionId, this.composeServiceNames.get(sessionId) ?? [], true);
    } catch (error) {
      console.error(`[egress:${sessionId}] service allowlist refresh failed closed:`, error);
      throw error;
    }
    return agentRunning;
  }

  private baseLabels(): Record<string, string> {
    const labels: Record<string, string> = {
      [CONTAINER_LABEL_KEY]: CONTAINER_LABEL_VALUE,
    };
    if (this.stackName) {
      labels[CONTAINER_STACK_LABEL] = this.stackName;
    }
    return labels;
  }

  private labelFilters(): string[] {
    const filters = [`${CONTAINER_LABEL_KEY}=${CONTAINER_LABEL_VALUE}`];
    if (this.stackName) {
      filters.push(`${CONTAINER_STACK_LABEL}=${this.stackName}`);
    }
    return filters;
  }

  private lifecycleDeps(): LifecycleDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      destroyEpochs: this.destroyEpochs,
      networkName: this.networkName,
      workerPort: this.workerPort,
      skipHealthCheck: this.skipHealthCheck,
      workspaceVolume: this.workspaceVolume,
      credentialsVolume: this.credentialsVolume,
      imageName: this.imageName,
      defaultMemoryLimit: this.defaultMemoryLimit,
      defaultCpuQuota: this.defaultCpuQuota,
      defaultPidsLimit: this.defaultPidsLimit,
      stackName: this.stackName,
      dockerImageName: this.dockerImageName,
      dockerProxyHost: this.dockerProxyHost,
      dockerProxyPort: this.dockerProxyPort,
      egressEnforce: egressEnforceEnabled(),
      egressSidecarImage: process.env.SESSION_EGRESS_SIDECAR_IMAGE,
      egressDns: egressDnsEnabled(),
      egressProxy: egressProxyEnabled(),
      ...(this.resolveEgressConfig ? { resolveEgressConfig: this.resolveEgressConfig } : {}),
      reopenJoinedEgress: (sessionId: string) => this.reopenJoinedSessionEgress(sessionId),
      kernelRuntime: kernelRuntime(),
      seccompSecurityOpt: resolveSeccompSecurityOpt(),
      readonlyRootfs: readonlyRootfsEnabled(),
      stateDir: this.stateDir,
      emitter: this,
      baseLabels: () => this.baseLabels(),
    };
  }

  private discoveryDeps(): DiscoveryDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      networkName: this.networkName,
      workerPort: this.workerPort,
      labelFilters: () => this.labelFilters(),
    };
  }

  private healthDeps(): HealthDeps {
    return {
      docker: this.docker,
      containers: this.containers,
      standbySessionIds: this.standbySessionIds,
      emitter: this,
      labelFilters: () => this.labelFilters(),
      onLabelledContainerStarted: () => this.noteContainerTopologyChanged(),
    };
  }

  private overlayDeps(): OverlayProvisionerDeps {
    return {
      docker: this.docker,
      workspaceVolume: this.workspaceVolume,
      stateDir: this.stateDir,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async ensureNetwork(): Promise<void> {
    try {
      const network = this.docker.getNetwork(this.networkName);
      await network.inspect();
    } catch {
      await this.docker.createNetwork({
        Name: this.networkName,
        Driver: "bridge",
        Labels: this.baseLabels(),
      });
    }
  }

  getDockerClient(): Docker { return this.docker; }

  async connectToNetwork(sessionId: string, networkName: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id) throw new Error(`No container found for session ${sessionId}`);

    const network = this.docker.getNetwork(networkName);
    try {
      await network.connect({ Container: sc.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) throw err;
    }

    // Firewall rebuilds flush OUTPUT; retain attachments so their rules can be restored.
    (sc.joinedSessionNetworks ??= new Set()).add(networkName);

    await this.allowEgressToSessionNetwork(sc.id, sessionId, networkName);
  }

  async ensureConnectedToSessionNetwork(sessionId: string, networkName: string): Promise<boolean> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id) return false;

    let info: Docker.NetworkInspectInfo;
    try {
      info = await this.docker.getNetwork(networkName).inspect();
    } catch {
      return false;
    }

    const members = info.Containers ?? {};
    if (Object.prototype.hasOwnProperty.call(members, sc.id)) {
      return false;
    }

    console.warn(
      `[network:${sessionId}] agent container not attached to live network ${networkName} ` +
        "(likely a proxy/network recreate) — reconnecting",
    );
    try {
      await this.docker.getNetwork(networkName).disconnect({ Container: sc.id, Force: true });
    } catch {
      // No stale endpoint to clear.
    }
    try {
      await this.connectToNetwork(sessionId, networkName);
      return true;
    } catch (err) {
      console.warn(
        `[network:${sessionId}] reconnect to ${networkName} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  private async allowEgressToSessionNetwork(
    agentContainerId: string,
    sessionId: string,
    networkName: string,
  ): Promise<void> {
    const sc = this.containers.get(sessionId);
    const sidecarImage = process.env.SESSION_EGRESS_SIDECAR_IMAGE;
    if (!egressEnforceEnabled() || !sidecarImage) {
      return;
    }
    // Do not overwrite unknown boot policy with the current policy used as a fallback.
    const contained =
      sc?.egressContainedAtStart ?? this.resolveEgressConfig?.(sessionId)?.contained ?? true;
    if (!contained) {
      return;
    }
    if (sc?.egressContainedAtStart === undefined) {
      console.log(
        `[egress:${sessionId}] boot containment unknown (rediscovered container); derived contained=${contained} from resolved policy — re-opening preview egress`,
      );
    }
    // Install subnet rules after the firewall's OUTPUT flush.
    if (sc?.egressFirewallReady) {
      try {
        await sc.egressFirewallReady;
      } catch {
        /* install failed; the create() catch reaps the container */
      }
    }
    try {
      const info = await this.docker.getNetwork(networkName).inspect();
      const subnets = extractNetworkSubnets(info);
      if (subnets.length === 0) {
        console.warn(`[egress:${sessionId}] no IPAM subnet found for ${networkName}; preview may be unreachable from the agent browser`);
        return;
      }
      const allowed = await allowEgressToSubnets(this.docker, {
        agentContainerId,
        sidecarImage,
        subnets,
        labels: { ...this.baseLabels(), "shipit-parent-session": sessionId },
      });
      console.log(`[egress:${sessionId}] opened agent egress to session subnet(s) ${allowed.join(", ")} (${networkName})`);
    } catch (err) {
      console.warn(
        `[egress:${sessionId}] failed to open egress to ${networkName} (preview may be unreachable from the agent browser):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async reopenJoinedSessionEgress(sessionId: string): Promise<void> {
    const sc = this.containers.get(sessionId);
    if (!sc?.id || !sc.joinedSessionNetworks?.size) return;
    for (const networkName of sc.joinedSessionNetworks) {
      await this.allowEgressToSessionNetwork(sc.id, sessionId, networkName);
    }
  }

  // Agent addresses use the container map, not the child-origin index's topology brackets.
  async create(config: ContainerConfig, opts?: CreateContainerOpts): Promise<SessionContainer> {
    return createContainer(this.lifecycleDeps(), config, opts);
  }

  /** Capture before preflight awaits so intervening teardown cancels creation. */
  teardownEpoch(sessionId: string): number {
    return this.destroyEpochs.get(sessionId) ?? 0;
  }

  /** replacementFollows keeps viewers from discarding previews during a rebuild. */
  async destroy(sessionId: string, opts: { replacementFollows?: boolean } = {}): Promise<void> {
    this.lastCreateErrors.delete(sessionId);
    // Docker reuses subnets; remove ranges only when the session's networks are removed.
    this.sessionNetworkRanges.delete(sessionId);
    return destroyContainer(this.lifecycleDeps(), sessionId, opts);
  }

  async destroyAgentContainer(sessionId: string): Promise<void> {
    this.lastCreateErrors.delete(sessionId);
    return destroyContainer(this.lifecycleDeps(), sessionId, { preserveChildResources: true });
  }

  async reapOrphans(sessionId: string): Promise<void> {
    await cleanupSessionDockerResources(this.docker, sessionId);
  }

  async resolveWorkerImageId(): Promise<string | undefined> {
    if (this.workerImageId !== undefined) return this.workerImageId || undefined;
    // Empty strings cache misses, avoiding repeated Docker calls.
    this.workerImageId = await resolveWorkerImageIdFn(this.docker, this.imageName);
    return this.workerImageId || undefined;
  }

  async resolveWorkerBaseDigest(): Promise<string | undefined> {
    if (this.workerBaseDigest !== undefined) return this.workerBaseDigest || undefined;
    this.workerBaseDigest = await resolveWorkerBaseDigestFn(this.docker, this.imageName);
    return this.workerBaseDigest || undefined;
  }

  async resolveWorkerNodeVersion(): Promise<string | undefined> {
    if (this.workerNodeVersion !== undefined) return this.workerNodeVersion || undefined;
    this.workerNodeVersion = await resolveWorkerNodeVersionFn(this.docker, this.imageName);
    return this.workerNodeVersion || undefined;
  }

  get(sessionId: string): SessionContainer | undefined {
    return this.containers.get(sessionId);
  }

  getAll(): SessionContainer[] {
    return [...this.containers.values()];
  }

  get size(): number {
    return this.containers.size;
  }

  recordCreateError(sessionId: string, error: string): void {
    this.lastCreateErrors.set(sessionId, { error, at: Date.now() });
  }

  getLastCreateError(sessionId: string): { error: string; at: number } | undefined {
    return this.lastCreateErrors.get(sessionId);
  }

  clearCreateError(sessionId: string): void {
    this.lastCreateErrors.delete(sessionId);
  }

  setDockerProxy(host: string, port: number, dockerImageName?: string): void {
    this.dockerProxyHost = host;
    this.dockerProxyPort = port;
    if (dockerImageName) {
      this.dockerImageName = dockerImageName;
    }
  }

  getSessionByContainerIp(ip: string): SessionContainer | undefined {
    return getSessionByContainerIp(this.containers, ip);
  }

  async getSessionByAnyContainerIp(ip: string): Promise<{ sessionId: string } | undefined> {
    const agent = this.getSessionByContainerIp(ip);
    if (agent) return { sessionId: agent.sessionId };
    // Capture arrival before the loop starts its first snapshot.
    const arrivedAt = Date.now();
    this.ensureOriginIndexLoop();

    // A fresh miss is trustworthy only outside session subnets and topology changes.
    if (arrivedAt - this.containerOriginRefreshedAt <= ORIGIN_INDEX_FRESH_MS) {
      const known = this.containerOriginSessions.get(ip);
      if (known) return { sessionId: known };
      if (!this.isLikelySessionContainerIp(ip)) return undefined;
    }

    const joinedRefreshStartedAt = this.containerOriginRefresh
      ? this.containerOriginRefreshStartedAt
      : 0;
    const deadline = arrivedAt + ORIGIN_LOOKUP_DEADLINE_MS;
    let timedOut = !(await this.awaitOriginIndexRefresh(deadline));
    // Snapshot after arrival, including same-millisecond ties, to see the requesting container.
    if (!timedOut && joinedRefreshStartedAt > 0 && joinedRefreshStartedAt <= arrivedAt
      && Date.now() >= this.containerOriginRefreshBackoffUntil) {
      timedOut = !(await this.awaitOriginIndexRefresh(deadline));
    }
    const refreshed = this.containerOriginSessions.get(ip);
    if (refreshed) return { sessionId: refreshed };
    if (timedOut || this.containerOriginRefreshFailed) {
      // The API guard uses known session ranges when this lookup fails.
      void this.refreshSessionNetworkRanges();
      throw new Error("container-origin index is unavailable");
    }
    return undefined;
  }

  // The request deadline does not cancel the shared refresh.
  private async awaitOriginIndexRefresh(deadline: number): Promise<boolean> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const refreshed = async (): Promise<boolean> => {
      await this.refreshContainerOriginIndex();
      return true;
    };
    return Promise.race([
      refreshed(),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), remaining).unref(); }),
    ]);
  }

  private async refreshContainerOriginIndex(): Promise<void> {
    if (this._disposed) return;
    if (Date.now() < this.containerOriginRefreshBackoffUntil) return;
    if (!this.containerOriginRefresh) {
      this.containerOriginRefreshStartedAt = Date.now();
      const generation = this.containerTopologyGeneration;
      const bracketedAtStart = this.containerTopologyMutations > 0;
      this.containerOriginRefresh = (async () => {
        try {
          const entries = await Promise.race([
            this.docker.listContainers({
              filters: { label: ["shipit-parent-session"] },
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("container-origin lookup timed out")),
                ORIGIN_INDEX_TIMEOUT_MS).unref();
            }),
          ]);
          const next = new Map<string, string>();
          for (const entry of entries) {
            const sessionId = entry.Labels?.["shipit-parent-session"];
            if (!sessionId) continue;
            for (const network of Object.values(entry.NetworkSettings?.Networks ?? {})) {
              if (network.IPAddress) next.set(network.IPAddress, sessionId);
            }
          }
          this.containerOriginSessions = next;
          // Keep known addresses, but withhold cached absence if topology changed during the query.
          const authoritative = !bracketedAtStart
            && this.containerTopologyMutations === 0
            && this.containerTopologyGeneration === generation;
          this.containerOriginRefreshedAt = authoritative ? Date.now() : 0;
          this.containerOriginRefreshBackoffUntil = 0;
          this.containerOriginRefreshFailed = false;
        } catch (error) {
          console.warn("[container-guard] could not refresh container IP index:", error);
          this.containerOriginRefreshBackoffUntil = Date.now() + 5_000;
          this.containerOriginRefreshFailed = true;
        } finally {
          this.containerOriginRefresh = undefined;
        }
      })();
    }
    await this.containerOriginRefresh;
  }

  /** Call before Docker can start a child, and close in finally; its first packet can beat Docker's reply. */
  beginContainerTopologyChange(): () => void {
    this.containerTopologyMutations++;
    this.containerTopologyGeneration++;
    this.containerOriginRefreshedAt = 0;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.containerTopologyMutations--;
      this.noteContainerTopologyChanged();
    };
  }

  /** For changes learned after the fact; planned changes need beginContainerTopologyChange. */
  noteContainerTopologyChanged(): void {
    this.containerTopologyGeneration++;
    this.containerOriginRefreshedAt = 0;
    if (this._disposed) return;
    if (!this.containerOriginRefresh) void this.refreshContainerOriginIndex();
  }

  private ensureOriginIndexLoop(): void {
    this.originIndexLastUsedAt = Date.now();
    if (this.originIndexTimer || this._disposed) return;
    this.originIndexTimer = setInterval(() => {
      if (Date.now() - this.originIndexLastUsedAt > ORIGIN_INDEX_IDLE_STOP_MS) {
        this.stopOriginIndexLoop();
        return;
      }
      void this.refreshContainerOriginIndex();
      if (Date.now() - this.originRangeRefreshedAt >= SESSION_RANGE_REFRESH_MS) {
        this.originRangeRefreshedAt = Date.now();
        void this.refreshSessionNetworkRanges();
      }
    }, ORIGIN_INDEX_REFRESH_MS);
    this.originIndexTimer.unref();
    void this.refreshContainerOriginIndex();
    this.originRangeRefreshedAt = Date.now();
    void this.refreshSessionNetworkRanges();
  }

  private stopOriginIndexLoop(): void {
    if (!this.originIndexTimer) return;
    clearInterval(this.originIndexTimer);
    this.originIndexTimer = undefined;
  }

  private async refreshSessionNetworkRanges(): Promise<void> {
    if (Date.now() < this.sessionNetworkRangeRefreshBackoffUntil) return;
    this.sessionNetworkRangeRefresh ??= (async () => {
        try {
          await Promise.race([
            Promise.all([...this.containers.keys()].map(
              async (sessionId) => this.recordSessionNetworkRanges(sessionId),
            )),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("session-network range lookup timed out")),
                SESSION_RANGE_TIMEOUT_MS).unref();
            }),
          ]);
          this.sessionNetworkRangeRefreshBackoffUntil = Date.now() + 1_000;
        } catch (error) {
          console.warn("[container-guard] could not refresh session network ranges:", error);
          this.sessionNetworkRangeRefreshBackoffUntil = Date.now() + 5_000;
        } finally {
          this.sessionNetworkRangeRefresh = undefined;
        }
      })();
    await this.sessionNetworkRangeRefresh;
  }

  private async recordSessionNetworkRanges(sessionId: string): Promise<void> {
    // Docker methods can throw before returning promises, so allSettled still needs a catch.
    let ranges: { subnet: string; gateway?: string }[] = [];
    try {
      // Docker-access bridges use the short ID; Compose and egress networks use the full ID.
      const inspected = await Promise.allSettled([
        this.docker.getNetwork(`shipit-session-${sessionId}`).inspect(),
        this.docker.getNetwork(`shipit-egress-${sessionId}`).inspect(),
        this.docker.getNetwork(`shipit-session-${sessionId.slice(0, 12)}`).inspect(),
      ]);
      ranges = inspected.flatMap((result) => result.status === "fulfilled"
        ? (result.value.IPAM?.Config ?? [])
          .filter((entry): entry is { Subnet: string; Gateway?: string } => Boolean(entry.Subnet))
          .map((entry) => ({ subnet: entry.Subnet, ...(entry.Gateway ? { gateway: entry.Gateway } : {}) }))
        : []);
    } catch { /* containment later verifies the network and fails closed */ }
    // Preserve known ranges through Docker outages so the guard still rejects container origins.
    if (ranges.length > 0) this.sessionNetworkRanges.set(sessionId, ranges);
  }

  isLikelySessionContainerIp(ip: string): boolean {
    for (const ranges of this.sessionNetworkRanges.values()) {
      for (const range of ranges) {
        if (range.gateway === ip) continue;
        if (ipInSubnet(ip, range.subnet)) return true;
      }
    }
    return false;
  }

  async createStandby(config: ContainerConfig, opts?: CreateContainerOpts): Promise<SessionContainer> {
    const sc = await this.create({
      ...config,
      extraLabels: { ...config.extraLabels, [CONTAINER_STANDBY_LABEL]: "true" },
    }, opts);
    this.standbySessionIds.add(config.sessionId);
    return sc;
  }

  isStandby(sessionId: string): boolean {
    return this.standbySessionIds.has(sessionId);
  }

  claimStandby(sessionId: string): SessionContainer | undefined {
    if (!this.standbySessionIds.has(sessionId)) return undefined;
    this.standbySessionIds.delete(sessionId);
    return this.containers.get(sessionId);
  }

  get standbyCount(): number {
    return this.standbySessionIds.size;
  }

  async cleanupOrphans(activeSessionIds: Set<string>): Promise<number> {
    return cleanupOrphanContainers(this.discoveryDeps(), activeSessionIds);
  }

  // Claimed containers retain the immutable standby label; active IDs protect them.
  async reapStandbyContainers(activeSessionIds: Set<string>): Promise<number> {
    return reapStandbyContainers(this.discoveryDeps(), activeSessionIds);
  }

  async rediscover(
    activeSessionIds: Set<string>,
    sessionInfoResolver?: (sessionId: string) => {
      workspaceDir: string;
      dockerAccess: boolean;
      resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
    } | undefined,
  ): Promise<number> {
    return rediscoverContainers(this.discoveryDeps(), activeSessionIds, sessionInfoResolver);
  }

  async adoptRunningContainer(
    sessionId: string,
    sessionInfoResolver?: (sessionId: string) => {
      workspaceDir: string;
      dockerAccess: boolean;
      resourceLimits?: { memory: number; cpuQuota: number; pidsLimit: number };
    } | undefined,
  ): Promise<boolean> {
    return adoptRunningContainer(this.discoveryDeps(), sessionId, sessionInfoResolver);
  }

  /** Undefined means Docker could not answer, not that the container stopped. */
  async isTrackedContainerRunning(sessionId: string): Promise<boolean | undefined> {
    return isTrackedContainerRunning(this.discoveryDeps(), sessionId);
  }

  async markContainerGone(sessionId: string, expectedContainerId: string): Promise<boolean> {
    const sc = this.containers.get(sessionId);
    if (!sc) return false;
    // An awaited probe of the old container must not remove its replacement.
    if (sc.id !== expectedContainerId) {
      console.warn(
        `[container] markContainerGone(${sessionId}) ignored — tracked ${sc.id.slice(0, 12)} != probed ${expectedContainerId.slice(0, 12)} (container was replaced)`,
      );
      return false;
    }
    // Reap before forgetting the entry; later teardown cannot find these sidecars.
    await reapSessionEgressSidecars(this.docker, sessionId, sc.id);
    sc.status = "stopped";
    this.containers.delete(sessionId);
    this.standbySessionIds.delete(sessionId);
    return true;
  }

  async startHealthMonitor(): Promise<void> {
    return startHealthMonitor(this.healthDeps(), this.healthMonitorState);
  }

  stopHealthMonitor(): void {
    stopHealthMonitor(this.healthMonitorState);
  }

  buildConfig(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    pnpmStoreDir?: string;
    env?: Record<string, string>;
    memoryLimit?: number;
    cpuQuota?: number;
    pidsLimit?: number;
    dockerAccess?: boolean;
    opsSession?: boolean;
    hostMounts?: HostMount[];
    overlaySpecs?: DepDirOverlaySpec[];
  }): ContainerConfig {
    return buildContainerConfig({
      imageName: this.imageName,
      defaultMemoryLimit: this.defaultMemoryLimit,
      defaultCpuQuota: this.defaultCpuQuota,
      defaultPidsLimit: this.defaultPidsLimit,
    }, opts);
  }

  buildConfigForWorkspace(opts: {
    sessionId: string;
    sessionDir: string;
    workspaceDir: string;
    credentialsDir: string;
    depCacheDir?: string;
    pnpmStoreDir?: string;
    env?: Record<string, string>;
    opsSession?: boolean;
    dockerAccess?: boolean;
    overlaySpecs?: DepDirOverlaySpec[];
  }): ContainerConfig {
    const cfg = readAgentConfig(opts.workspaceDir);
    const limits = resolveAgentDockerLimits(opts.workspaceDir);
    return this.buildConfig({
      sessionId: opts.sessionId,
      sessionDir: opts.sessionDir,
      workspaceDir: opts.workspaceDir,
      credentialsDir: opts.credentialsDir,
      depCacheDir: opts.depCacheDir,
      pnpmStoreDir: opts.pnpmStoreDir,
      env: opts.env,
      memoryLimit: limits.memoryLimit,
      cpuQuota: limits.cpuQuota,
      pidsLimit: limits.pidsLimit,
      // Sandboxes use explicit capability grants because their workspace has no root config.
      dockerAccess: opts.dockerAccess ?? limits.dockerAccess,
      opsSession: opts.opsSession,
      hostMounts: opts.opsSession ? cfg.hostMounts : undefined,
      overlaySpecs: opts.overlaySpecs,
    });
  }

  async prepareOverlaySpecs(opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
    /** Compose external-volume references must already exist; creation paths omit this. */
    requireProvisioned?: boolean;
  }): Promise<DepDirOverlaySpec[]> {
    return prepareOverlaySpecsFn(this.overlayDeps(), opts);
  }

  async resolveSiblingOverlayDepDirs(opts: {
    sessionId: string;
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  }): Promise<{ depDir: string; volumeName: string }[]> {
    return resolveSiblingOverlayDepDirsFn(this.overlayDeps(), {
      ...opts,
      provisioned: this.provisionedOverlayDepDirs(opts.sessionId),
    });
  }

  preparePnpmStore(opts: {
    workspaceDir: string;
    session: Pick<SessionInfo, "remoteUrl" | "kind">;
  }): string | undefined {
    return preparePnpmStoreFn(this.overlayDeps(), opts);
  }

  // Leave containers alive for adoption after an orchestrator update.
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this.stopHealthMonitor();
    this.stopOriginIndexLoop();
    this.removeAllListeners();
  }
}
