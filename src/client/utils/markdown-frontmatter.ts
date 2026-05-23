import type { DocPriority, DocStatus } from "../../server/shared/types.js";

const VALID_STATUSES = new Set<DocStatus>([
  "planned",
  "in-progress",
  "done",
  "paused",
  "rejected",
]);

const VALID_PRIORITIES = new Set<DocPriority>(["high", "medium", "low"]);

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface ParsedFrontmatter {
  /** Body with the frontmatter block removed. Unchanged when no frontmatter. */
  body: string;
  /** True iff a frontmatter block was present and stripped. */
  hasFrontmatter: boolean;
  status?: DocStatus;
  customStatus?: string;
  priority?: DocPriority;
  description?: string;
  /** Any other `key: value` lines from frontmatter, preserved for display. */
  extras: { key: string; value: string }[];
}

/**
 * Parse a YAML frontmatter block from the start of a markdown document and
 * return the typed fields plus the body with the block stripped. Mirrors the
 * server-side parser in `src/server/orchestrator/markdown.ts` — kept narrow
 * (regex-based, no YAML dep) because the frontmatter we render is shallow
 * `key: value` pairs.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { body: content, hasFrontmatter: false, extras: [] };
  }

  const block = match[1];
  const body = content.slice(match[0].length);

  let status: DocStatus | undefined;
  let customStatus: string | undefined;
  let priority: DocPriority | undefined;
  let description: string | undefined;
  const extras: { key: string; value: string }[] = [];

  for (const line of block.split("\n")) {
    const fieldMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!fieldMatch) continue;
    const key = fieldMatch[1].trim();
    const value = fieldMatch[2].trim();
    if (!value) continue;

    if (key === "status") {
      const raw = value.toLowerCase();
      if (VALID_STATUSES.has(raw as DocStatus)) status = raw as DocStatus;
      else customStatus = raw;
    } else if (key === "priority") {
      const raw = value.toLowerCase();
      if (VALID_PRIORITIES.has(raw as DocPriority)) priority = raw as DocPriority;
    } else if (key === "description") {
      description = value;
    } else if (key === "title") {
      // Title is derived elsewhere (filename / parent dir); skip it from extras
      // so we don't render a duplicate label above the H1.
    } else {
      extras.push({ key, value });
    }
  }

  return { body, hasFrontmatter: true, status, customStatus, priority, description, extras };
}
