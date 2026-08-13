/**
 * docs/262 reqs 3, 5, 16, 20 — turning a plugin's **compose fragment** into real
 * services in the consuming session.
 *
 * A plugin repository owns its service definitions (req 5); a consuming project
 * declares the plugin and, at most, overrides startup and a colliding name
 * (reqs 16, 20). This module is the edge between those two: it locates each
 * imported plugin's fragment in whatever is live for it, validates it, renames
 * what the consumer renamed, and hands back service definitions the compose
 * override generator can emit beside the project's own.
 *
 * ## Why the fragment is re-emitted rather than passed to `docker compose -f`
 *
 * Compose's own multi-file merge resolves every relative path against the
 * **base** file's project directory — so a plugin's `- .:/app` would mount the
 * consuming *project*, not the plugin. Plan §1b calls that out and requires
 * per-fragment resolution to be preserved deliberately. Rewriting each relative
 * source into an explicit mount of the plugin's own tree is how: the fragment
 * keeps behaving the way it does standalone (`docker compose up` in its own
 * directory), and nothing about the consuming project can change what `.` means.
 *
 * It also means ShipIt authors every line the daemon sees for a plugin service,
 * which is what makes the validation below a boundary rather than a lint.
 *
 * ## What a plugin fragment may contain — an allowlist, not a denylist
 *
 * A project's own compose file is the user's; a plugin's is a third party's, and
 * arrives without review on every tracked-branch commit (req 19's standing
 * grant). So the service keys ShipIt understands are enumerated
 * ({@link ALLOWED_SERVICE_KEYS}) and everything else is refused by name. A
 * denylist would silently pass the next key Compose adds; this way a plugin that
 * needs something new gets a clear error and ShipIt gets to decide.
 *
 * On top of the allowlist, a fragment gets **the same validation the consuming
 * session applies to the project's own services** (`parseComposeFile`'s
 * `validateServiceSecurity`, including the contained-egress rules a contained
 * session enforces on everything — docs/263), with three plugin-edge additions:
 *
 *  - **Never the Docker socket**, whatever the project's `compose.docker-socket`
 *    says. That flag is the project granting itself the daemon; it is not the
 *    project granting a third-party repository the daemon.
 *  - **Every `$` is escaped on the way out.** Compose interpolates `${VAR}` and
 *    `$VAR` from the environment of the `docker compose` process — which is the
 *    ORCHESTRATOR's environment. A fragment could otherwise read ShipIt's own
 *    variables into a plugin container by naming them. Escaping preserves
 *    ordinary shell usage (`sh -c 'echo $HOME'`) exactly, which rejecting `$`
 *    would not.
 *  - **No `build:`** (v1). A plugin service's own files reach it through the
 *    generation's overlay volume — checkout plus install output — and a build
 *    context cannot be a volume. Pointing it at the pristine checkout instead
 *    would give one service two different views of the same plugin, so the
 *    fragment is asked for an `image:` and told why.
 */

import fs from "node:fs";
import path from "node:path";
import { isScalar, parse as parseYaml, parseDocument, visit } from "yaml";
import type { PluginExport, PluginReposConfig, PluginUse } from "../shared/plugin-repos.js";
import {
  CONTAINER_PLUGIN_SETTINGS_FILE,
  CONTAINER_PLUGIN_STATE_DIR,
  CONTAINER_PROJECT_DIR,
  PLUGIN_COMMIT_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_STATE_ENV,
  PLUGIN_PROJECT_ENV,
} from "../shared/plugin-contract.js";
import { createPluginImportResolver, pluginSettingsPath, pluginStateDir } from "./plugin-state.js";
import { activeLinkPath } from "./plugin-generations.js";
import { validateServiceSecurity, type ComposeService } from "./compose-generator.js";
import { chownToSessionWorker } from "./session-worker-uid.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One surfaced plugin service, before ShipIt's mounts and env are attached. */
export interface PluginFragmentService {
  /** The name the session addresses it by — `as:` when the consumer set one. */
  name: string;
  /** Its name inside the plugin's own fragment. */
  sourceName: string;
  /** The import this came from (`use.alias`) — keys its state dir and settings. */
  alias: string;
  /** The declared repository's own spelling — the unit the Plugins card groups by. */
  repo: string;
  /** The exported plugin's name in the repository's manifest. */
  plugin: string;
  /** Effective startup: the fragment's `x-shipit-preview`, then the consumer's override (req 16). */
  preview: "auto" | "manual";
  /** The port the service serves on, from the fragment's first `ports` entry. */
  port?: number;
  /**
   * The fragment's own definition, allowlisted and with ShipIt-owned keys
   * removed. Relative volume sources are still the fragment's — they are
   * rewritten against the plugin's tree in {@link buildPluginComposeServices},
   * which is the half that needs to know where that tree is mounted.
   */
  definition: Record<string, unknown>;
  /** Directory of the fragment inside the repository ("" = the repo root). */
  fragmentDir: string;
  /** `repo: self` — the live working tree, with no generation (req 27). */
  self: boolean;
  /** The live generation's commit, for a tracked repository (req 15). */
  commit?: string;
}

export interface PluginFragmentResolution {
  services: PluginFragmentService[];
  /**
   * Problems, grouped by the declared repository — the unit the Plugins tab
   * draws a card for. Recomputable from the declaration and what is live on
   * disk, so the snapshot GET derives them itself rather than remembering them
   * from a round that may never have run (the `plugin-state.ts` precedent).
   */
  issuesByRepo: Map<string, string[]>;
}

export interface CollectPluginFragmentsOptions {
  workspaceDir: string;
  /** The session STATE dir — where tracked repositories' generations live. */
  stateDir: string;
  plugins: PluginReposConfig;
  /** The consuming project's own `exports.plugins`, for `repo: self` imports. */
  selfExports: readonly PluginExport[];
  /** The project's own compose service names — the other half of req 20's domain. */
  projectServiceNames: readonly string[];
  /** Whether this session contains Compose-service egress (docs/263). */
  containEgress: boolean;
}

class PluginFragmentError extends Error {}

/**
 * Compose service names, and therefore what `as:` may rename one to. Compose's
 * own rule (`[a-zA-Z0-9._-]+`); it also becomes a container-name component and a
 * log-channel address, so nothing looser can be allowed through.
 */
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Service keys a plugin fragment may declare. Everything a service needs to
 * describe ITSELF; nothing that describes its relationship to the host, which is
 * ShipIt's to decide (`labels`, `networks`, `restart`, `privileged`, `cap_add`,
 * `devices`, `network_mode`, `extends`, `volumes_from`, `env_file`, lifecycle
 * hooks, `deploy`, `secrets`, `configs`, `profiles`, `x-shipit-secrets`).
 *
 * `x-shipit-secrets` is refused rather than ignored: a plugin's credentials are
 * declared in its manifest by NAME (req 23) and resolved from the consuming
 * project's store, so a fragment reaching for the project's compose secrets is
 * asking for the wrong thing and should hear about it.
 */
export const ALLOWED_SERVICE_KEYS: ReadonlySet<string> = new Set([
  "image", "command", "entrypoint", "working_dir", "environment", "volumes",
  "ports", "expose", "depends_on", "healthcheck", "init", "read_only", "tmpfs",
  "user", "stop_grace_period", "stop_signal", "shm_size", "mem_limit",
  "mem_reservation", "cpus", "pids_limit", "ulimits", "sysctls",
  "x-shipit-preview",
]);

/** Top-level keys a fragment may declare. `services` is the only one with meaning. */
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["services", "name", "version"]);

/** ShipIt extension keys read here and never re-emitted into the override. */
const SHIPIT_EXTENSION_KEYS: ReadonlySet<string> = new Set(["x-shipit-preview"]);

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Resolve every imported plugin's compose fragment into surfaced services.
 *
 * Filesystem-only and side-effect-free, so the snapshot route can call it to
 * report exactly the problems the service path would hit — before anything has
 * been started, and without starting anything (req 13: a declaration that cannot
 * work says so).
 *
 * **A plugin's services are all-or-nothing.** One unusable service — an invalid
 * fragment, a name that collides — drops every service of that import, with the
 * reason on the repository's card. Half a plugin is the partial state req 15
 * forbids, and for a plugin whose UI and CLI share state (req 17) it is also the
 * confusing one: better no probe UI than a probe UI without the worker beside it.
 */
export function collectPluginFragments(
  opts: CollectPluginFragmentsOptions,
): PluginFragmentResolution {
  const services: PluginFragmentService[] = [];
  const issuesByRepo = new Map<string, string[]>();
  const addIssue = (repo: string, issue: string): void => {
    issuesByRepo.set(repo, [...(issuesByRepo.get(repo) ?? []), issue]);
  };

  const resolver = createPluginImportResolver(opts.plugins, opts.selfExports, opts.stateDir);
  const selfByName = new Map(
    opts.plugins.repos.map((r) => [r.name.toLowerCase(), r.source.kind === "self"]),
  );
  // req 20 phase 3: one name domain across the project and every plugin. Seeded
  // with the project's own services, which always win — they are the thing the
  // consumer did not import and cannot be asked to rename.
  const claimed = new Map<string, string>();
  for (const name of opts.projectServiceNames) claimed.set(name.toLowerCase(), "this project");

  for (const use of opts.plugins.uses) {
    const repoName = resolver.repoNameFor(use);
    // An unknown `from:` is a parse-phase problem the parser already surfaced.
    if (!repoName) continue;
    const exported = resolver.exportFor(use);
    // Not knowable yet (never fetched) or not exported — the card says so
    // already, from the generation record and the selector check.
    if (!exported?.compose) continue;

    const self = selfByName.get(repoName.toLowerCase()) ?? false;
    const root = self ? opts.workspaceDir : activeLinkPath(opts.stateDir, repoName);

    let parsed: ParsedFragmentService[];
    try {
      parsed = parsePluginFragment(path.join(root, exported.compose), opts.containEgress);
    } catch (err) {
      addIssue(repoName, `\`${use.alias}\`: ${message(err)}`);
      continue;
    }

    const claimedHere = renameServices(parsed, use);
    if (typeof claimedHere === "string") {
      addIssue(repoName, `\`${use.alias}\`: ${claimedHere}`);
      continue;
    }

    const collision = claimedHere.find(({ name }) => claimed.has(name.toLowerCase()));
    if (collision) {
      addIssue(
        repoName,
        `\`${use.alias}\`: its service \`${collision.name}\` collides with a service `
        + `${claimed.get(collision.name.toLowerCase())} already provides. Rename it under the `
        + `\`use\` entry whose alias is \`${use.alias}\`, with `
        + `\`overrides.services.${collision.source.name}.as\`.`,
      );
      continue;
    }

    const fragmentDir = path.posix.dirname(exported.compose);
    const commit = self ? undefined : readCommit(opts.stateDir, repoName);
    for (const { name, source } of claimedHere) {
      claimed.set(name.toLowerCase(), `the plugin \`${use.alias}\``);
      services.push({
        name,
        sourceName: source.name,
        alias: use.alias,
        repo: repoName,
        plugin: exported.name,
        preview: resolvePreview(source, use),
        ...(source.port !== undefined ? { port: source.port } : {}),
        definition: source.definition,
        fragmentDir: fragmentDir === "." ? "" : fragmentDir,
        self,
        ...(commit ? { commit } : {}),
      });
    }
  }

  return { services, issuesByRepo };
}

/**
 * req 16 — the fragment declares whether a service starts automatically; the
 * consuming project overrides it per service. The fragment's own default follows
 * the vocabulary project services already use: an explicit `x-shipit-preview`,
 * otherwise `auto` when it declares a port.
 */
function resolvePreview(source: ParsedFragmentService, use: PluginUse): "auto" | "manual" {
  const override = use.overrides.services[source.name]?.autostart;
  if (override !== undefined) return override ? "auto" : "manual";
  return source.preview ?? (source.port !== undefined ? "auto" : "manual");
}

/**
 * Apply the consumer's per-service `as:` renames (req 20) and check that the
 * result is a legal, internally unique set. Returns an error string rather than
 * throwing so the caller can attribute it to the import.
 */
function renameServices(
  parsed: readonly ParsedFragmentService[],
  use: PluginUse,
): { name: string; source: ParsedFragmentService }[] | string {
  const renamed = new Map<string, string>();
  for (const source of parsed) {
    const as = use.overrides.services[source.name]?.as;
    const name = as ?? source.name;
    if (!SERVICE_NAME_RE.test(name)) {
      return `\`overrides.services.${source.name}.as\` is not a usable service name (\`${name}\`).`;
    }
    renamed.set(source.name, name);
  }
  const seen = new Set<string>();
  for (const name of renamed.values()) {
    if (seen.has(name.toLowerCase())) {
      return `two of its services would both be called \`${name}\` after the \`as\` overrides.`;
    }
    seen.add(name.toLowerCase());
  }
  // An override naming a service the fragment does not have is a stale
  // declaration, and silently doing nothing is how a consumer keeps believing a
  // service is manual after the plugin renamed it (the `plugin-state.ts`
  // argument for treating an undeclared setting as an error).
  for (const name of Object.keys(use.overrides.services)) {
    if (!renamed.has(name)) {
      return `\`overrides.services.${name}\` names a service this plugin does not define.`;
    }
  }
  return parsed.map((source) => ({
    name: renamed.get(source.name)!,
    source: { ...source, definition: rewriteDependsOn(source.definition, renamed) },
  }));
}

/** A plugin's internal `depends_on` must follow its own services through `as:`. */
function rewriteDependsOn(
  definition: Record<string, unknown>,
  renamed: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const dependsOn = definition.depends_on;
  if (dependsOn === undefined) return definition;
  if (Array.isArray(dependsOn)) {
    return { ...definition, depends_on: dependsOn.map((d) => renamed.get(String(d)) ?? String(d)) };
  }
  if (dependsOn && typeof dependsOn === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, condition] of Object.entries(dependsOn)) {
      out[renamed.get(name) ?? name] = condition;
    }
    return { ...definition, depends_on: out };
  }
  return definition;
}

function readCommit(stateDir: string, repoName: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(activeLinkPath(stateDir, repoName), ".shipit-generation.json"), "utf-8");
    const record: unknown = JSON.parse(raw);
    const commit = record && typeof record === "object" ? (record as { commit?: unknown }).commit : undefined;
    return typeof commit === "string" ? commit : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fragment parsing + validation
// ---------------------------------------------------------------------------

interface ParsedFragmentService {
  name: string;
  preview?: "auto" | "manual";
  port?: number;
  definition: Record<string, unknown>;
}

/**
 * Read, validate and normalize one compose fragment. Throws
 * {@link PluginFragmentError} with a message written for the consuming
 * project's card — it names the fragment's own key, because the fix belongs to
 * the plugin's author, not to the project that imported it.
 */
export function parsePluginFragment(
  fragmentPath: string,
  containEgress: boolean,
): ParsedFragmentService[] {
  let content: string;
  try {
    content = fs.readFileSync(fragmentPath, "utf-8");
  } catch {
    throw new PluginFragmentError(
      `its compose fragment could not be read (\`${path.basename(fragmentPath)}\`).`,
    );
  }

  // Custom YAML tags are refused for the same reason contained project services
  // refuse them: the `yaml` parser and Compose need not agree on what an
  // unresolved tag means, and a validator that saw a different document from the
  // one that runs is not a validator.
  const document = parseDocument(content);
  let hasExplicitTag = false;
  visit(document, {
    Node: (_key, node) => {
      if (node.tag !== undefined) hasExplicitTag = true;
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<") return;
    },
  });
  if (hasExplicitTag || document.warnings.some((w) => /unresolved tag/i.test(w.message))) {
    throw new PluginFragmentError("its compose fragment uses custom YAML tags, which are not supported.");
  }

  let doc: Record<string, unknown> | null;
  try {
    // Merge keys are resolved HERE and the resolved result is what gets emitted,
    // so Compose never sees an unresolved one — unlike a project file, which
    // Compose reads itself.
    doc = parseYaml(content, { merge: true }) as Record<string, unknown> | null;
  } catch (err) {
    throw new PluginFragmentError(`its compose fragment is not valid YAML: ${message(err)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new PluginFragmentError("its compose fragment must be a YAML mapping.");
  }

  for (const key of Object.keys(doc)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key) || key.startsWith("x-")) continue;
    throw new PluginFragmentError(
      `its compose fragment declares \`${key}:\`, which a plugin fragment may not — `
      + "ShipIt owns the session's networks, volumes and secrets.",
    );
  }

  const rawServices = doc.services;
  if (!rawServices || typeof rawServices !== "object" || Array.isArray(rawServices)) {
    throw new PluginFragmentError("its compose fragment has no `services:` section.");
  }

  const parsed: ParsedFragmentService[] = [];
  for (const [name, raw] of Object.entries(rawServices as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PluginFragmentError(`its compose service \`${name}\` is not a mapping.`);
    }
    parsed.push(parseFragmentService(name, raw as Record<string, unknown>, containEgress));
  }
  if (parsed.length === 0) {
    throw new PluginFragmentError("its compose fragment defines no services.");
  }
  return parsed;
}

function parseFragmentService(
  name: string,
  svc: Record<string, unknown>,
  containEgress: boolean,
): ParsedFragmentService {
  if (!SERVICE_NAME_RE.test(name)) {
    throw new PluginFragmentError(`its compose service \`${name}\` is not a usable service name.`);
  }
  if (svc.build !== undefined) {
    throw new PluginFragmentError(
      `its compose service \`${name}\` declares \`build:\`. A plugin service's own files reach it `
      + "through the plugin's checkout, which a build context cannot be — declare an `image:` instead.",
    );
  }
  for (const key of Object.keys(svc)) {
    if (ALLOWED_SERVICE_KEYS.has(key)) continue;
    throw new PluginFragmentError(
      `its compose service \`${name}\` declares \`${key}:\`, which is not supported in a plugin's `
      + "compose fragment.",
    );
  }
  if (svc.image === undefined) {
    throw new PluginFragmentError(`its compose service \`${name}\` declares no \`image:\`.`);
  }

  // The consuming session's own rules, applied to a plugin exactly as they are
  // applied to the project (docs/263). `dockerSocket: false` unconditionally —
  // see the module note — and never the trusted-ops-proxy shape, which is a
  // server-authored service, not something a repository can claim to be.
  validateServiceSecurity(name, svc, false, containEgress, false);

  validateFragmentVolumes(name, svc.volumes);
  validateFragmentEnvironment(name, svc.environment);

  const ports = readPorts(name, svc.ports);
  const preview = svc["x-shipit-preview"];

  const definition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(svc)) {
    // `ports:` is read for the service's port and never emitted: ShipIt strips
    // host publishing from every service it runs and reaches containers by IP on
    // the session network (`generateComposeOverride`).
    if (key === "ports" || SHIPIT_EXTENSION_KEYS.has(key)) continue;
    definition[key] = value;
  }

  return {
    name,
    ...(preview === "auto" || preview === "manual" ? { preview } : {}),
    ...(ports !== undefined ? { port: ports } : {}),
    definition,
  };
}

/**
 * The container port the service serves on, from its first `ports` entry — the
 * same reading `ServiceManager` does for a project service.
 */
function readPorts(name: string, raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PluginFragmentError(`its compose service \`${name}\`: \`ports\` must be a non-empty list.`);
  }
  const first = raw[0];
  const text = typeof first === "string" || typeof first === "number"
    ? String(first)
    : first && typeof first === "object" && "target" in (first as object)
      ? String((first as { target: unknown }).target)
      : undefined;
  if (text === undefined) {
    throw new PluginFragmentError(`its compose service \`${name}\`: \`ports[0]\` is not a port mapping.`);
  }
  const segments = text.split("/")[0].split(":");
  const port = Number.parseInt(segments[segments.length - 1], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new PluginFragmentError(`its compose service \`${name}\`: \`${text}\` is not a port mapping.`);
  }
  return port;
}

/**
 * A plugin fragment may mount its OWN files and anonymous scratch volumes, and
 * nothing else.
 *
 * A named volume is refused rather than silently created: session-scoped plugin
 * state has a home ShipIt guarantees the lifetime of (`/plugin-state`, reqs 17,
 * 18), and a compose-created volume would survive or vanish on rules the plugin
 * cannot see. Absolute sources and `..` are already refused by the shared
 * validator; this is the half it cannot know — that a bare `foo:/x` is Compose's
 * NAMED-volume syntax rather than a path.
 */
function validateFragmentVolumes(name: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new PluginFragmentError(`its compose service \`${name}\`: \`volumes\` must be a list.`);
  }
  for (const entry of raw) {
    if (typeof entry === "string") {
      // A single path with no `:` is an anonymous volume — allowed.
      if (!entry.includes(":")) continue;
      requireRelativeSource(name, entry.split(":")[0]);
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (obj.type !== undefined && obj.type !== "bind") {
        throw new PluginFragmentError(
          `its compose service \`${name}\`: only bind mounts of the plugin's own files are supported `
          + `(saw \`type: ${String(obj.type)}\`).`,
        );
      }
      if (typeof obj.source !== "string") {
        throw new PluginFragmentError(`its compose service \`${name}\`: a volume entry has no \`source\`.`);
      }
      requireRelativeSource(name, obj.source);
      continue;
    }
    throw new PluginFragmentError(`its compose service \`${name}\`: a volume entry is not a string or mapping.`);
  }
}

function requireRelativeSource(name: string, source: string): void {
  if (source === "." || source === "./" || source.startsWith("./")) return;
  throw new PluginFragmentError(
    `its compose service \`${name}\`: \`${source}\` is not a path inside the plugin. A plugin may `
    + "mount its own files (`./…`) and anonymous volumes; named volumes and host paths are not "
    + "available, and session-scoped state belongs in `/plugin-state`.",
  );
}

/**
 * A fragment's `environment` may not use the list form's pass-through spelling
 * (`- FOO`, no `=`), which Compose resolves from the environment of the process
 * that runs it — the orchestrator's. Values are safe: every `$` is escaped when
 * the definition is emitted (see the module note), so nothing interpolates.
 */
function validateFragmentEnvironment(name: string, raw: unknown): void {
  if (raw === undefined) return;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string" && entry.includes("=")) continue;
      throw new PluginFragmentError(
        `its compose service \`${name}\`: \`environment\` entry \`${String(entry)}\` has no value. `
        + "A plugin's environment must be self-contained; credentials are declared by name in its manifest.",
      );
    }
    return;
  }
  if (raw && typeof raw === "object") return;
  throw new PluginFragmentError(`its compose service \`${name}\`: \`environment\` must be a list or mapping.`);
}

// ---------------------------------------------------------------------------
// Mounts, environment and the emitted definition
// ---------------------------------------------------------------------------

/** A surfaced plugin service, ready for the compose override. */
export interface PluginComposeService {
  name: string;
  sourceName: string;
  alias: string;
  repo: string;
  plugin: string;
  preview: "auto" | "manual";
  /** The port the container serves on — what the preview proxy connects to. */
  port?: number;
  /** The routing key the preview origin carries, pinned per session (req 18). */
  publishedPort?: number;
  /** The complete definition to emit, mounts and environment included. */
  definition: Record<string, unknown>;
  /** Volumes the override must declare `external: true` for. */
  externalVolumes: string[];
}

export interface PluginMountOptions {
  /** The session ROOT (`<sessionsRoot>/<id>`) — `plugin-data/` lives here. */
  sessionDir: string;
  /**
   * The DAEMON's view of {@link sessionDir}. In production the orchestrator sees
   * the session tree inside its own container while the daemon sees a volume
   * mountpoint, and a bind source is resolved by the daemon — the same
   * translation `plugin-overlay.ts` documents, and the same one the staged
   * secrets entrypoint already relies on (planning#287). Identity in dev.
   */
  sessionDirDaemon: string;
  workspaceDir: string;
  /** Docker volume holding the workspace, when the orchestrator runs containerized. */
  workspaceVolume?: string;
  /** This session's subpath within that volume. */
  workspaceSubpath?: string;
  /**
   * Declared repository → the live generation's overlay volume (checkout plus
   * install output). A tracked repository without one cannot serve its own
   * files, so its services are dropped with a reason rather than started
   * against a tree that is missing whatever `install` produced.
   */
  pluginVolumes: ReadonlyMap<string, string>;
  /** Surfaced service name → published port (`plugin-ports.ts`). */
  publishedPorts: ReadonlyMap<string, number>;
}

/**
 * Attach ShipIt's half of the in-session contract to each surfaced service:
 * the plugin's own tree, the consuming project at `/project` (req 21), the
 * import's shared state directory and validated settings file (reqs 17, 18, 26),
 * and the environment that names all three (plan §2).
 *
 * The fragment deliberately declares none of it, so that it stays valid for a
 * plain `docker compose up` and a plugin can report the pieces it did not get.
 */
export function buildPluginComposeServices(
  fragments: readonly PluginFragmentService[],
  opts: PluginMountOptions,
): { services: PluginComposeService[]; issuesByRepo: Map<string, string[]> } {
  const services: PluginComposeService[] = [];
  const issuesByRepo = new Map<string, string[]>();

  for (const fragment of fragments) {
    const volumeName = fragment.self ? undefined : opts.pluginVolumes.get(fragment.repo);
    if (!fragment.self && !volumeName) {
      issuesByRepo.set(fragment.repo, [
        ...(issuesByRepo.get(fragment.repo) ?? []),
        `\`${fragment.alias}\`: its services could not be started because the plugin's writable `
        + "layer is not available in this session.",
      ]);
      continue;
    }

    const definition: Record<string, unknown> = { ...fragment.definition };
    const externalVolumes: string[] = [];
    if (volumeName) externalVolumes.push(volumeName);
    if (opts.workspaceVolume) externalVolumes.push("shipit-workspace");

    const volumes: unknown[] = [];
    for (const entry of asArray(fragment.definition.volumes)) {
      volumes.push(rewriteFragmentVolume(entry, fragment, opts, volumeName));
    }
    volumes.push(projectMount(opts));
    volumes.push(...pluginDataMounts(fragment.alias, opts));
    definition.volumes = volumes;

    definition.environment = {
      ...normalizeEnvironment(fragment.definition.environment),
      ...pluginEnvironment(fragment, opts),
    };

    services.push({
      name: fragment.name,
      sourceName: fragment.sourceName,
      alias: fragment.alias,
      repo: fragment.repo,
      plugin: fragment.plugin,
      preview: fragment.preview,
      ...(fragment.port !== undefined ? { port: fragment.port } : {}),
      ...(opts.publishedPorts.has(fragment.name)
        ? { publishedPort: opts.publishedPorts.get(fragment.name) }
        : {}),
      // Escaped LAST, over everything: Compose interpolates `${VAR}` and `$VAR`
      // from the environment of the process that runs it — the orchestrator's —
      // and this file is written by ShipIt, so nothing in it may interpolate.
      // `$$` is Compose's own escape, so an ordinary `sh -c 'echo $HOME'`
      // survives untouched (see the module note).
      definition: escapeDollars(definition) as Record<string, unknown>,
      externalVolumes,
    });
  }

  return { services, issuesByRepo };
}

/**
 * Point a fragment's relative source at the plugin's own tree.
 *
 * For a tracked repository that tree is the generation's overlay volume — the
 * pristine checkout with the install output merged over it — so the mount is a
 * volume subpath rooted at the fragment's own directory, which is what makes
 * `- .:/app` mean "this plugin", exactly as it does standalone. A `repo: self`
 * import has no generation (req 27): its tree is the session's own working
 * copy, reached the same way the project's own services reach it.
 */
function rewriteFragmentVolume(
  entry: unknown,
  fragment: PluginFragmentService,
  opts: PluginMountOptions,
  volumeName: string | undefined,
): unknown {
  const parsed = readVolumeEntry(entry);
  if (!parsed) return entry; // an anonymous volume — nothing to resolve
  const { source, target, readOnly } = parsed;
  const relative = source === "." || source === "./" ? "" : source.slice(2);
  const withinRepo = joinPosix(fragment.fragmentDir, relative);

  if (volumeName) {
    return {
      type: "volume",
      source: volumeName,
      target,
      ...(withinRepo ? { volume: { subpath: withinRepo } } : {}),
      ...(readOnly ? { read_only: true } : {}),
    };
  }
  if (opts.workspaceVolume) {
    const subpath = joinPosix(opts.workspaceSubpath ?? "", withinRepo);
    return {
      type: "volume",
      source: "shipit-workspace",
      target,
      ...(subpath ? { volume: { subpath } } : {}),
      ...(readOnly ? { read_only: true } : {}),
    };
  }
  return {
    type: "bind",
    source: path.join(opts.workspaceDir, withinRepo),
    target,
    ...(readOnly ? { read_only: true } : {}),
  };
}

/** req 21 — the consuming project's workspace, at the one path every plugin can name. */
function projectMount(opts: PluginMountOptions): Record<string, unknown> {
  if (opts.workspaceVolume) {
    return {
      type: "volume",
      source: "shipit-workspace",
      target: CONTAINER_PROJECT_DIR,
      ...(opts.workspaceSubpath ? { volume: { subpath: opts.workspaceSubpath } } : {}),
    };
  }
  return { type: "bind", source: opts.workspaceDir, target: CONTAINER_PROJECT_DIR };
}

/**
 * The import's two primitives (`plugin-state.ts`): its shared state directory,
 * read-WRITE, and its validated settings file, read-ONLY.
 *
 * The settings file is mounted only when it exists. A bind source that does not
 * exist is created by the daemon as an empty DIRECTORY, which would both give
 * the plugin a settings path it cannot parse and leave a directory where the
 * next validated write expects a file.
 *
 * The state directory is created here when it is missing, rather than skipped,
 * because the opposite failure is the harmful one: the daemon would create it
 * owned by root and the plugin — which runs as the session-worker uid — could
 * not write the one surface req 18 gives it. `preparePluginState` owns it in the
 * steady state; this is the ordering case where a stack starts before the first
 * activation round has settled.
 */
function pluginDataMounts(alias: string, opts: PluginMountOptions): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const stateDir = pluginStateDir(opts.sessionDir, alias);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    chownToSessionWorker(stateDir);
    mounts.push({
      type: "bind",
      source: pluginStateDir(opts.sessionDirDaemon, alias),
      target: CONTAINER_PLUGIN_STATE_DIR,
    });
  } catch (err) {
    console.warn(`[plugins] could not prepare ${stateDir}:`, message(err));
  }
  if (fs.existsSync(pluginSettingsPath(opts.sessionDir, alias))) {
    mounts.push({
      type: "bind",
      source: pluginSettingsPath(opts.sessionDirDaemon, alias),
      target: CONTAINER_PLUGIN_SETTINGS_FILE,
      read_only: true,
    });
  }
  return mounts;
}

/**
 * The environment both surfaces share (plan §2). `SHIPIT_PLUGIN_COMMIT` is
 * deliberately absent under `repo: self`: a live working tree corresponds to no
 * exact commit (req 15's own scope), and its absence is how the fixture tells
 * its two modes apart.
 */
function pluginEnvironment(
  fragment: PluginFragmentService,
  opts: PluginMountOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    [PLUGIN_PROJECT_ENV]: CONTAINER_PROJECT_DIR,
    [PLUGIN_STATE_ENV]: CONTAINER_PLUGIN_STATE_DIR,
  };
  if (fs.existsSync(pluginSettingsPath(opts.sessionDir, fragment.alias))) {
    env[PLUGIN_SETTINGS_ENV] = CONTAINER_PLUGIN_SETTINGS_FILE;
  }
  if (fragment.commit) env[PLUGIN_COMMIT_ENV] = fragment.commit;
  return env;
}

function readVolumeEntry(
  entry: unknown,
): { source: string; target: string; readOnly: boolean } | null {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    if (parts.length < 2) return null;
    return { source: parts[0], target: parts[1], readOnly: parts[2] === "ro" };
  }
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.source !== "string" || typeof obj.target !== "string") return null;
    return { source: obj.source, target: obj.target, readOnly: obj.read_only === true };
  }
  return null;
}

/** Compose accepts `environment` as a map or a `K=V` list; merging needs one shape. */
function normalizeEnvironment(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const index = entry.indexOf("=");
      if (index <= 0) continue; // refused during validation; belt and braces
      out[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      out[key] = String(value);
    }
  }
  return out;
}

/** Compose's own escape: `$$` renders as a literal `$` and interpolates nothing. */
function escapeDollars(value: unknown): unknown {
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
 * Project a surfaced plugin service into the shape the override generator
 * consumes, so a plugin service picks up every ShipIt policy a project service
 * gets — labels, the session network, `cap_drop`, the contained-egress overlay,
 * the session-worker uid — from ONE implementation (req 16's lifecycle parity).
 *
 * `dependsOnInstall: false`: the install gate exists for services that read the
 * consuming project's `node_modules` while `agent.install` is writing them
 * (docs/137). A plugin's dependencies are its own, installed into its own layer
 * before its generation was published (plan §1b), so gating it on the project's
 * install would hold it for something it never reads.
 */
export function toComposeService(svc: PluginComposeService): ComposeService {
  const declaredUser = svc.definition.user;
  return {
    name: svc.name,
    origin: {
      kind: "plugin",
      repo: svc.repo,
      alias: svc.alias,
      plugin: svc.plugin,
      sourceName: svc.sourceName,
    },
    pluginDefinition: svc.definition,
    externalVolumes: svc.externalVolumes,
    shipitPreview: svc.preview,
    dependsOnInstall: false,
    // Read back off the definition so the generator does not inject the session
    // worker uid over a `user:` the fragment declared — which a contained
    // session requires it to declare.
    ...(typeof declaredUser === "string" || typeof declaredUser === "number"
      ? { user: String(declaredUser) }
      : {}),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function joinPosix(...segments: string[]): string {
  return segments.filter((s) => s.length > 0).join("/");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
