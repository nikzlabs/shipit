/**
 * Make OpenCode's XDG data dir exist before the orchestrator spawns the CLI
 * (docs/268).
 *
 * OpenCode keeps `auth.json` and its `opencode.db` session store under
 * `$HOME/.local/share/opencode`, and creates that directory during bootstrap —
 * before it does any work. Both ShipIt images turn that path into a **symlink**
 * into the credentials volume so a login survives a container restart:
 *
 *     /root/.local/share/opencode -> /credentials/.local/share/opencode
 *
 * Nothing else creates the target. `.claude` / `.codex` are single-segment, so a
 * plain `mkdir -p /credentials/.claude` materializes them; `.local/share/opencode`
 * is three deep, and no code path walks it. The link therefore DANGLES on a fresh
 * volume, and a dangling symlink is the one case where creating the directory
 * does not merely work:
 *
 *   - `mkdir(2)` returns **EEXIST** for a path that exists as a dangling
 *     symlink — the link is an entry, so the name is taken. This is true for
 *     root as well; it is a namespace collision, not a permission check, and no
 *     capability changes it.
 *   - Node's `{recursive: true}` converts that to ENOENT (it stats and finds
 *     nothing) but still refuses. OpenCode's Bun runtime surfaces the raw errno,
 *     so the process dies with
 *     `EEXIST: file already exists, mkdir '/home/shipit/.local/share/opencode'`
 *     and exit 1 — the production symptom that motivated this.
 *
 * So the fix is not "mkdir -p the path": that is exactly what fails. Resolve the
 * link and create what it POINTS AT.
 *
 * The session container has the same symlink and solves it at boot, in
 * `docker/session-worker/entrypoint.sh`, where it must additionally run as the
 * worker (that mount is sealed 0700 to the session's own uid and the container
 * drops DAC_OVERRIDE). Here in the orchestrator we are the owner, so an ordinary
 * mkdir is enough — only the symlink hop is shared.
 *
 * Best-effort: a naming run that cannot prepare the dir will fail on its own and
 * fall back to a derived title, which is a better outcome than throwing out of a
 * fire-and-forget path.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Ensure `<home>/.local/share/opencode` is a usable directory, following a
 * symlink at the leaf. Returns the path actually created (the link's target when
 * there is one), or `null` if it could not be prepared.
 */
export function ensureOpencodeDataDir(home: string): string | null {
  const dir = path.join(home, ".local", "share", "opencode");

  // `lstat`, not `stat`: the whole point is to see the LINK rather than the
  // (missing) thing it names.
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  let target = dir;
  if (stat?.isSymbolicLink()) {
    try {
      // Resolved against the link's own directory, so a relative target works.
      target = path.resolve(path.dirname(dir), fs.readlinkSync(dir));
    } catch (err) {
      console.warn(`[opencode] could not read the symlink at ${dir}:`, err);
      return null;
    }
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch (err) {
    console.warn(`[opencode] could not prepare the data dir ${target}:`, err);
    return null;
  }
}
