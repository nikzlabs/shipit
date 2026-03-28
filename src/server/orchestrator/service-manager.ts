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

  private services = new Map<string, ManagedService>();
  private logProcesses = new Map<string, ChildProcess>();
  private _started = false;
  private readonly composeRunner: ComposeRunner;
  private readonly composeQuery: ComposeQuery;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ServiceManagerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeConfig = opts.composeConfig;
    this.composeRunner = opts.composeRunner ?? defaultComposeRunner;
    this.composeQuery = opts.composeQuery ?? defaultComposeQuery;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
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

  /**
   * Initialize the compose stack:
   * 1. Parse and validate the compose file
   * 2. Generate the override file
   * 3. Start auto services via `docker compose up -d`
   */
  async start(): Promise<void> {
    const composePath = path.join(this.workspaceDir, this.composeConfig.file);

    // Parse and validate
    const parsedServices = parseComposeFile(composePath, {
      dockerSocket: this.composeConfig.dockerSocket,
    });

    // Build service map
    for (const svc of parsedServices) {
      const preview = svc.shipitPreview ?? (svc.ports?.length ? "auto" : "manual");
      const port = svc.ports?.[0] ? extractHostPort(svc.ports[0]) : undefined;
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
    };
    const overrideContent = generateComposeOverride(parsedServices, overrideOpts);
    writeComposeOverride(this.workspaceDir, overrideContent);

    // Start auto services
    const autoServices = [...this.services.values()].filter(s => s.preview === "auto");
    for (const svc of autoServices) {
      this.updateServiceStatus(svc.name, "starting");
    }

    try {
      await this.composeUp();
      this._started = true;

      // Poll actual container state instead of assuming "running"
      await this.pollStatus();

      // Start log streaming for all services
      for (const svc of this.services.values()) {
        this.streamLogs(svc.name);
      }

      // Begin periodic status polling to detect crashes
      this.startPolling();

      this.emit("stack_ready");
    } catch (err) {
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

    const args = this.composeArgs([], "logs", "-f", "--no-log-prefix", name);
    const proc = spawn("docker", args, {
      cwd: this.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleData = (chunk: Buffer) => {
      this.emit("service_log", name, chunk.toString());
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
    // Re-start with the same config — start() handles parsing, override, and up
    this.services.clear();
    this._started = false;
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
    const args = this.composeArgs([], "ps", "--format", "json", "-a");
    let stdout: string;
    try {
      stdout = await this.composeQuery(args, this.workspaceDir);
    } catch {
      return; // Poll failure is non-fatal
    }

    // docker compose ps --format json outputs one JSON object per line
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { Service?: string; State?: string; ExitCode?: number };
      try {
        entry = JSON.parse(trimmed) as typeof entry;
      } catch {
        continue;
      }
      const svc = entry.Service ? this.services.get(entry.Service) : undefined;
      if (!svc) continue;

      const prev = svc.status;
      const state = entry.State ?? "";
      if (state === "running") {
        if (prev !== "running") this.updateServiceStatus(svc.name, "running");
      } else if (state === "exited" || state === "dead") {
        const code = entry.ExitCode ?? 1;
        if (code === 0) {
          if (prev !== "stopped") this.updateServiceStatus(svc.name, "stopped");
        } else {
          this.updateServiceStatus(svc.name, "error", `Exited with code ${code}`);
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(svc.name, "starting");
      }
    }
  }

  /** Start periodic status polling. */
  private startPolling(): void {
    this.stopPolling();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollStatus().catch(() => { /* non-fatal */ });
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
    this.emit("service_status", { ...svc });
  }

  /** Build common compose CLI args with the user file and override. */
  private composeArgs(profiles: string[], ...extra: string[]): string[] {
    return [
      "compose",
      "-f", this.composeConfig.file,
      "-f", ".shipit/compose.override.yml",
      "-p", `shipit-${this.sessionId}`,
      ...profiles.flatMap(p => ["--profile", p]),
      ...extra,
    ];
  }

  /** Run `docker compose up -d` for auto services. */
  private composeUp(): Promise<void> {
    return this.runCompose([], "up", "-d", "--remove-orphans");
  }

  /** Run `docker compose up -d` with the shipit-manual profile for a specific service. */
  private composeUpService(name: string): Promise<void> {
    return this.runCompose(["shipit-manual"], "up", "-d", name);
  }

  /** Run `docker compose stop <service>`. */
  private composeStop(name: string): Promise<void> {
    return this.runCompose([], "stop", name);
  }

  /** Run `docker compose down --remove-orphans`. */
  private composeDown(): Promise<void> {
    return this.runCompose([], "down", "--remove-orphans");
  }

  /** Run a docker compose command and resolve/reject based on exit code. */
  private runCompose(profiles: string[], ...subArgs: string[]): Promise<void> {
    const args = this.composeArgs(profiles, ...subArgs);
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
        reject(new Error(`docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
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
 * Supports common Docker Compose forms:
 * - "5173" → 5173
 * - "5173:5173" → 5173
 * - "8080:80" → 8080
 * - "5173:5173/tcp" → 5173
 * - "127.0.0.1:5173:5173" → 5173
 */
function extractHostPort(portMapping: string): number | undefined {
  if (!portMapping) return undefined;

  // Strip optional protocol suffix ("/tcp", "/udp")
  const withoutProtocol = portMapping.split("/")[0].trim();
  if (!withoutProtocol) return undefined;

  const parts = withoutProtocol.split(":");
  let portStr: string | undefined;

  switch (parts.length) {
    case 1:
      // "HOST_PORT"
      portStr = parts[0];
      break;
    case 2:
      // "HOST_PORT:CONTAINER_PORT"
      portStr = parts[0];
      break;
    case 3:
      // "HOST_IP:HOST_PORT:CONTAINER_PORT"
      portStr = parts[1];
      break;
    default:
      return undefined;
  }

  const port = parseInt(portStr, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}
