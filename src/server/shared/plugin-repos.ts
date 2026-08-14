/**
 * docs/262 — plugin repositories: the consumer `plugins:` block and the
 * plugin-side `exports.plugins:` manifest (plan §1a/§1b), plus the browser
 * snapshot types behind `GET /api/plugin-repos`.
 *
 * Filesystem-free on purpose (the `declared-tracker.ts` precedent): the client
 * imports the types, so nothing here may pull in `node:fs`. The parser is pure
 * — `shipit-config.ts` feeds it the raw YAML value and the declared trackers.
 *
 * Parsing is **phase 1** of the three validation phases (plan §1a): grammar,
 * the repo-name/tracker-name reservation pass, alias uniqueness, and reference
 * shape — everything knowable without a network. Selector validation against a
 * *fetched* manifest is phase 2; service/command collisions are phase 3. Like
 * the trackers block, **nothing here is fatal** (req 13): every malformed
 * entry warns and is dropped, and the session still opens.
 */

import { parseOwnerRepo } from "./tracker-id.js";
import type { DeclaredTracker } from "./declared-tracker.js";
import { PLUGIN_CONTRACT_ENV_NAMES } from "./plugin-contract.js";
import type { PluginCredentialGroup, PluginCredentialNeed } from "./plugin-credentials.js";
import type { PluginHostGroup, PluginHostNeed } from "./plugin-hosts.js";

// ---------------------------------------------------------------------------
// Config types (what shipit.yaml declares)
// ---------------------------------------------------------------------------

/** Where a declared plugin repo's content comes from. */
export type PluginRepoSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "self" };

/** One `plugins.repos` entry (plan §1a): one checkout, one card, one refresh unit. */
export interface DeclaredPluginRepo {
  /** The reservation-domain name: checkout path, card, refresh target, feedback destination. */
  name: string;
  source: PluginRepoSource;
  /** Tracked branch; mutually exclusive with `pin`; never present for `self`. */
  branch?: string;
  /** Tag or SHA; mutually exclusive with `branch`; never present for `self`. */
  pin?: string;
}

/** Per-service consumer override (req 16, req 20). */
export interface PluginServiceOverride {
  autostart?: boolean;
  /** Service alias on collision. */
  as?: string;
}

/** Consumer overrides on one `use` entry — flat: the entry IS one plugin. */
export interface PluginUseOverrides {
  services: Record<string, PluginServiceOverride>;
  commands: Record<string, { as?: string }>;
  /** req 26 — values for plugin-declared settings. Scalars only. */
  settings: Record<string, string | number | boolean>;
}

/** One `plugins.use` entry: activates one exported plugin from a declared repo. */
export interface PluginUse {
  /** Selector: the exported plugin to activate (validated against the manifest in phase 2). */
  plugin: string;
  /** References a declared repo by name. */
  from: string;
  /** Local name; defaults to `plugin`. Keys overrides/settings/skills namespacing and UI. */
  alias: string;
  overrides: PluginUseOverrides;
}

/** The parsed consumer block. `declared` is plugin INTENT — the key existing at
 * all — which is what gates the Plugins tab (req 13: an invalid declaration
 * must not erase its own warning surface). */
export interface PluginReposConfig {
  declared: boolean;
  repos: DeclaredPluginRepo[];
  uses: PluginUse[];
}

/** One exported plugin from the manifest (plan §1b). All fields optional —
 * a CLI-only or files-only export is valid. */
export interface PluginExport {
  name: string;
  /** Compose fragment path, relative to the repo root. */
  compose?: string;
  /** Command name → entrypoint path (repo-root-relative). */
  cli: Record<string, string>;
  /** Skills directory, relative to the repo root. */
  skills?: string;
  install?: string;
  /** Files whose content re-triggers install (same convention as agent.install-inputs). */
  installInputs: string[];
  /**
   * Directories `install` populates, relative to the repository root — the
   * plugin half of `agent.dep-dirs` (docs/183), and what req 28 means by "a
   * plugin's declared dependency directories". Each one is eligible for the
   * shared dependency store: ShipIt promotes it out of the generation's
   * writable layer into a base keyed by this repository, the runtime, and the
   * content of the install's inputs, so the next commit — and every other
   * session — mounts it instead of installing again.
   *
   * Defaults to `[node_modules]` for the same reason `agent.dep-dirs` does: the
   * common npm plugin is then zero-config. A declared directory that does not
   * exist after install simply contributes nothing.
   */
  depDirs: string[];
  /** Credential NAMES only — values live with each consuming project (req 23). */
  credentials: string[];
  /** Informational; grants nothing (req 24). */
  hosts: string[];
  /** Declared settings + defaults (req 26). */
  settings: Record<string, { description?: string; default?: string | number | boolean }>;
}

export const EMPTY_PLUGIN_REPOS: Readonly<PluginReposConfig> = Object.freeze({
  declared: false,
  repos: [],
  uses: [],
});

// ---------------------------------------------------------------------------
// Snapshot types (what GET /api/plugin-repos returns)
// ---------------------------------------------------------------------------

/** One `use` entry as the card shows it. `found` is three-valued: resolved
 * against a manifest (self repos — theirs is in the same file), missing from
 * that manifest, or `null` = not knowable until the repo is fetched. */
export interface PluginRepoUseView {
  plugin: string;
  alias: string;
  found: boolean | null;
  /**
   * req 23 — the credential names this plugin declares, each resolved against
   * the CONSUMING project's own secret store. Grouped under the plugin that
   * declares them (not flattened onto the card) so an unsatisfied name reads
   * as "`artk` needs `FAL_KEY`" rather than as an anonymous missing key.
   * Empty when the plugin declares none, and when the repository has no live
   * manifest to read — "not knowable" is never reported as "needs nothing".
   */
  credentials: PluginCredentialNeed[];
  /**
   * req 24 — the external hosts this plugin declares, each resolved against
   * the session's own egress allowlist. Grouped under the declaring plugin for
   * the reason `credentials` is: req 24 asks for "the same visibility req 23
   * gives credentials", and a flat list cannot name the claimant.
   *
   * A `false` here is a gap the user may close deliberately, never one the
   * declaration closed by itself — the declaration grants nothing.
   */
  hosts: PluginHostNeed[];
}

/**
 * One card in the Plugins tab:
 * - `"self"` — the live working tree (req 27); no ref/commit by design.
 * - `"active"` — a generation is live; `commit` is its exact SHA (req 15).
 * - `"activating"` — staging/installing right now.
 * - `"degraded"` — the latest attempt failed but a prior generation is still
 *   live and whole; `commit` is that prior one (req 15).
 * - `"unavailable"` — nothing was ever activated for this repository (req 13).
 */
export type PluginRepoStatus = "self" | "active" | "activating" | "degraded" | "unavailable";

export interface PluginRepoCardView {
  name: string;
  /** `"self"` or `"owner/repo"` — always visible on the card (req 19). */
  source: string;
  /**
   * The ref of what is **being executed**, paired with {@link commit} from the
   * same generation record; the declared ref only when nothing is live, where
   * there is nothing else to name. Null for self.
   *
   * req 19 says ShipIt visibly identifies "the repository, ref, and exact
   * commit **being executed**", and `ref` used to come from the declaration
   * while `commit` came from the live generation — so a declaration edited
   * since the last successful round rendered as `active` at the NEW ref and
   * the OLD commit, a pair no round ever produced (seen in the dogfood
   * instance, where a round needs an attached runner and an edit made with
   * none never settles). A ref that has produced no generation is not being
   * executed; the gap between what is declared and what runs belongs in the
   * `activating` / `degraded` framing that exists for it, and — when neither
   * applies — in an issue row saying so.
   */
  ref: string | null;
  /** The live generation's exact commit; null for self and when nothing is live. */
  commit: string | null;
  status: PluginRepoStatus;
  uses: PluginRepoUseView[];
  /** Problems attached to this repo (a failed activation, a missing selector). */
  issues: string[];
}

/**
 * What the orchestrator knows about a tracked repository beyond its
 * declaration. Passed into {@link buildPluginReposSnapshot} so the projection
 * stays pure and testable — the route reads the live generation off disk.
 */
export interface PluginRepoRuntime {
  activating?: boolean;
  commit?: string;
  /**
   * The ref the live generation RECORDED when it was built ({@link
   * declaredRefLabel}'s spelling) — what is being executed, as opposed to what
   * the declaration says now. Present exactly when {@link commit} is.
   */
  ref?: string;
  /** Exported plugin names in the live generation's manifest (phase-2 input). */
  exports?: string[];
  error?: string;
  /** Advisory — a moved tag the durable pin overrode (req 8). */
  warning?: string;
  /** Warnings from parsing the live generation's manifest (req 13 — degrade *visibly*). */
  manifestWarnings?: string[];
  /**
   * Selected exports the failed attempt's version does not have — `error`
   * already names them. Present only when a phase-2 selector check is what
   * failed, so the card can state that fact once (see the issue projection).
   */
  missingSelectors?: string[];
  /**
   * Settings this repository's imports declare that cannot be resolved against
   * the live manifest (req 26 — an undeclared name, a type that disagrees with
   * the plugin's default). Each names its `alias`, because the card's unit is
   * the repository while a settings problem belongs to one import.
   */
  settingsIssues?: string[];
  /**
   * Companion-CLI commands this repository's imports could not surface (req 20
   * — a name claimed twice, a reserved name, a name already on the agent's
   * PATH). Each names its `alias` and the `overrides.commands.<x>.as` that
   * resolves it, because the card's unit is the repository while a command
   * belongs to one import.
   */
  commandIssues?: string[];
  /**
   * Problems with this repository's plugin SERVICES (reqs 3, 20): a compose
   * fragment that cannot be used, a surfaced service name that collides with
   * the project's or another plugin's, a plugin whose runtime layer could not
   * be prepared. Each names its `alias`, for the same reason `settingsIssues`
   * does — the card's unit is the repository while the problem belongs to one
   * import.
   */
  serviceIssues?: string[];
}

export interface PluginReposSnapshot {
  /** Plugin intent — gates the tab. */
  declared: boolean;
  /**
   * At least one repository is mid-activation. Activation is fire-and-forget
   * server-side, so nothing pushes its completion; the client re-fetches while
   * this is true rather than leaving the card stuck on "activating" until the
   * next shipit.yaml event (review finding).
   */
  activating: boolean;
  /**
   * The answer is *not yet knowable*: the session's checkout is evicted or
   * mid-restore, so "declares nothing" must not be cached — the client
   * retries instead (the `declarationsPending` precedent, plan §3).
   */
  pending: boolean;
  /** The consuming project's remote — the secret store "Add key…" must write to (plan §3). */
  consumerRepoUrl: string | null;
  repos: PluginRepoCardView[];
  /** Parse-level warnings (dropped entries, unknown keys). Count toward the warn dot. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parsing — consumer side
// ---------------------------------------------------------------------------

/** Same charset as tracker names: the shared reservation domain (plan §1a
 * phase 1) needs one rule, and aliases feed the `plugins--<alias>--<skill>`
 * namespace, so whitespace/`#`/`/` are out for both. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const KNOWN_REPO_KEYS = new Set(["repo", "name", "branch", "pin"]);
const KNOWN_USE_KEYS = new Set(["plugin", "from", "alias", "overrides"]);
const KNOWN_OVERRIDE_KEYS = new Set(["services", "commands", "settings"]);
const KNOWN_SERVICE_OVERRIDE_KEYS = new Set(["autostart", "as"]);
const KNOWN_COMMAND_OVERRIDE_KEYS = new Set(["as"]);

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Parse the consumer `plugins:` block. **Call only when the `plugins` key
 * exists in the document** (shipit-config gates on `"plugins" in raw`): an
 * empty or null value — bare `plugins:` in YAML parses to null — is still
 * plugin INTENT and must keep its tab (req 13, review finding), so presence
 * is the caller's signal and every value, including null, declares.
 *
 * `trackers` feeds the cross-block name reservation: tracker names are
 * reserved first (they parse first), and a repo name colliding with one is
 * dropped — UNLESS the repo's GitHub destination is the same repository the
 * tracker already points at, which is the sanctioned alias case (plan §1a:
 * one destination, two names, one adapter).
 */
export function parsePluginRepos(
  raw: unknown,
  trackers: readonly DeclaredTracker[],
  warnings: string[],
): PluginReposConfig {
  if (raw === undefined || raw === null) return { declared: true, repos: [], uses: [] };

  if (!isMapping(raw)) {
    warnings.push("`plugins` must be a mapping (object); ignoring it.");
    // The key exists, so intent is declared — the tab must show the warning.
    return { declared: true, repos: [], uses: [] };
  }

  for (const key of Object.keys(raw)) {
    if (key !== "repos" && key !== "use") {
      warnings.push(`Unknown key \`plugins.${key}\` in shipit.yaml.`);
    }
  }

  const repos = parseRepoList(raw.repos, trackers, warnings);
  const uses = parseUseList(raw.use, repos, warnings);
  return { declared: true, repos, uses };
}

function parseRepoList(
  raw: unknown,
  trackers: readonly DeclaredTracker[],
  warnings: string[],
): DeclaredPluginRepo[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`plugins.repos` must be a list; ignoring it.");
    return [];
  }

  const trackerNames = new Map<string, DeclaredTracker>(
    trackers.map((t) => [t.name.toLowerCase(), t]),
  );
  const seenNames = new Set<string>();
  const seenDestinations = new Map<string, string>();
  const repos: DeclaredPluginRepo[] = [];

  for (let i = 0; i < raw.length; i++) {
    const repo = parseRepoEntry(raw[i], i, warnings);
    if (!repo) continue;

    const nameKey = repo.name.toLowerCase();
    // Reservation pass, cross-block half: trackers parse first, so on a name
    // collision the tracker wins — except when the plugin repo IS the
    // tracker's repository, where one destination legitimately carries both
    // roles under one name.
    const tracker = trackerNames.get(nameKey);
    if (tracker && !sameDestination(repo.source, tracker)) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: \`${repo.name}\` is already a declared tracker name — repo and tracker names share one namespace (first declared wins).`,
      );
      continue;
    }
    if (seenNames.has(nameKey)) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: duplicate repo name \`${repo.name}\`.`,
      );
      continue;
    }
    const destKey = destinationKey(repo.source);
    const claimedBy = seenDestinations.get(destKey);
    if (claimedBy) {
      warnings.push(
        `Ignoring \`plugins.repos[${i}]\`: \`${destKey}\` is already declared as \`${claimedBy}\` — a repository may only be declared once.`,
      );
      continue;
    }
    seenNames.add(nameKey);
    seenDestinations.set(destKey, repo.name);
    repos.push(repo);
  }
  return repos;
}

/**
 * The canonical identity of what a declaration POINTS AT — `owner/repo`
 * lowercased, or `self`. Distinct from the declaration's `name`, which is only
 * what the consumer calls it and can be re-pointed at a different repository.
 *
 * Exported because a generation records it (`plugin-generations.ts`): a
 * generation keyed by name alone would let a re-pointed declaration pair a new
 * repository with the previous one's commit. The session container compares
 * against it too, before exposing a checkout it did not publish
 * (`session/plugin-runtime.ts`) — which is why this lives in `shared/` and not
 * beside the generation engine.
 */
export function destinationKey(source: PluginRepoSource): string {
  return source.kind === "self" ? "self" : `${source.owner}/${source.repo}`.toLowerCase();
}

/**
 * The URL a declared plugin repository is cloned from. Case-preserving, because
 * every cache keyed on it (`repo-cache/<hash>`, docs/075's `dep-cache/<hash>`)
 * hashes the URL byte-for-byte — the lowercased {@link destinationKey} is the
 * IDENTITY of a repository and not a substitute for it here.
 *
 * Lives beside `destinationKey` so the activation path and the disk janitor
 * cannot derive two different answers: the janitor's whole job is to recognize
 * the very directories activation created (req 28).
 */
export function pluginCloneUrl(source: PluginRepoSource): string {
  if (source.kind === "self") throw new Error("self repos have no clone URL");
  return `https://github.com/${source.owner}/${source.repo}.git`;
}

/**
 * How a declared version is written wherever a human reads it: the generation
 * record (`plugin-generations.ts`), the refresh rows the agent's `shipit plugin
 * refresh` prints, the preflight verdict, and the Plugins card.
 *
 * One formatter because the card **compares** two of those (plan §3): the ref a
 * generation recorded when it was built against the ref the declaration names
 * now. Two spellings of "the default branch" would make every default-branch
 * repository look re-pointed. Never called for a `repo: self` declaration —
 * a live working tree has no version to state (req 27).
 */
export function declaredRefLabel(repo: Pick<DeclaredPluginRepo, "branch" | "pin">): string {
  return repo.pin ? `pin ${repo.pin}` : `branch ${repo.branch ?? "(default)"}`;
}

function sameDestination(source: PluginRepoSource, tracker: DeclaredTracker): boolean {
  return (
    source.kind === "github" &&
    tracker.kind === "github" &&
    source.owner.toLowerCase() === tracker.owner.toLowerCase() &&
    source.repo.toLowerCase() === tracker.repo.toLowerCase()
  );
}

function parseRepoEntry(entry: unknown, index: number, warnings: string[]): DeclaredPluginRepo | null {
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`plugins.repos[${index}]\`: ${reason}.`);
    return null;
  };

  if (!isMapping(entry)) return drop("each entry must be a mapping with `repo:` and `name:`");

  for (const key of Object.keys(entry)) {
    if (!KNOWN_REPO_KEYS.has(key)) {
      warnings.push(`Unknown key \`plugins.repos[${index}].${key}\` in shipit.yaml.`);
    }
  }

  const rawRepo = entry.repo;
  if (typeof rawRepo !== "string" || !rawRepo.trim()) {
    return drop("each entry needs `repo: owner/name` (or `repo: self`)");
  }
  const repoStr = rawRepo.trim();

  const rawName = entry.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    return drop("each entry needs a `name:` — it is the checkout path, card, and refresh target");
  }
  const name = rawName.trim();
  if (!PLUGIN_NAME_RE.test(name)) {
    return drop(`\`name: ${name}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
  }

  const branch = optionalTrimmedString(entry.branch, `plugins.repos[${index}].branch`, warnings);
  const pin = optionalTrimmedString(entry.pin, `plugins.repos[${index}].pin`, warnings);
  if (branch === false || pin === false) return null;
  if (branch && pin) return drop("`branch` and `pin` are mutually exclusive (req 8)");

  if (repoStr.toLowerCase() === "self") {
    // req 27 — the session's own working tree: live, no version to track.
    if (branch || pin) return drop("`repo: self` takes no `branch`/`pin` — the live working tree has no tracked version");
    return { name, source: { kind: "self" } };
  }

  const ref = parseOwnerRepo(repoStr);
  if (!ref) {
    return drop(`\`repo: ${repoStr}\` must be an \`owner/name\` slug or \`self\` (GitHub-only in v1)`);
  }
  return {
    name,
    source: { kind: "github", owner: ref.owner, repo: ref.repo },
    ...(branch ? { branch } : {}),
    ...(pin ? { pin } : {}),
  };
}

/** A tri-state string field: undefined (absent), the trimmed value, or `false`
 * meaning "present but unusable" — the entry is dropped so a typo'd pin can't
 * silently become "track the default branch". */
function optionalTrimmedString(
  raw: unknown,
  label: string,
  warnings: string[],
): string | undefined | false {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    warnings.push(`Ignoring the entry: \`${label}\` must be a non-empty string.`);
    return false;
  }
  return raw.trim();
}

function parseUseList(
  raw: unknown,
  repos: readonly DeclaredPluginRepo[],
  warnings: string[],
): PluginUse[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("`plugins.use` must be a list; ignoring it.");
    return [];
  }

  const repoNames = new Set(repos.map((r) => r.name.toLowerCase()));
  const seenAliases = new Set<string>();
  const uses: PluginUse[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const drop = (reason: string): void => {
      warnings.push(`Ignoring \`plugins.use[${i}]\`: ${reason}.`);
    };

    if (!isMapping(entry)) {
      drop("each entry must be a mapping with `plugin:` and `from:`");
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!KNOWN_USE_KEYS.has(key)) {
        warnings.push(`Unknown key \`plugins.use[${i}].${key}\` in shipit.yaml.`);
      }
    }

    const plugin = typeof entry.plugin === "string" ? entry.plugin.trim() : "";
    if (!plugin || !PLUGIN_NAME_RE.test(plugin)) {
      drop("each entry needs `plugin:` — the exported plugin to activate");
      continue;
    }
    const from = typeof entry.from === "string" ? entry.from.trim() : "";
    if (!from) {
      drop("each entry needs `from:` — a declared repo name");
      continue;
    }
    if (!repoNames.has(from.toLowerCase())) {
      drop(`\`from: ${from}\` names no declared repo`);
      continue;
    }

    let alias = plugin;
    if (entry.alias !== undefined && entry.alias !== null) {
      if (typeof entry.alias !== "string" || !PLUGIN_NAME_RE.test(entry.alias.trim())) {
        drop("`alias` must be letters, digits, `.`, `_` or `-`");
        continue;
      }
      alias = entry.alias.trim();
    }
    // Domain 2 of the naming phases: aliases are unique across ALL use
    // entries — the alias keys settings, skills namespacing, and the UI.
    const aliasKey = alias.toLowerCase();
    if (seenAliases.has(aliasKey)) {
      drop(`duplicate plugin alias \`${alias}\``);
      continue;
    }

    const overrides = parseOverrides(entry.overrides, i, warnings);
    if (!overrides) continue;

    seenAliases.add(aliasKey);
    uses.push({ plugin, from, alias, overrides });
  }
  return uses;
}

/**
 * Overrides are **fail-closed at the use-entry level** (review finding): a
 * malformed override field must drop the whole `use` entry, never degrade
 * into different executable semantics — `autostart: "false"` silently
 * becoming "no override" would START a service the declaration asked to keep
 * off. Returns null (with one warning naming the field) on any invalid piece.
 */
function parseOverrides(
  raw: unknown,
  useIndex: number,
  warnings: string[],
): PluginUseOverrides | null {
  const empty: PluginUseOverrides = { services: {}, commands: {}, settings: {} };
  if (raw === undefined || raw === null) return empty;

  const fail = (field: string, reason: string): null => {
    warnings.push(`Ignoring \`plugins.use[${useIndex}]\`: \`${field}\` ${reason}.`);
    return null;
  };

  if (!isMapping(raw)) return fail("overrides", "must be a mapping");

  for (const key of Object.keys(raw)) {
    if (!KNOWN_OVERRIDE_KEYS.has(key)) {
      warnings.push(`Unknown key \`plugins.use[${useIndex}].overrides.${key}\` in shipit.yaml.`);
    }
  }

  const services: Record<string, PluginServiceOverride> = {};
  if (raw.services !== undefined && raw.services !== null) {
    if (!isMapping(raw.services)) return fail("overrides.services", "must be a mapping keyed by service name");
    for (const [svc, val] of Object.entries(raw.services)) {
      const field = `overrides.services.${svc}`;
      if (!isMapping(val)) return fail(field, "must be a mapping");
      for (const key of Object.keys(val)) {
        if (!KNOWN_SERVICE_OVERRIDE_KEYS.has(key)) {
          warnings.push(`Unknown key \`plugins.use[${useIndex}].${field}.${key}\` in shipit.yaml.`);
        }
      }
      const out: PluginServiceOverride = {};
      if (val.autostart !== undefined && val.autostart !== null) {
        if (typeof val.autostart !== "boolean") return fail(`${field}.autostart`, "must be true or false");
        out.autostart = val.autostart;
      }
      if (val.as !== undefined && val.as !== null) {
        const as = parseAlias(val.as);
        if (!as) return fail(`${field}.as`, "must be letters, digits, `.`, `_` or `-`");
        out.as = as;
      }
      services[svc] = out;
    }
  }

  const commands: Record<string, { as?: string }> = {};
  if (raw.commands !== undefined && raw.commands !== null) {
    if (!isMapping(raw.commands)) return fail("overrides.commands", "must be a mapping keyed by command name");
    for (const [cmd, val] of Object.entries(raw.commands)) {
      const field = `overrides.commands.${cmd}`;
      if (!isMapping(val)) return fail(field, "must be a mapping");
      for (const key of Object.keys(val)) {
        if (!KNOWN_COMMAND_OVERRIDE_KEYS.has(key)) {
          warnings.push(`Unknown key \`plugins.use[${useIndex}].${field}.${key}\` in shipit.yaml.`);
        }
      }
      const out: { as?: string } = {};
      if (val.as !== undefined && val.as !== null) {
        const as = parseAlias(val.as);
        if (!as) return fail(`${field}.as`, "must be letters, digits, `.`, `_` or `-`");
        out.as = as;
      }
      commands[cmd] = out;
    }
  }

  const settings: Record<string, string | number | boolean> = {};
  if (raw.settings !== undefined && raw.settings !== null) {
    if (!isMapping(raw.settings)) return fail("overrides.settings", "must be a mapping");
    for (const [name, val] of Object.entries(raw.settings)) {
      // Fail-closed grammar (plan §1a): setting values are scalars, and a
      // malformed value must not silently fall back to the plugin's default.
      if (!isScalar(val)) return fail(`overrides.settings.${name}`, "must be a scalar");
      settings[name] = val;
    }
  }

  return { services, commands, settings };
}

function parseAlias(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !PLUGIN_NAME_RE.test(raw.trim())) return undefined;
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Parsing — plugin side (the exports manifest)
// ---------------------------------------------------------------------------

const KNOWN_EXPORT_KEYS = new Set([
  "compose",
  "cli",
  "skills",
  "install",
  "install-inputs",
  "dep-dirs",
  "credentials",
  "hosts",
  "settings",
]);

/**
 * What `dep-dirs` means when an export does not say (req 28). The same literal
 * `agent.dep-dirs` defaults to (docs/183), duplicated rather than imported
 * because `shipit-config.ts` imports THIS module — and it is the module that is
 * allowed to touch `node:fs`, which this one deliberately is not.
 */
export const DEFAULT_PLUGIN_DEP_DIRS: readonly string[] = ["node_modules"];

/** Credential names are environment variable names (req 23). */
const CREDENTIAL_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** A hostname, no scheme, no path — `fal.run`, not `https://fal.run/x` (req 24). */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Parse the `exports:` block. Fail-closed **per plugin** (plan §1b): a plugin
 * entry with any invalid field is dropped whole, with a warning naming the
 * field — degraded beats partial (reqs 13, 14). Phase 2 turns that same rule
 * into "a failing selected export invalidates the repository's generation".
 */
export function parsePluginExports(raw: unknown, warnings: string[]): PluginExport[] {
  if (raw === undefined || raw === null) return [];
  if (!isMapping(raw)) {
    warnings.push("`exports` must be a mapping (object); ignoring it.");
    return [];
  }
  for (const key of Object.keys(raw)) {
    if (key !== "plugins") {
      warnings.push(`Unknown key \`exports.${key}\` in shipit.yaml.`);
    }
  }
  const rawPlugins = raw.plugins;
  if (rawPlugins === undefined || rawPlugins === null) return [];
  if (!isMapping(rawPlugins)) {
    warnings.push("`exports.plugins` must be a mapping keyed by plugin name; ignoring it.");
    return [];
  }

  const exportsList: PluginExport[] = [];
  for (const [name, entry] of Object.entries(rawPlugins)) {
    const parsed = parseExportEntry(name, entry, warnings);
    if (parsed) exportsList.push(parsed);
  }
  return exportsList;
}

function parseExportEntry(name: string, entry: unknown, warnings: string[]): PluginExport | null {
  // The message quotes the full `exports.plugins.<name>` key: the snapshot
  // projection keeps warnings by their quoted key prefix, and the drop reason
  // must reach the tab — a self-declared consumer of this export otherwise
  // sees only "not in manifest" with the real cause filtered away (review
  // finding).
  const drop = (reason: string): null => {
    warnings.push(`Ignoring \`exports.plugins.${name}\`: ${reason}.`);
    return null;
  };

  if (!PLUGIN_NAME_RE.test(name)) {
    return drop("plugin names must be letters, digits, `.`, `_` or `-`");
  }
  if (!isMapping(entry)) return drop("each plugin must be a mapping");

  for (const key of Object.keys(entry)) {
    if (!KNOWN_EXPORT_KEYS.has(key)) {
      warnings.push(`Unknown key \`exports.plugins.${name}.${key}\` in shipit.yaml.`);
    }
  }

  const compose = optionalRelPath(entry.compose, `exports.plugins.${name}.compose`);
  const skills = optionalRelPath(entry.skills, `exports.plugins.${name}.skills`);
  if (typeof compose === "object") return drop(compose.error);
  if (typeof skills === "object") return drop(skills.error);

  let install: string | undefined;
  if (entry.install !== undefined && entry.install !== null) {
    if (typeof entry.install !== "string" || !entry.install.trim()) {
      return drop("`install` must be a non-empty string");
    }
    install = entry.install.trim();
  }

  const cli: Record<string, string> = {};
  if (entry.cli !== undefined && entry.cli !== null) {
    if (!isMapping(entry.cli)) return drop("`cli` must be a mapping of command name → entrypoint path");
    for (const [cmd, p] of Object.entries(entry.cli)) {
      if (!PLUGIN_NAME_RE.test(cmd)) return drop(`command name \`${cmd}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
      const rel = optionalRelPath(p, `exports.plugins.${name}.cli.${cmd}`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`cli.${cmd}\` needs an entrypoint path`);
      }
      cli[cmd] = rel;
    }
  }

  const installInputs: string[] = [];
  if (entry["install-inputs"] !== undefined && entry["install-inputs"] !== null) {
    const rawInputs = entry["install-inputs"];
    if (!Array.isArray(rawInputs)) return drop("`install-inputs` must be a list of file paths");
    for (let i = 0; i < rawInputs.length; i++) {
      const rel = optionalRelPath(rawInputs[i], `exports.plugins.${name}.install-inputs[${i}]`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`install-inputs[${i}]\` must be a path`);
      }
      installInputs.push(rel);
    }
  }

  // req 28 — the directories install populates, each eligible for the shared
  // dependency store. Absent means the npm default, exactly as `agent.dep-dirs`
  // behaves; an explicit empty list opts out.
  let depDirs: string[] = [...DEFAULT_PLUGIN_DEP_DIRS];
  if (entry["dep-dirs"] !== undefined && entry["dep-dirs"] !== null) {
    const rawDirs = entry["dep-dirs"];
    if (!Array.isArray(rawDirs)) return drop("`dep-dirs` must be a list of directory paths");
    const seen = new Set<string>();
    depDirs = [];
    for (let i = 0; i < rawDirs.length; i++) {
      const rel = optionalRelPath(rawDirs[i], `exports.plugins.${name}.dep-dirs[${i}]`);
      if (rel === undefined || typeof rel === "object") {
        return drop(typeof rel === "object" ? rel.error : `\`dep-dirs[${i}]\` must be a path`);
      }
      if (seen.has(rel)) continue;
      seen.add(rel);
      depDirs.push(rel);
    }
  }

  const credentials: string[] = [];
  if (entry.credentials !== undefined && entry.credentials !== null) {
    if (!Array.isArray(entry.credentials)) return drop("`credentials` must be a list of credential NAMES");
    for (const c of entry.credentials) {
      if (typeof c !== "string" || !CREDENTIAL_NAME_RE.test(c)) {
        return drop(`credential names must look like environment variables (got \`${String(c)}\`)`);
      }
      // The check belongs HERE rather than on either delivery surface, so both
      // inherit one answer and the plugin author is told at declaration time
      // (see `PLUGIN_CONTRACT_ENV_NAMES`): the compose surface silently drops
      // such a name while the CLI surface appends a duplicate `Env` entry whose
      // resolution nothing specifies. Refused rather than ignored, because a
      // plugin that names one of these has confused ShipIt's contract for its
      // own configuration, and telling it so is cheaper than either surface's
      // undefined behaviour.
      if (PLUGIN_CONTRACT_ENV_NAMES.has(c)) {
        return drop(
          `\`${c}\` is set by ShipIt in every plugin container, so a plugin cannot declare it as a credential`,
        );
      }
      credentials.push(c);
    }
  }

  const hosts: string[] = [];
  if (entry.hosts !== undefined && entry.hosts !== null) {
    if (!Array.isArray(entry.hosts)) return drop("`hosts` must be a list of hostnames");
    for (const h of entry.hosts) {
      if (typeof h !== "string" || !HOST_RE.test(h)) {
        return drop(`hosts must be bare hostnames like \`fal.run\` (got \`${String(h)}\`)`);
      }
      hosts.push(h);
    }
  }

  const settings: PluginExport["settings"] = {};
  if (entry.settings !== undefined && entry.settings !== null) {
    if (!isMapping(entry.settings)) return drop("`settings` must be a mapping keyed by setting name");
    for (const [sName, sVal] of Object.entries(entry.settings)) {
      if (!PLUGIN_NAME_RE.test(sName)) return drop(`setting name \`${sName}\` must be letters, digits, \`.\`, \`_\` or \`-\``);
      if (sVal === null || sVal === undefined) {
        settings[sName] = {};
        continue;
      }
      if (!isMapping(sVal)) return drop(`\`settings.${sName}\` must be a mapping (description/default)`);
      // A misspelled descriptor key (`defualt`) silently loses the default it
      // meant to set — say so (review finding). Warn-not-drop, the same
      // forward-compatibility rule as every other unknown key.
      for (const key of Object.keys(sVal)) {
        if (key !== "description" && key !== "default") {
          warnings.push(`Unknown key \`exports.plugins.${name}.settings.${sName}.${key}\` in shipit.yaml.`);
        }
      }
      const out: { description?: string; default?: string | number | boolean } = {};
      if (sVal.description !== undefined) {
        if (typeof sVal.description !== "string") return drop(`\`settings.${sName}.description\` must be a string`);
        out.description = sVal.description;
      }
      if (sVal.default !== undefined) {
        if (!isScalar(sVal.default)) return drop(`\`settings.${sName}.default\` must be a scalar`);
        out.default = sVal.default;
      }
      settings[sName] = out;
    }
  }

  return {
    name,
    ...(compose !== undefined ? { compose } : {}),
    cli,
    ...(skills !== undefined ? { skills } : {}),
    ...(install !== undefined ? { install } : {}),
    installInputs,
    depDirs,
    credentials,
    hosts,
    settings,
  };
}

/** Literal relative path, workspace-confined — the same structural rules as
 * `agent.dep-dirs`, re-implemented here because this module must stay
 * filesystem-free (the shipit-config helper lives beside `node:fs` imports).
 * Returns the normalized path, `undefined` for absent, or `{error}` — the
 * caller drops the whole plugin (fail-closed per plugin). */
function optionalRelPath(
  raw: unknown,
  label: string,
): string | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) return { error: `\`${label}\` must be a non-empty path` };
  const trimmed = raw.trim();
  if (trimmed.startsWith("/")) return { error: `\`${label}\` must be a relative path` };
  if (/[*?[\]{}]/.test(trimmed)) return { error: `\`${label}\` must be a literal path — no globs` };
  const segments = trimmed.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) return { error: `\`${label}\` must stay inside the repository` };
  if (segments.length === 0) return { error: `\`${label}\` must not be the repository root` };
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Snapshot assembly (used by the /api/plugin-repos route)
// ---------------------------------------------------------------------------

/**
 * Project the parsed config into the browser snapshot. Pure — the route feeds
 * it the config and the session's remote. Self repos resolve their `use`
 * selectors against the same file's own manifest (their phase 2 needs no
 * fetch); tracked repos stay `found: null` until checkout mechanics exist.
 */
export function buildPluginReposSnapshot(
  plugins: PluginReposConfig,
  pluginExports: readonly PluginExport[],
  consumerRepoUrl: string | null,
  warnings: readonly string[],
  runtime: Readonly<Record<string, PluginRepoRuntime>> = {},
  /**
   * req 23 — per-plugin credential needs, already resolved against the
   * consuming project's store by the caller (`plugin-credentials.ts`). Passed
   * in rather than computed here for the reason the whole module is
   * filesystem-free: satisfaction is a store read, and this projection stays
   * pure. Keyed onto `use` entries by alias, which is unique per project.
   */
  credentialGroups: readonly PluginCredentialGroup[] = [],
  /**
   * req 24 — per-plugin host needs, already resolved against the session's own
   * egress allowlist by the caller (`orchestrator/plugin-hosts.ts`). Passed in
   * for the reason `credentialGroups` is: allowance is a store read, and this
   * projection stays pure. A declaration NEVER decides its own allowance.
   */
  hostGroups: readonly PluginHostGroup[] = [],
): PluginReposSnapshot {
  const selfExports = new Set(pluginExports.map((e) => e.name.toLowerCase()));
  const needsByAlias = new Map(credentialGroups.map((g) => [g.alias.toLowerCase(), g.credentials]));
  const hostsByAlias = new Map(hostGroups.map((g) => [g.alias.toLowerCase(), g.hosts]));

  const repos: PluginRepoCardView[] = plugins.repos.map((repo) => {
    const isSelf = repo.source.kind === "self";
    const live = runtime[repo.name] ?? {};
    // Selector resolution (phase 2): a self repo's manifest is this same file;
    // a tracked repo's is the live generation's. Both are `null` — "not yet
    // knowable" — until there is a manifest to check against.
    const manifest = isSelf ? selfExports : live.exports ? new Set(live.exports.map((n) => n.toLowerCase())) : null;

    const uses = plugins.uses
      .filter((u) => u.from.toLowerCase() === repo.name.toLowerCase())
      .map((u) => ({
        plugin: u.plugin,
        alias: u.alias,
        found: manifest ? manifest.has(u.plugin.toLowerCase()) : null,
        credentials: needsByAlias.get(u.alias.toLowerCase()) ?? [],
        hosts: hostsByAlias.get(u.alias.toLowerCase()) ?? [],
      }));

    // What runs, and what the declaration says now. The card states the
    // former (req 19 — the commit "being executed"); when they disagree and
    // nothing is in flight to reconcile them, the difference is itself a fact
    // the user needs, because their edit has not taken effect. Ordered first:
    // a repository at the wrong version explains the selector, settings and
    // command problems below it.
    const declaredRef = isSelf ? null : declaredRefLabel(repo);
    const issues: string[] = [];
    if (live.ref && declaredRef && live.ref !== declaredRef && !live.activating) {
      issues.push(
        `Running \`${live.ref}\`; the declaration now says \`${declaredRef}\`. `
        + `Run \`shipit plugin refresh ${repo.name}\` to move to it.`,
      );
    }

    // A phase-2 failure already says which selectors the declared version
    // lacks, so repeating it here would state one fact twice on the card
    // (found live in the dogfood instance). The generic message still fires for
    // a selector the LIVE generation lacks when the attempt failed for some
    // other reason — a fetch failure plus a newly added selector, say.
    const named = new Set((live.missingSelectors ?? []).map((n) => n.toLowerCase()));
    issues.push(
      ...uses
        .filter((u) => u.found === false && !named.has(u.plugin.toLowerCase()))
        .map((u) => `\`${u.plugin}\` is not in this repository's \`exports.plugins\` manifest.`),
    );
    // req 26 — a settings value that cannot take effect. Below the selector
    // problems: a plugin that is not there at all outranks one whose settings
    // are wrong.
    issues.push(...(live.settingsIssues ?? []));
    // req 20 — a command that is not on PATH. Same class as a settings value
    // that cannot take effect: the declaration asked for something the session
    // is not doing, and nothing inside the plugin can tell.
    issues.push(...(live.commandIssues ?? []));
    // Services below both: a plugin whose services cannot be surfaced still
    // gives the session its files, CLIs and skills, so it outranks neither the
    // plugin being absent nor a declaration that silently takes no effect.
    issues.push(...(live.serviceIssues ?? []));
    // Order: the failure first, then advisories, then selector problems.
    if (live.warning) issues.unshift(live.warning);
    for (const w of live.manifestWarnings ?? []) issues.unshift(w);
    if (live.error) issues.unshift(live.error);

    return {
      name: repo.name,
      source: isSelf ? "self" : `${(repo.source as { owner: string }).owner}/${(repo.source as { repo: string }).repo}`,
      // The running generation's own ref, so the pair on the card comes from
      // one record; the declared ref only when nothing is running.
      ref: isSelf ? null : live.ref ?? declaredRef,
      commit: live.commit ?? null,
      status: cardStatus(isSelf, live),
      uses,
      issues,
    };
  });

  // Warning projection (review finding): consumer-block warnings always ride
  // the snapshot — they are what the tab's intent gating protects. Exports
  // warnings ride it only when the project consumes plugins: a repo that only
  // EXPORTS must not grow a Plugins tab from a manifest warning (plan §3 —
  // the tab renders only when the project declares plugins; the config
  // banner already surfaces those warnings to the plugin's author). Every
  // message from this module quotes its config key, which is what the
  // prefixes match.
  const consumerWarnings = warnings.filter((w) => w.includes("`plugins"));
  const exportWarnings = plugins.declared ? warnings.filter((w) => w.includes("`exports")) : [];

  return {
    declared: plugins.declared,
    pending: false,
    activating: repos.some((r) => r.status === "activating"),
    consumerRepoUrl,
    repos,
    warnings: [...consumerWarnings, ...exportWarnings],
  };
}

/**
 * `degraded` is the distinction req 15 asks for: a failed refresh that left a
 * prior generation live is NOT the same as never having fetched at all, and
 * the two read differently on the card.
 */
function cardStatus(isSelf: boolean, live: PluginRepoRuntime): PluginRepoStatus {
  if (isSelf) return "self";
  // `activating` is checked FIRST (review finding): a refresh running over a
  // live prior generation is in progress, and reporting it as `active` hid
  // every refresh that had something to replace.
  if (live.activating) return "activating";
  if (live.commit) return live.error ? "degraded" : "active";
  return "unavailable";
}
