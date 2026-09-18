import fs from "node:fs/promises";
import path from "node:path";

import { compareDocsByRecency } from "../shared/doc-sort.js";
import { isWorkspaceSkipDir } from "../shared/fs-constants.js";
import type { DocEntry } from "../shared/types.js";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

function extractFrontmatter(content: string): string | undefined {
  return FRONTMATTER_RE.exec(content)?.[1];
}

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

const GENERIC_FILENAMES = new Set(["plan", "checklist", "readme", "index"]);

const CHECKBOX_RE = /^[ \t]*[-*+]\s+\[([ xX])\]\s/gm;

export function parseChecklistProgress(content: string): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const m of content.matchAll(CHECKBOX_RE)) {
    total++;
    if (m[1].toLowerCase() === "x") done++;
  }
  return { total, done };
}

function kebabToTitle(name: string): string {
  const stripped = name.replace(/^\d+-/, "");
  if (!stripped) return name;
  return stripped
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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
      const content = await fs.readFile(fullPath, "utf-8");
      const fields = parseFrontmatterFields(content);
      issue = fields.issue;
      title = fields.title;
      description = fields.description;
      const progress = parseChecklistProgress(content);
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

async function scanMarkdownFiles(dir: string, prefix: string): Promise<DocEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: DocEntry[] = [];

  for (const entry of entries) {
    if (isWorkspaceSkipDir(entry.name)) continue;
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

export async function findMarkdownFiles(dir: string, prefix = ""): Promise<DocEntry[]> {
  const results = await scanMarkdownFiles(dir, prefix);

  // The viewer hides a plan's sibling checklist, so show its progress on the plan.
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
