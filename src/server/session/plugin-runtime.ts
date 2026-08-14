/**
 * docs/262 — the container half of plugin activation (plan §2): make each live
 * plugin checkout reachable at `/plugins/<name>`.
 *
 * That is ALL this module does, and the boundary is deliberate. An earlier
 * revision also ran each plugin's `install` here, reasoning that it would then
 * hold no more authority than `agent.install`. That was wrong twice over:
 * `agent.install` is the project's OWN command while a plugin's install string
 * comes from a third-party repository, and this container can reach the
 * worker's LOOPBACK credential broker (`/agent-ops/*`, no token required) to
 * obtain a real GitHub token — so req 19 cannot hold for anything running here.
 * Install now runs in its own container against an overlay volume (plan §1b).
 *
 * It also materializes each imported plugin's skills into the workspace skill
 * roots (req 22) — see `plugin-skills.ts`. That is still no plugin-authored
 * code: it copies markdown the agent reads, and runs nothing from the checkout.
 *
 * A `repo: self` import (req 27) takes the same route through every half of this
 * pass, with one substitution: its checkout is the session's own working tree
 * instead of a published generation ({@link resolveLiveCheckout}). Nothing is
 * duplicated to make that work — the manifest, the skills and the commands are
 * read from the one copy of them that exists, in the repository being edited.
 *
 * The declaration is readable at `/workspace/shipit.yaml`, so the orchestrator
 * only has to say *when*, never *what*.
 */

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGINS_DIR, CONTAINER_PLUGIN_STORE_DIR } from "../shared/fs-constants.js";
import { readPluginGenerationSource } from "../shared/plugin-generation-record.js";
import { destinationKey, type DeclaredPluginRepo } from "../shared/plugin-repos.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "../shared/utils.js";
import { ensureGitExcludedBlock } from "../shared/git.js";
import { preparePluginCommands, type PluginCommandIssue } from "./plugin-cli.js";
import {
  materializePluginSkills,
  planPluginSkills,
  pluginSkillExcludeEntries,
  resolvePluginSkillSources,
  sweepStalePluginSkills,
  PLUGIN_SKILL_EXCLUDE_BLOCK,
  type PluginSkillFailure,
} from "./plugin-skills.js";

export interface PluginPrepareResult {
  /** Repos that got a `/plugins/<name>` entry. */
  linked: string[];
  /** Declared but with no live generation yet — activation may still be running. */
  missing: string[];
  /** Links removed because the declaration no longer names that repo. */
  unlinked: string[];
  /**
   * Declared repositories whose live checkout could not be made reachable at
   * `/plugins/<name>`. Reported for the same reason `skillsFailed` is: a repo
   * that silently never linked renders as a perfectly healthy card while
   * nothing of it is in the workspace (req 2, req 13). Distinct from `missing`,
   * which is the ordinary "activation has not published a generation yet" state
   * the card already shows as `unavailable`.
   */
  linkFailed: { repo: string; reason: string }[];
  /** Namespaced skill directories written into each harness's discovery root (req 22). */
  skills: string[];
  /** Materialized skills removed because the declaration no longer imports them. */
  skillsRemoved: string[];
  /**
   * Skills that could not be written — reported, never fatal. Each names the
   * declared repository it belongs to, because this list is what the
   * orchestrator turns into card issues (req 13): a failure it cannot attribute
   * to a repository has nowhere to render, which is how this half of prepare
   * used to reach nothing but the log.
   */
  skillsFailed: PluginSkillFailure[];
  /** Companion-CLI commands now on the agent's PATH (reqs 17, 20). */
  commands: string[];
  /** Wrappers removed because the declaration no longer surfaces them. */
  commandsRemoved: string[];
  /**
   * Names deliberately not surfaced (req 20 — a collision, a reserved name, or
   * a name the agent container's PATH already resolves). Attributed to the
   * declared repository for the same reason `skillsFailed` is: this is the ONLY
   * surface that can carry the PATH-dependent half, which the snapshot cannot
   * recompute.
   */
  commandsRefused: PluginCommandIssue[];
  /** Wrappers that could not be written — reported, never fatal. */
  commandsFailed: PluginCommandIssue[];
}

export interface PreparePluginsOptions {
  workspaceDir: string;
  pluginsDir?: string;
  storeDir?: string;
  /** Where companion-CLI wrappers are written (reqs 17, 20). */
  binDir?: string;
  /** The `shipit` shim every wrapper execs. */
  shimPath?: string;
}

/**
 * Make every live plugin checkout reachable at `/plugins/<name>`, and remove
 * links the declaration no longer names. Idempotent, so it is safe on every
 * activation round and on every container start.
 *
 * Never throws — a repo that cannot be linked is reported, not fatal (req 13:
 * the session opens either way).
 */
export function preparePlugins(opts: PreparePluginsOptions): PluginPrepareResult {
  const pluginsDir = opts.pluginsDir ?? CONTAINER_PLUGINS_DIR;
  const storeDir = opts.storeDir ?? CONTAINER_PLUGIN_STORE_DIR;
  const result: PluginPrepareResult = {
    linked: [], missing: [], unlinked: [], linkFailed: [],
    skills: [], skillsRemoved: [], skillsFailed: [],
    commands: [], commandsRemoved: [], commandsRefused: [], commandsFailed: [],
  };

  const config = resolveShipitConfig(opts.workspaceDir);
  const wanted = new Set<string>();

  // ONE verified resolution per declared repository, shared by every half of
  // this pass. Both properties it carries are per-pass properties, so they have
  // to be established once and handed down rather than re-derived: a second
  // resolution can land in a different generation, and a half that skips the
  // identity check exposes what the others refused. Splitting this between the
  // links, the skills and the commands is exactly how the pass came to describe
  // two generations at once before.
  const live = new Map<string, LiveGeneration>();
  const resolve = (repo: DeclaredPluginRepo): LiveGeneration => {
    if (!live.has(repo.name)) live.set(repo.name, resolveLiveCheckout(opts.workspaceDir, storeDir, repo));
    return live.get(repo.name)!;
  };
  const liveDir = (repo: DeclaredPluginRepo): string | null => resolve(repo).dir;

  for (const repo of config.plugins.repos) {
    // **`repo: self` gets no link, and that is the finished answer** (req 27),
    // not a gap. Its checkout is the session's own working tree, which the agent
    // already has at the workspace root — a second name for it buys nothing, and
    // `/plugins/<name>` is not a path a plugin author can rely on anyway, since
    // each consumer names the repository whatever it likes. What the plugin's
    // own code names is `/plugin`, which the CLI and service surfaces mount from
    // the working tree.
    //
    // Leaving it out of `wanted` is also what withdraws a link left by a
    // declaration that USED to be tracked under this name: `removeStaleLinks`
    // takes it, and nothing under the store is ever consulted for a self
    // declaration (see {@link resolveLiveCheckout}).
    if (repo.source.kind === "self") continue;
    wanted.add(repo.name);

    const target = path.join(storeDir, repo.name, "active");
    const generation = resolve(repo);
    if (generation.dir === null) {
      result.missing.push(repo.name);
      // A refusal explains itself; an ordinary "not fetched yet" does not need
      // to, because the card already renders that from the generation state.
      if (generation.refusal) {
        result.linkFailed.push({ repo: repo.name, reason: generation.refusal });
      }
      // A generation this session already linked can stop being exposable while
      // the declaration still names the repository — retired mid-refresh, or
      // re-pointed so that what is live belongs to the PREVIOUS repository.
      // `removeStaleLinks` does not cover either: the name is still declared,
      // so it is not stale. Left alone, `/plugins/<name>` keeps resolving to a
      // tree this declaration does not name, or survives dangling and lists
      // while being unreadable — presence claiming a plugin the card is
      // simultaneously reporting as unavailable (req 13). Dropping it is safe
      // because the next prepare re-links as soon as an owned generation is
      // published, and every activation round and container start fires one.
      //
      // A withdrawal that FAILS is reported, not swallowed: this whole path
      // exists to stop the agent reaching a tree it may not use, so "we could
      // not take it away" is the one outcome the card must not render as a
      // clean unavailable.
      const withdrawal = removeDeadLink(pluginsDir, repo.name, target);
      if (withdrawal) result.linkFailed.push({ repo: repo.name, reason: withdrawal });
      continue;
    }
    const failure = linkPlugin(pluginsDir, repo.name, target);
    if (failure) result.linkFailed.push({ repo: repo.name, reason: failure });
    else result.linked.push(repo.name);
  }

  // A repo dropped from the declaration must stop being addressable — including
  // when the block is emptied entirely, which is why this runs even when
  // nothing is declared.
  result.unlinked.push(...removeStaleLinks(pluginsDir, wanted));

  // req 22 — a checkout discloses nothing on its own, so each imported plugin's
  // skills are copied into every harness's discovery root. Same lifecycle as
  // the links: idempotent, and re-run on every activation round, which is what
  // makes a refresh take effect. Kept out of the user's repository by a
  // per-clone git exclude rather than by editing their `.gitignore`.
  // `from:` matches a declared repo case-insensitively (`plugin-repos.ts`), but
  // the checkout directory is named with the declaration's own spelling — so
  // resolve through the declaration rather than trusting the `use` entry's
  // case, which silently found nothing on a case-sensitive filesystem (review
  // finding).
  const declaredRepos = new Map(config.plugins.repos.map((r) => [r.name.toLowerCase(), r]));
  const sources = resolvePluginSkillSources(
    config.plugins.uses,
    (repoName) => {
      const declared = declaredRepos.get(repoName.toLowerCase());
      if (!declared) return null;
      const dir = liveDir(declared);
      // The declared spelling travels with the checkout: every downstream
      // failure is attributed to that repository's card, and the card is keyed
      // by the name as the declaration writes it.
      return dir ? { dir, repo: declared.name } : null;
    },
  );

  const plan = planPluginSkills(sources);
  result.skillsFailed.push(...plan.failed);
  const names = plan.planned.map((p) => p.name);

  // Order is load-bearing, in three steps.
  //
  // 1. SWEEP FIRST. The exclude lists exact directories, so narrowing it while
  //    a dropped skill still exists on disk opens a window where a concurrent
  //    `git add -A` stages it (review finding). Remove, then stop excluding.
  result.skillsRemoved.push(...sweepStalePluginSkills(opts.workspaceDir, new Set(names)));

  // 2. Rewrite the exclude block — ALWAYS, including to nothing. Skipping the
  //    rewrite when there is nothing planned left every old exclusion installed
  //    forever, where it could later hide a directory the user created with the
  //    same name (review finding).
  const excluded = !isGitRepo(opts.workspaceDir)
    || ensureGitExcludedBlock(
      opts.workspaceDir,
      PLUGIN_SKILL_EXCLUDE_BLOCK,
      pluginSkillExcludeEntries(names),
    );

  // 3. Only then write. Fail closed: if the exclude is not in force,
  //    materializing would put a copy of somebody else's repository into the
  //    user's next commit, which is the one thing req 22 rules out.
  if (!excluded) {
    // Attributed to every repository that had something planned, and to no
    // others: the exclude is one file, but the consequence is per repository —
    // "none were materialized" is only a degradation for a card that expected
    // skills. A repository with nothing planned is unaffected and must not grow
    // an issue about a mechanism it does not use.
    for (const repo of new Set(plan.planned.map((p) => p.repo))) {
      result.skillsFailed.push({
        repo,
        skill: "(all)",
        reason: "could not keep plugin skills out of this clone's git, so none were materialized",
      });
    }
  } else {
    const skills = materializePluginSkills(opts.workspaceDir, plan.planned);
    result.skills.push(...skills.materialized);
    result.skillsFailed.push(...skills.failed);
  }

  // reqs 17, 20 — the companion CLIs. Same lifecycle as the links and the
  // skills: idempotent, swept against the current declaration, re-run on every
  // round so a refresh reaches the agent. Deliberately independent of the git
  // exclude above — a wrapper lives outside the workspace and can never enter
  // the user's commit, so a repository whose exclude could not be written still
  // gets its commands.
  const commands = preparePluginCommands({
    workspaceDir: opts.workspaceDir,
    plugins: config.plugins,
    selfExports: config.pluginExports,
    // The same verified resolution the links and the skills used. Reading the
    // store again here is what made one prepare result describe two
    // generations, and it is also the half with no identity check at all — a
    // command name is put on the agent's PATH, so a foreign one is a name the
    // agent can run.
    checkoutFor: liveDir,
    ...(opts.binDir ? { binDir: opts.binDir } : {}),
    ...(opts.shimPath ? { shimPath: opts.shimPath } : {}),
  });
  result.commands.push(...commands.commands);
  result.commandsRemoved.push(...commands.removed);
  result.commandsRefused.push(...commands.refused);
  result.commandsFailed.push(...commands.failed);

  return result;
}

/**
 * The concrete generation directory this declaration may expose, or `null` when
 * there is none — nothing published yet, a link dangling mid-prune, or a
 * generation that belongs to a DIFFERENT repository than the declaration now
 * names.
 *
 * Two properties, and the pass depends on both.
 *
 * **One resolution.** `realpathSync` rather than `existsSync` + the symlink
 * path: one syscall answers "is there a live generation?" and "which one?", and
 * the caller holds a path no later swap can re-point. What it does NOT buy is a
 * directory that stays there — a refresh prunes the generation it replaces, so
 * a pass pinned to A can find A deleted mid-copy and report a write failure.
 * That is the intended trade: the unpinned code silently picked up B instead,
 * and a bounded, visible, self-healing failure beats a quiet mixed read
 * (req 13). The next prepare — which that same refresh round fires — sees B.
 *
 * **One identity.** Re-pointing a `repos:` entry at a different repository
 * leaves the previous repository's generation live under the same name until an
 * activation round retires it, and that round is fire-and-forget behind a fetch
 * that may take minutes or fail outright. Every ORCHESTRATOR reader refuses
 * such a generation by comparing the record's source against the declaration;
 * this side had no record check at all, so the generation the card correctly
 * refused was still the one the agent got — its files under `/plugins/<name>`,
 * its SKILL.md files in the agent's skill roots, its command names on PATH.
 * Skills are the sharpest of those: they are INSTRUCTIONS the agent follows,
 * from a repository this project's declaration no longer names, and req 19's
 * standing grant covers the repository the declaration names and no other.
 *
 * A record with NO source is refused for the same reason a foreign one is:
 * nothing can prove whose it is. The orchestrator deliberately keeps such a
 * generation on disk rather than deleting it (deleting would drop every plugin
 * in every live session on the first deploy, ahead of a fetch that may fail) —
 * refusing to EXPOSE it is what makes keeping it safe. It stops being refused
 * the moment a publish records a source, which is the next successful
 * activation round.
 */
interface LiveGeneration {
  /** The concrete generation directory, or `null` when none may be exposed. */
  dir: string | null;
  /**
   * Why a generation that EXISTS may not be used, as a complete sentence for
   * the card. Absent when there is simply nothing published — that is the
   * ordinary state, not a problem to report.
   */
  refusal?: string;
}

/**
 * The tree this declaration may be read from, whichever kind it is.
 *
 * **The `repo: self` answer to the identity question, stated rather than
 * incidental** (req 27). Every other reader of a plugin checkout proves whose it
 * is by comparing a generation record's `source` against the declaration. A self
 * declaration has no generation and therefore no record — so the question is not
 * "which record proves this one?" but "what may stand in for it?", and the
 * answer is: only the session's own working tree, by construction. Nothing under
 * the store is consulted for a self declaration, so a generation left there by a
 * declaration that used to be tracked under the same name cannot be linked,
 * cannot supply skills and cannot name a command — the case the check exists for
 * is answered by never looking.
 *
 * The tree is live and editable, which is the point of developing there: an edit
 * is visible to the next pass with nothing to refresh (req 27, and req 15 scopes
 * its exact-commit correspondence to tracked checkouts for exactly this reason).
 */
function resolveLiveCheckout(
  workspaceDir: string,
  storeDir: string,
  repo: DeclaredPluginRepo,
): LiveGeneration {
  if (repo.source.kind === "self") return { dir: workspaceDir };
  return resolveLiveGeneration(storeDir, repo);
}

function resolveLiveGeneration(storeDir: string, repo: DeclaredPluginRepo): LiveGeneration {
  let dir: string;
  try {
    dir = fs.realpathSync(path.join(storeDir, repo.name, "active"));
  } catch {
    // Nothing published, or a link dangling mid-prune. The ordinary state, and
    // the card already renders it as `unavailable` from the generation state.
    return { dir: null };
  }
  // Read from the RESOLVED directory, never through `active` again: the point
  // of pinning is that the record and the tree it describes are the same
  // generation.
  const source = readPluginGenerationSource(dir);
  if (source === destinationKey(repo.source)) return { dir };
  // Something IS published here and this session may not use it. That is not
  // the same as "nothing published", and it does not explain itself: `missing`
  // never leaves the worker (the orchestrator ingests only the failure lists),
  // so without a reason here the card would render a bare `unavailable` for a
  // state that is not "not fetched yet". Usually the failed activation that
  // caused it supplies its own reason, but that is transient in-memory state —
  // after an orchestrator restart, or when no round has run at all, this is the
  // only thing that can say why (req 13: reports that plugins are unavailable
  // *and why*).
  return {
    dir: null,
    refusal: source === null
      ? "the version on disk predates ShipIt recording which repository a version came from, so it cannot be"
        + " confirmed as this repository's. The next successful activation replaces it."
      : `the version on disk was published from \`${source}\`, which this declaration no longer names.`
        + " The next successful activation replaces it.",
  };
}

/**
 * Whether this workspace is a git clone at all. A standalone session with no
 * repository has no commit to pollute, so the exclude is moot there — and
 * refusing to materialize would deny it skills for a reason that does not
 * apply.
 */
function isGitRepo(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, ".git"));
}

/**
 * Drop `/plugins/<name>` entries this session no longer declares. Only symlinks
 * are removed: anything else under that path was not created here.
 */
function removeStaleLinks(pluginsDir: string, wanted: Set<string>): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || wanted.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(pluginsDir, entry.name));
      removed.push(entry.name);
    } catch (err) {
      console.warn(`[plugins] could not unlink ${entry.name}: ${getErrorMessage(err)}`);
    }
  }
  return removed;
}

/**
 * Drop `/plugins/<name>` when it is OUR link to a store path that no longer
 * resolves. Ownership is checked the same way `linkPlugin` checks it — the link
 * must point exactly where we would have pointed it — so a real directory, or a
 * link somebody else made, is left alone even when it is broken.
 *
 * Silent: the repository is already reported in `missing`, which is the
 * accurate statement of what the user needs to know. Reporting the removal as
 * `unlinked` would be false — that list means "the declaration no longer names
 * this repo", and here it still does.
 */
function removeDeadLink(pluginsDir: string, name: string, target: string): string | null {
  const link = path.join(pluginsDir, name);
  let current: string;
  try {
    current = fs.readlinkSync(link);
  } catch {
    return null; // No link, or not a link at all — nothing of ours to remove.
  }
  if (current !== target) return null;
  try {
    fs.unlinkSync(link);
    return null;
  } catch (err) {
    const reason = getErrorMessage(err);
    console.warn(`[plugins] could not withdraw ${link}: ${reason}`);
    return `\`${link}\` could not be removed and still points at a version this session may not use: ${reason}`;
  }
}

/**
 * Point `/plugins/<name>` at the read-only store. The link target is a path
 * that only exists inside this container, and BOTH hops resolve per access —
 * this symlink, then the store's own `active` symlink — so activating a new
 * generation on the host is visible here immediately, with no remount and no
 * container recreation (plan §2).
 *
 * Returns a reason on failure, `null` on success. It used to return a bare
 * boolean whose `false` was dropped on the floor, so a repository that never
 * became reachable rendered as a healthy card with nothing behind it.
 */
function linkPlugin(pluginsDir: string, name: string, target: string): string | null {
  const link = path.join(pluginsDir, name);
  try {
    fs.mkdirSync(pluginsDir, { recursive: true });
    // Replace only what we own. An existing correct link is left alone so a
    // re-prepare mid-turn never briefly breaks a path the agent is using.
    let current: string | null = null;
    try {
      current = fs.readlinkSync(link);
    } catch {
      current = null;
    }
    if (current === target) return null;
    if (current !== null) fs.unlinkSync(link);
    // A real file/dir — refuse to clobber it, and say so.
    else if (fs.existsSync(link)) return `\`${link}\` already exists and is not a link ShipIt made`;
    fs.symlinkSync(target, link);
    return null;
  } catch (err) {
    const reason = getErrorMessage(err);
    console.warn(`[plugins] could not link ${link}: ${reason}`);
    return reason;
  }
}
