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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, parseDocument, visit } from "yaml";
import type {
  DeclaredPluginRepo,
  PluginExport,
  PluginReposConfig,
  PluginUse,
} from "../shared/plugin-repos.js";
import {
  CONTAINER_PLUGIN_SETTINGS_FILE,
  CONTAINER_PLUGIN_STATE_DIR,
  CONTAINER_PLUGIN_DIR,
  CONTAINER_PROJECT_DIR,
  PLUGIN_COMMIT_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_STATE_ENV,
  PLUGIN_PROJECT_ENV,
  PLUGIN_PORT_ENV,
} from "../shared/plugin-contract.js";
import {
  pluginSettingsPath,
  pluginStateDir,
  PLUGIN_DATA_SUBDIR,
  PLUGIN_SETTINGS_FILE,
  PLUGIN_STATE_SUBDIR,
} from "./plugin-state.js";
import {
  generationIdFor,
  readGenerationManifestAt,
  type LiveGenerations,
} from "./plugin-generations.js";
import {
  escapeDollars,
  OVERRIDE_SENTINELS,
  validateServiceSecurity,
  type ComposeService,
} from "./compose-generator.js";
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
  /**
   * The port the service serves on — the consuming project's
   * `overrides.services.<name>.port` and nothing else (docs/266-plugin-service-ports reqs 2, 9).
   * Absent means the project named none, so the service is not previewable.
   */
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
  /**
   * The credential NAMES the exported plugin declares (req 23), de-duplicated,
   * in manifest order.
   *
   * Read from the SAME manifest this fragment came from — the resolve-once
   * snapshot — so a service can never be started with the names of one
   * generation and the tree of another. Names only: the values are resolved
   * from the consuming project's own secret store, at the one place that
   * already decides which names count as satisfied
   * (`service-secrets-resolver.ts`), and never travel through this module.
   */
  credentials: readonly string[];
  /** `repo: self` — the live working tree, with no generation (req 27). */
  self: boolean;
  /** The live generation's commit, for a tracked repository (req 15). */
  commit?: string;
  /**
   * docs/273-plugin-generation-rebuild — the live generation's IDENTITY, which
   * is what its overlay volume and writable layer are named by. Usually the
   * commit; `<commit>.<8 hex>` for a build that was made beside a live one.
   * Absent for `repo: self`, which has no generation at all.
   *
   * Carried beside `commit` rather than derived from it because the two answer
   * different questions: the commit is what the session is RUNNING and goes in
   * `SHIPIT_PLUGIN_COMMIT`, the id is which copy of it, and a mount built from
   * the commit would name the volume of a different build.
   */
  generationId?: string;
  /**
   * The concrete tree this was read from — an already-resolved generation
   * directory, never the `active` symlink. Carried so the overlay volume's
   * lowerdir is the SAME generation the fragment and commit came from.
   */
  checkoutDir: string;
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
  /**
   * This operation's live generations, resolved once per repository (docs/262
   * resolve-once). Taken rather than a `stateDir` so a fragment, the tree it
   * mounts and the card's commit cannot come from three different generations —
   * and so the identity check that proves a generation belongs to the
   * declaration runs where the link is resolved, not once per reader.
   */
  live: LiveGenerations;
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
  // No `ports`: the number is the consuming project's to write (docs/266-plugin-service-ports req 1),
  // and a fragment that declares one is refused by name in `parseService`.
  "expose", "depends_on", "healthcheck", "init", "read_only", "tmpfs",
  "user", "stop_grace_period", "stop_signal", "shm_size", "mem_limit",
  "mem_reservation", "cpus", "pids_limit", "ulimits",
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

  // ONE snapshot per declared repository, resolved once (see
  // {@link RepoSnapshot}). Everything below reads from it rather than following
  // `active` again.
  const snapshots = new Map<string, RepoSnapshot>();
  for (const repo of opts.plugins.repos) {
    snapshots.set(repo.name.toLowerCase(), snapshotRepo(repo, opts));
  }
  // req 20 phase 3: one name domain across the project and every plugin. Seeded
  // with the project's own services, which always win — they are the thing the
  // consumer did not import and cannot be asked to rename.
  const claimed = new Map<string, string>();
  for (const name of opts.projectServiceNames) claimed.set(name.toLowerCase(), "this project");
  // docs/266-plugin-service-ports req 7, the half that is settled here: every plugin service's port
  // is written in `shipit.yaml`, so two imports claiming one number is knowable
  // from the declaration alone. The project's OWN ports are deliberately NOT
  // seeded — this module's separate read of the project compose file is the
  // thing that disagreed with the running stack in #2325, so it must not be
  // what refuses. `ServiceManager` decides that pair against the real parse.
  const claimedPorts = new Map<number, string>();

  for (const use of opts.plugins.uses) {
    const snapshot = snapshots.get(use.from.toLowerCase());
    // An unknown `from:` is a parse-phase problem the parser already surfaced.
    // A repository with no live generation is not knowable yet — the card says
    // so already, from the generation record and the selector check.
    if (!snapshot?.root) continue;
    const repoName = snapshot.name;
    const exported = snapshot.exports.find((e) => e.name.toLowerCase() === use.plugin.toLowerCase());
    if (!exported?.compose) continue;

    let parsed: ParsedFragmentService[];
    try {
      parsed = parsePluginFragment(path.join(snapshot.root, exported.compose), opts.containEgress);
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

    // docs/266-plugin-service-ports req 7 — checked across the whole import before any of it is
    // pushed, and against the imports already accepted, so both the two-imports
    // case and the two-services-in-one-import case are caught. The import is
    // refused whole, matching the all-or-nothing rule below.
    const portIssue = findPortCollision(claimedHere, use, claimedPorts);
    if (portIssue) {
      addIssue(repoName, `\`${use.alias}\`: ${portIssue}`);
      continue;
    }

    const fragmentDir = path.posix.dirname(exported.compose);
    for (const { name, source } of claimedHere) {
      claimed.set(name.toLowerCase(), `the plugin \`${use.alias}\``);
      const port = use.overrides.services[source.name]?.port;
      if (port !== undefined) {
        claimedPorts.set(port, `the plugin \`${use.alias}\`'s service \`${name}\``);
      }
      services.push({
        name,
        sourceName: source.name,
        alias: use.alias,
        repo: repoName,
        plugin: exported.name,
        preview: resolvePreview(source, use, port),
        ...(port !== undefined ? { port } : {}),
        definition: source.definition,
        fragmentDir: fragmentDir === "." ? "" : fragmentDir,
        credentials: [...new Set(exported.credentials)],
        self: snapshot.self,
        checkoutDir: snapshot.root,
        ...(snapshot.commit ? { commit: snapshot.commit } : {}),
        ...(snapshot.generationId ? { generationId: snapshot.generationId } : {}),
      });
    }
  }

  // A repository's services activate as a UNIT (plan §1a phase 3, ruling of
  // 2026-08-13): one unusable service withholds every service that repository
  // provides, not just its own import's. A compose stack is not a set of
  // independent services — the ones that came up would be running against a
  // stack the declaration cannot produce — and the prior generation stays live
  // either way (req 15), so nothing is torn down to say so.
  //
  // This is deliberately NOT the rule for commands, which are withheld
  // individually. The asymmetry is the difference between a stack and a name.
  return {
    services: services.filter((s) => !issuesByRepo.has(s.repo)),
    issuesByRepo,
  };
}

/**
 * The first port two of this declaration's plugin services both claim, phrased
 * for the consumer (docs/266-plugin-service-ports req 7). `undefined` when the import is clean.
 *
 * Both numbers are the consumer's own, in one file, so naming both services and
 * refusing is something the reader can act on — which is the whole difference
 * from #2325, where ShipIt silently served one of them.
 */
function findPortCollision(
  claimedHere: readonly { name: string; source: ParsedFragmentService }[],
  use: PluginUse,
  claimedPorts: ReadonlyMap<number, string>,
): string | undefined {
  const seenHere = new Map<number, string>();
  for (const { name, source } of claimedHere) {
    const port = use.overrides.services[source.name]?.port;
    if (port === undefined) continue;
    const prior = seenHere.get(port) ?? claimedPorts.get(port);
    if (prior !== undefined) {
      return `its service \`${name}\` is given port ${port}, which ${prior} already uses. `
        + "Two services cannot preview on one port — give one of them a different "
        + "`port:` in its `plugins.use` overrides.";
    }
    seenHere.set(port, `this import's service \`${name}\``);
  }
  return undefined;
}

/**
 * req 16 — whether a service starts automatically, which is NOT the same
 * question as whether it is previewable.
 *
 * docs/266-plugin-service-ports req 9 governs previewability, and it needs nothing from this field:
 * a service the consuming project named no port for carries no port, and the
 * pane's detected-ports list is built from ports (`buildDetectedPortsFromServices`),
 * so it cannot reach the pane whatever this returns. Which is why a portless
 * service can still be `auto`: a worker the consumer asked to start
 * automatically starts, and simply has nothing to preview.
 *
 * What the port DOES decide is the default, in place of the fragment's own
 * `ports:` — the consumer naming a port is what says "this one is a UI". The
 * fragment's `x-shipit-preview` survives under that as the author's hint.
 */
function resolvePreview(
  source: ParsedFragmentService,
  use: PluginUse,
  port: number | undefined,
): "auto" | "manual" {
  const override = use.overrides.services[source.name]?.autostart;
  if (override !== undefined) return override ? "auto" : "manual";
  // An explicit `x-shipit-preview` is still the author's answer, port or no
  // port. Letting the port override it would SILENTLY drop a key the fragment
  // declared — a portless worker written `auto` would stop starting, with
  // nothing anywhere saying why. The port replaces the fragment's old `ports:`
  // as the DEFAULT only.
  if (source.preview !== undefined) return source.preview;
  return port !== undefined ? "auto" : "manual";
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

/**
 * One declared repository as ONE round sees it.
 *
 * Built by resolving `active` exactly once, because the alternative is not
 * merely repetitive but wrong: a refresh can publish a new generation between
 * two reads, and following the link four times could produce a manifest from
 * generation A, a service definition from B, a `SHIPIT_PLUGIN_COMMIT` from C and
 * an overlay whose lowerdir is D. The symlink swap is atomic per read; nothing
 * makes separate reads coherent with each other (review finding). One
 * `realpath` fixes the generation for the whole round, and every later consumer
 * is handed that concrete directory.
 */
interface RepoSnapshot {
  /** The declaration's own spelling — the unit the card groups by. */
  name: string;
  /** The concrete tree to read from, or null when nothing is live yet. */
  root: string | null;
  self: boolean;
  /** The generation's exported plugins, read from that same tree. */
  exports: readonly PluginExport[];
  /** The generation's commit (req 15); absent for `repo: self`. */
  commit?: string;
  /** That generation's identity — the directory, layer and volume name. */
  generationId?: string;
}

function snapshotRepo(
  repo: DeclaredPluginRepo,
  opts: CollectPluginFragmentsOptions,
): RepoSnapshot {
  if (repo.source.kind === "self") {
    // req 27 — the live working tree, which corresponds to no exact commit.
    return { name: repo.name, root: opts.workspaceDir, self: true, exports: opts.selfExports };
  }
  const verified = opts.live(repo);
  if (!verified) {
    // Nothing live, or nothing live that belongs to this declaration — the
    // caller already treats a null root as "this repository contributes no
    // services", which is the right answer for both.
    return { name: repo.name, root: null, self: false, exports: [] };
  }
  // Every fact read out of the directory the resolution already returned, never
  // from the link again — that is the whole point of the snapshot, and the
  // generation engine offers the directory-scoped readers for exactly this.
  return {
    name: repo.name,
    root: verified.dir,
    self: false,
    exports: readGenerationManifestAt(verified.dir),
    commit: verified.record.commit,
    // From the resolved DIRECTORY, so the volume this names and the lowerdir it
    // points at cannot describe two builds (docs/273-plugin-generation-rebuild).
    generationId: generationIdFor(verified.dir, verified.record),
  };
}

// ---------------------------------------------------------------------------
// Fragment parsing + validation
// ---------------------------------------------------------------------------

interface ParsedFragmentService {
  name: string;
  /** The author's start hint. It no longer decides previewability (docs/266-plugin-service-ports req 9). */
  preview?: "auto" | "manual";
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

  // A `depends_on` may only name another service in THIS fragment. Left
  // unchecked, an unknown name is not a plugin problem but a PROJECT one:
  // Compose refuses the whole document when a dependency does not resolve, so a
  // plugin could take the project's own stack down with it — and one that DID
  // resolve, against a project service, would be a plugin asserting an ordering
  // over a repository it knows nothing about.
  const own = new Set(parsed.map((s) => s.name));
  for (const service of parsed) {
    for (const target of dependsOnTargets(service.definition.depends_on)) {
      if (own.has(target)) continue;
      throw new PluginFragmentError(
        `its compose service \`${service.name}\` depends on \`${target}\`, which is not a service `
        + "in the same plugin. A plugin's services may only depend on each other.",
      );
    }
  }
  return parsed;
}

/** The service names a `depends_on` refers to, in either of Compose's two forms. */
function dependsOnTargets(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((entry) => describe(entry));
  if (raw && typeof raw === "object") return Object.keys(raw);
  return [];
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
  // docs/266-plugin-service-ports reqs 1 + 6. Checked ahead of the allowlist loop so the reader gets
  // the rule and the remedy rather than "not supported": this is the one refused
  // key that used to be legal, and the line to delete is the whole message.
  if (svc.ports !== undefined) {
    throw new PluginFragmentError(
      `its compose service \`${name}\` declares \`ports:\`. A plugin cannot know what a consuming `
      + "project already runs, so the port is the consumer's to write — as `port:` on that service "
      + "in its `plugins.use` overrides. Remove the `ports:` line.",
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

  // ShipIt substitutes Compose's `!reset`/`!override` tags into the generated
  // override by text replacement after serialization, so a fragment value
  // carrying one of those literals would be rewritten inside the document ShipIt
  // authors. Refused rather than escaped: nothing legitimate contains them, and
  // an escape would have to survive a pass that runs on the serialized text.
  for (const sentinel of OVERRIDE_SENTINELS) {
    if (JSON.stringify(svc).includes(sentinel)) {
      throw new PluginFragmentError(
        `its compose service \`${name}\` contains \`${sentinel}\`, which is reserved by ShipIt.`,
      );
    }
  }

  // The consuming session's own rules, applied to a plugin exactly as they are
  // applied to the project (docs/263). `dockerSocket: false` unconditionally —
  // see the module note — and never the trusted-ops-proxy shape, which is a
  // server-authored service, not something a repository can claim to be.
  validateServiceSecurity(name, svc, false, containEgress, false);

  validateFragmentVolumes(name, svc.volumes);
  validateFragmentEnvironment(name, svc.environment);

  const preview = svc["x-shipit-preview"];

  const definition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(svc)) {
    if (SHIPIT_EXTENSION_KEYS.has(key)) continue;
    definition[key] = value;
  }

  return {
    name,
    ...(preview === "auto" || preview === "manual" ? { preview } : {}),
    definition,
  };
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
          + `(saw \`type: ${describe(obj.type)}\`).`,
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

/**
 * `./` says where a bind source STARTS. It deliberately says nothing about
 * where it ends: `./../..` satisfies this and leaves the plugin's tree. The
 * containment half belongs to `validateServiceSecurity`, which every fragment
 * also runs (see the module docstring) and which refuses a traversal by name —
 * so this stays the shape check and does not grow a second, divergent one.
 */
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
        `its compose service \`${name}\`: \`environment\` entry \`${describe(entry)}\` has no value. `
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
  /**
   * The port the container serves on AND the preview origin it answers at — one
   * number, the consuming project's (docs/266-plugin-service-ports reqs 2, 10), exactly as a project
   * service's port already is.
   */
  port?: number;
  /** The complete definition to emit, mounts and environment included. */
  definition: Record<string, unknown>;
  /**
   * The credential names this service's plugin declares (req 23) — carried
   * through so the secrets pass can deliver exactly those, and so a manifest
   * that gains or drops a name counts as a CHANGED service
   * (`setPluginServices` compares these objects) and the container is recreated
   * with the new set.
   *
   * Never values. Delivery is an env file the secrets resolver writes outside
   * the workspace; nothing about a credential enters this definition, so the
   * override the daemon reads stays free of secrets.
   */
  credentials: readonly string[];
  /** Volumes the override must declare `external: true` for. */
  externalVolumes: string[];
  /**
   * `repo: self` — the plugin's tree is this session's own working tree, with no
   * generation and no `install` of its own (req 27). Carried through because the
   * install gate depends on it; see {@link toComposeService}.
   */
  self: boolean;
  /**
   * Fingerprint of the validated settings file's CONTENT (req 26), or absent
   * when the import has none.
   *
   * It exists to make a settings change visible twice, because nothing else
   * makes it visible at all. The settings file is written atomically and only
   * when its content actually changed, so a change gives it a NEW INODE — and a
   * file bind mount follows the inode it was created with, so a running
   * container goes on reading the file nobody writes to any more. The mount path
   * is identical either way, so neither the reconcile decision
   * (`setPluginServices`) nor Compose's own "has this service changed?" test
   * would notice. Carried into a label, it changes both answers together: the
   * round reconciles, and Compose recreates the container that has to re-open
   * the file.
   */
  settingsFingerprint?: string;
}

export interface PluginMountOptions {
  /** The session ROOT (`<sessionsRoot>/<id>`) — `plugin-data/` lives here. */
  sessionDir: string;
  /**
   * The session root's path INSIDE the workspace volume (`sessions/<id>`), when
   * there is one.
   *
   * A subpath, never a host path, and that is the whole point. In production the
   * session tree lives inside a named volume the daemon knows nothing about, so
   * a plain bind of the orchestrator's `/workspace/sessions/<id>/…` makes Docker
   * silently create an EMPTY, ROOT-OWNED directory — `/plugin-state` would not
   * be the state the CLI writes to, and `/project` would not be the project.
   * Dev and dogfood would work perfectly the whole time, because there the paths
   * are real. `container-lifecycle.ts` mounts workspace, credentials, uploads
   * and scratch this way for exactly this reason; absent here means dev, where a
   * bind of the real path is correct.
   *
   * Absent WITH a `workspaceVolume` means the caller could not locate the
   * session inside that volume, which is not dev and has no correct mount —
   * every service is dropped with a reason rather than mounted wrongly (see
   * {@link SessionVolume}).
   */
  sessionSubpath?: string;
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
}

/**
 * Compose's own name for the workspace volume. It is an ALIAS: the override
 * generator declares it `external: true` with `name:` set to the real volume
 * (`compose-generator.ts`), so every file ShipIt writes names it this way and
 * only the generator knows what it resolves to.
 */
const WORKSPACE_VOLUME_ALIAS = "shipit-workspace";

/**
 * The session, as the DAEMON can reach it — present only when the orchestrator
 * runs containerized, and then complete.
 *
 * Both halves are required together, and that is the point. `workspaceSubpath`
 * names the git clone; `sessionSubpath` names its parent, because `plugin-data/`
 * is a SIBLING of `workspace/` and cannot be derived from the clone's path. A
 * mount that had the volume but not the subpath it needs used to fall back —
 * `/plugin-state` to a bind (an empty root-owned directory in production), and
 * `/project` to the volume with no subpath, which is every session's tree at
 * once. Neither is a degraded mount; both are wrong in a way nothing reports.
 * Making the pair one value means a mount helper that compiles has the subpath.
 */
interface SessionVolume {
  workspaceSubpath: string;
  sessionSubpath: string;
}

function sessionVolume(opts: PluginMountOptions): SessionVolume | undefined {
  if (!opts.workspaceVolume || !opts.workspaceSubpath || !opts.sessionSubpath) return undefined;
  return { workspaceSubpath: opts.workspaceSubpath, sessionSubpath: opts.sessionSubpath };
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
  // Both failures below are per IMPORT, while the loops that reach them run per
  // SERVICE — so an import with three services said the same thing three times
  // on its card. Deduplicated here rather than at the reader: the card's unit is
  // the repository, and one fact stated once is what it is for.
  const addIssue = (repo: string, issue: string): void => {
    const existing = issuesByRepo.get(repo) ?? [];
    if (existing.includes(issue)) return;
    issuesByRepo.set(repo, [...existing, issue]);
  };

  // Resolved ONCE, and every session-path mount below takes it rather than
  // reading `opts` again. That is what makes the volume form unmissable: with a
  // volume runtime there is no subpath-less branch left to fall into, so no
  // mount can quietly become "the whole volume" or "an orchestrator path the
  // daemon cannot see" — see {@link SessionVolume}.
  const volume = sessionVolume(opts);
  if (opts.workspaceVolume && !volume) {
    for (const fragment of fragments) {
      addIssue(
        fragment.repo,
        `\`${fragment.alias}\`: its services could not be started because ShipIt could not locate `
        + "this session inside the workspace volume.",
      );
    }
    return { services: [], issuesByRepo };
  }

  for (const fragment of fragments) {
    const volumeName = fragment.self ? undefined : opts.pluginVolumes.get(fragment.repo);
    if (!fragment.self && !volumeName) {
      addIssue(
        fragment.repo,
        `\`${fragment.alias}\`: its services could not be started because the plugin's writable `
        + "layer is not available in this session.",
      );
      continue;
    }

    const definition: Record<string, unknown> = { ...fragment.definition };
    const externalVolumes: string[] = [];
    if (volumeName) externalVolumes.push(volumeName);
    if (opts.workspaceVolume) externalVolumes.push(WORKSPACE_VOLUME_ALIAS);

    const volumes: unknown[] = [];
    for (const entry of asArray(fragment.definition.volumes)) {
      volumes.push(rewriteFragmentVolume(entry, fragment, opts, volumeName, volume));
    }
    volumes.push(pluginTreeMount(opts, volumeName, volume));
    volumes.push(projectMount(opts, volume));
    volumes.push(...pluginDataMounts(fragment.alias, opts, volume));
    definition.volumes = volumes;

    const settingsFingerprint = fingerprintSettings(fragment.alias, opts);
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
      credentials: fragment.credentials,
      ...(fragment.port !== undefined ? { port: fragment.port } : {}),
      // Escaped LAST, over everything: Compose interpolates `${VAR}` and `$VAR`
      // from the environment of the process that runs it — the orchestrator's —
      // and this file is written by ShipIt, so nothing in it may interpolate.
      // `$$` is Compose's own escape, so an ordinary `sh -c 'echo $HOME'`
      // survives untouched (see the module note).
      definition: escapeDollars(definition) as Record<string, unknown>,
      externalVolumes,
      self: fragment.self,
      ...(settingsFingerprint ? { settingsFingerprint } : {}),
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
 *
 * **A tracked mount is forced read-only, whatever the fragment declared** — the
 * rule is about the TREE, not about the path ShipIt happens to mount it at
 * ({@link pluginTreeMount}). Compose's default is read-write, so the ordinary
 * `- .:/app` handed a consumer's service a writable alias of the generation
 * while `/plugin` next to it was read-only: the service could copy-up into the
 * layer and change the code its own repository's CLIs then executed, under a
 * `SHIPIT_PLUGIN_COMMIT` that no longer described it (reqs 7, 15). Forced
 * rather than refused, because the read-write form is a default almost no
 * fragment means, and refusing would withhold a whole plugin's services over
 * a colon nobody typed.
 *
 * A `repo: self` fragment keeps what it declared: there the tree IS the project,
 * which the same container already has read-write at `/project` (req 27).
 */
function rewriteFragmentVolume(
  entry: unknown,
  fragment: PluginFragmentService,
  opts: PluginMountOptions,
  volumeName: string | undefined,
  volume: SessionVolume | undefined,
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
      read_only: true,
    };
  }
  if (volume) {
    return {
      type: "volume",
      source: WORKSPACE_VOLUME_ALIAS,
      target,
      volume: { subpath: joinPosix(volume.workspaceSubpath, withinRepo) },
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

/**
 * The plugin's own tree at {@link CONTAINER_PLUGIN_DIR} — the one path every
 * surface that runs plugin code mounts it at, so a `cli:` entrypoint declared
 * relative to the repository root resolves identically in a CLI invocation and
 * in a service (`plugin-contract.ts`).
 *
 * **`/plugin` carries the writability of what it IS, and the answer never
 * depends on which surface asks** (plan §1b; the rule the two surfaces once
 * disagreed about, real-instance-e2e Run 1).
 *
 * - **A tracked generation is read-only**, on services and on companion-CLI
 *   invocations alike (`plugin-cli-run.ts` mounts the same volume the same way),
 *   and unlike the install container's view of it. Req 7 keeps the plugin source
 *   unmodified, and req 15 says the files, the CLIs and the services of a
 *   repository all correspond to ONE commit — a surface that can copy-up into the
 *   generation's layer breaks that for every other surface in the session, with
 *   `SHIPIT_PLUGIN_COMMIT` still naming the commit it no longer is. `install` is
 *   the one writer, and it runs before the generation is published. A plugin's
 *   writable surfaces at runtime are `/plugin-state` (session-scoped state,
 *   req 18) and `/project` (durable output, reqs 18, 21).
 * - **A `repo: self` working tree is read-write**, for the same reason: req 27
 *   makes the checkout this session's own tree, editable and live, and binds req
 *   7 to consuming projects only. Read-only here would not be containment at
 *   all — it is the very same tree this function's caller mounts read-write at
 *   `/project`, so it only forbids naming it `/plugin`.
 *
 * The volume root IS the repository root, so no subpath: the fragment's own
 * relative mounts are the ones anchored at the fragment's directory.
 */
function pluginTreeMount(
  opts: PluginMountOptions,
  volumeName: string | undefined,
  volume: SessionVolume | undefined,
): Record<string, unknown> {
  if (volumeName) {
    return { type: "volume", source: volumeName, target: CONTAINER_PLUGIN_DIR, read_only: true };
  }
  // A `repo: self` import has no generation: its tree is the session's own
  // working copy, which is also its `/project` (req 27 — the plugin repository
  // IS the consuming project there), and it is mounted with the same rights.
  if (volume) {
    return {
      type: "volume",
      source: WORKSPACE_VOLUME_ALIAS,
      target: CONTAINER_PLUGIN_DIR,
      volume: { subpath: volume.workspaceSubpath },
    };
  }
  return { type: "bind", source: opts.workspaceDir, target: CONTAINER_PLUGIN_DIR };
}

/** req 21 — the consuming project's workspace, at the one path every plugin can name. */
function projectMount(
  opts: PluginMountOptions,
  volume: SessionVolume | undefined,
): Record<string, unknown> {
  if (volume) {
    return {
      type: "volume",
      source: WORKSPACE_VOLUME_ALIAS,
      target: CONTAINER_PROJECT_DIR,
      volume: { subpath: volume.workspaceSubpath },
    };
  }
  return { type: "bind", source: opts.workspaceDir, target: CONTAINER_PROJECT_DIR };
}

/**
 * The import's two primitives (`plugin-state.ts`): its shared state directory,
 * read-WRITE, and its validated settings file, read-ONLY.
 *
 * Both live at `<sessionDir>/plugin-data/<alias>/…`, a SIBLING of `workspace/`,
 * so neither is workspace-relative and neither may be an absolute bind — see
 * {@link PluginMountOptions.sessionSubpath} for what a bind would silently do in
 * production. They get the same volume+subpath shape the agent container's own
 * mounts use, keyed off the session root instead of the workspace.
 *
 * The settings file is mounted **as a file**, which the daemon supports: it
 * stats the resolved path and binds a file as a file
 * (`daemon/volume/safepath/join_linux.go`), from API 1.45 — below the Engine 28
 * docs/263 already requires. Mounting its parent instead would hand the plugin
 * a directory it can write, and settings a plugin can rewrite were never
 * validated.
 *
 * It is mounted only when it EXISTS: a mount source that does not is created as
 * an empty directory, which would both give the plugin a settings path it cannot
 * parse and leave a directory where the next validated write expects a file.
 *
 * The state directory is created here when it is missing, rather than skipped,
 * because the opposite failure is the harmful one: it would be created owned by
 * root and the plugin — which runs as the session-worker uid — could not write
 * the one surface req 18 gives it. `preparePluginState` owns it in the steady
 * state; this is the ordering case where a stack starts before the first
 * activation round has settled.
 */
function pluginDataMounts(
  alias: string,
  opts: PluginMountOptions,
  volume: SessionVolume | undefined,
): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const stateDir = pluginStateDir(opts.sessionDir, alias);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    chownToSessionWorker(stateDir);
    mounts.push(sessionMount(volume, `${PLUGIN_DATA_SUBDIR}/${alias}/${PLUGIN_STATE_SUBDIR}`, {
      hostPath: stateDir,
      target: CONTAINER_PLUGIN_STATE_DIR,
    }));
  } catch (err) {
    console.warn(`[plugins] could not prepare ${stateDir}:`, message(err));
  }
  const settingsPath = pluginSettingsPath(opts.sessionDir, alias);
  if (fs.existsSync(settingsPath)) {
    mounts.push(sessionMount(volume, `${PLUGIN_DATA_SUBDIR}/${alias}/${PLUGIN_SETTINGS_FILE}`, {
      hostPath: settingsPath,
      target: CONTAINER_PLUGIN_SETTINGS_FILE,
      readOnly: true,
    }));
  }
  return mounts;
}

/**
 * Mount something under the session root: through the workspace volume when the
 * orchestrator runs containerized, and as an ordinary bind in dev, where the
 * daemon and this process see the same filesystem.
 */
function sessionMount(
  volume: SessionVolume | undefined,
  relative: string,
  spec: { hostPath: string; target: string; readOnly?: boolean },
): Record<string, unknown> {
  if (volume) {
    return {
      type: "volume",
      source: WORKSPACE_VOLUME_ALIAS,
      target: spec.target,
      volume: { subpath: joinPosix(volume.sessionSubpath, relative) },
      ...(spec.readOnly ? { read_only: true } : {}),
    };
  }
  return {
    type: "bind",
    source: spec.hostPath,
    target: spec.target,
    ...(spec.readOnly ? { read_only: true } : {}),
  };
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
  // docs/266-plugin-service-ports reqs 3, 8 — the consuming project's number, told to the process
  // that has to bind it. Only when there is one: a service the project named no
  // port for is not previewable, and an unset variable is how it tells that
  // apart from "serve here".
  if (fragment.port !== undefined) env[PLUGIN_PORT_ENV] = String(fragment.port);
  return env;
}

/** A short digest of the settings file's content — see `settingsFingerprint`. */
function fingerprintSettings(alias: string, opts: PluginMountOptions): string | undefined {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(pluginSettingsPath(opts.sessionDir, alias)))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined; // no settings file — nothing to notice a change in
  }
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
      out[key] = describe(value);
    }
  }
  return out;
}

/**
 * Project a surfaced plugin service into the shape the override generator
 * consumes, so a plugin service picks up every ShipIt policy a project service
 * gets — labels, the session network, `cap_drop`, the contained-egress overlay,
 * the session-worker uid — from ONE implementation (req 16's lifecycle parity).
 *
 * `dependsOnInstall` follows the tree the service's own code runs out of, and
 * the two answers are opposite.
 *
 * The install gate exists for services that read the consuming project's
 * `node_modules` while `agent.install` is writing them (docs/137). A TRACKED
 * plugin's dependencies are its own, installed into its own layer before its
 * generation was published (plan §1b), so gating it on the project's install
 * would hold it for something it never reads — `false`.
 *
 * Under `repo: self` that reasoning inverts, because every premise it rests on
 * is absent: there is no generation, no writable layer and no `install` at all
 * (req 27). The plugin's dependencies ARE the project's `node_modules` — the
 * very thing the tracked case assumes it never reads — so its service is
 * exactly what docs/137 describes and takes the gate. Without it the service can
 * start against a tree `agent.install` is still writing, which is the same
 * empty-`node_modules` failure by a different route (nikzlabs/shipit#2298).
 */
export function toComposeService(svc: PluginComposeService): ComposeService {
  const declaredUser = svc.definition.user;
  return {
    ...(svc.settingsFingerprint ? { settingsFingerprint: svc.settingsFingerprint } : {}),
    name: svc.name,
    origin: {
      kind: "plugin",
      repo: svc.repo,
      alias: svc.alias,
      plugin: svc.plugin,
      sourceName: svc.sourceName,
      self: svc.self,
    },
    pluginDefinition: svc.definition,
    externalVolumes: svc.externalVolumes,
    shipitPreview: svc.preview,
    dependsOnInstall: svc.self,
    // Read back off the definition so the generator does not inject the session
    // worker uid over a `user:` the fragment declared. docs/271 — a contained
    // session no longer REQUIRES that declaration (github#2374: the uid a service
    // needs is the session's own, which a project may not name), so the common
    // case is `undefined` and the generator fills the identity in. This branch is
    // what keeps a deliberate declaration deliberate; it is no longer describing
    // the path most fragments take.
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

/**
 * Render an arbitrary YAML value for a message or an environment entry. Objects
 * and arrays are JSON, never `[object Object]` — a message that cannot name what
 * it rejected is not a message the plugin's author can act on.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
