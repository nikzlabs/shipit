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
}

export interface ComposeOverrideOptions {
  /** Session ID for labels and network naming. */
  sessionId: string;
  /** Compose config from shipit.yaml. */
  composeConfig: ComposeConfig;
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

    result.push({ name, ports, shipitPreview, profiles });
  }

  return result;
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
    const entry: Record<string, unknown> = {
      labels: {
        "shipit-parent-session": opts.sessionId,
        "shipit-service-name": svc.name,
        "shipit-preview-mode": mode,
      },
      networks: ["shipit-session"],
      cap_drop: ["NET_RAW"],
    };

    // Manual services get the shipit-manual profile
    if (mode === "manual") {
      const profiles = svc.profiles ? [...svc.profiles] : [];
      if (!profiles.includes("shipit-manual")) {
        profiles.push("shipit-manual");
      }
      entry.profiles = profiles;
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

  return `# Generated by ShipIt — do not edit manually.\n# This file is merged with your docker-compose.yml at runtime.\n${stringifyYaml(override, { lineWidth: 120 })}`;
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
