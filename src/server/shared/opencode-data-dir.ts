/**
 * Make OpenCode's XDG data dir exist before ShipIt spawns the CLI (docs/268).
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
 * **Two mechanisms, deliberately, because they have different jobs.**
 *
 *   - `docker/session-worker/entrypoint.sh` prepares it once at container boot,
 *     via gosu as the worker (the mount is sealed 0700 to the session's own uid
 *     and the container drops DAC_OVERRIDE, so root cannot). That covers
 *     everything in the container, including an `opencode` the user runs in the
 *     terminal panel — which passes through no spawn site of ours.
 *   - This helper covers the spawn itself, which is what makes local/dogfood
 *     mode work: there is no container there and so no entrypoint, while the
 *     orchestrator image carries the same symlink at `/root`. Inside a container
 *     it is an idempotent directory read.
 *
 * What it must **not** be used for is a spawn whose HOME is the flat credentials
 * root (`namingHome()` with no account — `/root` in the orchestrator). Creating
 * the dir there would flip `copyCredentialPath`'s "no source" early-return and
 * start copying the orchestrator's own OpenCode session store into every
 * session's credential subtree, which is the isolation docs/138 exists to
 * provide. OpenCode is key-mode only (docs/268 req 5), so a credential-less
 * spawn wants a scratch `XDG_DATA_HOME` instead — see `session-namer.ts`.
 *
 * Best-effort: a caller that cannot prepare the dir will fail on its own, which
 * beats throwing out of a fire-and-forget path.
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
