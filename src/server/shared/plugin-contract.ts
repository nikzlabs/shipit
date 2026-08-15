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

/**
 * Where the plugin's own tree — the generation's checkout merged with its
 * install output — is mounted in every container that runs plugin code: the
 * install container (`plugin-install.ts`), a CLI invocation
 * (`plugin-cli-run.ts`), and a plugin service. One path, because a plugin's
 * `cli:` entrypoints are declared relative to its repository root and must
 * resolve identically on every surface.
 */
export const CONTAINER_PLUGIN_DIR = "/plugin";

/**
 * The consuming project's workspace, at the fixed path req 21 promises: the
 * same in every project, nameable by a plugin repository that knows nothing
 * about its consumers. Present in service and CLI containers; deliberately
 * absent from the install container, which gets the plugin's tree and nothing
 * else (plan §1b).
 */
export const CONTAINER_PROJECT_DIR = "/project";

/** Env var naming the project workspace on both surfaces (req 21). */
export const PLUGIN_PROJECT_ENV = "SHIPIT_PROJECT_DIR";

/**
 * Env var carrying the exact commit the running plugin was built from (req 15
 * — "readable by the plugin itself", so a plugin can decide whether a version
 * change invalidates a cache it keeps). **Unset under `repo: self`**: a live
 * working tree corresponds to no exact commit, and an absent variable is how a
 * plugin tells the two apart.
 */
export const PLUGIN_COMMIT_ENV = "SHIPIT_PLUGIN_COMMIT";

/**
 * The environment names ShipIt itself sets in every container that runs plugin
 * code — the in-session usage contract, as a set.
 *
 * A plugin may not declare a credential (req 23) under one of these names: the
 * two delivery surfaces would answer differently and neither answer is
 * specified. The compose surface drops such a name defensively when it merges
 * delivered values (`compose-generator.ts`), while the CLI surface appends the
 * credential as a second `Env` entry after ShipIt's own, whose resolution is
 * the daemon's business rather than a decision anyone took. Nothing crosses a
 * boundary either way — the mounts are the same — so this is a coherence
 * defect, and the fix belongs where both surfaces inherit one answer: the
 * manifest parser refuses the declaration (`plugin-repos.ts`), so the plugin
 * author is told at declaration time instead of a name being silently ignored
 * on one surface and duplicated on the other.
 */
export const PLUGIN_CONTRACT_ENV_NAMES: ReadonlySet<string> = new Set([
  PLUGIN_STATE_ENV,
  PLUGIN_SETTINGS_ENV,
  PLUGIN_PROJECT_ENV,
  PLUGIN_COMMIT_ENV,
]);

/**
 * Where generated companion-CLI wrappers live inside the **agent** container
 * (req 17). A directory of ShipIt-authored shell wrappers — no plugin code, and
 * no plugin credential, ever lands here; each wrapper brokers an invocation
 * container instead (plan §2, "CLIs").
 *
 * It is **appended** to `PATH`, never prepended. The collision check (req 20)
 * already refuses to write a wrapper whose name resolves anywhere else on PATH,
 * so appending costs a surfaced command nothing — and if that check is ever
 * wrong, the ordering means a plugin still cannot shadow `git`.
 */
export const CONTAINER_PLUGIN_BIN_DIR = "/plugin-bin";
