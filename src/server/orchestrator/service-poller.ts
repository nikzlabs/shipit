export type ComposeQueryFn = (args: string[], cwd: string) => Promise<string>;

export interface PollerService {
  name: string;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "running" | "error";
}

// Covers recreation gaps; isStartInFlight protects longer builds.
export const MISSING_CONTAINER_GRACE_MS = 30_000;
export const COMPOSE_QUERY_TIMEOUT_MS = 30_000;
export const DOCKER_UNREACHABLE_GRACE_MS = 30_000;

export const DOCKER_UNREACHABLE_MESSAGE =
  `Docker has not answered \`docker compose ps\` for over ${Math.round(DOCKER_UNREACHABLE_GRACE_MS / 1000)}s, ` +
  "so this service's status can no longer be confirmed. The container may still be running. " +
  "The status recovers on its own as soon as Docker responds again.";

// Preserve unknown and paused states; containment owns the paused transition.
const INCONCLUSIVE_CONTAINER_STATES = new Set(["created", "removing"]);

export interface ServicePollerOptions {
  sessionId: string;
  workspaceDir: string;
  composeQuery: ComposeQueryFn;
  /** Zero disables periodic polling. */
  pollIntervalMs: number;
  composeArgs: (...extra: string[]) => string[];
  isGated?: (name: string) => boolean;
  getService: (name: string) => PollerService | undefined;
  listServices: () => PollerService[];
  isStartInFlight?: (name: string) => boolean;
  setContainerIp: (serviceName: string, ip: string) => void;
  updateServiceStatus: (
    name: string,
    status: "stopped" | "starting" | "running" | "error",
    error?: string,
  ) => void;
  /** Called on every running poll, before the status update. */
  onRunning: (name: string) => void;
  onLeftRunning: (name: string) => void;
  onExitedCleanly: (name: string) => void;
  /** oomKilled comes from inspect; exit 137 alone does not prove OOM. */
  onExitedWithError: (name: string, exitCode: number, oomKilled?: boolean) => void;
  afterPoll?: () => void | Promise<void>;
}

// Bounds the wait without killing the underlying Docker process.
function withQueryTimeout(promise: Promise<string>, message: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), COMPOSE_QUERY_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class ServicePoller {
  private readonly sessionId: string;
  private readonly workspaceDir: string;
  private readonly composeQuery: ComposeQueryFn;
  private readonly pollIntervalMs: number;
  private readonly composeArgs: (...extra: string[]) => string[];
  private readonly isGated: (name: string) => boolean;
  private readonly getService: (name: string) => PollerService | undefined;
  private readonly listServices: () => PollerService[];
  private readonly isStartInFlight: (name: string) => boolean;
  private readonly setContainerIp: (serviceName: string, ip: string) => void;
  private readonly updateServiceStatus: ServicePollerOptions["updateServiceStatus"];
  private readonly onRunning: (name: string) => void;
  private readonly onLeftRunning: (name: string) => void;
  private readonly onExitedCleanly: (name: string) => void;
  private readonly onExitedWithError: (name: string, exitCode: number, oomKilled?: boolean) => void;
  private readonly afterPoll?: () => void | Promise<void>;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly missingSince = new Map<string, number>();
  private psFailingSince: number | null = null;

  constructor(opts: ServicePollerOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeQuery = (args, cwd) => withQueryTimeout(
      opts.composeQuery(args, cwd),
      `docker ${args[0]} did not answer within ${COMPOSE_QUERY_TIMEOUT_MS}ms`,
    );
    this.pollIntervalMs = opts.pollIntervalMs;
    this.composeArgs = opts.composeArgs;
    this.isGated = opts.isGated ?? (() => false);
    this.getService = opts.getService;
    this.listServices = opts.listServices;
    this.isStartInFlight = opts.isStartInFlight ?? (() => false);
    this.setContainerIp = opts.setContainerIp;
    this.updateServiceStatus = opts.updateServiceStatus;
    this.onRunning = opts.onRunning;
    this.onLeftRunning = opts.onLeftRunning;
    this.onExitedCleanly = opts.onExitedCleanly;
    this.onExitedWithError = opts.onExitedWithError;
    this.afterPoll = opts.afterPoll;
  }

  async pollOnce(): Promise<void> {
    const args = this.composeArgs("ps", "--format", "json", "-a");
    let stdout: string;
    try {
      stdout = await this.composeQuery(args, this.workspaceDir);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] pollStatus failed:`, (err as Error).message);
      // Query failure is not an empty container list; expire only sustained stale claims.
      this.expireUnconfirmedStatuses();
      return;
    }
    this.psFailingSince = null;

    const containerNames = new Map<string, string>();
    const statusUpdates: { name: string; state: string; exitCode: number }[] = [];
    const seen = new Set<string>();

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
      if (!INCONCLUSIVE_CONTAINER_STATES.has(entry.State ?? "")) seen.add(svc.name);

      // The install gate owns held service statuses.
      if (this.isGated(svc.name)) continue;

      const containerRef = entry.ID ?? entry.Name;
      if (containerRef) containerNames.set(containerRef, svc.name);
      statusUpdates.push({
        name: svc.name,
        state: entry.State ?? "",
        exitCode: entry.ExitCode ?? 1,
      });
    }

    // Resolve IPs before announcing running so previews can route immediately.
    let oomFlags = new Map<string, boolean>();
    if (containerNames.size > 0) {
      oomFlags = await this.resolveContainerIps(containerNames);
    }

    for (const { name, state, exitCode } of statusUpdates) {
      const svc = this.getService(name);
      if (!svc) continue;
      const prev = svc.status;
      if (state === "running") {
        this.onRunning(name);
        if (prev !== "running") this.updateServiceStatus(name, "running");
      } else if (state === "exited" || state === "dead") {
        this.onLeftRunning(name);
        if (exitCode === 0) {
          this.onExitedCleanly(name);
          if (prev !== "stopped") this.updateServiceStatus(name, "stopped");
        } else {
          this.onExitedWithError(name, exitCode, oomFlags.get(name));
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(name, "starting");
      }
    }

    this.reconcileMissingServices(seen);

    if (this.afterPoll) {
      try {
        await this.afterPoll();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] afterPoll hook failed:`, (err as Error).message);
      }
    }
  }

  private expireUnconfirmedStatuses(): void {
    const now = Date.now();
    if (this.psFailingSince === null) {
      this.psFailingSince = now;
      return;
    }
    if (now - this.psFailingSince < DOCKER_UNREACHABLE_GRACE_MS) return;

    // An in-flight up cannot confirm that a previously running container still exists.
    for (const svc of this.listServices()) {
      if (svc.status !== "running") continue;
      if (this.isGated(svc.name)) continue;
      console.warn(
        `[compose:${this.sessionId}] service "${svc.name}" was last seen running but docker has not ` +
        `answered for ${Math.round((now - this.psFailingSince) / 1000)}s — status no longer confirmed`,
      );
      this.onLeftRunning(svc.name);
      this.updateServiceStatus(svc.name, "error", DOCKER_UNREACHABLE_MESSAGE);
    }
  }

  private reconcileMissingServices(seen: Set<string>): void {
    const now = Date.now();
    const known = new Set<string>();

    for (const svc of this.listServices()) {
      known.add(svc.name);
      const eligible =
        !seen.has(svc.name) &&
        !this.isGated(svc.name) &&
        !this.isStartInFlight(svc.name) &&
        svc.status !== "stopped" &&
        svc.status !== "error";
      if (!eligible) {
        // Measure continuous absence, not the sum of separate gaps.
        this.missingSince.delete(svc.name);
        continue;
      }

      const since = this.missingSince.get(svc.name);
      if (since === undefined) {
        this.missingSince.set(svc.name, now);
        continue;
      }
      if (now - since < MISSING_CONTAINER_GRACE_MS) continue;

      this.missingSince.delete(svc.name);
      console.warn(
        `[compose:${this.sessionId}] service "${svc.name}" has had no container for ` +
        `${Math.round((now - since) / 1000)}s while ${svc.status} — marking stopped`,
      );
      this.onLeftRunning(svc.name);
      this.updateServiceStatus(svc.name, "stopped");
    }

    for (const name of this.missingSince.keys()) {
      if (!known.has(name)) this.missingSince.delete(name);
    }
  }

  start(): void {
    this.stop();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err: unknown) => {
        console.warn(`[compose:${this.sessionId}] periodic poll error:`, (err as Error).message);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Reconcile replaces the registry; its old outage clocks must not carry over.
    this.missingSince.clear();
    this.psFailingSince = null;
  }

  private async resolveContainerIps(
    containerNames: Map<string, string>,
  ): Promise<Map<string, boolean>> {
    const networkName = `shipit-session-${this.sessionId}`;
    const oomFlags = new Map<string, boolean>();

    for (const [containerName, serviceName] of containerNames) {
      try {
        const stdout = await this.composeQuery(
          ["inspect", containerName],
          this.workspaceDir,
        );
        const parsed = JSON.parse(stdout) as { State?: { OOMKilled?: boolean }; NetworkSettings?: { IPAddress?: string; Networks?: Record<string, { IPAddress?: string }> } }[];
        // Exited containers may have no networks, but their OOM flag still matters.
        const oomKilled = parsed[0]?.State?.OOMKilled;
        if (typeof oomKilled === "boolean") oomFlags.set(serviceName, oomKilled);
        const netSettings = parsed[0]?.NetworkSettings;
        let nets = netSettings?.Networks;

        if (!nets || Object.keys(nets).length === 0) {
          try {
            await this.composeQuery(
              ["network", "connect", networkName, containerName],
              this.workspaceDir,
            );
            const stdout2 = await this.composeQuery(["inspect", containerName], this.workspaceDir);
            const parsed2 = JSON.parse(stdout2) as typeof parsed;
            nets = parsed2[0]?.NetworkSettings?.Networks;
          } catch {
            // Network repair is best effort.
          }
        }

        if (!nets) continue;

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

    return oomFlags;
  }
}
