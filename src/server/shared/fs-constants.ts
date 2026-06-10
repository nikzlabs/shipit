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
