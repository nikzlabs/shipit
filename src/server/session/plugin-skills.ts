/**
 * docs/262 req 22 — make a plugin repository's skills reach the agent.
 *
 * A checkout on its own discloses nothing. Both harnesses find skills by
 * scanning a directory under the workspace (`.claude/skills`, `.codex/skills`),
 * and `/plugins/<name>` is not one of them — so a plugin's skills have to be
 * **materialized** into those roots. That is the whole job here.
 *
 * Two properties of req 22 shape every decision below.
 *
 * **"Whichever agent backend runs the session … never tied to one backend."**
 * So the skills go into the discovery root of EVERY harness in the catalogue,
 * not only the one that happens to be running, and not only the one docs/209
 * verified. docs/209 found that Codex also reads `.claude/skills`, but it
 * recorded that as *observed behavior, not a guarantee*, and `skillsDirName`
 * additionally drives ShipIt's own skill listing — so a Codex session whose
 * plugin skills existed only under `.claude` would work in the CLI and be
 * missing from the picker. Writing both roots costs a few kilobytes and owes
 * nothing to either observation.
 *
 * **"Projects never keep copies that must be kept in sync."** The materialized
 * tree therefore must never enter the user's repository. It cannot be excluded
 * by editing the project's `.gitignore` — that is a tracked file ShipIt does
 * not own. It uses the same mechanism docs/198 used for pnpm's relocated
 * store: `.git/info/exclude`, a per-clone, non-tracked ignore list, so
 * `git status` and the post-turn `git add -A` never see these directories and
 * the committed tree is unchanged.
 *
 * Copied rather than symlinked, following the marketplace installer: a skill is
 * a few kilobytes of markdown, a copy has no dangling-link failure mode, and
 * re-copying is how a refresh takes effect (plan §2 — "refresh re-materializes
 * and the agent re-scans on next turn").
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HARNESSES } from "../shared/catalogue/harnesses.js";
import { parsePluginExports, type PluginExport } from "../shared/plugin-repos.js";
import { getErrorMessage } from "../shared/utils.js";

/**
 * Prefix of every directory this module owns. A single namespace, so stale
 * cleanup can identify its own output without a per-directory marker, and one
 * that cannot collide with the marketplace installer's `<plugin>__<skill>`.
 */
export const PLUGIN_SKILL_PREFIX = "plugins--";

/** Written into each materialized skill so nothing else is ever overwritten. */
export const PLUGIN_SKILL_MARKER = ".shipit-plugin-skill.json";

/** Value the marker must carry — presence of the FILE is not proof of ownership. */
export const PLUGIN_SKILL_MARKER_ID = "shipit-plugin-skill-v1";

/** Name of the managed block written into `.git/info/exclude`. */
export const PLUGIN_SKILL_EXCLUDE_BLOCK = "shipit plugin skills";

/**
 * The exact `.git/info/exclude` entries for a planned set of skills — one line
 * per directory that will exist, in every root.
 *
 * Exact paths, not `plugins--*`: a wildcard also hides whatever the user
 * happens to name that way, and a marketplace plugin called `plugins--acme`
 * installs as `plugins--acme__<skill>`, which the wildcard would match — its
 * own path-scoped `git add` then fails as an ignored path, leaving a hidden
 * half-installed plugin (review finding).
 */
export function pluginSkillExcludeEntries(names: readonly string[]): string[] {
  return skillsRoots("").flatMap((rel) => [
    // The staging directories too. They exist only mid-copy, but prepare is
    // fire-and-forget and can overlap a post-turn `git add -A`, which would
    // otherwise stage a half-copied third-party tree — and a crash leaves one
    // behind entirely (review finding). A wildcard is safe HERE, unlike for the
    // published names: the pattern is a dot-prefixed form of our own namespace
    // that nothing else plausibly writes.
    `/${rel}/${STAGING_GLOB}`,
    ...names.map((name) => `/${rel}/${name}/`),
  ]);
}

/** Shape of a staging directory: `.plugins--<name>.staging-<8 hex>`. */
const STAGING_GLOB = `.${PLUGIN_SKILL_PREFIX}*.staging-*/`;
const STAGING_RE = new RegExp(`^\\.${PLUGIN_SKILL_PREFIX}.*\\.staging-`);

/**
 * Every harness's skills root, workspace-relative when `workspaceDir` is empty.
 * Deduplicated: two harnesses that name the same directory get one root.
 */
function skillsRoots(workspaceDir: string): string[] {
  const names = [...new Set(HARNESSES.map((h) => h.capabilities.skillsDirName))];
  return names.map((name) => (workspaceDir ? path.join(workspaceDir, name, "skills") : `${name}/skills`));
}

/** One plugin's skills, ready to be written. */
export interface PluginSkillSource {
  /** The consumer's alias for the imported plugin — the namespace key (req 20). */
  alias: string;
  /** Absolute path of the skills directory inside the plugin checkout. */
  skillsDir: string;
  /**
   * The checkout the skills dir must stay inside, REALLY — not lexically.
   * Carried separately because containment is checked with `realpath`: the
   * manifest's own validation is lexical, so `skills: pkg/skills` where `pkg`
   * is a symlink out of the checkout passes it and then reads somebody else's
   * files (review finding).
   */
  checkoutDir: string;
}

export interface PluginSkillsResult {
  /** Namespaced skill directory names now present, across all roots. */
  materialized: string[];
  /** Namespaced directories removed because the declaration no longer names them. */
  removed: string[];
  /** Alias/skill pairs that could not be written, with the reason. */
  failed: { skill: string; reason: string }[];
}

/**
 * Resolve which skills to materialize from what the consumer imported.
 *
 * Reads each plugin repository's OWN manifest out of its live checkout, so the
 * orchestrator never has to send the export list — the same "say when, never
 * what" split the link surface uses.
 */
export function resolvePluginSkillSources(
  uses: readonly { plugin: string; from: string; alias: string }[],
  checkoutDirFor: (repoName: string) => string | null,
): PluginSkillSource[] {
  const manifests = new Map<string, PluginExport[]>();
  const sources: PluginSkillSource[] = [];

  for (const use of uses) {
    const key = use.from.toLowerCase();
    if (!manifests.has(key)) manifests.set(key, readExports(checkoutDirFor(use.from)));
    const exported = manifests.get(key)!
      .find((e) => e.name.toLowerCase() === use.plugin.toLowerCase());
    if (!exported?.skills) continue;

    const checkoutDir = checkoutDirFor(use.from);
    if (!checkoutDir) continue;
    // The manifest parser already rejects absolute paths and traversal, so this
    // join stays inside the checkout.
    sources.push({
      alias: use.alias,
      checkoutDir,
      skillsDir: path.join(checkoutDir, exported.skills),
    });
  }
  return sources;
}

function readExports(checkoutDir: string | null): PluginExport[] {
  if (!checkoutDir) return [];
  try {
    // Parsed from YAML the same way the orchestrator does. A malformed manifest
    // yields no exports rather than throwing — the session still opens (req 13).
    const raw = fs.readFileSync(path.join(checkoutDir, "shipit.yaml"), "utf-8");
    const doc: unknown = parseYaml(raw);
    const block = doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>).exports
      : undefined;
    return parsePluginExports(block, []);
  } catch {
    return [];
  }
}

/** One skill about to be written: where it comes from, and what it will be called. */
export interface PlannedSkill {
  name: string;
  from: string;
}

/** What a plan produced: what to write, and what could not be planned at all. */
export interface PluginSkillPlan {
  planned: PlannedSkill[];
  failed: { skill: string; reason: string }[];
}

/**
 * Work out what would be materialized, WITHOUT writing anything.
 *
 * Separate from the write so the caller can put the exact directory names into
 * the clone's git exclude *before* they exist — the promise that these never
 * enter the project has to hold from the first moment they do.
 *
 * This is also where a plan is REJECTED rather than silently degraded: a skills
 * directory that escapes its checkout, and two imports whose namespaced names
 * collide. Both used to pass — the first read files outside the plugin, the
 * second let one copy overwrite the other.
 */
export function planPluginSkills(sources: readonly PluginSkillSource[]): PluginSkillPlan {
  const plan: PluginSkillPlan = { planned: [], failed: [] };
  const claimed = new Map<string, string>();

  for (const source of sources) {
    // Absent and escaping are different problems and get different messages —
    // one is a plugin that has not shipped what it declared, the other is a
    // plugin reaching outside its own checkout.
    if (!fs.existsSync(source.skillsDir)) {
      // Declared and selected, but the generation does not have it. Silence
      // here reported a plugin as fully active while shipping none of the
      // instructions it promised (review finding).
      plan.failed.push({
        skill: source.alias,
        reason: "the declared skills directory does not exist in this generation",
      });
      continue;
    }
    const skillsDir = containedRealPath(source.checkoutDir, source.skillsDir);
    if (!skillsDir) {
      plan.failed.push({
        skill: source.alias,
        reason: "the declared skills directory resolves outside the plugin checkout",
      });
      continue;
    }
    const dirs = listSkillDirs(skillsDir);
    if (dirs === null) {
      plan.failed.push({
        skill: source.alias,
        reason: "the declared skills directory could not be read",
      });
      continue;
    }
    for (const skillDir of dirs) {
      const from = containedRealPath(skillsDir, path.join(skillsDir, skillDir));
      if (!from) {
        plan.failed.push({
          skill: `${source.alias}/${skillDir}`,
          reason: "the skill directory resolves outside the plugin checkout",
        });
        continue;
      }
      const name = namespacedName(source.alias, skillDir);
      // A name is claimed once. The hash makes a clash unlikely, not
      // impossible — and "unlikely" silently overwriting somebody's skill is
      // not the unambiguous namespace req 20 promises.
      const owner = claimed.get(name);
      if (owner !== undefined) {
        plan.failed.push({
          skill: `${source.alias}/${skillDir}`,
          reason: `its namespaced name collides with \`${owner}\``,
        });
        continue;
      }
      claimed.set(name, `${source.alias}/${skillDir}`);
      plan.planned.push({ name, from });
    }
  }
  return plan;
}

/** The deepest ancestor of `p` (including `p`) that exists on disk. */
function nearestExisting(p: string): string {
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * `target` resolved through every symlink, but only if it really stays inside
 * `base` — also resolved. `null` when it escapes or cannot be resolved.
 *
 * A lexical check is not enough on either side of this copy. On the source
 * side the checkout belongs to a third party, so any component of the declared
 * path may be a link out of it. On the destination side the project may own a
 * `.claude -> /outside` symlink, which would put every copy beyond the reach of
 * the git exclude that is supposed to contain them.
 */
function containedRealPath(base: string, target: string): string | null {
  try {
    const realBase = fs.realpathSync(base);
    const real = fs.realpathSync(target);
    const prefix = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
    return real === realBase || real.startsWith(prefix) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Write the planned skills into each harness's discovery root.
 *
 * **All roots or none.** If any root refuses a skill, the ones that took it are
 * rolled back. Reporting a partial write as a failure was not enough: the
 * FILESYSTEM was still backend-specific, so a foreign directory under `.claude`
 * left the skill present for Codex and absent for Claude — exactly the
 * per-backend outcome req 22 rules out (review finding).
 *
 * Idempotent, and safe to run on every activation round and container start.
 * Never throws: a skill that cannot be written is reported, not fatal.
 */
export function materializePluginSkills(
  workspaceDir: string,
  planned: readonly PlannedSkill[],
): PluginSkillsResult {
  const result: PluginSkillsResult = { materialized: [], removed: [], failed: [] };

  for (const { name, from } of planned) {
    const written: string[] = [];
    const failures: string[] = [];
    for (const root of skillsRoots(workspaceDir)) {
      const failure = writeSkill(from, root, name);
      if (failure) failures.push(failure);
      else written.push(path.join(root, name));
    }
    if (failures.length === 0) {
      result.materialized.push(name);
      continue;
    }
    for (const reason of failures) result.failed.push({ skill: name, reason });
    for (const dir of written) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[plugins] could not roll back ${dir}: ${getErrorMessage(err)}`);
      }
    }
  }
  return result;
}

/**
 * Remove materialized skills this session no longer imports, and any staging
 * directory a previous run left behind.
 *
 * Split out of the write so the caller can run it BEFORE rewriting the git
 * exclude: dropping an exclusion while the directory it covers still exists
 * opens a window where a concurrent `git add -A` stages it (review finding).
 */
export function sweepStalePluginSkills(
  workspaceDir: string,
  wanted: ReadonlySet<string>,
): string[] {
  return removeStaleSkills(workspaceDir, wanted);
}

/**
 * `plugins--<alias>--<skill>` (plan §2), rendered safe for a directory name and
 * made unique by a hash of the exact pair.
 *
 * The readable rendering is lossy: it collapses every punctuation run, so the
 * aliases `foo_bar` and `foo-bar` — both valid, both distinct to the parser's
 * uniqueness check — render identically, and so do the skills `do_it` and
 * `do-it`. Without the hash the second copy would silently delete the first,
 * which is the opposite of the unambiguous namespace req 20 promises (review
 * finding; the same defect the plugin overlay volume name had).
 *
 * **The hash narrows the odds; it does not make the name unique**, and the
 * first version of this comment claimed that it did. A second reviewer found a
 * real collision at 6 hex digits in under ten thousand crafted candidates
 * (`a-._--_-.b` and `a...-.---b` both render `a-b` and hashed alike). It is 12
 * digits now, but the guarantee comes from `planPluginSkills` REJECTING a
 * duplicate name outright — a hash width is a defence, not a proof.
 */
export function namespacedName(alias: string, skill: string): string {
  const hash = crypto.createHash("sha256").update(`${alias}\u0000${skill}`).digest("hex").slice(0, 12);
  return `${PLUGIN_SKILL_PREFIX}${segment(alias)}--${segment(skill)}-${hash}`;
}

function segment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/**
 * Immediate subdirectories of a skills dir that actually hold a `SKILL.md`, or
 * `null` when the directory itself is missing or unreadable — which is a
 * reportable failure, not an empty result.
 */
function listSkillDirs(skillsDir: string): string[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name);
}

/**
 * Copy one skill into a discovery root. Returns a reason on failure, `null` on
 * success.
 *
 * **Only ever replaces a directory this module wrote.** A user's own skill that
 * happens to sit at the same path is left alone and reported, because the
 * alternative is deleting somebody's work to make room for a copy.
 *
 * **Published by rename, never written in place** — which is weaker than
 * atomic, and the first version of this comment claimed it was atomic. The
 * directory that appears is always COMPLETE, because it is built under a
 * staging name and arrives by rename. It is not indivisible: `rename(2)`
 * refuses a non-empty destination, so the old copy is removed first and a
 * reader in that gap sees no skill rather than half of one. Absent-then-whole
 * is the failure mode worth having; the shape before this let a reader see a
 * directory with files missing, and left an unmarked partial behind on failure
 * that the ownership check then refused to replace, wedging the skill.
 */
function writeSkill(from: string, root: string, name: string): string | null {
  const staging = path.join(root, `.${name}.staging-${crypto.randomUUID().slice(0, 8)}`);
  const to = path.join(root, name);
  try {
    // Checked BEFORE the mkdir, against the deepest ancestor that already
    // exists. Creating first and checking after still creates the directory:
    // a project-owned `.claude -> /outside` with no `/outside/skills` yet was
    // populated there, entirely beyond the git exclude meant to contain it
    // (review finding).
    const workspaceDir = path.dirname(path.dirname(root));
    if (!containedRealPath(workspaceDir, nearestExisting(root))) {
      return `\`${root}\` resolves outside the workspace; refusing to write through it`;
    }
    fs.mkdirSync(root, { recursive: true });

    const owned = ownershipOf(to);
    if (owned === "foreign") return `\`${name}\` already exists and was not created by ShipIt`;

    fs.rmSync(staging, { recursive: true, force: true });
    // Symlinks are DROPPED, not followed. `dereference: true` copies a link's
    // target content, so a plugin repository could ship
    // `skills/x/assets -> /credentials` (or a huge tree) and have this copy it
    // into the workspace — the manifest's path validation is lexical and says
    // nothing about what a link inside the checkout points at (review finding).
    fs.cpSync(from, staging, {
      recursive: true,
      dereference: false,
      filter: (src) => !isSymlink(src),
    });
    if (!fs.existsSync(path.join(staging, "SKILL.md"))) {
      return `\`${name}\` has no readable SKILL.md`;
    }
    rewriteSkillName(path.join(staging, "SKILL.md"), name);
    fs.writeFileSync(
      path.join(staging, PLUGIN_SKILL_MARKER),
      `${JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID, source: from, name }, null, 2)}\n`,
    );

    // What this does and does NOT guarantee. The directory that appears at
    // `to` is always complete — it is built entirely under `staging` and
    // arrives by rename. It is not fully atomic: `rename(2)` refuses a
    // non-empty destination directory, so the old copy is removed first, and a
    // reader in that gap sees no skill at all rather than half of one.
    // Absent-then-whole is the failure mode worth having; the previous shape
    // let a reader see a directory with some files missing, and left an
    // unmarked partial behind on failure.
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(staging, to);
    return null;
  } catch (err) {
    return getErrorMessage(err);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Who owns the directory at `p`: this module, nobody (it does not exist), or
 * somebody else.
 *
 * The marker's CONTENT is checked, not merely its name. A file called
 * `.shipit-plugin-skill.json` is something a handwritten skill could plausibly
 * contain — and treating its presence as proof of ownership makes this module
 * willing to recursively delete that skill (review finding). A symlink in its
 * place is likewise not proof of anything.
 */
function ownershipOf(p: string): "ours" | "absent" | "foreign" {
  if (!fs.existsSync(p)) return "absent";
  const marker = path.join(p, PLUGIN_SKILL_MARKER);
  try {
    if (!fs.lstatSync(marker).isFile()) return "foreign";
    const parsed: unknown = JSON.parse(fs.readFileSync(marker, "utf-8"));
    const id = parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).marker
      : undefined;
    return id === PLUGIN_SKILL_MARKER_ID ? "ours" : "foreign";
  } catch {
    return "foreign";
  }
}

/**
 * Namespace the skill's invocable name to match its directory.
 *
 * Without this, two plugins that both ship a `probe` skill are two entries
 * called `probe`: the scanner takes the invocable name from the frontmatter and
 * only falls back to the directory name. The directory namespace would be doing
 * nothing where it matters most.
 */
function rewriteSkillName(skillMdPath: string, name: string): void {
  let body: string;
  try {
    body = fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!match) return;
  const frontmatter = match[1];
  const rewritten = /^name:.*$/m.test(frontmatter)
    ? frontmatter.replace(/^name:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;
  fs.writeFileSync(skillMdPath, body.replace(match[0], `---\n${rewritten}\n---`));
}

/**
 * Remove materialized skills this session no longer imports — a dropped `use`
 * entry, a renamed alias, a plugin whose manifest stopped exporting them.
 *
 * Scoped by the `plugins--` prefix AND by the marker file, so neither a user's
 * own skill nor a marketplace-installed one can be touched.
 */
function removeStaleSkills(workspaceDir: string, wanted: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const root of skillsRoots(workspaceDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A staging directory is always ours and never wanted: it exists only
      // between the copy and the rename, so anything still here is the residue
      // of a run that died (review finding — the `finally` cannot cover a
      // killed process, and nothing else names these).
      if (entry.isDirectory() && STAGING_RE.test(entry.name)) {
        try {
          fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        } catch (err) {
          console.warn(`[plugins] could not remove staging dir ${entry.name}: ${getErrorMessage(err)}`);
        }
        continue;
      }
      if (!entry.isDirectory() || !entry.name.startsWith(PLUGIN_SKILL_PREFIX)) continue;
      if (wanted.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      // Same validated ownership test as the write path — a directory is only
      // ours if its marker says so.
      if (ownershipOf(dir) !== "ours") continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!removed.includes(entry.name)) removed.push(entry.name);
      } catch (err) {
        console.warn(`[plugins] could not remove skill ${entry.name}: ${getErrorMessage(err)}`);
      }
    }
  }
  return removed;
}
