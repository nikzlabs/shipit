/**
 * ServiceManager — manages Docker Compose service lifecycle for a session.
 *
 * Replaces the services container (Fastify session worker for preview) with
 * direct `docker compose` CLI invocations from the orchestrator. Each session
 * gets its own compose stack with an override file for ShipIt integration.
 *
 * Responsibilities:
 * - Start/stop compose stack
 * - Start/stop individual services
 * - Service status polling
 * - Log streaming via `docker compose logs -f`
 * - Config change detection and stack reconciliation
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ComposeConfig } from "../shared/shipit-config.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import {
  parseComposeFile,
  generateComposeOverride,
  writeComposeOverride,
  type ComposeOverrideOptions,
} from "./compose-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = "stopped" | "starting" | "running" | "error";

export interface ManagedService {
  name: string;
  port?: number;
  preview: "auto" | "manual";
  status: ServiceStatus;
  error?: string;
  /** Container IP on the session network (populated by status polling). */
  containerIp?: string;
}

/** Runs a docker compose command. Resolves on exit 0, rejects otherwise. */
export type ComposeRunner = (args: string[], cwd: string) => Promise<void>;

/** Runs a docker compose command and returns stdout. */
export type ComposeQuery = (args: string[], cwd: string) => Promise<string>;

export interface ServiceManagerOptions {
  /** Session ID. */
  sessionId: string;
  /** Absolute path to the workspace directory. */
  workspaceDir: string;
  /** Compose config from shipit.yaml. */
  composeConfig: ComposeConfig;
  /** Optional override for running compose commands (useful for testing). */
  composeRunner?: ComposeRunner;
  /** Optional override for querying compose commands (useful for testing). */
  composeQuery?: ComposeQuery;
  /** Status poll interval in ms. 0 disables polling. Default: 5000. */
  pollIntervalMs?: number;
  /** Docker named volume holding the workspace (for compose volume rewriting). */
  workspaceVolume?: string;
  /** Subpath within the workspace volume for this session. */
  workspaceSubpath?: string;
  /** Docker stack name (e.g. "shipit-dev") — propagated to compose labels for cleanup filtering. */
  stackName?: string;
  /** Called during start() to join the agent container to the compose network. */
  networkJoinFn?: (networkName: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ServiceManagerEvents {
  service_status: (service: ManagedService) => void;
  service_log: (serviceName: string, text: string) => void;
  stack_ready: () => void;
  stack_error: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// ServiceManager
// ---------------------------------------------------------------------------

export class ServiceManager extends EventEmitter {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private readonly composeConfig: ComposeConfig;

  private static readonly MAX_LOG_BUFFER = 80_000;

  private services = new Map<string, ManagedService>();
  private logProcesses = new Map<string, ChildProcess>();
  private logBuffers = new Map<string, string>();
  private _started = false;
  private readonly composeRunner: ComposeRunner;
  private readonly composeQuery: ComposeQuery;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly workspaceVolume?: string;
  private readonly workspaceSubpath?: string;
  private readonly stackName?: string;
  private readonly networkJoinFn?: (networkName: string) => Promise<void>;
  private _startupComplete = false;
  /** Error message if the compose stack failed to start. */
  startError: string | null = null;

  constructor(opts: ServiceManagerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeConfig = opts.composeConfig;
    this.composeRunner = opts.composeRunner ?? defaultComposeRunner;
    this.composeQuery = opts.composeQuery ?? defaultComposeQuery;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.workspaceVolume = opts.workspaceVolume;
    this.workspaceSubpath = opts.workspaceSubpath;
    this.stackName = opts.stackName;
    this.networkJoinFn = opts.networkJoinFn;
  }

  /** Whether the compose stack has been started. */
  get started(): boolean {
    return this._started;
  }

  /** Get all managed services. */
  getServices(): ManagedService[] {
    return [...this.services.values()];
  }

  /** Get a specific service by name. */
  getService(name: string): ManagedService | undefined {
    return this.services.get(name);
  }

  /** Find the container IP for a service listening on the given port. */
  getContainerIpForPort(port: number): string | undefined {
    for (const svc of this.services.values()) {
      if (svc.port === port && svc.containerIp) return svc.containerIp;
    }
    return undefined;
  }

  /** Get the buffered log output for a service. */
  getLogBuffer(name: string): string {
    return this.logBuffers.get(name) ?? "";
  }

  /**
   * Initialize the compose stack:
   * 1. Parse and validate the compose file
   * 2. Generate the override file
   * 3. Start auto services via `docker compose up -d`
   */
  async start(): Promise<void> {
    // Kill any stale compose containers left over from a previous orchestrator
    // run (e.g. ShipIt restart). Uses label filter — no compose files needed.
    try {
      await this.killStaleContainers();
    } catch {
      // Best-effort cleanup
    }

    const composePath = path.join(this.workspaceDir, this.composeConfig.file);

    // Parse and validate
    const parsedServices = parseComposeFile(composePath, {
      dockerSocket: this.composeConfig.dockerSocket,
    });

    // Build service map
    for (const svc of parsedServices) {
      const preview = svc.shipitPreview ?? (svc.ports?.length ? "auto" : "manual");
      const port = svc.ports?.[0] ? extractContainerPort(svc.ports[0]) : undefined;
      this.services.set(svc.name, {
        name: svc.name,
        port,
        preview,
        status: "stopped",
      });
    }

    // Generate override
    const overrideOpts: ComposeOverrideOptions = {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      stackName: this.stackName,
    };
    const overrideContent = generateComposeOverride(parsedServices, overrideOpts);
    writeComposeOverride(this.workspaceDir, overrideContent);

    // Mark auto services as starting (silently — _startupComplete is false)
    const autoServices = [...this.services.values()].filter(s => s.preview === "auto");
    for (const svc of autoServices) {
      this.updateServiceStatus(svc.name, "starting");
    }

    try {
      // 1. Start auto services (named explicitly so manual services aren't
      //    started but remain part of the project for dependency resolution)
      const autoNames = autoServices.map(s => s.name);
      await this.composeUp(autoNames);
      this._started = true;

      // 2. Join agent container to compose network (before IP resolution)
      if (this.networkJoinFn) {
        const networkName = `shipit-session-${this.sessionId}`;
        try {
          await this.networkJoinFn(networkName);
        } catch {
          // Non-fatal — agent may not reach services by DNS but proxy still works
        }
      }

      // 3. Resolve container IPs and actual statuses
      await this.pollStatus();

      // 4. Startup complete — flush all service statuses to listeners at once
      this._startupComplete = true;
      for (const svc of this.services.values()) {
        this.emit("service_status", { ...svc });
      }

      // 5. Start log streaming (--tail 1000 replays recent history + follows)
      for (const svc of this.services.values()) {
        this.streamLogs(svc.name);
      }

      // 6. Begin periodic polling to detect crashes
      this.startPolling();

      this.emit("stack_ready");
    } catch (err) {
      this._startupComplete = true;
      for (const svc of autoServices) {
        this.updateServiceStatus(svc.name, "error", (err as Error).message);
      }
      this.emit("stack_error", err);
      throw err;
    }
  }

  /**
   * Start a specific manual service.
   */
  async startService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);

    this.updateServiceStatus(name, "starting");
    try {
      await this.composeUpService(name);
      await this.pollStatus();
      this.streamLogs(name);
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
  }

  /**
   * Restart a specific service (stop then start).
   */
  async restartService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);

    this.updateServiceStatus(name, "starting");
    try {
      await this.composeStop(name);
      await this.composeUpService(name);
      await this.pollStatus();
      // Restart log streaming to pick up new container output
      this.streamLogs(name);
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
  }

  /**
   * Stop a specific service.
   */
  async stopService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);

    try {
      await this.composeStop(name);
      this.updateServiceStatus(name, "stopped");
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
  }

  /**
   * Stream logs for a service. Returns a cleanup function.
   */
  streamLogs(name: string): () => void {
    const existing = this.logProcesses.get(name);
    if (existing) {
      existing.kill();
      this.logProcesses.delete(name);
    }

    // Clear buffer before (re)starting — --tail 1000 replays history into it
    this.logBuffers.delete(name);

    const args = this.composeArgs("logs", "-f", "--tail", "1000", "--no-log-prefix", name);
    const proc = spawn("docker", args, {
      cwd: this.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleData = (chunk: Buffer) => {
      const text = chunk.toString();

      // Append to per-service ring buffer
      let buf = (this.logBuffers.get(name) ?? "") + text;
      if (buf.length > ServiceManager.MAX_LOG_BUFFER) {
        buf = truncateTerminalBuffer(buf, ServiceManager.MAX_LOG_BUFFER);
      }
      this.logBuffers.set(name, buf);

      this.emit("service_log", name, text);
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    this.logProcesses.set(name, proc);

    return () => {
      proc.kill();
      this.logProcesses.delete(name);
    };
  }

  /**
   * Reconcile the compose stack after a config change.
   * Re-parses the compose file, regenerates the override, and runs `up -d`.
   */
  async reconcile(): Promise<void> {
    // Kill orphaned log processes before clearing state — if a service was
    // renamed or removed, start() won't find its old process to clean up.
    for (const [, proc] of this.logProcesses) proc.kill();
    this.logProcesses.clear();
    this.stopPolling();

    this.services.clear();
    this.logBuffers.clear();
    this._started = false;
    this._startupComplete = false;
    this.startError = null;
    await this.start();
  }

  /**
   * Tear down the entire compose stack.
   */
  async stop(): Promise<void> {
    this.stopPolling();

    // Kill all log streaming processes
    for (const [name, proc] of this.logProcesses) {
      proc.kill();
      this.logProcesses.delete(name);
    }

    try {
      await this.composeDown();
    } catch {
      // Best-effort cleanup
    }

    for (const [name] of this.services) {
      this.updateServiceStatus(name, "stopped");
    }
    this.logBuffers.clear();
    this._started = false;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Query `docker compose ps --format json` and update service statuses
   * based on actual container state.
   */
  private async pollStatus(): Promise<void> {
    const args = this.composeArgs("ps", "--format", "json", "-a");
    let stdout: string;
    try {
      stdout = await this.composeQuery(args, this.workspaceDir);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] pollStatus failed:`, (err as Error).message);
      return;
    }

    // Parse container info and collect names for IP resolution
    const containerNames = new Map<string, string>();
    const statusUpdates: { name: string; state: string; exitCode: number }[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { Service?: string; ID?: string; Name?: string; State?: string; ExitCode?: number };
      try {
        entry = JSON.parse(trimmed) as typeof entry;
      } catch {
        continue;
      }
      const svc = entry.Service ? this.services.get(entry.Service) : undefined;
      if (!svc) continue;

      // Use container ID for inspect (more reliable than name)
      const containerRef = entry.ID ?? entry.Name;
      if (containerRef) containerNames.set(containerRef, svc.name);
      statusUpdates.push({
        name: svc.name,
        state: entry.State ?? "",
        exitCode: entry.ExitCode ?? 1,
      });
    }

    // Resolve container IPs *before* emitting status events so the preview
    // proxy can route requests as soon as the client learns a service is running.
    if (containerNames.size > 0) {
      await this.resolveContainerIps(containerNames);
    }

    // Now emit status updates
    for (const { name, state, exitCode } of statusUpdates) {
      const svc = this.services.get(name);
      if (!svc) continue;
      const prev = svc.status;
      if (state === "running") {
        if (prev !== "running") this.updateServiceStatus(name, "running");
      } else if (state === "exited" || state === "dead") {
        if (exitCode === 0) {
          if (prev !== "stopped") this.updateServiceStatus(name, "stopped");
        } else {
          this.updateServiceStatus(name, "error", `Exited with code ${exitCode}`);
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(name, "starting");
      }
    }
  }

  /**
   * Resolve container IPs via `docker inspect` on each container.
   * Prefers the session network IP, falls back to any available IP.
   */
  private async resolveContainerIps(
    containerNames: Map<string, string>,
  ): Promise<void> {
    const networkName = `shipit-session-${this.sessionId}`;

    for (const [containerName, serviceName] of containerNames) {
      try {
        const stdout = await this.composeQuery(
          ["inspect", containerName],
          this.workspaceDir,
        );
        const parsed = JSON.parse(stdout) as { NetworkSettings?: { IPAddress?: string; Networks?: Record<string, { IPAddress?: string }> } }[];
        const netSettings = parsed[0]?.NetworkSettings;
        let nets = netSettings?.Networks;

        // Docker Compose v5 on some platforms (e.g. WSL2) sets NetworkMode
        // to the custom network but doesn't actually attach the container.
        // Fix: explicitly connect the container if it has no networks.
        if (!nets || Object.keys(nets).length === 0) {
          try {
            await this.composeQuery(
              ["network", "connect", networkName, containerName],
              this.workspaceDir,
            );
            // Re-inspect to get the IP
            const stdout2 = await this.composeQuery(["inspect", containerName], this.workspaceDir);
            const parsed2 = JSON.parse(stdout2) as typeof parsed;
            nets = parsed2[0]?.NetworkSettings?.Networks;
          } catch {
            // Non-fatal
          }
        }

        if (!nets) continue;

        // Prefer the session network, fall back to any network with an IP
        let ip = nets[networkName]?.IPAddress;
        if (!ip) {
          for (const net of Object.values(nets)) {
            if (net.IPAddress) { ip = net.IPAddress; break; }
          }
        }
        if (ip) {
          const svc = this.services.get(serviceName);
          if (svc) svc.containerIp = ip;
        }
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] docker inspect ${containerName} failed:`, (err as Error).message);
      }
    }
  }

  /** Start periodic status polling. */
  private startPolling(): void {
    this.stopPolling();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollStatus().catch((err: unknown) => {
        console.warn(`[compose:${this.sessionId}] periodic poll error:`, (err as Error).message);
      });
    }, this.pollIntervalMs);
  }

  /** Stop periodic status polling. */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private updateServiceStatus(name: string, status: ServiceStatus, error?: string): void {
    const svc = this.services.get(name);
    if (!svc) return;
    svc.status = status;
    svc.error = error;
    // During initial startup, updates are batched — events are flushed
    // once the full sequence (compose up → network join → IP resolution) completes.
    if (this._startupComplete) {
      this.emit("service_status", { ...svc });
    }
  }

  /** Build common compose CLI args with the user file and override. */
  private composeArgs(...extra: string[]): string[] {
    return [
      "compose",
      "-f", this.composeConfig.file,
      "-f", ".shipit/compose.override.yml",
      "-p", `shipit-${this.sessionId.slice(0, 12)}`,
      ...extra,
    ];
  }

  /** Run `docker compose up -d`, optionally for specific services only. */
  private composeUp(serviceNames?: string[]): Promise<void> {
    return this.runCompose("up", "-d", "--remove-orphans", ...(serviceNames ?? []));
  }

  /** Run `docker compose up -d` for a specific manual service. */
  private composeUpService(name: string): Promise<void> {
    return this.runCompose("up", "-d", name);
  }

  /** Run `docker compose stop <service>`. */
  private composeStop(name: string): Promise<void> {
    return this.runCompose("stop", name);
  }

  /** Run `docker compose down --remove-orphans`. */
  private composeDown(): Promise<void> {
    return this.runCompose("down", "--remove-orphans");
  }

  /**
   * Kill and remove any containers from a previous compose stack for this
   * session. Uses the `shipit-parent-session` label so no compose files needed.
   */
  private async killStaleContainers(): Promise<void> {
    const stdout = await this.composeQuery(
      ["ps", "-aq", "--filter", `label=shipit-parent-session=${this.sessionId}`],
      this.workspaceDir,
    );
    const ids = stdout.split("\n").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    console.log(`[compose:${this.sessionId}] Removing ${ids.length} stale container(s)`);
    await this.composeQuery(["rm", "-f", ...ids], this.workspaceDir);
    // Also remove the old network if it exists
    try {
      await this.composeQuery(
        ["network", "rm", `shipit-session-${this.sessionId}`],
        this.workspaceDir,
      );
    } catch {
      // Network may not exist or may be in use — that's fine
    }
  }

  /** Run a docker compose command and resolve/reject based on exit code. */
  private runCompose(...subArgs: string[]): Promise<void> {
    const args = this.composeArgs(...subArgs);
    return this.composeRunner(args, this.workspaceDir);
  }
}

// ---------------------------------------------------------------------------
// Default compose runner
// ---------------------------------------------------------------------------

function defaultComposeRunner(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

function defaultComposeQuery(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the host port from a port mapping string.
 * Extracts the container (target) port — the port the service actually listens
 * on inside the container. The preview proxy routes to this port directly on
 * the session network (host port bindings are stripped by the override).
 *
 * Supports common Docker Compose forms:
 * - "5173" → 5173
 * - "5173:5173" → 5173
 * - "8080:80" → 80
 * - "5173:5173/tcp" → 5173
 * - "127.0.0.1:8080:80" → 80
 */
function extractContainerPort(portMapping: string): number | undefined {
  if (!portMapping) return undefined;

  // Strip optional protocol suffix ("/tcp", "/udp")
  const withoutProtocol = portMapping.split("/")[0].trim();
  if (!withoutProtocol) return undefined;

  const parts = withoutProtocol.split(":");
  // Container port is always the last segment
  const portStr = parts[parts.length - 1];

  const port = parseInt(portStr, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}
