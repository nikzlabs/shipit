/**
 * docs/246 — the per-session **state dir**: where ShipIt's own generated
 * artifacts live, OUTSIDE the user's git clone.
 *
 * Every session's clone is mounted at `/workspace`, and ShipIt used to write its
 * generated artifacts into `<clone>/.shipit/` — where the post-turn `git add -A`
 * (`GitManager.autoCommit`) stages them into the user's repository. Only
 * ShipIt's own `.gitignore` hid them; no user repo has that line. This module
 * owns the replacement location and every filename that goes in it.
 *
 * The dir is `<sessionDir>/state/` — a sibling of `workspace/`, the same shape
 * docs/217 used for `scratch/` (`/persist`) and docs/138 for the per-session
 * credentials subtree (`/credentials`).
 *
 * **Derived from the clone path, and only from a layout that proves it.** A bare
 * `path.dirname(workspaceDir)` is not enough: the pre-`workspace/` flat layout
 * had `sessionDir === workspaceDir`, where `dirname` yields `sessionsRoot` and
 * every session's state would collide in one directory. So
 * {@link sessionStateDirForWorkspace} derives only when the clone sits at
 * `<sessionDir>/workspace` — the shape `createSessionDirFactory` guarantees —
 * and REFUSES anything else (SHI-286). One resolver, so the host side and the
 * container mount can never disagree about where a session's state lives.
 *
 * Nothing user-authored ever lived in a clone's `.shipit/`: the per-repo config
 * a human writes is `shipit.yaml` at the repo root, and `.shipit/system-prompt.md`
 * is a *global* setting read from the orchestrator's own workspace root, one
 * level above every clone. So the invariant is unconditional and has no
 * carve-outs — a `.shipit/` inside a session clone is a bug.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  COMPOSE_OVERRIDE_FILE,
  INSTALL_MARKER_FILE,
  CI_LOGS_SUBDIR,
  AGENT_ENV_FILE,
} from "../shared/fs-constants.js";

/** Directory name of the per-session state dir (sibling of `workspace/`). */
export const SESSION_STATE_SUBDIR = "state";

/**
 * Directory name of the per-session clone under the session dir. Shared with
 * `session-dir-factory.ts` so {@link sessionStateDirForWorkspace} is reading a
 * contract rather than guessing at a path convention.
 */
export const SESSION_WORKSPACE_SUBDIR = "workspace";

// The container mount point + artifact filenames live in `shared/fs-constants.ts`
// because the session layer needs them too and may not import from
// `orchestrator/`. Re-exported here so orchestrator callers have one import.
export {
  CONTAINER_SESSION_STATE_DIR,
  COMPOSE_OVERRIDE_FILE,
  INSTALL_MARKER_FILE,
  CI_LOGS_SUBDIR,
  AGENT_ENV_FILE,
} from "../shared/fs-constants.js";

/** Host path of a session's state dir, given its session dir. */
export function sessionStateDir(sessionDir: string): string {
  return path.join(sessionDir, SESSION_STATE_SUBDIR);
}

/**
 * Resolve a session's state dir from its **clone** path.
 *
 * Most call sites (`ServiceManager`, the runner, the container mount) only ever
 * receive the clone path — `runner.sessionDir` is itself the workspace dir,
 * since runners are created with `session.workspaceDir`
 * (`route-registry.ts`) — so this is the single contract all of them share.
 *
 * It derives ONLY when the clone sits at `<sessionDir>/workspace`, which
 * `createSessionDirFactory` guarantees for every session it creates: the two
 * sides share {@link SESSION_WORKSPACE_SUBDIR}.
 *
 * **Anything else throws** (SHI-286). The two alternatives were both worse. A
 * bare `path.dirname` fallback re-creates the bug this contract was written to
 * kill: a flat-layout clone (`<sessionsRoot>/<id>`) resolves to
 * `<sessionsRoot>/state`, one directory shared by every such session on the
 * host, with a single `.install-done` between them. And the fallback this
 * replaced — return `null`, let the caller keep writing into the clone — is the
 * placement docs/246 exists to end; it is what forced req 1 to carry an
 * allowlist. A production census (SHI-286: 307 rows, `flat == 0`, archived
 * included) found no session of that shape, and the accepted consequence of
 * refusing is that a database carrying one would be **unserviceable rather than
 * degraded**. Failing here names that at the point of resolution instead of
 * silently handing back a path that is wrong for every caller.
 */
export function sessionStateDirForWorkspace(workspaceDir: string): string {
  if (path.basename(workspaceDir) !== SESSION_WORKSPACE_SUBDIR) {
    throw new Error(
      `[session-state] cannot resolve a state dir for clone ${workspaceDir}: expected it to sit at `
        + `<sessionDir>/${SESSION_WORKSPACE_SUBDIR}. Sessions created before that layout are no longer `
        + "serviceable (SHI-286).",
    );
  }
  return sessionStateDir(path.dirname(workspaceDir));
}

/**
 * The subdirectory of the state dir that is MOUNTED into the session container
 * at {@link CONTAINER_SESSION_STATE_DIR}.
 *
 * Only the artifacts the worker or the agent must reach live here — the install
 * marker and fetched CI logs. The orchestrator-only artifacts (the compose
 * override, `.env.agent`) stay in the state dir's root, which is NOT mounted, so
 * "orchestrator-side only" is a property of the layout rather than a claim in a
 * doc. Mounting the whole state dir would have put `.env.agent` inside the
 * container namespace while the design said it wasn't.
 */
export const SESSION_STATE_SHARED_SUBDIR = "shared";

/** Host path of the container-visible slice of a session's state dir. */
export function sessionSharedStateDir(stateDir: string): string {
  return path.join(stateDir, SESSION_STATE_SHARED_SUBDIR);
}

/**
 * The generated names earlier ShipIt versions wrote into `<clone>/.shipit/`.
 * Used by {@link sweepLegacyCloneArtifacts} — NOT a list of current write
 * targets.
 */
export const LEGACY_CLONE_ARTIFACTS: readonly string[] = [
  COMPOSE_OVERRIDE_FILE,
  INSTALL_MARKER_FILE,
  CI_LOGS_SUBDIR,
  AGENT_ENV_FILE,
  // SHI-285 — Docker-secrets mode used to copy its entrypoint wrapper here so
  // the compose override could mount it through the workspace volume; it is
  // staged in the secrets root now. Deliberately a literal, not the constant
  // the staging code uses: this is the name OLD versions wrote, and renaming
  // the current file must not silently change what the sweep removes.
  "secrets-entrypoint.sh",
];

/**
 * Remove ShipIt's generated artifacts from a clone's `.shipit/` (docs/246 req 6)
 * and drop the directory when nothing else is left in it.
 *
 * Working tree only. Copies a user already committed are deliberately left
 * alone and not announced — ShipIt cannot rewrite someone's history, and the
 * files are inert once it stops writing them (resolved question, 2026-08-03).
 *
 * Only the names in {@link LEGACY_CLONE_ARTIFACTS} are removed, never the
 * directory wholesale: a user is free to keep their own files under `.shipit/`,
 * and an `rm -rf` of a directory in someone's repo is not a cleanup we get to
 * do on their behalf.
 *
 * **Tracked paths are never swept.** Matching on filename alone is not proof of
 * provenance — a repository may legitimately commit a `.shipit/ci-logs/` or a
 * `.shipit/compose.override.yml` of its own. Deleting one would be silent (the
 * next auto-commit records the deletion) and unrecoverable from the user's point
 * of view. `git ls-files` is the provenance check: anything git tracks belongs
 * to the user, whatever it is called. ShipIt's own leftovers are untracked in
 * every repo that didn't commit them, which is the case this sweep exists for.
 *
 * Best-effort throughout — a sweep failure must never block session boot.
 *
 * Returns the names actually removed (for logging/tests).
 */
/**
 * Does git track anything at `relPath` (a file, or any path under it)? Errors —
 * not a repo, no git binary, no HEAD — answer "unknown", and we treat unknown as
 * TRACKED: refusing to delete is always recoverable, deleting is not.
 */
function isTrackedByGit(workspaceDir: string, relPath: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch (err) {
    // Exit 1 with no match is the common, expected case: untracked → sweepable.
    if ((err as { status?: number }).status === 1) return false;
    return true; // anything else is unknown → keep the file
  }
}

export function sweepLegacyCloneArtifacts(workspaceDir: string): string[] {
  const shipitDir = path.join(workspaceDir, ".shipit");
  const removed: string[] = [];

  for (const name of LEGACY_CLONE_ARTIFACTS) {
    const target = path.join(shipitDir, name);
    try {
      if (!fs.existsSync(target)) continue;
      if (isTrackedByGit(workspaceDir, `.shipit/${name}`)) {
        console.warn(
          `[session-state] not sweeping tracked path .shipit/${name} — it belongs to the repo, not ShipIt`,
        );
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      console.warn(`[session-state] failed to sweep ${target}:`, err);
    }
  }

  // Drop `.shipit/` itself only when our sweep emptied it — `rmdir` fails on a
  // non-empty dir, which is exactly the guard we want for a user's own files.
  try {
    if (removed.length > 0) fs.rmdirSync(shipitDir);
  } catch {
    // Non-empty (user files remain) or already gone — both fine.
  }

  return removed;
}
