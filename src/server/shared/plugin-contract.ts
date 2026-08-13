/**
 * docs/262 — the names the in-session usage contract fixes (plan §2), for the
 * two primitives every imported plugin gets: its **shared state directory**
 * (reqs 17, 18) and its **validated settings file** (req 26).
 *
 * They live here, filesystem-free and layer-free, because the two consumers sit
 * on opposite sides of the container edge and must not disagree: the
 * orchestrator builds the mounts and the environment, and session-side code
 * (CLI wrapper generation) needs the same strings without importing from
 * `orchestrator/`. Host paths are NOT here — those are
 * `orchestrator/plugin-state.ts`, which owns the layout on disk.
 *
 * **Both surfaces get the same env names** (plan §2): a companion CLI is handed
 * paths in the container it runs in, a service is handed the paths its mounts
 * land on, and the plugin's own code reads one variable either way. That is what
 * lets the fixture's single report builder run on both surfaces
 * (`test-plugin/lib/report.mjs`).
 */

/**
 * Where a plugin's shared state directory is mounted inside a plugin *service*
 * container. Read-write: this is the one place a plugin may keep session-scoped
 * state (req 18), and the only writable surface it gets that is neither the
 * read-only checkout (req 7) nor the project's own files.
 */
export const CONTAINER_PLUGIN_STATE_DIR = "/plugin-state";

/**
 * Where the validated settings file is mounted inside a plugin *service*
 * container. Deliberately NOT inside {@link CONTAINER_PLUGIN_STATE_DIR}: that
 * directory is writable by the plugin, and a plugin that can rewrite its own
 * validated settings has settings that were never validated.
 */
export const CONTAINER_PLUGIN_SETTINGS_FILE = "/plugin-settings.json";

/** Env var naming the shared state directory on both surfaces (reqs 17, 18). */
export const PLUGIN_STATE_ENV = "SHIPIT_PLUGIN_STATE";

/** Env var naming the validated settings JSON on both surfaces (req 26). */
export const PLUGIN_SETTINGS_ENV = "SHIPIT_SETTINGS";
