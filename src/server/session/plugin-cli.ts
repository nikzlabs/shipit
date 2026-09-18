// Wrappers invoke the ShipIt broker; plugin code must not run beside worker credentials.

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGIN_BIN_DIR } from "../shared/plugin-contract.js";
import { planPluginCommands, type SurfacedPluginCommand } from "../shared/plugin-cli.js";
import type { DeclaredPluginRepo, PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { getErrorMessage } from "../shared/utils.js";
import { readCheckoutExports } from "./plugin-skills.js";

export const DEFAULT_SHIM_PATH = "/usr/local/bin/shipit";

// Only marked files may be overwritten or removed, regardless of their directory.
export const WRAPPER_MARKER = "# shipit-plugin-command v1";

export interface PluginCommandIssue {
  repo: string;
  reason: string;
}

export interface PluginCommandPrepareResult {
  commands: string[];
  removed: string[];
  refused: PluginCommandIssue[];
  failed: PluginCommandIssue[];
}

export interface PreparePluginCommandsOptions {
  workspaceDir: string;
  plugins: PluginReposConfig;
  selfExports: readonly PluginExport[];
  /** Caller-verified generation, shared with skills/links for this pass; null forbids use. */
  checkoutFor: (repo: DeclaredPluginRepo) => string | null;
  binDir?: string;
  shimPath?: string;
  pathEnv?: string;
}

export function preparePluginCommands(
  opts: PreparePluginCommandsOptions,
): PluginCommandPrepareResult {
  const binDir = opts.binDir ?? CONTAINER_PLUGIN_BIN_DIR;
  const shimPath = opts.shimPath ?? DEFAULT_SHIM_PATH;
  const result: PluginCommandPrepareResult = {
    commands: [], removed: [], refused: [], failed: [],
  };

  ensureOnPath(binDir);

  const plan = buildPlan(opts, binDir);
  for (const [repo, issues] of plan.issues) {
    result.refused.push(...issues.map((reason) => ({ repo, reason })));
  }

  const wanted = new Map(plan.commands.map((c) => [c.name, c]));

  result.removed.push(...sweepWrappers(binDir, new Set(wanted.keys())));

  if (wanted.size > 0 && !isExecutable(shimPath)) {
    for (const command of wanted.values()) {
      result.failed.push({
        repo: command.repo ?? "",
        reason: `\`${command.name}\` is not on PATH: the \`shipit\` shim is not installed at ${shimPath}.`,
      });
    }
    return result;
  }

  for (const command of wanted.values()) {
    const outcome = writeWrapper(binDir, shimPath, command);
    if (outcome === null) result.commands.push(command.name);
    else result.failed.push({ repo: command.repo ?? "", reason: `\`${command.name}\` is not on PATH: ${outcome}` });
  }
  return result;
}

function buildPlan(
  opts: PreparePluginCommandsOptions,
  binDir: string,
): ReturnType<typeof planPluginCommands> {
  const declared = new Map(opts.plugins.repos.map((r) => [r.name.toLowerCase(), r]));
  const manifests = new Map<string, PluginExport[]>();

  const exportsFor = (repoKey: string): PluginExport[] => {
    if (!manifests.has(repoKey)) {
      const repo = declared.get(repoKey);
      manifests.set(
        repoKey,
        !repo
          ? []
          : repo.source.kind === "self"
            ? [...opts.selfExports]
            : readCheckoutExports(opts.checkoutFor(repo)),
      );
    }
    return manifests.get(repoKey)!;
  };

  const takenBy = new Map<string, string>();
  return planPluginCommands(
    opts.plugins.uses,
    (use) => {
      const key = use.from.toLowerCase();
      const repo = declared.get(key);
      return {
        repo: repo?.name ?? null,
        exported: exportsFor(key).find((e) => e.name.toLowerCase() === use.plugin.toLowerCase()) ?? null,
      };
    },
    {
      isTaken: (name) => {
        const found = resolveOnPath(name, opts.pathEnv ?? process.env.PATH ?? "", binDir);
        if (found) takenBy.set(name, found);
        return found !== null;
      },
      describeTaken: (name) => `\`${takenBy.get(name) ?? name}\``,
    },
  );
}

// Exclude our directory so previous wrappers do not collide with themselves.
function resolveOnPath(name: string, pathEnv: string, binDir: string): string | null {
  const resolvedBin = path.resolve(binDir);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || path.resolve(dir) === resolvedBin) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function wrapperScript(shimPath: string, command: SurfacedPluginCommand): string {
  return [
    "#!/bin/sh",
    WRAPPER_MARKER,
    `# ShipIt companion CLI: \`${command.declared}\` from plugin \`${command.plugin}\``,
    "# Generated — edits are overwritten on the next plugin activation round.",
    `exec ${shimPath} plugin exec --alias '${command.alias}' --command '${command.declared}' -- "$@"`,
    "",
  ].join("\n");
}

function writeWrapper(
  binDir: string,
  shimPath: string,
  command: SurfacedPluginCommand,
): string | null {
  if (!SAFE_ARG_RE.test(command.alias) || !SAFE_ARG_RE.test(command.declared)) {
    return "its alias or command name is not a plain identifier";
  }
  const target = path.join(binDir, command.name);
  const body = wrapperScript(shimPath, command);
  try {
    fs.mkdirSync(binDir, { recursive: true });
    const existing = readIfPresent(target);
    if (existing !== null && !isOurs(existing)) {
      return `${target} already exists and was not created by ShipIt`;
    }
    if (existing === body && isMode(target, 0o755)) return null;
    // Atomic replacement prevents concurrent exec from reading a partial script.
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return null;
  } catch (err) {
    return getErrorMessage(err);
  }
}

// Validate again at the shell boundary; quoted arguments must exclude shell syntax.
const SAFE_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readIfPresent(target: string): string | null {
  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

function isOurs(content: string): boolean {
  return content.split("\n", 3).includes(WRAPPER_MARKER);
}

function isMode(target: string, mode: number): boolean {
  try {
    return (fs.statSync(target).mode & 0o777) === mode;
  } catch {
    return false;
  }
}

function sweepWrappers(binDir: string, wanted: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || wanted.has(entry.name)) continue;
    const target = path.join(binDir, entry.name);
    const content = readIfPresent(target);
    if (content === null || !isOurs(content)) continue;
    try {
      fs.rmSync(target, { force: true });
      removed.push(entry.name);
    } catch (err) {
      console.warn(`[plugins] could not remove wrapper ${target}: ${getErrorMessage(err)}`);
    }
  }
  return removed;
}

// Append to avoid shadowing system commands. /etc/profile.d handles login shells.
export function ensureOnPath(binDir: string): void {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (current.some((dir) => path.resolve(dir) === path.resolve(binDir))) return;
  process.env.PATH = [...current, binDir].join(path.delimiter);
}

export function ensurePluginBinOnPath(): void {
  ensureOnPath(CONTAINER_PLUGIN_BIN_DIR);
}
