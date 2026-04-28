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
]);

/**
 * Hidden entries (names starting with `.`) that ARE shown in the file tree
 * despite the default "skip dotfiles" rule. Skills, env files, and (where
 * present) project-level Claude config are part of the codebase and should be
 * editable from the IDE. See docs/096-claude-skills-access/plan.md.
 */
export const WORKSPACE_HIDDEN_ALLOWLIST = new Set([
  ".env",
  ".env.local",
  ".claude",
]);
