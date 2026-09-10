import type { PluginExport, PluginUse } from "./plugin-repos.js";

export interface SurfacedPluginCommand {
  name: string;
  alias: string;
  repo: string | null;
  plugin: string;
  declared: string;
  /** Relative to the plugin repository root. */
  entry: string;
}

export interface PluginCommandPlan {
  commands: SurfacedPluginCommand[];
  issues: Map<string, string[]>;
}

export interface PluginCommandSource {
  repo: string | null;
  exported: PluginExport | null;
}

export interface PlanPluginCommandsOptions {
  /** Probe PATH outside the wrapper directory. */
  isTaken?: (name: string) => boolean;
  describeTaken?: (name: string) => string;
}

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

interface CommandClaim extends SurfacedPluginCommand {
  issueKey: string;
}

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

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return { commands, issues };
}

function findOverride(
  use: PluginUse,
  declared: string,
): { as?: string; ambiguous?: true } {
  const matches = Object.entries(use.overrides.commands)
    .filter(([name]) => name.toLowerCase() === declared.toLowerCase());
  if (matches.length > 1) return { ambiguous: true };
  return matches.length === 1 ? { ...(matches[0][1].as ? { as: matches[0][1].as } : {}) } : {};
}
