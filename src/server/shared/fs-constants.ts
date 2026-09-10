export const CONTAINER_WORKSPACE_DIR = "/workspace";
export const CONTAINER_SESSION_STATE_DIR = "/session-state";
export const DEP_CACHE_CONTAINER_PATH = "/dep-cache";
export const CONTAINER_CREDENTIALS_DIR = "/credentials";

// Both are read-only. Mount the whole store so active-link changes remain visible.
export const CONTAINER_PLUGINS_DIR = "/plugins";
export const CONTAINER_PLUGIN_STORE_DIR = "/plugin-store";

export const COMPOSE_OVERRIDE_FILE = "compose.override.yml";
export const INSTALL_MARKER_FILE = ".install-done";
export const CI_LOGS_SUBDIR = "ci-logs";
export const AGENT_ENV_FILE = ".env.agent";

export const WORKSPACE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vibe-chat-history",
  "dist",
  ".next",
  ".cache",
  ".vite",
  "sessions",
  ".shipit",
  ".inner-shipit",
]);

export const SESSION_UID_SENTINEL_PREFIX = ".shipit-uid-";

export function isWorkspaceSkipDir(name: string): boolean {
  return WORKSPACE_SKIP_DIRS.has(name) || name.startsWith(SESSION_UID_SENTINEL_PREFIX);
}

export const WORKSPACE_HIDDEN_FILES = new Set([
  ".DS_Store",
  ".shipit-usage.json",
  ".vibe-sessions.json",
]);

/** Credential copies preserved after failed publication: <name>.stranded-<epoch ms>. */
export const STRANDED_CREDENTIAL_MARKER = ".stranded-";

export function isStrandedCredentialOf(name: string, base: string): boolean {
  if (!name.startsWith(`${base}${STRANDED_CREDENTIAL_MARKER}`)) return false;
  return /^\d+$/.test(name.slice(base.length + STRANDED_CREDENTIAL_MARKER.length));
}
