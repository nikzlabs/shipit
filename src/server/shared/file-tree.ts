import fs from "node:fs/promises";
import path from "node:path";
import type { FileTreeNode } from "./types.js";

import { isWorkspaceSkipDir, WORKSPACE_HIDDEN_FILES } from "./fs-constants.js";

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
    if (isWorkspaceSkipDir(entry.name)) continue;
    if (WORKSPACE_HIDDEN_FILES.has(entry.name)) continue;

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

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}
