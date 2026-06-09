/**
 * Secret resolver — resolves declared `x-shipit-secrets` from the compose file
 * against user-saved secrets (SecretStore) and writes per-service env files
 * that the compose override references via `env_file:`.
 *
 * Responsibilities:
 *   - Phase 1: simple string form (`x-shipit-secrets: [STRIPE_KEY, ...]`) +
 *     per-service env-file output.
 *   - Phase 2: object-form entries with `description`, `required`, `agent`,
 *     `source` — produces a structured `SecretResolution` that includes
 *     per-service requirement metadata + a "missing required" report so the
 *     UI can surface a "configure secrets" banner.
 *
 * Later phases extend this module to:
 *   - Agent container env file (`.shipit/.env.agent`) for `agent: true`
 *     entries (Phase 3)
 *   - Docker secrets-based delivery instead of env files for stronger
 *     isolation (Phase 1 follow-up)
 *
 * Removed (docs/184): `source: platform:*` forwarding (Phase 4). Compose
 * services no longer receive the user's platform-managed credentials (Claude
 * OAuth / GitHub token / MCP OAuth) just because a repo-controlled compose
 * file asked for them — that handed the user's global identity to
 * attacker-controlled service code. A compose entry that still carries a
 * `source: platform:*` field now resolves only from the user's own secret
 * store under its declared `name`, and a warning is surfaced so the user
 * knows to set one.
 *
 * The output is intentionally minimal and predictable — sorted keys, no
 * quoting (compose's env-file parser doesn't interpret quotes) — so writes
 * are deterministic and don't trigger unnecessary container recreations from
 * compose.
 */

import fs from "node:fs";
import path from "node:path";
import type { ComposeService } from "./compose-generator.js";
import type { SecretRequirement } from "../shared/types/domain-types.js";
import type { CredentialStore } from "./credential-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretResolution {
  /** Per-service env-file contents, keyed by service name. */
  perServiceEnv: Record<string, string>;
  /**
   * Service-name → list of secret names declared but not present in user
   * secrets (covers both required and optional declarations).
   */
  missingByService: Record<string, string[]>;
  /**
   * Service-name → list of declared secrets whose `required: true` flag is
   * set but no value was found. This is the subset of `missingByService`
   * that drives the `secrets_missing` banner — optional missing secrets
   * don't surface as a UX problem.
   */
  missingRequiredByService: Record<string, string[]>;
  /** All secret names referenced by any service (de-duplicated, sorted). */
  declaredNames: string[];
  /**
   * All declared requirements across all services, de-duplicated by name.
   * If the same name appears with different metadata in multiple services,
   * the merged record carries the union: `required` is OR'd, `agent` is
   * OR'd, `description` and `source` take the first non-empty value, and
   * `services` lists every service that declared it.
   *
   * The UI uses this to render one row per unique secret regardless of how
   * many services consume it — with chips listing the consuming services.
   */
  declared: DeclaredSecret[];
  /**
   * Env-file body containing only secrets marked `agent: true` across any
   * service (Phase 3). Empty string when no `agent: true` declarations
   * exist or when none have values. Written to `.shipit/.env.agent` on the
   * orchestrator filesystem and pushed to the agent container's
   * `process.env` via the worker `/secrets` endpoint.
   *
   * The agent container is NOT a compose service — it gets these env vars
   * via direct injection, not via compose `env_file:`. Designed for
   * connection strings the agent needs when running CLI tools (migrations,
   * codegen, tests) — not for true secrets like API keys.
   */
  agentEnv: string;
  /**
   * Resolved key-value pairs for `agent: true` entries. Same content as
   * `agentEnv` but in a structured form for callers that push to a running
   * worker via HTTP rather than writing a file.
   */
  agentValues: Record<string, string>;
  /**
   * Resolved key-value pairs for every service-injected secret, keyed by
   * service name. Phase 1 follow-up uses this when isolated-secrets mode
   * is on — secret values get written to per-secret files outside the
   * workspace volume rather than into a shared `.env.<service>`.
   *
   * The same value can appear under multiple services (per-service scoping
   * is preserved); the consumer is responsible for de-duplicating across
   * services if it wants per-secret files.
   */
  perServiceValues: Record<string, Record<string, string>>;
  /**
   * Compose entries that still declare a now-unhonored `source: platform:*`
   * field (docs/184). Platform-credential forwarding was removed, so these
   * entries resolve from `userSecrets[name]` (or nothing) like any other
   * declaration. Reported here — one entry per (service, name) — so the
   * caller can surface a service-log warning telling the user to set a
   * user secret of the same name. Empty when no entry carries a platform
   * source.
   */
  platformSourceWarnings: PlatformSourceWarning[];
}

/** A compose entry whose `source: platform:*` field is no longer honored. */
export interface PlatformSourceWarning {
  /** Service that declared the entry. */
  service: string;
  /** Declared secret name. */
  name: string;
  /** The unhonored `source:` value (e.g. `platform:github_token`). */
  source: string;
}

/**
 * A declared secret aggregated across all services that referenced it.
 * Carries the merged requirement metadata + the list of consuming services.
 */
export interface DeclaredSecret extends SecretRequirement {
  /** Names of services that listed this secret in `x-shipit-secrets`. */
  services: string[];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve declared secrets from `x-shipit-secrets` against user-saved secrets.
 *
 * Returns a per-service env-file body for every service that declares at least
 * one secret. Services with no declarations get no entry (compose override
 * also skips `env_file:` for them).
 *
 * Missing secrets are reported per service. Required-and-missing secrets are
 * reported separately (`missingRequiredByService`) so the UI can distinguish
 * "user hasn't filled in optional value yet" from "service can't run until
 * the user provides this."
 *
 * Resolution does NOT throw on missing required secrets — the compose stack
 * still attempts to start. The orchestrator surfaces a `secrets_missing` WS
 * message so the user can configure values from the secrets panel; on save,
 * `refreshSecrets()` will re-resolve and `docker compose up -d` will
 * recreate affected containers.
 */
export function resolveSecrets(opts: {
  services: ComposeService[];
  userSecrets: Record<string, string>;
}): SecretResolution {
  const { services, userSecrets } = opts;
  const perServiceEnv: Record<string, string> = {};
  const perServiceValues: Record<string, Record<string, string>> = {};
  const missingByService: Record<string, string[]> = {};
  const missingRequiredByService: Record<string, string[]> = {};
  // Map name → merged DeclaredSecret. We merge metadata from multiple services
  // so the UI can show one row per unique secret with chips for each consumer.
  const declaredByName = new Map<string, DeclaredSecret>();
  // Phase 3: collect entries marked `agent: true` so the agent container
  // gets connection strings / debugging env vars it needs to operate
  // against the running compose stack. De-duplicated by name; first
  // non-empty value wins (same merge rule as declaredByName).
  const agentValues: Record<string, string> = {};
  // docs/184: collect entries that still declare a now-unhonored
  // `source: platform:*` field so the caller can warn the user to set a
  // user secret instead.
  const platformSourceWarnings: PlatformSourceWarning[] = [];

  for (const svc of services) {
    if (!svc.secrets || svc.secrets.length === 0) continue;
    // Use canonical SecretRequirement[] when available (Phase 2+); fall back
    // to synthesizing requirements from the legacy `secrets` string list so
    // older callers / tests still work end-to-end.
    const requirements: SecretRequirement[] =
      svc.secretRequirements ?? svc.secrets.map((name) => ({ name }));

    // De-duplicate within a service in case the user repeats a name. Keep the
    // first occurrence — its metadata wins.
    const seen = new Set<string>();
    const unique: SecretRequirement[] = [];
    for (const req of requirements) {
      if (seen.has(req.name)) continue;
      seen.add(req.name);
      unique.push(req);
    }

    const present: { key: string; value: string }[] = [];
    const missing: string[] = [];
    const missingRequired: string[] = [];

    for (const req of unique) {
      mergeDeclared(declaredByName, req, svc.name);

      // docs/184: `source: platform:*` is no longer forwarded. Flag the entry
      // so the caller can warn, then resolve it from the user secret store
      // under its declared `name` like any other declaration.
      if (req.source?.startsWith("platform:")) {
        platformSourceWarnings.push({
          service: svc.name,
          name: req.name,
          source: req.source,
        });
      }
      const value = resolveValue(req, userSecrets);
      if (typeof value === "string" && value.length > 0) {
        present.push({ key: req.name, value });
        // Phase 3: mirror to agent env when this entry is `agent: true`.
        // The mirror is keyed by name — if multiple services declare the
        // same name with `agent: true`, the value is identical (the same
        // user-saved secret), so first-write-wins is correct.
        if (req.agent && agentValues[req.name] === undefined) {
          agentValues[req.name] = value;
        }
      } else {
        missing.push(req.name);
        if (req.required) missingRequired.push(req.name);
      }
    }

    if (missing.length > 0) {
      missingByService[svc.name] = missing;
    }
    if (missingRequired.length > 0) {
      missingRequiredByService[svc.name] = missingRequired;
    }

    perServiceEnv[svc.name] = renderEnvFile(present);
    perServiceValues[svc.name] = Object.fromEntries(present.map((p) => [p.key, p.value]));
  }

  // Sort declared list deterministically (by name) and ensure each entry's
  // `services` list is sorted as well. Stable order matters because the UI
  // diffs the list across reconciles.
  const declared = [...declaredByName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ ...d, services: [...d.services].sort() }));

  // Render the agent env file body. Empty when no `agent: true` entries
  // resolved to a value — the .env.agent file is then deleted by the caller.
  const agentEntries = Object.entries(agentValues)
    .map(([key, value]) => ({ key, value }));
  const agentEnv = agentEntries.length > 0 ? renderEnvFile(agentEntries) : "";

  return {
    perServiceEnv,
    missingByService,
    missingRequiredByService,
    declaredNames: declared.map((d) => d.name),
    declared,
    agentEnv,
    agentValues,
    perServiceValues,
    platformSourceWarnings,
  };
}

/**
 * Collect account-level MCP secret values (docs/088-mcp-integration).
 *
 * Returns the union of two namespaces from `CredentialStore`:
 *
 *   1. Every `agentEnv` entry whose key matches `/^mcp__/` — Phase 1 secret
 *      values referenced from server blobs via `$secret:` placeholders.
 *   2. Every `mcpOAuth[source].accessToken` rewrapped as
 *      `MCP_PLATFORM_<UPPER_SOURCE>` — Phase 2 OAuth tokens referenced from
 *      server blobs via `$platform:<source>` placeholders. The worker
 *      substitutes both forms in `mcp-resolve.ts`.
 *
 * Token refresh is **not** performed here — this function is called from
 * synchronous code paths (the `mcpAgentEnvLoader` plumbed into
 * `ServiceManager`). Near-expired tokens are refreshed by a separate
 * async path (`refreshExpiredMcpOAuthTokens()` in `mcp-oauth.ts`),
 * triggered at orchestrator startup and before each agent turn.
 *
 * This is a deliberately separate path from {@link resolveSecrets}: MCP
 * secrets are account-level (not declared in any compose file, not keyed by
 * repo), so they don't flow through the compose-declaration resolver.
 * `ServiceManager` merges this map into the resolved `agentValues` *after*
 * `resolveSecrets()` runs, before writing `.shipit/.env.agent` and pushing
 * to the worker.
 *
 * `mcp__*` and `MCP_PLATFORM_*` keys are always agent-bound — no
 * `agent: true` opt-in is needed, because every MCP secret/token is by
 * definition consumed by the agent container.
 */
export function collectMcpAgentEnv(
  credentialStore: Pick<
    CredentialStore,
    "getAllAgentEnv" | "getAllMcpOAuthTokens"
  >,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentialStore.getAllAgentEnv())) {
    if (key.startsWith("mcp__") && typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  for (const [source, tokens] of Object.entries(credentialStore.getAllMcpOAuthTokens())) {
    if (!tokens?.accessToken) continue;
    // Mirror `platformSourceEnvName()` in `mcp-oauth-providers.ts` — kept
    // inline to avoid a worker-side import (this module is orchestrator-only
    // but the env-name contract is shared verbatim with the worker resolver).
    out[`MCP_PLATFORM_${source.toUpperCase()}`] = tokens.accessToken;
  }
  return out;
}

/**
 * Resolve the effective value for a single declared requirement.
 *
 * Resolution consults only the user's own secret store, keyed by the
 * declared `name`. A `source:` field is ignored (docs/184 removed
 * `source: platform:*` forwarding) — a compose entry that still carries one
 * resolves from `userSecrets[name]`, or to nothing if the user hasn't set a
 * matching secret.
 */
function resolveValue(
  req: SecretRequirement,
  userSecrets: Record<string, string>,
): string | undefined {
  const userValue = userSecrets[req.name];
  if (typeof userValue === "string" && userValue.length > 0) return userValue;
  return undefined;
}

/**
 * Merge a per-service `SecretRequirement` into the cross-service aggregate.
 * If the secret was already seen, the OR-able flags are unioned and the
 * service is added to the consumers list; the first non-empty description /
 * source wins.
 */
function mergeDeclared(
  acc: Map<string, DeclaredSecret>,
  req: SecretRequirement,
  serviceName: string,
): void {
  const existing = acc.get(req.name);
  if (!existing) {
    const next: DeclaredSecret = { name: req.name, services: [serviceName] };
    if (req.description) next.description = req.description;
    if (req.required) next.required = true;
    if (req.agent) next.agent = true;
    if (req.source) next.source = req.source;
    acc.set(req.name, next);
    return;
  }
  if (!existing.services.includes(serviceName)) {
    existing.services.push(serviceName);
  }
  if (!existing.description && req.description) existing.description = req.description;
  if (req.required) existing.required = true;
  if (req.agent) existing.agent = true;
  if (!existing.source && req.source) existing.source = req.source;
}

/**
 * Render a list of key/value pairs into a docker-compose-compatible env file.
 *
 * Format rules:
 *   - One `KEY=VALUE` per line.
 *   - Keys are sorted alphabetically for deterministic output.
 *   - Values containing newlines are rejected — compose `env_file` cannot
 *     express them and the agent should not store multi-line values.
 *   - All other values are written verbatim. Compose's env-file parser does
 *     NOT interpret quotes — leading/trailing quotes become part of the value
 *     — so we must pass the raw string. Any character (including `#`, `"`,
 *     `'`, spaces, `=`) is preserved as-is.
 *   - A leading "# Generated by ShipIt" header makes the file recognizable.
 */
/**
 * Render an agent env-file body from a flat key→value map. Used by
 * `ServiceManager.syncSecrets()` after merging compose-declared `agent: true`
 * values with account-level `mcp__*` values (docs/088). Returns "" for an
 * empty map so the caller deletes `.shipit/.env.agent`.
 */
export function renderAgentEnvBody(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => ({ key, value }));
  return entries.length > 0 ? renderEnvFile(entries) : "";
}

function renderEnvFile(entries: { key: string; value: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const lines: string[] = [
    "# Generated by ShipIt — do not edit manually.",
    "# This file holds secrets for a single compose service. Rewritten on every",
    "# session activation and on PUT /api/secrets.",
  ];
  for (const { key, value } of sorted) {
    if (value.includes("\n") || value.includes("\r")) {
      // Skip multi-line values — compose's env_file parser doesn't support them.
      // The user can still reach them through the secrets API but they won't
      // be exposed to compose services. (Phase 2 surfaces this as a warning.)
      continue;
    }
    lines.push(`${key}=${value}`);
  }
  // Trailing newline so the file ends cleanly.
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * Write per-service env files to `.shipit/.env.<service>` inside `workspaceDir`.
 *
 * - Creates the `.shipit/` directory if missing.
 * - Files are written with mode 0600 (the workspace volume is shared with the
 *   agent — file mode is a defense-in-depth measure but does not prevent
 *   process.env exfiltration through agent-authored code; see plan §"Security").
 * - Stale `.shipit/.env.<svc>` files for services that no longer declare
 *   secrets (or were removed from compose) are deleted, so a service can't
 *   re-pick up a leftover file from a previous compose definition.
 *
 * Returns the list of file paths written (relative to `workspaceDir`).
 */
export function writePerServiceEnvFiles(opts: {
  workspaceDir: string;
  perServiceEnv: Record<string, string>;
}): string[] {
  const { workspaceDir, perServiceEnv } = opts;
  const shipitDir = path.join(workspaceDir, ".shipit");
  fs.mkdirSync(shipitDir, { recursive: true });

  // Remove stale `.env.<svc>` files for services that no longer declare secrets.
  // We only sweep files we own (the `.env.` prefix) and leave `.env.agent`
  // alone (Phase 3 owns it).
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(shipitDir);
  } catch {
    existing = [];
  }
  const keep = new Set<string>();
  for (const svc of Object.keys(perServiceEnv)) keep.add(`.env.${svc}`);
  for (const entry of existing) {
    if (!entry.startsWith(".env.")) continue;
    if (entry === ".env.agent") continue; // Phase 3 owns this
    if (keep.has(entry)) continue;
    try {
      fs.unlinkSync(path.join(shipitDir, entry));
    } catch {
      // Best-effort cleanup
    }
  }

  const written: string[] = [];
  for (const [serviceName, body] of Object.entries(perServiceEnv)) {
    const filePath = path.join(shipitDir, `.env.${serviceName}`);
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    written.push(path.relative(workspaceDir, filePath));
  }
  return written;
}

/**
 * Write per-service env files to an orchestrator-private root OUTSIDE the
 * session workspace (docs/183): `<rootDir>/<sessionId>/.env.<service>`.
 *
 * This is the default delivery mode in containerized runtime — it keeps
 * service-only secrets out of the agent-readable workspace while preserving
 * the env-var semantics inside the service container. The generated compose
 * override references the returned absolute paths via `env_file:` rather than
 * the workspace-relative `.shipit/.env.<service>`.
 *
 * Why this is agent-invisible: in production `rootDir` defaults to
 * `<stateDir>/service-env`, where `stateDir` is the workspace-volume root. The
 * agent container mounts only the `sessions/<id>/workspace` subpath of that
 * volume, so a `service-env/` directory at the volume root is outside the
 * agent's mount even though both live on the same Docker volume. That subpath
 * dependency is load-bearing — see plan §"Why `<stateDir>/service-env` is
 * agent-invisible".
 *
 * Safety invariant (plan §"Resolved Decisions"): the resolved root must NOT
 * live inside the agent's workspace mount, or the isolation is a no-op. If
 * `rootDir` resolves to `workspaceDir` or a descendant, this throws rather
 * than silently leaking the files into the agent's view.
 *
 * Behaviour:
 *   - Creates `<rootDir>/<sessionId>/` (mode 0700) if missing.
 *   - Files are written with mode 0600.
 *   - Stale `.env.<svc>` files in the session dir (services that no longer
 *     declare secrets) are swept.
 *   - Any leftover workspace `.shipit/.env.<svc>` files from the pre-183
 *     write path are swept so a prior leak doesn't linger in the agent view.
 *
 * Returns a map of service name → absolute env-file path (for the override)
 * plus the per-session directory.
 */
export function writeServiceEnvFilesToRoot(opts: {
  rootDir: string;
  sessionId: string;
  workspaceDir: string;
  perServiceEnv: Record<string, string>;
}): { serviceEnvFiles: Record<string, string>; sessionDir: string } {
  const { rootDir, sessionId, workspaceDir, perServiceEnv } = opts;
  assertServiceEnvRootOutsideWorkspace(rootDir, workspaceDir);

  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  // Sweep stale `.env.<svc>` files for services that no longer declare secrets,
  // so a service can't re-pick up a leftover file from a previous compose def.
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(sessionDir);
  } catch {
    existing = [];
  }
  const keep = new Set<string>();
  for (const svc of Object.keys(perServiceEnv)) keep.add(`.env.${svc}`);
  for (const entry of existing) {
    if (!entry.startsWith(".env.")) continue;
    if (keep.has(entry)) continue;
    try {
      fs.unlinkSync(path.join(sessionDir, entry));
    } catch {
      // Best-effort cleanup
    }
  }

  const serviceEnvFiles: Record<string, string> = {};
  for (const [serviceName, body] of Object.entries(perServiceEnv)) {
    const filePath = path.join(sessionDir, `.env.${serviceName}`);
    fs.writeFileSync(filePath, body, { mode: 0o600 });
    serviceEnvFiles[serviceName] = filePath;
  }

  // Sweep any pre-183 workspace service env files so the agent can't read
  // stale plaintext values left behind by the old in-workspace write path.
  sweepWorkspaceServiceEnvFiles(workspaceDir);

  return { serviceEnvFiles, sessionDir };
}

/**
 * Remove workspace `.shipit/.env.<service>` files (every `.env.*` except
 * `.env.agent`, which Phase 3 owns). Used when service env files moved out of
 * the workspace (docs/183) and by Docker-secrets mode, so stale plaintext
 * service secrets don't linger in the agent-readable workspace.
 */
export function sweepWorkspaceServiceEnvFiles(workspaceDir: string): void {
  const shipitDir = path.join(workspaceDir, ".shipit");
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(shipitDir);
  } catch {
    return;
  }
  for (const entry of existing) {
    if (!entry.startsWith(".env.") || entry === ".env.agent") continue;
    try {
      fs.unlinkSync(path.join(shipitDir, entry));
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Remove a session's external service-env directory
 * (`<rootDir>/<sessionId>/`) and everything under it. docs/183.
 *
 * Called from `ServiceManager.stop({ removeVolumes: true })` — the
 * session-going-away-for-good signal (archive / full reset) — so the plaintext
 * service env files don't outlive the session. Without this they would
 * accumulate on the volume root indefinitely, since (unlike the old
 * in-workspace `.shipit/.env.<svc>` path) they're outside the workspace
 * checkout that archive drops and outside the disk-janitor's orphan-workspace
 * sweep. Best-effort: a failure here must not block teardown.
 */
export function removeSessionServiceEnvDir(opts: {
  rootDir: string;
  sessionId: string;
}): void {
  const { rootDir, sessionId } = opts;
  if (!sessionId) return;
  try {
    fs.rmSync(path.join(rootDir, sessionId), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — never block session teardown on this.
  }
}

/**
 * Throw if `rootDir` resolves to `workspaceDir` or a path inside it. The
 * out-of-workspace service-env placement (docs/183) is only isolation if the
 * directory is genuinely outside the agent's workspace mount — so we fail
 * closed rather than silently leak service-only secrets into the agent view.
 *
 * Resolves symlinks (best-effort) before the containment check: a lexical
 * `path.relative` comparison alone would pass a `service-env` symlink whose
 * target is inside the workspace, defeating the assertion in exactly the
 * non-standard `stateDir` setups it exists to guard. `realpathSync` falls
 * back to the lexical path for components that don't exist on disk yet.
 */
function assertServiceEnvRootOutsideWorkspace(rootDir: string, workspaceDir: string): void {
  const root = realpathOrResolve(rootDir);
  const ws = realpathOrResolve(workspaceDir);
  const rel = path.relative(ws, root);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw new Error(
      `Refusing to write service env files: resolved service-env root "${root}" ` +
        `is inside the agent workspace "${ws}", which would expose service-only ` +
        `secrets to the agent. Set SHIPIT_SERVICE_ENV_DIR to a path outside the workspace.`,
    );
  }
}

/**
 * `fs.realpathSync` with a fallback that resolves the longest existing
 * ancestor and re-appends the not-yet-created tail. Pure `path.resolve` when
 * nothing on the path exists. Never throws — used only to harden a safety
 * check, so a resolution failure degrades to the lexical path.
 */
function realpathOrResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Path (or a leading component) doesn't exist yet — resolve the deepest
    // existing ancestor so a symlinked parent is still followed, then re-join
    // the remaining tail lexically.
    let dir = abs;
    const tail: string[] = [];
    while (dir !== path.dirname(dir)) {
      try {
        const real = fs.realpathSync(dir);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch {
        tail.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
    return abs;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 follow-up: Docker-secrets mode
// ---------------------------------------------------------------------------

/**
 * Write per-secret files into an orchestrator-private directory for use
 * with Docker Compose's `secrets: { file: ... }` mechanism. Phase 1
 * follow-up — gives stronger isolation than env files (the agent's
 * workspace doesn't see the values).
 *
 * Files are written to `<rootDir>/<sessionId>/<NAME>` with mode 0600.
 * Stale files for names no longer declared by any service are deleted on
 * every call so a removed `x-shipit-secrets` entry stops being a Docker
 * secret on the next reconcile.
 *
 * Same name across multiple services collapses to one file (the value is
 * the same — it's the same user-saved secret). The caller (compose-generator)
 * generates per-service `secrets:` references that all point to the same file.
 *
 * Returns the list of unique secret names that were written. Caller uses
 * this to populate the top-level `secrets:` block in the compose override.
 */
export function writeIsolatedSecretFiles(opts: {
  /**
   * Orchestrator-internal root directory where secret files are written.
   * Each session gets a `<rootDir>/<sessionId>/` subdirectory. The path
   * must be the orchestrator's view of the directory (which may differ
   * from the path used in the compose file's `file:` references — see
   * `composeFilePathFor()` below).
   */
  rootDir: string;
  sessionId: string;
  /**
   * Secret name → value, de-duplicated across services. Caller is
   * responsible for collapsing per-service maps before calling.
   */
  values: Record<string, string>;
}): { written: string[]; sessionDir: string } {
  const { rootDir, sessionId, values } = opts;
  const sessionDir = path.join(rootDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

  // Sweep stale files — names that were previously written but aren't in
  // the current values map. Keeps Docker from referencing a file with
  // outdated content.
  let existing: string[] = [];
  try {
    existing = fs.readdirSync(sessionDir);
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (entry in values) continue;
    try {
      fs.unlinkSync(path.join(sessionDir, entry));
    } catch {
      // Best-effort cleanup
    }
  }

  const written: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const filePath = path.join(sessionDir, name);
    fs.writeFileSync(filePath, value, { mode: 0o600 });
    written.push(name);
  }
  return { written: written.sort(), sessionDir };
}

/**
 * Build the compose-side path for a given secret file. When the
 * orchestrator runs in a container, the Docker daemon (which reads the
 * `file:` references) lives on the host — so the path must be expressed
 * in host terms, not orchestrator-internal terms.
 *
 * If `hostDir` is provided, returns `<hostDir>/<sessionId>/<name>`.
 * Otherwise returns the orchestrator-internal path (for setups where the
 * orchestrator runs on the host directly, or for tests).
 */
export function composeSecretFilePath(opts: {
  rootDir: string;
  hostDir?: string;
  sessionId: string;
  name: string;
}): string {
  const base = opts.hostDir ?? opts.rootDir;
  return path.join(base, opts.sessionId, opts.name);
}

/**
 * Write (or remove) the agent-container env file at `.shipit/.env.agent`
 * inside `workspaceDir`. Phase 3 — agent gets the subset of secrets marked
 * `agent: true`.
 *
 * - Empty `body` removes the file (no agent entries currently resolved).
 *   The agent's process.env is also cleaned up via the worker `/secrets`
 *   endpoint with a delete-keys list.
 * - Non-empty `body` writes the file with mode 0600. The file lives in the
 *   workspace volume, NOT on a separate orchestrator-only volume — see the
 *   security note in the plan: `agent: true` entries are intentionally
 *   reserved for connection strings, not real secrets, so workspace-volume
 *   visibility is acceptable.
 *
 * Returns the relative path written, or `null` when the file was removed.
 */
export function writeAgentEnvFile(opts: {
  workspaceDir: string;
  body: string;
}): string | null {
  const { workspaceDir, body } = opts;
  const shipitDir = path.join(workspaceDir, ".shipit");
  const filePath = path.join(shipitDir, ".env.agent");
  if (!body) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort — file may not exist.
    }
    return null;
  }
  fs.mkdirSync(shipitDir, { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o600 });
  return path.relative(workspaceDir, filePath);
}
