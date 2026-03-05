import fs from "node:fs/promises";
import path from "node:path";

import { WORKSPACE_SKIP_DIRS } from "../shared/fs-constants.js";

/**
 * Recursively find `.md` files in a directory, skipping `node_modules` and `.git`.
 *
 * Returns paths relative to `dir`, sorted alphabetically.
 * Example: `["ARCHITECTURE.md", "docs/setup.md"]`
 */
export async function findMarkdownFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...await findMarkdownFiles(path.join(dir, entry.name), relativePath));
    } else if (entry.name.endsWith(".md")) {
      results.push(relativePath);
    }
  }

  return results.sort();
}
