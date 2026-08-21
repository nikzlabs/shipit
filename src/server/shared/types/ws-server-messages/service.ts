import type { SecretRequirement } from "../domain-types.js";
import type { PluginCredentialGroup } from "../../plugin-credentials.js";

// ---- Install status messages (server → client) ----

/** Server → Client: status update for agent.install execution. */
export interface WsInstallStatus {
  type: "install_status";
  sessionId: string;
  status: "running" | "complete" | "error" | "skipped";
  /** Current command being executed. */
  command?: string;
  /** Error message on failure. */
  message?: string;
}

/**
 * Server → Client: per-MCP-server runtime status (docs/088-mcp-integration).
 * Originates as a worker SSE `mcp_server_status` event and is relayed to the
 * browser so the Settings → MCP Servers panel can render load state.
 */
export interface WsMcpServerStatus {
  type: "mcp_server_status";
  sessionId: string;
  /** Server name (the `mcp__<name>__*` namespace identifier). */
  name: string;
  state: "loaded" | "failed" | "crashed" | "disabled";
  /** Human-readable reason when `state` is "failed" or "crashed". */
  reason?: string;
}

/** Server → Client: log output from agent.install execution. */
export interface WsInstallLog {
  type: "install_log";
  sessionId: string;
  text: string;
  stream: "stdout" | "stderr";
}

// ---- Compose service messages (server → client) ----

export type ComposeServiceStatus = "stopped" | "starting" | "running" | "error";
export type ComposeServicePreviewMode = "auto" | "manual";

/**
 * docs/262 req 3 — where a surfaced service came from, when it is not the
 * project's own compose file. Plugin services are first-class everywhere else,
 * so this is the only thing that distinguishes them: services keep `name` as
 * their client identity (it is already collision-checked across the project and
 * every plugin, req 20, and it is today's control and log address).
 */
export interface ComposeServiceOriginView {
  kind: "plugin";
  /** The declared plugin repository, as the Plugins card names it. */
  repo: string;
  /** The import's local name (`use.alias`). */
  alias: string;
  /** The exported plugin's name in that repository's manifest. */
  plugin: string;
}

/**
 * Server → Client: status update for a single compose service.
 *
 * `port` is the **browser's** routing key — the number the preview origin
 * carries (`{sessionId}--{port}.<host>`), which is the container port for a
 * project service and the pinned published port for a plugin one (docs/262
 * req 18). The orchestrator resolves it back to the real container port when it
 * proxies. The agent-facing `url` on `GET /api/sessions/:id/services` is the
 * other half of that pair and carries the container port, because it is a direct
 * connection with no proxy in it.
 */
export interface WsServiceStatus {
  type: "service_status";
  sessionId: string;
  name: string;
  status: ComposeServiceStatus;
  port?: number;
  preview: ComposeServicePreviewMode;
  error?: string;
  /** docs/262 — present only for a service a plugin provides. */
  origin?: ComposeServiceOriginView;
}

/** Server → Client: full list of compose services for a session. */
export interface WsServiceList {
  type: "service_list";
  sessionId: string;
  services: {
    name: string;
    status: ComposeServiceStatus;
    /** The browser's routing key — see {@link WsServiceStatus.port}. */
    port?: number;
    preview: ComposeServicePreviewMode;
    error?: string;
    /** docs/262 — present only for a service a plugin provides. */
    origin?: ComposeServiceOriginView;
  }[];
}

/**
 * docs/262 — Server → Client: this session's plugin repositories finished an
 * activation round, so the browser should refetch `GET /api/plugin-repos`.
 *
 * A signal, not a payload: the snapshot is the single authoritative shape and
 * re-deriving it here would be a second source of truth. It exists because
 * activation is fire-and-forget — without a push the client can only poll, and
 * a poll with any budget eventually gives up on a slow fetch and leaves the
 * card stuck on "activating".
 */
export interface WsPluginReposUpdated {
  type: "plugin_repos_updated";
  sessionId: string;
}

/** Server → Client: Docker Compose stack failed to start. */
export interface WsComposeError {
  type: "compose_error";
  sessionId: string;
  message: string;
}

/**
 * Server → Client: a stack-level emergency from `ServiceManager`.
 *
 * Distinct from `compose_error` (user-facing PreviewFrame banner emitted
 * from the startup catch path) — this carries any error the manager
 * raises via its `stack_error` EventEmitter signal. Today it fires only
 * on startup, so the two channels overlap; the separate type means
 * future non-startup emit sites (e.g. a mid-session `compose down`
 * failure) reach the client without re-wiring.
 *
 * The diagnostics panel reads recent `stack_error` log-ring entries so
 * a viewer that connects after the fact still sees the failure.
 *
 * See docs/124-session-rescue-and-diagnostics §1.1.
 */
export interface WsStackError {
  type: "stack_error";
  sessionId: string;
  message: string;
}

/** Server → Client: No compose file configured in shipit.yaml. */
export interface WsComposeNotConfigured {
  type: "compose_not_configured";
  sessionId: string;
}

/**
 * Server → Client: declared secrets and missing-required report for a session.
 *
 * Emitted whenever `ServiceManager.syncSecrets()` runs (compose start,
 * reconcile, secret save). The client uses this to:
 *   - Show a "Configure secrets to run this project" banner in the preview
 *     panel when `missingRequired.length > 0`.
 *   - Render the secrets panel with declared-vs-undeclared distinction and
 *     show per-secret descriptions, required indicators, and consumer
 *     service chips.
 *
 * `missingByService` includes both required and optional missing values;
 * `missingRequired` is the union of just the required-and-missing names.
 * The banner only fires on `missingRequired`.
 */
export interface WsSecretsStatus {
  type: "secrets_status";
  sessionId: string;
  /**
   * All declared secrets, de-duplicated by name: every service's
   * `x-shipit-secrets` entries, plus every credential name an activated plugin
   * declares (docs/262 req 23). A name claimed by both is ONE row carrying
   * both claimant lists — deliberately, because it is one stored secret.
   * `services` is empty on a row only a plugin claims.
   */
  declared: (SecretRequirement & { services: string[]; plugins?: string[] })[];
  /** Service name → secret names declared but not present (required + optional). */
  missingByService: Record<string, string[]>;
  /**
   * De-duplicated list of names whose `required: true` flag is set but no
   * value was found. Empty list = no banner.
   */
  missingRequired: string[];
  /**
   * docs/262 req 23 — plugin-declared credentials GROUPED per activated
   * plugin, each name carrying whether this project has a value for it. The
   * grouping is what makes a missing key a *named* gap ("`artk` needs
   * `FAL_KEY`") instead of an anonymous entry in a flat list.
   *
   * Values come from the consuming project's own secret store and nothing
   * else; ShipIt's platform credentials can never satisfy one of these.
   *
   * Not part of `missingRequired`: that list drives the preview's blocking
   * "configure secrets" banner, which is about the project's own services.
   */
  plugins: PluginCredentialGroup[];
}

/**
 * Server → Client: a Compose-managed (i.e. user) container was OOM-killed.
 *
 * The Docker event loop in `container-health.ts` historically only watched
 * containers labeled `shipit-session=true`, which excludes compose
 * children (which carry `shipit-parent-session={sid}` instead). The
 * widened filter now catches compose-child OOMs and emits this event so
 * the user gets an immediate "service was killed for OOM" notice instead
 * of waiting 5 s for `pollStatus` to flip the service to `error` with the
 * unhelpful "Exited with code 137" message.
 *
 * See docs/124-session-rescue-and-diagnostics §1.2.
 */
export interface WsServiceOom {
  type: "service_oom";
  sessionId: string;
  /** Compose service name, when resolvable. */
  serviceName?: string;
  /** Underlying Docker container id (short form). */
  containerId: string;
}
