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
  parseUserNamedVolumes,
  generateComposeOverride,
  writeComposeOverride,
  type ComposeOverrideOptions,
  type ComposeService,
} from "./compose-generator.js";
import fs from "node:fs";
import {
  resolveSecrets,
  writePerServiceEnvFiles,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
  type DeclaredSecret,
} from "./secret-resolver.js";
import type { PlatformCredentialProvider } from "./platform-credentials.js";

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
  /**
   * Loads user-saved secrets for the session's repo (from SecretStore).
   *
   * Called once before each compose start/reconcile so secret values reach
   * compose services via per-service env files (`.shipit/.env.<service>`).
   * Returning an empty object is fine — services with declared
   * `x-shipit-secrets` whose values aren't configured simply get an empty env
   * file (Phase 2 surfaces this as a missing-secrets warning).
   */
  secretsLoader?: () => Promise<Record<string, string>>;
  /**
   * Resolves `source: platform:*` entries against orchestrator-level
   * credentials (Claude OAuth, GitHub token). When omitted, those entries
   * fall through to the user-secrets lookup like any other declaration —
   * which usually means "missing".
   */
  platformCredentials?: PlatformCredentialProvider;
  /**
   * Phase 1 follow-up — Docker-secrets isolation. When configured, secret
   * values are written to per-secret files outside the workspace volume and
   * referenced from the compose override via `secrets: { file: ... }` instead
   * of `env_file:`. The agent container can no longer read service secrets
   * from the workspace.
   *
   * Required pieces:
   *   - `internalDir`: orchestrator's view of the per-session secrets root.
   *     Files are written here.
   *   - `hostDir`: optional override of the path used in compose `file:`
   *     references. Required when the orchestrator runs in a container
   *     (the Docker daemon reads paths from the host's filesystem). Omit
   *     for orchestrator-on-host setups.
   *   - `entrypointSourcePath`: orchestrator path to the
   *     `secrets-entrypoint.sh` baked into the image. Copied into
   *     `.shipit/secrets-entrypoint.sh` at compose-start so service
   *     containers can mount it.
   *
   * When omitted, the manager falls back to the env-file mode (Phase 1
   * baseline).
   */
  dockerSecretsConfig?: {
    internalDir: string;
    hostDir?: string;
    entrypointSourcePath: string;
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface SecretsStatusSnapshot {
  /** All declared secrets across all services, de-duplicated by name. */
  declared: DeclaredSecret[];
  /** Service-name → list of declared secrets that have no value (required + optional). */
  missingByService: Record<string, string[]>;
  /** Names of required secrets that have no value, de-duplicated. */
  missingRequired: string[];
  /**
   * Names of secrets marked `agent: true` that have a resolved value.
   * Used by the runner to push them into the agent container's process.env.
   * Values themselves are exposed via {@link agentValues} on the snapshot
   * the runner consumes — kept off this public type to avoid leaking
   * secret values into telemetry / logs.
   */
  agentNames: string[];
}

/**
 * Internal snapshot variant carried over the EventEmitter — same as
 * {@link SecretsStatusSnapshot} plus the resolved `agent: true` values that
 * subscribers (the runner) need to push into the agent container.
 *
 * Kept as a separate type so the public-facing snapshot doesn't include
 * raw secret values.
 */
export interface SecretsStatusInternalSnapshot extends SecretsStatusSnapshot {
  /** Resolved key-value pairs for `agent: true` entries. */
  agentValues: Record<string, string>;
}

export interface ServiceManagerEvents {
  service_status: (service: ManagedService) => void;
  service_log: (serviceName: string, text: string) => void;
  stack_ready: () => void;
  stack_error: (error: Error) => void;
  /**
   * Emitted after each `syncSecrets()` pass (compose start, reconcile,
   * `refreshSecrets()`). Carries the full declared/missing/required snapshot
   * + the resolved `agent: true` values so the runner can push them into
   * the agent container without a follow-up call.
   */
  secrets_status: (snapshot: SecretsStatusInternalSnapshot) => void;
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
  private secretsLoader?: () => Promise<Record<string, string>>;
  private platformCredentials?: PlatformCredentialProvider;
  private dockerSecretsConfig?: {
    internalDir: string;
    hostDir?: string;
    entrypointSourcePath: string;
  };
  /**
   * Per-secret file references for the most recent compose override. Built
   * inside `syncSecrets()` and consumed by `generateComposeOverride()`.
   * Only set when Docker-secrets mode is active.
   */
  private dockerSecretsBuild?: {
    secretNames: string[];
    perService: Record<string, string[]>;
    filePathFor: (name: string) => string;
    entrypointWorkspacePath: string;
  };
  /** Names of secrets declared in `x-shipit-secrets` across all services. */
  private declaredSecretNames: string[] = [];
  /** Service-name → list of declared secrets that have no user-saved value. */
  private missingSecretsByService: Record<string, string[]> = {};
  /** Latest secrets snapshot emitted via `secrets_status`. */
  private secretsSnapshot: SecretsStatusInternalSnapshot = {
    declared: [],
    missingByService: {},
    missingRequired: [],
    agentNames: [],
    agentValues: {},
  };
  private _startupComplete = false;
  /** Error message if the compose stack failed to start. */
  startError: string | null = null;
  /**
   * Set to `true` once `stop()` has been called. Guards retry callbacks so
   * they don't fire after the manager has been torn down. Reset to `false`
   * at the top of `start()` (which is also the path `reconcile()` takes).
   */
  private _disposed = false;

  // --- Install-running retry gate ---
  /**
   * While `true`, services that exit non-zero are restarted with backoff
   * instead of being marked `error`. Set by the orchestrator around the
   * `agent.install` window so a dev server that loses a race with install
   * (deps still extracting) recovers automatically rather than latching to
   * `error`. See `setInstallRunning`.
   */
  private _installRunning = false;
  /** Per-service backoff timer for retry-while-installing. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-service retry attempt counter (drives exponential backoff). */
  private retryAttempts = new Map<string, number>();
  /** Backoff schedule: 1s, 2s, 4s, 8s, capped at 10s. */
  private static readonly RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];

  // --- OOM auto-retry ---
  /**
   * Per-service OOM attempt counter — separate from `retryAttempts` (which
   * tracks install-window retries). Counts consecutive OOM-killed exits
   * (code 137) for a `preview: auto` service. Reset when:
   *   - The service runs for `OOM_STABLE_RESET_MS` without OOMing again
   *     (the typical "one-off pressure spike" case).
   *   - The service is explicitly stopped or restarted by the user.
   *   - The manager is reconciled / disposed.
   * NOT reset on every momentary `running` poll — a service that flaps in
   * and out of `running` while OOMing every few seconds must NOT loop
   * forever; the cap forces the user to intervene after MAX retries.
   */
  private oomRetryAttempts = new Map<string, number>();
  /**
   * Per-service stable-uptime timers. When a service comes up `running`
   * after at least one OOM-retry, we arm a timer to clear the OOM counter
   * if it stays running long enough. The timer is cancelled if the
   * service leaves `running` before it fires.
   */
  private oomStableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Hard cap on consecutive OOM-retries before we latch to `error`. After
   * this many retries in a row (without `OOM_STABLE_RESET_MS` of stable
   * uptime between them) the service is left in `error` so the user can
   * investigate — repeatedly restarting a service that keeps OOMing just
   * burns CPU and masks the real problem (memory cap too low, runaway
   * process, host pressure).
   */
  private static readonly MAX_OOM_AUTO_RETRIES = 3;
  /**
   * How long a service must run continuously before its OOM counter is
   * cleared. A short flap (run for 2s, OOM, run for 2s, OOM…) shouldn't
   * reset the counter; a service that comes up properly and runs for
   * a full minute should.
   */
  private static readonly OOM_STABLE_RESET_MS = 60_000;

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
    this.secretsLoader = opts.secretsLoader;
    this.platformCredentials = opts.platformCredentials;
    this.dockerSecretsConfig = opts.dockerSecretsConfig;
  }

  /**
   * Update or replace the secrets loader. Called when the session's remoteUrl
   * changes (e.g. after warm-session graduation) so subsequent reconciles read
   * the right slice of SecretStore.
   */
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this.secretsLoader = loader;
  }

  /**
   * Toggle the install-in-progress gate.
   *
   * While `true`, services that exit non-zero are restarted with exponential
   * backoff instead of being marked `error`. This handles the cold-start case
   * where the agent is running `npm install` (or similar) into a bind-mounted
   * `node_modules` while a compose service tries to use it — the service may
   * fail until install completes, and we want it to recover automatically.
   *
   * When toggled from `true` → `false` we make one explicit pass over every
   * service currently in `error` or pending-retry state and restart it, so a
   * service that gave up just before install finished gets one more chance.
   */
  setInstallRunning(running: boolean): void {
    if (this._installRunning === running) return;
    const wasRunning = this._installRunning;
    this._installRunning = running;
    if (wasRunning && !running) {
      this.flushPostInstallRetries();
    }
  }

  /** Whether the install-running gate is currently active. */
  get installRunning(): boolean {
    return this._installRunning;
  }

  /** Names of secrets declared in `x-shipit-secrets` across all services. */
  getDeclaredSecretNames(): string[] {
    return [...this.declaredSecretNames];
  }

  /** Missing secrets (required + optional) by service. */
  getMissingSecretsByService(): Record<string, string[]> {
    return { ...this.missingSecretsByService };
  }

  /**
   * Latest secrets snapshot — declared requirements + per-service missing +
   * de-duplicated required-and-missing names + resolved agent values.
   * Returned as a defensive copy so callers can't mutate manager state.
   */
  getSecretsSnapshot(): SecretsStatusInternalSnapshot {
    return {
      declared: this.secretsSnapshot.declared.map((d) => ({ ...d, services: [...d.services] })),
      missingByService: Object.fromEntries(
        Object.entries(this.secretsSnapshot.missingByService).map(([k, v]) => [k, [...v]]),
      ),
      missingRequired: [...this.secretsSnapshot.missingRequired],
      agentNames: [...this.secretsSnapshot.agentNames],
      agentValues: { ...this.secretsSnapshot.agentValues },
    };
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
    this._disposed = false;
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

    // Resolve secrets BEFORE generating the override — the override references
    // per-service env files via `env_file:` and compose detects the file at
    // `up` time. We always sync the env files (even when no secrets are
    // declared) so stale files from a previous compose definition are cleared.
    await this.syncSecrets(parsedServices);

    // Generate override
    const userNamedVolumes = parseUserNamedVolumes(composePath);
    const overrideOpts: ComposeOverrideOptions = {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      stackName: this.stackName,
      userNamedVolumes,
      ...(this.dockerSecretsBuild ? { dockerSecrets: this.dockerSecretsBuild } : {}),
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
      //    started but remain part of the project for dependency resolution).
      //
      // Edge case: when EVERY service is manual, `autoNames` is `[]`. Calling
      // `docker compose up -d` with no service names tells compose "bring up
      // every service in the project," which would silently start the manual
      // services we explicitly asked to leave alone. Skip the call entirely
      // in that case — the rest of `start()` (network join, status polling,
      // log streaming) still runs so the manual services show up in the UI as
      // `stopped` and the user can start them on demand.
      const autoNames = autoServices.map(s => s.name);
      if (autoNames.length > 0) {
        await this.composeUp(autoNames);
      }
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

    // User-initiated start — clear any OOM auto-retry budget so the
    // service gets a fresh chance. If the user explicitly hits "start"
    // after we gave up on retries, they're saying "try again."
    this.cancelOomStableTimer(name);
    this.oomRetryAttempts.delete(name);
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

    // Same as startService — explicit user action resets the OOM budget.
    this.cancelOomStableTimer(name);
    this.oomRetryAttempts.delete(name);
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
    this.cancelAllRetries();

    this.services.clear();
    this.logBuffers.clear();
    this._started = false;
    this._startupComplete = false;
    this.startError = null;
    await this.start();
  }

  /**
   * Tear down the entire compose stack.
   *
   * Pass `{ removeVolumes: true }` from session-deletion / full-reset paths
   * so per-stack named volumes (e.g. user-declared `node_modules` caches) are
   * dropped along with the containers. Idle-eviction and reconcile pass the
   * default `false` so the user can resume without losing build state.
   */
  async stop(opts: { removeVolumes?: boolean } = {}): Promise<void> {
    this._disposed = true;
    this.stopPolling();
    this.cancelAllRetries();

    // Kill all log streaming processes
    for (const [name, proc] of this.logProcesses) {
      proc.kill();
      this.logProcesses.delete(name);
    }

    try {
      await this.composeDown({ removeVolumes: opts.removeVolumes ?? false });
    } catch {
      // Best-effort cleanup
    }

    for (const [name] of this.services) {
      this.updateServiceStatus(name, "stopped");
    }
    this.logBuffers.clear();
    this._started = false;
  }

  /**
   * Refresh secret env files and apply them to the running stack.
   *
   * Called when the user saves secrets via `PUT /api/secrets`. Re-parses the
   * compose file (in case it changed), rewrites `.shipit/.env.<service>`
   * files, and runs `docker compose up -d` so compose detects the env
   * changes and recreates affected containers. Safe to call when the stack
   * isn't started — env files are written but no compose call happens.
   */
  async refreshSecrets(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      const composePath = path.join(this.workspaceDir, this.composeConfig.file);
      parsedServices = parseComposeFile(composePath, {
        dockerSocket: this.composeConfig.dockerSocket,
      });
    } catch {
      // Compose file missing or invalid — there's nothing to apply secrets to.
      return;
    }
    await this.syncSecrets(parsedServices);

    // In Docker-secrets mode the override file references which secrets each
    // service consumes — so a change to the set of declared secrets (or to
    // `agent: true` flags) requires regenerating the override. In env-file
    // mode, the override only references the env file PATH, so the file
    // content can change without regenerating. We always regenerate when
    // Docker-secrets mode is active to be safe.
    if (this.dockerSecretsBuild) {
      const composePath = path.join(this.workspaceDir, this.composeConfig.file);
      const userNamedVolumes = parseUserNamedVolumes(composePath);
      const overrideOpts: ComposeOverrideOptions = {
        sessionId: this.sessionId,
        composeConfig: this.composeConfig,
        userNamedVolumes,
        ...(this.workspaceVolume ? { workspaceVolume: this.workspaceVolume } : {}),
        ...(this.workspaceSubpath ? { workspaceSubpath: this.workspaceSubpath } : {}),
        ...(this.stackName ? { stackName: this.stackName } : {}),
        dockerSecrets: this.dockerSecretsBuild,
      };
      const overrideContent = generateComposeOverride(parsedServices, overrideOpts);
      writeComposeOverride(this.workspaceDir, overrideContent);
    }

    if (!this._started) return;
    // Re-run `up -d` for the auto services so compose recreates containers
    // whose env_file content changed. Manual services aren't restarted —
    // they're only running if the user explicitly started them.
    const autoNames = [...this.services.values()]
      .filter(s => s.preview === "auto")
      .map(s => s.name);
    try {
      await this.composeUp(autoNames);
      await this.pollStatus();
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] refreshSecrets compose up failed:`, (err as Error).message);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve secrets and write per-service env files. Always runs (even when
   * no secrets are declared) so stale `.env.<svc>` files are swept.
   *
   * Also publishes the latest snapshot via `secrets_status` so subscribers
   * (the runner → WS → client) can render the secrets banner / panel without
   * polling. Emitted on every call regardless of whether the snapshot
   * changed — listeners are cheap, debouncing is the consumer's concern.
   */
  private async syncSecrets(parsedServices: ComposeService[]): Promise<void> {
    let userSecrets: Record<string, string> = {};
    if (this.secretsLoader) {
      try {
        userSecrets = await this.secretsLoader();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] secretsLoader failed:`, (err as Error).message);
      }
    }
    const resolution = resolveSecrets({
      services: parsedServices,
      userSecrets,
      platformCredentials: this.platformCredentials,
    });
    this.declaredSecretNames = resolution.declaredNames;
    this.missingSecretsByService = resolution.missingByService;

    // De-duplicate required-and-missing across services. Same secret name
    // declared `required: true` by multiple services collapses to one entry
    // in the banner — duplicate entries would produce duplicate UI rows.
    const missingRequired = [
      ...new Set(Object.values(resolution.missingRequiredByService).flat()),
    ].sort();
    this.secretsSnapshot = {
      declared: resolution.declared,
      missingByService: resolution.missingByService,
      missingRequired,
      agentNames: Object.keys(resolution.agentValues).sort(),
      agentValues: resolution.agentValues,
    };
    this.emit("secrets_status", this.getSecretsSnapshot());

    if (this.dockerSecretsConfig) {
      // Phase 1 follow-up: Docker-secrets mode. Write per-secret files to
      // the orchestrator-private directory and build the override metadata.
      // Sweep any leftover .env.<svc> files so the agent can't read stale
      // values from a previous reconcile.
      this.applyDockerSecretsMode(resolution);
    } else {
      writePerServiceEnvFiles({
        workspaceDir: this.workspaceDir,
        perServiceEnv: resolution.perServiceEnv,
      });
    }

    // Phase 3: also write the agent env file. Empty body removes the file.
    writeAgentEnvFile({
      workspaceDir: this.workspaceDir,
      body: resolution.agentEnv,
    });
  }

  /**
   * Phase 1 follow-up: write per-secret files outside the workspace and
   * stage compose-override metadata.
   *
   * Steps:
   *   1. De-duplicate values across services (one file per unique name).
   *   2. Write to `dockerSecretsConfig.internalDir/<sessionId>/<NAME>`.
   *   3. Build per-service references (each service only references the
   *      secrets it declared — scoping is preserved at the compose layer).
   *   4. Copy the entrypoint wrapper into `.shipit/secrets-entrypoint.sh`
   *      so compose can mount it into service containers.
   *   5. Sweep any stale `.shipit/.env.<svc>` files from a prior
   *      env-file-mode run.
   */
  private applyDockerSecretsMode(resolution: ReturnType<typeof resolveSecrets>): void {
    const cfg = this.dockerSecretsConfig;
    if (!cfg) return;

    // Collapse per-service values to a single name → value map. The same
    // name appearing under multiple services has the same value (it's the
    // same user-saved secret), so this is safe.
    const collapsed: Record<string, string> = {};
    for (const map of Object.values(resolution.perServiceValues)) {
      for (const [name, value] of Object.entries(map)) {
        collapsed[name] = value;
      }
    }

    const { written } = writeIsolatedSecretFiles({
      rootDir: cfg.internalDir,
      sessionId: this.sessionId,
      values: collapsed,
    });

    // Stage compose override metadata.
    const perService: Record<string, string[]> = {};
    for (const [svcName, values] of Object.entries(resolution.perServiceValues)) {
      const names = Object.keys(values);
      if (names.length > 0) perService[svcName] = names;
    }

    // Copy the entrypoint wrapper into the workspace `.shipit/` directory
    // so it's visible from the workspace volume that compose mounts into
    // service containers. We refresh on every reconcile in case the
    // baked-in script changed.
    const shipitDir = path.join(this.workspaceDir, ".shipit");
    fs.mkdirSync(shipitDir, { recursive: true });
    const wrapperDest = path.join(shipitDir, "secrets-entrypoint.sh");
    try {
      fs.copyFileSync(cfg.entrypointSourcePath, wrapperDest);
      fs.chmodSync(wrapperDest, 0o755);
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] failed to copy entrypoint wrapper:`,
        (err as Error).message,
      );
    }

    this.dockerSecretsBuild = {
      secretNames: written,
      perService,
      filePathFor: (name) => composeSecretFilePath({
        rootDir: cfg.internalDir,
        ...(cfg.hostDir ? { hostDir: cfg.hostDir } : {}),
        sessionId: this.sessionId,
        name,
      }),
      entrypointWorkspacePath: ".shipit/secrets-entrypoint.sh",
    };

    // Sweep any leftover env-file-mode `.shipit/.env.<svc>` files so the
    // agent can't read stale plaintext values.
    let existing: string[] = [];
    try {
      existing = fs.readdirSync(shipitDir);
    } catch {
      existing = [];
    }
    for (const entry of existing) {
      if (!entry.startsWith(".env.") || entry === ".env.agent") continue;
      try {
        fs.unlinkSync(path.join(shipitDir, entry));
      } catch {
        // best-effort
      }
    }
  }

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
        // Service recovered — clear any pending install-window retry state.
        this.clearRetryState(name);
        // If a previous OOM kicked off auto-retries, arm a stable-uptime
        // timer that clears the OOM counter once the service has been
        // healthy long enough. We don't clear the counter eagerly: a
        // service that flaps in and out of `running` while OOMing must
        // still hit the cap, otherwise we loop forever.
        this.armOomStableResetIfNeeded(name);
        if (prev !== "running") this.updateServiceStatus(name, "running");
      } else if (state === "exited" || state === "dead") {
        // Whatever happens below, the service is no longer running — cancel
        // any pending stable-uptime timer so a fresh `running` poll has to
        // re-arm it.
        this.cancelOomStableTimer(name);
        if (exitCode === 0) {
          this.clearRetryState(name);
          this.oomRetryAttempts.delete(name);
          if (prev !== "stopped") this.updateServiceStatus(name, "stopped");
        } else if (this._installRunning && svc.preview === "auto") {
          // Install is still extracting deps into the bind-mounted workspace.
          // Don't latch to `error` — schedule a retry with backoff so the
          // service can come up once install finishes. Manual services are
          // user-initiated and not retried automatically.
          this.scheduleRetryWhileInstalling(name, exitCode);
        } else if (exitCode === 137 && svc.preview === "auto") {
          // 137 = SIGKILL, the most common cause of which inside a
          // memory-limited container is the OOM killer. The authoritative
          // signal comes from the Docker event subscriber in
          // container-health.ts (which checks State.OOMKilled), but if that
          // event was missed we still want to handle it correctly here.
          //
          // We auto-retry up to MAX_OOM_AUTO_RETRIES times with the same
          // backoff schedule the install-window path uses. Without this,
          // the service latches to `error` and the user clicks Rescue
          // session — which destroys+recreates the agent container, kicks
          // off a fresh compose stack, and immediately hits the same OOM
          // condition. The user perceives "Rescue does nothing." This path
          // lets transient pressure spikes self-heal without the user
          // needing to intervene at all.
          this.scheduleOomRetry(name);
        } else {
          const message = exitCode === 137
            ? "Exited with code 137 (likely OOMKilled)"
            : `Exited with code ${exitCode}`;
          this.updateServiceStatus(name, "error", message);
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(name, "starting");
      }
    }
  }

  /**
   * Schedule a retry for a service that exited non-zero while
   * `agent.install` is still in flight. Uses exponential backoff capped at
   * 10s. The service is held in `starting` state (not `error`) so the user
   * sees a benign "still coming up" rather than a failure.
   */
  private scheduleRetryWhileInstalling(name: string, exitCode: number): void {
    if (this._disposed) return;
    // If a retry is already pending, leave it in place.
    if (this.retryTimers.has(name)) return;

    const attempt = (this.retryAttempts.get(name) ?? 0);
    const delayIdx = Math.min(attempt, ServiceManager.RETRY_BACKOFF_MS.length - 1);
    const delay = ServiceManager.RETRY_BACKOFF_MS[delayIdx];
    this.retryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} exited ${exitCode} while install in progress — retry #${attempt + 1} in ${delay}ms`,
    );

    // Reflect "still coming up" to the UI rather than `error`.
    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  /** Run a single restart attempt for a service in retry-backoff. */
  private async runRetryNow(name: string): Promise<void> {
    if (this._disposed) return;
    const svc = this.services.get(name);
    if (!svc) return;
    try {
      await this.composeUpService(name);
      // Status is updated by the next pollStatus pass (periodic poller).
      // Trigger a poll now so we don't wait up to pollIntervalMs to learn
      // whether the retry succeeded.
      await this.pollStatus();
    } catch (err) {
      // Compose itself failed — treat as a normal exit and schedule another
      // retry if install is still running.
      const msg = (err as Error).message;
      if (this._installRunning) {
        this.scheduleRetryWhileInstalling(name, -1);
      } else {
        this.updateServiceStatus(name, "error", msg);
      }
    }
  }

  /**
   * Called when `setInstallRunning(false)` is invoked. Cancels pending
   * backoff timers and triggers one explicit restart for every service
   * currently in `error` or pending-retry state, so a service that crashed
   * just before install finished still recovers.
   */
  private flushPostInstallRetries(): void {
    if (this._disposed) return;

    const targets = new Set<string>();

    // Cancel pending backoff timers — we'll restart immediately.
    for (const [name, timer] of this.retryTimers) {
      clearTimeout(timer);
      targets.add(name);
    }
    this.retryTimers.clear();

    // Also cover services that latched to `error` before install started OR
    // before the retry path was reached (e.g. stack-level start failure).
    for (const svc of this.services.values()) {
      if (svc.preview === "auto" && svc.status === "error") {
        targets.add(svc.name);
      }
    }

    if (targets.size === 0) return;
    console.log(
      `[compose:${this.sessionId}] install finished — restarting ${targets.size} service(s): ${[...targets].join(", ")}`,
    );

    for (const name of targets) {
      this.retryAttempts.delete(name);
      this.updateServiceStatus(name, "starting");
      void this.runRetryNow(name);
    }
  }

  /** Clear any retry state for a service that has recovered or stopped cleanly. */
  private clearRetryState(name: string): void {
    const timer = this.retryTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(name);
    }
    this.retryAttempts.delete(name);
  }

  /** Cancel all pending retries — used during stop()/reconcile(). */
  private cancelAllRetries(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    for (const timer of this.oomStableTimers.values()) clearTimeout(timer);
    this.oomStableTimers.clear();
    this.oomRetryAttempts.clear();
  }

  /**
   * Schedule an OOM-recovery retry for a `preview: auto` service that
   * just exited with code 137. Mirrors `scheduleRetryWhileInstalling` but
   * is bounded by `MAX_OOM_AUTO_RETRIES` — after that many consecutive
   * OOMs without a stable-uptime window in between, we latch to `error`
   * so the user can investigate.
   */
  private scheduleOomRetry(name: string): void {
    if (this._disposed) return;
    // If a retry is already pending, leave it in place.
    if (this.retryTimers.has(name)) return;

    const attempt = this.oomRetryAttempts.get(name) ?? 0;
    if (attempt >= ServiceManager.MAX_OOM_AUTO_RETRIES) {
      // Exhausted — latch to error with a message that explicitly names
      // the retry budget so the user knows we already tried (and that
      // Rescue session won't help here, only fixing the underlying memory
      // pressure will).
      //
      // We intentionally do NOT delete the counter here: the next periodic
      // pollStatus tick will see the service still in `exited`/`dead` state
      // and re-enter this method. Leaving the counter at MAX_OOM_AUTO_RETRIES
      // keeps the gate closed so we don't kick off a fresh retry loop. The
      // counter is reset only by an explicit user action (startService /
      // restartService) or by manager-wide cleanup (cancelAllRetries).
      this.updateServiceStatus(
        name,
        "error",
        `OOMKilled (exit 137) — gave up after ${ServiceManager.MAX_OOM_AUTO_RETRIES} auto-retries; increase the service's memory limit or close other sessions to free host memory`,
      );
      return;
    }

    const delayIdx = Math.min(attempt, ServiceManager.RETRY_BACKOFF_MS.length - 1);
    const delay = ServiceManager.RETRY_BACKOFF_MS[delayIdx];
    this.oomRetryAttempts.set(name, attempt + 1);

    console.log(
      `[compose:${this.sessionId}] ${name} OOMKilled — retry #${attempt + 1}/${ServiceManager.MAX_OOM_AUTO_RETRIES} in ${delay}ms`,
    );

    // Reflect "still coming up" to the UI rather than `error`. The
    // PreviewFrame banner / service dot stay yellow during the retry
    // window instead of going red.
    this.updateServiceStatus(name, "starting");

    const timer = setTimeout(() => {
      this.retryTimers.delete(name);
      void this.runRetryNow(name);
    }, delay);
    this.retryTimers.set(name, timer);
  }

  /**
   * Arm a stable-uptime timer for a service that has reached `running`
   * after at least one OOM auto-retry. If the service stays running for
   * `OOM_STABLE_RESET_MS` the OOM counter resets; if it leaves `running`
   * first, the timer is cancelled by the next exited-state poll.
   */
  private armOomStableResetIfNeeded(name: string): void {
    if (!this.oomRetryAttempts.has(name)) return;
    if (this.oomStableTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.oomStableTimers.delete(name);
      this.oomRetryAttempts.delete(name);
    }, ServiceManager.OOM_STABLE_RESET_MS);
    this.oomStableTimers.set(name, timer);
  }

  /** Cancel the stable-uptime timer for a service (when it leaves `running`). */
  private cancelOomStableTimer(name: string): void {
    const timer = this.oomStableTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.oomStableTimers.delete(name);
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
    return this.runComposeUpWithConflictRecovery("up", "-d", "--remove-orphans", ...(serviceNames ?? []));
  }

  /** Run `docker compose up -d` for a specific manual service. */
  private composeUpService(name: string): Promise<void> {
    return this.runComposeUpWithConflictRecovery("up", "-d", name);
  }

  /**
   * Run `docker compose up …` and, on a Docker container-name conflict
   * (a stale container with the predicted name exists but compose doesn't
   * adopt it — e.g., labels drifted across orchestrator versions, the prior
   * teardown was interrupted, or another `up` call raced and left a zombie),
   * force-remove the conflicting container by ID and retry once.
   *
   * Why this lives here, not in `killStaleContainers()`: the broad pre-start
   * label sweep was over-aggressive — it SIGKILLed healthy preview containers
   * on every config reconcile (see efa1ec150 / docs/127-restart-agent §"Out
   * of scope"). This handler is surgical: it only removes the *specific*
   * container Docker named in the conflict error, so working stacks aren't
   * disturbed. The conflicting container can't be useful anyway — its name
   * is blocking the create we're about to issue.
   */
  private async runComposeUpWithConflictRecovery(...subArgs: string[]): Promise<void> {
    try {
      await this.runCompose(...subArgs);
    } catch (err) {
      const conflictId = extractConflictContainerId((err as Error).message);
      if (!conflictId) throw err;
      console.warn(
        `[compose:${this.sessionId}] Container-name conflict; removing ${conflictId.slice(0, 12)} and retrying`,
      );
      try {
        await this.composeQuery(["rm", "-f", conflictId], this.workspaceDir);
      } catch {
        // Removal failed — surface the original conflict error so the cause
        // is clear, rather than masking it with the removal failure.
        throw err;
      }
      await this.runCompose(...subArgs);
    }
  }

  /** Run `docker compose stop <service>`. */
  private composeStop(name: string): Promise<void> {
    return this.runCompose("stop", name);
  }

  /** Run `docker compose down --remove-orphans`, optionally dropping volumes. */
  private composeDown(opts: { removeVolumes: boolean }): Promise<void> {
    const args = ["down", "--remove-orphans"];
    if (opts.removeVolumes) args.push("--volumes");
    return this.runCompose(...args);
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
 * Parse the conflicting container ID out of a Docker compose-up error.
 *
 * The daemon's name-collision message looks like:
 *   `… The container name "/shipit-…-dev-1" is already in use by container
 *    "6f943f7b45f75e4b321b707752b26f460155c64e6625243b312da9a3acdb0631". …`
 *
 * Returns the 64-hex container ID when present, otherwise `undefined` so the
 * caller can rethrow the original error untouched.
 */
function extractConflictContainerId(message: string): string | undefined {
  const m = /already in use by container "([0-9a-f]{12,64})"/.exec(message);
  return m?.[1];
}

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
