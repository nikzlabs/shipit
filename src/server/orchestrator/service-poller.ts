export type ComposeQueryFn = (args: string[], cwd: string) => Promise<string>;

export interface PollerService {
  name: string;
  preview: "auto" | "manual";
  status: "stopped" | "starting" | "running" | "error";
}

/**
 * One container of the project, from whichever source listed it. `networks: undefined` means the
 * source cannot report addresses, so the address has to be inspected for (the `compose ps` source);
 * `exitCode: undefined` means the same for the exit (the Engine API source).
 */
export interface PollerContainer {
  /** Container ID or name: what `inspect` is called with, and how an address is attributed. */
  ref: string;
  service: string | undefined;
  state: string;
  oneOff: boolean;
  networks?: Record<string, string | undefined>;
  exitCode?: number;
}

export interface PollerInspection {
  oomKilled?: boolean;
  exitCode?: number;
  networks?: Record<string, string | undefined>;
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

const EXITED_STATES = new Set(["exited", "dead"]);

/**
 * `ps -a` also lists the containers `docker compose run` leaves. Compose joins a row's labels
 * with unescaped commas, so a value can mimic the label; every Compose container carries it,
 * and a service's own `False` wins.
 */
function isOneOff(labels: unknown): boolean {
  if (typeof labels !== "string") return false;
  const pairs = labels.split(",");
  return pairs.includes("com.docker.compose.oneoff=True") && !pairs.includes("com.docker.compose.oneoff=False");
}

/** The `docker compose ps --format json -a` source: one JSON object per line. */
export function parseComposePs(stdout: string): PollerContainer[] {
  const containers: PollerContainer[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { Service?: string; ID?: string; Name?: string; State?: string; ExitCode?: number; Labels?: unknown };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    containers.push({
      ref: entry.ID ?? entry.Name ?? "",
      service: entry.Service,
      state: entry.State ?? "",
      oneOff: isOneOff(entry.Labels),
      // `ps` reports no address, so every container still needs an inspect for one.
      exitCode: entry.ExitCode ?? 1,
    });
  }
  return containers;
}

export interface ServicePollerOptions {
  sessionId: string;
  workspaceDir: string;
  /** Working directory for its queries; defaults to `workspaceDir`. */
  queryCwd?: () => string;
  composeQuery: ComposeQueryFn;
  /** Zero disables periodic polling, which is what an event-driven session uses. */
  pollIntervalMs: number;
  composeArgs: (...extra: string[]) => string[];
  /** Defaults to the `docker compose ps` source built from `composeQuery`. */
  listContainers?: () => Promise<PollerContainer[]>;
  /** Defaults to `docker inspect` built from `composeQuery`. */
  inspectContainer?: (ref: string) => Promise<PollerInspection>;
  /** Reattaches a container that reports no network; defaults to `docker network connect`. */
  repairNetwork?: (networkName: string, ref: string) => Promise<void>;
  isGated?: (name: string) => boolean;
  getService: (name: string) => PollerService | undefined;
  listServices: () => PollerService[];
  isStartInFlight?: (name: string) => boolean;
  /** Undefined clears the address. */
  setContainerIp: (serviceName: string, ip: string | undefined) => void;
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
function withQueryTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
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
  private readonly queryCwd: () => string;
  private readonly composeQuery: ComposeQueryFn;
  private readonly pollIntervalMs: number;
  private readonly composeArgs: (...extra: string[]) => string[];
  private readonly listContainers: () => Promise<PollerContainer[]>;
  private readonly inspectContainer: (ref: string) => Promise<PollerInspection>;
  private readonly repairNetwork: (networkName: string, ref: string) => Promise<void>;
  private readonly isGated: (name: string) => boolean;
  private readonly getService: (name: string) => PollerService | undefined;
  private readonly listServices: () => PollerService[];
  private readonly isStartInFlight: (name: string) => boolean;
  private readonly setContainerIp: (serviceName: string, ip: string | undefined) => void;
  private readonly updateServiceStatus: ServicePollerOptions["updateServiceStatus"];
  private readonly onRunning: (name: string) => void;
  private readonly onLeftRunning: (name: string) => void;
  private readonly onExitedCleanly: (name: string) => void;
  private readonly onExitedWithError: (name: string, exitCode: number, oomKilled?: boolean) => void;
  private readonly afterPoll?: () => void | Promise<void>;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  private followUpDueAt: number | null = null;
  private requestedFollowUpAt: number | null = null;
  private readonly missingSince = new Map<string, number>();
  private psFailingSince: number | null = null;
  /** The container each service's current address was read from. */
  private readonly addressSource = new Map<string, string>();
  /** Bumped by anything that makes an in-flight listing stale; see `pollOnce`. */
  private generation = 0;
  /**
   * When this poller last published anything, or was invalidated — for judging the age of a listing
   * taken elsewhere. Monotonic, so a wall-clock step backwards cannot make a newer exit look older,
   * and seeded at construction so a replacement manager never accepts its predecessor's slice.
   */
  private lastAppliedAt = monotonicNow();
  /** Orders overlapping listings of this project, whoever started them. */
  private pollSeq = 0;
  private appliedSeq = 0;
  /** Set once the outage sweep has run, so a continuing outage stops re-arming for it. */
  private unreachableSwept = false;

  constructor(opts: ServicePollerOptions) {
    this.sessionId = opts.sessionId;
    this.queryCwd = opts.queryCwd ?? (() => opts.workspaceDir);
    this.composeQuery = (args, cwd) => withQueryTimeout(
      opts.composeQuery(args, cwd),
      `docker ${args[0]} did not answer within ${COMPOSE_QUERY_TIMEOUT_MS}ms`,
    );
    this.pollIntervalMs = opts.pollIntervalMs;
    this.composeArgs = opts.composeArgs;
    this.listContainers = opts.listContainers
      ? () => withQueryTimeout(
          opts.listContainers!(),
          `the container listing did not answer within ${COMPOSE_QUERY_TIMEOUT_MS}ms`,
        )
      : () => this.listViaComposePs();
    this.inspectContainer = opts.inspectContainer
      ? (ref) => withQueryTimeout(
          opts.inspectContainer!(ref),
          `inspect of ${ref} did not answer within ${COMPOSE_QUERY_TIMEOUT_MS}ms`,
        )
      : (ref) => this.inspectViaCli(ref);
    // Bounded like every other Docker call: this one is awaited inside a refresh, and the
    // host-wide backstop reconciles sessions in turn, so a hung repair would stall them all.
    const repair = opts.repairNetwork
      ?? (async (networkName: string, ref: string) => {
        await this.composeQuery(["network", "connect", networkName, ref], this.queryCwd());
      });
    this.repairNetwork = (networkName, ref) => withQueryTimeout(
      repair(networkName, ref),
      `attaching ${ref} to ${networkName} did not complete within ${COMPOSE_QUERY_TIMEOUT_MS}ms`,
    );
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

  private async listViaComposePs(): Promise<PollerContainer[]> {
    const args = this.composeArgs("ps", "--format", "json", "-a");
    return parseComposePs(await this.composeQuery(args, this.queryCwd()));
  }

  private async inspectViaCli(ref: string): Promise<PollerInspection> {
    const stdout = await this.composeQuery(["inspect", ref], this.queryCwd());
    const parsed = JSON.parse(stdout) as {
      State?: { OOMKilled?: boolean; ExitCode?: number };
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
    }[];
    const state = parsed[0]?.State;
    const nets = parsed[0]?.NetworkSettings?.Networks;
    return {
      ...(typeof state?.OOMKilled === "boolean" ? { oomKilled: state.OOMKilled } : {}),
      ...(typeof state?.ExitCode === "number" ? { exitCode: state.ExitCode } : {}),
      // An inspect always knows the networks: no `Networks` at all means none, not unknown.
      networks: nets ? mapAddresses(nets) : {},
    };
  }

  private get networkName(): string {
    return `shipit-session-${this.sessionId}`;
  }

  /**
   * `listed` is a slice of a listing already taken for the whole host (the docs/332 backstop), so
   * that reconciling every session costs one Engine API call rather than one per session. An empty
   * slice is a real answer — no containers — unlike a failed listing.
   */
  async pollOnce(listed?: PollerContainer[], takenAt?: number): Promise<void> {
    // A listing describes the moment it was taken. Anything that changes service state while this
    // one is in flight — a `die` event, a stop — makes it stale, and applying it anyway would
    // republish a dead container as running and cancel the recovery that event just scheduled.
    const generation = this.generation;
    const seq = ++this.pollSeq;
    let containers: PollerContainer[];
    if (listed) {
      // A SHARED listing was taken before this call and the backstop reconciles sessions in turn,
      // so its own age is what counts — the generation at entry is already too late to see an
      // invalidation that happened while earlier sessions were being reconciled.
      if (takenAt !== undefined && takenAt <= this.lastAppliedAt) {
        console.log(
          `[compose:${this.sessionId}] discarding a shared listing older than what is already applied`,
        );
        return;
      }
      containers = listed;
    } else {
      try {
        containers = await this.listContainers();
      } catch (err) {
        console.warn(`[compose:${this.sessionId}] pollStatus failed:`, (err as Error).message);
        if (this.generation !== generation || this.appliedSeq > seq) return;
        // Query failure is not an empty container list; expire only sustained stale claims.
        this.expireUnconfirmedStatuses();
        this.armFollowUp();
        return;
      }
    }

    const statusUpdates: { name: string; state: string; container: PollerContainer }[] = [];
    const seen = new Set<string>();

    for (const container of containers) {
      if (container.oneOff) continue;
      const svc = container.service ? this.getService(container.service) : undefined;
      if (!svc) continue;
      if (!INCONCLUSIVE_CONTAINER_STATES.has(container.state)) seen.add(svc.name);

      // The install gate owns held service statuses.
      if (this.isGated(svc.name)) continue;

      statusUpdates.push({ name: svc.name, state: container.state, container });
    }

    // Reads and inspects only: nothing is published before the staleness check below.
    const resolved = statusUpdates.length > 0
      ? await this.resolveContainers(statusUpdates)
      : {
          addresses: new Map<string, string | undefined>(),
          details: new Map<string, PollerInspection>(),
          sources: new Map<string, string>(),
        };

    if (this.generation !== generation) {
      console.log(
        `[compose:${this.sessionId}] discarding a listing overtaken by a newer exit or a stop`,
      );
      return;
    }
    // A later-started listing has already published; this one describes an older moment. Follow-ups
    // and the manager's own post-`up` refreshes call in directly, so ordering cannot live in the
    // caller that happens to coalesce.
    if (this.appliedSeq > seq) {
      console.log(`[compose:${this.sessionId}] discarding a listing a newer one already superseded`);
      return;
    }
    this.appliedSeq = seq;
    this.lastAppliedAt = monotonicNow();
    this.psFailingSince = null;
    // Reset with the clock it guards, or a LATER outage would never arm its sweep at all.
    this.unreachableSwept = false;

    for (const [name, ip] of resolved.addresses) {
      const source = resolved.sources.get(name);
      if (source) this.addressSource.set(name, source);
      else this.addressSource.delete(name);
      this.setContainerIp(name, ip);
    }

    for (const { name, state, container } of statusUpdates) {
      const svc = this.getService(name);
      if (!svc) continue;
      const prev = svc.status;
      if (state === "running") {
        this.onRunning(name);
        if (prev !== "running") this.updateServiceStatus(name, "running");
      } else if (EXITED_STATES.has(state)) {
        const info = resolved.details.get(container.ref);
        const exitCode = container.exitCode ?? info?.exitCode ?? 1;
        this.applyExit(name, exitCode, info?.oomKilled);
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

    if (this.generation !== generation) return;
    this.armFollowUp();
  }

  /**
   * A service container's exit, from the Docker event that reported it. The event is the only
   * source for the exit code and the OOM flag: a listing carries neither, and a container with a
   * restart policy is replaced before any listing could observe that it exited at all.
   *
   * The caller follows this with a refresh. That refresh is NEWER, so if Docker has already
   * restarted the container its verdict wins and supersedes what this scheduled — which is correct,
   * because the service really is up again.
   */
  applyServiceExit(serviceName: string, info: { exitCode: number; oomKilled?: boolean }): void {
    if (!this.getService(serviceName)) return;
    if (this.isGated(serviceName)) return;
    // Invalidate every listing already in flight, and every shared one already taken: each
    // described the container as it was before this exit.
    this.invalidate();
    this.applyExit(serviceName, info.exitCode, info.oomKilled);
    this.armFollowUp();
  }

  /** A listing taken for this project elsewhere failed; the outage clock still has to run. */
  noteListingFailed(): void {
    this.expireUnconfirmedStatuses();
    this.armFollowUp();
  }

  private invalidate(): void {
    this.generation++;
    this.lastAppliedAt = monotonicNow();
  }

  private applyExit(name: string, exitCode: number, oomKilled?: boolean): void {
    const prev = this.getService(name)?.status;
    this.onLeftRunning(name);
    if (exitCode === 0) {
      this.onExitedCleanly(name);
      if (prev !== "stopped") this.updateServiceStatus(name, "stopped");
      return;
    }
    this.onExitedWithError(name, exitCode, oomKilled);
  }

  private expireUnconfirmedStatuses(): void {
    const now = Date.now();
    if (this.psFailingSince === null) {
      this.psFailingSince = now;
      return;
    }
    if (now - this.psFailingSince < DOCKER_UNREACHABLE_GRACE_MS) return;
    this.unreachableSwept = true;

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

  /**
   * The missing-container and docker-unreachable rules each need a SECOND look once their grace
   * window has passed, and no Docker event announces a container that is merely still absent. A
   * cadence used to supply that look; now one refresh is armed per pending condition, so a healthy
   * session holds no timer at all.
   */
  requestFollowUp(delayMs: number): void {
    const at = Date.now() + Math.max(delayMs, 0);
    if (this.requestedFollowUpAt !== null && this.requestedFollowUpAt <= at) return;
    this.requestedFollowUpAt = at;
    this.armFollowUp();
  }

  private armFollowUp(): void {
    const deadlines: number[] = [];
    if (this.psFailingSince === null) {
      for (const since of this.missingSince.values()) deadlines.push(since + MISSING_CONTAINER_GRACE_MS);
    } else if (!this.unreachableSwept) {
      // While listings are failing, only the outage clock can decide anything: a failed listing
      // never reconciles, so a missing-container deadline already in the past would re-arm on
      // every attempt — at the 250ms floor, which is a spin. And once the sweep has run, even
      // this clock is spent; recovery arrives with the next event or the host-wide backstop.
      deadlines.push(this.psFailingSince + DOCKER_UNREACHABLE_GRACE_MS);
    }
    // A request outlives its arming: it is cleared when it fires, never by a later unrelated arm.
    if (this.requestedFollowUpAt !== null) deadlines.push(this.requestedFollowUpAt);

    if (deadlines.length === 0) {
      this.clearFollowUp();
      return;
    }
    this.armFollowUpAt(Math.min(...deadlines));
  }

  private armFollowUpAt(at: number): void {
    if (this.followUpTimer && this.followUpDueAt !== null && this.followUpDueAt <= at) return;
    this.clearFollowUp();
    this.followUpDueAt = at;
    // A grace window that has already passed still needs one turn of the loop, never a tight spin.
    const timer = setTimeout(() => {
      this.followUpTimer = null;
      this.followUpDueAt = null;
      if (this.requestedFollowUpAt !== null && this.requestedFollowUpAt <= Date.now()) {
        this.requestedFollowUpAt = null;
      }
      this.pollOnce().catch((err: unknown) => {
        console.warn(`[compose:${this.sessionId}] follow-up poll error:`, (err as Error).message);
      });
    }, Math.max(at - Date.now(), 250));
    timer.unref?.();
    this.followUpTimer = timer;
  }

  private clearFollowUp(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    this.followUpDueAt = null;
  }

  /**
   * Arms the optional interval only. It must NOT discard pending state: `ServiceManager.start()`
   * calls this AFTER its own refresh, so wiping the outage clocks here would silently retire the
   * follow-up that refresh had just armed, and no cadence remains to set it again.
   */
  start(): void {
    this.clearPollInterval();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err: unknown) => {
        console.warn(`[compose:${this.sessionId}] periodic poll error:`, (err as Error).message);
      });
    }, this.pollIntervalMs);
  }

  private clearPollInterval(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop(): void {
    this.clearPollInterval();
    this.clearFollowUp();
    this.requestedFollowUpAt = null;
    // A listing already in flight described a stack this manager no longer owns.
    this.invalidate();
    // Reconcile replaces the registry; its old outage clocks must not carry over.
    this.missingSince.clear();
    this.psFailingSince = null;
    this.unreachableSwept = false;
  }

  /**
   * Addresses and exits for the listed containers, resolved WITHOUT publishing any of them: the
   * caller checks for a newer exit or a stop first (`pollOnce`). A source that reports addresses
   * itself (the Engine API) spares every running container an `inspect`, which is where this
   * poller's measured CPU went; an exit still needs one, for what the listing omits.
   */
  private async resolveContainers(
    listed: { name: string; state: string; container: PollerContainer }[],
  ): Promise<{
    addresses: Map<string, string | undefined>;
    details: Map<string, PollerInspection>;
    /** The container each resolved address was read from, for `addressSource`. */
    sources: Map<string, string>;
  }> {
    const details = new Map<string, PollerInspection>();
    const found = new Map<string, string>();
    const unread = new Set<string>();
    const services = new Set<string>();
    const sources = new Map<string, string>();

    for (const { name, state, container } of listed) {
      if (!container.ref) continue;
      services.add(name);
      const exited = EXITED_STATES.has(state);
      let networks = container.networks;
      let info: PollerInspection | undefined;

      // Exit 137 is the only code whose meaning depends on the OOM flag (docs/239).
      const needsExit = exited
        && (container.exitCode === undefined || container.exitCode === 137);
      if (networks === undefined || needsExit) {
        try {
          info = await this.inspectContainer(container.ref);
          if (info.networks !== undefined) networks = info.networks;
        } catch (err) {
          console.warn(`[compose:${this.sessionId}] docker inspect ${container.ref} failed:`, (err as Error).message);
          if (this.addressSource.get(name) === container.ref) unread.add(name);
          continue;
        }
      }
      if (info) details.set(container.ref, info);

      // A running container outside the session network cannot be reached by the preview proxy.
      if (!exited && networks !== undefined && !networks[this.networkName]) {
        networks = await this.reattach(container.ref, networks);
      }

      const ip = networks?.[this.networkName];
      if (ip && !found.has(name)) {
        found.set(name, ip);
        sources.set(name, container.ref);
      }
    }

    // One service can have several containers (replicas), so decide per service.
    const addresses = new Map<string, string | undefined>();
    for (const name of services) {
      const ip = found.get(name);
      // A container that could not be read keeps its address; a replacement does not inherit it.
      if (ip || !unread.has(name)) addresses.set(name, ip);
    }

    return { addresses, details, sources };
  }

  private async reattach(
    ref: string,
    networks: Record<string, string | undefined>,
  ): Promise<Record<string, string | undefined>> {
    // Only repair a container with no networks at all; one on another network is not ours to move.
    if (Object.keys(networks).length > 0) return networks;
    try {
      await this.repairNetwork(this.networkName, ref);
      const after = await this.inspectContainer(ref);
      return after.networks ?? networks;
    } catch {
      // Network repair is best effort.
      return networks;
    }
  }
}

/** Monotonic within the process, unlike `Date.now()`, which can step backwards. */
export function monotonicNow(): number {
  return performance.now();
}

function mapAddresses(
  nets: Record<string, { IPAddress?: string }>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, settings] of Object.entries(nets)) out[name] = settings?.IPAddress;
  return out;
}
