/**
 * docs/262 reqs 17, 20 — which companion-CLI commands a session surfaces, and
 * which ones it **refuses** because their name is ambiguous.
 *
 * Pure and filesystem-free, because the answer is needed on both sides of the
 * container edge and the two must not disagree:
 *
 *  - the **orchestrator** reports refusals on the Plugins tab's card
 *    (`plugin-commands.ts`), from the declaration plus each live generation's
 *    manifest — so a collision is visible before anything runs;
 *  - the **session** generates the PATH wrappers (`session/plugin-cli.ts`) from
 *    exactly the same plan, plus one thing only it can know: what the agent
 *    container's PATH already resolves.
 *
 * Same shape as `resolvePluginSettings` (`plugin-state.ts`) and for the same
 * reason: the refusal has to be recomputable from the declaration and the live
 * manifest, so the snapshot GET can state it without having run a round.
 *
 * ## Why a collision refuses EVERY claimant
 *
 * Req 20 says ShipIt "reports the collision before running the ambiguous one".
 * First-declared-wins is what the requirement rules out — it is precisely the
 * silent last-one-wins failure mode with the order reversed, and the loser's
 * author has no way to know their command never ran. So when two imports claim
 * one name, neither gets a wrapper: the name is ambiguous, and running either
 * would be a guess. The fix is in the declaration
 * (`overrides.commands.<name>.as`), which is the second half of req 20.
 *
 * Repo-name collisions upstream of this DO use first-declared-wins
 * (`plugin-repos.ts`), and the difference is deliberate: there the loser is
 * dropped whole and says so, while here both claimants stay live and only the
 * one contested name is withheld.
 */

import type { PluginExport, PluginUse } from "./plugin-repos.js";

/** One command a session puts on the agent's PATH. */
export interface SurfacedPluginCommand {
  /** The name the wrapper is written under — after any `overrides.commands.<x>.as`. */
  name: string;
  /** The importing `use:` entry's alias — the unit the invocation is keyed by. */
  alias: string;
  /** The declaring repository's own spelling, or null when `from:` names none. */
  repo: string | null;
  /** The exported plugin this command belongs to. */
  plugin: string;
  /** The command name as the plugin's manifest declares it. */
  declared: string;
  /** The entrypoint, relative to the plugin repository root (manifest-validated). */
  entry: string;
}

export interface PluginCommandPlan {
  /** Commands that may be surfaced. Refused ones are absent, never renamed. */
  commands: SurfacedPluginCommand[];
  /**
   * Why a command was refused, grouped by the declared repository the import
   * came from — the unit the card draws (plan §3).
   *
   * **A `Map`, not an object.** Declared repository names are unconstrained
   * enough to include `constructor` and `toString`, which on a plain object
   * read back as inherited functions for a repository with no issues at all —
   * the defect `pluginSettingsIssuesByRepo` already had to fix.
   */
  issues: Map<string, string[]>;
}

/** What one `use:` entry points at. Mirrors `PluginImportResolver`'s two halves. */
export interface PluginCommandSource {
  /** The declared repository's OWN spelling, or null when `from:` names none. */
  repo: string | null;
  /**
   * The manifest entry behind the import, or null when it is not knowable — an
   * unfetched repository, or a selector the manifest lacks. Null contributes
   * nothing: "there is no manifest yet" is not a command problem, and the
   * missing-selector case is already stated once on the card.
   */
  exported: PluginExport | null;
}

export interface PlanPluginCommandsOptions {
  /**
   * Whether a name is already resolvable outside the wrapper directory. The
   * session passes a PATH probe; the orchestrator passes nothing, because it
   * has no PATH to probe and must not invent one.
   */
  isTaken?: (name: string) => boolean;
  /** How a taken name is described on the card. Defaults to a generic phrase. */
  describeTaken?: (name: string) => string;
}

/**
 * Names a plugin may never surface, whatever PATH happens to hold.
 *
 * The PATH probe is the real check and this list does not duplicate it — this
 * exists so the **orchestrator** can report the worst of these on the card
 * before any container is running, and so a name stays refused even in a
 * container where the binary happens to be missing. It is deliberately short:
 * ShipIt's own agent surface, the version-control and package tooling an agent
 * relies on, and the shell.
 */
export const RESERVED_PLUGIN_COMMANDS: ReadonlySet<string> = new Set([
  "shipit",
  "shipit-git-credential",
  "gh",
  "git",
  "sh",
  "bash",
  "env",
  "sudo",
  "su",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "pip",
  "pip3",
  "docker",
  "claude",
  "codex",
]);

/** A claim on one surfaced name, before collisions are known. */
interface CommandClaim extends SurfacedPluginCommand {
  /** Where a refusal for this claim is reported. */
  issueKey: string;
}

/**
 * Resolve every `use:` entry's commands into a plan.
 *
 * Never throws and never partially surfaces: a name that cannot be surfaced
 * unambiguously is left off `commands` and explained in `issues`.
 */
export function planPluginCommands(
  uses: readonly PluginUse[],
  sourceFor: (use: PluginUse) => PluginCommandSource,
  opts: PlanPluginCommandsOptions = {},
): PluginCommandPlan {
  const issues = new Map<string, string[]>();
  const addIssue = (key: string, message: string): void => {
    issues.set(key, [...(issues.get(key) ?? []), message]);
  };

  const claims: CommandClaim[] = [];

  for (const use of uses) {
    const { repo, exported } = sourceFor(use);
    const issueKey = repo ?? use.from;
    if (!exported) continue;

    const declaredCommands = new Map(
      Object.entries(exported.cli).map(([name, entry]) => [name.toLowerCase(), { name, entry }]),
    );

    // An `as:` for a command the plugin does not export. An error rather than a
    // silent no-op, for the reason `resolvePluginSettings` gives: the project
    // asked for something, would have got the plugin's own name instead, and
    // could not tell from inside the session which one it got.
    for (const name of Object.keys(use.overrides.commands)) {
      if (declaredCommands.has(name.toLowerCase())) continue;
      addIssue(
        issueKey,
        `\`${use.alias}\`: \`${name}\` is not a command \`${exported.name}\` exports, `
        + "so the rename this project sets would have no effect.",
      );
    }

    for (const [declared, entry] of Object.entries(exported.cli)) {
      const override = findOverride(use, declared);
      if (override.ambiguous) {
        addIssue(
          issueKey,
          `\`${use.alias}\`: \`overrides.commands\` renames \`${declared}\` more than once `
          + "(the keys differ only in case), so it is not on PATH. Keep one.",
        );
        continue;
      }
      claims.push({
        name: override.as ?? declared,
        alias: use.alias,
        repo,
        plugin: exported.name,
        declared,
        entry,
        issueKey,
      });
    }
  }

  // Domain 5 of the naming phases (plan §1a): surfaced command names, across
  // every plugin. Case-normalized like every other reservation domain here —
  // two commands differing only in case are not a distinction a user can hold.
  const byName = new Map<string, CommandClaim[]>();
  for (const claim of claims) {
    const key = claim.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), claim]);
  }

  const commands: SurfacedPluginCommand[] = [];
  for (const [, group] of byName) {
    const first = group[0];

    if (group.length > 1) {
      const claimants = group.map((c) => `\`${c.alias}\``).join(", ");
      for (const claim of group) {
        addIssue(
          claim.issueKey,
          `Command \`${claim.name}\` is claimed by more than one plugin (${claimants}), so none of `
          + "them is on PATH. Rename one under the `use` entry whose alias is "
          + `\`${claim.alias}\` — \`overrides.commands.${claim.declared}.as\`.`,
        );
      }
      continue;
    }

    if (RESERVED_PLUGIN_COMMANDS.has(first.name.toLowerCase())) {
      addIssue(
        first.issueKey,
        `Command \`${first.name}\` is a name ShipIt reserves, so it is not on PATH. Rename it `
        + `under the \`use\` entry whose alias is \`${first.alias}\` — `
        + `\`overrides.commands.${first.declared}.as\`.`,
      );
      continue;
    }

    if (opts.isTaken?.(first.name)) {
      const what = opts.describeTaken?.(first.name) ?? "a program that is already on PATH";
      addIssue(
        first.issueKey,
        `Command \`${first.name}\` would shadow ${what}, so it is not on PATH. Rename it under `
        + `the \`use\` entry whose alias is \`${first.alias}\` — `
        + `\`overrides.commands.${first.declared}.as\`.`,
      );
      continue;
    }

    commands.push({
      name: first.name,
      alias: first.alias,
      repo: first.repo,
      plugin: first.plugin,
      declared: first.declared,
      entry: first.entry,
    });
  }

  // Stable, declaration-independent ordering: the wrapper directory is swept
  // against this list and the card renders it, and neither should churn because
  // a map's insertion order changed.
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, issues };
}

/**
 * The consumer's rename for one declared command, matched case-insensitively —
 * the same rule `from:` and `plugin:` selectors use, so a project cannot lose a
 * rename to a capitalization the manifest happens to prefer.
 *
 * Two keys that differ only in case are **ambiguous, not a tie to break**
 * (review finding): the parser accepts `reqs:` and `REQS:` as distinct YAML
 * keys, and picking the first match would let declaration order silently decide
 * which rename applies. `{ ambiguous: true }` refuses the command instead, for
 * the same reason a contested name refuses every claimant — a command whose
 * name was chosen by something the user cannot see is not one to run.
 */
function findOverride(
  use: PluginUse,
  declared: string,
): { as?: string; ambiguous?: true } {
  const matches = Object.entries(use.overrides.commands)
    .filter(([name]) => name.toLowerCase() === declared.toLowerCase());
  if (matches.length > 1) return { ambiguous: true };
  return matches.length === 1 ? { ...(matches[0][1].as ? { as: matches[0][1].as } : {}) } : {};
}
