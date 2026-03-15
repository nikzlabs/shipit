import fs from "node:fs/promises";
import path from "node:path";

import { WORKSPACE_SKIP_DIRS } from "../shared/fs-constants.js";
import type { DocEntry, DocStatus } from "../shared/types.js";

/** Valid doc statuses. */
const VALID_STATUSES = new Set<DocStatus>(["planned", "in-progress", "done", "paused"]);

/** Frontmatter regex — matches `---\n...\n---` at start of file. */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

/**
 * Extract the YAML frontmatter block from markdown content.
 * Returns the raw frontmatter string (without delimiters), or undefined.
 */
function extractFrontmatter(content: string): string | undefined {
  return FRONTMATTER_RE.exec(content)?.[1];
}

/**
 * Extract `status` from a frontmatter block.
 */
export function parseStatusFromFrontmatter(content: string): DocStatus | undefined {
  const fm = extractFrontmatter(content);
  if (!fm) return undefined;

  const statusMatch = /^status:\s*(.+)$/m.exec(fm);
  if (!statusMatch) return undefined;

  const raw = statusMatch[1].trim().toLowerCase();
  if (VALID_STATUSES.has(raw as DocStatus)) {
    return raw as DocStatus;
  }
  return undefined;
}

/**
 * Parse both status and title from frontmatter in a single extraction.
 */
function parseFrontmatterFields(content: string): { status?: DocStatus; title?: string } {
  const fm = extractFrontmatter(content);
  if (!fm) return {};

  let status: DocStatus | undefined;
  const statusMatch = /^status:\s*(.+)$/m.exec(fm);
  if (statusMatch) {
    const raw = statusMatch[1].trim().toLowerCase();
    if (VALID_STATUSES.has(raw as DocStatus)) {
      status = raw as DocStatus;
    }
  }

  let title: string | undefined;
  const titleMatch = /^title:\s*(.+)$/m.exec(fm);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  return { status, title };
}

/**
 * Derive a human-readable title from a file path.
 * Converts the filename from kebab-case to title case.
 */
function titleFromPath(relativePath: string): string {
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
      let status: DocStatus | undefined;
      let title: string | undefined;

      try {
        const handle = await fs.open(path.join(dir, entry.name), "r");
        try {
          const buf = Buffer.alloc(512);
          const { bytesRead } = await handle.read(buf, 0, 512, 0);
          const content = buf.toString("utf-8", 0, bytesRead);
          const fields = parseFrontmatterFields(content);
          status = fields.status;
          title = fields.title;
        } finally {
          await handle.close();
        }
      } catch {
        // Can't read file — skip frontmatter parsing
      }

      results.push({ path: relativePath, status, title: title ?? titleFromPath(relativePath) });
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
