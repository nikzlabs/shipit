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
import { killChild } from "../shared/kill-child.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import type { LogStore } from "./log-store.js";
import {
  parseComposeFile,
  parseUserNamedVolumes,
  generateComposeOverride,
  writeComposeOverride,
  type ComposeOverrideOptions,
  type ComposeService,
  type OverlayDepDirVolume,
} from "./compose-generator.js";
import { COMPOSE_OVERRIDE_FILE, sessionStateDirForWorkspace } from "./session-state-dir.js";
import {
  ServiceSecretsResolver,
  type SecretsStatusInternalSnapshot,
  type DockerSecretsConfig,
} from "./service-secrets-resolver.js";
import { ServicePoller } from "./service-poller.js";
import { ServiceRetryManager } from "./service-retry-manager.js";
import { removeSessionServiceEnvDir, removeSessionSecretsDir } from "./secret-resolver.js";
import {
  ComposeCli,
  type ComposeRunner,
  type ComposeQuery,
  type ComposeOutputSink,
} from "./compose-cli.js";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface tests / consumers import from
// here. `SecretsStatusInternalSnapshot` is consumed by ContainerSessionRunner
// and the test file via this module; the simpler `SecretsStatusSnapshot`
// type stays exported for external consumers that only need the public
// shape (no agent values). `ComposeRunner`/`ComposeQuery` now live in
// `compose-cli.ts` (docs/201 P8) but stay re-exported here — the test file
// and other consumers import them from this module.
// ---------------------------------------------------------------------------

export type {
  SecretsStatusSnapshot,
  SecretsStatusInternalSnapshot,
} from "./service-secrets-resolver.js";

export type { ComposeRunner, ComposeQuery, ComposeOutputSink } from "./compose-cli.js";

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
  /**
   * Whether this service is gated on `agent.install` completing before it
   * starts (`x-shipit-depends-on-install`). Defaults to `true` for
   * `auto`-preview services. See docs/137-depends-on-install.
   */
  dependsOnInstall: boolean;
  /** Container IP on the session network (populated by status polling). */
  containerIp?: string;
  /**
   * Direct, agent-reachable URL for this service's dev server
   * (`http://<containerIp>:<port>/`). Populated by {@link getServices} whenever
   * the service has a live container address — its IP and port are both known
   * and it has not been observed `stopped`/`error`.
   *
   * Deliberately NOT gated on `status === "running"` (#2044). The address is a
   * fact about the container, and the readiness verdict is a separate question
   * the poller answers a beat later — so gating on it meant a service that was
   * demonstrably serving but still reported `starting` published no address at
   * all, and the agent had no supported way to reach a service it had just
   * started successfully. A `starting` service's URL may not answer yet; that
   * is strictly better than no URL, because "connection refused, retry" is a
   * recoverable state and "no address exists" is not.
   *
   * This is the address the agent's own tooling — `curl` and the in-container
   * Playwright browser — should hit to reach the live preview. docs/172 Gap 1
   * (planning#92) opens the agent's egress to its session subnet so this IP is
   * routable from the agent's netns. It is deliberately NOT the user's
   * Preview-tab origin, which is the orchestrator's `{sessionId}--{port}.<host>`
   * subdomain proxy and does not resolve from inside the agent container. See
   * GH #1509.
   */
  url?: string;
}

/**
 * Message used when a gated service can't start because `agent.install`
 * failed. Surfaces the real cause instead of the downstream symptom
 * (`vite: not found`, exit 127, etc.).
 */
export const INSTALL_FAILED_GATE_MESSAGE =
  "agent.install failed — dependent service not started";

/**
 * Prefix on every line of `docker compose up` output relayed into a service's
 * log stream, so the image build / pull phase reads as what it is rather than
 * as output from the user's own container.
 *
 * Why this exists at all: `startService` writes `starting`, then awaits
 * `docker compose up -d --build`, and only spawns the log follower once that
 * returns. With a warm layer cache the `up` takes ~2s and nobody notices. With
 * a cold one — a fresh host, or any deploy that pruned the BuildKit cache — it
 * is a full image build, and this repo's own dogfood `dev` service (apt-get +
 * agent CLIs + a Playwright Chromium) takes minutes. For that whole window the
 * service sat at `starting` with an EMPTY log panel and no diagnostic anywhere:
 * the runner collected stderr into a local string and dropped it on success,
 * the follower had no container to follow, and `withUpInFlight` correctly
 * exempts an in-flight `up` from both the missing-container reconciliation and
 * the {@link STARTING_WATCHDOG_MS} watchdog — so nothing ever spoke. The user
 * reads that as "Start does nothing", stops, and starts again, which appears to
 * work because the first build has meanwhile warmed the cache.
 */
export const COMPOSE_LOG_PREFIX = "[compose] ";

/**
 * Longest run of compose output the line-buffering sink holds without seeing a
 * newline before it emits anyway. Bounds the one buffer that lives OUTSIDE
 * `MAX_LOG_BUFFER`'s cap; well above any real progress line.
 */
export const MAX_COMPOSE_LOG_LINE = 8_000;

/**
 * How long {@link ServiceManager.joinSessionNetwork} may block before its
 * callers give up and move on to resolving service status (#2044).
 *
 * Generous enough that a healthy join — a dockerode `network connect` plus the
 * short-lived egress sidecar — always completes inside it, and short enough
 * that a wedged one costs a service one poll interval of unknown status rather
 * than the rest of the session.
 */
export const NETWORK_JOIN_TIMEOUT_MS = 30_000;

/**
 * How long a service may sit in `starting` — with nothing legitimately holding
 * it there — before the manager gives up and reports it as an error (#2044).
 *
 * `starting` is written optimistically by `startService`/`restartService` and by
 * the gate, and every mechanism that *clears* it runs downstream of a successful
 * `docker compose ps`: the poller's forward pass and its missing-container
 * reconciliation both need `ps` to answer. So anything that stops the poll loop
 * — a `ps` that fails every time, a `reconcile()` whose `start()` never reached
 * `poller.start()`, a wedged call sequenced ahead of `pollOnce()` — pinned the
 * service at `starting` forever, with no address and no diagnostic anywhere the
 * user or the agent could see. This is the backstop for that whole class: it is
 * driven by its own timer, so it holds even when the poll loop does not.
 *
 * Two exemptions keep it from firing on a service that is legitimately still
 * coming up, and they are the same two the poller's reconciliation uses: a
 * `docker compose up` in flight (an image build has no bound) and the install
 * gate (docs/137). Both re-arm the watchdog rather than cancelling it, so a
 * service that is still stuck once they clear is still caught.
 */
export const STARTING_WATCHDOG_MS = 120_000;

/**
 * Reason recorded on a service the {@link STARTING_WATCHDOG_MS} watchdog gives
 * up on. Written to `ManagedService.error`, so it reaches the services drawer,
 * `shipit service list`, and `GET /api/sessions/:id/services`.
 *
 * Deliberately says the container may in fact be running: the watchdog fires on
 * "readiness was never confirmed", not on "the service failed", and telling the
 * user their service is dead when it is serving requests would send them
 * debugging the wrong thing. It also has to be true for the other way in: a
 * container looping in Docker's `restarting` state is reported as `starting`
 * too, and there the probe is answering perfectly well.
 */
export const STARTING_TIMEOUT_MESSAGE =
  `Stuck in "starting" for over ${Math.round(STARTING_WATCHDOG_MS / 1000)}s with no compose up ` +
  "in flight — readiness was never confirmed. The service may in fact be running, or its " +
  "container may be stuck in a restart loop: check `shipit service logs <name>`, then restart " +
  "the service to re-probe.";

/**
 * How long a `docker compose up` may produce NO output at all while a service
 * waits on it, before the manager stops treating it as a reason to keep the
 * service at `starting` (docs/121, requirement 2).
 *
 * The exemption {@link ServiceManager.withUpInFlight} grants an in-flight `up`
 * is correct and stays: an image build has no time limit, and requirement 2's
 * non-requirements say so explicitly. But the exemption was unconditional, so a
 * `docker compose up` that never returns — a wedged daemon, a dead socket proxy,
 * a `docker` process that outlives its connection — re-armed the
 * {@link STARTING_WATCHDOG_MS} watchdog forever and pinned the service at
 * `starting` for the rest of the session with no diagnostic anywhere.
 *
 * The bound is therefore on SILENCE, not on elapsed time. Requirement 2 asks
 * that a service be "making progress the user can see, or reported as failed",
 * and since PR #2121 the `up`'s own output is exactly that visible progress: it
 * streams into the service's log panel through {@link ServiceManager.composeLogSink}.
 * A ten-minute build that keeps printing keeps its exemption indefinitely; a
 * build that has said nothing at all for this long is not one the user can watch.
 *
 * Chosen well above the quietest stretch a real build produces — a single silent
 * `RUN npm install …` layer — because the cost of being wrong is a service
 * reported as failed while it is in fact still building. That error is not
 * terminal: the `up` is never cancelled, and the poll that follows its success
 * restores `running`.
 */
export const UP_SILENCE_TIMEOUT_MS = 300_000;

/**
 * Reason recorded on a service whose `docker compose up` went silent for
 * {@link UP_SILENCE_TIMEOUT_MS}. Names the command as the thing that stalled,
 * because that is the actionable fact — the service's own container may not
 * exist yet — and, like {@link STARTING_TIMEOUT_MESSAGE}, does not claim more
 * than we observed.
 */
export const UP_STALLED_MESSAGE =
  `\`docker compose up\` has produced no output for over ${Math.round(UP_SILENCE_TIMEOUT_MS / 60_000)} minutes ` +
  "and has not returned — Docker may be unresponsive. The command has not been cancelled, so a build that is " +
  "merely slow will still finish and the service will recover on its own; check `shipit service logs <name>` " +
  "for build output, or restart the service to retry.";

/**
 * Reject-after-`ms` wrapper. The underlying promise is NOT cancelled (nothing in
 * the Docker paths this guards is cancellable) — the caller simply stops waiting
 * on it, which is the whole point: a best-effort step must not hold up the work
 * sequenced behind it.
 */
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
  /**
   * docs/128 — server-authoritative ops session flag. Allows the hidden ops
   * template's docker-socket-proxy service to mount the host Docker socket even
   * though ordinary sessions cannot enable that by copying workspace files.
   */
  opsSession?: boolean;
  /** Called during start() to join the agent container to the compose network. */
  networkJoinFn?: (networkName: string) => Promise<void>;
  /**
   * docs/128 — periodic self-heal: re-attach the agent container to the compose
   * network if a network/bridge recreate (e.g. the ops `docker-socket-proxy`
   * restarting under its `restart: unless-stopped` policy) stranded it on a dead
   * bridge. Invoked on the poll heartbeat and membership-gated inside the hook,
   * so it's a cheap `network inspect` no-op while the agent is correctly
   * attached. Omitted in tests / non-container setups.
   */
  networkHealFn?: (networkName: string) => Promise<void>;
  /** Apply fail-closed egress containment to newly started/recreated services. */
  containServicesFn?: (serviceNames: string[]) => Promise<void>;
  /** Tier B is active, so generated services use its loopback DNS upstream. */
  containServiceDns?: boolean;
  /** Tier C is active for contained services. */
  containServiceProxy?: boolean;
  /** Detach stale NAT endpoints before Compose starts stopped containers. */
  prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
  /** Recreate a reused session network when its internal mode is stale. */
  ensureSessionNetworkModeFn?: (internal: boolean) => Promise<void>;
  /**
   * Loads user-saved secrets for the session's repo (from SecretStore).
   *
   * Called once before each compose start/reconcile so secret values reach
   * compose services via per-service env files.
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
   * collision) before the session state dir's `.env.agent` is written and
   * pushed to the worker. Synchronous — `CredentialStore` is an in-memory JSON store.
   */
  accountAgentEnvLoader?: () => Record<string, string>;
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
   *     `secrets-entrypoint.sh` baked into the image. Staged into the
   *     Docker-secrets root at compose-start (planning#287) so service containers
   *     can bind-mount it by absolute path.
   *
   * When omitted, the manager falls back to the env-file mode (Phase 1
   * baseline).
   */
  dockerSecretsConfig?: DockerSecretsConfig;
  /**
   * docs/183 — orchestrator-private root for per-service env files, OUTSIDE the
   * session workspace. Unless Docker-secrets mode is on, service env files are
   * written to `<serviceEnvDir>/<sessionId>/.env.<svc>` and the compose override
   * references those absolute paths, keeping service-only secrets out of the
   * agent-readable workspace.
   *
   * **Required** (planning#292) — see `ServiceSecretsResolverOptions.serviceEnvDir`
   * for why the optional form had to go. The root must resolve outside
   * `workspaceDir` or the write throws.
   */
  serviceEnvDir: string;
  /**
   * docs/183 Phase 5 — per-session overlay dep-dir volumes for an overlay-eligible
   * session. Forwarded into `generateComposeOverride` so services that share the
   * workspace also mount the same dep-dir overlay volumes nested at
   * `<service-target>/<dep-dir>`. Resolved lazily via {@link setOverlayDepDirs}
   * (the populator is async), so the constructor value is just the initial seed.
   * Empty/absent → no overlay mounts.
   */
  overlayDepDirs?: OverlayDepDirVolume[];
  /**
   * docs/192 — durable per-session log store. When set, streamed service logs
   * are persisted here (channel `service:<name>`) so the panel can replay full
   * history after orchestrator restart / idle eviction / container destruction,
   * none of which the in-memory `logBuffers` ring survives. Omit for tests /
   * setups that don't need durability.
   */
  logStore?: LogStore;
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
  private composeConfig: ComposeConfig;

  private static readonly MAX_LOG_BUFFER = 80_000;
  /**
   * Byte cap for an on-demand {@link snapshotLogs} backlog. Larger than the
   * live ring buffer (which only needs to cover the reconnect window) because
   * this is the full history shown on panel open; bounded so a chatty service
   * can't push megabytes over the WS in one `service_log_buffer` message.
   */
  private static readonly MAX_LOG_SNAPSHOT = 500_000;

  private services = new Map<string, ManagedService>();
  private logProcesses = new Map<string, ChildProcess>();
  private logBuffers = new Map<string, string>();
  private readonly logStore?: LogStore;
  private _started = false;
  /** docs/201 P8 — owns `docker compose` command construction + execution. */
  private readonly compose: ComposeCli;
  private readonly workspaceVolume?: string;
  private readonly workspaceSubpath?: string;
  /** docs/183 Phase 5 — per-session overlay dep-dir volumes (set lazily; see setOverlayDepDirs). */
  private overlayDepDirs: OverlayDepDirVolume[];
  private readonly stackName?: string;
  private readonly opsSession: boolean;
  private readonly networkJoinFn?: (networkName: string) => Promise<void>;
  /** docs/128 — periodic agent network-attachment self-heal (see options). */
  private readonly networkHealFn?: (networkName: string) => Promise<void>;
  private containServicesFn?: (serviceNames: string[]) => Promise<void>;
  private containServiceDns: boolean;
  private containServiceProxy: boolean;
  private readonly ensureSessionNetworkModeFn?: (internal: boolean) => Promise<void>;
  private prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>;
  /** docs/183 — external service-env root, for teardown cleanup. */
  private readonly serviceEnvDir: string;
  /**
   * docs/246 — where the generated compose override is written: the session's
   * state dir, always outside the clone.
   */
  private readonly overrideDir: string;
  /**
   * docs/087 Phase 1 follow-up — Docker-secrets orchestrator-internal root, for
   * teardown cleanup. The same `<internalDir>/<sessionId>/` directory
   * `writeIsolatedSecretFiles()` writes per-secret plaintext files into; dropped
   * on `stop({ removeVolumes: true })` so they don't outlive the session.
   */
  private readonly secretsInternalDir?: string;

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

  /**
   * Whether the most recently completed install attempt failed. Combined
   * with `_installRunning`, this is the install gate: it is open only when
   * no install is in flight AND the last attempt (if any) succeeded. While
   * the gate is closed, `dependsOnInstall` services are held — never started,
   * or latched to `error` if install failed. See docs/137-depends-on-install.
   */
  private _installFailed = false;

  /**
   * Names of `dependsOnInstall` services currently held by the gate (either
   * waiting for install to finish, or latched to `error` after install
   * failed). The poller skips these so its `docker compose ps` diff can't
   * clobber the held `starting`/`error` status, and `handleNonZeroExit`
   * ignores their exits (e.g. during mid-session re-install teardown).
   */
  private gatedServices = new Set<string>();

  /**
   * Names of gated services that have just been released by the gate and are
   * within their first-boot recovery window. A crash here (e.g. the install
   * gate opened before `node_modules/.bin` was on disk — exit 127) is owned by
   * the bounded post-gate retry in {@link handleNonZeroExit} instead of
   * latching straight to `error`. A service leaves the set the moment it
   * reaches `running` (first boot succeeded), exhausts its retry budget, or is
   * re-held for a mid-session re-install. See docs/137-depends-on-install.
   */
  private postGateServices = new Set<string>();

  /**
   * Services with a `docker compose up` currently in flight, reference-counted
   * by overlapping calls (a user-initiated start can race a retry attempt for
   * the same service). Read by the poller's missing-container reconciliation
   * (planning#316): a service being brought up legitimately has no container yet —
   * for minutes, if an image is building — and must not be reconciled to
   * `stopped` in that window. Always mutated via {@link withUpInFlight} so the
   * count is released even when compose throws.
   */
  private upInFlight = new Map<string, number>();

  /**
   * `Date.now()` of the last output byte the in-flight `docker compose up`
   * produced for a service — seeded when the exemption is taken, refreshed by
   * {@link composeLogSink}. Read only by {@link onStartingWatchdogFired}, to
   * tell a build that is working from one that has stopped talking. See
   * {@link UP_SILENCE_TIMEOUT_MS}.
   */
  private upLastOutputAt = new Map<string, number>();

  /**
   * Settlements of the `docker compose up` calls currently in flight for a
   * service — resolved (never rejected) so a waiter can sequence itself after
   * them without inheriting their failures. {@link stopService} is the waiter: a
   * stop issued while an `up` is running has to outlive that `up`, or compose
   * brings the container back after the user asked for it to be gone
   * (requirement 5).
   *
   * A SET per service, for the same reason {@link upInFlight} is
   * reference-counted rather than a boolean: overlapping calls for one service
   * are expected (a user-initiated start racing a retry attempt). Holding only
   * the latest promise would let the shorter call's completion retire the
   * entry while the longer one is still running, and a stop arriving after
   * that would see nothing to wait for.
   */
  private upSettled = new Map<string, Set<Promise<void>>>();

  /**
   * Services the user explicitly stopped, and which nothing has deliberately
   * started since (requirement 5 — "the user's last instruction is the one that
   * holds").
   *
   * Two mechanisms read it. The automatic restart paths refuse to bring a
   * service in this set back up, so a retry timer that was already in flight
   * cannot undo the stop. And {@link handleNonZeroExit} ignores its exits: our
   * own `docker compose stop` SIGTERMs the container and SIGKILLs it when the
   * 10s grace expires, so a service that doesn't forward SIGTERM exits 143/137
   * — which, taken at face value, walked a service the user had just stopped
   * to `error` (and, for a `preview: auto` service, into the retry paths) on
   * the very next poll.
   *
   * Cleared by every deliberate start — `startService`, `restartService`,
   * `start()`, and the install gate's release — so it only ever suppresses the
   * window between a stop and the next explicit instruction.
   */
  private stoppedByUser = new Set<string>();

  /**
   * Per-service `starting` watchdog timers (#2044). Armed whenever a service
   * enters `starting`, cancelled the moment it leaves. See
   * {@link STARTING_WATCHDOG_MS} for why this exists and why it runs off its
   * own timer rather than off the poll loop.
   */
  private readonly startingWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * In-flight `docker compose stop` for a mid-session re-install teardown, or
   * `null`. The gate-open path awaits it before releasing gated services so the
   * teardown's own SIGKILL is still observed while the service is gated — and
   * is therefore swallowed by the existing gated guards instead of being
   * reported to the user as a crash. See `releaseInstallGate` (docs/239).
   */
  private _gatedTeardown: Promise<void> | null = null;

  constructor(opts: ServiceManagerOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.workspaceDir = opts.workspaceDir;
    this.composeConfig = opts.composeConfig;
    // docs/246 — the override lives in the session's state dir, outside the
    // clone, so the post-turn `git add -A` can never stage it into the user's
    // repository. Derived from the clone path via the one contract every side
    // of the feature shares; a clone that isn't `<sessionDir>/workspace` throws
    // rather than falling back into the clone (planning#288).
    this.overrideDir = sessionStateDirForWorkspace(opts.workspaceDir);
    this.compose = new ComposeCli({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      composeFile: opts.composeConfig.file,
      overrideFile: path.join(this.overrideDir, COMPOSE_OVERRIDE_FILE),
      ...(opts.composeRunner ? { composeRunner: opts.composeRunner } : {}),
      ...(opts.composeQuery ? { composeQuery: opts.composeQuery } : {}),
    });
    this.workspaceVolume = opts.workspaceVolume;
    this.workspaceSubpath = opts.workspaceSubpath;
    this.overlayDepDirs = opts.overlayDepDirs ?? [];
    this.stackName = opts.stackName;
    this.opsSession = opts.opsSession ?? false;
    this.networkJoinFn = opts.networkJoinFn;
    this.networkHealFn = opts.networkHealFn;
    this.containServicesFn = opts.containServicesFn;
    this.containServiceDns = opts.containServiceDns ?? false;
    this.containServiceProxy = opts.containServiceProxy ?? false;
    this.ensureSessionNetworkModeFn = opts.ensureSessionNetworkModeFn;
    this.prepareContainedStartFn = opts.prepareContainedStartFn;
    this.serviceEnvDir = opts.serviceEnvDir;
    this.secretsInternalDir = opts.dockerSecretsConfig?.internalDir;
    this.logStore = opts.logStore;

    this.secrets = new ServiceSecretsResolver({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      ...(opts.secretsLoader ? { secretsLoader: opts.secretsLoader } : {}),
      ...(opts.accountAgentEnvLoader ? { accountAgentEnvLoader: opts.accountAgentEnvLoader } : {}),
      ...(opts.dockerSecretsConfig ? { dockerSecretsConfig: opts.dockerSecretsConfig } : {}),
      serviceEnvDir: opts.serviceEnvDir,
      onSnapshot: (snapshot) => this.emit("secrets_status", snapshot),
      // docs/184: relay the now-unhonored `source: platform:*` notice into the
      // service's log stream so it surfaces in the same place as its output.
      onPlatformSourceWarning: (serviceName, text) => this.emit("service_log", serviceName, text),
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
      composeQuery: this.compose.query,
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      composeArgs: (...extra) => this.compose.args(...extra),
      isGated: (name) => this.gatedServices.has(name),
      getService: (name) => this.services.get(name),
      listServices: () => [...this.services.values()],
      isStartInFlight: (name) => this.upInFlight.has(name),
      setContainerIp: (name, ip) => {
        const svc = this.services.get(name);
        if (svc) svc.containerIp = ip;
      },
      updateServiceStatus: (name, status, error) =>
        this.updateServiceStatus(name, status, error),
      onRunning: (name) => {
        // A service that came back after a recreate is running in a container
        // the log follower knows nothing about, and the follower it had died
        // with the predecessor (docs/121 gap F, requirement 4). This hook is the
        // one place every recovery route converges on — the install-window
        // retry, the OOM retry, the gated batch and a plain manual restart all
        // end at a poll that sees `running` — so re-attaching here covers them
        // all without each path remembering to.
        //
        // Deliberately every `running` poll rather than only the transition
        // into `running`. The follower's death is asynchronous to the poll that
        // observes the replacement: if `close` has not fired yet when the
        // transition lands, a transition-gated check no-ops against a follower
        // that is about to die, and no later transition ever comes — the logs
        // would stay dead for the rest of the session. Re-checking each poll
        // costs a Map lookup in the steady state, because `ensureLogFollower`
        // is a no-op while the follower is alive.
        this.ensureLogFollower(name);
        // Service recovered — clear any pending install-window retry state.
        this.retry.clearRetryState(name);
        // Leave the post-gate recovery window only after the service has been
        // STABLY running, not at the first `running` poll: a
        // `command: sh -c "npm install && npm run dev"` service is `running` a
        // minute before the dev server exists, and a crash in that
        // establishment phase (live: ETXTBSY in the service's own npm install,
        // docs/183 FINDINGS) used to land outside the window and latch to
        // `error` with zero retries. Flapping keeps the bounded attempt
        // budget — the timer is cancelled on every exit, so a crash-loop
        // still exhausts MAX_POST_GATE_RETRIES rather than looping forever.
        if (this.postGateServices.has(name)) {
          this.retry.armPostGateStableClear(name, () => {
            this.postGateServices.delete(name);
          });
        }
        // If a previous OOM kicked off auto-retries, arm a stable-uptime
        // timer that clears the OOM counter once the service has been
        // healthy long enough. We don't clear the counter eagerly: a
        // service that flaps in and out of `running` while OOMing must
        // still hit the cap, otherwise we loop forever.
        this.retry.armOomStableResetIfNeeded(name);
      },
      onLeftRunning: (name) => {
        this.retry.cancelOomStableTimer(name);
        this.retry.cancelPostGateStableTimer(name);
      },
      onExitedCleanly: (name) => {
        this.retry.clearRetryState(name);
        this.retry.clearOomBudget(name);
      },
      onExitedWithError: (name, exitCode, oomKilled) => {
        this.handleNonZeroExit(name, exitCode, oomKilled);
      },
      afterPoll: () => this.healSessionNetwork(),
    });
  }

  /**
   * docs/128 — re-attach the agent container to the compose network if a
   * network/bridge recreate stranded it. Called on the poll heartbeat via the
   * poller's `afterPoll` hook. Membership-gated inside `networkHealFn`, so this
   * is a cheap `network inspect` no-op while the agent is correctly attached.
   * Best-effort: a heal failure is logged and swallowed so it never disrupts
   * the poll loop.
   */
  private async healSessionNetwork(): Promise<void> {
    if (!this.networkHealFn) return;
    const networkName = `shipit-session-${this.sessionId}`;
    try {
      await this.networkHealFn(networkName);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] network heal failed:`, (err as Error).message);
    }
  }

  /**
   * docs/183 Phase 5 — set the per-session overlay dep-dir volumes used when
   * generating the compose override. Resolved lazily by `setupServiceManager`
   * (the populator is async — it inspects the workspace state volume) and set
   * before the first `start()`, so both override-generation paths pick it up.
   * `[]` (the default / flag-off case) leaves the override byte-for-byte unchanged.
   */
  setOverlayDepDirs(overlayDepDirs: OverlayDepDirVolume[]): void {
    this.overlayDepDirs = overlayDepDirs;
  }

  /** Refresh the boot-effective egress policy when a preserved manager is adopted. */
  updateEgressContainment(
    containServicesFn: ((serviceNames: string[]) => Promise<void>) | undefined,
    containServiceDns: boolean,
    containServiceProxy: boolean,
    prepareContainedStartFn?: (serviceNames: string[]) => Promise<void>,
  ): boolean {
    const changed = Boolean(this.containServicesFn) !== Boolean(containServicesFn)
      || this.containServiceDns !== containServiceDns
      || this.containServiceProxy !== containServiceProxy;
    this.containServicesFn = containServicesFn;
    this.containServiceDns = containServiceDns;
    this.containServiceProxy = containServiceProxy;
    this.prepareContainedStartFn = prepareContainedStartFn;
    return changed;
  }

  /**
   * Branching for a non-zero exit. See the original inline pollStatus for
   * the rationale on each branch — preserved verbatim here so the retry
   * paths behave identically.
   *
   * @param oomKilled The container's inspected `State.OOMKilled` (from the
   *   poller), or `undefined` when the inspect couldn't answer. Exit 137 is
   *   SIGKILL, not "OOM" — see the exit-137 branch below.
   */
  private handleNonZeroExit(name: string, exitCode: number, oomKilled?: boolean): void {
    const svc = this.services.get(name);
    if (!svc) return;

    if (this.stoppedByUser.has(name)) {
      // We are looking at our OWN `docker compose stop` landing. It SIGTERMs the
      // container and SIGKILLs it once the 10s grace expires, so a service that
      // doesn't forward SIGTERM exits 143 — or 137, which the branch below reads
      // as a possible OOM. Either way the next poll would walk a service the
      // user deliberately stopped to `error`, and for a `preview: auto` service
      // into a retry that brings it back. The user's stop is the last
      // instruction (requirement 5); this exit is that instruction working.
      //
      // `stopped` rather than a bare return, because this branch is also the
      // only reader of a non-zero exit: a poll that raced the stop and wrote
      // `running` (compose had not killed the container yet) would otherwise
      // keep that claim forever, since every later poll lands right back here.
      // Requirement 3 outranks staying quiet.
      if (svc.status !== "stopped") this.updateServiceStatus(name, "stopped");
      return;
    }

    if (this.gatedServices.has(name)) {
      // Intentionally held by the install gate — either waiting for install
      // or being torn down for a mid-session re-install. Ignore the exit; the
      // gate decides when this service starts. See docs/137-depends-on-install.
      return;
    }

    if (this._installRunning && svc.preview === "auto") {
      // Install is still extracting deps into the bind-mounted workspace.
      // Don't latch to `error` — schedule a retry with backoff so the
      // service can come up once install finishes. Manual services are
      // user-initiated and not retried automatically.
      this.retry.scheduleRetryWhileInstalling(name, exitCode);
      return;
    }

    if (exitCode === 137 && oomKilled === true && svc.preview === "auto") {
      // CONFIRMED OOM kill: 137 (SIGKILL) *and* the container's inspected
      // `State.OOMKilled` says the kernel's cgroup OOM killer did it.
      //
      // The `oomKilled` conjunct is load-bearing, not defensive. 137 alone
      // means "somebody sent SIGKILL", and the most frequent sender in this
      // system is US: `stopGatedForReinstall` runs `docker compose stop`, and a
      // `command: sh -c "npm install && npm run dev"` service never forwards
      // SIGTERM, so the 10s grace period always expires into a SIGKILL. Field
      // report (docs/239): a cached ~35ms re-install looping every 30s produced
      // an exit-137 every cycle with `OOMKilled: false` on a service using
      // 110 MiB of a 3 GiB limit — auto-"OOM"-retried, budget drained, then
      // latched to `error` advising the user to raise a memory limit that was
      // never the problem. An unconfirmed 137 now falls through: inside the
      // post-gate window it lands on the docs/137 recovery path built for
      // exactly "crashed right after the gate opened", and outside it, on the
      // terminal branch with an honest message.
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

    if (this.postGateServices.has(name) && svc.preview === "auto") {
      // Gated service that crashed within its first-boot window after the
      // gate opened. The install-complete signal can lead the dependency
      // tree on warm/reused fast-install paths, so retry with backoff
      // instead of latching to `error` — nothing else owns this crash now
      // that the gate is closed and the service is no longer gated. Bounded:
      // a `false` return means the budget is exhausted, so fall through to
      // the terminal `error` below with the real exit message.
      if (this.retry.schedulePostGateRetry(name)) return;
      this.postGateServices.delete(name);
    }

    this.updateServiceStatus(name, "error", describeExit(exitCode, oomKilled));
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
   * This drives two mechanisms:
   *
   *   1. **The declarative install gate** (docs/137) — services that declare
   *      `x-shipit-depends-on-install` (the default for `auto` preview) are
   *      held until install finishes, then started exactly once. On
   *      `true → false` with a successful install they start in one batched
   *      `up`; with a failed install they latch to `error`. On `false → true`
   *      (mid-session re-install) they're torn down and re-held.
   *
   *   2. **The legacy install-window backoff** — for services that opted out
   *      (`x-shipit-depends-on-install: false`) and untouched legacy projects,
   *      a non-zero exit while `true` is retried with backoff instead of
   *      latching to `error`, and `true → false` does one explicit restart
   *      pass over services still in `error` / pending-retry.
   *
   * @param opts.failed Set when the completing install failed (`true → false`).
   *   Gated services latch to `error` instead of starting.
   */
  setInstallRunning(running: boolean, opts: { failed?: boolean } = {}): void {
    if (this._installRunning === running) return;
    const wasRunning = this._installRunning;
    this._installRunning = running;

    if (!wasRunning && running) {
      // Install (re-)starting. Clear the prior failure latch and, mid-session,
      // tear down + re-hold gated services so they relaunch against the fresh
      // dependency tree once install completes.
      this._installFailed = false;
      this.holdGatedServicesForReinstall();
      return;
    }

    if (wasRunning && !running) {
      this._installFailed = opts.failed ?? false;
      this.releaseInstallGate();
      // Legacy safety net for opted-out / non-gated services that crashed
      // during the install window. Excludes gated services (handled above).
      this.flushPostInstallRetries();
    }
  }

  /**
   * Install finished — hand the gated services back to their normal lifecycle.
   *
   * Deliberately waits for any in-flight mid-session teardown
   * (`stopGatedForReinstall`) to finish first. `holdGatedServicesForReinstall`
   * issues `docker compose stop`, which SIGTERMs the container and SIGKILLs it
   * when the 10s grace period expires — and a `command: sh -c "npm install &&
   * npm run dev"` service never forwards SIGTERM, so the grace period always
   * expires. If the gate reopens before that SIGKILL lands (observed at +35ms
   * on a cached no-op install, ~10s before the kill — docs/239), the service is
   * no longer in `gatedServices`, so the poller's `isGated` skip and
   * `handleNonZeroExit`'s gated early-return — both written for exactly this
   * exit — miss it, and our own teardown surfaces to the user as a service
   * crash. Waiting is what lets those existing guards do their job.
   *
   * Sequencing it also stops the reopening `compose up` from racing the
   * `compose stop` it just issued against the same container.
   */
  private releaseInstallGate(): void {
    const teardown = this._gatedTeardown;
    this._gatedTeardown = null;

    const open = (): void => {
      if (this._disposed) return;
      // A new install may have started while we waited for the teardown; that
      // re-held the services, and its own completion owns the next gate open.
      if (this._installRunning) return;
      if (this._installFailed) {
        this.latchGatedServicesToError();
      } else {
        this.startGatedServices();
      }
    };

    if (!teardown) {
      // No mid-session teardown in flight (the common first-install path) —
      // open synchronously, exactly as before.
      open();
      return;
    }
    // Fire-and-forget from a sync caller (`setInstallRunning`): the gate opens
    // once the teardown lands. `stopGatedForReinstall` never rejects.
    void (async () => {
      await teardown;
      open();
    })();
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

  /**
   * Whether a secrets sync has run yet. An empty snapshot means "nothing is
   * declared" only once this is true; before that it means "not resolved yet."
   */
  get secretsSynced(): boolean {
    return this.secrets.hasSynced;
  }

  /** Whether the compose stack has been started. */
  get started(): boolean {
    return this._started;
  }

  /** Get all managed services. */
  getServices(): ManagedService[] {
    // Derive `url` on read (never stored) so it can't go stale: the agent-facing
    // direct URL exists while the service has a live container address.
    // `stopped`/`error` are excluded — there we have positive evidence the
    // container is gone, so the last-known IP is a stale address rather than an
    // unverified one. See GH #1509, #2044, and the `url` field doc.
    return [...this.services.values()].map((svc) =>
      hasLiveAddress(svc)
        ? { ...svc, url: `http://${svc.containerIp}:${svc.port}/` }
        : { ...svc },
    );
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
   * Fetch an authoritative log snapshot directly from Docker at call time.
   *
   * This is the source of truth for the backlog shown when the user opens the
   * logs panel. Unlike {@link getLogBuffer} — the in-memory ring buffer, which
   * rotates at MAX_LOG_BUFFER (so older lines are evicted as the service keeps
   * logging) and is wiped on every reconcile/restart (`logBuffers.clear()`) —
   * this runs a fresh `docker compose logs --tail <lines>` and returns whatever
   * Docker still retains for the *current* container. That's what makes the
   * panel show history from before it was opened instead of only the slice that
   * happened to survive in the ring buffer. The live `-f` stream
   * ({@link streamLogs}) still feeds incremental updates after this snapshot.
   *
   * Never rejects: falls back to the in-memory buffer if the snapshot command
   * errors or returns nothing.
   */
  async snapshotLogs(name: string, lines = 2000): Promise<string> {
    if (!this.services.has(name)) return "";

    // docs/192 — the durable store is the source of truth: it retains history
    // across reconcile/restart/container destruction, which a fresh
    // `docker compose logs` (bound to the *current* container) cannot. Prefer
    // it; fall back to Docker only before the store has been seeded (e.g. very
    // first open, or a setup without a LogStore).
    const channel = `service:${name}`;
    if (this.logStore?.hasChannel(this.sessionId, channel)) {
      return this.logStore.snapshotText(this.sessionId, channel, ServiceManager.MAX_LOG_SNAPSHOT);
    }

    const tail = Number.isFinite(lines) && lines > 0 ? String(Math.floor(lines)) : "2000";
    const args = this.compose.args("logs", "--no-log-prefix", "--tail", tail, name);

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
          cwd: this.workspaceDir,
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

  /**
   * Initialize the compose stack:
   * 1. Parse and validate the compose file
   * 2. Generate the override file
   * 3. Start auto services via `docker compose up -d`
   */
  async start(): Promise<void> {
    this._disposed = false;
    await this.ensureSessionNetworkModeFn?.(Boolean(this.containServicesFn));
    // Kill any stale compose containers left over from a previous orchestrator
    // run (e.g. ShipIt restart). Uses label filter — no compose files needed.
    try {
      await this.compose.killStaleContainers();
    } catch {
      // Best-effort cleanup
    }

    const composePath = path.join(this.workspaceDir, this.composeConfig.file);

    // Parse and validate
    const parsedServices = parseComposeFile(composePath, {
      dockerSocket: this.composeConfig.dockerSocket || this.opsSession,
      containEgress: Boolean(this.containServicesFn),
      trustedOpsProxy: this.opsSession,
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
        dependsOnInstall: svc.dependsOnInstall ?? (preview === "auto"),
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
    const serviceEnvFiles = this.secrets.getServiceEnvFiles();
    const overrideOpts: ComposeOverrideOptions = {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      stackName: this.stackName,
      userNamedVolumes,
      ...(this.containServicesFn ? { containEgress: true } : {}),
      ...(this.containServiceDns ? { containDns: true } : {}),
      ...(this.containServiceProxy ? { containProxy: true } : {}),
      ...(dockerSecretsBuild ? { dockerSecrets: dockerSecretsBuild } : {}),
      ...(serviceEnvFiles ? { serviceEnvFiles } : {}),
      ...(this.overlayDepDirs.length > 0 ? { overlayDepDirs: this.overlayDepDirs } : {}),
    };
    const overrideContent = generateComposeOverride(parsedServices, overrideOpts);
    writeComposeOverride(this.overrideDir, overrideContent);

    // Mark auto services as starting (silently — _startupComplete is false)
    const autoServices = [...this.services.values()].filter(s => s.preview === "auto");
    for (const svc of autoServices) {
      this.updateServiceStatus(svc.name, "starting");
    }

    // Partition auto services by the install gate (docs/137). The gate is
    // open when no install is in flight and the last attempt (if any)
    // succeeded. While closed, `dependsOnInstall` services are held: kept in
    // `starting` if install is still running, or latched to `error` if a
    // prior install already failed (the install-finished hook would otherwise
    // have fired before this start() ran). Non-gated services start now.
    this.gatedServices.clear();
    this.postGateServices.clear();
    // A full (re)start is a deliberate instruction covering every service, so
    // no earlier per-service stop survives it (requirement 5).
    this.stoppedByUser.clear();
    // A full (re)start supersedes any pending mid-session teardown — the stack
    // is being brought up from scratch, so the gate must not wait on it.
    this._gatedTeardown = null;
    const gateOpen = !this._installRunning && !this._installFailed;
    const startNow: ManagedService[] = [];
    for (const svc of autoServices) {
      if (svc.dependsOnInstall && !gateOpen) {
        if (this._installFailed) {
          this.updateServiceStatus(svc.name, "error", INSTALL_FAILED_GATE_MESSAGE);
          this.gatedServices.add(svc.name);
        } else {
          // Install still running — hold in `starting`.
          this.gatedServices.add(svc.name);
        }
      } else {
        startNow.push(svc);
      }
    }

    try {
      // 1. Start non-gated auto services (named explicitly so manual and
      //    install-gated services aren't started but remain part of the
      //    project for dependency resolution).
      //
      // Edge case: when EVERY service is manual or install-gated, `autoNames`
      // is `[]`. Calling `docker compose up -d` with no service names tells
      // compose "bring up every service in the project," which would silently
      // start the services we explicitly asked to leave alone. Skip the call
      // entirely in that case — the rest of `start()` (network join, status
      // polling, log streaming) still runs so manual services show up as
      // `stopped` and gated services stay `starting` until install completes.
      const autoNames = startNow.map(s => s.name);
      if (autoNames.length > 0) {
        await this.withUpInFlight(autoNames, async () => {
          await this.prepareContainedStartFn?.(autoNames);
          await this.compose.up(autoNames, this.composeLogSink(autoNames));
          await this.containServicesFn?.([...this.services.keys()]);
        });
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

      // 5. Start log streaming (--tail 1000 replays recent history + follows).
      //    `ensureLogFollower`, not `streamLogs`: step 3's poll can already have
      //    attached one on an auto service that came up `running`, and replacing
      //    a live follower would clear the ring buffer it just filled. Nothing
      //    else can hold a follower here — `reconcile()` kills them all before
      //    calling us, and a first `start()` has none.
      for (const svc of this.services.values()) {
        this.ensureLogFollower(svc.name);
      }

      this.emit("stack_ready");
    } catch (err) {
      this._startupComplete = true;
      // Only the services we actually tried to start reflect this failure.
      // Gated services are intentionally held by the install gate (which is
      // still pending) — don't clobber their held status with a stack error
      // that's about the services we brought up.
      for (const svc of startNow) {
        this.updateServiceStatus(svc.name, "error", (err as Error).message);
      }
      this.emit("stack_error", err);
      throw err;
    } finally {
      // 6. Begin periodic polling to detect crashes.
      //
      // In the `finally`, not at the end of the `try` (#2044). The poll loop is
      // the ONLY thing that ever moves a service off `starting` or resolves its
      // container IP, and `reconcile()` stops it before calling us — so a throw
      // anywhere in steps 1-5 used to leave the session with no poller at all
      // and every service frozen at whatever status it last had, permanently.
      // The failure modes that get here (a compose `up` that failed, a listener
      // that threw during the status flush) are exactly the ones after which we
      // most want to keep watching Docker.
      if (!this._disposed) this.poller.start();
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
    // ...and this start is now the user's most recent instruction, so an
    // earlier stop no longer suppresses anything (requirement 5).
    this.stoppedByUser.delete(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.withUpInFlight([name], async () => {
        await this.prepareContainedStartFn?.([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // The user stopped this service while the `up` above was still running.
      // Theirs is the later instruction, and `stopService` is already waiting on
      // that `up` to stop whatever it produced — so finishing the start here
      // would only race it back to `running`. See `stopService`.
      if (this.stoppedByUser.has(name)) return;
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

    // Same as startService — explicit user action resets the OOM budget, and
    // supersedes an earlier stop (requirement 5).
    this.retry.resetOomBudget(name);
    this.stoppedByUser.delete(name);
    this.updateServiceStatus(name, "starting");
    try {
      await this.compose.stop(name);
      // Checked BEFORE the `up`, not only after it. A restart's own stop can
      // burn the full 10s SIGTERM grace period, and a user Stop landing in that
      // window registers no in-flight `up` for `stopService` to chase — so
      // without this the restart would go on to recreate the container after
      // the service had already been reported stopped (requirement 5).
      if (this.stoppedByUser.has(name)) return;
      await this.withUpInFlight([name], async () => {
        await this.prepareContainedStartFn?.([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // Stopped mid-restart — see `startService` for why this returns rather
      // than finishing the bring-up.
      if (this.stoppedByUser.has(name)) return;
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
   * Stop a specific service, and make it stay stopped (requirement 5).
   *
   * A bare `docker compose stop` is not enough when a start is still in flight,
   * which is exactly when the user reaches for Stop — a service that appears
   * wedged mid-`up`. The stop lands on a container the racing `up` then creates
   * or starts anyway, and the service the user asked to be gone comes back.
   * Nothing sequenced the two: both WS handlers just call the manager.
   *
   * So the stop is issued immediately (a running container should go down now,
   * not after a build that may still have minutes left), and then, if an `up`
   * was in flight for this service, waited out and issued a second time against
   * whatever that `up` left behind. {@link stoppedByUser} covers the same race
   * from the other side: the start path abandons its post-`up` work, the
   * automatic retries refuse to fire, and the SIGTERM/SIGKILL exit our own stop
   * produces is not read as a crash.
   *
   * Deliberately not a lock around the two operations. Waiting for the `up`
   * BEFORE stopping would leave the user unable to stop a service whose `up` is
   * hung — the very failure requirement 2 is about — and would make Stop appear
   * to do nothing for the length of an image build.
   */
  async stopService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Unknown service: ${name}`);

    this.stoppedByUser.add(name);
    // A retry timer already scheduled against an earlier crash would otherwise
    // restart the service seconds after the user stopped it. This cancels the
    // pending timer for all three schedules — install-window, OOM and post-gate
    // retries share `retryTimers`.
    this.retry.clearRetryState(name);
    // Captured BEFORE the stop below: an `up` that settles while we are stopping
    // drops its own entry, and that is precisely the one whose container we
    // would then never revisit.
    const pendingUps = [...(this.upSettled.get(name) ?? [])];
    try {
      await this.compose.stop(name);
      this.updateServiceStatus(name, "stopped");
    } catch (err) {
      this.updateServiceStatus(name, "error", (err as Error).message);
      throw err;
    }
    // The racing `up` is chased in the BACKGROUND, not awaited. Awaiting it
    // would hand the stop the one failure mode it exists to survive: an `up`
    // that never returns (see UP_SILENCE_TIMEOUT_MS) would leave this call
    // pending forever, so the service would never be reported stopped and the
    // user's Stop would hang — turning requirement 2's failure into a
    // requirement 5 failure. The stop above has already gone in; this only
    // catches what the `up` puts back afterwards.
    if (pendingUps.length > 0) void this.stopAfterPendingUps(name, pendingUps);
  }

  /**
   * Re-issue a stop once the `up` calls that were racing it have settled — the
   * second half of {@link stopService} (requirement 5).
   *
   * Re-checks {@link stoppedByUser} at the end: a deliberate start may have
   * arrived while we waited, and that is a newer instruction than the stop that
   * queued this. Never rejects — it runs unattended, and a stop failure here is
   * reported through the service's status rather than an unhandled rejection.
   */
  private async stopAfterPendingUps(name: string, pendingUps: Promise<void>[]): Promise<void> {
    await Promise.all(pendingUps);
    if (this._disposed) return;
    if (!this.stoppedByUser.has(name)) return;
    try {
      await this.compose.stop(name);
      this.updateServiceStatus(name, "stopped");
    } catch (err) {
      console.warn(
        `[compose:${this.sessionId}] follow-up stop for ${name} failed:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Stream logs for a service. Returns a cleanup function.
   */
  streamLogs(name: string): () => void {
    const existing = this.logProcesses.get(name);
    if (existing) {
      killChild(existing);
      this.logProcesses.delete(name);
    }

    // Clear buffer before (re)starting — --tail replays history into it
    this.logBuffers.delete(name);

    // docs/192 — durable persistence. The follower replays its `--tail` window
    // on every (re)start, which would duplicate lines in the durable store
    // across restarts. So we only replay history (`--tail 1000`, which also
    // *seeds* the store via handleData) when the store has nothing yet;
    // otherwise we follow only NEW lines (`--tail 0`). This keeps an earlier
    // container's persisted history intact after the container is destroyed
    // and a fresh one starts. (Lines emitted while the orchestrator itself was
    // down are not backfilled — a `--since` follower is the planned follow-up.)
    const channel = `service:${name}`;
    const seeded = this.logStore?.hasChannel(this.sessionId, channel) ?? false;
    const tail = this.logStore && seeded ? "0" : "1000";

    const args = this.compose.args("logs", "-f", "--tail", tail, "--no-log-prefix", name);
    const proc = spawn("docker", args, {
      cwd: this.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleData = (chunk: Buffer) => {
      const text = chunk.toString();
      // Durable backlog (docs/192) — survives reconcile/restart/container rm.
      this.logStore?.append(this.sessionId, channel, text);
      this.bufferServiceLog(name, text);
    };

    proc.stdout?.on("data", handleData);
    proc.stderr?.on("data", handleData);

    // A ChildProcess that fails to exec emits 'error', and an 'error' event
    // with no listener is rethrown as an uncaughtException that kills the
    // whole process. The follower is the one docker spawn that bypasses the
    // injectable compose runner, so it fires for real even when a caller has
    // stubbed every other docker call — most visibly when `npm test` runs
    // inside a ShipIt session container, which has no `docker` binary at all:
    // ENOENT there crashed the vitest worker, and the pool crashed with it.
    // Losing the follower is not fatal (it only feeds the log buffer), so
    // degrade to "no follower" instead.
    proc.on("error", (err: Error) => {
      console.warn(`[compose:${this.sessionId}] log follower for ${name} failed to start:`, err.message);
      if (this.logProcesses.get(name) === proc) this.logProcesses.delete(name);
    });

    // A follower dies with the container it follows: `docker compose logs -f`
    // ends when the container it resolved at spawn time is gone, which every
    // recreate does. Nothing noticed (docs/121 gap F) — the dead process stayed
    // in the map, so the service looked followed while its log panel silently
    // stopped growing. Dropping it here is what makes `logProcesses.has(name)`
    // an honest liveness answer for {@link ensureLogFollower}; the deliberate
    // kills (`streamLogs`, `reconcile`, `stop`) have already removed their own
    // entry by the time this fires, so this only ever reaps a follower that
    // exited on its own.
    proc.on("close", () => {
      if (this.logProcesses.get(name) === proc) this.logProcesses.delete(name);
    });

    this.logProcesses.set(name, proc);

    return () => {
      killChild(proc);
      this.logProcesses.delete(name);
    };
  }

  /**
   * Re-attach a log follower for `name` if the one it had is gone (docs/121
   * gap F, requirement 4).
   *
   * A follower exits with the container it was following, so every recreate
   * leaves the service unfollowed: its log panel keeps whatever it had and never
   * grows again. The three user-visible recreate paths — a crash retry, an OOM
   * recovery, the install gate's batched release — are all AUTOMATIC, so the
   * pre-existing `streamLogs` calls on `start()` / `startService` /
   * `restartService` never covered them, and the only way back was for the user
   * to restart the service by hand. That is the exact thing requirement 4 rules
   * out.
   *
   * A no-op while the follower is alive, which is what lets the callers invoke
   * it unconditionally. It deliberately does NOT kill and replace a live
   * follower: `streamLogs` clears the in-memory ring buffer on every spawn, so a
   * needless replacement would throw away the log panel's backlog — the opposite
   * of the requirement.
   */
  private ensureLogFollower(name: string): void {
    if (this.logProcesses.has(name)) return;
    this.streamLogs(name);
  }

  /**
   * Adopt a freshly-resolved `compose:` block from `shipit.yaml`.
   *
   * `composeConfig` is read from `shipit.yaml` once, when the manager is
   * constructed — but `shipit.yaml` itself is a workspace file that a git
   * sync/rebase (or a plain edit) can rewrite mid-session. Without this,
   * `reconcile()` would keep re-parsing the ORIGINAL compose path forever, so
   * a repo that moves its compose file or flips `docker-socket` would silently
   * keep running the old stack definition. Call this before `reconcile()`.
   *
   * Returns true when the config actually changed (the caller can skip work,
   * and the reconcile is a plain compose-file re-read).
   */
  updateComposeConfig(next: ComposeConfig): boolean {
    const changed =
      next.file !== this.composeConfig.file ||
      next.dockerSocket !== this.composeConfig.dockerSocket;
    if (!changed) return false;
    this.composeConfig = next;
    this.compose.setComposeFile(next.file);
    return true;
  }

  /**
   * Reconcile the compose stack after a config change.
   * Re-parses the compose file, regenerates the override, and runs `up -d`.
   */
  async reconcile(): Promise<void> {
    // Kill orphaned log processes before clearing state — if a service was
    // renamed or removed, start() won't find its old process to clean up.
    for (const [, proc] of this.logProcesses) killChild(proc);
    this.logProcesses.clear();
    this.poller.stop();
    this.retry.cancelAll();
    // The services map is about to be rebuilt from scratch; a watchdog armed
    // against the OLD entry would fire against a service object that no longer
    // exists (or, worse, a same-named replacement it never watched).
    this.cancelStartingWatchdogs();
    // Same generation argument for the in-flight set, which is an exemption
    // rather than a lock: a `compose up` from the previous definition that
    // never returned would otherwise exempt the SAME-NAMED new service from
    // both the poller's missing-container reconciliation and the `starting`
    // watchdog, for the rest of the session. A stale call releasing later just
    // deletes an absent key; if it races a new `up` for the same name it can
    // drop that exemption early, which costs one grace window rather than the
    // session.
    this.upInFlight.clear();
    // Same generation argument for the two maps keyed alongside it: a stale
    // `up`'s silence clock must not judge the new service of that name, and a
    // stop must not wait on the previous definition's call.
    this.upLastOutputAt.clear();
    this.upSettled.clear();

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
    this.cancelStartingWatchdogs();
    this.postGateServices.clear();
    this._gatedTeardown = null;

    // Kill all log streaming processes
    for (const [name, proc] of this.logProcesses) {
      killChild(proc);
      this.logProcesses.delete(name);
    }

    try {
      await this.compose.down({ removeVolumes: opts.removeVolumes ?? false });
    } catch {
      // Best-effort cleanup
    }

    // docs/183: when the session is going away for good (archive / full reset
    // pass `removeVolumes: true`), drop the external service-env directory so
    // plaintext service secrets don't outlive the session. They sit outside
    // the workspace checkout, so neither archive nor the disk-janitor would
    // otherwise reclaim them. Idle eviction / reconcile keep `removeVolumes`
    // false, preserving the files for resume.
    if (opts.removeVolumes) {
      removeSessionServiceEnvDir({ rootDir: this.serviceEnvDir, sessionId: this.sessionId });
    }

    // docs/087 Phase 1 follow-up: Docker-secrets mode has the same leak — it
    // writes per-secret plaintext files to `<internalDir>/<sessionId>/` outside
    // the workspace. Drop that directory under the same teardown-for-good guard
    // (idle eviction / reconcile keep `removeVolumes` false to preserve files
    // for resume).
    if (opts.removeVolumes && this.secretsInternalDir) {
      removeSessionSecretsDir({ internalDir: this.secretsInternalDir, sessionId: this.sessionId });
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
   * compose file (in case it changed), rewrites the per-service env
   * files, and runs `docker compose up -d` so compose detects the env
   * changes and recreates affected containers. Safe to call when the stack
   * isn't started — env files are written but no compose call happens.
   */
  async refreshSecrets(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      const composePath = path.join(this.workspaceDir, this.composeConfig.file);
      parsedServices = parseComposeFile(composePath, {
        dockerSocket: this.composeConfig.dockerSocket || this.opsSession,
        containEgress: Boolean(this.containServicesFn),
        trustedOpsProxy: this.opsSession,
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
        ...(this.containServicesFn ? { containEgress: true } : {}),
        ...(this.containServiceDns ? { containDns: true } : {}),
        ...(this.containServiceProxy ? { containProxy: true } : {}),
        ...(this.overlayDepDirs.length > 0 ? { overlayDepDirs: this.overlayDepDirs } : {}),
        dockerSecrets: dockerSecretsBuild,
      };
      const overrideContent = generateComposeOverride(parsedServices, overrideOpts);
      writeComposeOverride(this.overrideDir, overrideContent);
    }

    if (!this._started) return;
    // Re-run `up -d` for the auto services so compose recreates containers
    // whose env_file content changed. Manual services aren't restarted —
    // they're only running if the user explicitly started them.
    const autoNames = [...this.services.values()]
      .filter(s => s.preview === "auto")
      .map(s => s.name);
    if (autoNames.length === 0) return;
    try {
      await this.withUpInFlight(autoNames, async () => {
        await this.prepareContainedStartFn?.(autoNames);
        await this.compose.up(autoNames, this.composeLogSink(autoNames));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      await this.poller.pollOnce();
      // This `up` recreates every container whose env file changed, and it is
      // the one recreate the `onRunning` hook can miss: the replacement can be
      // up before any poll observes the service as anything but `running`, so
      // no transition ever fires. Without this the log panel goes quiet for the
      // rest of the session on nothing worse than the user saving a secret.
      for (const name of autoNames) this.ensureLogFollower(name);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] refreshSecrets compose up failed:`, (err as Error).message);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Mark `names` as having a `compose up` in flight for the duration of `fn`
   * (planning#316). Every `compose up`/`up <service>` call goes through this so the
   * poller can tell "this service has no container because it is still coming
   * up" from "this service's container disappeared".
   */
  private async withUpInFlight<T>(names: string[], fn: () => Promise<T>): Promise<T> {
    for (const name of names) {
      this.upInFlight.set(name, (this.upInFlight.get(name) ?? 0) + 1);
      // A new container is on its way, so the address we hold describes the
      // OUTGOING one. Dropping it here is what keeps `getServices` from
      // publishing a dead (or, worse, reassigned) IP during the window where
      // the service is `starting` and the replacement doesn't exist yet.
      this.clearContainerIp(name);
      // The silence clock starts now, not at the first byte: an `up` that never
      // says anything at all is exactly the case the bound exists for.
      this.upLastOutputAt.set(name, Date.now());
    }
    // Declared here but only ever ASSIGNED inside the try, so a synchronous
    // throw from `fn` still runs the release below rather than exempting the
    // service from reconciliation for the rest of the session.
    let settled: Promise<void> | undefined;
    try {
      const call = fn();
      // Never rejects — `stopService` awaits this only to sequence itself after
      // the call, and the caller of `withUpInFlight` still gets the real rejection.
      // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form
      settled = call.then(() => {}, () => {});
      for (const name of names) {
        const pending = this.upSettled.get(name) ?? new Set<Promise<void>>();
        pending.add(settled);
        this.upSettled.set(name, pending);
      }
      return await call;
    } finally {
      for (const name of names) {
        const next = (this.upInFlight.get(name) ?? 1) - 1;
        if (next > 0) this.upInFlight.set(name, next);
        else {
          this.upInFlight.delete(name);
          this.upLastOutputAt.delete(name);
        }
        // Only OUR settlement leaves the set — an overlapping call for the same
        // service is still running, and a stop must wait for that one too.
        const pending = this.upSettled.get(name);
        if (pending && settled) {
          pending.delete(settled);
          if (pending.size === 0) this.upSettled.delete(name);
        }
      }
      // The watchdog's window is armed when `starting` is written — which for
      // every caller here is BEFORE this `up`. An up that eats most of the
      // window would otherwise leave only its remainder to cover the network
      // join and the first poll, and a service that is coming up perfectly
      // normally would be marked `error` seconds before the poll that would
      // have cleared it. Releasing the exemption restarts the clock.
      for (const name of names) {
        if (!this.upInFlight.has(name) && this.services.get(name)?.status === "starting") {
          this.armStartingWatchdog(name);
        }
      }
    }
  }

  /**
   * Append text to a service's in-memory ring buffer and fan it out to
   * listeners. The hot path shared by the container log follower and the
   * compose-output sink; the durable store (docs/192) is deliberately NOT
   * written here — see {@link composeLogSink} and `streamLogs`.
   */
  private bufferServiceLog(name: string, text: string): void {
    let buf = (this.logBuffers.get(name) ?? "") + text;
    if (buf.length > ServiceManager.MAX_LOG_BUFFER) {
      buf = truncateTerminalBuffer(buf, ServiceManager.MAX_LOG_BUFFER);
    }
    this.logBuffers.set(name, buf);
    this.emit("service_log", name, text);
  }

  /**
   * Build a sink that relays a `docker compose up`'s own output into the log
   * stream of the service(s) that `up` is bringing up — see
   * {@link COMPOSE_LOG_PREFIX} for why the silence it replaces was a bug.
   *
   * Line-buffered, because compose emits progress in arbitrary chunks and a
   * per-chunk prefix would land mid-line. The buffer is bounded
   * ({@link MAX_COMPOSE_LOG_LINE}) so a record that never terminates can't grow
   * without limit outside the ring buffer's cap, and `flush` empties it at each
   * process boundary so the last line isn't dropped.
   *
   * For a multi-service `up`, every line goes to every named service. Compose's
   * output is stack-global — it can even name a service pulled in by
   * `depends_on` that isn't in `names` — so no per-line attribution exists to
   * recover. Copying it is the honest option, and the {@link COMPOSE_LOG_PREFIX}
   * says plainly that these lines describe the `up`, not the container.
   *
   * Deliberately NOT persisted to the durable log store, even though every
   * other line in this channel is. `streamLogs` decides between replaying the
   * container's history (`--tail 1000`) and following only new lines
   * (`--tail 0`) by asking whether the store already holds this channel — its
   * guard against duplicating history across follower restarts (docs/192).
   * Seeding the channel with build output would flip that predicate before the
   * container has ever been followed, and the container's first lines — emitted
   * in the gap between `up` returning and the follower attaching, which spans a
   * network join and a poll — would be lost for good. `hasChannel` is a
   * file-size check over a raw-text channel, so there is no cheaper way to tell
   * the two kinds of bytes apart; persisting build output needs its own
   * "container backlog seeded" marker, which is a docs/192 change rather than
   * part of this fix.
   *
   * What live emission plus the ring buffer does cover: an open panel gets the
   * lines as they arrive, and on a service with no persisted history yet — the
   * cold-build case this exists for — a panel opened mid-build also gets them
   * from `snapshotLogs`, which falls back to the ring buffer while
   * `docker compose logs` has no container to answer for. What it does not:
   * once the channel holds container history, `snapshotLogs` returns that and
   * ignores the ring, so a later build is visible only live.
   */
  private composeLogSink(names: string[]): ComposeOutputSink {
    let pending = "";
    const emit = (line: string): void => {
      if (!line.trim()) return;
      const text = `${COMPOSE_LOG_PREFIX}${line}\n`;
      for (const name of names) this.bufferServiceLog(name, text);
    };
    const sink: ComposeOutputSink = (chunk: string) => {
      // Progress the user can see (requirement 2) — recorded per CHUNK, before
      // the line buffering below, so a build whose output has not yet reached a
      // newline still counts as talking. See UP_SILENCE_TIMEOUT_MS.
      const now = Date.now();
      for (const name of names) this.upLastOutputAt.set(name, now);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
      // A stream that never emits a newline would otherwise accumulate here
      // forever, re-copied by every `split` — unbounded memory on a path whose
      // whole job is to survive a build of unknown length.
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

  /** Run a single restart attempt for a service in retry-backoff. */
  private async runRetryNow(name: string): Promise<void> {
    if (this._disposed) return;
    const svc = this.services.get(name);
    if (!svc) return;
    // The user stopped this service after the retry was scheduled. An automatic
    // restart must not overrule that (requirement 5); a deliberate start clears
    // the flag and the service becomes retryable again.
    if (this.stoppedByUser.has(name)) return;
    try {
      await this.withUpInFlight([name], async () => {
        await this.prepareContainedStartFn?.([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
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
      // Skip gated services — the declarative install gate owns their
      // lifecycle (started or latched to error by startGatedServices /
      // latchGatedServicesToError). Only the legacy backoff net applies here.
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

  // -----------------------------------------------------------------------
  // Declarative install gate (docs/137-depends-on-install)
  // -----------------------------------------------------------------------

  /**
   * Install finished successfully — start every gated service in one batched
   * `docker compose up` so they share startup time rather than serializing.
   * Clears the gate set; from here the periodic poller tracks them normally.
   */
  private startGatedServices(): void {
    if (this._disposed) return;
    if (this.gatedServices.size === 0) return;
    // A gated service the user stopped while it was held stays stopped. The gate
    // opening is an automatic lifecycle event, not a newer instruction from the
    // user, and requirement 5 gives the user's stop the last word — starting it
    // here would undo a stop they can watch us undo. They can start it whenever
    // they like, which clears the flag.
    const names = [...this.gatedServices].filter(n => !this.stoppedByUser.has(n));
    const held = this.gatedServices.size - names.length;
    this.gatedServices.clear();
    if (names.length === 0) return;
    const heldNote = held > 0 ? ` (${held} left stopped at the user's request)` : "";
    console.log(
      `[compose:${this.sessionId}] install finished — starting ${names.length} gated service(s): ${names.join(", ")}${heldNote}`,
    );
    for (const name of names) {
      this.updateServiceStatus(name, "starting");
      // Open a first-boot recovery window: if the service crashes shortly
      // after this `up` (e.g. the gate released before deps finished landing),
      // handleNonZeroExit restarts it with backoff instead of latching to
      // `error`. Cleared once it reaches `running`. See docs/137.
      this.postGateServices.add(name);
    }
    void this.startGatedBatch(names);
  }

  /** Bring up a batch of gated services and wire up their post-start plumbing. */
  private async startGatedBatch(names: string[]): Promise<void> {
    if (this._disposed) return;
    try {
      await this.withUpInFlight(names, async () => {
        await this.prepareContainedStartFn?.(names);
        await this.compose.up(names, this.composeLogSink(names));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // First `up` for an otherwise all-gated/all-manual stack is the moment
      // the compose network materializes — attach the orchestrator + agent.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
      // Log streaming for these services is already running: `start()` streams
      // every service in the map (gated ones included) before the gate opens,
      // and `docker compose logs -f <service>` follows the service across the
      // container's first `up`. No need to re-spawn here.
    } catch (err) {
      const msg = (err as Error).message;
      for (const name of names) {
        this.updateServiceStatus(name, "error", msg);
      }
    }
  }

  /**
   * Install failed — latch every gated service to `error` with a message that
   * names the real cause, instead of letting them crash on missing install
   * output (`vite: not found`, exit 127, etc.). They stay in the gate set so
   * a subsequent successful re-install restarts them.
   */
  private latchGatedServicesToError(): void {
    if (this.gatedServices.size === 0) return;
    console.log(
      `[compose:${this.sessionId}] install failed — ${this.gatedServices.size} gated service(s) not started`,
    );
    for (const name of this.gatedServices) {
      this.updateServiceStatus(name, "error", INSTALL_FAILED_GATE_MESSAGE);
    }
  }

  /**
   * Mid-session re-install began (`setInstallRunning(false → true)`). Tear
   * down currently-gated services and re-hold them in `starting` so they
   * relaunch against the fresh dependency tree once install completes. Causes
   * a visible preview blink — acceptable because the edit that triggered
   * re-install changed the dependency tree.
   */
  private holdGatedServicesForReinstall(): void {
    if (this._disposed) return;
    const gated = [...this.services.values()].filter(
      s => s.preview === "auto" && s.dependsOnInstall,
    );
    if (gated.length === 0) return;
    this.gatedServices = new Set(gated.map(s => s.name));
    console.log(
      `[compose:${this.sessionId}] install re-running — holding ${gated.length} gated service(s): ${gated.map(s => s.name).join(", ")}`,
    );
    for (const svc of gated) {
      this.updateServiceStatus(svc.name, "starting");
      // Re-gating supersedes any in-flight post-gate recovery window — the
      // next gate open re-arms a fresh one.
      this.postGateServices.delete(svc.name);
      this.retry.clearPostGateState(svc.name);
      this.retry.cancelPostGateStableTimer(svc.name);
      // Same reasoning for the OOM budget: this teardown+relaunch is a fresh
      // start against a new dependency tree, so it should not inherit an
      // earlier OOM count. Without this, a repeating re-install (the dep-change
      // cooldown is 30s) tears the service down before it can bank the 60s of
      // continuous uptime that clears the counter, so the budget only ever
      // drains — monotonically, to a permanent latch. See docs/239.
      this.retry.resetOomBudget(svc.name);
    }
    // Retained so the gate-open path can await it — see `releaseInstallGate`.
    this._gatedTeardown = this.stopGatedForReinstall([...this.gatedServices]);
  }

  /**
   * Stop gated containers so they relaunch fresh after re-install completes.
   *
   * Concurrent, not sequential: `releaseInstallGate` now waits for this, and
   * each `compose stop` can burn the full 10s SIGTERM grace period, so a
   * sequential loop would add 10s of preview downtime *per gated service* to
   * every re-install bracket. Stopping them together caps the added wait at one
   * grace period for the whole stack. Never rejects — a stop failure is logged
   * and swallowed so it can't wedge the gate closed.
   */
  private async stopGatedForReinstall(names: string[]): Promise<void> {
    await Promise.all(names.map(async (name) => {
      if (this._disposed) return;
      try {
        await this.compose.stop(name);
      } catch (err) {
        console.warn(
          `[compose:${this.sessionId}] failed to stop gated service ${name} for re-install:`,
          (err as Error).message,
        );
      }
    }));
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
   *
   * **Bounded** (#2044). Every caller sequences this *before* the `pollOnce()`
   * that resolves the service's status and container IP, so for as long as this
   * blocks, the service stays pinned at whatever it was — `starting`, with no
   * address — even though its container is already up. And it can block for a
   * long time: the join reaches Docker over dockerode (no client-side timeout),
   * awaits the container's egress-firewall readiness promise, and then RUNS A
   * SIDECAR CONTAINER to open egress to the new subnet. A best-effort side
   * quest — its own failure is explicitly swallowed as non-fatal below — must
   * not be able to wedge the authoritative status read behind it, so a join
   * that overruns is treated exactly like a join that failed.
   */
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
      // Non-fatal — agent may not reach services by DNS but proxy still works.
      // The orchestrator-side join inside `networkJoinFn` has its own
      // try/catch with "already exists" handling (see app-lifecycle.ts).
      //
      // Logged rather than silently dropped: a join that keeps timing out is
      // exactly the condition that leaves the agent unable to resolve a service
      // by its compose name, and there was previously no record of it anywhere.
      console.warn(
        `[compose:${this.sessionId}] joinSessionNetwork failed:`,
        (err as Error).message,
      );
    }
  }

  /**
   * (Re)arm the stuck-`starting` watchdog for one service (#2044).
   *
   * Always resets an existing timer: the window measures "how long since
   * something last declared this service starting", so a fresh `startService`
   * on an already-`starting` service legitimately buys another full window.
   */
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

  /** Drop every armed `starting` watchdog — teardown and reconcile. */
  private cancelStartingWatchdogs(): void {
    for (const timer of this.startingWatchdogs.values()) clearTimeout(timer);
    this.startingWatchdogs.clear();
  }

  /**
   * The `starting` watchdog expired for `name` — decide whether the service is
   * genuinely wedged or just legitimately slow.
   *
   * Both exemptions RE-ARM rather than cancel: a build that outruns the window
   * or an install that takes ten minutes is fine, but the service still has to
   * answer for itself once that reason goes away.
   *
   * The `compose up` exemption is itself bounded (requirement 2): it holds for
   * as long as the `up` keeps producing output, and stops holding once it has
   * gone silent for {@link UP_SILENCE_TIMEOUT_MS}. Without that, a `docker
   * compose up` that never returns re-armed this watchdog for the rest of the
   * session. The bound is on silence rather than elapsed time precisely so that
   * a legitimately slow image build — which talks the whole way through — is
   * never the thing it fires on.
   */
  private onStartingWatchdogFired(name: string): void {
    if (this._disposed) return;
    const svc = this.services.get(name);
    // Raced with a status change we haven't torn the timer down for yet.
    if (svc?.status !== "starting") return;
    if (this.upInFlight.has(name)) {
      const silentFor = Date.now() - (this.upLastOutputAt.get(name) ?? 0);
      if (silentFor < UP_SILENCE_TIMEOUT_MS) {
        // The build is still producing output — a legitimately slow one, and
        // requirement 2's non-requirements rule out putting a clock on it.
        this.armStartingWatchdog(name);
        return;
      }
      console.warn(
        `[compose:${this.sessionId}] compose up for "${name}" has produced no output for ` +
        `${Math.round(silentFor / 1000)}s and has not returned — marking error`,
      );
      // Deliberately not re-armed: the `up` is still running, so the exemption
      // would fire this branch again every window. `withUpInFlight` re-arms only
      // a service still in `starting`, and the poll after a late success writes
      // `running`, so a build that recovers still clears this.
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

  /**
   * Forget a service's resolved container address.
   *
   * Called wherever the container it described is gone or being replaced. The
   * IP was previously kept indefinitely, which was harmless only because
   * `getServices` published a URL for `running` services alone; now that a
   * `starting` service publishes one too, a retained IP would resurface as an
   * address the moment a stop→start cycle wrote `starting` — pointing at a dead
   * container, or at whatever else Docker has since handed that IP to.
   */
  private clearContainerIp(name: string): void {
    const svc = this.services.get(name);
    if (svc) delete svc.containerIp;
  }

  private updateServiceStatus(name: string, status: ServiceStatus, error?: string): void {
    const svc = this.services.get(name);
    if (!svc) return;
    svc.status = status;
    svc.error = error;
    // `stopped`/`error` are conclusions drawn from an observed exit (or from
    // reconciliation finding no container at all) — the address we hold is now
    // stale, not merely unverified. `starting` deliberately keeps it: the
    // poller's `restarting` branch writes `starting` for a container it just
    // resolved an IP for on the same pass.
    if (status === "stopped" || status === "error") delete svc.containerIp;
    // Arm/disarm the stuck-`starting` watchdog on the transition itself, so
    // every writer of `starting` is covered without each one remembering to.
    if (status === "starting") {
      this.armStartingWatchdog(name);
    } else {
      this.clearStartingWatchdog(name);
    }
    // During initial startup, updates are batched — events are flushed
    // once the full sequence (compose up → network join → IP resolution) completes.
    if (this._startupComplete) {
      this.emit("service_status", { ...svc });
    }
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a service currently has an address worth publishing — a container IP
 * and port we resolved, and no positive evidence that the container is gone.
 *
 * `running` and `starting` both qualify: `starting` means "we have not confirmed
 * readiness", not "there is no container". `stopped`/`error` do not: those are
 * conclusions the poller drew from an actual `ps` row (or from reconciliation),
 * so the retained IP describes a container that has exited.
 */
function hasLiveAddress(svc: ManagedService): svc is ManagedService & { containerIp: string; port: number } {
  return (
    !!svc.containerIp &&
    !!svc.port &&
    (svc.status === "running" || svc.status === "starting")
  );
}

/**
 * User-facing message for a service that exited non-zero.
 *
 * Exit 137 is SIGKILL — an OOM kill is only ONE of its causes, and inside
 * ShipIt it is not even the most common one (our own re-install teardown
 * SIGKILLs services that don't forward SIGTERM). So we only name OOM when the
 * container's inspected `State.OOMKilled` backs it up, hedge when we couldn't
 * ask, and say plainly that it wasn't an OOM when the daemon told us so —
 * because "raise your memory limit" is inert advice for a plain SIGKILL and
 * sends the user chasing a limit that was never binding. See docs/239.
 */
function describeExit(exitCode: number, oomKilled?: boolean): string {
  if (exitCode !== 137) return `Exited with code ${exitCode}`;
  if (oomKilled === true) return "Exited with code 137 (OOMKilled)";
  if (oomKilled === false) return "Exited with code 137 (SIGKILL — not an OOM kill)";
  return "Exited with code 137 (likely OOMKilled)";
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
