/**
 * Compose override file generator.
 *
 * Reads a user's docker-compose.yml and generates `.shipit/compose.override.yml`
 * that layers on ShipIt's labels, network, volume rewrites, and security policies.
 * The user's file is never modified.
 *
 * The override is used with:
 *   docker compose -f <user-file> -f .shipit/compose.override.yml up -d
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { SecretRequirement } from "../shared/types/domain-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeService {
  name: string;
  /** Ports exposed by the service (host:container or just port). */
  ports?: string[];
  /** x-shipit-preview value from the user's compose file. */
  shipitPreview?: "auto" | "manual";
  /**
   * Whether this service must wait for `agent.install` to finish before it
   * is started (the `x-shipit-depends-on-install` extension). Resolved during
   * parsing: an explicit `true`/`false` wins; otherwise it defaults to `true`
   * for services whose effective preview mode is `auto` and `false` for
   * `manual`. See docs/137-depends-on-install.
   */
  dependsOnInstall?: boolean;
  /** User-defined profiles from the compose file. */
  profiles?: string[];
  /** Raw volume entries from the compose file (for rewriting in override). */
  volumes?: unknown[];
  /**
   * Secret env-var names the service needs (from `x-shipit-secrets` in compose).
   *
   * Names only — kept for backward compatibility and ergonomic checks like
   * `svc.secrets?.length`. The full per-entry metadata (`description`,
   * `required`, `agent`, `source`) lives on `secretRequirements`.
   *
   * Invariant: `secrets` and `secretRequirements` are produced from the same
   * parser pass, so `secrets[i] === secretRequirements[i].name` for every i.
   */
  secrets?: string[];
  /**
   * Full secret declarations as parsed from `x-shipit-secrets` (Phase 2+).
   * Always present when `secrets` is, with the same length and ordering.
   * Each entry carries the optional `description`, `required`, `agent`, and
   * `source` fields from the object form (or empty defaults for the string
   * shorthand).
   */
  secretRequirements?: SecretRequirement[];
}

export interface ComposeOverrideOptions {
  /** Session ID for labels and network naming. */
  sessionId: string;
  /** Compose config from shipit.yaml. */
  composeConfig: ComposeConfig;
  /**
   * Docker named volume that holds the workspace (e.g. "shipit-dev_workspace").
   * When set, `.` bind mounts in user compose files are rewritten to use this
   * volume with a subpath so compose services share the agent container's workspace.
   */
  workspaceVolume?: string;
  /**
   * Subpath within the workspace volume for this session
   * (e.g. "sessions/abc/workspace").
   */
  workspaceSubpath?: string;
  /** Docker stack name (e.g. "shipit-dev") — added as a label for cleanup filtering. */
  stackName?: string;
  /**
   * User-declared top-level named volumes (from the user's compose file).
   * When provided, the override emits a labels overlay for each entry so
   * the disk janitor's `docker volume prune --filter "label=shipit-managed"`
   * can sweep orphaned per-session compose volumes without touching the
   * user's other Docker volumes.
   */
  userNamedVolumes?: UserNamedVolume[];
  /**
   * Phase 1 follow-up: when present, generate Docker-secrets-style
   * delivery instead of `env_file:`. The `secrets:` map at the top-level
   * uses the file paths from `dockerSecrets.filePathFor(name)`, and each
   * service that declared secrets gets a `secrets:` list referencing the
   * `shipit-<NAME>` aliases plus an `entrypoint:` override that runs the
   * wrapper script before the original command.
   */
  dockerSecrets?: {
    /** Secret names that have a value (from `writeIsolatedSecretFiles`). */
    secretNames: string[];
    /**
     * Map of service name → secret names that service consumes (subset of
     * `secretNames`). Each service's compose entry references only the
     * secrets it declared, preserving per-service scoping.
     */
    perService: Record<string, string[]>;
    /** Returns the compose-side `file:` path for a given secret name. */
    filePathFor: (name: string) => string;
    /**
     * Workspace-relative path to the entrypoint wrapper script
     * (`secrets-entrypoint.sh`), e.g. `.shipit/secrets-entrypoint.sh`.
     * The override mounts it into each service container at
     * `/shipit/secrets-entrypoint.sh` and sets it as the entrypoint.
     */
    entrypointWorkspacePath: string;
  };
}

export class ComposeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeValidationError";
  }
}

// ---------------------------------------------------------------------------
// Compose file parsing
// ---------------------------------------------------------------------------

/**
 * Top-level named volume declared by the user (i.e., keys under the
 * compose file's `volumes:` block). The override emits a labels overlay
 * for each one so the disk janitor's volume prune can safely target only
 * ShipIt-managed leftovers without touching the user's own data.
 */
export interface UserNamedVolume {
  name: string;
}

/**
 * Extract the list of top-level user-declared named volumes from a compose
 * file. Defensive — never throws, returns `[]` on read or parse failure.
 * Called from `ServiceManager.refreshSecrets()` which can fire while the
 * user is mid-edit on their compose file; a transient YAML parse error
 * must not propagate up and break the secrets refresh.
 *
 * Note: entries declared `external: true` in the user's volumes block are
 * still returned. The override's labels overlay is silently ignored by
 * compose for external volumes (they're not created or modified by the
 * compose project), so they won't carry the `shipit-managed` label and
 * the disk-janitor's prune-by-label will skip them. That's the right
 * behavior — externals belong to the user's other workloads, not us.
 */
export function parseUserNamedVolumes(composePath: string): UserNamedVolume[] {
  let content: string;
  try {
    content = fs.readFileSync(composePath, "utf-8");
  } catch {
    return [];
  }
  let doc: Record<string, unknown> | null;
  try {
    doc = parseYaml(content) as Record<string, unknown> | null;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const volumes = doc.volumes;
  if (!volumes || typeof volumes !== "object" || Array.isArray(volumes)) return [];
  return Object.keys(volumes as Record<string, unknown>).map((name) => ({ name }));
}

/**
 * Parse a docker-compose.yml file and extract service definitions.
 * Validates security constraints and returns parsed service info.
 */
export function parseComposeFile(
  composePath: string,
  opts: { dockerSocket: boolean },
): ComposeService[] {
  let content: string;
  try {
    content = fs.readFileSync(composePath, "utf-8");
  } catch {
    throw new ComposeValidationError(`Cannot read compose file: ${composePath}`);
  }

  let doc: Record<string, unknown> | null;
  try {
    doc = parseYaml(content) as Record<string, unknown> | null;
  } catch (err) {
    // Surface YAML parse errors as ComposeValidationError so callers (which
    // catch them defensively, e.g. mid-edit / mid-merge reconciles) can log
    // a clean one-liner instead of a full stack trace. Common trigger: the
    // user's compose file is briefly invalid while they're typing or while
    // a merge has left conflict markers in the file.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ComposeValidationError(`Compose file is not valid YAML: ${msg}`);
  }
  if (!doc || typeof doc !== "object") {
    throw new ComposeValidationError("Compose file must be a YAML mapping");
  }

  const services = doc.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || typeof services !== "object") {
    throw new ComposeValidationError("Compose file must have a `services` section");
  }

  const result: ComposeService[] = [];

  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc !== "object" || svc === null) continue;

    // Security validation
    validateServiceSecurity(name, svc, opts.dockerSocket);

    // Extract ports (supports short syntax "8080:80" and long syntax { published, target })
    const rawPorts = Array.isArray(svc.ports) ? svc.ports : undefined;
    const ports = rawPorts
      ? rawPorts.map((p: unknown, index: number) => {
          if (typeof p === "string" || typeof p === "number") return String(p);
          if (p && typeof p === "object") {
            const obj = p as Record<string, unknown>;
            const published = obj.published;
            const target = obj.target;
            if (
              (typeof published === "string" || typeof published === "number") &&
              (typeof target === "string" || typeof target === "number")
            ) {
              return `${String(published)}:${String(target)}`;
            }
          }
          throw new ComposeValidationError(
            `Service \`${name}\`: unsupported ports[${index}] entry; expected string/number or long syntax with \`published\` and \`target\` fields.`,
          );
        })
      : undefined;

    // Extract x-shipit-preview
    const preview = svc["x-shipit-preview"];
    let shipitPreview: "auto" | "manual" | undefined;
    if (preview === "auto" || preview === "manual") {
      shipitPreview = preview;
    }

    // Resolve x-shipit-depends-on-install. An explicit boolean wins; otherwise
    // gate on install for `auto`-preview services and don't for `manual` ones.
    // See docs/137-depends-on-install.
    const rawDepends = svc["x-shipit-depends-on-install"];
    let dependsOnInstall: boolean;
    if (typeof rawDepends === "boolean") {
      dependsOnInstall = rawDepends;
    } else {
      const effectivePreview = shipitPreview ?? (ports && ports.length > 0 ? "auto" : "manual");
      dependsOnInstall = effectivePreview === "auto";
    }

    // Extract profiles
    const profiles = Array.isArray(svc.profiles)
      ? svc.profiles.map((p: unknown) => String(p))
      : undefined;

    // Preserve raw volumes for rewriting in override
    const volumes = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : undefined;

    // Extract x-shipit-secrets — accepts both the simple string form
    // (`STRIPE_KEY`) and the object form (`{ name, description, required,
    // agent, source }`). Unknown shapes (entry without a name, or a name
    // that fails validation) are silently skipped so a future schema upgrade
    // in user files doesn't break older orchestrators.
    const requirements = parseSecretEntries(name, svc["x-shipit-secrets"]);
    const secrets = requirements?.map((r) => r.name);

    result.push({
      name,
      ports,
      shipitPreview,
      dependsOnInstall,
      profiles,
      volumes,
      secrets,
      secretRequirements: requirements,
    });
  }

  return result;
}

/**
 * Parse `x-shipit-secrets` for a service into a list of `SecretRequirement`s.
 *
 * Both forms are accepted:
 *   - Strings — sugar for `{ name: <string> }` with no other metadata.
 *   - Objects — full `SecretRequirement`. `name` is required; other fields
 *     (`description`, `required`, `agent`, `source`) are copied verbatim
 *     when present and well-typed. Unknown extra keys are ignored.
 *
 * Returns `undefined` if no recognized entries were found, so the override
 * can omit `env_file:` for services that don't declare any secrets.
 */
function parseSecretEntries(
  serviceName: string,
  raw: unknown,
): SecretRequirement[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: \`x-shipit-secrets\` must be a list.`,
    );
  }
  const requirements: SecretRequirement[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        throw new ComposeValidationError(
          `Service \`${serviceName}\`: \`x-shipit-secrets\` entry \`${trimmed}\` ` +
          `is not a valid env var name.`,
        );
      }
      requirements.push({ name: trimmed });
    } else if (entry && typeof entry === "object") {
      // Object form: { name, description, required, agent, source }
      const obj = entry as Record<string, unknown>;
      const n = obj.name;
      if (typeof n !== "string") continue;
      const trimmed = n.trim();
      if (!trimmed || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) continue;

      const req: SecretRequirement = { name: trimmed };
      if (typeof obj.description === "string" && obj.description.trim()) {
        req.description = obj.description.trim();
      }
      if (obj.required === true) {
        req.required = true;
      }
      if (obj.agent === true) {
        req.agent = true;
      }
      if (typeof obj.source === "string" && obj.source.trim()) {
        req.source = obj.source.trim();
      }
      requirements.push(req);
    }
    // Anything else (numbers, booleans, nulls inside the list) silently skipped.
  }
  return requirements.length > 0 ? requirements : undefined;
}

/**
 * Validate security constraints for a compose service definition.
 */
function validateServiceSecurity(
  name: string,
  svc: Record<string, unknown>,
  dockerSocket: boolean,
): void {
  // Reject privileged: true
  if (svc.privileged === true) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`privileged: true\` is not allowed. ` +
      `Remove the privileged flag.`,
    );
  }

  // Reject network_mode: host
  if (svc.network_mode === "host") {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`network_mode: host\` is not allowed. ` +
      `Use explicit port mappings instead.`,
    );
  }

  // Check volumes for Docker socket and path traversal
  if (Array.isArray(svc.volumes)) {
    for (const vol of svc.volumes) {
      // Extract source path from both string and object forms
      let source: string | undefined;
      if (typeof vol === "string") {
        // Single absolute path without ":" is an anonymous volume target
        // (e.g. "/app/node_modules"), not a bind mount source — skip it.
        if (!vol.includes(":")) continue;
        source = vol.split(":")[0];
      } else if (vol && typeof vol === "object") {
        const obj = vol as Record<string, unknown>;
        // Object form: { type: "bind", source: "./src", target: "/app" }
        // Skip named volumes (type: "volume") — they don't have host paths
        if (obj.type === "volume") continue;
        if (typeof obj.source === "string") source = obj.source;
      }
      if (!source) continue;

      // Docker socket check
      if (source.includes("/var/run/docker.sock") && !dockerSocket) {
        if (name === "docker-socket-proxy") {
          throw new ComposeValidationError(
            `Service \`${name}\`: Docker socket mount is only allowed for ` +
            `server-created ops sessions. Recreate the ops session from Settings ` +
            `so it is marked as kind="ops".`,
          );
        }
        throw new ComposeValidationError(
          `Service \`${name}\`: Docker socket mount is not allowed. ` +
          `Set \`compose.docker-socket: true\` in shipit.yaml to enable it.`,
        );
      }

      // Path traversal check — reject absolute paths and ../
      if (source.startsWith("/") && !source.startsWith("/var/run/docker.sock")) {
        throw new ComposeValidationError(
          `Service \`${name}\`: Absolute bind mount path \`${source}\` is not allowed. ` +
          `Use relative paths within the workspace.`,
        );
      }
      if (source.includes("..")) {
        throw new ComposeValidationError(
          `Service \`${name}\`: Path traversal \`${source}\` is not allowed. ` +
          `Bind mounts must stay within the workspace.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Override generation
// ---------------------------------------------------------------------------

/**
 * Resolve effective preview mode for a service:
 * - Explicit x-shipit-preview takes priority
 * - Services with ports default to "auto"
 * - Services without ports default to "manual"
 */
function resolvePreviewMode(svc: ComposeService): "auto" | "manual" {
  if (svc.shipitPreview) return svc.shipitPreview;
  return svc.ports && svc.ports.length > 0 ? "auto" : "manual";
}

/**
 * Check if a volume source is a relative workspace path (., ./, ./subdir).
 * Returns the relative subdirectory (empty string for root) or null if not.
 */
function isRelativeWorkspacePath(source: string): string | null {
  if (source === "." || source === "./") return "";
  if (source.startsWith("./")) return source.slice(2);
  return null;
}

/**
 * Join the workspace subpath with a relative volume path.
 * Returns undefined if both are empty (root mount with no subpath).
 */
function joinSubpath(workspaceSubpath: string | undefined, relPath: string): string | undefined {
  if (workspaceSubpath && relPath) return `${workspaceSubpath}/${relPath}`;
  if (workspaceSubpath) return workspaceSubpath;
  if (relPath) return relPath;
  return undefined;
}

/**
 * Rewrite volume entries: replace workspace bind mounts (., ./, ./subdir)
 * with the shared Docker named volume so compose services see the same files
 * as the agent container.
 *
 * Returns the full volumes list for the override — compose merges lists by
 * replacing entirely, so we must include non-workspace volumes too.
 */
function rewriteVolumes(
  volumes: unknown[],
  opts: ComposeOverrideOptions,
): unknown[] {
  return volumes.map((vol) => {
    if (typeof vol === "string") {
      const parts = vol.split(":");
      const source = parts[0];
      const relPath = isRelativeWorkspacePath(source);
      if (relPath !== null) {
        const target = parts[1];
        if (!target) return vol; // bare "." with no target — leave as-is
        const mode = parts[2];
        const subpath = joinSubpath(opts.workspaceSubpath, relPath);
        const entry: Record<string, unknown> = {
          type: "volume",
          source: "shipit-workspace",
          target,
        };
        if (subpath) {
          entry.volume = { subpath };
        }
        if (mode === "ro") entry.read_only = true;
        return entry;
      }
      return vol;
    }
    if (vol && typeof vol === "object") {
      const obj = vol as Record<string, unknown>;
      if (typeof obj.source === "string") {
        const relPath = isRelativeWorkspacePath(obj.source);
        if (relPath !== null) {
          const subpath = joinSubpath(opts.workspaceSubpath, relPath);
          const entry: Record<string, unknown> = {
            ...obj,
            type: "volume",
            source: "shipit-workspace",
          };
          if (subpath) {
            entry.volume = { subpath };
          }
          return entry;
        }
      }
    }
    return vol;
  });
}

/**
 * Generate the `.shipit/compose.override.yml` content.
 *
 * The override adds:
 * - ShipIt labels (session ID, service name)
 * - Session network
 * - Volume rewrites (. → workspace named volume)
 * - Manual services get the `shipit-manual` profile
 * - cap_drop: [NET_RAW] for security
 */
export function generateComposeOverride(
  services: ComposeService[],
  opts: ComposeOverrideOptions,
): string {
  const overrideServices: Record<string, Record<string, unknown>> = {};

  for (const svc of services) {
    const mode = resolvePreviewMode(svc);
    const labels: Record<string, string> = {
      "shipit-parent-session": opts.sessionId,
      "shipit-service-name": svc.name,
      "shipit-preview-mode": mode,
    };
    if (opts.stackName) {
      labels["shipit-stack"] = opts.stackName;
    }
    const entry: Record<string, unknown> = {
      labels,
      networks: ["shipit-session"],
      cap_drop: ["NET_RAW"],
    };

    // Strip host port bindings — compose services are accessed through
    // the preview proxy via the session network, not direct host ports.
    // Publishing to the host causes "port already allocated" conflicts.
    // We use a sentinel that gets replaced with `!reset []` after YAML
    // serialization — compose merges arrays by appending, so a plain `[]`
    // doesn't clear the original ports.
    if (svc.ports && svc.ports.length > 0) {
      entry.ports = "__RESET_PORTS__";
    }

    // Rewrite workspace bind mounts ("." or "./" source) so compose services
    // share the same workspace as the agent container.
    if (svc.volumes && opts.workspaceVolume) {
      entry.volumes = rewriteVolumes(svc.volumes, opts);
    }

    // Phase 1 follow-up: Docker-secrets mode. When `dockerSecrets` is
    // present we emit `secrets:` references + an entrypoint hijack. Falls
    // back to per-service env_file otherwise.
    const ds = opts.dockerSecrets;
    if (ds && svc.secrets && svc.secrets.length > 0) {
      const consumed = (ds.perService[svc.name] ?? []).filter((n) => ds.secretNames.includes(n));
      if (consumed.length > 0) {
        entry.secrets = consumed.map((n) => `shipit-${n}`);
        // Mount the entrypoint wrapper read-only into the container. We
        // reuse the workspace-volume mount (the wrapper is copied into
        // .shipit/) so this works on both volume-backed and bind-mount
        // setups without changing the host bind path.
        const existingVolumes = (entry.volumes as unknown[] | undefined) ?? [];
        const wrapperMount: Record<string, unknown> = opts.workspaceVolume
          ? {
            type: "volume",
            source: "shipit-workspace",
            target: "/shipit/secrets-entrypoint.sh",
            read_only: true,
            volume: { subpath: opts.workspaceSubpath
              ? `${opts.workspaceSubpath}/${ds.entrypointWorkspacePath}`
              : ds.entrypointWorkspacePath },
          }
          : { type: "bind", source: `./${ds.entrypointWorkspacePath}`, target: "/shipit/secrets-entrypoint.sh", read_only: true };
        entry.volumes = [...existingVolumes, wrapperMount];
        // Override the entrypoint to the wrapper. The wrapper exec's
        // "$@" so the user's command runs unchanged. We don't touch
        // `command:` here — leaving it unset means compose merges the
        // user's compose-file value, which is what we want.
        entry.entrypoint = ["/shipit/secrets-entrypoint.sh"];
      }
    } else if (svc.secrets && svc.secrets.length > 0) {
      // Inject the per-service secrets env file if the service declared any
      // secrets via `x-shipit-secrets`. The orchestrator writes the file before
      // running `docker compose up` (see secret-resolver.ts).
      entry.env_file = [`.shipit/.env.${svc.name}`];
    }

    overrideServices[svc.name] = entry;
  }

  const override: Record<string, unknown> = {
    services: overrideServices,
    networks: {
      "shipit-session": {
        name: `shipit-session-${opts.sessionId}`,
      },
    },
  };

  // Phase 1 follow-up: top-level `secrets:` block listing every secret
  // name with a `file:` reference. The path is host-side (the Docker
  // daemon reads it), so the orchestrator pre-resolves it via
  // `filePathFor()` to handle the orchestrator-in-container case.
  if (opts.dockerSecrets && opts.dockerSecrets.secretNames.length > 0) {
    const secretsBlock: Record<string, { file: string }> = {};
    for (const name of opts.dockerSecrets.secretNames) {
      secretsBlock[`shipit-${name}`] = {
        file: opts.dockerSecrets.filePathFor(name),
      };
    }
    override.secrets = secretsBlock;
  }

  // Top-level `volumes:` block:
  //   - shipit-workspace is declared external when workspaceVolume is set
  //     (orchestrator-managed; no labels — compose can't label externals).
  //   - User-declared named volumes get a labels overlay so the disk
  //     janitor can prune orphans by label without touching the user's
  //     other Docker volumes.
  const volumeOverlay: Record<string, Record<string, unknown>> = {};
  if (opts.workspaceVolume) {
    volumeOverlay["shipit-workspace"] = {
      name: opts.workspaceVolume,
      external: true,
    };
  }
  if (opts.userNamedVolumes && opts.userNamedVolumes.length > 0) {
    for (const v of opts.userNamedVolumes) {
      volumeOverlay[v.name] = {
        labels: {
          "shipit-managed": "true",
          "shipit-session": opts.sessionId,
        },
      };
    }
  }
  if (Object.keys(volumeOverlay).length > 0) {
    override.volumes = volumeOverlay;
  }

  let yaml = stringifyYaml(override, { lineWidth: 120 });
  // Replace sentinel with !reset tag — Docker Compose's extension to clear
  // inherited array values instead of appending to them.
  yaml = yaml.replace(/ports: __RESET_PORTS__/g, "ports: !reset []");
  return `# Generated by ShipIt — do not edit manually.\n# This file is merged with your docker-compose.yml at runtime.\n${yaml}`;
}

/**
 * Write the compose override file to `.shipit/compose.override.yml`
 * in the given workspace directory. Creates the `.shipit/` directory
 * if it doesn't exist.
 */
export function writeComposeOverride(
  workspaceDir: string,
  content: string,
): string {
  const shipitDir = path.join(workspaceDir, ".shipit");
  fs.mkdirSync(shipitDir, { recursive: true });
  const overridePath = path.join(shipitDir, "compose.override.yml");
  fs.writeFileSync(overridePath, content, "utf-8");
  return overridePath;
}
