import fs from "node:fs/promises";
import path from "node:path";

import { WORKSPACE_SKIP_DIRS } from "../shared/fs-constants.js";
import type { DocEntry, DocStatus } from "../shared/types.js";

/** Valid doc statuses. */
const VALID_STATUSES = new Set<DocStatus>(["planned", "in-progress", "done", "paused"]);

/**
 * Extract YAML frontmatter `status` field from markdown content.
 * Uses simple regex — no heavy YAML library needed.
 *
 * Supports:
 *   ---
 *   status: in-progress
 *   ---
 */
export function parseStatusFromFrontmatter(content: string): DocStatus | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return undefined;

  const frontmatter = match[1];
  const statusMatch = /^status:\s*(.+)$/m.exec(frontmatter);
  if (!statusMatch) return undefined;

  const raw = statusMatch[1].trim().toLowerCase();
  if (VALID_STATUSES.has(raw as DocStatus)) {
    return raw as DocStatus;
  }
  return undefined;
}

/**
 * Extract YAML frontmatter `title` field from markdown content.
 */
function parseTitleFromFrontmatter(content: string): string | undefined {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return undefined;

  const frontmatter = match[1];
  const titleMatch = /^title:\s*(.+)$/m.exec(frontmatter);
  if (!titleMatch) return undefined;

  return titleMatch[1].trim();
}

/**
 * Derive a human-readable title from a file path.
 * Uses frontmatter `title:` if available, otherwise converts the filename
 * from kebab-case to title case.
 */
function deriveTitle(relativePath: string, frontmatterContent?: string): string {
  if (frontmatterContent) {
    const fmTitle = parseTitleFromFrontmatter(frontmatterContent);
    if (fmTitle) return fmTitle;
  }

  const basename = path.basename(relativePath, ".md");
  return basename
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Recursively find `.md` files in a directory, skipping `node_modules` and `.git`.
 *
 * Returns `DocEntry[]` sorted alphabetically by path. Each entry includes
 * an optional `status` parsed from YAML frontmatter.
 */
export async function findMarkdownFiles(dir: string, prefix = ""): Promise<DocEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: DocEntry[] = [];

  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      results.push(...await findMarkdownFiles(path.join(dir, entry.name), relativePath));
    } else if (entry.name.endsWith(".md")) {
      // Read a small portion of the file to check for frontmatter
      let content: string | undefined;
      try {
        const handle = await fs.open(path.join(dir, entry.name), "r");
        try {
          const buf = Buffer.alloc(512);
          const { bytesRead } = await handle.read(buf, 0, 512, 0);
          content = buf.toString("utf-8", 0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch {
        // Can't read file — skip frontmatter parsing
      }

      const status = content ? parseStatusFromFrontmatter(content) : undefined;
      const title = deriveTitle(relativePath, content);

      results.push({ path: relativePath, status, title });
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
