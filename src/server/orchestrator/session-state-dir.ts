import path from "node:path";

export const SESSION_STATE_SUBDIR = "state";
export const SESSION_WORKSPACE_SUBDIR = "workspace";
/** Mounted at /persist in the agent container and, on request, in compose services (docs/317). */
export const SESSION_SCRATCH_SUBDIR = "scratch";

export {
  CONTAINER_SESSION_STATE_DIR,
  COMPOSE_OVERRIDE_FILE,
  INSTALL_MARKER_FILE,
  CI_LOGS_SUBDIR,
  AGENT_ENV_FILE,
} from "../shared/fs-constants.js";

export function sessionStateDir(sessionDir: string): string {
  return path.join(sessionDir, SESSION_STATE_SUBDIR);
}

// A flat-layout clone would resolve to a state directory shared by every session.
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

export function sessionScratchDirForWorkspace(workspaceDir: string): string {
  return path.join(path.dirname(sessionStateDirForWorkspace(workspaceDir)), SESSION_SCRATCH_SUBDIR);
}

/** ShipIt's own Compose files for this session's starts (docs/318-compose-remaining-escapes). */
export const SESSION_COMPOSE_SUBDIR = "compose";

export function composeStateDirForWorkspace(workspaceDir: string): string {
  return path.join(sessionStateDirForWorkspace(workspaceDir), SESSION_COMPOSE_SUBDIR);
}

// Mount only this subtree; the root contains orchestrator-only files such as .env.agent.
export const SESSION_STATE_SHARED_SUBDIR = "shared";

export function sessionSharedStateDir(stateDir: string): string {
  return path.join(stateDir, SESSION_STATE_SHARED_SUBDIR);
}
