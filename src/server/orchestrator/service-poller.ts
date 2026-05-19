/**
 * ServicePoller — owns the `docker compose ps` poll loop, the per-container
 * `docker inspect` for IP resolution, and the state-transition diff that
 * fires the recovery/retry/OOM hooks on the parent ServiceManager.
 *
 * Extracted from `service-manager.ts` so polling can be tested in isolation
 * and so the manager's lifecycle methods (`start`, `stop`, `reconcile`)
 * don't need to know how often we poll or how IPs are resolved.
 *
 * The poller is intentionally callback-driven — it never touches the
 * services Map directly. The manager passes accessor and mutator hooks via
 * the constructor; the poller calls them on each state transition. This
 * keeps the manager's services map the single source of truth and avoids
 * the dual-write problem.
 */

/**
 * Runs a docker compose command and returns stdout. Same shape as
 * `ComposeQuery` in `service-manager.ts` — duplicated here to avoid the
 * type-only back-import that would otherwise create a cycle.
 */
export type ComposeQueryFn = (args: string[], cwd: string) => Promise<string>;

export interface PollerService {
  name: string;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "running" | "error";
}

export interface ServicePollerOptions {
  sessionId: string;
  workspaceDir: string;
  composeQuery: ComposeQueryFn;
  /** How often the periodic poll fires, in ms. 0 disables the timer. */
  pollIntervalMs: number;
  /** Build the common compose CLI args (manager owns the file/project flags). */
  composeArgs: (...extra: string[]) => string[];
  /** Look up the current state of a service in the manager's map. */
  getService: (name: string) => PollerService | undefined;
  /** Persist a resolved container IP back to the manager's service entry. */
  setContainerIp: (serviceName: string, ip: string) => void;
  /** Update a service's status (delegates to the manager). */
  updateServiceStatus: (
    name: string,
    status: "stopped" | "starting" | "running" | "error",
    error?: string,
  ) => void;
  // --- State-transition hooks (called from poll diff) ---
  /**
   * Service is `running`. Always invoked on a `running` poll (before any
   * status update is emitted) so the manager can clear install-retry state
   * and arm the OOM-stable-uptime timer.
   */
  onRunning: (name: string) => void;
  /**
   * Service has left `running` (exit code 0 or non-zero). Always invoked
   * once per poll — the manager uses it to cancel the OOM-stable timer.
   */
  onLeftRunning: (name: string) => void;
  /**
   * Service exited cleanly (exit 0). Invoked AFTER `onLeftRunning` on the
   * same poll. The manager uses it to clear retry / OOM bookkeeping.
   */
  onExitedCleanly: (name: string) => void;
  /**
   * Service exited non-zero. The manager decides the branch (install-window
   * retry / OOM retry / terminal error) — the poller just dispatches.
   */
  onExitedWithError: (name: string, exitCode: number) => void;
}

export class ServicePoller {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private readonly composeQuery: ComposeQueryFn;
  private readonly pollIntervalMs: number;
  private readonly composeArgs: (...extra: string[]) => string[];
  private readonly getService: (name: string) => PollerService | undefined;
  private readonly setContainerIp: (serviceName: string, ip: string) => void;
  private readonly updateServiceStatus: ServicePollerOptions["updateServiceStatus"];
  private readonly onRunning: (name: string) => void;
  private readonly onLeftRunning: (name: string) => void;
  private readonly onExitedCleanly: (name: string) => void;
  private readonly onExitedWithError: (name: string, exitCode: number) => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ServicePollerOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeQuery = opts.composeQuery;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.composeArgs = opts.composeArgs;
    this.getService = opts.getService;
    this.setContainerIp = opts.setContainerIp;
    this.updateServiceStatus = opts.updateServiceStatus;
    this.onRunning = opts.onRunning;
    this.onLeftRunning = opts.onLeftRunning;
    this.onExitedCleanly = opts.onExitedCleanly;
    this.onExitedWithError = opts.onExitedWithError;
  }

  /**
   * Query `docker compose ps --format json` and update service statuses
   * based on actual container state. Public so the manager can trigger
   * an on-demand poll after `compose up`, `startService`, retries, etc.
   */
  async pollOnce(): Promise<void> {
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
      const svc = entry.Service ? this.getService(entry.Service) : undefined;
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
      const svc = this.getService(name);
      if (!svc) continue;
      const prev = svc.status;
      if (state === "running") {
        // Service recovered — clear any pending install-window retry state,
        // and (if applicable) arm a stable-uptime timer that clears the OOM
        // counter once the service has been healthy long enough.
        this.onRunning(name);
        if (prev !== "running") this.updateServiceStatus(name, "running");
      } else if (state === "exited" || state === "dead") {
        // Whatever happens below, the service is no longer running — cancel
        // any pending stable-uptime timer so a fresh `running` poll has to
        // re-arm it.
        this.onLeftRunning(name);
        if (exitCode === 0) {
          this.onExitedCleanly(name);
          if (prev !== "stopped") this.updateServiceStatus(name, "stopped");
        } else {
          // Branch between install-window retry / OOM auto-retry / terminal
          // error is the manager's call — see `handleNonZeroExit` there.
          this.onExitedWithError(name, exitCode);
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(name, "starting");
      }
    }
  }

  /**
   * Start the periodic poll timer. Idempotent — calling twice replaces
   * the existing timer with a fresh one.
   */
  start(): void {
    this.stop();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err: unknown) => {
        console.warn(`[compose:${this.sessionId}] periodic poll error:`, (err as Error).message);
      });
    }, this.pollIntervalMs);
  }

  /** Stop the periodic poll timer. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
          this.setContainerIp(serviceName, ip);
        }
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] docker inspect ${containerName} failed:`, (err as Error).message);
      }
    }
  }
}
