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
  return skillsRoots("").flatMap((rel) => names.map((name) => `/${rel}/${name}/`));
}

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
    sources.push({ alias: use.alias, skillsDir: path.join(checkoutDir, exported.skills) });
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

/**
 * Work out what would be materialized, WITHOUT writing anything.
 *
 * Separate from the write so the caller can put the exact directory names into
 * the clone's git exclude *before* they exist — the promise that these never
 * enter the project has to hold from the first moment they do.
 */
export function planPluginSkills(sources: readonly PluginSkillSource[]): PlannedSkill[] {
  const planned: PlannedSkill[] = [];
  for (const source of sources) {
    for (const skillDir of listSkillDirs(source.skillsDir)) {
      planned.push({
        name: namespacedName(source.alias, skillDir),
        from: path.join(source.skillsDir, skillDir),
      });
    }
  }
  return planned;
}

/**
 * Write the planned skills into each harness's discovery root, and drop the
 * ones this session no longer imports.
 *
 * Idempotent, and safe to run on every activation round and container start.
 * Never throws: a skill that cannot be written is reported, not fatal.
 */
export function materializePluginSkills(
  workspaceDir: string,
  planned: readonly PlannedSkill[],
): PluginSkillsResult {
  const result: PluginSkillsResult = { materialized: [], removed: [], failed: [] };
  const wanted = new Set(planned.map((p) => p.name));

  for (const { name, from } of planned) {
    const failures = skillsRoots(workspaceDir)
      .map((root) => writeSkill(from, path.join(root, name), name))
      .filter((f): f is string => f !== null);
    for (const reason of failures) result.failed.push({ skill: name, reason });
    // Reported as materialized only when EVERY root got it. A partial write is
    // a skill the running backend may not see at all — reporting it as done
    // would hide exactly the case worth knowing about (review finding).
    if (failures.length === 0) result.materialized.push(name);
  }

  result.removed.push(...removeStaleSkills(workspaceDir, wanted));
  return result;
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
 */
export function namespacedName(alias: string, skill: string): string {
  const hash = crypto.createHash("sha256").update(`${alias}\u0000${skill}`).digest("hex").slice(0, 6);
  return `${PLUGIN_SKILL_PREFIX}${segment(alias)}--${segment(skill)}-${hash}`;
}

function segment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/** Immediate subdirectories of a skills dir that actually hold a `SKILL.md`. */
function listSkillDirs(skillsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return []; // no skills dir in this generation — nothing to do
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
 * **Published by rename, never written in place.** The earlier version deleted
 * the live directory and copied into its final path, so an agent reading a
 * skill during a refresh could see an ENOENT or half a tree — and a copy that
 * failed after the delete left an unmarked partial directory, which the
 * ownership check above would then refuse to replace, wedging that skill
 * permanently (review finding). Staging beside the target and renaming closes
 * both: the live directory is replaced in one step, and a failed copy leaves
 * only a staging directory that is cleaned up.
 */
function writeSkill(from: string, to: string, name: string): string | null {
  const staging = path.join(path.dirname(to), `.${name}.staging-${crypto.randomUUID().slice(0, 8)}`);
  try {
    const owned = ownershipOf(to);
    if (owned === "foreign") return `\`${name}\` already exists and was not created by ShipIt`;

    fs.mkdirSync(path.dirname(to), { recursive: true });
    // The destination root itself must not be a symlink out of the workspace:
    // a project-owned `.claude/skills -> /somewhere` would make every path
    // below it land outside the tree the git exclude covers.
    if (isSymlink(path.dirname(to))) return `\`${path.dirname(to)}\` is a symlink; refusing to write through it`;

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
function removeStaleSkills(workspaceDir: string, wanted: Set<string>): string[] {
  const removed: string[] = [];
  for (const root of skillsRoots(workspaceDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
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
