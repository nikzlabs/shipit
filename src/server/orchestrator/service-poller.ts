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

/**
 * How long a known service may be absent from `docker compose ps -a` before
 * the poller reconciles it to `stopped` (SHI-314). ~6 polls at the default 5s
 * interval.
 *
 * The window exists because "no row" is genuinely ambiguous for a short
 * moment: `compose up` recreating a container removes the old one before
 * creating the new one, so a poll landing in that gap sees nothing. It is NOT
 * the mechanism that protects a slow first start — a `compose up` that is
 * still building has no row for minutes, far longer than any sane grace, and
 * is excluded by the `isStartInFlight` check instead.
 */
export const MISSING_CONTAINER_GRACE_MS = 30_000;

export interface ServicePollerOptions {
  sessionId: string;
  workspaceDir: string;
  composeQuery: ComposeQueryFn;
  /** How often the periodic poll fires, in ms. 0 disables the timer. */
  pollIntervalMs: number;
  /** Build the common compose CLI args (manager owns the file/project flags). */
  composeArgs: (...extra: string[]) => string[];
  /**
   * Whether a service is currently held by the install gate (docs/137).
   * Gated services are skipped entirely by the poll — their `starting`/
   * `error` status is owned by the gate, so a transient `ps` reading (e.g.
   * a container exiting during mid-session re-install teardown) must not
   * clobber it. Optional — defaults to "never gated".
   */
  isGated?: (name: string) => boolean;
  /** Look up the current state of a service in the manager's map. */
  getService: (name: string) => PollerService | undefined;
  /**
   * Every service the manager currently knows about. Drives the
   * missing-container reconciliation pass (SHI-314) — the poll's forward pass
   * can only react to services `ps` mentions, so the reverse question ("which
   * services did `ps` NOT mention?") needs the full registry.
   */
  listServices: () => PollerService[];
  /**
   * Whether a `docker compose up` is in flight for this service right now.
   * Such a service legitimately has no container yet — possibly for minutes
   * while an image builds — so it is exempt from missing-container
   * reconciliation. Optional — defaults to "never in flight".
   */
  isStartInFlight?: (name: string) => boolean;
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
   *
   * `oomKilled` is the container's authoritative `State.OOMKilled`, harvested
   * from the `docker inspect` this poll already runs for IP resolution:
   * `true`/`false` when the inspect answered, `undefined` when it didn't (or
   * the daemon omitted the field). Exit 137 alone does NOT mean OOM — our own
   * re-install teardown SIGKILLs a service that ignores SIGTERM, and that
   * exits 137 with `OOMKilled: false`.
   */
  onExitedWithError: (name: string, exitCode: number, oomKilled?: boolean) => void;
  /**
   * Optional hook invoked at the end of each successful poll. Used to run the
   * agent network-attachment self-heal on the poll heartbeat (docs/128 —
   * stranded ops agent after a proxy/network recreate). Best-effort — its
   * errors are swallowed so a heal failure never disrupts polling. Omitted in
   * tests / non-container setups.
   */
  afterPoll?: () => void | Promise<void>;
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
  /**
   * `serviceName -> Date.now()` of the first poll that found the service
   * absent from `ps` output while it was eligible for reconciliation. Cleared
   * the moment the service reappears (or becomes ineligible), so the grace
   * window measures a *continuous* absence rather than a cumulative one.
   */
  private readonly missingSince = new Map<string, number>();

  constructor(opts: ServicePollerOptions) {
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeQuery = opts.composeQuery;
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

  /**
   * Query `docker compose ps --format json` and update service statuses
   * based on actual container state. Public so the manager can trigger
   * an on-demand poll after `compose up`, `startService`, retries, etc.
   */
  async pollOnce(): Promise<void> {
    const args = this.composeArgs("ps", "--format", "json", "-a");
    let stdout: string;
    try {
      // A failing `ps` says nothing about container state, so we deliberately
      // bail out entirely rather than letting the reconciliation pass below
      // interpret "no rows" as "every container vanished" — a broken docker
      // CLI would otherwise mark the whole stack `stopped`. Statuses stay
      // frozen until `ps` answers again.
      stdout = await this.composeQuery(args, this.workspaceDir);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] pollStatus failed:`, (err as Error).message);
      return;
    }

    // Parse container info and collect names for IP resolution
    const containerNames = new Map<string, string>();
    const statusUpdates: { name: string; state: string; exitCode: number }[] = [];
    /** Services `ps` returned a row for — the input to the reconcile pass. */
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
      // Recorded before the gate check: a gated service with a container is
      // still "present", and reconciliation must not reason about it at all.
      seen.add(svc.name);

      // Skip gated services — the install gate owns their status. A `ps`
      // reading here (e.g. a container exiting during re-install teardown)
      // must not overwrite the held `starting`/`error`. See docs/137.
      if (this.isGated(svc.name)) continue;

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
    // The same inspect answers "was this container OOM-killed?", which the
    // non-zero-exit branch below needs to tell a real OOM from a plain SIGKILL.
    let oomFlags = new Map<string, boolean>();
    if (containerNames.size > 0) {
      oomFlags = await this.resolveContainerIps(containerNames);
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
          // error is the manager's call — see `handleNonZeroExit` there. Pass
          // the inspected `State.OOMKilled` so exit 137 can be classified
          // rather than assumed.
          this.onExitedWithError(name, exitCode, oomFlags.get(name));
        }
      } else if (state === "restarting") {
        if (prev !== "starting") this.updateServiceStatus(name, "starting");
      }
    }

    // Reverse pass: services the registry knows about that `ps` never
    // mentioned (SHI-314).
    this.reconcileMissingServices(seen);

    // Self-heal the agent's compose-network attachment on the poll heartbeat
    // (docs/128). Membership-gated inside the hook, so the steady state is a
    // single cheap `network inspect`. Best-effort — never let a heal failure
    // disrupt the poll loop.
    if (this.afterPoll) {
      try {
        await this.afterPoll();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] afterPoll hook failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Reconcile services the registry knows about but `docker compose ps -a`
   * did not return a row for (SHI-314).
   *
   * The forward pass above can only ever react to rows `ps` produced, so a
   * service whose container was *removed* — as opposed to merely exited, which
   * `-a` still reports — produced no update at all and kept whatever status it
   * last had. In practice that is the `"starting"` set by `startService`
   * immediately before `compose up`, and it stuck forever: nothing else in the
   * manager times a `starting` service out. That is not cosmetic — `getServices`
   * only publishes a preview URL for a `running` service, so a pinned service
   * silently costs the preview and the agent's `containerIp`. The usual trigger
   * is a compose reconcile (editing `docker-compose.yml` while the stack is up),
   * which tears the old container down.
   *
   * "No row" resolves to `"stopped"`, not `"error"`: no container exists, and
   * we have no evidence of a failure — `error` would also feed the service into
   * `flushPostInstallRetries`, which is for crashes, not disappearances.
   *
   * Three exclusions keep a healthy service from being flapped to `stopped`:
   *
   *  - **Gated services** (docs/137) are skipped exactly as the forward pass
   *    skips them — the install gate owns their held `starting`/`error`, and a
   *    mid-re-install teardown legitimately removes their containers.
   *  - **A `compose up` in flight** means the service is entitled to have no
   *    container yet, for however long the image takes to build. This is the
   *    real answer to "is it legitimately mid-start?"; a wall-clock grace alone
   *    could never distinguish a five-minute build from a vanished container.
   *  - **Already `stopped`/`error`** services have nothing to reconcile, and
   *    re-emitting their status every poll would be pure noise.
   *
   * The remaining grace window covers only the genuinely brief ambiguity: a
   * container being *recreated* is removed before its replacement is created,
   * so a poll landing in that gap sees no row for a service that is fine.
   */
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
        // Any reason to skip also resets the clock — the grace window must
        // measure one continuous absence, not a sum of unrelated ones.
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
      // The service is not running, whatever it was doing before. Cancel the
      // stable-uptime timers the same way an observed exit would, so a vanished
      // container can't quietly clear the OOM budget it was accruing.
      this.onLeftRunning(svc.name);
      this.updateServiceStatus(svc.name, "stopped");
    }

    // Drop bookkeeping for services that left the registry (e.g. renamed or
    // deleted by a compose reconcile) so the map can't grow unboundedly.
    for (const name of this.missingSince.keys()) {
      if (!known.has(name)) this.missingSince.delete(name);
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
    // `reconcile()` stops the poller, clears the services map and starts over;
    // an absence observed against the *old* registry must not count toward the
    // new one's grace window.
    this.missingSince.clear();
  }

  /**
   * Resolve container IPs via `docker inspect` on each container.
   * Prefers the session network IP, falls back to any available IP.
   *
   * Also harvests each container's `State.OOMKilled` from the same inspect —
   * the authoritative answer to "was this an OOM kill?", which the exit-137
   * classification needs and which `docker compose ps` does not report. Free
   * here: this inspect already runs on every poll. Returns a map keyed by
   * SERVICE name; a service is absent when its inspect failed or the daemon
   * omitted `State`, which the caller treats as "unknown", not "not an OOM".
   */
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
        // Record before the network bail-outs below — an exited container often
        // has no networks left, and that is exactly the case we need the flag for.
        const oomKilled = parsed[0]?.State?.OOMKilled;
        if (typeof oomKilled === "boolean") oomFlags.set(serviceName, oomKilled);
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

    return oomFlags;
  }
}
