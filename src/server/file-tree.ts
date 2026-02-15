import fs from "node:fs/promises";
import path from "node:path";
import type { FileTreeNode } from "./types.js";

/** Directories to skip when scanning the workspace file tree. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vibe-chat-history",
  "dist",
  ".next",
  ".cache",
  ".vite",
]);

/**
 * Recursively scan a directory and return a tree of FileTreeNode objects.
 *
 * - Directories come before files (sorted alphabetically within each group)
 * - Skips common noise directories (node_modules, .git, dist, etc.)
 * - Paths are relative to the workspace root
 */
export async function scanFileTree(dir: string, prefix = ""): Promise<FileTreeNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: FileTreeNode[] = [];
  const files: FileTreeNode[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    // Skip hidden files/dirs (except common ones like .env)
    if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.local") continue;

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = await scanFileTree(path.join(dir, entry.name), relativePath);
      dirs.push({
        name: entry.name,
        path: relativePath,
        type: "directory",
        children,
      });
    } else {
      files.push({
        name: entry.name,
        path: relativePath,
        type: "file",
      });
    }
  }

  // Sort directories first, then files, both alphabetically
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}
