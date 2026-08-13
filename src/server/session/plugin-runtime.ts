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
 * The declaration is readable at `/workspace/shipit.yaml`, so the orchestrator
 * only has to say *when*, never *what*.
 */

import fs from "node:fs";
import path from "node:path";
import { CONTAINER_PLUGINS_DIR, CONTAINER_PLUGIN_STORE_DIR } from "../shared/fs-constants.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { getErrorMessage } from "../shared/utils.js";

export interface PluginPrepareResult {
  /** Repos that got a `/plugins/<name>` entry. */
  linked: string[];
  /** Declared but with no live generation yet — activation may still be running. */
  missing: string[];
  /** Links removed because the declaration no longer names that repo. */
  unlinked: string[];
}

export interface PreparePluginsOptions {
  workspaceDir: string;
  pluginsDir?: string;
  storeDir?: string;
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
  const result: PluginPrepareResult = { linked: [], missing: [], unlinked: [] };

  const config = resolveShipitConfig(opts.workspaceDir);
  const wanted = new Set<string>();

  for (const repo of config.plugins.repos) {
    // `repo: self` runs the live working tree and has no generation (req 27);
    // its consumer-path parity is its own piece of work.
    if (repo.source.kind === "self") continue;
    wanted.add(repo.name);

    const target = path.join(storeDir, repo.name, "active");
    if (!fs.existsSync(target)) {
      result.missing.push(repo.name);
      continue;
    }
    if (linkPlugin(pluginsDir, repo.name, target)) result.linked.push(repo.name);
  }

  // A repo dropped from the declaration must stop being addressable — including
  // when the block is emptied entirely, which is why this runs even when
  // nothing is declared.
  result.unlinked.push(...removeStaleLinks(pluginsDir, wanted));
  return result;
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
 * Point `/plugins/<name>` at the read-only store. The link target is a path
 * that only exists inside this container, and BOTH hops resolve per access —
 * this symlink, then the store's own `active` symlink — so activating a new
 * generation on the host is visible here immediately, with no remount and no
 * container recreation (plan §2).
 */
function linkPlugin(pluginsDir: string, name: string, target: string): boolean {
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
    if (current === target) return true;
    if (current !== null) fs.unlinkSync(link);
    else if (fs.existsSync(link)) return false; // a real file/dir — refuse to clobber
    fs.symlinkSync(target, link);
    return true;
  } catch (err) {
    console.warn(`[plugins] could not link ${link}: ${getErrorMessage(err)}`);
    return false;
  }
}
