import fs from "node:fs/promises";
import path from "node:path";
import type { FileTreeNode } from "./types.js";

import { WORKSPACE_SKIP_DIRS, WORKSPACE_HIDDEN_ALLOWLIST } from "./fs-constants.js";

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
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    // Skip hidden files/dirs except those explicitly allowed (e.g. .env, .claude)
    if (entry.name.startsWith(".") && !WORKSPACE_HIDDEN_ALLOWLIST.has(entry.name)) continue;

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
