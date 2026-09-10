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

export interface PluginFragmentService {
  name: string;
  sourceName: string;
  alias: string;
  repo: string;
  plugin: string;
  preview: "auto" | "manual";
  port?: number;
  // Validated definition; relative mounts still need resolution against the fragment directory.
  definition: Record<string, unknown>;
  fragmentDir: string;
  credentials: readonly string[];
  self: boolean;
  commit?: string;
  // Distinguishes builds of the same commit when naming layers and volumes.
  generationId?: string;
  checkoutDir: string;
}

export interface PluginFragmentResolution {
  services: PluginFragmentService[];
  issuesByRepo: Map<string, string[]>;
}

export interface CollectPluginFragmentsOptions {
  workspaceDir: string;
  live: LiveGenerations;
  plugins: PluginReposConfig;
  selfExports: readonly PluginExport[];
  projectServiceNames: readonly string[];
  containEgress: boolean;
}

class PluginFragmentError extends Error {}

const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Reject unknown keys so new Compose features cannot bypass plugin validation.
export const ALLOWED_SERVICE_KEYS: ReadonlySet<string> = new Set([
  "image", "command", "entrypoint", "working_dir", "environment", "volumes",
  "expose", "depends_on", "healthcheck", "init", "read_only", "tmpfs",
  "user", "stop_grace_period", "stop_signal", "shm_size", "mem_limit",
  "mem_reservation", "cpus", "pids_limit", "ulimits",
  "x-shipit-preview",
]);

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["services", "name", "version"]);
const SHIPIT_EXTENSION_KEYS: ReadonlySet<string> = new Set(["x-shipit-preview"]);

export function collectPluginFragments(
  opts: CollectPluginFragmentsOptions,
): PluginFragmentResolution {
  const services: PluginFragmentService[] = [];
  const issuesByRepo = new Map<string, string[]>();
  const addIssue = (repo: string, issue: string): void => {
    issuesByRepo.set(repo, [...(issuesByRepo.get(repo) ?? []), issue]);
  };

  // One snapshot keeps manifests, commits, and mounted trees on the same generation.
  const snapshots = new Map<string, RepoSnapshot>();
  for (const repo of opts.plugins.repos) {
    snapshots.set(repo.name.toLowerCase(), snapshotRepo(repo, opts));
  }
  const claimed = new Map<string, string>();
  for (const name of opts.projectServiceNames) claimed.set(name.toLowerCase(), "this project");
  // ServiceManager checks project-port conflicts against the actual running-stack parse.
  const claimedPorts = new Map<number, string>();

  for (const use of opts.plugins.uses) {
    const snapshot = snapshots.get(use.from.toLowerCase());
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
        credentials: [...new Set(exported.credentials.map((c) => c.name))],
        self: snapshot.self,
        checkoutDir: snapshot.root,
        ...(snapshot.commit ? { commit: snapshot.commit } : {}),
        ...(snapshot.generationId ? { generationId: snapshot.generationId } : {}),
      });
    }
  }

  // Services activate per repository: withhold the whole stack if any import is invalid.
  return {
    services: services.filter((s) => !issuesByRepo.has(s.repo)),
    issuesByRepo,
  };
}

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

function resolvePreview(
  source: ParsedFragmentService,
  use: PluginUse,
  port: number | undefined,
): "auto" | "manual" {
  const override = use.overrides.services[source.name]?.autostart;
  if (override !== undefined) return override ? "auto" : "manual";
  if (source.preview !== undefined) return source.preview;
  return port !== undefined ? "auto" : "manual";
}

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

interface RepoSnapshot {
  name: string;
  root: string | null;
  self: boolean;
  exports: readonly PluginExport[];
  commit?: string;
  generationId?: string;
}

function snapshotRepo(
  repo: DeclaredPluginRepo,
  opts: CollectPluginFragmentsOptions,
): RepoSnapshot {
  if (repo.source.kind === "self") {
    return { name: repo.name, root: opts.workspaceDir, self: true, exports: opts.selfExports };
  }
  const verified = opts.live(repo);
  if (!verified) {
    return { name: repo.name, root: null, self: false, exports: [] };
  }
  return {
    name: repo.name,
    root: verified.dir,
    self: false,
    exports: readGenerationManifestAt(verified.dir),
    commit: verified.record.commit,
    generationId: generationIdFor(verified.dir, verified.record),
  };
}

interface ParsedFragmentService {
  name: string;
  preview?: "auto" | "manual";
  definition: Record<string, unknown>;
}

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

  // Refuse tags that YAML validation and Compose might interpret differently.
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
    // Emit resolved merge keys so Compose receives exactly what was validated.
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

  // External dependencies could invalidate or impose ordering on the project's own stack.
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

  // These literals become YAML tags in the generator's final text-replacement pass.
  for (const sentinel of OVERRIDE_SENTINELS) {
    if (JSON.stringify(svc).includes(sentinel)) {
      throw new PluginFragmentError(
        `its compose service \`${name}\` contains \`${sentinel}\`, which is reserved by ShipIt.`,
      );
    }
  }

  // A project's Docker socket grant never extends to imported plugins.
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

function validateFragmentVolumes(name: string, raw: unknown): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new PluginFragmentError(`its compose service \`${name}\`: \`volumes\` must be a list.`);
  }
  for (const entry of raw) {
    if (typeof entry === "string") {
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

// Shape check only; validateServiceSecurity rejects traversal beyond the plugin tree.
function requireRelativeSource(name: string, source: string): void {
  if (source === "." || source === "./" || source.startsWith("./")) return;
  throw new PluginFragmentError(
    `its compose service \`${name}\`: \`${source}\` is not a path inside the plugin. A plugin may `
    + "mount its own files (`./…`) and anonymous volumes; named volumes and host paths are not "
    + "available, and session-scoped state belongs in `/plugin-state`.",
  );
}

// Bare list entries would inherit the orchestrator's environment.
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

export interface PluginComposeService {
  name: string;
  sourceName: string;
  alias: string;
  repo: string;
  plugin: string;
  preview: "auto" | "manual";
  port?: number;
  definition: Record<string, unknown>;
  credentials: readonly string[];
  externalVolumes: string[];
  self: boolean;
  // Atomic settings writes replace the inode. This label forces Compose to remount the file.
  settingsFingerprint?: string;
}

export interface PluginMountOptions {
  sessionDir: string;
  sessionSubpath?: string;
  workspaceDir: string;
  workspaceVolume?: string;
  workspaceSubpath?: string;
  pluginVolumes: ReadonlyMap<string, string>;
}

const WORKSPACE_VOLUME_ALIAS = "shipit-workspace";

interface SessionVolume {
  workspaceSubpath: string;
  sessionSubpath: string;
}

function sessionVolume(opts: PluginMountOptions): SessionVolume | undefined {
  if (!opts.workspaceVolume || !opts.workspaceSubpath || !opts.sessionSubpath) return undefined;
  return { workspaceSubpath: opts.workspaceSubpath, sessionSubpath: opts.sessionSubpath };
}

export function buildPluginComposeServices(
  fragments: readonly PluginFragmentService[],
  opts: PluginMountOptions,
): { services: PluginComposeService[]; issuesByRepo: Map<string, string[]> } {
  const services: PluginComposeService[] = [];
  const issuesByRepo = new Map<string, string[]>();
  const addIssue = (repo: string, issue: string): void => {
    const existing = issuesByRepo.get(repo) ?? [];
    if (existing.includes(issue)) return;
    issuesByRepo.set(repo, [...existing, issue]);
  };

  // Never fall back to binds or the whole volume when session subpaths are unavailable.
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
      // Escape last: Compose must not interpolate the orchestrator's environment.
      definition: escapeDollars(definition) as Record<string, unknown>,
      externalVolumes,
      self: fragment.self,
      ...(settingsFingerprint ? { settingsFingerprint } : {}),
    });
  }

  return { services, issuesByRepo };
}

// Resolve relative mounts from the fragment directory, not the consuming project's directory.
// Every alias of a tracked generation must be read-only, as /plugin is.
function rewriteFragmentVolume(
  entry: unknown,
  fragment: PluginFragmentService,
  opts: PluginMountOptions,
  volumeName: string | undefined,
  volume: SessionVolume | undefined,
): unknown {
  const parsed = readVolumeEntry(entry);
  if (!parsed) return entry;
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

function pluginTreeMount(
  opts: PluginMountOptions,
  volumeName: string | undefined,
  volume: SessionVolume | undefined,
): Record<string, unknown> {
  if (volumeName) {
    return { type: "volume", source: volumeName, target: CONTAINER_PLUGIN_DIR, read_only: true };
  }
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

function pluginDataMounts(
  alias: string,
  opts: PluginMountOptions,
  volume: SessionVolume | undefined,
): Record<string, unknown>[] {
  const mounts: Record<string, unknown>[] = [];
  const stateDir = pluginStateDir(opts.sessionDir, alias);
  try {
    // Pre-create with worker ownership; Docker would otherwise create a root-owned directory.
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
  if (fragment.port !== undefined) env[PLUGIN_PORT_ENV] = String(fragment.port);
  return env;
}

function fingerprintSettings(alias: string, opts: PluginMountOptions): string | undefined {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(pluginSettingsPath(opts.sessionDir, alias)))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined;
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

function normalizeEnvironment(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const index = entry.indexOf("=");
      if (index <= 0) continue;
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
    // Self imports read project dependencies; tracked generations already have their own.
    dependsOnInstall: svc.self,
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

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
