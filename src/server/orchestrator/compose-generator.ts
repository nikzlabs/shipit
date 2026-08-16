/**
 * Compose override file generator.
 *
 * Reads a user's docker-compose.yml and generates a `compose.override.yml`
 * that layers on ShipIt's labels, network, volume rewrites, and security policies.
 * The user's file is never modified, and the override is written to the session's
 * state dir rather than the clone (docs/246 — see {@link writeComposeOverride}).
 *
 * The override is used with:
 *   docker compose -f <user-file> -f <state-dir>/compose.override.yml up -d
 */

import fs from "node:fs";
import path from "node:path";
import { isScalar, parse as parseYaml, parseDocument, stringify as stringifyYaml, visit } from "yaml";
import type { ComposeConfig } from "../shared/shipit-config.js";
import type { SecretRequirement } from "../shared/types/domain-types.js";
import { sessionWorkerUid } from "./session-worker-uid.js";
import { COMPOSE_OVERRIDE_FILE } from "./session-state-dir.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { EGRESS_PROXY_UID } from "./egress-proxy-install.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "../shared/plugin-contract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * docs/262 req 3 — which repository a surfaced service came from. Plugin
 * services are first-class in every list, control and log path, so the only
 * thing that distinguishes them is this label.
 */
export interface ComposeServiceOrigin {
  kind: "plugin";
  /** The declared plugin repository's own spelling — the Plugins card's unit. */
  repo: string;
  /** The import's local name (`use.alias`). */
  alias: string;
  /** The exported plugin's name in that repository's manifest. */
  plugin: string;
  /** The service's name inside the plugin's own fragment, before any `as:`. */
  sourceName: string;
  /**
   * docs/262 req 27 — `repo: self`: the plugin's tree is this session's own
   * working tree, so its dependency directories are the project's. It is the one
   * fact the override needs about a plugin's origin beyond identity; see
   * {@link overlayMountsForPluginService}.
   */
  self: boolean;
}

export interface ComposeService {
  name: string;
  /** True only for the server-authorized, validated ops Docker proxy shape. */
  trustedOpsProxy?: boolean;
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
  /**
   * docs/262 — where this service came from. Absent means the project's own
   * compose file; a plugin service carries its import's identity so the services
   * list can say so (req 3) and so the override knows to emit its definition
   * rather than only an overlay on the user's.
   */
  origin?: ComposeServiceOrigin;
  /**
   * docs/262 — the complete definition to emit for a PLUGIN service. The
   * project's own services are described by the user's compose file and only
   * overlaid here; a plugin's fragment is never handed to `docker compose -f`
   * (see `plugin-compose.ts`), so ShipIt writes every line of it, mounts and
   * environment included.
   */
  pluginDefinition?: Record<string, unknown>;
  /**
   * docs/262 — volumes this service references that the daemon-overlay
   * subsystem owns (the plugin generation's volume, and the workspace volume
   * when the project's own services do not already pull it in). Declared
   * `external: true` in the volumes block, exactly like the dep-dir overlays.
   */
  externalVolumes?: string[];
  /**
   * docs/262 req 26 — digest of this service's validated settings file. Emitted
   * as a label so that a settings change, which alters nothing else Compose can
   * see, still counts as a changed service definition and recreates the
   * container. See `PluginComposeService.settingsFingerprint`.
   */
  settingsFingerprint?: string;
  /**
   * Explicit `user:` declared by the service in the user's compose file, if any.
   * When set, ShipIt honors it and does NOT inject the session-worker UID
   * (see {@link generateComposeOverride}). Captured as a string so both the
   * `1000` and `1000:1000` / named forms round-trip.
   */
  user?: string;
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
   * Make the session network internal while Compose services are being
   * contained. A separate private egress bridge is attached only after the
   * service namespace has received its firewall/resolver/proxy stack.
   */
  containEgress?: boolean;
  /** Point Docker DNS at the Tier B loopback resolver during containment setup. */
  containDns?: boolean;
  /** Tier C is active, so redirected HTTPS needs route_localnet. */
  containProxy?: boolean;
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
     * planning#287 — absolute, DAEMON-SIDE path of the staged entrypoint wrapper
     * (`stageSecretsEntrypoint()`), e.g.
     * `/var/lib/shipit/secrets/_entrypoint/secrets-entrypoint.sh`. The override
     * bind-mounts it into each secret-consuming service container at
     * `/shipit/secrets-entrypoint.sh` and sets it as the entrypoint.
     *
     * It used to be a workspace-RELATIVE path mounted through the workspace
     * volume, which required the wrapper to live inside the user's git clone.
     * The daemon resolves this path the same way it resolves the `file:`
     * references in the top-level `secrets:` block, so both come from the same
     * `hostDir` mapping and are correct together or wrong together.
     *
     * Absent when staging failed — the service then gets its `secrets:`
     * references without the wrapper rather than a mount of a path that
     * doesn't exist.
     */
    entrypointHostPath?: string;
  };
  /**
   * docs/183 — service-name → absolute env-file path for services that declare
   * `x-shipit-secrets`. The service's `env_file:` entry uses this path, which
   * always resolves outside the session's git clone.
   *
   * A service missing from the map gets **no** `env_file:` entry rather than a
   * fallback path (planning#292 — there is no longer an in-clone file to fall back
   * to). `ServiceSecretsResolver.sync()` populates one entry per
   * secret-declaring service and always runs before the override is generated,
   * so a gap here means secrets haven't been resolved at all.
   *
   * Ignored when `dockerSecrets` is active (that mode uses `secrets:`, not
   * `env_file:`).
   */
  serviceEnvFiles?: Record<string, string>;
  /**
   * docs/262 req 23 — plugin-service name → the credential values that
   * service's plugin DECLARED and this project has a value for
   * (`ServiceSecretsResolver.getPluginServiceEnv()`).
   *
   * Merged into the emitted service's `environment`, never `env_file`. That is
   * the deliberate difference from the map above, and it is what makes the
   * value ShipIt resolved the value the container gets: Compose gives a
   * service's own `environment` precedence over any `env_file`, so a plugin
   * fragment declaring the same name would otherwise shadow its own declared
   * credential — the card would say satisfied and the container would run on
   * the fragment's literal. Compose's env-file parser also applies quote,
   * comment and `${VAR}` handling to the values it reads, so a stored value is
   * not necessarily delivered byte-for-byte, and `${…}` could resolve from the
   * environment of the process that runs Compose — the ORCHESTRATOR's. Emitting
   * here instead puts every value through {@link escapePluginDollars}, the same
   * escaping the rest of a plugin definition already gets.
   *
   * The cost, stated rather than hidden: the generated override is the one
   * ShipIt-written file that now carries secret values. It lives in the session
   * STATE dir — never the git clone, and outside the `plugins/` subtree that is
   * the agent container's only mount of it — and is written 0600.
   *
   * Only consulted for a service carrying a plugin `origin`, so nothing here
   * can inject an environment into one of the project's own services.
   */
  pluginServiceEnv?: Record<string, Record<string, string>>;
  /**
   * docs/183 Phase 5 — per-session overlay dep-dir volumes. For an
   * overlay-eligible session, each declared dep dir (e.g. `node_modules`) is a
   * separate per-session `type=overlay` Docker volume that the agent container
   * mounts nested at `/workspace/<dep-dir>`. A compose service that bind-mounts
   * the workspace (or a subdir of it) must share those SAME deps — so for every
   * such service we KEEP its normal `shipit-workspace` mount (source + `.git`)
   * and **additionally append** one `type: volume` mount per dep dir reachable
   * through that mount, targeted at the matching nested subpath
   * (`<service-target>/<dep-dir-relative-to-the-mounted-source>`). This is the
   * shared-overlay-volume-across-containers refcount pattern (proven by
   * `shared-volume-spike.sh`), NOT the rejected "root the whole service at an
   * overlay" approach. Each referenced volume is declared `external: true` (the
   * daemon-overlay subsystem owns its lifecycle). Empty/absent → no overlay
   * mounts (non-overlay sessions are byte-for-byte unchanged).
   */
  overlayDepDirs?: OverlayDepDirVolume[];
}

/** One per-session overlay dep-dir volume: the dep dir it backs + its Docker volume name. */
export interface OverlayDepDirVolume {
  /** Declared dep dir, relative to the workspace root (e.g. `node_modules`). */
  depDir: string;
  /** Per-session `type=overlay` Docker volume name (`shipit-<id>_overlay-<hash>`). */
  volumeName: string;
}

/**
 * The placeholders {@link generateComposeOverride} substitutes for Compose's
 * `!reset` / `!override` tags AFTER serialization, because the YAML writer
 * cannot emit them.
 *
 * Exported because that post-serialization `replace` is a text pass over the
 * whole document, so any value that reaches the override carrying one of these
 * literals would be rewritten mid-string. For the project's own compose file
 * that is self-inflicted and harmless; for a plugin fragment it is a
 * third-party string landing in a file ShipIt authors, so `plugin-compose.ts`
 * refuses them (docs/262).
 */
export const OVERRIDE_SENTINELS: readonly string[] = [
  "__RESET_PORTS__",
  "__RESET_NETWORKS__",
  "__RESET_DNS__",
];

/**
 * Compose's name for the workspace volume inside every file ShipIt writes. It
 * is an ALIAS — the `volumes:` block below declares it `external: true` with
 * `name:` set to the real volume — so only this module knows what it resolves
 * to. `plugin-compose.ts` emits its mounts against the same alias.
 */
const WORKSPACE_VOLUME_ALIAS = "shipit-workspace";

/**
 * The two ways a compose file can be unusable, which are not one outcome
 * (planning#377).
 *
 * - `malformed` — ShipIt could not UNDERSTAND the file: unreadable on disk,
 *   invalid YAML, or not a compose document at all. Nothing about it is known,
 *   and there is nothing to say beyond where the parse gave up.
 * - `refused` — ShipIt understood the file perfectly and DECLINED it. The
 *   message names the rule and the fix, so a caller that can only report one
 *   sentence should report this one.
 *
 * `refused` is the default because every rule below is one: a check added later
 * without a thought for this field is still a refusal, and reporting it as one
 * is right. Only the four "could not parse it at all" sites opt out.
 */
export type ComposeValidationKind = "malformed" | "refused";

export class ComposeValidationError extends Error {
  readonly kind: ComposeValidationKind;

  constructor(message: string, kind: ComposeValidationKind = "refused") {
    super(message);
    this.name = "ComposeValidationError";
    this.kind = kind;
  }
}

/**
 * Why a compose file could not be turned into a list of services — the ONE
 * classified shape every surface that reports that failure carries
 * (planning#377, planning#382).
 *
 * One shape and one classifier, because the failure now reaches several
 * surfaces that must not disagree about it: the plugin card
 * (`readProjectServices`), the session's service list (`ServiceManager`), and
 * everything the list feeds — `GET /api/sessions/:id/services`, the agent
 * bridge's `list`, `shipit service list`.
 */
export interface ComposeFailure {
  kind: ComposeValidationKind;
  /** The parser's own message — it names the service, the rule and the fix. */
  message: string;
}

/**
 * Classify a parse throw into a {@link ComposeFailure}.
 *
 * A non-`ComposeValidationError` is by definition something ShipIt did not
 * anticipate, so it reads as `malformed`: only a deliberate refusal can claim
 * to name a fix.
 */
export function classifyComposeFailure(err: unknown): ComposeFailure {
  return {
    kind: err instanceof ComposeValidationError ? err.kind : "malformed",
    message: err instanceof Error ? err.message : String(err),
  };
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
 * **Names only, and that is not a check.** This function reads no `driver`,
 * `driver_opts`, `external` or `name` — it exists to label volumes for the disk
 * janitor's prune, not to admit them. The security rule over this same block is
 * {@link validateTopLevelVolumes}, which runs inside {@link parseComposeFile}
 * before every `up`; planning#386 is what happens when the only reader of the
 * block is this one. An `external: true` entry no longer reaches here at all
 * (that call refuses the file), so the old note about externals silently
 * missing the `shipit-managed` label describes a case that can no longer occur.
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
 * The container (target) port a compose `ports:` entry names — the port the
 * service actually listens on inside the container. ShipIt strips host
 * bindings from every service it runs and reaches containers by IP on the
 * session network, so this is the only number in a mapping that means anything
 * to the preview proxy.
 *
 * Supports the common Compose forms:
 * - "5173" → 5173
 * - "5173:5173" → 5173
 * - "8080:80" → 80
 * - "5173:5173/tcp" → 5173
 * - "127.0.0.1:8080:80" → 80
 */
export function extractContainerPort(portMapping: string): number | undefined {
  if (!portMapping) return undefined;

  // Strip optional protocol suffix ("/tcp", "/udp")
  const withoutProtocol = portMapping.split("/")[0].trim();
  if (!withoutProtocol) return undefined;

  const parts = withoutProtocol.split(":");
  // Container port is always the last segment
  const portStr = parts[parts.length - 1];

  const port = parseInt(portStr, 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

/**
 * Every container port a parsed compose stack claims — one derivation, shared
 * by the two surfaces that must agree about it (#2325).
 *
 * A plugin service's published port is allocated around the ports the PROJECT
 * already claims, and the routing key it becomes must be unique across the
 * whole session. Two independent readings of "which numbers are taken" is how
 * that uniqueness was lost: the plugin resolver counted a service's ports one
 * way and the ServiceManager another, and a plugin then published a number the
 * project's own service was already reachable on. Both now count them here.
 *
 * Every entry of every service, not just the first: a service listening on two
 * ports occupies both, even though only the first is the one ShipIt previews.
 */
export function declaredContainerPorts(
  services: readonly Pick<ComposeService, "ports">[],
): Set<number> {
  const ports = new Set<number>();
  for (const svc of services) {
    for (const mapping of svc.ports ?? []) {
      const port = extractContainerPort(mapping);
      if (port !== undefined) ports.add(port);
    }
  }
  return ports;
}

/**
 * Parse a docker-compose.yml file and extract service definitions.
 * Validates security constraints and returns parsed service info.
 */
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
    // Compose resolves YAML merge keys. Resolve them here as well so security
    // validation sees the same effective fields in Open mode.
    doc = parseYaml(content, { merge: true }) as Record<string, unknown> | null;
  } catch (err) {
    // The two containment rules above throw from INSIDE this block, and they
    // are refusals of a document that parsed perfectly well. Re-thrown as they
    // are: wrapping them turned "custom YAML tags are not supported" into
    // "Compose file is not valid YAML: custom YAML tags are not supported",
    // which is both untrue and — once callers began telling the two apart
    // (planning#377) — filed under the wrong kind (review finding).
    if (err instanceof ComposeValidationError) throw err;
    // Surface YAML parse errors as ComposeValidationError so callers (which
    // catch them defensively, e.g. mid-edit / mid-merge reconciles) can log
    // a clean one-liner instead of a full stack trace. Common trigger: the
    // user's compose file is briefly invalid while they're typing or while
    // a merge has left conflict markers in the file.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ComposeValidationError(`Compose file is not valid YAML: ${msg}`, "malformed");
  }
  if (!doc || typeof doc !== "object") {
    throw new ComposeValidationError("Compose file must be a YAML mapping", "malformed");
  }
  // planning#386 — unconditional, where this was `containEgress`-only. `include:`
  // does not add a feature to the model, it REPLACES the model this function
  // reads: the effective document is the root file plus every included one, and
  // only the root file is here. That voids the per-service rules below in an
  // Open session, and it voids {@link validateTopLevelVolumes} outright — the
  // root file declares a service mounting `escape:/host` (an ordinary named
  // volume, admitted), an included file declares `escape:` with a bind
  // `driver_opts`, and Compose resolves both. A rule that a second file can
  // delete is not a rule.
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

    // Security validation
    //
    // `extends:` is the sibling of the `include:` rule above and is deliberately
    // NOT unconditional (planning#386, review lead). It is the same shape of
    // problem — the effective service is the local mapping merged with one from
    // another file, and only the local mapping is validated here, so in an OPEN
    // session a `privileged: true` or an absolute bind can arrive from the
    // extended file untouched. Two things make it a separate decision rather
    // than a line to change here: it cannot reach the top-level `volumes:` block
    // (Compose requires a named volume an extended service mounts to be declared
    // in the file doing the extending, which IS this one), so it does not defeat
    // `validateTopLevelVolumes`; and unlike `include:` it is a widely used
    // Compose feature, so refusing it in Open sessions is a product call. Stated
    // rather than left for the next reader to rediscover.
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

    // Preserve an explicit `user:` so the override doesn't clobber it. Compose
    // accepts string (`node`, `1000:1000`) and bare-number forms.
    const user =
      typeof svc.user === "string" || typeof svc.user === "number" ? String(svc.user) : undefined;

    result.push({
      name,
      trustedOpsProxy: isTrustedOpsProxyService(name, svc, opts.trustedOpsProxy ?? false),
      ports,
      shipitPreview,
      dependsOnInstall,
      profiles,
      volumes,
      secrets,
      secretRequirements: requirements,
      user,
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
 * The one device mapping ShipIt permits through to a Compose service:
 * `/dev/kvm` → `/dev/kvm`, for Android-emulator hardware acceleration (docs/213).
 * This is NOT a general devices passthrough — every other device is rejected.
 */
export const ALLOWED_DEVICE = "/dev/kvm";

/**
 * Operator kill-switch for the `/dev/kvm` passthrough. Default ON — the emulator
 * tier needs it and the user opts in *per-service* by declaring the device, so
 * the floor is "allowed". An operator sets `SESSION_ALLOW_DEV_KVM=0` (also
 * `false`/`no`/`off`) to disable it deployment-wide — e.g. on a shared or
 * multi-tenant host that shouldn't expose KVM. This is the deployment-level
 * gate the design called for, NOT a per-repo `shipit.yaml` field.
 */
export function isDevKvmAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SESSION_ALLOW_DEV_KVM?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * Parse one compose `devices` entry into its host/container device paths.
 * Supports the short string form `HOST[:CONTAINER[:PERMS]]` and the long object
 * form `{ source, target, permissions }`. Returns null for unparseable entries.
 * Cgroup permissions are ignored — they scope r/w/m on the device, not which
 * device, so they can't widen past the path check below.
 */
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

/**
 * Validate a service's `devices:`. ShipIt allows exactly ONE mapping —
 * `/dev/kvm:/dev/kvm` (Android-emulator hardware acceleration, docs/213) — and
 * rejects everything else; it is not a general device passthrough. The single
 * allowed device is itself gated by the operator kill-switch ({@link isDevKvmAllowed}).
 */
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
    // parsed === null (unparseable) → `undefined !== ALLOWED_DEVICE` is true → rejected.
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

/**
 * Every file a repository's compose model asks ShipIt to READ must be inside
 * that repository's workspace (planning#371, review finding).
 *
 * The `volumes:` rule below already rejects an absolute bind source, because a
 * host path is an escape from the workspace. Three other fields are the same
 * primitive by another name and were unchecked — with a sharper edge the
 * volumes rule does not have, because two of them are read by the **CLI**, in
 * the orchestrator's own filesystem, rather than bound by the daemon:
 *
 *  - `secrets:` / `configs:` (top level) — a service reference bind-mounts the
 *    file at `/run/secrets/<name>` or `/<name>`, resolved by the DAEMON, so an
 *    absolute path is an arbitrary HOST-file read into a contained container.
 *  - `build.secrets` references that same `secrets:` block, and a BUILD secret
 *    is read CLIENT-side and streamed to the builder.
 *  - `env_file:` is read CLIENT-side too — Compose must read it to render the
 *    model — and its contents become the service's environment.
 *
 * The client-side pair is what makes them a way around {@link composeSpawnEnv}:
 * scrubbing the child's environment does not remove `/proc/1/environ`, which a
 * same-uid child can read (mode 0400, owned by the orchestrator process). So
 * `env_file: /proc/1/environ` would hand a container the very environment the
 * spawn no longer passes.
 *
 * A source must therefore be a plain workspace-relative path: no leading `/`,
 * no `..`, and no `${…}` — an interpolated path would be validated as the
 * literal here and resolved to something else by Compose
 * (`${HOME}/.docker/config.json` is the whole attack in one line).
 *
 * **What this does NOT close, so the next reader need not re-derive it.** These
 * are string rules over a declared path, exactly like the `volumes:` rule they
 * mirror, and a **symlink inside the workspace defeats them** — the workspace
 * is writable by the agent and by any plugin service holding `/project`. Making
 * them airtight means resolving each path and proving containment, which is a
 * TOCTOU race against a writer who can swap the link afterwards; the durable
 * fix is not a longer deny-list but running the CLI without access to anything
 * worth reading. That is its own change, tracked as planning#373. This closes the
 * direct references; it does not make the compose file safe.
 *
 * ShipIt's OWN generated override writes absolute `file:` and `env_file:`
 * paths, and is unaffected: those go into the override, which is never parsed
 * here. A plugin fragment can declare none of these keys
 * (`plugin-compose.ts`'s `ALLOWED_SERVICE_KEYS` / `ALLOWED_TOP_LEVEL_KEYS`);
 * this covers the project file, which is the surface a plugin with `/project`
 * write access — or the project itself — can author.
 */
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

/** A rejected value, rendered for the error message without trusting its shape. */
function showValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/**
 * Does an options map (`driver_opts:`, `ipam:`) actually carry an option?
 *
 * `driver_opts: {}` and `ipam: {}` are accepted by Compose and reach nothing —
 * a templating layer emits them for a case that produced no options (review
 * finding). Refusing them is a false refusal with no safety to show for it. An
 * absent key and an empty map are the same statement; anything else is not.
 */
function hasOptions(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  // A scalar or a list where Compose expects a mapping: not empty, not
  // understood, and not something to wave through.
  return true;
}

/**
 * Is `value` a compose `external:` that means "not external"?
 *
 * Only the FALSE spellings are enumerated, and only the ones verified to be
 * read that way, because the two directions are not symmetric: admitting one
 * Compose reads as TRUE attaches a foreign volume, while refusing one it reads
 * as false costs a user a clear error on a spelling nobody uses on purpose. So
 * `false` and any casing of `"false"` (Compose coerces quoted booleans
 * case-insensitively — review finding, compose-go `loader/interpolate.go`) are
 * admitted, and `no` / `off` / `0` are left to be refused rather than added on
 * the strength of a guess about a second coercion path.
 */
function meansNotExternal(value: unknown): boolean {
  if (value === undefined || value === false) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "false";
}

/**
 * The top-level `volumes:` block (planning#386).
 *
 * The `volumes:` rule inside {@link validateServiceSecurity} refuses a host path
 * a SERVICE declares. It is the whole check, and it is per-service — so the
 * top-level block, which is not a service, reached the daemon with nothing read
 * from it but its keys ({@link parseUserNamedVolumes} returns names only). The
 * local driver's `driver_opts` is a host bind written in another syntax:
 *
 *     volumes:
 *       escape:
 *         driver_opts: { type: none, device: /, o: bind }
 *
 * The service that mounts it writes `- escape:/host`, which every check above
 * classifies as an ordinary named volume, because that is exactly what it looks
 * like. No forbidden absolute path appears anywhere in the file.
 *
 * **Why this is not "a project may bind its own host".** The project's compose
 * file is the project's own code and the user is entitled to trust it; the
 * question is who else can write it. A PLUGIN can — `/project` is read-write in
 * its containers by design (docs/262 req 29) — and so can an npm `postinstall`
 * running in the session worker. The watcher then reconciles the rewritten file
 * and {@link parseComposeFile} re-runs before every `up`
 * (`ServiceManager.parseProjectCompose`), so the escape needs no user action
 * beyond the one they already took.
 *
 * So a top-level volume must be a plain, Compose-managed, local volume. Four
 * refusals, deny-the-primitive rather than a safe subset of `driver_opts` (the
 * `cap_add` rule's reasoning, and `o:` is an opaque pass-through to `mount(8)`):
 *
 *  - **`driver_opts`** — the bind above, and `type: nfs`/`cifs` besides, which
 *    the KERNEL mounts from the host's network namespace and containment
 *    therefore does not see at all. A service that wants a scratch filesystem
 *    has `tmpfs:` for it.
 *  - **a non-`local` `driver`** — a host-installed volume plugin, whose
 *    semantics ShipIt cannot know and did not choose.
 *  - **`external: true`** — attaches a volume this session did not create. On a
 *    shared daemon that includes ShipIt's own, whose names are not secrets
 *    (`shipit-<stack>_workspace` holds every session's clone AND state dir).
 *  - **`name:`** — the same reach without the `external` keyword. Compose's own
 *    project-label check refuses to adopt a foreign volume today, but that is
 *    an inherited guarantee in someone else's code; there is no use for a
 *    stable cross-project volume name inside an ephemeral session anyway.
 *
 * Unconditional, exactly like the service-level bind rule it mirrors: the two
 * are one primitive in two syntaxes, and a rule that fires only when contained
 * would make the Open-session compose file a different language.
 *
 * Not closed here, and not close-able by a string rule: `driver_opts` is only
 * the reach ShipIt can SEE. See `validateTopLevelFileRefs` on the symlink
 * limit, which applies to this block's neighbours for the same reason.
 */
function validateTopLevelVolumes(block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    // `pgdata:` with no body is the ordinary declaration — nothing to check.
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
    // Only a value that does NOT mean false attaches pre-existing storage. The
    // legacy `external: { name: … }` object form is one such, and is caught by
    // the same test.
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

/**
 * The top-level `networks:` block — the same structural gap as
 * {@link validateTopLevelVolumes}, one block over (planning#386).
 *
 * A CONTAINED service never joins one of these: the override replaces its
 * `networks:` with `!override [shipit-session]`, which is why the reserved-name
 * rule in {@link parseComposeFile} was written for contained sessions only. An
 * OPEN session's override does not — it appends `shipit-session` and Compose
 * merges the two lists — so there the project's own networks are joined as
 * declared, and nothing had ever read this block.
 *
 * "Open means unrestricted egress" does not cover what that reaches. Egress is
 * about routed internet access; these are different primitives:
 *
 *  - `driver: macvlan` / `ipvlan` with `driver_opts: {parent: <host nic>}` puts
 *    the container on the HOST's layer-2 segment with its own MAC — not an
 *    internet route but a peer on the host's LAN.
 *  - `external: true` (and its `name:`-only twin) joins a network that already
 *    exists on the daemon. Session isolation is a claim ShipIt makes in Open
 *    sessions too, and `shipit-session-<id>` / the orchestrator's own compose
 *    network are named by a scheme, not by a secret.
 *
 * So the same shape as the volumes rule: `bridge` (or unstated) driver only, no
 * `driver_opts`, no `ipam`, no `external`, no `name:`. And the reserved-name
 * refusal applies to every session rather than contained ones — Compose merges
 * maps key-by-key, so a key the override does not set survives from the
 * project's file, and `driver:` under a project-declared `shipit-session:` is
 * exactly such a key.
 *
 * `driver_opts` and `ipam` were the two this nearly kept, on the grounds that
 * MTU is a real deployment need and that a chosen subnet only collides with
 * itself. Both are refused instead, because neither reason survived being
 * written down as a claim: `com.docker.network.bridge.name` names a host
 * interface, `ipam` picks the address a container presents to everything that
 * identifies containers by source IP (docs/172), and "assessed and probably
 * harmless" is the shape of the residue this very block already shipped once. A
 * refusal is loud and says what to remove; the alternative was a safe-subset
 * allowlist over an option namespace Docker extends without asking us.
 */
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
    // The driver first: `macvlan` needs a `driver_opts.parent`, and naming the
    // driver is the more useful half of that pair to report.
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

/**
 * The top-level `secrets:` / `configs:` blocks — see {@link validateReadablePath}.
 *
 * `file:` is the only key checked, and the other three were looked at while
 * closing the sibling blocks (planning#386) rather than left unexamined:
 *
 *  - `content:` (configs) is an inline literal — it reaches nothing.
 *  - `external: true` / `name:` never become a host-file read. A referenced
 *    external secret or config is refused by Compose itself as UNSUPPORTED —
 *    not looked up and not found missing (`docker/compose` `pkg/compose/create.go`,
 *    review finding; an earlier draft of this comment said it resolved against
 *    swarm objects a non-swarm daemon lacks, which reached the same verdict by
 *    a mechanism that does not exist). A bare `name:` fails source validation
 *    instead. Either way there is no path from these two keys to a file. This
 *    is the difference from the volumes and networks blocks, where the same
 *    keys name ordinary daemon objects that DO exist and belong to other
 *    sessions — which is why they are refused there and left here.
 *  - `environment: VAR` materializes a value from the environment Compose is
 *    interpolating with, which is `composeSpawnEnv()`'s allowlist plus the
 *    project's own `.env`. It is deliberately NOT refused: the allowlist
 *    carries no credential (that is its whole purpose), a `.env` in the
 *    workspace is the project's own file, and a project reading its own
 *    variable into a config is a legitimate pattern. What it does mean is that
 *    the allowlist is load-bearing HERE too, not only at the spawn — widening
 *    `COMPOSE_ENV_PASSTHROUGH` with anything sensitive would open this without
 *    touching this file.
 */
function validateTopLevelFileRefs(kind: string, block: unknown): void {
  if (!block || typeof block !== "object" || Array.isArray(block)) return;
  for (const [name, entry] of Object.entries(block as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    validateReadablePath(kind, name, (entry as Record<string, unknown>).file);
  }
}

/**
 * A service's `env_file:`, in each of the three shapes Compose accepts: a bare
 * string, a list of strings, and a list of `{ path, required }` objects.
 */
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

/**
 * Validate security constraints for a compose service definition.
 */
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
  // The server-authored template uses map form. List entries without `=` are
  // resolved from the project environment by Compose, so their effective
  // values cannot be validated here and must not receive proxy trust.
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

/**
 * Exported for docs/262: a plugin's compose fragment is held to exactly the
 * rules the consuming session applies to the project's own services, so
 * `plugin-compose.ts` runs THIS function rather than a second copy that could
 * drift from it.
 */
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


  // NET_ADMIN would let repository code flush its namespace firewall. Reject
  // every capability addition rather than maintain a fragile safe subset.
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

  // Reject device passthrough except the exact /dev/kvm mapping (docs/213).
  validateDevices(name, svc, isDevKvmAllowed());

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
  if (containEgress && !trustedProxyShape) {
    const containedUser = typeof svc.user === "string" || typeof svc.user === "number"
      ? String(svc.user).trim()
      : "";
    const containedUid = /^\d+(?::\d+)?$/.test(containedUser)
      ? Number(containedUser.split(":", 1)[0])
      : NaN;
    if (!Number.isInteger(containedUid) || containedUid <= 0
      || containedUid === EGRESS_RESOLVER_UID || containedUid === EGRESS_PROXY_UID) {
      throw new ComposeValidationError(
        `Service \`${name}\`: contained services must declare a numeric, non-root \`user:\` `
        + `that is not reserved UID ${EGRESS_RESOLVER_UID} or ${EGRESS_PROXY_UID}. `
        + "Use an image that runs directly as this user, or use an Open session for root-init images.",
      );
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
 * Extract the (source, target) of a volume entry in either short (`"src:tgt[:mode]"`)
 * or long (`{ source, target }`) form. Returns nulls for shapes we don't recognize
 * (anonymous volumes, named-volume-only entries) so callers can skip them.
 */
function volumeSourceTarget(vol: unknown): { source: string | null; target: string | null } {
  if (typeof vol === "string") {
    const parts = vol.split(":");
    // "src:tgt[:mode]" — a bare "/app/node_modules" anonymous volume has no ":".
    return parts.length >= 2 ? { source: parts[0], target: parts[1] } : { source: null, target: null };
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

/**
 * A dep dir `depDir` (workspace-relative) is reachable through a service mount of
 * workspace subdir `mountSubdir` ("" = the workspace root) iff it equals or lives
 * under that subdir. Returns the dep dir's path RELATIVE to the mount ("" when the
 * mount IS the dep dir), or null when the dep dir isn't under the mount.
 */
function depDirWithinMount(mountSubdir: string, depDir: string): string | null {
  if (mountSubdir === "") return depDir;
  if (depDir === mountSubdir) return "";
  if (depDir.startsWith(`${mountSubdir}/`)) return depDir.slice(mountSubdir.length + 1);
  return null;
}

/**
 * Compute the nested overlay mounts to append to a service: for each of the
 * service's workspace mounts (relative-path source) and each dep dir reachable
 * through it, one `type: volume` mount of that dep dir's overlay volume targeted
 * at `<mount-target>/<dep-dir-relative-to-the-mount>`. De-duplicated by target so
 * two overlapping mounts (or a dep dir that equals a mounted subdir) never emit a
 * duplicate-target the daemon would reject. Mutates `referenced` with the volume
 * names actually used (so only used volumes get an `external:` declaration).
 */
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
    if (mountSubdir === null) continue; // not a workspace mount — nothing to nest under
    for (const { depDir, volumeName } of overlayDepDirs) {
      const rel = depDirWithinMount(mountSubdir, depDir);
      if (rel === null) continue;
      const mountTarget = rel ? path.posix.join(target, rel) : target;
      if (seenTargets.has(mountTarget)) continue;
      seenTargets.add(mountTarget);
      referenced.add(volumeName);
      // No `volume.subpath`: the overlay volume's root IS the merged dep dir, so
      // the mount points at the volume root. This also keeps the read-only-lower
      // guardrail trivially true — a service mount can never reach an
      // `overlay-base/` lowerdir subpath.
      mounts.push({ type: "volume", source: volumeName, target: mountTarget });
    }
  }
  return mounts;
}

/**
 * docs/262 req 27 — the same nesting for a **`repo: self`** plugin service.
 *
 * A plugin service never reaches {@link overlayMountsForService}: its volumes
 * are not the user's compose entries but ShipIt's own re-emitted ones
 * (`plugin-compose.ts`), so a workspace mount is already the workspace VOLUME
 * with a subpath rather than a `./…` source, and `svc.volumes` — the raw
 * user-compose list that block reads — is empty for it. So a dep dir was, from a
 * plugin's side, the empty directory the overlay mounts over everywhere else.
 * Under `repo: self` that is fatal (nikzlabs/shipit#2298): the plugin's tree IS
 * the project's tree, there is no generation and no `install` of its own, and
 * the dependencies its entry points load are exactly the ones `agent.install`
 * prepared — all of them missing.
 *
 * **A tracked generation is deliberately left alone, and the reason is the
 * install gate.** Its own tree rides its generation volume and already carries
 * what its own `install` produced, so it needs nothing here; giving it the
 * project's dep dirs at `/project` as well would look tidier and would create a
 * race the tracked case has no answer for — it starts with
 * `dependsOnInstall: false` (rightly: its dependencies are its own), so it would
 * be reading `node_modules` while `agent.install` writes them, which is the
 * failure docs/137's gate exists to prevent. Exposing the project's
 * dependencies to a CONSUMING plugin is a separate decision that has to settle
 * that gate first; it is not part of fixing self-use.
 *
 * So one rule, and the gate follows it exactly: **a plugin sees the project's
 * dependency directories precisely when the project's tree is its own tree, and
 * then it waits for the project's install** ({@link toComposeService}).
 *
 * `/plugin-state` and `/plugin-settings.json` ride the same volume, under
 * `sessions/<id>/plugin-data/…`. They are excluded by the very test that
 * includes `/project`: the subpath must be at or under `workspaceSubpath`, and
 * `plugin-data/` is a sibling of `workspace/`, not a child.
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

/**
 * Where a workspace-volume mount sits INSIDE the session's clone, or null when
 * it is not inside it at all. "" means the mount is the clone root.
 */
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

/**
 * Compose's own escape: `$$` renders as a literal `$` and interpolates nothing.
 *
 * Compose interpolates `${VAR}` and `$VAR` in the files it reads from the
 * environment of the process that runs it — the ORCHESTRATOR's. Everything
 * ShipIt writes into a plugin service's definition therefore goes through this:
 * the fragment's own lines (`plugin-compose.ts`) and the credential values
 * delivered beside them (req 23). Ordinary shell usage (`sh -c 'echo $HOME'`)
 * survives untouched, which rejecting `$` would not allow.
 */
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

/**
 * docs/262 req 23 — merge a plugin's delivered credential values into the
 * `environment` map ShipIt already emitted for that service.
 *
 * Two rules, in this order:
 *
 *  - **The delivery wins over the fragment.** A plugin may declare `FAL_KEY` in
 *    its manifest AND set `FAL_KEY` in its own fragment; Compose would let the
 *    fragment's literal stand, so the card would report the project's stored
 *    value satisfied while the container ran on something else.
 *  - **ShipIt's contract never loses.** A credential named after one of the
 *    contract variables (`SHIPIT_PROJECT_DIR` and friends) is dropped rather
 *    than delivered: those name the mounts ShipIt made, and a stored secret is
 *    not allowed to move a plugin's idea of where the project is. Nothing is
 *    lost that could have worked — the fragment's own `environment` could never
 *    override them either, for the same reason.
 *
 * Values are escaped exactly as the rest of the definition already was, so
 * Compose interpolates nothing out of the orchestrator's environment.
 */
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
  // docs/183 Phase 5 — overlay volume names actually referenced by some service,
  // so only used volumes get an `external:` declaration in the volumes block.
  const referencedOverlayVolumes = new Set<string>();

  for (const svc of services) {
    const applyServiceContainment = Boolean(opts.containEgress && !svc.trustedOpsProxy);
    const mode = resolvePreviewMode(svc);
    const labels: Record<string, string> = {
      "shipit-parent-session": opts.sessionId,
      "shipit-service-name": svc.name,
      "shipit-preview-mode": mode,
      // Always write the label so a repository-supplied `true` cannot survive
      // Compose map merging for an ordinary service.
      "shipit-trusted-ops-proxy": svc.trustedOpsProxy ? "true" : "false",
    };
    if (opts.stackName) {
      labels["shipit-stack"] = opts.stackName;
    }
    if (svc.settingsFingerprint) {
      labels["shipit-plugin-settings"] = svc.settingsFingerprint;
    }
    const entry: Record<string, unknown> = {
      // docs/262 — a plugin service has no definition in the user's compose
      // file, so its own (already validated and path-rewritten) definition is
      // the base everything below overlays. Spread FIRST: every ShipIt-owned
      // key that follows must win over anything the fragment declared.
      ...(svc.pluginDefinition ?? {}),
      labels,
      // Replace, do not merge, user-declared networks. A second ordinary
      // bridge would give repository code a NAT route before containment.
      networks: opts.containEgress ? "__RESET_NETWORKS__" : ["shipit-session"],
      cap_drop: applyServiceContainment ? ["NET_RAW", "SETUID", "SETGID"] : ["NET_RAW"],
      // On an internal Docker network, ordinary routed traffic is blocked but
      // Docker's embedded DNS can still forward queries through the daemon.
      // Point its upstream at loopback until the controlled resolver is in the
      // namespace, closing the pre-pause DNS-tunnelling window.
      ...(opts.containDns ? { dns: "__RESET_DNS__" } : {}),
      ...(applyServiceContainment ? {
        restart: "no",
        security_opt: ["no-new-privileges"],
      } : {}),
      ...(opts.containProxy && !svc.trustedOpsProxy
        ? { sysctls: { "net.ipv4.conf.all.route_localnet": "1" } }
        : {}),
    };

    // docs/150 §7 / #1646 — run compose services as the same UID the session
    // worker drops to, so files a dev server writes into the SHARED workspace
    // (e.g. `node_modules/.vite`, framework build caches) are owned by the agent
    // user. Otherwise a root-owned cache from the running dev server makes a
    // one-off `npm run build` in the terminal (run as `shipit`) fail with EACCES
    // when the tool tries to rmdir/overwrite it — and `sudo` isn't available.
    // Symmetric with the worker entrypoint's `gosu ${UID}:${UID}` and the
    // orchestrator's §7 chowns, all gated on the same env var:
    //   - unset (legacy default) → no-op; worker AND services are both root, so
    //     there's no ownership mismatch to begin with.
    //   - set (e.g. 1000) → both sides share the UID; one deploy flips both.
    // An explicit `user:` in the user's compose file is honored — we never
    // override a deliberate choice.
    const workerUid = sessionWorkerUid();
    // docs/128 — the ops docker-socket-proxy image must start as its image
    // default user so its entrypoint can generate
    // /usr/local/etc/haproxy/haproxy.cfg before haproxy drops privileges. The
    // read-only Docker security boundary is enforced by the proxy's env
    // allowlist and the read-only socket mount, not by forcing this service to
    // the session worker UID.
    const preservesImageStartupUser = svc.trustedOpsProxy === true
      || (!opts.containEgress && svc.name === "docker-socket-proxy");
    if (workerUid !== null && svc.user === undefined && !preservesImageStartupUser) {
      entry.user = `${workerUid}:${workerUid}`;
    }

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
    if (svc.origin?.kind === "plugin") {
      // docs/262 req 23 — a plugin's declared credentials, resolved from the
      // consuming project's own store by `ServiceSecretsResolver`. Checked
      // FIRST and exclusively: a plugin fragment may not declare
      // `x-shipit-secrets` (the allowlist refuses it), and the Docker-secrets
      // branch below hijacks `entrypoint`, which for a plugin service is a line
      // ShipIt re-emitted from the plugin's own fragment.
      const delivered = opts.pluginServiceEnv?.[svc.name];
      if (delivered && Object.keys(delivered).length > 0) {
        entry.environment = mergePluginCredentialEnv(entry.environment, delivered);
      }
    } else if (ds && svc.secrets && svc.secrets.length > 0) {
      const consumed = (ds.perService[svc.name] ?? []).filter((n) => ds.secretNames.includes(n));
      if (consumed.length > 0) {
        entry.secrets = consumed.map((n) => `shipit-${n}`);
        // planning#287 — bind-mount the wrapper read-only from its staged absolute
        // path. One mount shape for every setup: the wrapper no longer rides
        // the workspace volume (which is what forced it to live inside the
        // user's git clone), and the daemon resolves this source exactly as it
        // resolves the `secrets: file:` paths above it.
        if (ds.entrypointHostPath) {
          const existingVolumes = (entry.volumes as unknown[] | undefined) ?? [];
          entry.volumes = [...existingVolumes, {
            type: "bind",
            source: ds.entrypointHostPath,
            target: "/shipit/secrets-entrypoint.sh",
            read_only: true,
          }];
          // Override the entrypoint to the wrapper. The wrapper exec's
          // "$@" so the user's command runs unchanged. We don't touch
          // `command:` here — leaving it unset means compose merges the
          // user's compose-file value, which is what we want.
          entry.entrypoint = ["/shipit/secrets-entrypoint.sh"];
        }
      }
    } else if (svc.secrets && svc.secrets.length > 0) {
      // Inject the per-service secrets env file if the service declared any
      // secrets via `x-shipit-secrets`. The orchestrator writes the file before
      // running `docker compose up` (see secret-resolver.ts), at an absolute
      // path outside the workspace (docs/183).
      //
      // No entry → no `env_file:`. There used to be a
      // `?? \`.shipit/.env.${svc.name}\`` fallback for the in-workspace write
      // path; that writer is gone (planning#292), so the fallback would now name a
      // file nothing creates and fail the whole stack at `up` time. Absence
      // means `sync()` hasn't run, which is also when there is no file to point
      // at.
      const envFilePath = opts.serviceEnvFiles?.[svc.name];
      if (envFilePath) {
        entry.env_file = [envFilePath];
      } else {
        // …and SAY SO. `sync()` writes one entry per secret-declaring service
        // (even when every value is unset — the file is then empty), and it
        // always runs before this, so a gap here means the caller generated the
        // override from resolver state it never read. That is exactly how the
        // dogfood `dev` service silently lost every secret for a whole session:
        // `refreshSecrets()` regenerated the override without `serviceEnvFiles`
        // and nothing anywhere reported an absent env var. The delivery is
        // still omitted rather than guessed — there is no in-clone path to fall
        // back to (planning#292) — but it is no longer invisible.
        console.warn(
          `[compose:${opts.sessionId}] service "${svc.name}" declares ` +
            `${svc.secrets.length} x-shipit-secrets entr${svc.secrets.length === 1 ? "y" : "ies"} ` +
            `but no env file was resolved for it — ShipIt will NOT inject those variables`,
        );
      }
    }

    // docs/183 Phase 5 — append nested overlay dep-dir mounts for services that
    // share the workspace, so a dev server reading `node_modules` sees the same
    // per-session overlay deps as the agent container. KEEP the normal workspace
    // mount(s) above and add one volume mount per reachable dep dir. An overlay
    // mount whose target collides with an existing mount (a service mounting a
    // dep dir directly) replaces it so the daemon never sees a duplicate target.
    const depDirs = opts.overlayDepDirs ?? [];
    if (depDirs.length > 0 && opts.workspaceVolume) {
      // docs/262 — a `repo: self` plugin service's mounts are ShipIt's own,
      // already rewritten onto the workspace volume, so they take the
      // subpath-shaped matcher; the project's own service still declares `./…`
      // and takes the other. A TRACKED plugin gets neither — see
      // `overlayMountsForPluginService` for why that is the gate's doing.
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
  // docs/183 Phase 5 — declare each referenced overlay dep-dir volume `external:
  // true`. The daemon-overlay subsystem `docker volume create`s it (with the
  // overlay options) before the agent container starts; compose only references
  // it, never creates or owns it.
  for (const name of referencedOverlayVolumes) {
    volumeOverlay[name] = { name, external: true };
  }
  // docs/262 — the same treatment for a plugin generation's overlay volume: the
  // orchestrator creates it (`plugin-overlay.ts`) and compose only references
  // it. `shipit-workspace` can appear here too when a plugin mounts the project;
  // it is already declared above whenever it is reachable, and never overwritten
  // with its alias, which is not the real volume's name.
  for (const svc of services) {
    for (const name of svc.externalVolumes ?? []) {
      if (!volumeOverlay[name]) volumeOverlay[name] = { name, external: true };
    }
  }
  if (Object.keys(volumeOverlay).length > 0) {
    override.volumes = volumeOverlay;
  }

  let yaml = stringifyYaml(override, { lineWidth: 120 });
  // Replace sentinel with !reset tag — Docker Compose's extension to clear
  // inherited array values instead of appending to them.
  yaml = yaml.replace(/ports: __RESET_PORTS__/g, "ports: !reset []");
  yaml = yaml.replace(/networks: __RESET_NETWORKS__/g, "networks: !override\n      - shipit-session");
  yaml = yaml.replace(/dns: __RESET_DNS__/g, "dns: !override\n      - 192.0.2.1");
  return `# Generated by ShipIt — do not edit manually.\n# This file is merged with your docker-compose.yml at runtime.\n${yaml}`;
}

/**
 * Write the compose override into `targetDir`, creating it if needed, and
 * return the absolute path written.
 *
 * docs/246 — `targetDir` is the session's **state dir**
 * (`<sessionDir>/state/`), NOT the clone. The override is a ShipIt-generated
 * artifact: the root orchestrator writes it and the orchestrator's own `docker
 * compose` reads it via an absolute `-f`. Nothing inside the session container
 * touches it, which is why the docs/150 §7 chown handoff this function used to
 * do is gone — the state dir is not mounted into the container, so there is no
 * worker uid to hand it to.
 *
 * Callers that still pass a clone path (legacy tests) get the old placement;
 * see `ComposeCli`'s `overrideFile` for the matching read side.
 */
export function writeComposeOverride(
  targetDir: string,
  content: string,
): string {
  fs.mkdirSync(targetDir, { recursive: true });
  const overridePath = path.join(targetDir, COMPOSE_OVERRIDE_FILE);
  // docs/262 req 23 — 0600, because this file now carries secret VALUES: a
  // plugin service's declared credentials are emitted as its `environment`
  // (see `pluginServiceEnv`), which is the only delivery Compose cannot let the
  // fragment shadow or reinterpret. The mode is set explicitly on every write,
  // not just at creation, so a file that predates this cannot stay readable.
  fs.writeFileSync(overridePath, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(overridePath, 0o600);
  return overridePath;
}
