import fs from "node:fs";
import path from "node:path";
import { isScalar, parse as parseYaml, parseDocument, stringify as stringifyYaml, visit } from "yaml";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { SecretRequirement } from "../shared/types/domain-types.js";
import { identityForSession, sessionWorkerUid } from "./session-worker-uid.js";
import { isSessionUid, SESSION_UID_MIN, SESSION_UID_MAX } from "./session-uid-allocator.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { EGRESS_PROXY_UID } from "./egress-proxy-install.js";
import { NO_HOST_ADDRESS_OPTION } from "./egress-firewall.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "../shared/plugin-contract.js";
import { SESSION_CPU_SHARES } from "./container-config-builder.js";
import { stackLabel } from "./stack-label.js";
import { composeProjectName } from "./compose-stack-reaper.js";
import { gpuRequestRefusal } from "./session-gpu.js";

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
  /** The resolved `environment` sets `HOME`; Compose has put the `env_file` values there. */
  declaresHome?: boolean;
  /** Subdirectories of /persist the service mounts; "" is /persist itself. */
  persistSubpaths?: string[];
  /** The workspace paths of this start's binds, which the snapshot mounts as volume subpaths. */
  workspaceMounts?: WorkspaceMountRecord[];
}

export interface WorkspaceMountRecord {
  /** Relative to the workspace; "" is the workspace itself. */
  relPath: string;
  target: string;
}

/** Reserved volume name: a service mounting it gets the session's own /persist (docs/317). */
export const PERSIST_VOLUME = "persist";

export interface PersistVolume {
  /** Daemon-side path of the session's scratch directory, the one the agent sees at /persist. */
  device: string;
}

export interface ComposeOverrideOptions {
  sessionId: string;
  composeConfig: ComposeConfig;
  workspaceVolume?: string;
  workspaceSubpath?: string;
  /** Daemon-side path of this session's workspace; required once a mount names a subdirectory of it. */
  workspaceDevice?: string;
  stackName?: string;
  containEgress?: boolean;
  /** Services start with no route out and get a firewall first; implied by `containEgress` (docs/319-api-reach-through-host). */
  isolateNetwork?: boolean;
  containDns?: boolean;
  containProxy?: boolean;
  /** Built by this start's `build`; `up --no-build` must not pull over them. */
  builtServices?: readonly string[];
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

/** The shared workspace volume: its root holds every session, not only this one. */
export const WORKSPACE_VOLUME_ALIAS = "shipit-workspace";

/** Rooted at this session's workspace, so Docker confines each subpath to that directory. */
export const SESSION_WORKSPACE_VOLUME_ALIAS = "shipit-session-workspace";

const RESERVED_VOLUME_NAMES: readonly string[] = [WORKSPACE_VOLUME_ALIAS, SESSION_WORKSPACE_VOLUME_ALIAS];

export const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

const OPS_PROXY_REPOSITORY = "tecnativa/docker-socket-proxy";
const OPS_PROXY_DIGEST = "sha256:9e4b9e7517a6b660f2cc903a19b257b1852d5b3344794e3ea334ff00ae677ac2";
// TODO(planning#620): confirm against registry-1.docker.io; read from ghcr.io, which the same upstream push fills.
export const TRUSTED_OPS_PROXY_IMAGE = `${OPS_PROXY_REPOSITORY}:0.3.0@${OPS_PROXY_DIGEST}`;

// Ops sessions created before the pin name the tag; the override runs the pinned image either way.
const LEGACY_OPS_PROXY_IMAGE = `${OPS_PROXY_REPOSITORY}:0.3.0`;

/** The user's `project.allowDockerSocket` for the session's repository (docs/318 req 8). */
export type DockerSocketGrant = "granted" | "not_granted" | "no_repository";

export interface DockerSocketAccess {
  /** `compose.docker-socket` in shipit.yaml: the repository asks; only the grant allows. */
  requested: boolean;
  grant: DockerSocketGrant;
}

export const NO_DOCKER_SOCKET: DockerSocketAccess = { requested: false, grant: "not_granted" };

const SOCKET_SETTING_HINT = "the user turns it on with \"Give this project's services the Docker socket\" "
  + "(`project.allowDockerSocket`) in Project Settings → Deployments → Agent permissions";

/** Open sessions only; NET_RAW is left off because ShipIt drops it from every service. */
export const SAFE_ADDED_CAPABILITIES: ReadonlySet<string> = new Set([
  "NET_ADMIN", "SYS_PTRACE", "IPC_LOCK", "SYS_NICE",
  // Docker's default set.
  "AUDIT_WRITE", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD",
  "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT",
]);

/**
 * Service keys ShipIt accepts besides `x-` ones: each has no effect outside the service's
 * container, or is checked in this file (docs/318 req 7, requirements Q15). Others are refused.
 */
export const CLASSIFIED_SERVICE_FIELDS: ReadonlySet<string> = new Set([
  "attach", "build", "cap_add", "cap_drop", "cgroup", "command", "configs", "container_name",
  "cpu_count", "cpu_percent", "cpu_period", "cpu_quota", "cpu_shares", "cpus", "cpuset",
  "depends_on", "deploy", "develop", "device_cgroup_rules", "devices", "dns", "dns_opt",
  "dns_search", "domainname", "entrypoint", "env_file", "environment", "expose", "extends",
  "extra_hosts", "gpus", "group_add", "healthcheck", "hostname", "image", "init", "ipc", "label_file",
  "labels", "links", "logging", "mem_limit", "mem_reservation", "mem_swappiness", "memswap_limit",
  "network_mode", "networks", "pid", "pids_limit", "platform", "ports", "post_start", "pre_stop",
  "privileged", "profiles", "provider", "pull_policy", "pull_refresh_after", "read_only", "restart",
  "scale", "secrets", "security_opt", "shm_size", "stdin_open", "stop_grace_period", "stop_signal",
  "sysctls", "tmpfs", "tty", "ulimits", "use_api_socket", "user", "userns_mode", "uts", "volumes",
  "volumes_from", "working_dir",
]);

const NAMESPACE_FIELDS = ["pid", "ipc", "network_mode", "uts", "cgroup", "userns_mode"] as const;

const NO_NEW_PRIVILEGES_OPTIONS: ReadonlySet<string> = new Set([
  "no-new-privileges", "no-new-privileges:true", "no-new-privileges=true",
]);

const LOCAL_LOG_DRIVERS: ReadonlySet<string> = new Set(["json-file", "local"]);

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

export interface ComposeParseOptions {
  /** `compose.docker-socket` in shipit.yaml. */
  dockerSocket: boolean;
  /** Absent means not granted. */
  dockerSocketGrant?: DockerSocketGrant;
  containEgress?: boolean;
  /** Implied by `containEgress` (docs/319-api-reach-through-host). */
  isolateNetwork?: boolean;
  trustedOpsProxy?: boolean;
}

function socketAccessOf(opts: ComposeParseOptions): DockerSocketAccess {
  return { requested: opts.dockerSocket, grant: opts.dockerSocketGrant ?? "not_granted" };
}

/**
 * The service map, from the project file's raw bytes, after the syntax checks
 * (docs/318-compose-remaining-escapes, Mechanism 2 step 2). The security checks run once, on the
 * model Compose resolves (`validateResolvedModel`).
 */
export function parseComposeContent(content: string | Buffer, opts: ComposeParseOptions): ComposeService[] {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  let doc: Record<string, unknown> | null;
  try {
    if (opts.containEgress) {
      const parsedDocument = parseDocument(text);
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
    doc = parseYaml(text, { merge: true }) as Record<string, unknown> | null;
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
  validateTopLevelFilePaths("Secret", doc.secrets);
  validateTopLevelFilePaths("Config", doc.configs);

  const services = doc.services as Record<string, Record<string, unknown>> | undefined;
  if (!services || typeof services !== "object") {
    throw new ComposeValidationError("Compose file must have a `services` section", "malformed");
  }

  const containEgress = opts.containEgress ?? false;
  const result: ComposeService[] = [];

  for (const [name, svc] of Object.entries(services)) {
    if (typeof svc !== "object" || svc === null) continue;

    if (containEgress && svc.extends !== undefined) {
      throw new ComposeValidationError(`Service \`${name}\`: \`extends\` is not supported for contained services.`);
    }
    validateContainedInterpolation(name, svc, containEgress);
    validateRawVolumeSources(name, svc.volumes);
    validateServiceEnvFile(name, svc.env_file);
    validateServiceLabelFile(name, svc.label_file);

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
    const persistSubpaths = (volumes ?? [])
      .map((vol) => persistSubpathOf(name, vol))
      .filter((subpath): subpath is string => subpath !== null);

    const requirements = parseSecretEntries(name, svc["x-shipit-secrets"]);
    const secrets = requirements?.map((r) => r.name);

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
      user: normalizedUser(svc.user),
      ...(persistSubpaths.length > 0 ? { persistSubpaths } : {}),
    });
  }

  return result;
}

// Empty users must normalize as in validation, so the non-root fill-in applies.
export function normalizedUser(raw: unknown): string | undefined {
  const user = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  return user?.trim() ? user : undefined;
}

/** No image has an account for a session UID, and Docker's home for a UID with no account is `/`, which it cannot write. */
export const SERVICE_HOME = "/tmp";

/** Reads the mapping form only: Compose's resolved model and a normalized plugin definition both use it. */
export function declaresHome(environment: unknown): boolean {
  return isMapping(environment) && Object.hasOwn(environment, "HOME");
}

export interface ResolvedModelContext extends ComposeParseOptions {
  /** Compose names a declared volume, network, secret, or config `<project>_<key>`. */
  project: string;
  workspaceDir: string;
}

export interface ResolvedModelCheck {
  /** Services in the ops template's proxy form; the override runs the pinned image for them. */
  trustedOpsProxies: Set<string>;
}

/**
 * The security checks, on the model `docker compose config` resolved: what `up` runs, with
 * interpolation, `extends`, and relative paths already applied (docs/318-compose-remaining-escapes,
 * Mechanism 2 step 3).
 */
export function validateResolvedModel(model: unknown, ctx: ResolvedModelContext): ResolvedModelCheck {
  if (!isMapping(model) || !isMapping(model.services)) {
    throw new ComposeValidationError("Compose's resolved model has no `services` section.", "malformed");
  }
  validateTopLevelVolumes(model.volumes, ctx.project);
  validateTopLevelNetworks(model.networks, ctx.project);
  validateResolvedFileObjects("Secret", model.secrets, ctx);
  validateResolvedFileObjects("Config", model.configs, ctx);

  const declaredVolumes = new Set(isMapping(model.volumes) ? Object.keys(model.volumes) : []);
  const socket = socketAccessOf(ctx);
  const containEgress = ctx.containEgress ?? false;
  const isolateNetwork = ctx.isolateNetwork ?? false;
  const opsSession = ctx.trustedOpsProxy ?? false;
  const trustedOpsProxies = new Set<string>();
  const entries: [string, Record<string, unknown>][] = [];
  for (const [name, svc] of Object.entries(model.services)) {
    if (!isMapping(svc)) {
      throw new ComposeValidationError(`Service \`${name}\`: its resolved definition is not a mapping.`, "malformed");
    }
    entries.push([name, svc]);
    validateClassifiedFields(name, svc);
    validateServiceSettings(name, svc, socket, containEgress, opsSession, isolateNetwork);
    validateResolvedServiceFiles(name, svc);
    validateResolvedMounts(name, svc.volumes, declaredVolumes, ctx.workspaceDir);
    if (isTrustedOpsProxyService(name, svc, opsSession)) trustedOpsProxies.add(name);
  }
  validateSocketJoins(entries);
  if (opsSession) validateOpsProxyImageUse(entries);
  return { trustedOpsProxies };
}

/**
 * The /persist subdirectory a volume entry mounts ("" for /persist itself), or null when the entry
 * does not mount `persist`. Accepts `persist:/t`, `persist/sub:/t`, and the long form with
 * `source: persist` and an optional `volume.subpath`.
 */
export function persistSubpathOf(serviceName: string, vol: unknown): string | null {
  if (typeof vol === "string") {
    if (!vol.includes(":")) return null;
    const source = vol.split(":")[0];
    if (source === PERSIST_VOLUME) return "";
    if (!source.startsWith(`${PERSIST_VOLUME}/`)) return null;
    return normalizePersistSubpath(serviceName, source.slice(PERSIST_VOLUME.length + 1));
  }
  if (!vol || typeof vol !== "object") return null;
  const obj = vol as Record<string, unknown>;
  if (obj.source !== PERSIST_VOLUME || (obj.type !== undefined && obj.type !== "volume")) return null;
  const options = obj.volume && typeof obj.volume === "object"
    ? (obj.volume as Record<string, unknown>)
    : {};
  if (options.subpath === undefined) return "";
  if (typeof options.subpath !== "string") {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: the \`persist\` volume's \`volume.subpath\` must be a string.`,
    );
  }
  return normalizePersistSubpath(serviceName, options.subpath);
}

// Docker confines the subpath to the volume root on its own; these checks give a readable refusal.
function normalizePersistSubpath(serviceName: string, raw: string): string {
  if (raw.includes("$")) {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: variable interpolation is not allowed in a \`persist\` subpath `
      + `(\`${raw}\`). Name the directory literally.`,
    );
  }
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: the \`persist\` subpath \`${raw}\` leaves /persist. `
      + "Name a directory inside /persist, without `..`.",
    );
  }
  return parts.join("/");
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

// Compose also reads string spellings such as "true" as set.
function meansSet(value: unknown): boolean {
  return value !== undefined && value !== null && !meansFalse(value);
}

function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The one `name:` a resolved declaration may carry: the one Compose itself gives it.
function isComposeAssignedName(value: unknown, key: string, project: string | undefined): boolean {
  return project !== undefined && value === `${project}_${key}`;
}

function validateTopLevelVolumes(block: unknown, project?: string): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    if (RESERVED_VOLUME_NAMES.includes(name)) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: the name is reserved for ShipIt's own workspace mounts. Rename the volume.`,
      );
    }
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
    if (vol.name !== undefined && !isComposeAssignedName(vol.name, name, project)) {
      throw new ComposeValidationError(
        `Volume \`${name}\`: a \`name:\` override is not allowed — it can point at a volume `
        + "outside this session. Compose names the volume after the project.",
      );
    }
  }
}

function validateTopLevelNetworks(block: unknown, project?: string): void {
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
    if (net.name !== undefined && !isComposeAssignedName(net.name, name, project)) {
      throw new ComposeValidationError(
        `Network \`${name}\`: a \`name:\` override is not allowed — it can point at a network `
        + "outside this session. Compose names the network after the project.",
      );
    }
  }
}

function validateTopLevelFilePaths(kind: "Secret" | "Config", block: unknown): void {
  if (!isMapping(block)) return;
  for (const [name, entry] of Object.entries(block)) {
    if (isMapping(entry)) validateReadablePath(kind, name, entry.file);
  }
}

/** Environment-backed sources depend on composeSpawnEnv excluding credentials. */
function validateResolvedFileObjects(
  kind: "Secret" | "Config",
  block: unknown,
  ctx: ResolvedModelContext,
): void {
  if (!isMapping(block)) return;
  for (const [name, entry] of Object.entries(block)) {
    if (!isMapping(entry)) continue;
    if (!meansNotExternal(entry.external)) {
      throw new ComposeValidationError(
        `${kind} \`${name}\`: \`external: ${showValue(entry.external)}\` is not allowed. It attaches an object `
        + "this session did not create. Declare it with `file:` and a path in the workspace.",
      );
    }
    if (entry.name !== undefined && !isComposeAssignedName(entry.name, name, ctx.project)) {
      throw new ComposeValidationError(
        `${kind} \`${name}\`: \`name: ${showValue(entry.name)}\` is not allowed — it can point at an object `
        + "outside this session. Remove it; Compose names the object after the project.",
      );
    }
    if (entry.file === undefined) continue;
    if (typeof entry.file !== "string" || entry.file.includes("$") || !path.posix.isAbsolute(entry.file)) {
      throw new ComposeValidationError(
        `${kind} \`${name}\`: Compose left \`file: ${showValue(entry.file)}\` unresolved. Name a file inside the workspace.`,
      );
    }
    if (!isWithinDir(entry.file, ctx.workspaceDir)) {
      throw new ComposeValidationError(
        `${kind} \`${name}\`: \`file:\` resolves to \`${entry.file}\`, outside this session's workspace. `
        + "Put the file inside the workspace and name it with a relative path.",
      );
    }
  }
}

function isWithinDir(p: string, dir: string): boolean {
  const rel = path.posix.relative(dir, p);
  return rel !== ".." && !rel.startsWith("../") && !path.posix.isAbsolute(rel);
}

function validateServiceLabelFile(name: string, labelFile: unknown): void {
  if (labelFile === undefined || labelFile === null) return;
  for (const entry of Array.isArray(labelFile) ? labelFile : [labelFile]) {
    validateReadablePath("Service", name, entry);
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
        `Service \`${name}\`: \`build.network: ${showValue(network)}\` is not allowed. `
        + "A build may use only the builder default (omit the key) or `none`.",
      );
    }
  }

  if (cfg.privileged !== undefined && !meansFalse(cfg.privileged)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`build.privileged: ${showValue(cfg.privileged)}\` is not allowed. `
      + "Remove it; a build runs without extra privileges.",
    );
  }

  if (Array.isArray(cfg.entitlements) ? cfg.entitlements.length > 0 : cfg.entitlements !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`build.entitlements: ${showValue(cfg.entitlements)}\` is not allowed. `
      + "Remove it; a build runs without extra entitlements.",
    );
  }
}

function buildTags(build: unknown): unknown[] {
  if (!build || typeof build !== "object" || Array.isArray(build)) return [];
  const tags = (build as Record<string, unknown>).tags;
  return Array.isArray(tags) ? tags : [];
}

function namesOpsProxyImage(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const lower = ref.trim().toLowerCase();
  if (lower.includes(OPS_PROXY_DIGEST.slice("sha256:".length))) return true;
  const withoutDigest = lower.split("@", 1)[0];
  const tagAt = withoutDigest.indexOf(":", withoutDigest.lastIndexOf("/") + 1);
  const repository = tagAt === -1 ? withoutDigest : withoutDigest.slice(0, tagAt);
  return repository.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "")
    === OPS_PROXY_REPOSITORY;
}

// The ops template's keys only: this container holds the socket.
const TRUSTED_OPS_PROXY_FIELDS: ReadonlySet<string> = new Set([
  "image", "environment", "volumes", "restart", "x-shipit-preview", "x-shipit-depends-on-install",
]);

const OPS_PROXY_HINT = "ShipIt trusts `docker-socket-proxy` only as the ops template defines it, "
  + `with image \`${TRUSTED_OPS_PROXY_IMAGE}\`. Restore that definition.`;

function isTrustedOpsProxyService(
  name: string,
  svc: Record<string, unknown>,
  trustedOpsProxy: boolean,
): boolean {
  if (name !== "docker-socket-proxy" || !trustedOpsProxy) return false;
  if (svc.image !== TRUSTED_OPS_PROXY_IMAGE && svc.image !== LEGACY_OPS_PROXY_IMAGE) return false;
  if (Object.keys(svc).some((key) => !TRUSTED_OPS_PROXY_FIELDS.has(key)
    && !(key === "networks" && isImplicitDefaultNetwork(svc.networks)))) return false;
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
        && (vol as Record<string, unknown>).source === DOCKER_SOCKET_PATH
        && (vol as Record<string, unknown>).target === DOCKER_SOCKET_PATH
        && (vol as Record<string, unknown>).read_only === true));
  return hasReadOnlySocket
    && Object.keys(env).length === expectedKeys.size
    && Object.keys(env).every((key) => expectedKeys.has(key))
    && allowed.every((key) => String(env[key]) === "1")
    && denied.every((key) => String(env[key]) === "0");
}

// Compose puts a service with no `networks:` on the project's default network.
function isImplicitDefaultNetwork(networks: unknown): boolean {
  if (!isMapping(networks)) return false;
  const keys = Object.keys(networks);
  const value = networks.default;
  return keys.length === 1 && keys[0] === "default"
    && (value === null || (isMapping(value) && Object.keys(value).length === 0));
}

function socketGranted(socket: DockerSocketAccess): boolean {
  return socket.requested && socket.grant === "granted";
}

function refuseDockerSocket(
  name: string,
  what: string,
  socket: DockerSocketAccess,
  opsSession: boolean,
): never {
  if (name === "docker-socket-proxy" && opsSession) {
    throw new ComposeValidationError(`Service \`${name}\`: ${what} is not allowed here. ${OPS_PROXY_HINT}`);
  }
  if (socket.grant === "no_repository") {
    throw new ComposeValidationError(
      `Service \`${name}\`: ${what} is not allowed in a session without a repository. For Docker in `
      + "this session, the user can turn on \"Docker access\" in Session settings.",
    );
  }
  if (name === "docker-socket-proxy") {
    throw new ComposeValidationError(
      `Service \`${name}\`: Docker socket mount is only allowed for ` +
      `server-created ops sessions. Recreate it from the sidebar's ` +
      `"New advanced session" menu → "Ops session" so it is marked as kind="ops".`,
    );
  }
  if (!socket.requested) {
    throw new ComposeValidationError(
      `Service \`${name}\`: ${what} is not allowed. It needs \`compose.docker-socket: true\` in `
      + `shipit.yaml, and ${SOCKET_SETTING_HINT}.`,
    );
  }
  throw new ComposeValidationError(
    `Service \`${name}\`: ${what} needs the user's permission. \`compose.docker-socket: true\` asks `
    + `for the Docker socket, and ${SOCKET_SETTING_HINT}.`,
  );
}

function validateNamespaces(name: string, svc: Record<string, unknown>): void {
  for (const field of NAMESPACE_FIELDS) {
    const raw = svc[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new ComposeValidationError(`Service \`${name}\`: \`${field}\` must be a string.`);
    }
    const value = raw.trim().toLowerCase();
    if (value === "host" || value.startsWith("container:")) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`${field}: ${raw}\` is not allowed. Share it only with a service of `
        + `this project (\`${field}: service:<name>\`), or omit it.`,
      );
    }
  }
}

function capabilityName(entry: unknown): string {
  return typeof entry === "string" ? entry.trim().toUpperCase().replace(/^CAP_/, "") : "";
}

function validateCapAdd(name: string, capAdd: unknown): void {
  if (capAdd === undefined || capAdd === null) return;
  if (!Array.isArray(capAdd)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`cap_add\` must be a list.`);
  }
  for (const entry of capAdd) {
    const cap = capabilityName(entry);
    if (SAFE_ADDED_CAPABILITIES.has(cap)) continue;
    throw new ComposeValidationError(
      `Service \`${name}\`: \`cap_add: ${showValue(entry)}\` is not allowed. A service may add only `
      + `${[...SAFE_ADDED_CAPABILITIES].join(", ")}.`,
    );
  }
}

function validateSecurityOpt(name: string, securityOpt: unknown): void {
  if (securityOpt === undefined || securityOpt === null) return;
  if (!Array.isArray(securityOpt)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`security_opt\` must be a list.`);
  }
  for (const entry of securityOpt) {
    if (typeof entry === "string" && NO_NEW_PRIVILEGES_OPTIONS.has(entry.trim())) continue;
    throw new ComposeValidationError(
      `Service \`${name}\`: \`security_opt: ${showValue(entry)}\` is not allowed. `
      + "The only security option a service may set is `no-new-privileges`.",
    );
  }
}

function validateLogging(name: string, logging: unknown): void {
  if (logging === undefined || logging === null) return;
  if (typeof logging !== "object" || Array.isArray(logging)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`logging\` must be a mapping.`);
  }
  const driver = (logging as Record<string, unknown>).driver;
  if (driver === undefined || driver === null) return;
  if (typeof driver === "string" && LOCAL_LOG_DRIVERS.has(driver.trim())) return;
  throw new ComposeValidationError(
    `Service \`${name}\`: \`logging.driver: ${showValue(driver)}\` is not allowed. `
    + "Use `json-file` or `local`, or omit the driver.",
  );
}

function validateHooks(name: string, svc: Record<string, unknown>): void {
  for (const field of ["post_start", "pre_stop"] as const) {
    const hooks = svc[field];
    if (hooks === undefined || hooks === null) continue;
    if (!Array.isArray(hooks)) {
      throw new ComposeValidationError(`Service \`${name}\`: \`${field}\` must be a list.`);
    }
    hooks.forEach((hook, index) => {
      if (!hook || typeof hook !== "object") return;
      const privileged = (hook as Record<string, unknown>).privileged;
      if (!meansSet(privileged)) return;
      throw new ComposeValidationError(
        `Service \`${name}\`: \`${field}[${index}].privileged: ${showValue(privileged)}\` is not allowed. `
        + "Run the hook without extra privileges.",
      );
    });
  }
}

function validateVolumesFrom(name: string, volumesFrom: unknown): void {
  if (volumesFrom === undefined || volumesFrom === null) return;
  if (!Array.isArray(volumesFrom)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`volumes_from\` must be a list.`);
  }
  for (const entry of volumesFrom) {
    if (typeof entry !== "string") {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`volumes_from\` entry \`${showValue(entry)}\` must name a service of this project.`,
      );
    }
    if (entry.trim().toLowerCase().startsWith("container:")) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`volumes_from: ${entry}\` is not allowed. Name a service of this project instead.`,
      );
    }
  }
}

const GPU_REQUEST_FIELDS: ReadonlySet<string> = new Set(["capabilities", "count", "device_ids", "driver", "options"]);

function reservedDevices(svc: Record<string, unknown>): Record<string, unknown> | undefined {
  const deploy = svc.deploy;
  if (!isMapping(deploy) || !isMapping(deploy.resources)) return undefined;
  const reservations = deploy.resources.reservations;
  return isMapping(reservations) ? reservations : undefined;
}

function hasEntries(value: unknown): boolean {
  return value !== undefined && value !== null && !isEmptyList(value);
}

/** A GPU in either Compose spelling; whether the session can give one is the rewrite's question. */
export function requestsGpu(svc: Record<string, unknown>): boolean {
  return hasEntries(reservedDevices(svc)?.devices) || hasEntries(svc.gpus);
}

function validateGpuEntry(name: string, where: string, entry: unknown, capabilitiesRequired: boolean): void {
  if (!isMapping(entry)) {
    throw new ComposeValidationError(`Service \`${name}\`: each \`${where}\` entry must be a mapping.`);
  }
  const extra = Object.keys(entry).find((key) => !GPU_REQUEST_FIELDS.has(key));
  if (extra !== undefined) {
    throw new ComposeValidationError(`Service \`${name}\`: \`${where}\` field \`${extra}\` is not allowed.`);
  }
  const caps = entry.capabilities;
  const refusal = gpuRequestRefusal({
    driver: entry.driver,
    // A Compose list is one set that must all hold.
    capabilities: caps === undefined || caps === null ? caps : [caps],
    options: entry.options,
    capabilitiesRequired,
  });
  if (refusal) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`${where}\` may only request an NVIDIA GPU: ${refusal}.`,
    );
  }
}

/** The one device reservation a service may make is a GPU (docs/325-session-gpu-access req 3). */
function validateGpuRequests(name: string, svc: Record<string, unknown>): void {
  const devices = reservedDevices(svc)?.devices;
  if (hasEntries(devices)) {
    if (!Array.isArray(devices)) {
      throw new ComposeValidationError(`Service \`${name}\`: \`deploy.resources.reservations.devices\` must be a list.`);
    }
    for (const entry of devices) validateGpuEntry(name, "deploy.resources.reservations.devices", entry, true);
  }
  const gpus = svc.gpus;
  if (!hasEntries(gpus) || gpus === "all") return;
  if (!Array.isArray(gpus)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`gpus\` must be \`all\` or a list.`);
  }
  // Compose adds the `gpu` capability to a `gpus:` entry itself.
  for (const entry of gpus) validateGpuEntry(name, "gpus", entry, false);
}

function removeGpuRequests(svc: Record<string, unknown>): void {
  delete svc.gpus;
  const reservations = reservedDevices(svc);
  if (reservations) delete reservations.devices;
}

/** Host or volume source of a mount entry; undefined for an anonymous volume. */
function volumeSource(vol: unknown): string | undefined {
  if (typeof vol === "string") {
    // A bare path is an anonymous-volume target, not a host source.
    return vol.includes(":") ? vol.split(":")[0] : undefined;
  }
  if (vol && typeof vol === "object") {
    const source = (vol as Record<string, unknown>).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

function mountsDockerSocket(svc: Record<string, unknown>): boolean {
  if (meansSet(svc.use_api_socket)) return true;
  return Array.isArray(svc.volumes) && svc.volumes.some((vol) =>
    volumeSource(vol) === DOCKER_SOCKET_PATH
    && !(vol && typeof vol === "object" && (vol as Record<string, unknown>).type === "volume"));
}

function volumesFromServices(svc: Record<string, unknown>): string[] {
  if (!Array.isArray(svc.volumes_from)) return [];
  return svc.volumes_from
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.split(":", 1)[0].trim());
}

function serviceNamespaceTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("service:") ? trimmed.slice("service:".length).trim() : null;
}

// A join shares the holder's socket, which only the grant gives.
function validateSocketJoins(services: [string, Record<string, unknown>][]): void {
  const holders = new Set(services.filter(([, svc]) => mountsDockerSocket(svc)).map(([name]) => name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, svc] of services) {
      if (holders.has(name) || !volumesFromServices(svc).some((target) => holders.has(target))) continue;
      holders.add(name);
      grew = true;
    }
  }
  for (const [name, svc] of services) {
    const inherited = volumesFromServices(svc).find((target) => holders.has(target));
    if (inherited !== undefined) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`volumes_from: ${inherited}\` is not allowed, because \`${inherited}\` has the `
        + "Docker socket. Mount what the service needs directly.",
      );
    }
    for (const field of NAMESPACE_FIELDS) {
      const target = serviceNamespaceTarget(svc[field]);
      if (target === null || !holders.has(target)) continue;
      throw new ComposeValidationError(
        `Service \`${name}\`: \`${field}: service:${target}\` is not allowed, because \`${target}\` has the `
        + "Docker socket. Give the service its own namespace.",
      );
    }
  }
}

function validateOpsProxyImageUse(services: [string, Record<string, unknown>][]): void {
  for (const [name, svc] of services) {
    if (isTrustedOpsProxyService(name, svc, true)) continue;
    const named = [svc.image, ...buildTags(svc.build)].find(namesOpsProxyImage);
    if (named === undefined) continue;
    throw new ComposeValidationError(
      `Service \`${name}\`: image \`${showValue(named)}\` is reserved for the ops session's `
      + "`docker-socket-proxy` in the form the ops template defines. Use another image name.",
    );
  }
}

/** Every check on one service definition as written, for plugin fragments, which Compose does not resolve. */
export function validateServiceSecurity(
  name: string,
  svc: Record<string, unknown>,
  socket: DockerSocketAccess,
  containEgress: boolean,
  trustedOpsProxy: boolean,
  isolateNetwork = false,
): void {
  validateClassifiedFields(name, svc);
  validateContainedInterpolation(name, svc, containEgress);
  validateServiceSettings(name, svc, socket, containEgress, trustedOpsProxy, isolateNetwork);
  validateRawVolumeSources(name, svc.volumes);
}

function validateClassifiedFields(name: string, svc: Record<string, unknown>): void {
  for (const key of Object.keys(svc)) {
    if (CLASSIFIED_SERVICE_FIELDS.has(key) || key.startsWith("x-")) continue;
    throw new ComposeValidationError(
      `Service \`${name}\`: the Compose field \`${key}\` is not supported. `
      + "Remove it; ShipIt accepts only the service fields it has checked.",
    );
  }
}

function validateContainedInterpolation(name: string, svc: Record<string, unknown>, containEgress: boolean): void {
  if (!containEgress) return;
  const interpolationSensitive = [
    svc.privileged, svc.volumes, svc.devices, svc.network_mode, svc.user,
    svc.use_api_socket, svc.deploy, svc.labels, svc.cap_add, svc.post_start,
    svc.pre_stop, svc.extends,
    svc.volumes_from, svc.pid, svc.ipc, svc.uts, svc.cgroup, svc.userns_mode,
    svc.security_opt, svc.device_cgroup_rules, svc.logging,
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

function refuseReservedVolume(name: string, source: string): never {
  throw new ComposeValidationError(
    `Service \`${name}\`: volume \`${source}\` is reserved for ShipIt. `
    + "Mount the workspace with a relative path such as `.:/app` or `./packages/web:/app`.",
  );
}

/** The path-string checks on mount sources as written; `validateResolvedMounts` is the boundary. */
function validateRawVolumeSources(name: string, volumes: unknown): void {
  if (!Array.isArray(volumes)) return;
  for (const vol of volumes) {
    if (persistSubpathOf(name, vol) !== null) continue;
    const source = volumeSource(vol);
    if (!source) continue;
    // The shared workspace volume would mount every session's files.
    if (RESERVED_VOLUME_NAMES.includes(source)) refuseReservedVolume(name, source);
    if (vol && typeof vol === "object" && (vol as Record<string, unknown>).type === "volume") continue;
    if (source.startsWith("/") && source !== DOCKER_SOCKET_PATH) {
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
    // Compose expands `~` to its own $HOME, and the daemon mounts that path from the host.
    if (source.startsWith("~")) {
      throw new ComposeValidationError(
        `Service \`${name}\`: home-relative bind mount path \`${source}\` is not allowed. ` +
        `Use relative paths within the workspace.`,
      );
    }
  }
}

// Fields a resolved mount may carry; `bind` options go with the bind when the rewrite makes it a volume.
const RESOLVED_MOUNT_FIELDS: ReadonlySet<string> = new Set([
  "type", "source", "target", "read_only", "consistency", "bind", "volume", "tmpfs",
]);

/**
 * Mount sources as the daemon will read them: a bind must be inside this session's workspace (the
 * rewrite makes it a volume subpath) or be the exact socket path, which `validateServiceSettings`
 * decides; a named volume must be declared, apart from ShipIt's `persist`.
 */
function validateResolvedMounts(
  name: string,
  volumes: unknown,
  declaredVolumes: ReadonlySet<string>,
  workspaceDir: string,
): void {
  if (volumes === undefined || volumes === null) return;
  if (!Array.isArray(volumes)) {
    throw new ComposeValidationError(`Service \`${name}\`: \`volumes\` must be a list.`);
  }
  for (const vol of volumes) {
    if (!isMapping(vol)) {
      throw new ComposeValidationError(
        `Service \`${name}\`: Compose left the mount \`${showValue(vol)}\` unresolved.`,
      );
    }
    for (const key of Object.keys(vol)) {
      if (RESOLVED_MOUNT_FIELDS.has(key) || key.startsWith("x-")) continue;
      throw new ComposeValidationError(
        `Service \`${name}\`: the mount field \`${key}\` is not supported. Remove it.`,
      );
    }
    const { type, source } = vol;
    if (type === "tmpfs") continue;
    if (type === "volume") {
      if (source === undefined || source === null || source === "") continue;
      if (typeof source !== "string" || source.includes("$")) {
        throw new ComposeValidationError(
          `Service \`${name}\`: Compose left the volume source \`${showValue(source)}\` unresolved.`,
        );
      }
      if (RESERVED_VOLUME_NAMES.includes(source)) refuseReservedVolume(name, source);
      if (resolvedPersistSubpath(name, vol) !== null) continue;
      if (!declaredVolumes.has(source)) {
        throw new ComposeValidationError(
          `Service \`${name}\`: volume \`${source}\` is not declared in the top-level \`volumes:\`. `
          + "Declare it there, or mount a workspace path such as `./data:/data`.",
        );
      }
      continue;
    }
    if (type === "bind") {
      if (typeof source !== "string" || source.includes("$") || !path.posix.isAbsolute(source)) {
        throw new ComposeValidationError(
          `Service \`${name}\`: Compose left the bind mount source \`${showValue(source)}\` unresolved.`,
        );
      }
      if (source === DOCKER_SOCKET_PATH || isWithinDir(source, workspaceDir)) continue;
      throw new ComposeValidationError(
        `Service \`${name}\`: bind mount source \`${source}\` is outside this session's workspace. `
        + "Mount a path inside the workspace, such as `./data:/data`, or /persist with `persist:/data`.",
      );
    }
    throw new ComposeValidationError(
      `Service \`${name}\`: mount type \`${showValue(type)}\` is not supported. `
      + "Use a workspace path, a named volume, or `tmpfs`.",
    );
  }
}

// On ShipIt's pinned Compose version, `config` inlines `env_file` and drops the key. It inlines
// `label_file` too but keeps that key, which the rewrite removes (docs/318 deployment checks).
function validateResolvedServiceFiles(name: string, svc: Record<string, unknown>): void {
  const envFile = svc.env_file;
  if (envFile !== undefined && envFile !== null && !isEmptyList(envFile)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: Compose did not resolve \`env_file\`, so ShipIt cannot see the values it sets `
      + "and does not start the service without them. This Compose version differs from the one ShipIt "
      + "pins; ask the operator to install the pinned version.",
    );
  }
  if (svc.extends !== undefined) {
    throw new ComposeValidationError(`Service \`${name}\`: Compose left \`extends\` unresolved.`);
  }
}

/** Checks that do not depend on how a mount source is spelled; they run on the resolved model. */
function validateServiceSettings(
  name: string,
  svc: Record<string, unknown>,
  socket: DockerSocketAccess,
  containEgress: boolean,
  trustedOpsProxy: boolean,
  isolateNetwork: boolean,
): void {
  const isolate = containEgress || isolateNetwork;
  const trustedProxyShape = isTrustedOpsProxyService(name, svc, trustedOpsProxy);
  if (meansSet(svc.privileged)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`privileged: ${showValue(svc.privileged)}\` is not allowed. ` +
      `Remove the privileged flag.`,
    );
  }
  // Compose runs a provider's program itself, on the orchestrator too.
  if (svc.provider !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`provider\` is not allowed. Declare the service with \`image:\` or \`build:\`.`,
    );
  }

  validateNamespaces(name, svc);

  // Added capabilities could disable the namespace firewall.
  if (containEgress && Array.isArray(svc.cap_add) && svc.cap_add.length > 0) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`cap_add\` is not allowed for contained services. `
      + "Remove added Linux capabilities, or use an Open session.",
    );
  }
  validateCapAdd(name, svc.cap_add);
  const netAdmin: unknown = isolate && Array.isArray(svc.cap_add)
    ? svc.cap_add.find((entry) => capabilityName(entry) === "NET_ADMIN")
    : undefined;
  if (netAdmin !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`cap_add: ${showValue(netAdmin)}\` is not allowed. ShipIt keeps sessions away `
      + "from this machine and private networks, and a service that adds NET_ADMIN could remove that. Remove it.",
    );
  }
  validateSecurityOpt(name, svc.security_opt);
  if (svc.device_cgroup_rules !== undefined && !isEmptyList(svc.device_cgroup_rules)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`device_cgroup_rules: ${showValue(svc.device_cgroup_rules)}\` is not allowed. `
      + `A service may use \`${ALLOWED_DEVICE}\` through \`devices:\`, and an NVIDIA GPU through \`gpus:\` `
      + "or `deploy.resources.reservations.devices`.",
    );
  }
  validateLogging(name, svc.logging);

  if (meansSet(svc.use_api_socket)) {
    if (containEgress) {
      throw new ComposeValidationError(
        `Service \`${name}\`: \`use_api_socket: ${showValue(svc.use_api_socket)}\` is not allowed for `
        + "contained services. Remove it.",
      );
    }
    if (!socketGranted(socket)) refuseDockerSocket(name, "`use_api_socket`", socket, trustedOpsProxy);
  }
  if (containEgress && (svc.post_start !== undefined || svc.pre_stop !== undefined)) {
    throw new ComposeValidationError(
      `Service \`${name}\`: Compose lifecycle hooks are not allowed for contained services.`,
    );
  }
  validateHooks(name, svc);
  if (containEgress && svc.volumes_from !== undefined) {
    throw new ComposeValidationError(
      `Service \`${name}\`: \`volumes_from\` is not allowed for contained services.`,
    );
  }
  validateVolumesFrom(name, svc.volumes_from);
  validateBuildSecurity(name, svc.build);

  const labels = svc.labels;
  const labelKeys = Array.isArray(labels)
    ? labels.map((entry) => typeof entry === "string" ? entry.split("=", 1)[0] : "")
    : labels && typeof labels === "object" ? Object.keys(labels) : [];
  const reserved = isolate ? labelKeys.find((key) => key.startsWith("shipit-egress-")) : undefined;
  if (reserved) {
    throw new ComposeValidationError(
      `Service \`${name}\`: label \`${reserved}\` uses ShipIt's reserved egress namespace.`,
    );
  }
  const deploy = svc.deploy;
  if (deploy && typeof deploy === "object") {
    const restartPolicy = (deploy as Record<string, unknown>).restart_policy;
    if (isolate && restartPolicy !== undefined) {
      throw new ComposeValidationError(containEgress
        ? `Service \`${name}\`: \`deploy.restart_policy\` is not allowed for contained services.`
        : `Service \`${name}\`: \`deploy.restart_policy\` is not allowed. A restarted service runs without the `
          + "firewall that keeps sessions away from this machine and private networks. Remove it.");
    }
  }
  validateGpuRequests(name, svc);

  validateDevices(name, svc, isDevKvmAllowed());

  if (Array.isArray(svc.volumes) && !trustedProxyShape) {
    for (const vol of svc.volumes) {
      if (volumeSource(vol) !== DOCKER_SOCKET_PATH) continue;
      if (vol && typeof vol === "object" && (vol as Record<string, unknown>).type === "volume") continue;
      if (containEgress) {
        const instead = name === "docker-socket-proxy" && trustedOpsProxy
          ? OPS_PROXY_HINT
          : "Use ShipIt's trusted docker-socket-proxy service.";
        throw new ComposeValidationError(
          `Service \`${name}\`: direct Docker socket access is not allowed with contained egress. ${instead}`,
        );
      }
      if (!socketGranted(socket)) refuseDockerSocket(name, "a Docker socket mount", socket, trustedOpsProxy);
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
    const containedUser = declaredUser;
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

export interface WorkspaceVolumeMount {
  type: "volume";
  source: string;
  volume: { subpath: string };
}

/**
 * Docker follows a subpath's symlinks and checks only that the result stays inside the volume
 * root. The workspace directory itself cannot be replaced from a container, because its parent is
 * never mounted, so it stays a subpath of the shared volume. Anything below it can be a symlink,
 * so it is a subpath of the session's own volume instead.
 */
export function workspaceVolumeMount(
  relPath: string,
  workspaceSubpath: string | undefined,
): WorkspaceVolumeMount {
  if (relPath) {
    return { type: "volume", source: SESSION_WORKSPACE_VOLUME_ALIAS, volume: { subpath: relPath } };
  }
  if (!workspaceSubpath) {
    throw new Error("ShipIt could not locate this session inside the workspace volume.");
  }
  return { type: "volume", source: WORKSPACE_VOLUME_ALIAS, volume: { subpath: workspaceSubpath } };
}

// nocopy: an empty target would otherwise take the image directory's files, owner and mode.
function persistVolumeOptions(existing: unknown, subpath: string): Record<string, unknown> {
  const options = existing && typeof existing === "object"
    ? { ...(existing as Record<string, unknown>) }
    : {};
  delete options.subpath;
  return { ...options, nocopy: true, ...(subpath ? { subpath } : {}) };
}

/**
 * The /persist subdirectory a resolved mount names, or null. `config --no-consistency` keeps
 * ShipIt's `persist/<sub>:/t` short form as the undeclared volume source `persist/<sub>`.
 */
export function resolvedPersistSubpath(serviceName: string, vol: unknown): string | null {
  if (!isMapping(vol) || vol.type !== "volume" || typeof vol.source !== "string") return null;
  if (vol.source === PERSIST_VOLUME) return persistSubpathOf(serviceName, vol);
  if (!vol.source.startsWith(`${PERSIST_VOLUME}/`)) return null;
  if (isMapping(vol.volume) && vol.volume.subpath !== undefined) {
    throw new ComposeValidationError(
      `Service \`${serviceName}\`: \`${vol.source}\` names a /persist subdirectory and also sets \`volume.subpath\`. `
      + "Use one of them.",
    );
  }
  return normalizePersistSubpath(serviceName, vol.source.slice(PERSIST_VOLUME.length + 1));
}

/** Which /persist subdirectories the resolved model mounts; `used` also covers a declared `persist`. */
export function resolvedPersistUse(model: Record<string, unknown>): { used: boolean; subpaths: string[] } {
  const subpaths: string[] = [];
  let used = isMapping(model.volumes) && model.volumes[PERSIST_VOLUME] !== undefined;
  for (const [name, svc] of Object.entries(isMapping(model.services) ? model.services : {})) {
    if (!isMapping(svc) || !Array.isArray(svc.volumes)) continue;
    for (const vol of svc.volumes) {
      const subpath = resolvedPersistSubpath(name, vol);
      if (subpath === null) continue;
      used = true;
      subpaths.push(subpath);
    }
  }
  return { used, subpaths };
}

export interface SnapshotRewriteOptions {
  sessionId: string;
  workspaceDir: string;
  workspaceVolume?: string;
  workspaceSubpath?: string;
  /** Daemon-side path of this session's workspace; required once a mount names a subdirectory of it. */
  workspaceDevice?: string;
  /** Required when the model mounts or declares `persist`. */
  persist?: PersistVolume;
  stackName?: string;
  /** The session's agent container has the GPU; otherwise GPU requests are removed. */
  gpuGranted?: boolean;
}

export interface ProjectFileReference {
  kind: "secrets" | "configs";
  name: string;
  /** Absolute, inside the workspace (`validateResolvedModel`). */
  file: string;
}

export interface SnapshotRewrite {
  model: Record<string, unknown>;
  /** Per service, the workspace path of each bind the rewrite replaced. */
  workspaceMounts: Map<string, WorkspaceMountRecord[]>;
  /** The files the daemon would bind from the workspace; the caller replaces each with its own copy. */
  projectFiles: ProjectFileReference[];
  /** Services with a `build:`, which this start builds. */
  builtServices: string[];
  /** Services that asked for a GPU and start without one (docs/325-session-gpu-access). */
  gpuRemoved: string[];
}

/**
 * Step 4 of the before-`up` sequence (docs/318-compose-remaining-escapes): every in-workspace bind
 * becomes a volume subpath, `persist` becomes ShipIt's bind-backed volume, and the file that holds a
 * mount of a ShipIt volume declares it. Runs on a model `validateResolvedModel` accepted.
 */
export function rewriteResolvedModel(
  model: Record<string, unknown>,
  opts: SnapshotRewriteOptions,
): SnapshotRewrite {
  const out = structuredClone(model);
  const services = isMapping(out.services) ? out.services : {};
  const workspaceMounts = new Map<string, WorkspaceMountRecord[]>();
  const builtServices: string[] = [];
  const gpuRemoved: string[] = [];
  const mounted = new Set<string>();
  for (const [name, svc] of Object.entries(services)) {
    if (!isMapping(svc)) continue;
    // Empty after validation; ShipIt publishes no host ports.
    delete svc.env_file;
    delete svc.label_file;
    delete svc.ports;
    if (svc.build !== undefined) builtServices.push(name);
    if (!opts.gpuGranted && requestsGpu(svc)) {
      removeGpuRequests(svc);
      gpuRemoved.push(name);
    }
    if (!Array.isArray(svc.volumes)) continue;
    const records: WorkspaceMountRecord[] = [];
    const rewritten = svc.volumes.map((vol) => rewriteResolvedMount(name, vol, opts, records));
    svc.volumes = rewritten;
    for (const vol of rewritten) {
      if (isMapping(vol) && vol.type === "volume" && typeof vol.source === "string") mounted.add(vol.source);
    }
    if (records.length > 0) workspaceMounts.set(name, records);
  }
  dropImplicitDefaultNetwork(out);

  const labels = shipitVolumeLabels(opts.sessionId, opts.stackName);
  const volumes: Record<string, unknown> = {};
  for (const [key, decl] of Object.entries(isMapping(out.volumes) ? out.volumes : {})) {
    if (key === PERSIST_VOLUME) continue;
    const existing = isMapping(decl) && isMapping(decl.labels) ? decl.labels : {};
    volumes[key] = { ...(isMapping(decl) ? decl : {}), labels: { ...existing, ...labels } };
  }
  if (mounted.has(PERSIST_VOLUME) || (isMapping(out.volumes) && out.volumes[PERSIST_VOLUME] !== undefined)) {
    volumes[PERSIST_VOLUME] = persistVolumeDeclaration(opts.sessionId, opts.persist, labels);
  }
  if (mounted.has(WORKSPACE_VOLUME_ALIAS)) {
    volumes[WORKSPACE_VOLUME_ALIAS] = { name: opts.workspaceVolume, external: true };
  }
  if (mounted.has(SESSION_WORKSPACE_VOLUME_ALIAS)) {
    volumes[SESSION_WORKSPACE_VOLUME_ALIAS] = sessionWorkspaceDeclaration(opts.workspaceDevice, labels);
  }
  if (Object.keys(volumes).length > 0) out.volumes = volumes;
  else delete out.volumes;

  const projectFiles: ProjectFileReference[] = [];
  for (const kind of ["secrets", "configs"] as const) {
    const block = out[kind];
    if (!isMapping(block)) continue;
    for (const [name, entry] of Object.entries(block)) {
      if (isMapping(entry) && typeof entry.file === "string") projectFiles.push({ kind, name, file: entry.file });
    }
  }
  return { model: out, workspaceMounts, projectFiles, builtServices, gpuRemoved };
}

/**
 * `config` writes `networks: {default: null}` for a service that names no network. The override
 * adds `shipit-session`, and the merge would keep both, so the service would join a second network
 * it never joined before; a service that names its networks keeps them.
 */
function dropImplicitDefaultNetwork(model: Record<string, unknown>): void {
  const services = isMapping(model.services) ? Object.values(model.services).filter(isMapping) : [];
  for (const svc of services) {
    const nets = svc.networks;
    if (isMapping(nets) && Object.keys(nets).length === 1 && "default" in nets && nets.default === null) {
      delete svc.networks;
    }
  }
  const stillUsed = services.some((svc) =>
    Array.isArray(svc.networks) ? svc.networks.includes("default") : isMapping(svc.networks) && "default" in svc.networks);
  if (!stillUsed && isMapping(model.networks)) {
    delete model.networks.default;
    if (Object.keys(model.networks).length === 0) delete model.networks;
  }
}

function rewriteResolvedMount(
  serviceName: string,
  vol: unknown,
  opts: SnapshotRewriteOptions,
  records: WorkspaceMountRecord[],
): unknown {
  if (!isMapping(vol)) return vol;
  const persistSubpath = resolvedPersistSubpath(serviceName, vol);
  if (persistSubpath !== null) {
    return { ...vol, type: "volume", source: PERSIST_VOLUME, volume: persistVolumeOptions(vol.volume, persistSubpath) };
  }
  if (vol.type !== "bind" || typeof vol.source !== "string" || vol.source === DOCKER_SOCKET_PATH) return vol;
  const relPath = path.posix.relative(opts.workspaceDir, vol.source);
  if (typeof vol.target === "string") records.push({ relPath, target: vol.target });
  // ShipIt does not start session containers without a workspace volume (docs/318 req 9).
  if (!opts.workspaceVolume) return vol;
  const { bind: _bindOptions, ...mount } = vol;
  return { ...mount, ...workspaceVolumeMount(relPath, opts.workspaceSubpath) };
}

function shipitVolumeLabels(sessionId: string, stackName: string | undefined): Record<string, string> {
  return { "shipit-managed": "true", "shipit-session": sessionId, ...stackLabel(stackName) };
}

// A bind-backed volume makes Docker confine every subpath to /persist; a subpath of the shared
// workspace volume is confined only to that volume, which holds every session.
function persistVolumeDeclaration(
  sessionId: string,
  persist: PersistVolume | undefined,
  labels: Record<string, string>,
): Record<string, unknown> {
  if (!persist) {
    throw new Error("The `persist` volume is declared, but this session's /persist could not be located.");
  }
  return {
    // Distinct from `<project>_persist`, a plain volume an earlier file may already have created.
    name: `${composeProjectName(sessionId)}_shipit-persist`,
    driver: "local",
    driver_opts: { type: "none", o: "bind", device: persist.device },
    labels,
  };
}

function sessionWorkspaceDeclaration(
  workspaceDevice: string | undefined,
  labels: Record<string, string>,
): Record<string, unknown> {
  if (!workspaceDevice) {
    throw new Error(
      "ShipIt could not locate this session's workspace on the Docker host, so it cannot mount "
      + "a subdirectory of it. Mounting the whole workspace (`.:/app`) still works.",
    );
  }
  return { driver: "local", driver_opts: { type: "none", o: "bind", device: workspaceDevice }, labels };
}

/**
 * `config` prints every `$` as `$$`, so its output is a model Compose reads back unchanged. ShipIt
 * checks and rewrites the values themselves, so it removes that escaping once when it reads the
 * output, and `serializeComposeModel` adds it back once.
 */
export function unescapeComposeDollars(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\$\$/g, "$");
  if (Array.isArray(value)) return value.map(unescapeComposeDollars);
  if (isMapping(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, unescapeComposeDollars(nested)]));
  }
  return value;
}

/** Compose reads `$$` as a literal `$`, so the model it loads holds exactly the validated values. */
export function serializeComposeModel(model: Record<string, unknown>): string {
  return stringifyYaml(escapeValueDollars(model), { lineWidth: 0 });
}

function escapeValueDollars(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\$/g, "$$$$");
  if (Array.isArray(value)) return value.map(escapeValueDollars);
  if (isMapping(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, escapeValueDollars(nested)]));
  }
  return value;
}

const PLUGIN_STUB_IMAGE = "shipit-plugin-stub";

/**
 * Name and image of each admitted plugin service, so a project service's `depends_on` on one
 * resolves in `config` and `build`; nothing a plugin service mounts or receives.
 */
export function pluginStubModel(
  plugins: readonly { name: string; definition: Record<string, unknown> }[],
): Record<string, unknown> {
  return {
    services: Object.fromEntries(plugins.map((svc) => [
      svc.name,
      { image: typeof svc.definition.image === "string" ? svc.definition.image : PLUGIN_STUB_IMAGE },
    ])),
  };
}

/**
 * The model `build` reads on stdin: the snapshot, the plugin stubs, and each project secret or
 * config at its workspace path, which the build's own container can read.
 */
export function composeBuildModel(
  snapshot: Record<string, unknown>,
  projectFiles: readonly ProjectFileReference[],
  stubs: Record<string, unknown>,
): Record<string, unknown> {
  const out = structuredClone(snapshot);
  for (const { kind, name, file } of projectFiles) {
    const block = out[kind];
    const entry = isMapping(block) ? block[name] : undefined;
    if (isMapping(entry)) entry.file = file;
  }
  const services = isMapping(out.services) ? out.services : {};
  const stubServices = isMapping(stubs.services) ? stubs.services : {};
  out.services = { ...stubServices, ...services };
  return out;
}

export interface ProjectFileCopy {
  kind: "secrets" | "configs";
  name: string;
  /** ShipIt's copy, relative to the workspace volume's root. */
  subpath: string;
}

const PROJECT_FILE_TARGET_ROOT = { secrets: "/run/secrets", configs: "/" } as const;

/**
 * Compose hands a `file:` secret or config to the daemon as a bind source, and a path inside the
 * workspace volume is not a host path on every daemon (docs/318-compose-remaining-escapes,
 * Mechanism 1). So each service's grant of a copied file becomes a read-only mount of that one
 * file from the volume, at the target Compose would have used.
 */
export function mountProjectFileCopies(
  model: Record<string, unknown>,
  copies: readonly ProjectFileCopy[],
  workspaceVolume: string,
): void {
  if (!isMapping(model.services)) return;
  let mounted = false;
  for (const svc of Object.values(model.services)) {
    if (!isMapping(svc)) continue;
    for (const kind of ["secrets", "configs"] as const) {
      const grants = svc[kind];
      if (!Array.isArray(grants)) continue;
      const kept: unknown[] = [];
      const mounts: Record<string, unknown>[] = [];
      for (const grant of grants as unknown[]) {
        const source = isMapping(grant) ? grant.source : grant;
        const copy = copies.find((c) => c.kind === kind && c.name === source);
        if (!copy) {
          kept.push(grant);
          continue;
        }
        const named = isMapping(grant) && typeof grant.target === "string" && grant.target !== ""
          ? grant.target
          : copy.name;
        mounts.push({
          type: "volume",
          source: WORKSPACE_VOLUME_ALIAS,
          target: path.posix.isAbsolute(named) ? named : path.posix.join(PROJECT_FILE_TARGET_ROOT[kind], named),
          read_only: true,
          volume: { subpath: copy.subpath },
        });
      }
      if (mounts.length === 0) continue;
      mounted = true;
      svc[kind] = kept;
      svc.volumes = [...(Array.isArray(svc.volumes) ? svc.volumes as unknown[] : []), ...mounts];
    }
  }
  if (!mounted) return;
  model.volumes = {
    ...(isMapping(model.volumes) ? model.volumes : {}),
    [WORKSPACE_VOLUME_ALIAS]: { name: workspaceVolume, external: true },
  };
}

function mountsSessionWorkspace(volumes: unknown): boolean {
  return Array.isArray(volumes) && volumes.some((vol) =>
    Boolean(vol && typeof vol === "object"
      && (vol as Record<string, unknown>).source === SESSION_WORKSPACE_VOLUME_ALIAS));
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
  workspaceMounts: readonly WorkspaceMountRecord[],
  overlayDepDirs: OverlayDepDirVolume[],
  referenced: Set<string>,
): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const seenTargets = new Set<string>();
  for (const { relPath: mountSubdir, target } of workspaceMounts) {
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

/**
 * Self only: a tracked plugin's service starts without waiting for agent.install (docs/137), so
 * it must not read the project's dep dirs. A one-shot command run has no such ordering and does
 * mount them — see `plugin-cli-run.ts`.
 */
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
    if (typeof obj.target !== "string") continue;
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
  if (entry.source === SESSION_WORKSPACE_VOLUME_ALIAS) return subpath;
  if (entry.source === WORKSPACE_VOLUME_ALIAS && subpath === workspaceSubpath) return "";
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

  const isolate = Boolean(opts.containEgress || opts.isolateNetwork);
  for (const svc of services) {
    const applyServiceContainment = Boolean(opts.containEgress && !svc.trustedOpsProxy);
    // A restart runs the service in a new namespace, without its firewall.
    const noRestart = isolate && !svc.trustedOpsProxy;
    const mode = resolvePreviewMode(svc);
    const labels: Record<string, string> = {
      "shipit-parent-session": opts.sessionId,
      "shipit-service-name": svc.name,
      "shipit-preview-mode": mode,
      // Always write false too, or a repository-supplied true can survive merging.
      "shipit-trusted-ops-proxy": svc.trustedOpsProxy ? "true" : "false",
    };
    Object.assign(labels, stackLabel(opts.stackName));
    if (svc.settingsFingerprint) {
      labels["shipit-plugin-settings"] = svc.settingsFingerprint;
    }
    const entry: Record<string, unknown> = {
      // ShipIt-owned fields must override the plugin definition.
      ...(svc.pluginDefinition ?? {}),
      ...(svc.trustedOpsProxy ? { image: TRUSTED_OPS_PROXY_IMAGE } : {}),
      labels,
      // A service container is a sibling on the host, not inside the worker's cgroup, so without
      // this it keeps the default weight and outranks the session it belongs to (docs/229).
      cpu_shares: SESSION_CPU_SHARES,
      // A second bridge would permit egress before containment is installed.
      networks: isolate ? "__RESET_NETWORKS__" : ["shipit-session"],
      cap_drop: applyServiceContainment ? ["NET_RAW", "SETUID", "SETGID"] : ["NET_RAW"],
      // Internal networks still forward DNS; block it until the controlled resolver is ready.
      ...(opts.containDns ? { dns: "__RESET_DNS__" } : {}),
      ...(noRestart ? { restart: "no" } : {}),
      ...(applyServiceContainment ? { security_opt: ["no-new-privileges"] } : {}),
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
      // Override values replace the project's, so a declared HOME must stop this.
      if (isSessionUid(workerUid) && !svc.declaresHome && !declaresHome(entry.environment)
        && !svc.secrets?.includes("HOME")) {
        entry.environment = { ...(isMapping(entry.environment) ? entry.environment : {}), HOME: SERVICE_HOME };
      }
    } else if (workerGid !== null && svc.user !== undefined && !preservesImageStartupUser) {
      // Grant workspace writes; mounting shared caches would also expose them through this gid.
      entry.group_add = [String(workerGid)];
    }

    // !reset removes host bindings; a plain [] would retain inherited ports.
    if (svc.ports && svc.ports.length > 0) {
      entry.ports = "__RESET_PORTS__";
    }

    // `up --no-build` follows this start's `build`; a pull would replace the image it built.
    if (opts.builtServices?.includes(svc.name)) entry.pull_policy = "never";

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
        : overlayMountsForService(svc.workspaceMounts ?? [], depDirs, referencedOverlayVolumes);
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
        ...(isolate ? { internal: true, enable_ipv6: false, driver_opts: { ...NO_HOST_ADDRESS_OPTION } } : {}),
        // The boot sweeps select by the stack label (planning#584); Compose adds none of its own.
        ...(opts.stackName ? { labels: stackLabel(opts.stackName) } : {}),
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
    volumeOverlay[WORKSPACE_VOLUME_ALIAS] = {
      name: opts.workspaceVolume,
      external: true,
    };
  }
  if (Object.values(overrideServices).some((entry) => mountsSessionWorkspace(entry.volumes))) {
    volumeOverlay[SESSION_WORKSPACE_VOLUME_ALIAS] = sessionWorkspaceDeclaration(
      opts.workspaceDevice,
      shipitVolumeLabels(opts.sessionId, opts.stackName),
    );
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

/** The file must be in the private session state directory; an override holds credentials. */
export function writeRootOnlyFile(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: "utf-8", mode: 0o600 });
  // chmod also restricts a file that existed before.
  fs.chmodSync(file, 0o600);
  return file;
}
