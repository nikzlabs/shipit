export const CONTAINER_PLUGIN_STATE_DIR = "/plugin-state";
// Keep validated settings outside writable plugin state.
export const CONTAINER_PLUGIN_SETTINGS_FILE = "/plugin-settings.json";
export const PLUGIN_STATE_ENV = "SHIPIT_PLUGIN_STATE";
export const PLUGIN_SETTINGS_ENV = "SHIPIT_SETTINGS";
export const CONTAINER_PLUGIN_DIR = "/plugin";
export const CONTAINER_PROJECT_DIR = "/project";
export const PLUGIN_PROJECT_ENV = "SHIPIT_PROJECT_DIR";
/** Unset for repo: self, whose working tree has no exact commit. */
export const PLUGIN_COMMIT_ENV = "SHIPIT_PLUGIN_COMMIT";
export const PLUGIN_PORT_ENV = "SHIPIT_PLUGIN_PORT";

export const PLUGIN_CONTRACT_ENV_NAMES: ReadonlySet<string> = new Set([
  PLUGIN_STATE_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_PROJECT_ENV,
  PLUGIN_COMMIT_ENV,
  PLUGIN_PORT_ENV,
]);

// Append to PATH so wrappers cannot shadow existing commands.
export const CONTAINER_PLUGIN_BIN_DIR = "/plugin-bin";
