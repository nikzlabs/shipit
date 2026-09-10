import fs from "node:fs";
import path from "node:path";
import { isScalar, parse as parseYaml, parseDocument, stringify as stringifyYaml, visit } from "yaml";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { SecretRequirement } from "../shared/types/domain-types.js";
import { identityForSession, sessionWorkerUid } from "./session-worker-uid.js";
import { isSessionUid, SESSION_UID_MIN, SESSION_UID_MAX } from "./session-uid-allocator.js";
import { COMPOSE_OVERRIDE_FILE } from "./session-state-dir.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { EGRESS_PROXY_UID } from "./egress-proxy-install.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "../shared/plugin-contract.js";

export interface ComposeServiceOrigin {
  kind: "plugin";
  repo: string;
  alias: string;
  plugin: string;
  /** Service name before aliasing. */
  sourceName: string;
  /** The plugin shares the project's working tree and dependencies. */
  self: boolean;
}

export interface ComposeService {
  name: string;
  trustedOpsProxy?: boolean;
  ports?: string[];
  shipitPreview?: "auto" | "manual";
  dependsOnInstall?: boolean;
  profiles?: string[];
  stopGracePeriodMs?: number;
  volumes?: unknown[];
  secrets?: string[];
  secretRequirements?: SecretRequirement[];
  origin?: ComposeServiceOrigin;
  /** Complete definition: plugin fragments are not passed separately to Compose. */
  pluginDefinition?: Record<string, unknown>;
  externalVolumes?: string[];
  /** Label digest forces recreation when only the settings file changes. */
  settingsFingerprint?: string;
  user?: string;
}

export interface ComposeOverrideOptions {
  sessionId: string;
  composeConfig: ComposeConfig;
  workspaceVolume?: string;
  workspaceSubpath?: string;
  stackName?: string;
  containEgress?: boolean;
  containDns?: boolean;
  containProxy?: boolean;
  userNamedVolumes?: UserNamedVolume[];
  dockerSecrets?: {
    secretNames: string[];
    perService: Record<string, string[]>;
    filePathFor: (name: string) => string;
    /** Absolute daemon-side path; absent if wrapper staging failed. */
    entrypointHostPath?: string;
  };
  serviceEnvFiles?: Record<string, string>;
  /** Escaped environment values take precedence over fragment credentials. */
  pluginServiceEnv?: Record<string, Record<string, string>>;
  overlayDepDirs?: OverlayDepDirVolume[];
}

export interface OverlayDepDirVolume {
  depDir: string;
  volumeName: string;
}

/** Replaced after serialization; plugin validation must reject these literals in input. */
export const OVERRIDE_SENTINELS: readonly string[] = [
  "__RESET_PORTS__",
  "__RESET_NETWORKS__",
  "__RESET_DNS__",
];

const WORKSPACE_VOLUME_ALIAS = "shipit-workspace";

export type ComposeValidationKind = "malformed" | "refused";

export class ComposeValidationError extends Error {
  readonly kind: ComposeValidationKind;

  constructor(message: string, kind: ComposeValidationKind = "refused") {
    super(message);
    this.name = "ComposeValidationError";
    this.kind = kind;
  }
}

export interface ComposeFailure {
  kind: ComposeValidationKind;
  message: string;
}

export function classifyComposeFailure(err: unknown): ComposeFailure {
  return {
    kind: err instanceof ComposeValidationError ? err.kind : "malformed",
    message: err instanceof Error ? err.message : String(err),
  };
}

export interface UserNamedVolume {
  name: string;
}

/** Reads names for cleanup labels; admission checks belong to validateTopLevelVolumes. */
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

export function extractContainerPort(portMapping: string): number | undefined {
  if (!portMapping) return undefined;

  const withoutProtocol = portMapping.split("/")[0].trim();
  if (!withoutProtocol) return undefined;

  const parts = withoutProtocol.split(":");
  const portStr = parts[parts.length - 1];

  const port = parseInt(portStr, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}


/** Compose's own default when a service declares no `stop_grace_period`. */
export const DEFAULT_STOP_GRACE_PERIOD_MS = 10_000;

/** A long fallback reduces the risk of starting services before teardown finishes. */
export const UNKNOWN_STOP_GRACE_PERIOD_MS = 600_000;

export function parseStopGracePeriodMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : UNKNOWN_STOP_GRACE_PERIOD_MS;
  }
  if (typeof raw !== "string") return UNKNOWN_STOP_GRACE_PERIOD_MS;
  const text = raw.trim();
  if (text === "") return UNKNOWN_STOP_GRACE_PERIOD_MS;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(text)) return UNKNOWN_STOP_GRACE_PERIOD_MS;
  let total = 0;
  for (const [, value, , unit] of text.matchAll(/(\d+(\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(value) * unitMs[unit];
  }
  return total;
}

export function parseComposeFile(
  composePath: string,
  opts: { dockerSocket: boolean; containEgress?: boolean; trustedOpsProxy?: boolean },
): ComposeService[] {
  let content: string;
  try {
    content = fs.readFileSync(composePath, "utf-8");
  } catch {
    throw new ComposeValidationError(`Cannot read compose file: ${composePath}`, "malformed");
  }

  let doc: Record<string, unknown> | null;
  try {
    if (opts.containEgress) {
      const parsedDocument = parseDocument(content);
      let hasExplicitTag = false;
      let hasMergeKey = false;
      visit(parsedDocument, {
        Node: (_key, node) => {
          if (node.tag !== undefined) hasExplicitTag = true;
        },
        Pair: (_key, pair) => {
          if (isScalar(pair.key) && pair.key.value === "<<") hasMergeKey = true;
        },
      });
      if (hasExplicitTag || parsedDocument.warnings.some((warning) => /unresolved tag/i.test(warning.message))) {
        throw new ComposeValidationError("Custom YAML tags are not supported for contained services.");
      }
      if (hasMergeKey) {
        throw new ComposeValidationError("YAML merge keys are not supported for contained services.");
      }
    }
    // Resolve merge keys so validation sees the fields Compose will use.
    doc = parseYaml(content, { merge: true }) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof ComposeValidationError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ComposeValidationError(`Compose file is not valid YAML: ${msg}`, "malformed");
  }
  if (!doc || typeof doc !== "object") {
    throw new ComposeValidationError("Compose file must be a YAML mapping", "malformed");
  }
  if (doc.include !== undefined) {
    throw new ComposeValidationError(
      "Compose `include:` is not supported. ShipIt validates the compose file it is given, "
      + "and an included file would not be checked. Declare the services in this file.",
    );
  }
  validateTopLevelFileRefs("Secret", doc.secrets);
  validateTopLevelFileRefs("Config", doc.configs);
  validateTopLevelVolumes(doc.volumes);
  validateTopLevelNetworks(doc.networks);

  const services = doc.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || typeof services !== "object") {
    throw new ComposeValidationError("Compose file must have a `services` section", "malformed");
  }

  const result: ComposeService[] = [];

  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc !== "object" || svc === null) continue;

    // Open-mode extends remains allowed; inherited service fields are not validated here.
    if (opts.containEgress && svc.extends !== undefined) {
      throw new ComposeValidationError(`Service \`${name}\`: \`extends\` is not supported for contained services.`);
    }
    validateServiceSecurity(
      name,
      svc,
      opts.dockerSocket,
      opts.containEgress ?? false,
      opts.trustedOpsProxy ?? false,
    );
    validateServiceEnvFile(name, svc.env_file);

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

    const preview = svc["x-shipit-preview"];
    let shipitPreview: "auto" | "manual" | undefined;
    if (preview === "auto" || preview === "manual") {
      shipitPreview = preview;
    }

    const rawDepends = svc["x-shipit-depends-on-install"];
    let dependsOnInstall: boolean;
    if (typeof rawDepends === "boolean") {
      dependsOnInstall = rawDepends;
    } else {
      const effectivePreview = shipitPreview ?? (ports && ports.length > 0 ? "auto" : "manual");
      dependsOnInstall = effectivePreview === "auto";
    }

    const profiles = Array.isArray(svc.profiles)
      ? svc.profiles.map((p: unknown) => String(p))
      : undefined;

    const stopGracePeriodMs = parseStopGracePeriodMs(svc.stop_grace_period);

    const volumes = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : undefined;

    const requirements = parseSecretEntries(name, svc["x-shipit-secrets"]);
    const secrets = requirements?.map((r) => r.name);

    // Empty users must normalize as in validation, so the non-root fill-in applies.
    const rawUser =
      typeof svc.user === "string" || typeof svc.user === "number" ? String(svc.user) : undefined;
    const user = rawUser?.trim() ? rawUser : undefined;

    result.push({
      name,
      trustedOpsProxy: isTrustedOpsProxyService(name, svc, opts.trustedOpsProxy ?? false),
      ports,
      shipitPreview,
      dependsOnInstall,
      profiles,
      stopGracePeriodMs,
      volumes,
      secrets,
      secretRequirements: requirements,
      user,
    });
  }

  return result;
}

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
  }
  return requirements.length > 0 ? requirements : undefined;
}

export const ALLOWED_DEVICE = "/dev/kvm";

export function isDevKvmAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SESSION_ALLOW_DEV_KVM?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function parseDeviceEntry(dev: unknown): { host: string; container: string } | null {
  if (typeof dev === "string") {
    const parts = dev.split(":").map((p) => p.trim());
    const host = parts[0];
    if (!host) return null;
    return { host, container: parts[1] || host };
  }
  if (dev && typeof dev === "object") {
    const o = dev as Record<string, unknown>;
    if (typeof o.source === "string" && o.source.trim()) {
      const host = o.source.trim();
      const target = typeof o.target === "string" && o.target.trim() ? o.target.trim() : host;
      return { host, container: target };
    }
  }
  return null;
}

export function validateDevices(
  name: string,
  svc: Record<string, unknown>,
  allowDevKvm: boolean,
): void {
  if (svc.devices === undefined) return;
  if (!Array.isArray(svc.devices)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`devices\` must be a list.`);
  }
  for (const dev of svc.devices) {
    const parsed = parseDeviceEntry(dev);
    if (parsed?.host !== ALLOWED_DEVICE || parsed?.container !== ALLOWED_DEVICE) {
      const shown = typeof dev === "string" ? dev : JSON.stringify(dev);
      throw new ComposeValidationError(
        `Service \`${name}\`: device \`${shown}\` is not allowed. ShipIt only permits the ` +
        `exact \`/dev/kvm:/dev/kvm\` mapping (Android-emulator hardware acceleration); ` +
        `no other device passthrough is supported.`,
      );
    }
    if (!allowDevKvm) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`/dev/kvm\` passthrough is disabled on this deployment ` +
        `(SESSION_ALLOW_DEV_KVM=0). Ask the operator to enable it, or use a cloud device farm.`,
      );
    }
  }
}

/** Checks declared paths only; workspace symlinks can still escape these string checks. */
function validateReadablePath(kind: string, name: string, file: unknown): void {
  if (typeof file !== "string" || file.length === 0) return;
  if (file.includes("${")) {
    throw new ComposeValidationError(
      `${kind} \`${name}\`: variable interpolation is not allowed in a file path. `
      + "Use a resolved path inside the workspace.",
    );
  }
  if (file.startsWith("/")) {
    throw new ComposeValidationError(
      `${kind} \`${name}\`: absolute path \`${file}\` is not allowed. `
      + "Use a relative path within the workspace.",
    );
  }
  if (file.includes("..")) {
    throw new ComposeValidationError(
      `${kind} \`${name}\`: path traversal \`${file}\` is not allowed. `
      + "Referenced files must stay within the workspace.",
    );
  }
}

function showValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

function hasOptions(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function meansNotExternal(value: unknown): boolean {
  if (value === undefined || value === false) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "false";
}

function meansFalse(value: unknown): boolean {
  if (value === false) return true;
  return typeof value === "string"
    && ["false", "n", "no", "off"].includes(value.trim().toLowerCase());
}

function validateTopLevelVolumes(block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: definition must be a mapping.`,
      );
    }
    const vol = entry as Record<string, unknown>;
    if (hasOptions(vol.driver_opts)) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: \`driver_opts\` is not allowed. They can attach a host path `
        + "or a remote filesystem to the session (`type: none` + `device:` is a bind mount). "
        + "Use an ordinary named volume, or a service `tmpfs:` entry.",
      );
    }
    if (vol.driver !== undefined && vol.driver !== "local") {
      throw new ComposeValidationError(
        `Volume \`${name}\`: volume driver \`${showValue(vol.driver)}\` is not allowed. `
        + "Only Docker's built-in `local` driver is supported.",
      );
    }
    if (!meansNotExternal(vol.external)) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: \`external\` volumes are not allowed. They attach storage this `
        + "session did not create, including volumes belonging to other sessions.",
      );
    }
    if (vol.name !== undefined) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: a \`name:\` override is not allowed — it can point at a volume `
        + "outside this session. Compose names the volume after the project.",
      );
    }
  }
}

function validateTopLevelNetworks(block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    if (name === "shipit-session") {
      throw new ComposeValidationError(
        "The reserved `shipit-session` network cannot be declared by a project's compose file.",
      );
    }
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "object" || Array.isArray(entry)) {
      throw new ComposeValidationError(`Network \`${name}\`: definition must be a mapping.`);
    }
    const net = entry as Record<string, unknown>;
    if (net.driver !== undefined && net.driver !== "bridge") {
      throw new ComposeValidationError(
        `Network \`${name}\`: network driver \`${showValue(net.driver)}\` is not allowed. `
        + "Only Docker's built-in `bridge` driver is supported — `macvlan`/`ipvlan` attach the "
        + "container to the host's own network segment.",
      );
    }
    if (hasOptions(net.driver_opts) || hasOptions(net.ipam)) {
      const key = hasOptions(net.driver_opts) ? "driver_opts" : "ipam";
      throw new ComposeValidationError(
        `Network \`${name}\`: \`${key}\` is not allowed. It reaches host networking — a bridge `
        + "name is a host interface, and an address pool decides what a container presents as "
        + "its source IP. Declare the network with no options.",
      );
    }
    if (!meansNotExternal(net.external)) {
      throw new ComposeValidationError(
        `Network \`${name}\`: \`external\` networks are not allowed. They join a network this `
        + "session did not create, including networks belonging to other sessions.",
      );
    }
    if (net.name !== undefined) {
      throw new ComposeValidationError(
        `Network \`${name}\`: a \`name:\` override is not allowed — it can point at a network `
        + "outside this session. Compose names the network after the project.",
      );
    }
  }
}

/** Environment-backed sources depend on composeSpawnEnv excluding credentials. */
function validateTopLevelFileRefs(kind: string, block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    validateReadablePath(kind, name, (entry as Record<string, unknown>).file);
  }
}

function validateServiceEnvFile(name: string, envFile: unknown): void {
  const entries = Array.isArray(envFile) ? envFile : [envFile];
  for (const entry of entries) {
    if (typeof entry === "string") {
      validateReadablePath("Service", name, entry);
    } else if (entry && typeof entry === "object") {
      validateReadablePath("Service", name, (entry as Record<string, unknown>).path);
    }
  }
}

/** Restricts declarations, not build egress or filesystem access through contexts, SSH, and caches. */
function validateBuildSecurity(name: string, build: unknown): void {
  if (!build || typeof build !== "object" || Array.isArray(build)) return;
  const cfg = build as Record<string, unknown>;

  const network = cfg.network;
  if (network !== undefined && network !== null) {
    const value = typeof network === "string" || typeof network === "number"
      ? String(network).trim().toLowerCase()
      : "unsupported";
    if (value !== "" && value !== "none" && value !== "default") {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`build.network: ${showValue(network)}\` is not allowed for contained services. `
        + "A build step is not covered by ShipIt's service-network policy, so it may only use the "
        + "builder default or `none`.",
      );
    }
  }

  if (cfg.privileged !== undefined && !meansFalse(cfg.privileged)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`build.privileged\` is not allowed for contained services. `
      + "It asks BuildKit for the `security.insecure` entitlement.",
    );
  }

  if (Array.isArray(cfg.entitlements) ? cfg.entitlements.length > 0 : cfg.entitlements !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`build.entitlements\` is not allowed for contained services. `
      + "An entitlement widens the sandbox a build step runs in.",
    );
  }
}

function isTrustedOpsProxyService(
  name: string,
  svc: Record<string, unknown>,
  trustedOpsProxy: boolean,
): boolean {
  if (name !== "docker-socket-proxy" || !trustedOpsProxy
    || svc.image !== "tecnativa/docker-socket-proxy:0.3.0"
    || svc.build !== undefined || svc.command !== undefined || svc.entrypoint !== undefined
    || svc.configs !== undefined || svc.secrets !== undefined || svc.env_file !== undefined
    || svc.tmpfs !== undefined || svc.working_dir !== undefined || svc.healthcheck !== undefined
    || svc.user !== undefined || svc.pid !== undefined || svc.ipc !== undefined
    || svc.security_opt !== undefined || svc.cap_add !== undefined
    || svc.network_mode !== undefined) return false;
  const environment = svc.environment;
  const env: Record<string, unknown> = {};
  // List entries can inherit environment values that this validator cannot inspect.
  if (Array.isArray(environment)) return false;
  if (environment && typeof environment === "object") {
    Object.assign(env, environment);
  }
  const allowed = ["CONTAINERS", "EVENTS", "IMAGES", "INFO", "NETWORKS", "VOLUMES", "VERSION", "PING"];
  const denied = ["POST", "BUILD", "COMMIT", "EXEC", "AUTH", "CONFIGS", "DISTRIBUTION",
    "GRPC", "NODES", "PLUGINS", "SECRETS", "SERVICES", "SESSION", "SWARM", "SYSTEM", "TASKS"];
  const expectedKeys = new Set([...allowed, ...denied]);
  const hasReadOnlySocket = Array.isArray(svc.volumes) && svc.volumes.length === 1 && svc.volumes.some((vol) =>
    typeof vol === "string"
      ? /^\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro$/.test(vol)
      : Boolean(vol && typeof vol === "object"
        && (vol as Record<string, unknown>).source === "/var/run/docker.sock"
        && (vol as Record<string, unknown>).target === "/var/run/docker.sock"
        && (vol as Record<string, unknown>).read_only === true));
  return hasReadOnlySocket
    && Object.keys(env).length === expectedKeys.size
    && Object.keys(env).every((key) => expectedKeys.has(key))
    && allowed.every((key) => String(env[key]) === "1")
    && denied.every((key) => String(env[key]) === "0");
}

export function validateServiceSecurity(
  name: string,
  svc: Record<string, unknown>,
  dockerSocket: boolean,
  containEgress: boolean,
  trustedOpsProxy: boolean,
): void {
  if (containEgress) {
    const interpolationSensitive = [
      svc.privileged, svc.volumes, svc.devices, svc.network_mode, svc.user,
      svc.use_api_socket, svc.deploy, svc.labels, svc.cap_add, svc.post_start,
      svc.pre_stop, svc.extends,
      svc.volumes_from,
    ];
    const containsInterpolation = (value: unknown): boolean => {
      if (typeof value === "string") return value.includes("${");
      if (Array.isArray(value)) return value.some(containsInterpolation);
      return Boolean(value && typeof value === "object"
        && Object.entries(value).some(([key, nested]) => key.includes("${") || containsInterpolation(nested)));
    };
    if (interpolationSensitive.some(containsInterpolation)) {
      throw new ComposeValidationError(
        `Service \`${name}\`: Compose variable interpolation is not allowed in security-sensitive fields `
        + "for contained services. Use resolved literal values.",
      );
    }
  }
  const trustedProxyShape = isTrustedOpsProxyService(name, svc, trustedOpsProxy);
  if (svc.privileged === true) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`privileged: true\` is not allowed. ` +
      `Remove the privileged flag.`,
    );
  }

  if (svc.network_mode === "host") {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`network_mode: host\` is not allowed. ` +
      `Use explicit port mappings instead.`,
    );
  }


  // Added capabilities could disable the namespace firewall.
  if (containEgress && Array.isArray(svc.cap_add) && svc.cap_add.length > 0) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`cap_add\` is not allowed. Remove added Linux capabilities.`,
    );
  }
  if (containEgress && svc.use_api_socket === true) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`use_api_socket: true\` is not allowed for contained services.`,
    );
  }
  if (!dockerSocket && svc.use_api_socket === true) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`use_api_socket: true\` requires \`compose.docker-socket: true\`.`,
    );
  }
  if (containEgress && (svc.post_start !== undefined || svc.pre_stop !== undefined)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: Compose lifecycle hooks are not allowed for contained services.`,
    );
  }
  if (containEgress && svc.volumes_from !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`volumes_from\` is not allowed for contained services.`,
    );
  }
  if (containEgress) validateBuildSecurity(name, svc.build);

  const labels = svc.labels;
  const labelKeys = Array.isArray(labels)
    ? labels.map((entry) => typeof entry === "string" ? entry.split("=", 1)[0] : "")
    : labels && typeof labels === "object" ? Object.keys(labels) : [];
  const reserved = containEgress ? labelKeys.find((key) => key.startsWith("shipit-egress-")) : undefined;
  if (reserved) {
    throw new ComposeValidationError(
      `Service \`${name}\`: label \`${reserved}\` uses ShipIt's reserved egress namespace.`,
    );
  }
  const deploy = svc.deploy;
  if (containEgress && deploy && typeof deploy === "object") {
    const restartPolicy = (deploy as Record<string, unknown>).restart_policy;
    if (restartPolicy !== undefined) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`deploy.restart_policy\` is not allowed for contained services.`,
      );
    }
  }

  validateDevices(name, svc, isDevKvmAllowed());

  if (Array.isArray(svc.volumes)) {
    for (const vol of svc.volumes) {
      let source: string | undefined;
      if (typeof vol === "string") {
        // A bare path is an anonymous-volume target, not a host source.
        if (!vol.includes(":")) continue;
        source = vol.split(":")[0];
      } else if (vol && typeof vol === "object") {
        const obj = vol as Record<string, unknown>;
        if (obj.type === "volume") continue;
        if (typeof obj.source === "string") source = obj.source;
      }
      if (!source) continue;

      const isSocket = source === "/var/run/docker.sock";
      const socketReadOnly = typeof vol === "string"
        ? /^\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro$/.test(vol)
        : Boolean(vol && typeof vol === "object"
          && (vol as Record<string, unknown>).target === "/var/run/docker.sock"
          && (vol as Record<string, unknown>).read_only === true);
      if (isSocket && containEgress && !(trustedProxyShape && socketReadOnly)) {
        throw new ComposeValidationError(
          `Service \`${name}\`: direct Docker socket access is not allowed with contained egress. `
          + "Use ShipIt's trusted docker-socket-proxy service.",
        );
      }
      if (isSocket && !dockerSocket) {
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
  const declaredUser = typeof svc.user === "string" || typeof svc.user === "number"
    ? String(svc.user).trim()
    : "";
  const declaredUid = /^\d+(?::\d+)?$/.test(declaredUser)
    ? Number(declaredUser.split(":", 1)[0])
    : NaN;
  if (isSessionUid(declaredUid)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`user: ${declaredUser}\` is inside ${SESSION_UID_MIN}-${SESSION_UID_MAX}, `
      + "the UID range ShipIt reserves for per-session identities. A service running as another "
      + "session's UID is not something ShipIt can allow. Pick a UID below "
      + `${SESSION_UID_MIN} — the account your image already uses is almost certainly one.`,
    );
  }
  if (containEgress && !trustedProxyShape) {
    const containedUser = typeof svc.user === "string" || typeof svc.user === "number"
      ? String(svc.user).trim()
      : "";
    // Missing users get ShipIt's UID; a legacy root UID cannot satisfy containment.
    const fillInUid = sessionWorkerUid();
    const shipitFillsIn = containedUser === "" && fillInUid !== null && fillInUid > 0;
    const containedUid = /^\d+(?::\d+)?$/.test(containedUser)
      ? Number(containedUser.split(":", 1)[0])
      : NaN;
    if (!shipitFillsIn
      && (!Number.isInteger(containedUid) || containedUid <= 0
        || containedUid === EGRESS_RESOLVER_UID || containedUid === EGRESS_PROXY_UID)) {
      throw new ComposeValidationError(
        `Service \`${name}\`: contained services must declare a numeric, non-root \`user:\` `
        + `that is not reserved UID ${EGRESS_RESOLVER_UID} or ${EGRESS_PROXY_UID}. `
        + "Use an image that runs directly as this user, or use an Open session for root-init images.",
      );
    }
  }
}

function resolvePreviewMode(svc: ComposeService): "auto" | "manual" {
  if (svc.shipitPreview) return svc.shipitPreview;
  return svc.ports && svc.ports.length > 0 ? "auto" : "manual";
}

function isRelativeWorkspacePath(source: string): string | null {
  if (source === "." || source === "./") return "";
  if (!source.startsWith("./")) return null;
  return source.slice(2).replace(/\/+$/, "");
}

function joinSubpath(workspaceSubpath: string | undefined, relPath: string): string | undefined {
  if (workspaceSubpath && relPath) return `${workspaceSubpath}/${relPath}`;
  if (workspaceSubpath) return workspaceSubpath;
  if (relPath) return relPath;
  return undefined;
}

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
        if (!target) return vol;
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

function volumeSourceTarget(vol: unknown): { source: string | null; target: string | null } {
  if (typeof vol === "string") {
    const parts = vol.split(":");
    // Anonymous volumes still have targets and must participate in deduplication.
    if (parts.length >= 2) return { source: parts[0], target: parts[1] };
    return { source: null, target: parts[0] ?? null };
  }
  if (vol && typeof vol === "object") {
    const obj = vol as Record<string, unknown>;
    return {
      source: typeof obj.source === "string" ? obj.source : null,
      target: typeof obj.target === "string" ? obj.target : null,
    };
  }
  return { source: null, target: null };
}

function depDirWithinMount(mountSubdir: string, depDir: string): string | null {
  if (mountSubdir === "") return depDir;
  if (depDir === mountSubdir) return "";
  if (depDir.startsWith(`${mountSubdir}/`)) return depDir.slice(mountSubdir.length + 1);
  return null;
}

function overlayMountsForService(
  rawVolumes: unknown[],
  overlayDepDirs: OverlayDepDirVolume[],
  referenced: Set<string>,
): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const seenTargets = new Set<string>();
  for (const vol of rawVolumes) {
    const { source, target } = volumeSourceTarget(vol);
    if (source === null || target === null) continue;
    const mountSubdir = isRelativeWorkspacePath(source);
    if (mountSubdir === null) continue;
    for (const { depDir, volumeName } of overlayDepDirs) {
      const rel = depDirWithinMount(mountSubdir, depDir);
      if (rel === null) continue;
      const mountTarget = rel ? path.posix.join(target, rel) : target;
      if (seenTargets.has(mountTarget)) continue;
      seenTargets.add(mountTarget);
      referenced.add(volumeName);
      mounts.push({ type: "volume", source: volumeName, target: mountTarget });
    }
  }
  return mounts;
}

/** Only self plugins share project dependencies; tracked plugins do not wait for agent.install. */
function overlayMountsForPluginService(
  rawVolumes: unknown[],
  overlayDepDirs: OverlayDepDirVolume[],
  workspaceSubpath: string,
  referenced: Set<string>,
): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const seenTargets = new Set<string>();
  for (const vol of rawVolumes) {
    if (!vol || typeof vol !== "object") continue;
    const obj = vol as Record<string, unknown>;
    if (obj.source !== WORKSPACE_VOLUME_ALIAS || typeof obj.target !== "string") continue;
    const mountSubdir = workspaceSubdirOfMount(workspaceSubpath, obj);
    if (mountSubdir === null) continue;
    for (const { depDir, volumeName } of overlayDepDirs) {
      const rel = depDirWithinMount(mountSubdir, depDir);
      if (rel === null) continue;
      const mountTarget = rel ? path.posix.join(obj.target, rel) : obj.target;
      if (seenTargets.has(mountTarget)) continue;
      seenTargets.add(mountTarget);
      referenced.add(volumeName);
      mounts.push({ type: "volume", source: volumeName, target: mountTarget });
    }
  }
  return mounts;
}

function workspaceSubdirOfMount(workspaceSubpath: string, entry: Record<string, unknown>): string | null {
  const volume = entry.volume;
  const subpath = volume && typeof volume === "object"
    ? (volume as Record<string, unknown>).subpath
    : undefined;
  if (typeof subpath !== "string") return null;
  if (subpath === workspaceSubpath) return "";
  if (subpath.startsWith(`${workspaceSubpath}/`)) return subpath.slice(workspaceSubpath.length + 1);
  return null;
}

/** Compose decodes $$ to a literal $ without interpolation. */
export function escapeDollars(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\$/g, "$$$$");
  if (Array.isArray(value)) return value.map(escapeDollars);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key.replace(/\$/g, "$$$$")] = escapeDollars(nested);
    }
    return out;
  }
  return value;
}

function mergePluginCredentialEnv(
  existing: unknown,
  delivered: Record<string, string>,
): Record<string, unknown> {
  const base = (existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {});
  for (const [name, value] of Object.entries(delivered)) {
    if (PLUGIN_CONTRACT_ENV_NAMES.has(name)) continue;
    base[name] = escapeDollars(value);
  }
  return base;
}

export function generateComposeOverride(
  services: ComposeService[],
  opts: ComposeOverrideOptions,
): string {
  const overrideServices: Record<string, Record<string, unknown>> = {};
  const referencedOverlayVolumes = new Set<string>();

  for (const svc of services) {
    const applyServiceContainment = Boolean(opts.containEgress && !svc.trustedOpsProxy);
    const mode = resolvePreviewMode(svc);
    const labels: Record<string, string> = {
      "shipit-parent-session": opts.sessionId,
      "shipit-service-name": svc.name,
      "shipit-preview-mode": mode,
      // Always write false too, or a repository-supplied true can survive merging.
      "shipit-trusted-ops-proxy": svc.trustedOpsProxy ? "true" : "false",
    };
    if (opts.stackName) {
      labels["shipit-stack"] = opts.stackName;
    }
    if (svc.settingsFingerprint) {
      labels["shipit-plugin-settings"] = svc.settingsFingerprint;
    }
    const entry: Record<string, unknown> = {
      // ShipIt-owned fields must override the plugin definition.
      ...(svc.pluginDefinition ?? {}),
      labels,
      // A second bridge would permit egress before containment is installed.
      networks: opts.containEgress ? "__RESET_NETWORKS__" : ["shipit-session"],
      cap_drop: applyServiceContainment ? ["NET_RAW", "SETUID", "SETGID"] : ["NET_RAW"],
      // Internal networks still forward DNS; block it until the controlled resolver is ready.
      ...(opts.containDns ? { dns: "__RESET_DNS__" } : {}),
      ...(applyServiceContainment ? {
        restart: "no",
        security_opt: ["no-new-privileges"],
      } : {}),
      ...(opts.containProxy && !svc.trustedOpsProxy
        ? { sysctls: { "net.ipv4.conf.all.route_localnet": "1" } }
        : {}),
    };

    // Share workspace ownership with the agent unless the service declares its own user.
    const identity = identityForSession(opts.sessionId);
    const workerUid = identity?.uid ?? sessionWorkerUid();
    const workerGid = identity?.gid ?? workerUid;
    // The proxy entrypoint needs its image user to generate HAProxy configuration.
    const preservesImageStartupUser = svc.trustedOpsProxy === true
      || (!opts.containEgress && svc.name === "docker-socket-proxy");
    if (workerUid !== null && svc.user === undefined && !preservesImageStartupUser) {
      entry.user = `${workerUid}:${workerGid}`;
    } else if (workerGid !== null && svc.user !== undefined && !preservesImageStartupUser) {
      // Grant workspace writes; mounting shared caches would also expose them through this gid.
      entry.group_add = [String(workerGid)];
    }

    // !reset removes host bindings; a plain [] would retain inherited ports.
    if (svc.ports && svc.ports.length > 0) {
      entry.ports = "__RESET_PORTS__";
    }

    if (svc.volumes && opts.workspaceVolume) {
      entry.volumes = rewriteVolumes(svc.volumes, opts);
    }

    const ds = opts.dockerSecrets;
    if (svc.origin?.kind === "plugin") {
      // Plugins keep their own entrypoint; only project services use the secrets wrapper.
      const delivered = opts.pluginServiceEnv?.[svc.name];
      if (delivered && Object.keys(delivered).length > 0) {
        entry.environment = mergePluginCredentialEnv(entry.environment, delivered);
      }
    } else if (ds && svc.secrets && svc.secrets.length > 0) {
      const consumed = (ds.perService[svc.name] ?? []).filter((n) => ds.secretNames.includes(n));
      if (consumed.length > 0) {
        entry.secrets = consumed.map((n) => `shipit-${n}`);
        if (ds.entrypointHostPath) {
          const existingVolumes = (entry.volumes as unknown[] | undefined) ?? [];
          entry.volumes = [...existingVolumes, {
            type: "bind",
            source: ds.entrypointHostPath,
            target: "/shipit/secrets-entrypoint.sh",
            read_only: true,
          }];
          entry.entrypoint = ["/shipit/secrets-entrypoint.sh"];
        }
      }
    } else if (svc.secrets && svc.secrets.length > 0) {
      const envFilePath = opts.serviceEnvFiles?.[svc.name];
      if (envFilePath) {
        entry.env_file = [envFilePath];
      } else {
        console.warn(
          `[compose:${opts.sessionId}] service "${svc.name}" declares ` +
            `${svc.secrets.length} x-shipit-secrets entr${svc.secrets.length === 1 ? "y" : "ies"} ` +
            `but no env file was resolved for it — ShipIt will NOT inject those variables`,
        );
      }
    }

    const depDirs = opts.overlayDepDirs ?? [];
    if (depDirs.length > 0 && opts.workspaceVolume) {
      const isPlugin = svc.origin?.kind === "plugin";
      const overlayMounts = isPlugin
        ? (!svc.origin?.self || opts.workspaceSubpath === undefined ? [] : overlayMountsForPluginService(
          (entry.volumes as unknown[] | undefined) ?? [],
          depDirs,
          opts.workspaceSubpath,
          referencedOverlayVolumes,
        ))
        : (svc.volumes === undefined ? [] : overlayMountsForService(
          svc.volumes,
          depDirs,
          referencedOverlayVolumes,
        ));
      if (overlayMounts.length > 0) {
        const overlayTargets = new Set(overlayMounts.map((m) => m.target as string));
        const existing = (entry.volumes as unknown[] | undefined) ?? [];
        const kept = existing.filter((v) => !overlayTargets.has(volumeSourceTarget(v).target ?? ""));
        entry.volumes = [...kept, ...overlayMounts];
      }
    }

    overrideServices[svc.name] = entry;
  }

  const override: Record<string, unknown> = {
    services: overrideServices,
    networks: {
      "shipit-session": {
        name: `shipit-session-${opts.sessionId}`,
        ...(opts.containEgress ? { internal: true } : {}),
      },
    },
  };

  if (opts.dockerSecrets && opts.dockerSecrets.secretNames.length > 0) {
    const secretsBlock: Record<string, { file: string }> = {};
    for (const name of opts.dockerSecrets.secretNames) {
      secretsBlock[`shipit-${name}`] = {
        file: opts.dockerSecrets.filePathFor(name),
      };
    }
    override.secrets = secretsBlock;
  }

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
  for (const name of referencedOverlayVolumes) {
    volumeOverlay[name] = { name, external: true };
  }
  for (const svc of services) {
    for (const name of svc.externalVolumes ?? []) {
      if (!volumeOverlay[name]) volumeOverlay[name] = { name, external: true };
    }
  }
  if (Object.keys(volumeOverlay).length > 0) {
    override.volumes = volumeOverlay;
  }

  let yaml = stringifyYaml(override, { lineWidth: 120 });
  yaml = yaml.replace(/ports: __RESET_PORTS__/g, "ports: !reset []");
  yaml = yaml.replace(/networks: __RESET_NETWORKS__/g, "networks: !override\n      - shipit-session");
  yaml = yaml.replace(/dns: __RESET_DNS__/g, "dns: !override\n      - 192.0.2.1");
  return `# Generated by ShipIt — do not edit manually.\n# This file is merged with your docker-compose.yml at runtime.\n${yaml}`;
}

/** targetDir must be the private session state directory; the override contains credentials. */
export function writeComposeOverride(
  targetDir: string,
  content: string,
): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const overridePath = path.join(targetDir, COMPOSE_OVERRIDE_FILE);
  // chmod also restricts files created before secret delivery was added.
  fs.writeFileSync(overridePath, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(overridePath, 0o600);
  return overridePath;
}
