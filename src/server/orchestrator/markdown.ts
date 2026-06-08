import fs from "node:fs/promises";
import path from "node:path";

import { compareDocsByRecency } from "../shared/doc-sort.js";
import { WORKSPACE_SKIP_DIRS } from "../shared/fs-constants.js";
import type { DocEntry } from "../shared/types.js";

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
 * Parse `issue`, `title`, and `description` from frontmatter in a single
 * extraction.
 *
 * docs/168 decoupled work tracking from docs: it now lives in the issue
 * tracker, so the doc carries only an optional `issue:` pointer to the work
 * item that tracks it. `description` is an optional single-line summary
 * surfaced under the title in the docs panel. The pointer is stored verbatim
 * (trimmed); the client infers the tracker from its shape and renders the
 * jump-to-issue chip.
 */
function parseFrontmatterFields(
  content: string,
): {
  issue?: string;
  title?: string;
  description?: string;
} {
  const fm = extractFrontmatter(content);
  if (!fm) return {};

  let issue: string | undefined;
  const issueMatch = /^issue:\s*(.+)$/m.exec(fm);
  if (issueMatch) {
    const raw = issueMatch[1].trim();
    if (raw.length > 0) issue = raw;
  }

  let title: string | undefined;
  const titleMatch = /^title:\s*(.+)$/m.exec(fm);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  let description: string | undefined;
  const descriptionMatch = /^description:\s*(.+)$/m.exec(fm);
  if (descriptionMatch) {
    const raw = descriptionMatch[1].trim();
    if (raw.length > 0) description = raw;
  }

  return { issue, title, description };
}

/** Generic filenames where the parent directory name is more meaningful. */
const GENERIC_FILENAMES = new Set(["plan", "checklist", "readme", "index"]);

/**
 * Markdown checkbox items, at any indentation level, with `-`/`*`/`+` bullet
 * markers. Captures the inside of the brackets so we can tell a checked
 * (`x`/`X`) item apart from an unchecked one (` `).
 */
const CHECKBOX_RE = /^[ \t]*[-*+]\s+\[([ xX])\]\s/gm;

/**
 * Count `- [ ]` / `- [x]` items in a markdown document. Returns
 * `{ total: 0, done: 0 }` when the document has no checkboxes — callers
 * can use that to decide whether to suppress a `0/0` progress badge.
 */
export function parseChecklistProgress(content: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const m of content.matchAll(CHECKBOX_RE)) {
    total++;
    if (m[1].toLowerCase() === "x") done++;
  }
  return { total, done };
}

/**
 * Convert a kebab-case string (possibly with leading numbers) to title case.
 * Strips a leading `NNN-` numeric prefix if present.
 */
function kebabToTitle(name: string): string {
  // Strip leading numeric prefix like "001-" or "42-"
  const stripped = name.replace(/^\d+-/, "");
  if (!stripped) return name; // all-numeric, keep original
  return stripped
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Derive a human-readable title from a file path.
 * For generic filenames like `plan.md`, uses the parent directory name instead.
 */
function titleFromPath(relativePath: string): string {
  const basename = path.basename(relativePath, ".md");
  if (GENERIC_FILENAMES.has(basename.toLowerCase())) {
    const dir = path.dirname(relativePath);
    if (dir && dir !== ".") {
      return kebabToTitle(path.basename(dir));
    }
  }
  return kebabToTitle(basename);
}

/**
 * Read one `.md` file and produce its `DocEntry`. For most docs we sniff
 * only the first 1024 bytes (frontmatter); for `checklist.md` we read the
 * whole file so we can count checkboxes for the progress badge.
 */
async function readMarkdownEntry(
  fullPath: string,
  relativePath: string,
  basename: string,
): Promise<DocEntry> {
  let issue: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let modifiedAt: string | undefined;
  let checklist: { total: number; done: number } | undefined;

  const isChecklist = basename.toLowerCase() === "checklist.md";

  try {
    if (isChecklist) {
      // Full read — checkboxes can appear anywhere in the file, so a
      // 512-byte sniff would undercount on real-world checklists.
      const content = await fs.readFile(fullPath, "utf-8");
      const fields = parseFrontmatterFields(content);
      issue = fields.issue;
      title = fields.title;
      description = fields.description;
      const progress = parseChecklistProgress(content);
      // Suppress empty checklists — they'd render as `0/0`, which is noise.
      if (progress.total > 0) checklist = progress;
      const stat = await fs.stat(fullPath);
      modifiedAt = stat.mtime.toISOString();
    } else {
      const handle = await fs.open(fullPath, "r");
      try {
        const buf = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(buf, 0, 1024, 0);
        const content = buf.toString("utf-8", 0, bytesRead);
        const fields = parseFrontmatterFields(content);
        issue = fields.issue;
        title = fields.title;
        description = fields.description;
        // Capture mtime from the same handle to avoid a second syscall.
        // Used by the client to surface docs touched in the current session.
        const stat = await handle.stat();
        modifiedAt = stat.mtime.toISOString();
      } finally {
        await handle.close();
      }
    }
  } catch {
    // Can't read file — skip frontmatter parsing
  }

  return {
    path: relativePath,
    issue,
    title: title ?? titleFromPath(relativePath),
    description,
    modifiedAt,
    checklist,
  };
}

/**
 * Recursive scan that collects every `.md` file under `dir` without sorting
 * or post-processing. Kept private so the public entry point can attach
 * sibling-derived data (checklist progress) before sorting.
 */
async function scanMarkdownFiles(dir: string, prefix: string): Promise<DocEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: DocEntry[] = [];

  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...await scanMarkdownFiles(fullPath, relativePath));
    } else if (entry.name.endsWith(".md")) {
      results.push(await readMarkdownEntry(fullPath, relativePath, entry.name));
    }
  }

  return results;
}

/**
 * Recursively find `.md` files in a directory, skipping `node_modules` and `.git`.
 *
 * Returns `DocEntry[]` ordered newest-first by feature number (see
 * `compareDocsByRecency`). Each entry includes an optional `issue` pointer
 * parsed from YAML frontmatter, plus `checklist` progress aggregated from a
 * sibling `checklist.md` (when present).
 */
export async function findMarkdownFiles(dir: string, prefix = ""): Promise<DocEntry[]> {
  const results = await scanMarkdownFiles(dir, prefix);

  // Propagate checklist progress from `checklist.md` onto its sibling
  // `plan.md`. The DocsViewer renders the tracked plan as the primary row
  // and hides the standalone checklist (see `hasTrackedSibling`), so the
  // badge has to live on the plan entry to be seen at all.
  const progressByDir = new Map<string, { total: number; done: number }>();
  for (const e of results) {
    if (!e.checklist) continue;
    const base = e.path.slice(e.path.lastIndexOf("/") + 1).toLowerCase();
    if (base === "checklist.md") {
      progressByDir.set(path.dirname(e.path), e.checklist);
    }
  }
  for (const e of results) {
    if (e.checklist) continue;
    const base = e.path.slice(e.path.lastIndexOf("/") + 1).toLowerCase();
    if (base !== "plan.md") continue;
    const progress = progressByDir.get(path.dirname(e.path));
    if (progress) e.checklist = progress;
  }

  return results.sort((a, b) => compareDocsByRecency(a.path, b.path));
}
