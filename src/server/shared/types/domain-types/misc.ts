// ---- Runtime mode (feature 118) ----

/**
 * Runtime mode for the orchestrator.
 *
 *   - `containerized` (default): production mode. Each session gets a Docker
 *     container with a session-worker; agents run inside containers; compose
 *     stacks manage previews. Requires Docker.
 *   - `local`: dogfooding mode (ShipIt running inside ShipIt). No Docker
 *     containers are created for inner sessions; agent CLIs are spawned as
 *     in-process subprocesses; per-session inner-compose stacks are skipped.
 *     See docs/118-shipit-ui-local/plan.md.
 *
 * Defined here (shared types) so both the orchestrator and the React client
 * can reference it without the client reaching into orchestrator-only modules.
 * `app-di.ts` re-exports this symbol for back-compat with existing imports.
 *
 * NOTE: this is NOT the same as `isTestMode`. `isTestMode` means "test harness
 * with mocks"; `local` means "production behavior minus the container layer."
 */
export type RuntimeMode = "containerized" | "local";

// ---- Doc types ----

export interface DocEntry {
  /** Relative path from workspace root, e.g. "docs/001-websocket-protocol/plan.md". */
  path: string;
  /**
   * docs/168 — pointer to the issue that tracks this doc's work, taken
   * verbatim from the frontmatter `issue:` field. Work tracking lives in the
   * tracker, not the doc, so this is the doc's only link to its scheduling.
   * A Linear pointer is always a full URL
   * (`https://linear.app/<workspace>/issue/SHI-28/...`); a GitHub pointer is
   * `owner/repo#123` or a full issue URL. Absent on pure reference docs. The
   * tracker is inferred from the pointer's shape by the client.
   */
  issue?: string;
  /** Human-readable title. Derived from frontmatter `title:` field, or from filename. */
  title: string;
  /**
   * Short one-line summary from the frontmatter `description:` field. Rendered
   * under the title in the docs panel so a doc's purpose is legible without
   * opening it. Single-line only (trimmed); omitted when absent.
   */
  description?: string;
  /**
   * File mtime as ISO 8601 string. Retained for display/sorting, but NOT used
   * to decide "modified in this session" — git rewrites mtimes on checkout,
   * which produced false positives. See `changedInSession`.
   */
  modifiedAt?: string;
  /**
   * True when this doc was actually changed in the current session, as
   * determined server-side from git (committed branch changes since divergence
   * from the base branch, plus uncommitted edits). Authoritative replacement
   * for the old mtime-vs-session-start heuristic. Absent when git state could
   * not be resolved.
   */
  changedInSession?: boolean;
  /**
   * Checkbox progress aggregated from `- [ ]` / `- [x]` items at any
   * indentation level. For a tracked plan, this comes from its sibling
   * `checklist.md` so the docs panel can render an at-a-glance progress
   * badge next to the status badge. For a standalone checklist (no plan
   * sibling), it reflects that file's own counts. Omitted when the doc
   * has no associated checklist.
   */
  checklist?: { total: number; done: number };
}

// ---- Template types ----

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: "frontend" | "fullstack" | "backend" | "utility";
  icon: string;
  files: Record<string, string>;
}

// ---- Secret declaration types (087-reusable-preview-secrets) ----

/**
 * A secret declaration entry from `x-shipit-secrets` in docker-compose.yml.
 * Two surface forms are accepted; both normalize to `SecretRequirement` once
 * parsed.
 *
 *   x-shipit-secrets:
 *     - STRIPE_KEY                      # string shorthand
 *     - name: DATABASE_URL              # object form
 *       description: Postgres URL
 *       required: true
 *       agent: true
 *       source: platform:claude_oauth
 */
export type SecretEntry = string | SecretRequirement;

export interface SecretRequirement {
  /**
   * Env var name to inject into the service. Must match
   * `^[A-Za-z_][A-Za-z0-9_]*$`.
   */
  name: string;
  /**
   * Human-readable description shown to the user in the secrets UI when
   * prompted to configure a value. Free-form text.
   */
  description?: string;
  /**
   * If true, the service will not run successfully without a value. Drives
   * the `secrets_missing` warning UI and surfaces in the secrets panel as a
   * required-marker.
   */
  required?: boolean;
  /**
   * If true, this secret is also injected into the agent container (via
   * `--env-file .shipit/.env.agent`). Used for connection strings the agent
   * needs when running migrations / codegen / tests against the running
   * stack. (Phase 3.)
   */
  agent?: boolean;
  /**
   * Resolve the value from a platform source instead of user-saved secrets.
   * Recognized values:
   *   - "platform:claude_oauth" — Claude OAuth token from AuthManager
   *   - "platform:github_token" — GitHub token from GitHubAuthManager
   * Unknown sources fall through to user-saved secrets. (Phase 4.)
   */
  source?: string;
}

// ---- Docker memory stats ----

export interface DockerMemoryStats {
  /** Memory currently in use (bytes). */
  usedBytes: number;
  /** Memory limit (bytes). 0 means unlimited. */
  totalBytes: number;
}

// ---- System info ----

/** Release channel an instance tracks. See docs/162-release-channels. */
export type ReleaseChannel = "stable" | "edge";

/**
 * Human-facing version identity of the running instance, channel-aware.
 * On `stable` this is the exact release tag (e.g. `v1.4.0`); on `edge` it is
 * `main @ <short-sha>`. Distinct from {@link SystemInfo.buildId}, which stays
 * the raw SHA used for client cache-busting.
 */
export interface VersionInfo {
  channel: ReleaseChannel;
  /** `vX.Y.Z` on a stable release, else `main @ <short-sha>`. */
  version: string;
  /** Full commit SHA the instance is built from, when resolvable. */
  commit?: string;
  /**
   * True when the on-disk checkout HEAD differs from the running image's baked
   * commit — the signature of an interrupted/failed in-place update where the
   * checkout advanced but the image was never rebuilt. The UI flags it so the
   * mismatch reads as "an update didn't finish" rather than a UI glitch.
   */
  mismatch?: boolean;
}

/**
 * Static per-process metadata about the orchestrator. Sent once on SSE
 * connect; the client uses `processStartedAt` to render a live-ticking
 * uptime badge so the user can confirm a restart actually bounced the
 * orchestrator (the value will reset on a fresh process).
 */
export interface SystemInfo {
  /** Epoch milliseconds when the orchestrator process started. */
  processStartedAt: number;
  /**
   * Build identifier for the orchestrator/client bundle. In production this is
   * passed as SHIPIT_BUILD_ID at image build time; in development it falls back
   * to the current git commit SHA.
   */
  buildId?: string;
  /**
   * Channel-aware human-facing version of the running instance. Surfaced in
   * Settings → Advanced → Software Updates so the user sees "Stable · v1.4.0"
   * or "Edge · main @ abc1234" instead of a bare SHA.
   */
  version?: VersionInfo;
  /**
   * Whether the host has an out-of-process updater/restarter watching the
   * trigger files. VPS installs set this to "managed"; local Docker prod is
   * "manual" and applies updates by re-running docker/local/prod.sh.
   */
  updateMode?: "managed" | "manual";
}

// ---- Ops session host overview (docs/128) ----

/** One ShipIt-managed container as seen by the orchestrator's Docker client. */
export interface HostContainerInfo {
  /** Short (12-char) container id. */
  id: string;
  /** Container name(s), leading slash stripped. */
  name: string;
  image: string;
  /** Docker state: running | exited | restarting | paused | created | dead. */
  state: string;
  /** Human status, e.g. "Up 3 hours" / "Exited (137) 2 minutes ago". */
  status: string;
  /** Unix seconds the container was created. */
  createdAt: number;
  /** Owning session id, when the container carries the shipit-session-id label. */
  sessionId?: string;
  /** Owning session title, resolved from the session store. */
  sessionTitle?: string;
  /** True when an agent turn is currently running for the owning session. */
  agentRunning?: boolean;
}

/**
 * Read-only host snapshot rendered inline in the ops session's Host tab. Built
 * from the orchestrator's own Docker client (it runs on the host), NOT from the
 * agent container. Informational only — no control actions (docs/128 §5).
 */
export interface HostOverview {
  generatedAt: string;
  /** False when the orchestrator's Docker client couldn't be reached. */
  dockerAvailable: boolean;
  /** Total / running counts across all ShipIt-managed containers. */
  totals: { containers: number; running: number };
  containers: HostContainerInfo[];
}
