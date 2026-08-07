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
 * and REFUSES anything else (planning#288). One resolver, so the host side and the
 * container mount can never disagree about where a session's state lives.
 *
 * Nothing user-authored ever lived in a clone's `.shipit/`: the per-repo config
 * a human writes is `shipit.yaml` at the repo root, and `.shipit/system-prompt.md`
 * is a *global* setting read from the orchestrator's own workspace root, one
 * level above every clone. So the invariant is unconditional and has no
 * carve-outs — a `.shipit/` inside a session clone is a bug.
 */

import path from "node:path";

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
 * **Anything else throws** (planning#288). The two alternatives were both worse. A
 * bare `path.dirname` fallback re-creates the bug this contract was written to
 * kill: a flat-layout clone (`<sessionsRoot>/<id>`) resolves to
 * `<sessionsRoot>/state`, one directory shared by every such session on the
 * host, with a single `.install-done` between them. And the fallback this
 * replaced — return `null`, let the caller keep writing into the clone — is the
 * placement docs/246 exists to end; it is what forced req 1 to carry an
 * allowlist. A production census (planning#288: 307 rows, `flat == 0`, archived
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
        + "serviceable (planning#288).",
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
