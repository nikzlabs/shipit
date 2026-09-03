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
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { ComposeServiceOriginView } from "../shared/types/ws-server-messages/service.js";
import { killChild } from "../shared/kill-child.js";
import { truncateTerminalBuffer } from "./terminal-buffer.js";
import type { LogStore } from "./log-store.js";
import {
  classifyComposeFailure,
  extractContainerPort,
  parseComposeFile,
  DEFAULT_STOP_GRACE_PERIOD_MS,
  parseUserNamedVolumes,
  generateComposeOverride,
  writeComposeOverride,
  type ComposeFailure,
  type ComposeOverrideOptions,
  type ComposeService,
  type ComposeServiceOrigin,
  type OverlayDepDirVolume,
} from "./compose-generator.js";
import { toComposeService, type PluginComposeService } from "./plugin-compose.js";
import { PLUGIN_PORT_ENV } from "../shared/plugin-contract.js";
import { COMPOSE_OVERRIDE_FILE, sessionStateDirForWorkspace } from "./session-state-dir.js";
import {
  ServiceSecretsResolver,
  type SecretsStatusInternalSnapshot,
  type DockerSecretsConfig,
} from "./service-secrets-resolver.js";
import type { PluginCredentialDeclaration } from "../shared/plugin-credentials.js";
import { ServicePoller } from "./service-poller.js";
import { ServiceRetryManager } from "./service-retry-manager.js";
import { serializeStackOp } from "./stack-op-queue.js";
import { markStackUp, forgetStackUp } from "./preview-timing.js";
import { removeSessionServiceEnvDir, removeSessionSecretsDir } from "./secret-resolver.js";
import {
  ComposeCli,
  composeSpawnEnv,
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
  /**
   * The container port the service serves on AND the preview origin it answers
   * at (`{sessionId}--{port}.<host>`) — one number for every service, the
   * project's own and a plugin's alike (docs/266-plugin-service-ports req 10).
   *
   * A plugin service used to carry a second, pinned number, because its
   * fragment declared the port and a tracked-branch commit could move it behind
   * the session's back. The port is now written in the consuming project's
   * `plugins.use` entry (docs/266-plugin-service-ports req 2), so it moves only when the consumer
   * moves it — the same guarantee a project service always had, by the same
   * means — and the indirection is gone.
   *
   * Uniqueness is enforced where each pair can actually be judged: two plugin
   * services are refused at declaration parse (`plugin-compose.ts`), and a
   * plugin against one of the project's own is refused here, against the parse
   * that really runs ({@link refusePluginPortCollisions}). Two of the project's
   * OWN services sharing a port stays a warning — both definitions are the
   * user's and ShipIt moves neither.
   */
  port?: number;
  preview: "auto" | "manual";
  status: ServiceStatus;
  error?: string;
  /** docs/262 req 3 — the plugin this service came from, when it is not the project's own. */
  origin?: ComposeServiceOrigin;
  /**
   * Whether this service is gated on `agent.install` completing before it
   * starts (`x-shipit-depends-on-install`). Defaults to `true` for
   * `auto`-preview services. See docs/137-depends-on-install.
   */
  dependsOnInstall: boolean;
  /**
   * The service's declared `stop_grace_period` in ms, when it has one. Carried
   * from the parse so the re-install teardown can bound its wait on what THIS
   * file says a stop may take rather than on Compose's default — see
   * {@link gatedTeardownTimeoutMs}.
   */
  stopGracePeriodMs?: number;
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
 * Everything a port-conflict message needs about one of the two parties: what
 * to call it, and — through `origin` — which file its number is written in
 * (nikzlabs/shipit#2379). A registered service satisfies it; so does a bare
 * `{ name }`, which is how the project's own side is passed before the row for
 * it exists.
 */
type PortHolder = Pick<ManagedService, "name" | "origin">;

/**
 * docs/262 — project a service's origin into the shape the client sees. The
 * fragment's own service name is deliberately dropped: it is what the collision
 * message needs (it names the key to write `as` under) and not something the
 * browser has any use for.
 */
export function originView(origin: ComposeServiceOrigin): ComposeServiceOriginView {
  return { kind: "plugin", repo: origin.repo, alias: origin.alias, plugin: origin.plugin };
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
 * How long between checks that a plugin service is actually listening on the
 * port the consuming project gave it (docs/266-plugin-service-ports req 8) — the wait before the
 * first check, and between retries.
 *
 * A container is `running` the moment its entrypoint execs, which for a
 * `sh -c "npm ci && node server.js"` service is a long way before anything
 * binds. So the answer is not read from one check: see
 * {@link PLUGIN_PORT_PROBE_ATTEMPTS}.
 */
export const PLUGIN_PORT_PROBE_DELAY_MS = 45_000;

/**
 * How many refusals in a row before ShipIt says nothing is listening.
 *
 * A single check at a fixed deadline was wrong in exactly the case the delay
 * above exists for: `npm ci` routinely outruns 45s, so the probe would report a
 * plugin that binds fine at 60s — and because the verdict was recorded and
 * never revisited, that wrong diagnosis sat in the Logs panel for the rest of
 * the session. Retrying makes the report mean "still not listening after
 * ~6 minutes", which a slow install no longer trips.
 *
 * A service that answers is marked confirmed and never probed again, so the
 * steady-state cost is nothing rather than a connect every poll.
 */
export const PLUGIN_PORT_PROBE_ATTEMPTS = 8;

/** How long the probe waits for the connection itself. Same-host, so short. */
export const PLUGIN_PORT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Does anything accept a TCP connection at `host:port`?
 *
 * A connect-and-close, not a request: the question is only whether the plugin's
 * server bound the port it was told to, and any protocol answers that.
 */
function tcpAccepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

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
 * Slack added on top of a service's `stop_grace_period` before the mid-session
 * re-install teardown gives up waiting for its `docker compose stop`.
 *
 * `releaseInstallGate` awaits that teardown, and the await is what makes the
 * teardown's own SIGKILL land while the service is still gated (docs/239). But
 * `docker compose stop` has no timeout of its own, so a wedged daemon turned
 * that deliberate wait into a permanent one: services stopped by our teardown,
 * sitting in `gatedServices`'s exit-reporting blind spot not for a bounded
 * window but forever, and no recovery path able to see them. That is the second
 * route to the docs/283 symptom.
 *
 * A FIXED bound was the first attempt and was wrong: it encoded Compose's
 * DEFAULT grace period (10s) as though it were the rule, but `stop_grace_period`
 * is a per-service key with no upper bound — and one ShipIt explicitly passes
 * through (`plugin-compose.ts`). A repo declaring `stop_grace_period: 1m30s`
 * would have had its perfectly healthy teardown declared wedged, reopening the
 * gate into a container still shutting down: precisely the docs/239 bug, now
 * caused by its own fix. Review finding.
 *
 * So the bound is derived per teardown ({@link gatedTeardownTimeoutMs}) and this
 * is only the margin on top, covering daemon round-trips and the CLI's own
 * startup — the part that is genuinely ShipIt's to estimate.
 */
export const GATED_TEARDOWN_GRACE_MARGIN_MS = 60_000;

/**
 * How long the install gate must look wedged — services held, no install in
 * flight, no teardown pending — before {@link ServiceManager.checkInstallGateLiveness}
 * reopens it (docs/286).
 *
 * The gate is a bracket: `holdGatedServicesForReinstall` closes it and a
 * matching `releaseInstallGate` opens it. Every route that loses the second
 * half leaves the same wreckage — `preview: auto` services stopped by our own
 * `docker compose stop` (exit 137, docs/239), sitting in `gatedServices` where
 * the poller's `isGated` skip and `handleNonZeroExit`'s gated early-return
 * deliberately ignore them, and where Compose's `restart: no` means nothing
 * else brings them back. docs/283 closed two such routes; a third was observed
 * in production afterwards, on a build that already carried that fix. So the
 * watchdog is deliberately written against the *state*, not against any
 * particular route: if nothing that could open the gate is in flight, no future
 * event will open it, and that is decidable without knowing which branch was
 * lost.
 *
 * Long enough that a legitimately in-progress bracket is never mistaken for a
 * wedge — the honest bound on one is a service's `stop_grace_period` plus
 * {@link GATED_TEARDOWN_GRACE_MARGIN_MS}, and the watchdog does not even start
 * its clock while that teardown is pending. Short enough that a wedge costs the
 * user a minute of dead preview rather than the rest of the session. This is a
 * backstop, not a participant: on a healthy bracket it never observes a wedge
 * at all.
 */
export const GATE_WATCHDOG_SETTLE_MS = 60_000;

/**
 * Await `work`, or give up after `ms` and say which happened.
 *
 * Reports the outcome instead of throwing on expiry because both outcomes are
 * ordinary here and the caller logs them differently — a timeout is not an
 * error the way a rejection is. `work` keeps running; only the waiting stops.
 * A rejection still propagates, so a caller that handles failure keeps doing
 * so. `Promise.race` leaves its handler attached to the loser, so a `work` that
 * rejects after the timeout won is handled rather than unhandled.
 */
async function settleOrTimeout(work: Promise<void>, ms: number): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = async (): Promise<"settled"> => {
    await work;
    return "settled";
  };
  const expire = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([settle(), expire]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  /**
   * Opens a container-topology bracket around every compose command — see
   * `ComposeCliOptions.onTopologyChange`. Wired to the session container
   * manager; absent when there is none (local/dogfood mode, tests).
   */
  onTopologyChange?: () => () => void;
  /** Status poll interval in ms. 0 disables polling. Default: 5000. */
  pollIntervalMs?: number;
  /**
   * How long the install gate must look wedged before the watchdog reopens it.
   * Default: {@link GATE_WATCHDOG_SETTLE_MS}. Overridable so tests can exercise
   * the watchdog without waiting out the production window — same role as
   * {@link pollIntervalMs}.
   */
  gateWatchdogSettleMs?: number;
  /** Docker named volume holding the workspace (for compose volume rewriting). */
  workspaceVolume?: string;
  /** Subpath within the workspace volume for this session. */
  workspaceSubpath?: string;
  /** Docker stack name (e.g. "shipit-dev") — propagated to compose labels for cleanup filtering. */
  stackName?: string;
  /**
   * docs/262 — this project declares no `compose:` block, so it HAS no compose
   * file of its own and its stack is its plugins' services alone (req 5). Off by
   * default; see {@link ComposeCliOptions.noProjectFile} for why this is not
   * "the file may be missing".
   */
  noProjectCompose?: boolean;
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
   * docs/262 req 23 — the credential NAMES this session's activated plugins
   * declare. Resolved inside the secret-sync pass against the same project
   * secret store the compose services use, and reported per plugin on
   * `secrets_status`. Names only: this never carries a value.
   */
  pluginCredentialsLoader?: () => PluginCredentialDeclaration[];
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
  service_status: [service: ManagedService];
  service_log: [serviceName: string, text: string];
  stack_ready: [];
  stack_error: [error: Error];
  /**
   * Emitted after each `syncSecrets()` pass (compose start, reconcile,
   * `refreshSecrets()`). Carries the full declared/missing/required snapshot
   * + the resolved `agent: true` values so the runner can push them into
   * the agent container without a follow-up call.
   */
  secrets_status: [snapshot: SecretsStatusInternalSnapshot];
}

// ---------------------------------------------------------------------------
// ServiceManager
// ---------------------------------------------------------------------------

export class ServiceManager extends EventEmitter<ServiceManagerEvents> {
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
  /**
   * nikzlabs/shipit#2426 — per-service `--since` anchor for the NEXT log follower
   * spawn: the instant an `up` for that service began. See
   * {@link armLogFollowerSince} and `streamLogs`.
   */
  private followerSince = new Map<string, string>();
  private readonly logStore?: LogStore;
  /** See {@link ServiceManagerOptions.gateWatchdogSettleMs}. */
  private readonly gateWatchdogSettleMs: number;
  private _started = false;
  /** docs/201 P8 — owns `docker compose` command construction + execution. */
  private readonly compose: ComposeCli;
  private readonly workspaceVolume?: string;
  private readonly workspaceSubpath?: string;
  /** docs/183 Phase 5 — per-session overlay dep-dir volumes (set lazily; see setOverlayDepDirs). */
  private overlayDepDirs: OverlayDepDirVolume[];
  /** docs/262 — plugin services this session surfaces (set lazily; see setPluginServices). */
  private pluginServices: PluginComposeService[] = [];
  /**
   * #2426 — the project's parsed compose services the override on disk was
   * generated from, serialized for comparison. `null` before the first
   * {@link writeOverrideFor}. Read by {@link overrideIsStaleFor} to tell a
   * compose edit that must reach the override from the far commoner case of an
   * unchanged file, which must rewrite nothing.
   */
  private _overrideProjectServices: string | null = null;
  /**
   * #2426 — the plugin services admitted into the override on disk.
   *
   * Carried forward verbatim by a mid-session override refresh rather than
   * re-derived, because admission is a decision {@link start} makes: a plugin
   * service is refused when it collides with a project port, and re-running that
   * against a half-changed picture would re-emit refusals nobody asked for. The
   * plugin set changes only via `setPluginServices`, whose caller reconciles.
   */
  private _overrideAdmittedPlugins: PluginComposeService[] = [];
  /** Port refusals from this start, held until the log followers are up. */
  private pendingPortRefusals: { service: string; message: string }[] = [];
  /**
   * Service name → why it was refused, for the CURRENT stack definition.
   * Rebuilt with the service map, so fixing the port clears it.
   */
  private portRefusals = new Map<string, string>();
  /** Pending one-shot "is it actually listening?" probes (docs/266-plugin-service-ports req 8). */
  private portProbeTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Services whose port question is answered — it bound, or it never will.
   * Either way the probe stops: this is a diagnosis, not a health check.
   */
  private portProbeSettled = new Set<string>();
  private readonly stackName?: string;
  private readonly opsSession: boolean;
  /**
   * docs/262 — this session has no project compose file at all: `shipit.yaml`
   * declares no `compose:` block, and the stack is its plugins' services (req 5).
   * A project that DOES declare one still fails loudly when its file cannot be
   * read.
   */
  private noProjectCompose: boolean;
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
   * planning#382 — why the project's own compose file yielded no services, when
   * that is the reason the list is empty.
   *
   * Deliberately NOT the same field as {@link startError}, which is every way a
   * stack can fail to start: an image pull that was denied, a port already
   * bound, a `compose up` that exited non-zero. This one is narrower and
   * classified — a file ShipIt could not understand (`malformed`) or one it
   * understood and DECLINED (`refused`, whose message names the rule and the one
   * line that fixes it). Only a failure of that shape can be reported as "your
   * compose file says X"; the rest are reported as stack errors and always were.
   *
   * Written by {@link parseProjectCompose} on both edges — set on a throw,
   * cleared on a parse that succeeds — so it describes the file as of the last
   * time ShipIt read it, not as of the last `start()`.
   */
  private _projectComposeFailure: ComposeFailure | null = null;
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
   * planning#2503 — is the gate currently latched by a FAILED install?
   *
   * Read by a caller deciding whether it may skip the `setInstallRunning`
   * bracket for an install that will not run. `_installFailed` is cleared only
   * by a false→true transition, and `checkInstallGateLiveness` deliberately
   * refuses to recover a gate it can see failed — so "no install ran, therefore
   * no transition" would strand latched services in `error` for the rest of the
   * session. Whoever skips the bracket has to ask first.
   */
  get installGateFailed(): boolean {
    return this._installFailed;
  }

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

  /**
   * Monotonic id of the newest gated-teardown cycle, and the id of the one
   * `_gatedTeardown` belongs to.
   *
   * `releaseInstallGate` awaits a teardown and then opens the gate, so its
   * callback runs at a moment that may belong to a LATER cycle: a second
   * hold/release bracket can start and store its own teardown while the first
   * is still stopping containers. The old callback re-checked only
   * `_installRunning`, which the newer bracket's release has already cleared,
   * so an older teardown could open a gate that is not its own — starting
   * services the newer teardown is in the middle of stopping. Comparing
   * generations is what makes an open provably belong to the cycle that
   * scheduled it. Raised by review on docs/283.
   */
  private _gateGeneration = 0;
  private _gatedTeardownGeneration = 0;

  /**
   * When the install gate started holding services, or `null` while it holds
   * none. Read once, at the moment the gate resolves, to report how much of the
   * user's "Starting…" was the install rather than the services themselves.
   */
  private _gateHeldSince: number | null = null;

  /**
   * Number of {@link releaseInstallGate} calls currently awaiting a teardown.
   *
   * `_gatedTeardown` cannot answer "is a release in flight?": the release
   * captures it and nulls the field on its first line, so for the whole of the
   * await — which can legitimately run for a service's `stop_grace_period` plus
   * {@link GATED_TEARDOWN_GRACE_MARGIN_MS} — the field reads `null` while the
   * bracket is very much still closing. The watchdog would call that a wedge and
   * reopen the gate mid-teardown, which is the docs/239 bug.
   *
   * A counter rather than a boolean because two releases can overlap (an older
   * cycle's release still awaiting its teardown when a newer one starts), and a
   * boolean cleared by whichever finishes first would un-hide the other.
   */
  private _gateReleasesInFlight = 0;

  /**
   * `Date.now()` of the first poll heartbeat at which the gate looked wedged,
   * or `null` while it does not. See {@link checkInstallGateLiveness}.
   */
  private _gateWedgedSince: number | null = null;

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
      ...(opts.noProjectCompose ? { noProjectFile: true } : {}),
      ...(opts.composeRunner ? { composeRunner: opts.composeRunner } : {}),
      ...(opts.composeQuery ? { composeQuery: opts.composeQuery } : {}),
      ...(opts.onTopologyChange ? { onTopologyChange: opts.onTopologyChange } : {}),
    });
    this.workspaceVolume = opts.workspaceVolume;
    this.workspaceSubpath = opts.workspaceSubpath;
    this.overlayDepDirs = opts.overlayDepDirs ?? [];
    this.stackName = opts.stackName;
    this.opsSession = opts.opsSession ?? false;
    this.noProjectCompose = opts.noProjectCompose ?? false;
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
    this.gateWatchdogSettleMs = opts.gateWatchdogSettleMs ?? GATE_WATCHDOG_SETTLE_MS;

    this.secrets = new ServiceSecretsResolver({
      sessionId: opts.sessionId,
      workspaceDir: opts.workspaceDir,
      ...(opts.secretsLoader ? { secretsLoader: opts.secretsLoader } : {}),
      ...(opts.accountAgentEnvLoader ? { accountAgentEnvLoader: opts.accountAgentEnvLoader } : {}),
      ...(opts.pluginCredentialsLoader ? { pluginCredentialsLoader: opts.pluginCredentialsLoader } : {}),
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
        // docs/266-plugin-service-ports req 8 — a plugin server that ignores the port ShipIt gave it
        // is broken under this rule, so the break has to be legible.
        this.armPluginPortProbe(name);
      },
      onLeftRunning: (name) => {
        this.retry.cancelOomStableTimer(name);
        this.retry.cancelPostGateStableTimer(name);
        this.cancelPluginPortProbe(name);
      },
      onExitedCleanly: (name) => {
        this.retry.clearRetryState(name);
        this.retry.clearOomBudget(name);
      },
      onExitedWithError: (name, exitCode, oomKilled) => {
        this.handleNonZeroExit(name, exitCode, oomKilled);
      },
      afterPoll: async () => {
        // Before the heal, so a heal that runs long can't delay the wedge
        // check behind it. Both are heartbeat work; neither owns the poll.
        this.checkInstallGateLiveness();
        await this.healSessionNetwork();
      },
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
   *
   * Returns whether the set actually CHANGED, for the same reason
   * {@link setPluginServices} does: the override is written by `start()` /
   * `reconcile()`, so a caller that re-points an already-running manager at a
   * different set (the `restartAgent` adoption path) has to reconcile for it to
   * reach the stack — and must NOT reconcile when the answer is identical, which
   * is the common case.
   */
  setOverlayDepDirs(overlayDepDirs: OverlayDepDirVolume[]): boolean {
    const changed = JSON.stringify(this.overlayDepDirs) !== JSON.stringify(overlayDepDirs);
    this.overlayDepDirs = overlayDepDirs;
    return changed;
  }

  /**
   * docs/262 — set the plugin services this session surfaces (reqs 3, 5, 16),
   * already located, validated and named by `plugin-compose.ts`.
   *
   * Resolved outside the manager for the same reason `setOverlayDepDirs` is: it
   * needs Docker and the session's plugin generations, neither of which this
   * class knows about. Returns whether the set actually CHANGED, so a caller can
   * skip the reconcile — an activation round settles on every session activation
   * and every `shipit.yaml` edit, and recreating live containers on each of them
   * would restart a plugin service that nothing happened to.
   */
  setPluginServices(services: PluginComposeService[]): boolean {
    const changed = JSON.stringify(this.pluginServices) !== JSON.stringify(services);
    this.pluginServices = services;
    return changed;
  }

  /**
   * The project compose file this manager reads, workspace-relative — the
   * `compose.file` `shipit.yaml` resolved to, which is any path the repository
   * chose and not necessarily a conventional name.
   *
   * Exposed for the runner's config-change detection: an edit to the file this
   * names is a configuration change whatever it is called, and a hard-coded list
   * of conventional filenames cannot know that (see
   * `ContainerSessionRunner.isConfigFileChange`).
   */
  get composeFilePath(): string {
    return this.composeConfig.file;
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
  /**
   * @returns whether this call actually moved the gate. A same-value call is
   *   ignored, so `false` means some OTHER caller owns the open bracket — the
   *   distinction a caller needs before it decides to close one (planning#2503).
   */
  setInstallRunning(running: boolean, opts: { failed?: boolean } = {}): boolean {
    if (this._installRunning === running) return false;
    const wasRunning = this._installRunning;
    this._installRunning = running;

    if (!wasRunning && running) {
      // Install (re-)starting. Clear the prior failure latch and, mid-session,
      // tear down + re-hold gated services so they relaunch against the fresh
      // dependency tree once install completes.
      this._installFailed = false;
      this.holdGatedServicesForReinstall();
      return true;
    }

    if (wasRunning && !running) {
      this._installFailed = opts.failed ?? false;
      this.releaseInstallGate();
      // Legacy safety net for opted-out / non-gated services that crashed
      // during the install window. Excludes gated services (handled above).
      this.flushPostInstallRetries();
    }
    return true;
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
    const generation = this._gatedTeardownGeneration;
    this._gatedTeardown = null;

    const open = (): void => {
      // Every branch here says which one it took. Until docs/286 the gate's
      // HOLD was logged unconditionally and its RELEASE was not, so a lost
      // release was completely invisible: the operator saw a `docker compose
      // stop` with no matching start and no reason anywhere, and diagnosing one
      // production incident took an hour to narrow to "one of five silent
      // returns" without ever identifying which. The watchdog below fixes the
      // class regardless of the branch; these lines are what make the NEXT one
      // take minutes.
      if (this._disposed) {
        console.log(
          `[compose:${this.sessionId}] install gate not opened — the manager was disposed while the teardown ran`,
        );
        return;
      }
      // A new install may have started while we waited for the teardown; that
      // re-held the services, and its own completion owns the next gate open.
      if (this._installRunning) {
        console.log(
          `[compose:${this.sessionId}] install gate not opened — a newer install is already running; its completion owns the next open`,
        );
        return;
      }
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
    // once the teardown lands. `stopGatedForReinstall` always settles — it
    // swallows a rejection and bounds a hang (docs/283).
    //
    // Counted for the whole await, INCLUDING `open()`: for as long as this is
    // non-zero the gate is legitimately mid-bracket and the watchdog must keep
    // its hands off (docs/239).
    this._gateReleasesInFlight++;
    void (async () => {
      try {
        await teardown;
        // Only THIS cycle's teardown may open the gate it scheduled. A newer
        // hold, or a full restart, has already superseded us — see
        // {@link _gateGeneration}.
        if (this._gateGeneration !== generation) {
          console.log(
            `[compose:${this.sessionId}] install gate not opened — this teardown belongs to gate ` +
            `generation ${generation}, superseded by ${this._gateGeneration}`,
          );
          return;
        }
        open();
      } finally {
        this._gateReleasesInFlight--;
      }
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

  /**
   * planning#382 — why {@link getServices} is empty, when the answer is the
   * project's own compose file rather than "nothing is declared".
   *
   * Read beside `getServices()` by every surface that renders the list, so an
   * empty list can state the reason instead of reading as an empty project. See
   * {@link _projectComposeFailure} for why this is not `startError`.
   */
  get projectComposeFailure(): ComposeFailure | null {
    return this._projectComposeFailure;
  }

  /** Get a specific service by name. */
  getService(name: string): ManagedService | undefined {
    return this.services.get(name);
  }

  /** Find the container IP for a service listening on the given port. */
  getContainerIpForPort(port: number): string | undefined {
    return this.resolvePreviewTarget(port)?.containerIp;
  }

  /**
   * Resolve a preview subdomain's port to the container address behind it.
   *
   * One pass over one number (docs/266-plugin-service-ports req 10). The subdomain's port IS the
   * container port, for a project service and a plugin service alike, so there
   * is nothing to map — the two-pass lookup this replaced existed only to carry
   * a plugin's pinned origin onto a container port the fragment could move.
   *
   * First match still wins, but the pair that made that dangerous is now
   * refused before it can be registered: two plugin services at declaration
   * parse, a plugin against the project's own in
   * {@link refusePluginPortCollisions}. What can still reach here is two of the
   * project's OWN services on one port, which {@link warnOnAmbiguousPreviewPorts}
   * reports and ShipIt deliberately does not resolve.
   */
  resolvePreviewTarget(port: number): { containerIp: string; port: number } | undefined {
    for (const svc of this.services.values()) {
      if (svc.port === port && svc.containerIp) {
        return { containerIp: svc.containerIp, port };
      }
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
          // planning#371 — `logs` names the project compose file too, so Compose
          // parses and interpolates it here exactly as `up` does.
          env: composeSpawnEnv(),
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
   * Say so when two services end up claiming one preview routing key (#2325).
   *
   * Two ways to get one. The project's own file can declare the same container
   * port on two of its services — legal Compose, since ShipIt strips host
   * bindings and each container keeps its own port — and ShipIt moves neither,
   * because a project service's port IS its origin *and* its container port (the
   * number the user wrote is the number they get) and both definitions belong to
   * the one person who can change them. Or a plugin service can arrive holding
   * the project's number, which the user cannot fix at all: it comes from the
   * plugin's fragment, and the consuming project has no override for it. That
   * second one is a design mistake being corrected in planning#395 — the port
   * becomes the consuming project's to declare — and until it is, this is the
   * only thing that says the collision happened.
   *
   * Either way {@link resolvePreviewTarget} answers with the first of the two.
   * "The pane shows the wrong service" is not a symptom anyone traces back to a
   * port on their own, so this is what turns it into one.
   *
   * **It goes to the user, not only to operator stderr** (review finding). The
   * condition is one the user has to act on — change a port, or stop importing
   * the plugin — and a `console.warn` in the orchestrator's own output is not
   * somewhere they can see, which would leave the pane silently serving the
   * wrong app with the explanation on a machine they do not have. It rides the
   * unreachable service's own log channel, so it lands in the Logs panel beside
   * that service, and is logged for the operator too.
   */
  private warnOnAmbiguousPreviewPorts(): void {
    const claimedBy = new Map<number, PortHolder>();
    for (const svc of this.services.values()) {
      if (svc.port === undefined) continue;
      const first = claimedBy.get(svc.port);
      if (first === undefined) {
        claimedBy.set(svc.port, svc);
        continue;
      }
      const message = `${this.describePortHolder(first)} and ${this.describePortHolder(svc)}`
        + ` both preview on port ${svc.port} — the preview pane can only reach ${first.name} there.`
        + ` Give one of them a different port: ${this.portChangeAdvice(svc)},`
        + ` or ${this.portChangeAdvice(first)}.`;
      this.reportPortConflict(svc.name, message);
    }
  }

  /**
   * Name a service and say where the number it previews on is written
   * (nikzlabs/shipit#2379).
   *
   * A port conflict is only actionable if the reader can find both numbers, and
   * the two kinds of service keep theirs in different files: the project's own
   * in its compose file, a plugin's in the consuming project's `plugins.use`
   * entry (docs/266-plugin-service-ports req 2). A message that assumes the
   * compose file for both sends the reader to a file that does not contain the
   * line — the dead end #2379 reports — so every port message routes its advice
   * through here instead of naming a file itself.
   */
  private describePortHolder(svc: PortHolder): string {
    if (!svc.origin) return `this project's own service \`${svc.name}\` (\`${this.composeConfig.file}\`)`;
    return `the plugin service \`${svc.name}\` (the \`plugins.use\` entry in \`shipit.yaml\``
      + ` whose alias is \`${svc.origin.alias}\`)`;
  }

  /**
   * How to move {@link describePortHolder}'s service off its port, in the file
   * that holds it. Both files are named outright — a reader who has never
   * written a `plugins.use` entry cannot be expected to know which file it is
   * in, and the compose file is named on the other side of the same sentence.
   */
  private portChangeAdvice(svc: PortHolder): string {
    if (!svc.origin) return `give \`${svc.name}\` a different port in \`${this.composeConfig.file}\``;
    return `change \`port:\` for \`${svc.origin.sourceName}\` under the \`plugins.use\` entry`
      + ` in \`shipit.yaml\` whose alias is \`${svc.origin.alias}\``;
  }

  /**
   * docs/266-plugin-service-ports req 7 — refuse a plugin service whose port one of the project's
   * own services already serves, and say which two claim it.
   *
   * Refused rather than moved. Both numbers are the consuming project's now:
   * one in its compose file, one in its `plugins.use` entry. That is what makes
   * a refusal actionable, and it is the whole difference from #2325, where the
   * port came from the plugin's fragment and the reader had nothing to change.
   *
   * The service is still REGISTERED, carrying the reason — dropping it silently
   * would leave the Services list one row short with no explanation anywhere.
   * It is registered `manual` so the auto-start sweep below does not flip it out
   * of `error`, and it is kept out of the generated override, so nothing starts.
   *
   * **The occupant is named from the current parse, and its declaration site is
   * named with it** (nikzlabs/shipit#2379). The message used to assert "this
   * project's own service" about whatever held the port in a map that outlives
   * an activation, so it could name the refused service's own outgoing instance
   * — a service the project never declared, on a port nothing was using. The
   * caller now reads the occupant out of `parsedServices` (see `start()`), so
   * the attribution is structurally true, and both halves of the advice point
   * at a line that exists.
   */
  private refusePluginPortCollision(svc: PluginComposeService, projectService: string): void {
    const origin: ComposeServiceOrigin = {
      kind: "plugin",
      repo: svc.repo,
      alias: svc.alias,
      plugin: svc.plugin,
      sourceName: svc.sourceName,
      self: svc.self,
    };
    const occupant: PortHolder = { name: projectService };
    const message = `${svc.name} is given port ${svc.port}. That port is already served by `
      + `${this.describePortHolder(occupant)}. Two services cannot preview on one port, so `
      + `${svc.name} was not started. Either ${this.portChangeAdvice({ name: svc.name, origin })}, `
      + `or ${this.portChangeAdvice(occupant)}.`;
    // Queued, not reported here. This runs while the service map is being
    // built, and `start()` clears the log ring buffers after that — a line
    // written now would reach the live viewers and then vanish from the buffer
    // a reader who opens the panel later reads. Drained in `reportPortRefusals`,
    // at the one point that is safe (see its call site).
    this.pendingPortRefusals.push({ service: svc.name, message });
    this.portRefusals.set(svc.name, message);
    this.services.set(svc.name, {
      name: svc.name,
      preview: "manual",
      status: "error",
      error: message,
      dependsOnInstall: false,
      origin,
    });
  }

  /**
   * docs/266-plugin-service-ports req 8 — check that a plugin service is actually listening on the
   * port the consuming project gave it, and say so when it is not.
   *
   * The rule that makes this necessary is docs/266-plugin-service-ports req 3: the port is the
   * consumer's, delivered to the container as `SHIPIT_PLUGIN_PORT`, so a plugin
   * whose server hardcodes its own number is broken. Broken silently, without
   * this: the container is `running`, the service list shows it green, the
   * preview pane is simply empty, and nothing anywhere names the cause. The
   * consumer cannot fix the plugin's code, but they can only report it if they
   * know — so this is the difference between a bug report and a shrug.
   *
   * **Retried, then settled.** A server binds some time after its container is
   * `running`, so one check at a fixed deadline answered the wrong question: it
   * reported plugins that were merely slow, and the verdict stuck. So a refusal
   * re-arms up to {@link PLUGIN_PORT_PROBE_ATTEMPTS} times, and the report means
   * "still nothing after all of them". An accepted connection settles the
   * service for good — confirmed services are never probed again, so this
   * costs nothing in the steady state even though `onRunning` fires every poll.
   */
  private armPluginPortProbe(name: string, attempt = 1): void {
    const svc = this.services.get(name);
    // Plugin services only. A project service's port is the user's own compose
    // file — if it does not listen there, that is their code and their line.
    if (!svc?.origin || svc.port === undefined) return;
    if (this.portProbeSettled.has(name) || this.portProbeTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.portProbeTimers.delete(name);
      void this.probePluginPort(name, attempt);
    }, PLUGIN_PORT_PROBE_DELAY_MS);
    timer.unref();
    this.portProbeTimers.set(name, timer);
  }

  private cancelPluginPortProbe(name: string): void {
    const timer = this.portProbeTimers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.portProbeTimers.delete(name);
  }

  private async probePluginPort(name: string, attempt: number): Promise<void> {
    const svc = this.services.get(name);
    // Re-read rather than closing over the earlier snapshot: the service may
    // have stopped, been refused, or lost its IP while the timer was pending.
    if (!svc?.origin || svc.port === undefined || !svc.containerIp) return;
    if (svc.status !== "running" || this.portProbeSettled.has(name)) return;
    // Captured, because the probe itself takes time: a container replaced mid
    // probe would otherwise have the OLD container's refusal reported against
    // its name.
    const { containerIp, port } = svc;
    const accepted = await tcpAccepts(containerIp, port, PLUGIN_PORT_PROBE_TIMEOUT_MS);
    if (this._disposed) return;
    const now = this.services.get(name);
    if (now?.containerIp !== containerIp || now.port !== port || now.status !== "running") return;
    if (accepted) {
      this.portProbeSettled.add(name);
      return;
    }
    if (attempt < PLUGIN_PORT_PROBE_ATTEMPTS) {
      this.armPluginPortProbe(name, attempt + 1);
      return;
    }
    this.portProbeSettled.add(name);
    this.reportPortConflict(
      name,
      `${name} is running but nothing is listening on port ${port}, so its preview will be `
      + `empty. That port is this project's to choose and ShipIt passes it to the container as `
      + `${PLUGIN_PORT_ENV}; a plugin whose server binds a port of its own instead will not be `
      + `reachable. Report it to the \`${svc.origin.repo}\` plugin's authors.`,
    );
  }

  /**
   * Refuse a start of a service {@link refusePluginPortCollision} held back.
   *
   * The row is `error` and the client shows a Start button on every `error`
   * row, so without this the user can press it — and the service is not in the
   * generated override, so `docker compose up` fails with "no such service" and
   * the catch REPLACES the actionable "change `port:`…" text with that. They
   * would be one click from losing the only message that told them what to do.
   */
  private refusePluginPortStart(name: string): void {
    const reason = this.portRefusals.get(name);
    if (reason) throw new Error(reason);
  }

  /** Emit the refusals {@link refusePluginPortCollision} queued during this start. */
  private reportPortRefusals(): void {
    const pending = this.pendingPortRefusals;
    this.pendingPortRefusals = [];
    for (const { service, message } of pending) this.reportPortConflict(service, message);
  }

  /**
   * Put a port conflict where the person who has to act on it will see it.
   *
   * **The user, not only operator stderr** (docs/262 review finding). The
   * condition is one they have to fix, and a `console.warn` in the
   * orchestrator's output is not somewhere they can read. It rides the affected
   * service's own log channel, so it lands in the Logs panel beside that
   * service — both halves, like the log follower's own `handleData`: the
   * durable store is what a viewer who opens the panel later reads (the
   * in-memory ring buffer is wiped whenever a follower re-attaches), and
   * `bufferServiceLog` is what reaches the viewers already watching.
   */
  private reportPortConflict(service: string, message: string): void {
    console.warn(`[compose:${this.sessionId}] ${message}`);
    const line = `[shipit] ${message}\n`;
    this.logStore?.append(this.sessionId, `service:${service}`, line);
    this.bufferServiceLog(service, line);
  }

  /**
   * Initialize the compose stack:
   * 1. Parse and validate the compose file
   * 2. Generate the override file
   * 3. Start auto services via `docker compose up -d`
   *
   * @param opts.sweepStaleContainers Run the broad pre-start label sweep
   *   ({@link ComposeCli.killStaleContainers}). Defaults to `true` — the right
   *   answer for a COLD start, where every container carrying this session's
   *   label is by definition left over from a previous orchestrator run or a
   *   previous agent-container incarnation. {@link reconcile} passes `false`;
   *   see the note there for why.
   */
  async start(opts: { sweepStaleContainers?: boolean } = {}): Promise<void> {
    this._disposed = false;
    // Invalidate any in-flight gate release BEFORE the first await, not later
    // alongside the `_gatedTeardown` reset. Clearing `_disposed` on the line
    // above reopens the only guard such a callback has, and everything between
    // here and the service-map rebuild is awaited — so a teardown settling in
    // that window would find `_disposed === false` and its own generation still
    // current, and act on a half-rebuilt gate. Review finding.
    this._gateGeneration++;
    await this.ensureSessionNetworkModeFn?.(Boolean(this.containServicesFn));
    // Kill any stale compose containers left over from a previous orchestrator
    // run (e.g. ShipIt restart). Uses label filter — no compose files needed.
    if (opts.sweepStaleContainers ?? true) {
      try {
        await this.compose.killStaleContainers();
      } catch {
        // Best-effort cleanup
      }
    }

    const composePath = path.join(this.workspaceDir, this.composeConfig.file);

    // planning#382 — "there is no project file" is itself an answer about the
    // project file, and the only one that arrives without a parse. Placed after
    // the network preparation above so a throw there leaves the last real
    // answer standing rather than erasing it (review finding).
    if (this.noProjectCompose) this._projectComposeFailure = null;

    // docs/262 — a project may declare plugins and no stack of its own (req 5:
    // one declaration). There is then no project compose file to parse at all,
    // declared or otherwise, and the plugin services below are the whole stack.
    if (this.noProjectCompose && this.pluginServices.length === 0) {
      console.log(`[compose:${this.sessionId}] no project compose file and no plugin services — nothing to start`);
      this._startupComplete = true;
      return;
    }

    // Parse and validate
    const parsedServices = this.noProjectCompose
      ? []
      : this.parseProjectCompose(composePath);

    // Build service map.
    //
    // docs/266-plugin-service-ports req 7 — a plugin service given a port one of the project's OWN
    // services already serves is refused, and refused HERE: against
    // `parsedServices`, the parse that actually runs. The plugin resolver's
    // separate read of the same file is the thing that disagreed with the live
    // stack in #2325, so it must not be what decides this. Both numbers are the
    // consumer's own now — one in the compose file, one in `plugins.use` — so a
    // refusal naming both is something the reader can act on, which re-routing
    // silently was not.
    //
    // `parsedServices`, and NOT `this.services` (nikzlabs/shipit#2379). Only
    // `reconcile()` clears that map, while `start()` clears nothing, so a
    // second `start()` without one in between reads the PREVIOUS activation's
    // rows as occupants. Which caller does that in production was not pinned
    // down — the report is one activation, not a trace — and it does not need
    // to be: the map is the wrong SOURCE for this question whatever reaches it,
    // because it answers "what did this manager last register" and the question
    // is "what does the project's file declare now". Counting those made a
    // plugin service clash with its own outgoing instance, and the refusal then
    // named an occupant that is not in the project's file at all. The current
    // parse is the only set that can honestly answer "which of the project's
    // own services serves this port", which is exactly what the message claims,
    // so the claim is now true by construction rather than by filtering.
    this.portRefusals.clear();
    const projectPorts = new Map<number, string>();
    for (const svc of parsedServices) {
      const preview = svc.shipitPreview ?? (svc.ports?.length ? "auto" : "manual");
      const port = svc.ports?.[0] ? extractContainerPort(svc.ports[0]) : undefined;
      if (port !== undefined && !projectPorts.has(port)) projectPorts.set(port, svc.name);
      this.services.set(svc.name, {
        name: svc.name,
        port,
        preview,
        status: "stopped",
        dependsOnInstall: svc.dependsOnInstall ?? (preview === "auto"),
        ...(svc.stopGracePeriodMs !== undefined ? { stopGracePeriodMs: svc.stopGracePeriodMs } : {}),
      });
    }
    const admittedPlugins = this.pluginServices.filter((svc) => {
      const clash = svc.port !== undefined ? projectPorts.get(svc.port) : undefined;
      if (clash === undefined) return true;
      this.refusePluginPortCollision(svc, clash);
      return false;
    });

    // docs/262 reqs 3, 16 — plugin services join the same map, so every control,
    // status and log path treats them as the first-class services req 3 asks
    // for. `dependsOnInstall` is the plugin's own answer and must agree with the
    // one the override carries (`toComposeService`, which states why the two
    // cases differ): a tracked plugin ran its install before its generation was
    // published, while a `repo: self` plugin has no install of its own and runs
    // out of the tree `agent.install` writes.
    for (const svc of admittedPlugins) {
      this.services.set(svc.name, {
        name: svc.name,
        ...(svc.port !== undefined ? { port: svc.port } : {}),
        preview: svc.preview,
        status: "stopped",
        dependsOnInstall: svc.self,
        origin: {
          kind: "plugin",
          repo: svc.repo,
          alias: svc.alias,
          plugin: svc.plugin,
          sourceName: svc.sourceName,
          self: svc.self,
        },
      });
    }
    await this.writeOverrideFor(parsedServices, admittedPlugins);

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
    // is being brought up from scratch, so the gate must not wait on it. The
    // matching generation bump already happened at the top of `start()`, before
    // any await could let a pending release slip through.
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
    // The gate set was just rebuilt, so the hold starts now. Not after a FAILED
    // install: those services were latched to `error` above and are waiting for
    // nothing, so there is no duration to measure (review finding).
    this._gateHeldSince = this.gatedServices.size > 0 && !this._installFailed ? Date.now() : null;

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
          this.armLogFollowerSince(autoNames);
          await this.compose.up(autoNames, this.composeLogSink(autoNames));
          // Before the containment below: from here the dev server is booting,
          // and the proxy's first answered request stops this clock.
          markStackUp(this.sessionId, startNow);
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
      // Every service now has a follower, so any anchor still armed belongs to
      // one that was already alive and has nothing to replay.
      this.disarmLogFollowerSince([...this.services.keys()]);

      // AFTER the followers, which is the one ordering constraint on it: this
      // writes to a service's durable log channel, and a channel that already
      // has content makes the follower spawn with `--tail 0` instead of
      // replaying the container's backlog. The followers above have made that
      // decision by the time we get here.
      this.reportPortRefusals();
      this.warnOnAmbiguousPreviewPorts();

      this.emit("stack_ready");
    } catch (err) {
      this._startupComplete = true;
      const error = err instanceof Error ? err : new Error(String(err));
      // Only the services we actually tried to start reflect this failure.
      // Gated services are intentionally held by the install gate (which is
      // still pending) — don't clobber their held status with a stack error
      // that's about the services we brought up.
      for (const svc of startNow) {
        this.updateServiceStatus(svc.name, "error", error.message);
      }
      // A refused port is not a consequence of THIS failure and outlives it —
      // the plugin service is still held back, and the reason is still the only
      // thing telling the user what to change. The success path reports these
      // after the log followers attach; here there may be no followers at all,
      // and saying it late beats not saying it (review finding).
      this.reportPortRefusals();
      this.emit("stack_error", error);
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
    this.refusePluginPortStart(name);

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
        this.armLogFollowerSince([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // The user stopped this service while the `up` above was still running.
      // Theirs is the later instruction, and `stopService` is already waiting on
      // that `up` to stop whatever it produced — so finishing the start here
      // would only race it back to `running`. See `stopService`.
      if (this.stoppedByUser.has(name)) return;
      // BEFORE the network join and the poll, not after them (#2426). Both are
      // Docker round trips the fresh container spends printing, and this spawn
      // is what claims the `--since` anchor armed above — leaving it until last
      // let the poll's own `onRunning` → `ensureLogFollower` claim it first,
      // only for the unconditional respawn here to kill that follower and
      // re-attach with no anchor at all, losing the very window the anchor
      // exists to replay.
      this.streamLogs(name);
      // The first manual-service start is the moment the compose network
      // actually gets created (compose materializes the network on `up`,
      // not just when the file is parsed). If this stack is all-manual,
      // `start()`'s earlier `joinSessionNetwork()` no-op'd because the
      // network didn't exist yet — the orchestrator + agent container
      // still need to be attached or the preview proxy can't reach the
      // freshly-started container by IP. Idempotent on subsequent starts.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
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
    this.refusePluginPortStart(name);

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
        this.armLogFollowerSince([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // Stopped mid-restart — see `startService` for why this returns rather
      // than finishing the bring-up.
      if (this.stoppedByUser.has(name)) return;
      // Restart log streaming to pick up new container output — before the join
      // and the poll, for the reason spelled out in `startService`. This is the
      // path #2426 was filed against: a restarted service that prints its
      // diagnostics and exits produced nothing the reporter could see, which
      // read as "the `command:` edit was never applied".
      this.streamLogs(name);
      // Defensive: if a previous all-manual `start()` skipped the network
      // join (see startService comment), the first restartService after
      // adoption could be the first time the orchestrator gets attached.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
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
    // *seeds* the store via handleData) when the store has nothing yet.
    //
    // Once the store IS seeded, the window is anchored by {@link armLogFollowerSince}
    // instead (nikzlabs/shipit#2426). `--tail 0` alone loses everything the
    // container printed between `up` returning and this spawn — a network join
    // and a poll later — and there is nowhere left to recover it from: the ring
    // buffer was just cleared above, the store never received those lines, and
    // `snapshotLogs` prefers the store over a fresh `docker compose logs`. A
    // service that prints and then exits produced NO visible output at all,
    // which is how a reporter concluded a `command:` edit had not been applied
    // when in fact it had. `--since <up-start>` replays exactly that gap.
    //
    // It cannot duplicate persisted history: the anchor is stamped immediately
    // before each `up`, so it excludes everything an earlier follower recorded,
    // and a follower only ever dies with its container — whose logs go with it.
    // `--tail 1000` rides along purely to bound a container that floods the gap.
    // With no anchor (a follower re-attached without an intervening `up`) the
    // behavior is unchanged: follow new lines only.
    const channel = `service:${name}`;
    const seeded = this.logStore?.hasChannel(this.sessionId, channel) ?? false;
    // Consumed, not just read: an anchor left behind would widen a later
    // unrelated re-attach's window for no gain.
    const since = this.followerSince.get(name);
    this.followerSince.delete(name);
    const window = this.logStore && seeded
      ? (since ? ["--since", since, "--tail", "1000"] : ["--tail", "0"])
      : ["--tail", "1000"];

    const args = this.compose.args("logs", "-f", ...window, "--no-log-prefix", name);
    const proc = spawn("docker", args, {
      cwd: this.workspaceDir,
      // planning#371 — same project file, same interpolation. See `composeSpawnEnv`.
      env: composeSpawnEnv(),
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
   * Stamp the moment an `up` begins, so the log follower that attaches after it
   * replays the window between the two instead of starting from "now"
   * (nikzlabs/shipit#2426). Called by EVERY path that runs `docker compose up`,
   * immediately before the command — the initial stack start, a manual
   * start/restart, the gated batch, a crash/OOM retry, and the secrets refresh.
   *
   * Uniform on purpose: a container recreated by any of them gets a follower
   * from a different place (`onRunning` covers the automatic routes,
   * `startService`/`restartService` spawn their own), and each one needs the
   * same window. Stamping at the `up` rather than at the spawn is what makes the
   * anchor exclude everything an earlier follower already persisted.
   *
   * Full ISO-8601 with milliseconds: `--since` is compared against daemon-side
   * log timestamps, and second precision would let a restart replay the outgoing
   * container's final lines.
   */
  private armLogFollowerSince(names: readonly string[]): void {
    const at = new Date().toISOString();
    for (const name of names) this.followerSince.set(name, at);
  }

  /**
   * Drop any anchor the `up` did not end up needing, once the follower question
   * is settled for these services.
   *
   * An anchor is claimed by the next follower SPAWN, and an `up` does not always
   * produce one: `docker compose logs -f` follows its service across a container
   * the `up` merely creates, so a follower that was already alive stays alive and
   * the anchor is left armed. It would then be claimed much later, by a re-attach
   * after some unrelated death — replaying a window the durable store already
   * holds, i.e. duplicating history.
   *
   * Called AFTER the poll, never right after the `up`. The poll is where
   * `onRunning` re-attaches a follower to a container the `up` REPLACED, and that
   * spawn is the one the anchor exists for — a crash retry losing its restart
   * output is the same bug as a manual restart losing it. By the time the poll has
   * run, an anchor still sitting here means a follower survived, which is exactly
   * the case with nothing to replay.
   */
  private disarmLogFollowerSince(names: readonly string[]): void {
    for (const name of names) this.followerSince.delete(name);
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
  updateComposeConfig(next: ComposeConfig, opts: { noProjectCompose?: boolean } = {}): boolean {
    const noProjectCompose = opts.noProjectCompose ?? false;
    const changed =
      next.file !== this.composeConfig.file ||
      next.dockerSocket !== this.composeConfig.dockerSocket ||
      // docs/262 — a `compose:` block added to (or removed from) a plugin-only
      // project changes whether there is a project file at all, which changes
      // the argument vector every later command is built from.
      noProjectCompose !== this.noProjectCompose;
    if (!changed) return false;
    this.composeConfig = next;
    this.noProjectCompose = noProjectCompose;
    this.compose.setComposeFile(next.file, noProjectCompose);
    // planning#382 — the recorded failure describes the file we are no longer
    // reading, or the security interpretation we are no longer reading it
    // under. Dropped HERE rather than left for the reconcile the caller queues
    // asynchronously afterwards: that gap is an observable window in which the
    // service list quotes a rule against a file the project has stopped
    // declaring. Review finding.
    this._projectComposeFailure = null;
    return true;
  }

  /**
   * Reconcile the compose stack after a config change.
   * Re-parses the compose file, regenerates the override, and runs `up -d`.
   *
   * **Without the pre-start stale-container sweep**, deliberately. The sweep is
   * `docker rm -f` over every container labelled with this session id — and on a
   * reconcile of a RUNNING stack, that set is the session's own healthy preview
   * containers. They were force-removed with no SIGTERM at all, so every edit to
   * `docker-compose.yml` or `shipit.yaml` killed the preview with exit 137 and
   * the user got a crash they had to wait out. `upWithConflictRecovery`'s
   * docstring already records this exact over-aggressiveness being found once
   * before (efa1ec150 / docs/127-restart-agent); the surgical conflict recovery
   * was added in response, but the sweep was never taken off this path, so the
   * original behaviour stayed live until it was re-diagnosed against a841e147.
   *
   * A reconcile does not need it. Compose owns the transition from the old
   * definition to the new one: it recreates the services whose config changed,
   * leaves the untouched ones running, and `--remove-orphans` drops containers
   * the project no longer declares. The one case the sweep was covering here —
   * a container whose name blocks the create because compose won't adopt it —
   * is exactly what `upWithConflictRecovery` handles, by id, without touching
   * the working stack.
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
    this.cancelPluginPortProbes();
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
    // planning#382 — deliberately NOT cleared here, unlike `startError`. This
    // field is only ever written by an ANSWER about the file: a parse that
    // threw, or one that succeeded. Clearing it optimistically at the top of a
    // reconcile looks equivalent and is not, because `start()` can throw before
    // it reaches the parse (`ensureSessionNetworkModeFn`) — the record would
    // then be gone while the file is still refused, and the list would go back
    // to reading as an empty project. `start()` clears it on the one path where
    // no parse will happen at all (`noProjectCompose`), which is the case this
    // was reaching for. Review finding.
    await this.start({ sweepStaleContainers: false });
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
    this.cancelPluginPortProbes();
    this.postGateServices.clear();
    this._gatedTeardown = null;
    this._gateHeldSince = null;
    forgetStackUp(this.sessionId);

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
  /**
   * docs/262 req 23 — re-resolve the secrets snapshot and re-publish it,
   * touching NO containers.
   *
   * Called when a plugin activation round settles: the set of credential names
   * the session's plugins declare comes from each repository's live manifest,
   * so a first activation (or a refresh that renames a credential) changes the
   * answer, and nothing else would resample it until an unrelated reconcile or
   * secret save. `refreshSecrets()` is the wrong tool for that — it re-runs
   * `compose up` for every auto service, so a plugin refresh would restart the
   * user's app. This is the same sync pass without that half: values are
   * unchanged, so the env files it rewrites are byte-identical and compose has
   * nothing to react to.
   *
   * A compose file that will not parse returns early rather than syncing an
   * empty service list — passing `[]` would sweep the env files of the
   * services that are still running.
   */
  async refreshSecretsStatus(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      // planning#382 — through `parseProjectCompose`, not a second inline copy
      // of the same call with the same options. This runs when a plugin
      // activation round settles, so it is a real read of the project's file
      // and must move the record like every other one: an inline copy neither
      // recorded a refusal it discovered NOR retracted one the user had since
      // fixed, which is a stale reason nothing would clear. Review finding.
      //
      // `noProjectCompose` short-circuits for the reason `refreshSecrets` has
      // it: a plugin-only project has no file to read, so parsing the path
      // anyway would both fail and file a `malformed` reason against a project
      // that declares no stack. Passing `[]` is safe here precisely because
      // there are no project services whose env files it could sweep.
      parsedServices = this.noProjectCompose
        ? []
        : this.parseProjectCompose(path.join(this.workspaceDir, this.composeConfig.file));
    } catch {
      return;
    }
    await this.secrets.sync(parsedServices, this.pluginServices);
  }

  async refreshSecrets(): Promise<void> {
    let parsedServices: ComposeService[];
    try {
      parsedServices = this.noProjectCompose
        ? []
        : this.parseProjectCompose(path.join(this.workspaceDir, this.composeConfig.file));
    } catch {
      // Compose file missing or invalid — there's nothing to apply secrets to.
      return;
    }
    await this.secrets.sync(parsedServices, this.pluginServices);

    // In Docker-secrets mode the override file references which secrets each
    // service consumes — so a change to the set of declared secrets (or to
    // `agent: true` flags) requires regenerating the override. In env-file
    // mode, the override only references the env file PATH, so the file
    // content can change without regenerating. We always regenerate when
    // Docker-secrets mode is active to be safe.
    //
    // docs/262 req 23 — and whenever this session surfaces PLUGIN services,
    // whatever the project's mode, because their credential VALUES live in the
    // override itself rather than behind a stable path. Without this a user
    // saving the key a plugin declared would rewrite nothing the plugin can
    // see, and the card would report it satisfied against a container started
    // before it existed. That is the same disagreement req 23 forbids, one
    // rebuild later.
    const dockerSecretsBuild = this.secrets.getDockerSecretsBuild();
    if (dockerSecretsBuild || this.pluginServices.length > 0) {
      // docs/262 — plugin services must survive this rewrite: the override is
      // the ONLY place their definitions exist, so regenerating it from the
      // project's services alone would delete them from the stack on the next
      // secret save.
      const overrideContent = generateComposeOverride(
        [...parsedServices, ...this.pluginServices.map(toComposeService)],
        this.buildOverrideOptions(),
      );
      writeComposeOverride(this.overrideDir, overrideContent);
      // #2426 — the override on disk now reflects THIS parse, so say so, or
      // `overrideIsStaleFor` would call for a rewrite on the next `up` and
      // recreate every service whose config that changed. Only the
      // project half is recorded: this path deliberately uses `pluginServices`
      // rather than the admitted set (see `writeOverrideFor`), so it is not
      // evidence about what was admitted.
      this._overrideProjectServices = JSON.stringify(parsedServices);
    }

    if (!this._started) return;
    // Re-run `up -d` for the auto services so compose recreates containers
    // whose env_file content changed. Manual services aren't restarted —
    // they're only running if the user explicitly started them. That applies
    // unchanged to a plugin's manual service (docs/262 req 23): its container
    // keeps the values it started with until something restarts it, so the
    // Plugins card can lead the container until then.
    const autoNames = [...this.services.values()]
      .filter(s => s.preview === "auto")
      .map(s => s.name);
    if (autoNames.length === 0) return;
    try {
      await this.withUpInFlight(autoNames, async () => {
        await this.prepareContainedStartFn?.(autoNames);
        this.armLogFollowerSince(autoNames);
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
      this.disarmLogFollowerSince(autoNames);
    } catch (err) {
      console.warn(`[compose:${this.sessionId}] refreshSecrets compose up failed:`, (err as Error).message);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Every option the compose override is generated from, in ONE place.
   *
   * The two generation sites — `start()` and `refreshSecrets()` — used to build
   * this object separately, and `refreshSecrets()` omitted `serviceEnvFiles`.
   * That was invisible for as long as its regeneration branch was
   * Docker-secrets-only (that mode delivers via `secrets:`, so the omitted
   * option is genuinely unused). docs/262 widened the branch to
   * `dockerSecretsBuild || this.pluginServices.length > 0`, and from then on any
   * session surfacing a plugin service rewrote its override on every secret
   * save WITHOUT the `env_file:` entries — silently stripping every project
   * service's `x-shipit-secrets` delivery, for the whole session, with no error
   * anywhere. The dogfood `dev` service simply stopped receiving `GITHUB_TOKEN`
   * and every provider key.
   *
   * So the fix is not "add the missing line back": it is that there is no
   * second place to forget it. What this does NOT establish is atomicity: it
   * reads the resolver's live state through its getters, and override writers
   * are not serialized against each other (`refreshSecrets()` is called
   * fire-and-forget per session from two places), so a concurrent pass can land
   * between the `sync()` a caller awaited and the read here. That race predates
   * this and is not what stripped the env files; it is called out so the shape
   * of the guarantee is not overstated — every option comes from ONE place, not
   * from one instant.
   */
  private buildOverrideOptions(): ComposeOverrideOptions {
    const composePath = path.join(this.workspaceDir, this.composeConfig.file);
    const dockerSecretsBuild = this.secrets.getDockerSecretsBuild();
    const serviceEnvFiles = this.secrets.getServiceEnvFiles();
    const pluginServiceEnv = this.secrets.getPluginServiceEnv();
    return {
      sessionId: this.sessionId,
      composeConfig: this.composeConfig,
      workspaceVolume: this.workspaceVolume,
      workspaceSubpath: this.workspaceSubpath,
      stackName: this.stackName,
      userNamedVolumes: parseUserNamedVolumes(composePath),
      ...(this.containServicesFn ? { containEgress: true } : {}),
      ...(this.containServiceDns ? { containDns: true } : {}),
      ...(this.containServiceProxy ? { containProxy: true } : {}),
      ...(dockerSecretsBuild ? { dockerSecrets: dockerSecretsBuild } : {}),
      ...(serviceEnvFiles ? { serviceEnvFiles } : {}),
      ...(pluginServiceEnv ? { pluginServiceEnv } : {}),
      ...(this.overlayDepDirs.length > 0 ? { overlayDepDirs: this.overlayDepDirs } : {}),
    };
  }

  /**
   * Parse and security-validate the project's own compose file.
   *
   * One place, because it is re-run before every `docker compose up` (see
   * {@link withUpInFlight}) and not only at `start()`. docs/262 is what forces
   * that: plugin services get the project workspace read-write at `/project`
   * (reqs 18, 21), so third-party code can now REWRITE this file — and every
   * later `up` (a manual start, a restart, an OOM or install retry, the gate
   * release) re-reads it from disk. Validating it only at `start()` left a
   * window in which a rewritten file was executed with none of the checks it
   * was admitted under: `privileged: true`, a Docker-socket bind, an absolute
   * host path. The file is small and the parse is cheap; the window is not.
   */
  private parseProjectCompose(composePath: string): ComposeService[] {
    try {
      const parsed = parseComposeFile(composePath, {
        dockerSocket: this.composeConfig.dockerSocket || this.opsSession,
        containEgress: Boolean(this.containServicesFn),
        trustedOpsProxy: this.opsSession,
      });
      // planning#382 — a parse that succeeds RETRACTS the last failure. This is
      // the one place the project's compose file is turned into services, so it
      // is also the only place that can say the reason no longer applies: the
      // same re-parse runs before every `up` (see the docstring above), so a
      // file the user has since fixed clears the record without waiting for a
      // reconcile.
      this._projectComposeFailure = null;
      return parsed;
    } catch (err) {
      // planning#382 — the reason is RECORDED here rather than only thrown,
      // because the throw reaches exactly one surface. `start()` propagates it
      // to `service-manager-setup.ts`, which turns it into `startError` and the
      // `compose_error` the Preview pane renders; every OTHER reader of this
      // session's services — `getServices()`, and through it
      // `GET /api/sessions/:id/services`, the agent bridge's `list` and
      // `shipit service list` — saw an empty map with nothing attached to it.
      // "No services" is the wrong answer to "why is this list empty" when the
      // truth is "refused, here is the line to add", and docs/263's containment
      // rules refuse a STOCK compose file, so it is the FIRST answer a project
      // not written for containment gets.
      this._projectComposeFailure = classifyComposeFailure(err);
      throw err;
    }
  }

  /**
   * Generate and write the compose override, and record what it was built from.
   *
   * The single writer, so the mid-session refresh in {@link withUpInFlight}
   * cannot drift from `start()` in either the inputs it feeds the generator or
   * the order it feeds them in. Secrets are resolved BEFORE the generator runs — the override
   * references per-service env files via `env_file:` and compose detects the
   * file at `up` time. The sync always runs (even with no secrets declared) so
   * stale files from a previous compose definition are cleared; docs/262 req 23
   * puts the plugin services through it too, since their declared credentials
   * are delivered by the same pass and the pass sweeps the files of plugin
   * services it is not told about.
   */
  private async writeOverrideFor(
    projectServices: ComposeService[],
    admittedPlugins: PluginComposeService[],
  ): Promise<void> {
    await this.secrets.sync(projectServices, admittedPlugins);
    const overrideServices = [...projectServices, ...admittedPlugins.map(toComposeService)];
    writeComposeOverride(
      this.overrideDir,
      generateComposeOverride(overrideServices, this.buildOverrideOptions()),
    );
    this._overrideProjectServices = JSON.stringify(projectServices);
    this._overrideAdmittedPlugins = admittedPlugins;
  }

  /**
   * Refuse to run `docker compose up` against a project compose file that no
   * longer passes validation — see {@link parseProjectCompose} for why it can
   * change under us. Throws the `ComposeValidationError` verbatim, so the
   * caller reports the real reason on the service it was starting.
   *
   * Returns the parse so {@link overrideIsStaleFor} and the refresh it gates can
   * use it rather than read the file a second time; `null` when this project has
   * no compose file of its own and there is nothing to validate.
   */
  private assertProjectComposeStillValid(): ComposeService[] | null {
    if (this.noProjectCompose) return null;
    return this.parseProjectCompose(path.join(this.workspaceDir, this.composeConfig.file));
  }

  /**
   * nikzlabs/shipit#2426 — has the compose file changed since the GENERATED
   * override was written? True means {@link withUpInFlight} regenerates it
   * before the `up`.
   *
   * The pre-`up` re-parse above was already happening and its result was thrown
   * away, which is the exact point where "the edit was never applied" became
   * true. `docker compose up` re-reads the user's file every time, so a
   * `command:` edit does land — but the override is written by
   * `start()`/`reconcile()` and by nothing else, and compose merges it OVER the
   * user's file. So every field the override derives — a service's `volumes:`
   * (which is where the workspace mount and its nested dep-dir overlays live),
   * `env_file:` from `x-shipit-secrets`, the user's named volumes — kept
   * whatever it held at the last full start, through any number of `shipit
   * service restart` cycles. Editing `.:/app` to `./game:/app` and restarting
   * left the service on the old mount; removing a service from the file left the
   * override declaring one with no image, which fails the whole project load.
   *
   * The config-file watcher's `reconcile()` was the only thing that refreshed
   * it, and that is a best-effort inotify over a bind mount — so whether an edit
   * took effect depended on whether an event arrived before the user hit
   * restart. Regenerating from the parse that just succeeded makes the answer
   * unconditional, without a second read of the file.
   *
   * **This gate exists because the refresh runs before EVERY `up`** — a manual
   * start, a restart, a crash/OOM retry, the install-gate release. An unchanged
   * file must not rewrite the override: compose recreates a container whenever
   * its config differs from what the running one was built with, so an
   * idempotent rewrite that merely reordered a key would recreate every service
   * in the stack on every retry. Being a synchronous predicate is part of that —
   * it keeps the unchanged case not just write-free but tick-for-tick identical
   * to before (see {@link withUpInFlight}).
   *
   * **What this deliberately does NOT do is rebuild the service map.** Adding or
   * removing a service, or changing its preview mode or ports, has to move
   * statuses, the install gate, the poller and the log followers together — that
   * is `reconcile()`, which the watcher still fires. This is scoped to what
   * compose EXECUTES.
   *
   * That leaves one asymmetry worth naming, because it looks like an oversight
   * and is not (review finding): a service the user deleted from the compose
   * file stops being DECLARED here, while `this.services` keeps polling its
   * entry until a reconcile clears it. Stale, not incoherent — and the direction
   * matters. Dropping it from the override is what lets the survivors start at
   * all, since compose fails the whole project load on a service left with
   * neither an image nor a build context.
   */
  private overrideIsStaleFor(parsed: ComposeService[] | null): boolean {
    if (parsed === null) return false;
    // Never before the first `start()` has written an override: there is nothing
    // to be stale against, and `start()` is about to generate one from this very
    // parse anyway.
    if (this._overrideProjectServices === null) return false;
    return JSON.stringify(parsed) !== this._overrideProjectServices;
  }

  /**
   * Mark `names` as having a `compose up` in flight for the duration of `fn`
   * (planning#316). Every `compose up`/`up <service>` call goes through this so the
   * poller can tell "this service has no container because it is still coming
   * up" from "this service's container disappeared".
   */
  private async withUpInFlight<T>(names: string[], fn: () => Promise<T>): Promise<T> {
    // BEFORE the bookkeeping below, so a refused `up` leaves no in-flight
    // exemption behind. Every `compose up` in this class goes through here,
    // which is what makes this the one place the check has to live.
    //
    // Synchronous, and it has to stay that way: the bookkeeping below is what
    // makes an `up` visible to a concurrent `stopService`, and every caller
    // reaches it without yielding, so an `await` here would open a window in
    // which an `up` is running and nothing knows it is (`service-manager.test.ts`
    // → "waits out every overlapping up"). #2426's override refresh is therefore
    // split in two around it: the decision is taken here, synchronously, and only
    // the WRITE — which happens on a compose edit and on no other `up` in the
    // session's life — runs after the bookkeeping and costs a tick.
    const parsed = this.assertProjectComposeStillValid();
    const staleParse = this.overrideIsStaleFor(parsed) ? parsed : null;
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
      // #2426 — inside the try, so a failure to rewrite the override releases
      // the exemption taken above rather than stranding it for the session.
      if (staleParse) {
        console.log(
          `[compose:${this.sessionId}] compose file changed since the override was generated — regenerating`,
        );
        await this.writeOverrideFor(staleParse, this._overrideAdmittedPlugins);
      }
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
        this.armLogFollowerSince([name]);
        await this.compose.upService(name, this.composeLogSink([name]));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // See `startService` — first manual-service start is the moment
      // the network actually exists, so re-attempt the orchestrator
      // network join here too. Idempotent on subsequent retries.
      await this.joinSessionNetwork();
      // Status is updated by the next pollStatus pass (periodic poller).
      // Trigger a poll now so we don't wait up to pollIntervalMs to learn
      // whether the retry succeeded. Its `onRunning` is also what re-attaches
      // the follower to the container this retry replaced — the spawn that
      // claims the anchor armed above.
      await this.poller.pollOnce();
      this.disarmLogFollowerSince([name]);
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
   * Backstop for a gate whose release was lost (docs/286). Runs on the poller's
   * heartbeat via `afterPoll`.
   *
   * The gate is a bracket, and the wedge is a *state*, not an event: services
   * sitting in `gatedServices` while nothing that could open the gate is in
   * flight. Nothing polls a held service — the poller's `isGated` skip,
   * `handleNonZeroExit`'s gated early-return and Compose's `restart: no` all
   * deliberately ignore it — so no gate event will arrive to open it. That is
   * decidable here without knowing which branch dropped the release, which
   * matters: docs/283 closed two routes to this symptom and a third was then
   * observed in production on a build already carrying that fix, over five
   * separate reinstall cycles on one session and four other sessions besides.
   * Guessing at a fourth route would be the same mistake again.
   *
   * **Scope.** This covers a lost gate RELEASE, not a lost install COMPLETION.
   * An install that never finishes leaves `_installRunning` true, and firing
   * there would start the services against a half-written dependency tree —
   * the docs/137 race the gate exists to remove. That layer is docs/283's
   * `awaitInstallCompletion`, and the two are deliberately independent.
   *
   * Four conditions must ALL hold, and each is a way the bracket can be
   * legitimately open:
   *
   *  - **Services are held.** Nothing to recover otherwise.
   *  - **No install is in flight.** A running install owns the gate; its own
   *    completion is the release. This also subsumes "a teardown is stored but
   *    not yet consumed": `_gatedTeardown` is only ever non-null while
   *    `_installRunning` is true, since the hold sets it and `releaseInstallGate`
   *    nulls it on its first line. Testing the field as well would add a
   *    condition that can only ever SUPPRESS a recovery, never prevent a
   *    docs/239 regression the next condition doesn't already prevent.
   *  - **The last install did not fail.** `latchGatedServicesToError` leaves the
   *    services in the set ON PURPOSE, latched to `error` with the real cause,
   *    so a later successful re-install can start them. That is a held gate the
   *    user can see and act on — not a wedge, and starting those services would
   *    walk them straight into the `vite: not found` the latch exists to
   *    prevent.
   *  - **No release is awaiting a teardown.** `docker compose stop` may
   *    legitimately run for a service's whole `stop_grace_period`, and
   *    `releaseInstallGate` awaits it precisely so our own SIGKILL lands while
   *    the service is still gated (docs/239). Reopening inside that window
   *    re-creates the bug the await exists to prevent. This is the ONLY signal
   *    for that window — see {@link _gateReleasesInFlight}.
   *
   * And it must hold CONTINUOUSLY for {@link gateWatchdogSettleMs}, measured
   * from the first heartbeat that saw it. That is what makes this a backstop
   * rather than a participant: on a healthy bracket a teardown or a running
   * install is always in flight, so the clock never even starts.
   *
   * The action is the gate's own open path (`startGatedServices`), not a bespoke
   * start, so the `stoppedByUser` filter (requirement 5) applies unchanged: a
   * wedged gate holding only services the user stopped is cleared and nothing is
   * started.
   */
  private checkInstallGateLiveness(now = Date.now()): void {
    const wedged =
      !this._disposed &&
      this.gatedServices.size > 0 &&
      !this._installRunning &&
      !this._installFailed &&
      this._gateReleasesInFlight === 0;

    if (!wedged) {
      this._gateWedgedSince = null;
      return;
    }

    // First sighting — start the clock and wait for the next heartbeat.
    if (this._gateWedgedSince === null) {
      this._gateWedgedSince = now;
      return;
    }

    const heldMs = now - this._gateWedgedSince;
    if (heldMs < this.gateWatchdogSettleMs) return;

    this._gateWedgedSince = null;
    console.warn(
      `[compose:${this.sessionId}] install gate watchdog: ${this.gatedServices.size} service(s) ` +
      `(${[...this.gatedServices].join(", ")}) have been held for ${Math.round(heldMs / 1000)}s with no ` +
      `install running, no failed install, and no teardown pending — the gate's release was lost, and no ` +
      `gate event will arrive to open it. Reopening it.`,
    );
    this.startGatedServices();
  }

  /**
   * Install finished successfully — start every gated service in one batched
   * `docker compose up` so they share startup time rather than serializing.
   * Clears the gate set; from here the periodic poller tracks them normally.
   */
  private startGatedServices(): void {
    if (this._disposed) return;
    if (this.gatedServices.size === 0) {
      // Only once the stack is up. Before `start()` has populated the service
      // map there is nothing the gate COULD be holding, and a successful
      // install routinely finishes in that window — logging there would put a
      // "declined to open the gate" line in every session's boot, which is how
      // a diagnostic becomes noise and stops being read (review finding).
      if (this._started) {
        console.log(
          `[compose:${this.sessionId}] install gate open skipped — no services are held`,
        );
      }
      return;
    }
    // A gated service the user stopped while it was held stays stopped. The gate
    // opening is an automatic lifecycle event, not a newer instruction from the
    // user, and requirement 5 gives the user's stop the last word — starting it
    // here would undo a stop they can watch us undo. They can start it whenever
    // they like, which clears the flag.
    const names = [...this.gatedServices].filter(n => !this.stoppedByUser.has(n));
    const held = this.gatedServices.size - names.length;
    // Cleared either way: the gate has done its job, and leaving names in the
    // set would look exactly like the wedge the watchdog hunts for.
    this.gatedServices.clear();
    if (names.length === 0) {
      console.log(
        `[compose:${this.sessionId}] install finished — all ${held} gated service(s) were stopped by the user; ` +
        `clearing the gate and starting nothing`,
      );
      // The gate is resolved, so its clock stops here too — nothing started, so
      // there is no wait worth reporting.
      this._gateHeldSince = null;
      return;
    }
    const heldNote = held > 0 ? ` (${held} left stopped at the user's request)` : "";
    console.log(
      `[compose:${this.sessionId}] install finished — starting ${names.length} gated service(s): ${names.join(", ")}${heldNote}`,
    );
    this.reportGateHeld("started", names.length);
    for (const name of names) {
      this.updateServiceStatus(name, "starting");
      // Open a first-boot recovery window: if the service crashes shortly
      // after this `up` (e.g. the gate released before deps finished landing),
      // handleNonZeroExit restarts it with backoff instead of latching to
      // `error`. Cleared once it reaches `running`. See docs/137.
      //
      // Set here rather than in the batch below, and so BEFORE the queue: both
      // this and the status are what the user sees while the op waits its turn.
      // A reconcile queued ahead of us clears the set (`start()` does), which
      // costs the window and is the right answer anyway — that reconcile
      // restarted the service against a freshly-read definition, so there is no
      // half-landed install left to recover from (review finding).
      this.postGateServices.add(name);
    }
    // Through the session's stack queue, like the first `start()` and both
    // reconciles. The gate opening is driven by `agent.install` finishing, which
    // a session activation deliberately runs CONCURRENTLY with the plugin-service
    // reconcile — so "the gate opens in the middle of a reconcile's `docker
    // compose up`" is the common case, not a corner. Unserialized, the two
    // compose invocations collided on the same containers: compose failed
    // mid-recreate with "removal of container … is already in progress", the
    // just-started container was force-removed (exit 137), and the service
    // walked to `stopped` 30s later when the poller gave up on it — a dead
    // preview on every activation. Diagnosed live against a841e147.
    // The generation travels WITH the queued batch. Checking it in
    // `releaseInstallGate` only proves the open was valid when it was
    // scheduled, and the queue can hold this op for as long as the `compose up`
    // ahead of it takes — long enough for a whole new reinstall cycle to
    // re-gate these services and start stopping them. Without the recheck
    // inside the batch, that queued start lands in the middle of the newer
    // teardown, which is req 6 again one layer down. Review finding.
    const generation = this._gateGeneration;
    void serializeStackOp(this.sessionId, () => this.startGatedBatch(names, generation));
  }

  /**
   * Bring up a batch of gated services and wire up their post-start plumbing.
   *
   * Runs on the stack queue, so `names` is decided BEFORE this runs and can go
   * stale: a reconcile queued ahead of us rebuilds the service map from a fresh
   * read of the compose file, and a service that release named may be gone from
   * it (renamed, removed, or a plugin service the round withdrew). Re-read the
   * map here rather than handing compose a service it no longer knows — an
   * `up <gone>` fails the whole batch and would latch the survivors to `error`.
   */
  private async startGatedBatch(requested: string[], generation: number): Promise<void> {
    if (this._disposed) return;
    // Stale by the time the queue reached us — a newer gate cycle owns these
    // services now. Its own release will start them.
    if (this._gateGeneration !== generation) {
      console.log(
        `[compose:${this.sessionId}] dropping stale gated start for ${requested.join(", ")} — ` +
        `a newer install gate cycle owns them`,
      );
      return;
    }
    // The `stoppedByUser` filter is re-applied here, not just in
    // `startGatedServices`, for the same reason the generation is re-checked:
    // that filter ran BEFORE the queue, and the queue can hold this batch for
    // as long as the `compose up` ahead of it takes. A Stop issued inside that
    // window records itself and finds no `up` in flight to chase
    // (`stopService` captures `upSettled` before stopping, and this batch has
    // not started one yet), so without this the queued start walks a service
    // the user just stopped straight back up — requirement 5 violated one layer
    // down, exactly as the generation was. Review finding on docs/286.
    const names = requested.filter(n => this.services.has(n) && !this.stoppedByUser.has(n));
    if (names.length === 0) return;
    try {
      await this.withUpInFlight(names, async () => {
        await this.prepareContainedStartFn?.(names);
        this.armLogFollowerSince(names);
        await this.compose.up(names, this.composeLogSink(names));
        markStackUp(this.sessionId, names.flatMap(n => this.services.get(n) ?? []));
        await this.containServicesFn?.([...this.services.keys()]);
      });
      // First `up` for an otherwise all-gated/all-manual stack is the moment
      // the compose network materializes — attach the orchestrator + agent.
      await this.joinSessionNetwork();
      await this.poller.pollOnce();
      // Log streaming for these services is already running: `start()` streams
      // every service in the map (gated ones included) before the gate opens,
      // and `docker compose logs -f <service>` follows the service across the
      // container's first `up`. No need to re-spawn here — and because no spawn
      // follows, the anchor armed above would otherwise sit armed until some
      // unrelated later re-attach replayed a window the store already holds.
      this.disarmLogFollowerSince(names);
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
    this.reportGateHeld("install-failed", this.gatedServices.size);
    for (const name of this.gatedServices) {
      this.updateServiceStatus(name, "error", INSTALL_FAILED_GATE_MESSAGE);
    }
  }

  /**
   * Report how long the install gate held auto-preview services, then stop the
   * clock. Silent when nothing was held — a session with no gated service has
   * no wait to report, and a line in every boot is a line nobody reads.
   */
  private reportGateHeld(outcome: "started" | "install-failed", services: number): void {
    const since = this._gateHeldSince;
    this._gateHeldSince = null;
    if (since === null) return;
    console.log(
      `[timing] install-gate for ${this.sessionId} held=${Date.now() - since}ms ` +
        `services=${services} outcome=${outcome}`,
    );
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
    this._gateHeldSince = Date.now();
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
    // Stamped with a fresh generation so only THIS cycle's release can act on
    // it, and so an earlier cycle's pending release is superseded here.
    this._gatedTeardownGeneration = ++this._gateGeneration;
    this._gatedTeardown = this.stopGatedForReinstall([...this.gatedServices]);
  }

  /**
   * How long the teardown may wait for THIS service's `compose stop`: whatever
   * the service says a stop may legitimately take, plus
   * {@link GATED_TEARDOWN_GRACE_MARGIN_MS}.
   *
   * Reading the service's own `stop_grace_period` is the whole point — a fixed
   * bound is a guess about the user's compose file, and guessing low turns a
   * healthy slow teardown into the docs/239 race. A service that declares
   * nothing gets Compose's default, which is then a fact about the file rather
   * than an assumption.
   */
  private gatedTeardownTimeoutMs(name: string): number {
    const declared = this.services.get(name)?.stopGracePeriodMs;
    return (declared ?? DEFAULT_STOP_GRACE_PERIOD_MS) + GATED_TEARDOWN_GRACE_MARGIN_MS;
  }

  /**
   * Stop gated containers so they relaunch fresh after re-install completes.
   *
   * Concurrent, not sequential: `releaseInstallGate` now waits for this, and
   * each `compose stop` can burn the full 10s SIGTERM grace period, so a
   * sequential loop would add 10s of preview downtime *per gated service* to
   * every re-install bracket. Stopping them together caps the added wait at one
   * grace period for the whole stack.
   *
   * **Always settles**, which is the contract `releaseInstallGate` depends on
   * and the reason this is the right place for the bound. A stop that REJECTS
   * was already logged and swallowed; a stop that HANGS was not, and it wedged
   * the gate shut permanently (docs/283). Both now end the same way — logged,
   * and the gate reopens.
   *
   * Abandoning the wait does not cancel the operation: the stop is happening
   * daemon-side, so killing the CLI process would not stop it either. If such a
   * stop lands after the gate has reopened it kills a freshly-started container,
   * which surfaces as an ordinary non-zero exit and goes through the normal
   * retry path. That is a visible, self-correcting outcome, and it is strictly
   * better than the invisible permanent one it replaces.
   */
  private async stopGatedForReinstall(names: string[]): Promise<void> {
    await Promise.all(names.map(async (name) => {
      if (this._disposed) return;
      const timeoutMs = this.gatedTeardownTimeoutMs(name);
      try {
        const outcome = await settleOrTimeout(this.compose.stop(name), timeoutMs);
        if (outcome === "timeout") {
          console.warn(
            `[compose:${this.sessionId}] gated teardown: 'compose stop ${name}' still running after ` +
            `${Math.round(timeoutMs / 1000)}s (grace period + margin) — abandoning the wait so the ` +
            `install gate can reopen`,
          );
        }
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

  /** Drop every pending port probe — teardown and reconcile (docs/266-plugin-service-ports req 8). */
  private cancelPluginPortProbes(): void {
    for (const timer of this.portProbeTimers.values()) clearTimeout(timer);
    this.portProbeTimers.clear();
    // `portProbeSettled` is deliberately NOT cleared: a stack that reconciles
    // repeatedly (a `shipit.yaml` edit, a plugin refresh) would otherwise
    // re-probe — and re-report — a plugin already settled either way.
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
