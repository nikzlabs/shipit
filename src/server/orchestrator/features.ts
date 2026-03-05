import fs from "node:fs/promises";
import path from "node:path";
import type { FeatureInfo, FeatureStatus } from "../shared/types.js";

/** Pattern for feature directories: NNN-name */
const FEATURE_DIR_PATTERN = /^(\d+)-(.+)$/;

/** Valid feature statuses. */
const VALID_STATUSES = new Set<FeatureStatus>(["planned", "in-progress", "done", "paused"]);

/**
 * Extract YAML frontmatter `status` field from markdown content.
 * Uses simple regex — no heavy YAML library needed.
 *
 * Supports:
 *   ---
 *   status: in-progress
 *   ---
 */
export function parseStatusFromFrontmatter(content: string): FeatureStatus {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return "planned";

  const frontmatter = match[1];
  const statusMatch = /^status:\s*(.+)$/m.exec(frontmatter);
  if (!statusMatch) return "planned";

  const raw = statusMatch[1].trim().toLowerCase();
  if (VALID_STATUSES.has(raw as FeatureStatus)) {
    return raw as FeatureStatus;
  }
  return "planned";
}

/**
 * Convert a kebab-case directory name to a human-readable title.
 * E.g. "websocket-protocol" → "Websocket Protocol"
 */
function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * FeatureManager — scans the docs/ directory for feature directories,
 * parses YAML frontmatter from plan.md, and returns feature metadata.
 *
 * @param workspaceDir - Root workspace directory. Defaults to `/workspace`.
 */
export class FeatureManager {
  private workspaceDir: string;

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir ?? "/workspace";
  }

  /**
   * Scan the docs/ directory and return all features sorted by number.
   */
  async list(): Promise<FeatureInfo[]> {
    const docsDir = path.join(this.workspaceDir, "docs");

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(docsDir, { withFileTypes: true });
    } catch {
      // docs/ doesn't exist — no features
      return [];
    }

    const features: FeatureInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const match = FEATURE_DIR_PATTERN.exec(entry.name);
      if (!match) continue;

      const num = parseInt(match[1], 10);
      const slug = match[2];

      const planPath = path.join("docs", entry.name, "plan.md");
      const planAbsolute = path.join(docsDir, entry.name, "plan.md");

      // Must have a plan.md to be a valid feature
      try {
        await fs.access(planAbsolute);
      } catch {
        continue;
      }

      // Parse status from frontmatter
      let status: FeatureStatus = "planned";
      try {
        const content = await fs.readFile(planAbsolute, "utf-8");
        status = parseStatusFromFrontmatter(content);
      } catch {
        // Can't read — default to planned
      }

      // Check for checklist.md
      const checklistAbsolute = path.join(docsDir, entry.name, "checklist.md");
      let checklistPath: string | undefined;
      try {
        await fs.access(checklistAbsolute);
        checklistPath = path.join("docs", entry.name, "checklist.md");
      } catch {
        // No checklist
      }

      features.push({
        id: entry.name,
        number: num,
        name: kebabToTitle(slug),
        status,
        planPath,
        checklistPath,
      });
    }

    return features.sort((a, b) => a.number - b.number);
  }

  /**
   * Get a single feature by ID (directory name).
   */
  async get(featureId: string): Promise<FeatureInfo | null> {
    const features = await this.list();
    return features.find((f) => f.id === featureId) ?? null;
  }
}
