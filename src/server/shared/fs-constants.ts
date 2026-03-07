/**
 * Directories to skip when scanning workspace file trees, watching for changes,
 * or searching for markdown files. Shared across file-tree, file-watcher, and
 * markdown scanners to keep the ignore lists consistent.
 */
/**
 * Mount point for the session workspace inside containers.
 * The session directory is bind-mounted here for both session and preview containers.
 */
export const CONTAINER_WORKSPACE_DIR = "/user";

export const WORKSPACE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vibe-chat-history",
  "dist",
  ".next",
  ".cache",
  ".vite",
]);
