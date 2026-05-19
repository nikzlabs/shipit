/**
 * ServiceManager — manages Docker Compose service lifecycle for a session.
 *
 * Replaces the services container (Fastify session worker for preview) with
 * direct `docker compose` CLI invocations from the orchestrator. Each session
 * gets its own compose stack with an override file for ShipIt integration.
 *
 * Responsibilities (kept here):
 *   - Start/stop/reconcile compose stack
 *   - Start/stop/restart individual services
 *   - Log streaming via `docker compose logs -f`
 *   - Compose CLI invocation (with conflict recovery)
 *
 * Three collaborators handle the more cohesive sub-concerns:
 *   - `ServiceSecretsResolver` — resolves declared secrets, writes env
 *     files / Docker-secrets files, publishes snapshot updates.
 *   - `ServicePoller` — runs the `docker compose ps` poll loop, resolves
 *     container IPs via `docker inspect`, fires state-transition hooks.
 *   - `ServiceRetryManager` — owns install-window retry timers and the
 *     OOM auto-retry budget.
 *
 * Each collaborator is callback-driven and never imports back from this
 * file at runtime (only types). The manager passes the hooks they need
 * via constructor options.
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
import type { PlatformCredentialProvider } from "./platform-credentials.js";
import {
  ServiceSecretsResolver,
  type SecretsStatusInternalSnapshot,
  type DockerSecretsConfig,
} from "./service-secrets-resolver.js";
import { ServicePoller } from "./service-poller.js";
import { ServiceRetryManager } from "./service-retry-manager.js";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface tests / consumers import from
// here. `SecretsStatusInternalSnapshot` is consumed by ContainerSessionRunner
// and the test file via this module; the simpler `SecretsStatusSnapshot`
// type stays exported for external consumers that only need the public
// shape (no agent values).
// ---------------------------------------------------------------------------

export type {
  SecretsStatusSnapshot,
  SecretsStatusInternalSnapshot,
} from "./service-secrets-resolver.js";

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
   * Collects account-level MCP secret values (`mcp__*` keys from
   * `CredentialStore.agentEnv`) — docs/088. Called inside the secret-sync
   * pass after `resolveSecrets()` runs; the result is merged into the
   * resolved `agentValues` map (compose-declared entries win on key
   * collision) before `.shipit/.env.agent` is written and pushed to the
   * worker. Synchronous — `CredentialStore` is an in-memory JSON store.
   */
  mcpAgentEnvLoader?: () => Record<string, string>;
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
  dockerSecretsConfig?: DockerSecretsConfig;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

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
  private readonly workspaceVolume?: string;
  private readonly workspaceSubpath?: string;
  private readonly stackName?: string;
  private readonly networkJoinFn?: (networkName: string) => Promise<void>;

  // Collaborators — see the module docstring.
  private readonly secrets: ServiceSecretsResolver;
  private readonly poller: ServicePoller;
  private readonly retry: ServiceRetryManager;

  private _startupComplete = false;
  /** Error message if the compose stack failed to start. */
  startError: string | null = null;
  /**
   * Set to `true` once `stop()` has been called. Guards retry callbacks so
   * they don't fire after the manager has been torn down. Reset to `false`
   * at the top of `start()` (which is also the path `reconcile()` takes).
   */
  private _disposed = false;

  /**
   * While `true`, services that exit non-zero are restarted with backoff
   * instead of being marked `error`. Set by the orchestrator around the
   * `agent.install` window so a dev server that loses a race with install
   * (deps still extracting) recovers automatically rather than latching to
   * `error`. See `setInstallRunning`.
   */
  private _installRunning = false;

  constructor(opts: ServiceManagerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeConfig = opts.composeConfig;
    this.composeRunner = opts.composeRunner ?? defaultComposeRunner;
    this.composeQuery = opts.composeQuery ?? defaultComposeQuery;
    this.workspaceVolume = opts.workspaceVolume;
    this.workspaceSubpath = opts.workspaceSubpath;
    this.stackName = opts.stackName;
    this.networkJoinFn = opts.networkJoinFn;

    this.secrets = new ServiceSecretsResolver({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      ...(opts.secretsLoader ? { secretsLoader: opts.secretsLoader } : {}),
      ...(opts.mcpAgentEnvLoader ? { mcpAgentEnvLoader: opts.mcpAgentEnvLoader } : {}),
      ...(opts.platformCredentials ? { platformCredentials: opts.platformCredentials } : {}),
      ...(opts.dockerSecretsConfig ? { dockerSecretsConfig: opts.dockerSecretsConfig } : {}),
      onSnapshot: (snapshot) => this.emit("secrets_status", snapshot),
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
      composeQuery: this.composeQuery,
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      composeArgs: (...extra) => this.composeArgs(...extra),
      getService: (name) => this.services.get(name),
      setContainerIp: (name, ip) => {
        const svc = this.services.get(name);
        if (svc) svc.containerIp = ip;
      },
      updateServiceStatus: (name, status, error) =>
        this.updateServiceStatus(name, status, error),
      onRunning: (name) => {
        // Service recovered — clear any pending install-window retry state.
        this.retry.clearRetryState(name);
        // If a previous OOM kicked off auto-retries, arm a stable-uptime
        // timer that clears the OOM counter once the service has been
        // healthy long enough. We don't clear the counter eagerly: a
        // service that flaps in and out of `running` while OOMing must
        // still hit the cap, otherwise we loop forever.
        this.retry.armOomStableResetIfNeeded(name);
      },
      onLeftRunning: (name) => {
        this.retry.cancelOomStableTimer(name);
      },
      onExitedCleanly: (name) => {
        this.retry.clearRetryState(name);
        this.retry.clearOomBudget(name);
      },
      onExitedWithError: (name, exitCode) => {
        this.handleNonZeroExit(name, exitCode);
      },
    });
  }

  /**
   * Branching for a non-zero exit. See the original inline pollStatus for
   * the rationale on each branch — preserved verbatim here so the retry
   * paths behave identically.
   */
  private handleNonZeroExit(name: string, exitCode: number): void {
    const svc = this.services.get(name);
    if (!svc) return;

    if (this._installRunning && svc.preview === "auto") {
      // Install is still extracting deps into the bind-mounted workspace.
      // Don't latch to `error` — schedule a retry with backoff so the
      // service can come up once install finishes. Manual services are
      // user-initiated and not retried automatically.
      this.retry.scheduleRetryWhileInstalling(name, exitCode);
      return;
    }

    if (exitCode === 137 && svc.preview === "auto") {
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
      this.retry.scheduleOomRetry(name);
      return;
    }

    const message = exitCode === 137
      ? "Exited with code 137 (likely OOMKilled)"
      : `Exited with code ${exitCode}`;
    this.updateServiceStatus(name, "error", message);
  }

  /**
   * Update or replace the secrets loader. Called when the session's remoteUrl
   * changes (e.g. after warm-session graduation) so subsequent reconciles read
   * the right slice of SecretStore.
   */
  setSecretsLoader(loader: () => Promise<Record<string, string>>): void {
    this.secrets.setSecretsLoader(loader);
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
    return this.secrets.getDeclaredNames();
  }

  /** Missing secrets (required + optional) by service. */
  getMissingSecretsByService(): Record<string, string[]> {
    return this.secrets.getMissingByService();
  }

  /**
   * Latest secrets snapshot — declared requirements + per-service missing +
   * de-duplicated required-and-missing names + resolved agent values.
   * Returned as a defensive copy so callers can't mutate manager state.
   */
  getSecretsSnapshot(): SecretsStatusInternalSnapshot {
    return this.secrets.getSnapshot();
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
    await this.secrets.sync(parsedServices);

    // Generate override
    const userNamedVolumes = parseUserNamedVolumes(composePath);
    const dockerSecretsBuild = this.secrets.getDockerSecretsBuild();
    const overrideOpts: ComposeOverrideOptions = {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      stackName: this.stackName,
      userNamedVolumes,
      ...(dockerSecretsBuild ? { dockerSecrets: dockerSecretsBuild } : {}),
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

      // 2. Join agent + orchestrator to compose network (before IP resolution).
      //    No-op when `autoNames.length === 0` because we just skipped
      //    `composeUp`, so the network doesn't exist yet — `joinSessionNetwork`
      //    will be re-invoked from `startService()` once the first manual
      //    service finally creates it. See the "all-manual stacks" comment on
      //    `joinSessionNetwork` for the full story.
      await this.joinSessionNetwork();

      // 3. Resolve container IPs and actual statuses
      await this.poller.pollOnce();

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
      this.poller.start();

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
    this.retry.resetOomBudget(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.composeUpService(name);
      // The first manual-service start is the moment the compose network
      // actually gets created (compose materializes the network on `up`,
      // not just when the file is parsed). If this stack is all-manual,
      // `start()`'s earlier `joinSessionNetwork()` no-op'd because the
      // network didn't exist yet — the orchestrator + agent container
      // still need to be attached or the preview proxy can't reach the
      // freshly-started container by IP. Idempotent on subsequent starts.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
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
    this.retry.resetOomBudget(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.composeStop(name);
      await this.composeUpService(name);
      // Defensive: if a previous all-manual `start()` skipped the network
      // join (see startService comment), the first restartService after
      // adoption could be the first time the orchestrator gets attached.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
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
    this.poller.stop();
    this.retry.cancelAll();

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
    this.poller.stop();
    this.retry.cancelAll();

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
    await this.secrets.sync(parsedServices);

    // In Docker-secrets mode the override file references which secrets each
    // service consumes — so a change to the set of declared secrets (or to
    // `agent: true` flags) requires regenerating the override. In env-file
    // mode, the override only references the env file PATH, so the file
    // content can change without regenerating. We always regenerate when
    // Docker-secrets mode is active to be safe.
    const dockerSecretsBuild = this.secrets.getDockerSecretsBuild();
    if (dockerSecretsBuild) {
      const composePath = path.join(this.workspaceDir, this.composeConfig.file);
      const userNamedVolumes = parseUserNamedVolumes(composePath);
      const overrideOpts: ComposeOverrideOptions = {
        sessionId: this.sessionId,
        composeConfig: this.composeConfig,
        userNamedVolumes,
        ...(this.workspaceVolume ? { workspaceVolume: this.workspaceVolume } : {}),
        ...(this.workspaceSubpath ? { workspaceSubpath: this.workspaceSubpath } : {}),
        ...(this.stackName ? { stackName: this.stackName } : {}),
        dockerSecrets: dockerSecretsBuild,
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
      await this.poller.pollOnce();
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] refreshSecrets compose up failed:`, (err as Error).message);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Run a single restart attempt for a service in retry-backoff. */
  private async runRetryNow(name: string): Promise<void> {
    if (this._disposed) return;
    const svc = this.services.get(name);
    if (!svc) return;
    try {
      await this.composeUpService(name);
      // See `startService` — first manual-service start is the moment
      // the network actually exists, so re-attempt the orchestrator
      // network join here too. Idempotent on subsequent retries.
      await this.joinSessionNetwork();
      // Status is updated by the next pollStatus pass (periodic poller).
      // Trigger a poll now so we don't wait up to pollIntervalMs to learn
      // whether the retry succeeded.
      await this.poller.pollOnce();
    } catch (err) {
      // Compose itself failed — treat as a normal exit and schedule another
      // retry if install is still running.
      const msg = (err as Error).message;
      if (this._installRunning) {
        this.retry.scheduleRetryWhileInstalling(name, -1);
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

    // Collect error-state services and let the retry manager fold in any
    // pending install-window retry timers (cancelling them as a side effect).
    const errorServices: string[] = [];
    for (const svc of this.services.values()) {
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

  /**
   * Attach the orchestrator (and the agent container, where applicable) to
   * the per-session compose network so the preview proxy can reach service
   * containers by IP, and the agent container can reach them by DNS.
   *
   * Idempotent: `networkJoinFn` swallows "already exists" errors at the
   * call site (see `setupServiceManager` in `app-lifecycle.ts`). Safe to
   * invoke after every successful `composeUp`/`composeUpService`.
   *
   * Why this is called from multiple places: compose only creates the
   * `shipit-session-<id>` network during a `docker compose up`. For stacks
   * where every service is `x-shipit-preview: manual` (the ShipIt-in-ShipIt
   * dogfood case is the canonical example), `start()` deliberately skips
   * `composeUp` — so the network does not exist yet, and this helper is a
   * no-op when invoked from `start()`. The network is then materialized
   * lazily by the first `composeUpService` from `startService` (or one of
   * its variants — `restartService`, `runRetryNow`), and the helper must
   * be called again from there to actually attach the orchestrator. Without
   * the post-`composeUpService` call, the proxy would resolve a perfectly
   * correct container IP that the orchestrator has no route to → ETIMEDOUT.
   */
  private async joinSessionNetwork(): Promise<void> {
    if (!this.networkJoinFn) return;
    const networkName = `shipit-session-${this.sessionId}`;
    try {
      await this.networkJoinFn(networkName);
    } catch {
      // Non-fatal — agent may not reach services by DNS but proxy still works.
      // The orchestrator-side join inside `networkJoinFn` has its own
      // try/catch with "already exists" handling (see app-lifecycle.ts).
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

  /**
   * Run `docker compose up -d --build`, optionally for specific services only.
   *
   * `--build` matters for any service that declares a `build:` section (e.g.
   * the ShipIt-in-ShipIt dogfood `dev` service). Without it, `docker compose
   * up` only builds when the named image is *missing* — so a changed
   * `Dockerfile` or build context on a host that already has the cached image
   * is silently ignored, and the stale image runs forever. `--build` forces
   * Compose to re-evaluate the build every `up`; Docker's layer cache makes
   * the no-change case cheap (all cache hits). For services that only declare
   * `image:` (the common case — most user repos pull a prebuilt image), there
   * is nothing to build and `--build` is a harmless no-op.
   */
  private composeUp(serviceNames?: string[]): Promise<void> {
    return this.runComposeUpWithConflictRecovery("up", "-d", "--build", "--remove-orphans", ...(serviceNames ?? []));
  }

  /** Run `docker compose up -d --build` for a specific manual service. */
  private composeUpService(name: string): Promise<void> {
    return this.runComposeUpWithConflictRecovery("up", "-d", "--build", name);
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
