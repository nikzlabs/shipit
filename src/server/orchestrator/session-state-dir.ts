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

/** Directory name of the per-session state dir (sibling of `workspace/`). */
export const SESSION_STATE_SUBDIR = "state";

/**
 * Directory name of the per-session clone under the session dir. Shared with
 * `session-dir-factory.ts` so {@link sessionStateDirForWorkspace} is reading a
 * contract rather than guessing at a path convention.
 */
export const SESSION_WORKSPACE_SUBDIR = "workspace";

/**
 * Mount point of the state dir inside the session container. Only the artifacts
 * the *worker* or the *agent* must reach are exposed here; orchestrator-only
 * artifacts (the compose override, the agent env file) stay unmounted.
 */
export const CONTAINER_SESSION_STATE_DIR = "/session-state";

/** Generated compose merge file (`docker compose -f … -f <this>`). */
export const COMPOSE_OVERRIDE_FILE = "compose.override.yml";
/** Install-skip marker, written in-container after `agent.install` succeeds. */
export const INSTALL_MARKER_FILE = ".install-done";
/** Fetched CI failure logs, read by the agent during a CI fix. */
export const CI_LOGS_SUBDIR = "ci-logs";
/** Agent-container env file (`agent: true` values + MCP credentials). */
export const AGENT_ENV_FILE = ".env.agent";

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
 * The generated names earlier ShipIt versions wrote into `<clone>/.shipit/`.
 * Used by {@link sweepLegacyCloneArtifacts} — NOT a list of current write
 * targets.
 */
export const LEGACY_CLONE_ARTIFACTS: readonly string[] = [
  COMPOSE_OVERRIDE_FILE,
  INSTALL_MARKER_FILE,
  CI_LOGS_SUBDIR,
  AGENT_ENV_FILE,
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
 * do on their behalf. Best-effort throughout — a sweep failure must never block
 * session boot.
 *
 * Returns the names actually removed (for logging/tests).
 */
export function sweepLegacyCloneArtifacts(workspaceDir: string): string[] {
  const shipitDir = path.join(workspaceDir, ".shipit");
  const removed: string[] = [];

  for (const name of LEGACY_CLONE_ARTIFACTS) {
    const target = path.join(shipitDir, name);
    try {
      if (!fs.existsSync(target)) continue;
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
