/**
 * Directories to skip when scanning workspace file trees, watching for changes,
 * or searching for markdown files. Shared across file-tree, file-watcher, and
 * markdown scanners to keep the ignore lists consistent.
 */
/**
 * Mount point for the session workspace inside containers.
 * The session directory is bind-mounted here for both session and preview containers.
 */
export const CONTAINER_WORKSPACE_DIR = "/workspace";

/**
 * docs/246 — mount point for ShipIt's per-session **state dir** inside session
 * containers. Holds ShipIt's own generated artifacts (the install marker,
 * fetched CI logs) so they no longer sit in the user's git clone, where the
 * post-turn `git add -A` staged them into their repository.
 *
 * Lives in `shared/` rather than beside the orchestrator's host-path helpers
 * (`orchestrator/session-state-dir.ts`) because BOTH layers need it and session
 * code may not import from `orchestrator/`.
 */
export const CONTAINER_SESSION_STATE_DIR = "/session-state";

/**
 * Mount point for the shared per-repo dependency cache inside session
 * containers (docs/075). Same "both layers need it" rationale as the state dir
 * above: the orchestrator builds the mount, and session code (docs/248's Node
 * toolchain cache) needs the container-side path without importing from
 * `orchestrator/`. Re-exported from `container-lifecycle.ts` for its existing
 * importers.
 */
export const DEP_CACHE_CONTAINER_PATH = "/dep-cache";

/**
 * docs/262 — where a session's plugin checkouts appear inside the agent
 * container. Two paths, and **both are read-only**: the agent container never
 * gets a writable view of a plugin checkout at any path (req 7). Plugin code
 * that must write runs elsewhere, against a copy-on-write overlay volume
 * (plan §1b).
 *
 * - {@link CONTAINER_PLUGINS_DIR} — the **agent-facing** surface, and the only
 *   one a plugin author or an agent should ever be told about. Holds one
 *   symlink per declared repo, pointing into the store below.
 * - {@link CONTAINER_PLUGIN_STORE_DIR} — the session's whole plugin root. The
 *   symlinks resolve through it, so swapping a generation's `active` link on
 *   the host is visible in-container at once (req 12's refresh, with no
 *   container recreation). Mounting a generation directly would instead pin
 *   whichever one was live at container creation, since Docker resolves a bind
 *   source's symlinks then.
 */
export const CONTAINER_PLUGINS_DIR = "/plugins";
export const CONTAINER_PLUGIN_STORE_DIR = "/plugin-store";

/** Generated compose merge file (`docker compose -f … -f <this>`). */
export const COMPOSE_OVERRIDE_FILE = "compose.override.yml";
/** Install-skip marker, written in-container after `agent.install` succeeds. */
export const INSTALL_MARKER_FILE = ".install-done";
/** Fetched CI failure logs, read by the agent during a CI fix. */
export const CI_LOGS_SUBDIR = "ci-logs";
/** Agent-container env file (`agent: true` values + MCP credentials). */
export const AGENT_ENV_FILE = ".env.agent";

export const WORKSPACE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vibe-chat-history",
  "dist",
  ".next",
  ".cache",
  ".vite",
  // ShipIt-in-ShipIt (feature 118): in local mode the inner orchestrator
  // creates per-session clones under `sessions/`, writes secret env files
  // into `.shipit/`, and stores its own SQLite db / caches under
  // `.inner-shipit/`. Excluding these keeps the outer file watcher from
  // flooding on inner-agent edits, and prevents inner-orch metadata from
  // ever appearing in the outer file tree.
  "sessions",
  ".shipit",
  ".inner-shipit",
  // docs/150 — the non-root entrypoint drops a UID-stamped sentinel DIR into
  // each writable mount (incl. /workspace in prod) to make the boot-time
  // `chown -R` a one-shot. It's an empty dir, so git never commits it (git
  // doesn't track empty dirs), but hide it from the file tree / watcher so it
  // isn't surfaced as workspace noise. Keep in sync with entrypoint.sh.
  ".shipit-uid-1000",
]);

/**
 * Individual files (not directories) hidden from the workspace file tree.
 *
 * Dotfiles are shown by default — `.npmrc`, `.gitignore`, `.dockerignore`,
 * `.editorconfig`, rc files, etc. are real, editable source and belong in the
 * tree exactly like VS Code shows them. This is a *minimal* deny-list for pure
 * junk and ShipIt-internal session data that the user never edits:
 *
 *   - `.DS_Store` — macOS Finder metadata, never source.
 *   - `.shipit-usage.json` / `.vibe-sessions.json` — ShipIt's own per-session
 *     bookkeeping written into the workspace root (mirrors `IGNORE_FILES` in
 *     `file-watcher.ts`); surfacing them would just be noise.
 *
 * Directory-level noise (`.git`, `.cache`, `.next`, `.vite`, `sessions`,
 * `.shipit`, `.inner-shipit`, …) is handled by `WORKSPACE_SKIP_DIRS` above,
 * not here. Keep this list short and well-justified — see
 * docs/096-claude-skills-access/plan.md for why the old allowlist model was
 * replaced with show-by-default.
 */
export const WORKSPACE_HIDDEN_FILES = new Set([
  ".DS_Store",
  ".shipit-usage.json",
  ".vibe-sessions.json",
]);
