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
 * **Threaded, never derived.** `ServiceManager` holds only `workspaceDir`, so
 * the tempting shortcut is `path.dirname(workspaceDir)`. That is wrong: the
 * legacy flat layout has `sessionDir === workspaceDir`
 * (`container-lifecycle.ts`), where `dirname` yields `sessionsRoot` and every
 * session's state collides in one directory. Callers that know the session dir
 * resolve the path with {@link sessionStateDir} and pass it down explicitly,
 * exactly as docs/183 threaded `serviceEnvDir`.
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
 * Resolve a session's state dir from its **clone** path, or `null` when the
 * layout doesn't prove where the session dir is.
 *
 * Most call sites (`ServiceManager`, the runner) only ever receive the clone
 * path — `runner.sessionDir` is itself the workspace dir, since runners are
 * created with `session.workspaceDir` (`route-registry.ts`). A bare
 * `path.dirname` is unsafe there: under the legacy flat layout
 * (`sessionDir === workspaceDir`) it yields `sessionsRoot`, and every session's
 * state would collide in one directory.
 *
 * So this derives ONLY when the clone sits at `<sessionDir>/workspace`, which
 * `createSessionDirFactory` guarantees for every session it creates — the two
 * sides share {@link SESSION_WORKSPACE_SUBDIR}. Anything else returns `null`,
 * and the caller keeps its legacy behavior rather than writing state to a
 * guessed location. The right long-term fix is a `stateDir` on the session
 * record; this contract avoids a schema migration for the same guarantee on
 * every session the current factory creates.
 */
export function sessionStateDirForWorkspace(workspaceDir: string): string | null {
  if (path.basename(workspaceDir) !== SESSION_WORKSPACE_SUBDIR) return null;
  return sessionStateDir(path.dirname(workspaceDir));
}

/**
 * Resolve the state dir a CONTAINER should mount, or `null` when the session's
 * layout can't place one safely.
 *
 * Deliberately derived from the **clone path only**, via the same
 * {@link sessionStateDirForWorkspace} contract the host-side callers use, so the
 * two can never disagree about where a session's state lives.
 *
 * The earlier version took the caller's `sessionDir` and only checked that the
 * result wasn't *inside* the clone. That check passed for a shape production
 * actually produces: the runner factory derives `sessionDir =
 * path.dirname(session.workspaceDir)` (`app-lifecycle.ts`), so a legacy FLAT
 * session (clone = `<sessionsRoot>/<id>`) resolved to `<sessionsRoot>/state` —
 * outside that clone, so it passed, but **shared by every flat session on the
 * host**. Every such session would have mounted one directory and shared a
 * single `.install-done`, while host callers (which use the clone-path contract)
 * looked somewhere else entirely.
 *
 * Deriving from one place removes the whole class: either a session has a state
 * dir that both sides agree on, or it has none and keeps its legacy in-clone
 * placement.
 */
export function resolveContainerStateDir(workspaceDir: string | undefined): string | null {
  if (!workspaceDir) return null;
  const resolved = sessionStateDirForWorkspace(workspaceDir);
  if (!resolved) return null;
  // Belt and braces: never hand back a path inside the clone.
  const rel = path.relative(path.resolve(workspaceDir), path.resolve(resolved));
  const insideClone = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return insideClone ? null : resolved;
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
