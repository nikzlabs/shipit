// Copy into every harness's discovery root; .git/info/exclude keeps copies untracked.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parsePluginExports, type PluginExport } from "../shared/plugin-repos.js";
import {
  PLUGIN_SKILL_MARKER,
  PLUGIN_SKILL_MARKER_ID,
  PLUGIN_SKILL_PREFIX,
} from "../shared/plugin-skill-marker.js";
import {
  ownedPluginSkillDirs,
  pluginSkillOwnership as ownershipOf,
  pluginSkillRoots as skillsRoots,
} from "../shared/plugin-skill-copies.js";
import { getErrorMessage } from "../shared/utils.js";

export { PLUGIN_SKILL_MARKER, PLUGIN_SKILL_MARKER_ID, PLUGIN_SKILL_PREFIX };

export const PLUGIN_SKILL_EXCLUDE_BLOCK = "shipit plugin skills";

// Exact published paths avoid hiding user or marketplace skills with the same prefix.
export function pluginSkillExcludeEntries(workspaceDir: string, names: readonly string[]): string[] {
  const rels = new Set<string>();
  for (const rel of skillsRoots("")) {
    rels.add(rel);
    // Git does not follow a symlinked root, so also exclude where the copies really land.
    const real = realRootRel(workspaceDir, rel);
    if (real !== null) rels.add(real);
  }
  return [...rels].flatMap((rel) => {
    // A resolved path is the user's, so its glob characters must match only themselves.
    const prefix = rel ? `/${rel.replace(/[\\*?[]/g, "\\$&")}/` : "/";
    return [
      // Staging can overlap auto-commit or survive a crash.
      `${prefix}${STAGING_GLOB}`,
      ...names.map((name) => `${prefix}${name}/`),
    ];
  });
}

const STAGING_GLOB = `.${PLUGIN_SKILL_PREFIX}*.staging-*/`;

// Null when the root resolves outside the workspace, where writeSkill refuses to write.
function realRootRel(workspaceDir: string, rel: string): string | null {
  try {
    const lexical = path.join(workspaceDir, rel);
    const existing = nearestExisting(lexical);
    const real = path.join(fs.realpathSync(existing), path.relative(existing, lexical));
    const inside = path.relative(fs.realpathSync(workspaceDir), real);
    if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
    return inside.split(path.sep).join("/");
  } catch {
    return null;
  }
}

export interface PluginSkillSource {
  alias: string;
  /** Declaration spelling, used to attribute failures to the repository card. */
  repo: string;
  skillsDir: string;
  checkoutDir: string;
}

export interface PluginSkillsResult {
  materialized: string[];
  removed: string[];
  failed: PluginSkillFailure[];
}

export function resolvePluginSkillSources(
  uses: readonly { plugin: string; from: string; alias: string }[],
  checkoutFor: (repoName: string) => PluginCheckout | null,
): PluginSkillSource[] {
  const manifests = new Map<string, PluginExport[]>();
  const sources: PluginSkillSource[] = [];

  for (const use of uses) {
    const key = use.from.toLowerCase();
    const checkout = checkoutFor(use.from);
    if (!manifests.has(key)) manifests.set(key, readCheckoutExports(checkout?.dir ?? null));
    const exported = manifests.get(key)!
      .find((e) => e.name.toLowerCase() === use.plugin.toLowerCase());
    if (!exported?.skills) continue;

    if (!checkout) continue;
    sources.push({
      alias: use.alias,
      repo: checkout.repo,
      checkoutDir: checkout.dir,
      skillsDir: path.join(checkout.dir, exported.skills),
    });
  }
  return sources;
}

export interface PluginCheckout {
  dir: string;
  repo: string;
}

export function readCheckoutExports(checkoutDir: string | null): PluginExport[] {
  if (!checkoutDir) return [];
  try {
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

export interface PlannedSkill {
  name: string;
  from: string;
  repo: string;
  label: string;
}

export interface PluginSkillFailure {
  repo: string;
  skill: string;
  reason: string;
}

export interface PluginSkillPlan {
  planned: PlannedSkill[];
  failed: PluginSkillFailure[];
}

// Plan before writing so callers can install git exclusions before copies exist.
export function planPluginSkills(sources: readonly PluginSkillSource[]): PluginSkillPlan {
  const plan: PluginSkillPlan = { planned: [], failed: [] };
  const claimed = new Map<string, string>();

  for (const source of sources) {
    if (!fs.existsSync(source.skillsDir)) {
      plan.failed.push({
        repo: source.repo,
        skill: source.alias,
        reason: "the declared skills directory does not exist in this generation",
      });
      continue;
    }
    const skillsDir = containedRealPath(source.checkoutDir, source.skillsDir);
    if (!skillsDir) {
      plan.failed.push({
        repo: source.repo,
        skill: source.alias,
        reason: "the declared skills directory resolves outside the plugin checkout",
      });
      continue;
    }
    const dirs = listSkillDirs(skillsDir);
    if (dirs === null) {
      plan.failed.push({
        repo: source.repo,
        skill: source.alias,
        reason: "the declared skills directory could not be read",
      });
      continue;
    }
    if (dirs.length === 0) {
      plan.failed.push({
        repo: source.repo,
        skill: source.alias,
        reason: "the declared skills directory contains no readable skill",
      });
      continue;
    }
    for (const skillDir of dirs) {
      const label = `${source.alias}/${skillDir}`;
      const from = containedRealPath(skillsDir, path.join(skillsDir, skillDir));
      if (!from) {
        plan.failed.push({
          repo: source.repo,
          skill: label,
          reason: "the skill directory resolves outside the plugin checkout",
        });
        continue;
      }
      const name = namespacedName(source.alias, skillDir);
      const owner = claimed.get(name);
      if (owner !== undefined) {
        plan.failed.push({
          repo: source.repo,
          skill: label,
          reason: `its namespaced name collides with \`${owner}\``,
        });
        continue;
      }
      claimed.set(name, label);
      plan.planned.push({ name, from, repo: source.repo, label });
    }
  }
  return plan;
}

function nearestExisting(p: string): string {
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

// Resolve symlinks on both sides; lexical containment cannot protect the source or destination.
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

// Roll back successful copies if any harness root refuses the skill.
export function materializePluginSkills(
  workspaceDir: string,
  planned: readonly PlannedSkill[],
): PluginSkillsResult {
  const result: PluginSkillsResult = { materialized: [], removed: [], failed: [] };

  for (const { name, from, repo, label } of planned) {
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
    for (const reason of failures) result.failed.push({ repo, skill: label, reason });
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

// Sweep before removing git exclusions, or auto-commit could stage stale copies.
export function sweepStalePluginSkills(
  workspaceDir: string,
  wanted: ReadonlySet<string>,
): string[] {
  return removeStaleSkills(workspaceDir, wanted);
}

// Hash the original pair because segment normalization is lossy; the planner rejects collisions.
export function namespacedName(alias: string, skill: string): string {
  const hash = crypto.createHash("sha256").update(`${alias}\u0000${skill}`).digest("hex").slice(0, 12);
  return `${PLUGIN_SKILL_PREFIX}${segment(alias)}--${segment(skill)}-${hash}`;
}

function segment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

// Exclude our output: self imports can otherwise copy previous copies indefinitely.
function listSkillDirs(skillsDir: string): string[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")))
    .filter((e) => ownershipOf(path.join(skillsDir, e.name)) !== "ours")
    .map((e) => e.name);
}

function writeSkill(from: string, root: string, name: string): string | null {
  const staging = path.join(root, `.${name}.staging-${crypto.randomUUID().slice(0, 8)}`);
  const to = path.join(root, name);
  try {
    // Check before mkdir to avoid creating paths through a symlink outside the workspace.
    const workspaceDir = path.dirname(path.dirname(root));
    if (!containedRealPath(workspaceDir, nearestExisting(root))) {
      return `\`${root}\` resolves outside the workspace; refusing to write through it`;
    }
    fs.mkdirSync(root, { recursive: true });

    const owned = ownershipOf(to);
    if (owned === "foreign") return `\`${name}\` already exists and was not created by ShipIt`;

    fs.rmSync(staging, { recursive: true, force: true });
    // Mark before copying so a later sweep can identify interrupted copies.
    fs.mkdirSync(staging, { recursive: true });
    writeMarker(staging, from, name);
    // Drop internal symlinks so the copy cannot read outside the checkout.
    fs.cpSync(from, staging, {
      recursive: true,
      dereference: false,
      filter: (src) => !isSymlink(src),
    });
    if (!fs.existsSync(path.join(staging, "SKILL.md"))) {
      return `\`${name}\` has no readable SKILL.md`;
    }
    rewriteSkillName(path.join(staging, "SKILL.md"), name);
    // The source may contain a marker of its own; restore ours after copying.
    writeMarker(staging, from, name);

    // Non-empty directories cannot be replaced by rename; readers may see an absence, never a partial copy.
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(staging, to);
    return null;
  } catch (err) {
    return getErrorMessage(err);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function writeMarker(dir: string, from: string, name: string): void {
  fs.writeFileSync(
    path.join(dir, PLUGIN_SKILL_MARKER),
    `${JSON.stringify({ marker: PLUGIN_SKILL_MARKER_ID, source: from, name }, null, 2)}\n`,
  );
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Frontmatter takes precedence over the directory name during skill discovery.
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

function removeStaleSkills(workspaceDir: string, wanted: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const { dir, name, staging } of ownedPluginSkillDirs(workspaceDir, wanted)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!staging && !removed.includes(name)) removed.push(name);
    } catch (err) {
      console.warn(`[plugins] could not remove ${staging ? "staging dir" : "skill"} ${name}: ${getErrorMessage(err)}`);
    }
  }
  return removed;
}
