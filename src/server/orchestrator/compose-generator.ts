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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeService {
  name: string;
  /** Ports exposed by the service (host:container or just port). */
  ports?: string[];
  /** x-shipit-preview value from the user's compose file. */
  shipitPreview?: "auto" | "manual";
  /** User-defined profiles from the compose file. */
  profiles?: string[];
  /** Raw volume entries from the compose file (for rewriting in override). */
  volumes?: unknown[];
  /**
   * Secret env-var names the service needs (from `x-shipit-secrets` in compose).
   * Phase 1: only the simple string form is supported. Object form (with
   * `description`, `required`, `agent`, `source`) is reserved for later phases.
   */
  secrets?: string[];
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

  const doc = parseYaml(content) as Record<string, unknown> | null;
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

    // Extract profiles
    const profiles = Array.isArray(svc.profiles)
      ? svc.profiles.map((p: unknown) => String(p))
      : undefined;

    // Preserve raw volumes for rewriting in override
    const volumes = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : undefined;

    // Extract x-shipit-secrets — Phase 1 supports the simple string form only.
    // The object form (`{ name, description, required, agent, source }`) is
    // reserved for later phases. Unknown shapes are tolerated (skipped) so a
    // future schema upgrade in user files doesn't break older orchestrators.
    const secrets = parseSecretEntries(name, svc["x-shipit-secrets"]);

    result.push({ name, ports, shipitPreview, profiles, volumes, secrets });
  }

  return result;
}

/**
 * Parse `x-shipit-secrets` for a service.
 *
 * Phase 1 accepts strings (env var name) and ignores object entries with a
 * warning — those become first-class once Phase 2 lands. Returns `undefined`
 * if no recognized entries were found, so the override can omit `env_file:`
 * for services that don't declare any secrets.
 */
function parseSecretEntries(serviceName: string, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: \`x-shipit-secrets\` must be a list.`,
    );
  }
  const names: string[] = [];
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
      names.push(trimmed);
    } else if (entry && typeof entry === "object") {
      // Object form (Phase 2+): { name, description, required, agent, source }
      const obj = entry as Record<string, unknown>;
      const n = obj.name;
      if (typeof n === "string" && n.trim()) {
        const trimmed = n.trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
          names.push(trimmed);
        }
      }
      // Silently skip if no usable name — extended fields land in later phases.
    }
  }
  return names.length > 0 ? names : undefined;
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

    // Inject the per-service secrets env file if the service declared any
    // secrets via `x-shipit-secrets`. The orchestrator writes the file before
    // running `docker compose up` (see secret-resolver.ts).
    if (svc.secrets && svc.secrets.length > 0) {
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

  // When using a workspace volume, declare it as external so compose doesn't
  // try to create it (it's managed by the orchestrator).
  if (opts.workspaceVolume) {
    override.volumes = {
      "shipit-workspace": {
        name: opts.workspaceVolume,
        external: true,
      },
    };
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
