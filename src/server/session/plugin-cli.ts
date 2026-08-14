/**
 * docs/262 reqs 17, 20 — put an imported plugin's companion CLI on the agent's
 * PATH, as generated wrappers.
 *
 * **Nothing a plugin wrote runs here.** A wrapper is ShipIt's own four-line
 * shell script; it execs the `shipit` shim, which brokers an invocation
 * container (`orchestrator/plugin-cli-run.ts`) holding the plugin's merged
 * tree, `/project`, its state directory and only its declared credentials. That
 * split is the same boundary `install` has (plan §1b) and exists for the same
 * reason: this container can reach the worker's loopback credential broker
 * (`/agent-ops/*`, no token required), so req 19 cannot hold for anything
 * plugin-authored that runs beside it. Req 17 only promises the agent can
 * invoke the command *inside the project session* — it says nothing about
 * sharing the agent's container, and a transparent wrapper keeps the promised
 * UX either way.
 *
 * **The refusal, not the rename, is the collision policy** (req 20). Which
 * names are ambiguous is decided by the pure planner every surface shares
 * (`shared/plugin-cli.ts`); this module adds the one input only it has — what
 * the agent container's PATH already resolves — and then writes wrappers for
 * what survives. A refused name gets no wrapper at all, and the Plugins tab
 * says why (`orchestrator/plugin-commands.ts` recomputes the same plan).
 *
 * Lifecycle mirrors the skills materializer beside it: idempotent, re-run on
 * every activation round and on every container start, sweeping what the
 * declaration no longer names — which is what makes a refresh (req 12) reach
 * the agent without recreating its container.
 */

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGIN_STORE_DIR } from "../shared/fs-constants.js";
import { CONTAINER_PLUGIN_BIN_DIR } from "../shared/plugin-contract.js";
import { planPluginCommands, type SurfacedPluginCommand } from "../shared/plugin-cli.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { getErrorMessage } from "../shared/utils.js";
import { readCheckoutExports } from "./plugin-skills.js";

/** The `shipit` shim every wrapper execs. Baked into the session-worker image. */
export const DEFAULT_SHIM_PATH = "/usr/local/bin/shipit";

/**
 * Second line of every generated wrapper, and the ONLY thing that makes a file
 * in the wrapper directory ours.
 *
 * Checked by content rather than by location, for the reason `plugin-skills.ts`
 * gives for its marker: this module deletes what it owns, and "it is in the
 * directory we use" is not ownership — a user or a base image could have put
 * something there. A file without this line is never overwritten and never
 * swept; its name is reported as unavailable instead.
 */
export const WRAPPER_MARKER = "# shipit-plugin-command v1";

/**
 * One thing that could not be surfaced, attributed to a plugin card.
 *
 * Same shape as `PluginSkillFailure` and for the same reason: the orchestrator
 * turns these into card issues (`readPrepareFailures`), and a failure it cannot
 * attribute to a declared repository has nowhere to render. That matters more
 * here than for skills — the snapshot recomputes cross-plugin and reserved-name
 * refusals from the declaration, but the PATH-shadow half is knowable ONLY
 * inside this container, so this list is its only route to the user.
 */
export interface PluginCommandIssue {
  /** Declared repository the card belongs to. */
  repo: string;
  /** Complete sentence, naming the command and the fix. */
  reason: string;
}

export interface PluginCommandPrepareResult {
  /** Command names now on PATH. */
  commands: string[];
  /** Wrappers removed because the declaration no longer surfaces them. */
  removed: string[];
  /** Names deliberately not surfaced (req 20 — claimed twice, reserved, or already on PATH). */
  refused: PluginCommandIssue[];
  /** Wrappers that could not be written — reported, never fatal (req 13). */
  failed: PluginCommandIssue[];
}

export interface PreparePluginCommandsOptions {
  workspaceDir: string;
  /** Parsed consumer block — passed in so this shares the caller's single read. */
  plugins: PluginReposConfig;
  /** The project's OWN manifest, for `repo: self` imports (req 27). */
  selfExports: readonly PluginExport[];
  binDir?: string;
  storeDir?: string;
  shimPath?: string;
  /** PATH to probe for collisions. Defaults to the worker's own. */
  pathEnv?: string;
}

/**
 * Generate (and sweep) the wrapper directory. Never throws: a command that
 * cannot be surfaced is reported, and the session opens either way (req 13).
 */
export function preparePluginCommands(
  opts: PreparePluginCommandsOptions,
): PluginCommandPrepareResult {
  const binDir = opts.binDir ?? CONTAINER_PLUGIN_BIN_DIR;
  const storeDir = opts.storeDir ?? CONTAINER_PLUGIN_STORE_DIR;
  const shimPath = opts.shimPath ?? DEFAULT_SHIM_PATH;
  const result: PluginCommandPrepareResult = {
    commands: [], removed: [], refused: [], failed: [],
  };

  // Appended, never prepended — see CONTAINER_PLUGIN_BIN_DIR. Idempotent, and
  // deliberately re-asserted here as well as at worker construction: this call
  // covers a non-default directory (tests) and the case where something else
  // rewrote PATH between the two.
  ensureOnPath(binDir);

  const plan = buildPlan(opts, storeDir, binDir);
  for (const [repo, issues] of plan.issues) {
    result.refused.push(...issues.map((reason) => ({ repo, reason })));
  }

  const wanted = new Map(plan.commands.map((c) => [c.name, c]));

  // Sweep BEFORE writing, and for the same ordering reason the skills
  // materializer sweeps first: a name that moved from one plugin to another
  // must not be briefly served by the old wrapper.
  result.removed.push(...sweepWrappers(binDir, new Set(wanted.keys())));

  if (wanted.size > 0 && !isExecutable(shimPath)) {
    // Fail closed and say so. A wrapper execing a shim that is not there would
    // surface as `command not found` from inside the plugin's own name — which
    // reads as a broken plugin rather than a missing ShipIt surface.
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

/**
 * Resolve each import's manifest and run the shared planner.
 *
 * A `repo: self` import reads the project's own parsed manifest (its exports
 * live in the same file — req 27); a tracked import reads the LIVE generation's
 * manifest out of its checkout, which is what a refresh changes. `from:`
 * matches a declared repo case-insensitively while the checkout directory
 * carries the declaration's own spelling, so the lookup goes through the
 * declaration — the defect `plugin-runtime.ts` had to fix for skills.
 */
function buildPlan(
  opts: PreparePluginCommandsOptions,
  storeDir: string,
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
            : readCheckoutExports(activeCheckout(storeDir, repo.name)),
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

/**
 * Resolve a declared repository's live generation to a CONCRETE directory, once.
 *
 * `active` is a symlink an activation round re-points, so handing back the link
 * unresolved leaves every later read following it again — and a refresh landing
 * between two of them yields one prepare result describing two generations.
 * One `realpathSync` and no preceding `existsSync`: the missing-link case is
 * the exception branch precisely so the check and the read cannot straddle a
 * swap. With the memo in {@link buildPlan}, that is one resolution per declared
 * repository per pass.
 *
 * Whether the generation it lands on came from the repository the declaration
 * NOW names is a separate axis, and it is deliberately not checked here: the
 * generation record lives in the orchestrator's tree, which
 * `src/server/session/` never imports. The container side is guarded instead by
 * activation clearing `active` for a re-pointed declaration before it fetches —
 * which is why that retirement is load-bearing here rather than redundant with
 * the orchestrator's own reader checks.
 */
function activeCheckout(storeDir: string, repoName: string): string | null {
  try {
    return fs.realpathSync(path.join(storeDir, repoName, "active"));
  } catch {
    return null;
  }
}

/**
 * Where else on PATH `name` already resolves, or null.
 *
 * The wrapper directory itself is excluded: a wrapper this module wrote on a
 * previous round is not a collision with anything, and counting it would make
 * every command disappear on the second pass.
 */
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

/** The wrapper's whole body. Everything variable in it is parser-validated. */
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

/**
 * Write one wrapper, or say why not.
 *
 * `alias` and `command` are single-quoted into a `sh` line, so they are checked
 * against the parser's own grammar first. That grammar already excludes quotes,
 * spaces and every shell metacharacter — this is the assertion that a later
 * loosening of it cannot silently become a command-injection surface here.
 */
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
    // Written then renamed: a turn may exec this path while a round rewrites
    // it, and a partially written script is a syntax error rather than an old
    // command. `rename(2)` over an existing file is atomic on the same
    // filesystem, which the wrapper directory always is.
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

/** The grammar `plugin-repos.ts` enforces — re-asserted at the shell boundary. */
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

/**
 * Drop wrappers the declaration no longer surfaces — and ONLY wrappers this
 * module wrote. A command dropped from a manifest, renamed by an override, or
 * newly refused as a collision must stop being on PATH in the same round that
 * decided it; leaving it would run a plugin the session no longer imports.
 */
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

/**
 * Put the wrapper directory LAST on this process's PATH, so everything the
 * worker spawns — the agent CLI, the terminal — can reach a surfaced command.
 *
 * Login shells are covered separately by a baked `/etc/profile.d` snippet:
 * Codex runs every tool command as `bash -lc`, and Debian's `/etc/profile`
 * overwrites PATH outright (the same mechanism docs/248 needed for the Node
 * pin).
 */
export function ensureOnPath(binDir: string): void {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (current.some((dir) => path.resolve(dir) === path.resolve(binDir))) return;
  process.env.PATH = [...current, binDir].join(path.delimiter);
}

/**
 * Assert the default wrapper directory on PATH, whatever has happened so far.
 *
 * Called once at worker construction as well as from every prepare round:
 * everything the worker spawns inherits `process.env.PATH` at spawn time, and
 * nothing orders the first prepare before the first agent process.
 */
export function ensurePluginBinOnPath(): void {
  ensureOnPath(CONTAINER_PLUGIN_BIN_DIR);
}
