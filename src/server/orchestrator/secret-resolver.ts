/**
 * Secret resolver — resolves declared `x-shipit-secrets` from the compose file
 * against user-saved secrets (SecretStore) and writes per-service env files
 * that the compose override references via `env_file:`.
 *
 * Every file this module writes lands OUTSIDE the session's git clone — the
 * orchestrator-private service-env root (docs/183), the Docker-secrets root, or
 * the session state dir. There is no in-clone placement left for any of them
 * (docs/246 req 7, enforced with no exemptions by `no-clone-writes.test.ts`).
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
 *   - Agent container env file (`.env.agent`) for `agent: true` entries
 *     (Phase 3) — written to the session state dir, outside the clone (docs/246)
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
import { AGENT_ENV_FILE, sessionStateDirForWorkspace } from "./session-state-dir.js";
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
   * exist or when none have values. Written to the session state dir's
   * `.env.agent` (docs/246 — orchestrator-side, outside the clone) and pushed
   * to the agent container's `process.env` via the worker `/secrets` endpoint.
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
 * Write per-service env files to an orchestrator-private root OUTSIDE the
 * session workspace (docs/183): `<rootDir>/<sessionId>/.env.<service>`.
 *
 * This is the ONLY env-file delivery mode. It keeps service-only secrets out of
 * the agent-readable workspace while preserving the env-var semantics inside the
 * service container; the generated compose override references the returned
 * absolute paths via `env_file:`. The in-workspace `.shipit/.env.<service>`
 * writer this replaced is gone (SHI-290) — it survived docs/183 as a fallback
 * for callers that configured no root, which production never was, and it was
 * the last thing in the codebase that put a ShipIt-generated file inside a
 * user's git clone (docs/246 req 7).
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
  let existing: string[];
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

  return { serviceEnvFiles, sessionDir };
}

/**
 * Remove a session's per-session secret-file directory
 * (`<rootDir>/<sessionId>/`) and everything under it. Best-effort: a failure
 * here must not block session teardown.
 *
 * Both out-of-workspace secret-delivery modes write plaintext per-session
 * files under `<rootDir>/<sessionId>/` (env-file mode → docs/183; Docker-secrets
 * mode → docs/087 Phase 1 follow-up). Those roots live outside the workspace
 * checkout, so neither archive nor the disk-janitor's orphan-workspace sweep
 * reclaims them — without an explicit drop on teardown they accumulate
 * indefinitely. This helper is the shared cleanup both modes call.
 */
function removeSessionSecretDir(rootDir: string, sessionId: string): void {
  if (!sessionId) return;
  try {
    fs.rmSync(path.join(rootDir, sessionId), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — never block session teardown on this.
  }
}

/**
 * Remove a session's external service-env directory
 * (`<rootDir>/<sessionId>/`). docs/183.
 *
 * Called from `ServiceManager.stop({ removeVolumes: true })` — the
 * session-going-away-for-good signal (archive / full reset) — so the plaintext
 * service env files written by env-file mode don't outlive the session.
 */
export function removeSessionServiceEnvDir(opts: {
  rootDir: string;
  sessionId: string;
}): void {
  removeSessionSecretDir(opts.rootDir, opts.sessionId);
}

/**
 * Remove a session's Docker-secrets directory (`<internalDir>/<sessionId>/`).
 * docs/087 Phase 1 follow-up, teardown cleanup added per docs/183.
 *
 * Docker-secrets mode (`writeIsolatedSecretFiles()`) writes per-secret plaintext
 * files to `<internalDir>/<sessionId>/<NAME>`. Like the env-file directory that
 * docs/183 cleans up, this lives outside the workspace checkout, so it must be
 * dropped explicitly when the session goes away for good. Called from
 * `ServiceManager.stop({ removeVolumes: true })` under the same guard; idle
 * eviction / reconcile (default `removeVolumes: false`) preserve the files so a
 * resumed session keeps its secrets. Only the orchestrator-internal `internalDir`
 * is touched — the optional `hostDir` path semantics are unaffected.
 */
export function removeSessionSecretsDir(opts: {
  internalDir: string;
  sessionId: string;
}): void {
  removeSessionSecretDir(opts.internalDir, opts.sessionId);
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
  let existing: string[];
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
 * Subdirectory of the Docker-secrets root that holds the staged entrypoint
 * wrapper. Sits BESIDE the per-session `<rootDir>/<sessionId>/` directories,
 * never inside one: {@link writeIsolatedSecretFiles} sweeps every entry of a
 * session dir that isn't a currently-declared secret name, and
 * `removeSessionSecretsDir()` drops the whole thing on teardown — either would
 * take the wrapper with it. The leading underscore can't collide with a session
 * id (they're uuids).
 */
const SECRETS_ENTRYPOINT_SUBDIR = "_entrypoint";

/** Filename of the staged wrapper. Matches the baked source for greppability. */
const SECRETS_ENTRYPOINT_FILE = "secrets-entrypoint.sh";

/**
 * SHI-285 — stage the Docker-secrets entrypoint wrapper where the Docker
 * **daemon** can bind-mount it into service containers, and return the path to
 * reference from the compose override.
 *
 * The wrapper is baked into the orchestrator image
 * (`/usr/local/share/shipit/secrets-entrypoint.sh`), which is a path inside the
 * orchestrator's own container — not something the daemon can resolve. So it has
 * to be copied somewhere with a known daemon-side path. ShipIt used to copy it
 * into the session's git clone and mount it through the workspace volume, which
 * put a generated file where the post-turn `git add -A` commits it into the
 * user's repository (docs/246 req 1).
 *
 * The Docker-secrets root is the natural home: it is the one directory this mode
 * already requires a daemon-side mapping for (`hostDir`, used by
 * {@link composeSecretFilePath} for every `secrets: file:` reference), so the
 * wrapper needs no configuration the mode doesn't already have. One shared copy
 * serves every session — the file is a static asset, identical for all of them,
 * not per-session state.
 *
 * Written via write-temp-then-rename so a concurrent reconcile in another
 * session can never expose a half-written script to a starting container. The
 * temp name is session-scoped for the same reason.
 *
 * Returns the compose-side (daemon-visible) absolute path, or `null` if staging
 * failed — the caller decides what to do without a wrapper.
 */
export function stageSecretsEntrypoint(opts: {
  /** Orchestrator-internal Docker-secrets root. */
  rootDir: string;
  /** Daemon-side view of `rootDir`, when the orchestrator runs in a container. */
  hostDir?: string;
  /** Session staging this copy — used only to make the temp filename unique. */
  sessionId: string;
  /** Baked wrapper inside the orchestrator image. */
  sourcePath: string;
}): string | null {
  const dir = path.join(opts.rootDir, SECRETS_ENTRYPOINT_SUBDIR);
  const dest = path.join(dir, SECRETS_ENTRYPOINT_FILE);
  const tmp = `${dest}.${opts.sessionId}.tmp`;
  try {
    // 0755 on the directory, not the 0700 the per-session secret dirs get: this
    // holds no secret, and the traversal happens daemon-side at mount time.
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.copyFileSync(opts.sourcePath, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    console.warn(`[secrets] failed to stage entrypoint wrapper:`, (err as Error).message);
    return null;
  }
  const base = opts.hostDir ?? opts.rootDir;
  return path.join(base, SECRETS_ENTRYPOINT_SUBDIR, SECRETS_ENTRYPOINT_FILE);
}

/**
 * Write (or remove) the agent-container env file (`.env.agent`) in the session's
 * state dir. Phase 3 — agent gets the subset of secrets marked `agent: true`.
 *
 * docs/246 moved it out of `<clone>/.shipit/`, restoring what docs/087 §403
 * specified ("this file is on the orchestrator's filesystem, not the workspace
 * volume"); the state dir's root is not part of the container's `/session-state`
 * mount, so the placement is orchestrator-only by layout rather than by claim.
 *
 * - Empty `body` removes the file (no agent entries currently resolved).
 *   The agent's process.env is also cleaned up via the worker `/secrets`
 *   endpoint with a delete-keys list.
 * - Non-empty `body` writes the file with mode 0600.
 *
 * Returns the path written relative to `workspaceDir`, or `null` when the file
 * was removed.
 */
export function writeAgentEnvFile(opts: {
  /**
   * The session's clone. Resolves the session state dir the file is written to
   * (orchestrator-side, outside the clone) — there is no in-clone placement any
   * more (SHI-286).
   */
  workspaceDir: string;
  body: string;
}): string | null {
  const { workspaceDir, body } = opts;
  const targetDir = sessionStateDirForWorkspace(workspaceDir);
  const filePath = path.join(targetDir, AGENT_ENV_FILE);

  if (!body) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort — file may not exist.
    }
    return null;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o600 });
  return path.relative(workspaceDir, filePath);
}
