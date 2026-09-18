import path from "node:path";

import type { GitManager } from "../../shared/git.js";
import type { NotableFileChange } from "../../shared/types.js";
import { committedChangesVsBase } from "./git.js";

const CONFIG_FILENAMES = new Set([
  "shipit.yaml",
  "docker-compose.yml",
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);

export interface RawFileChange {
  status: string;
  path: string;
}

function normalizeStatus(raw: string): "M" | "A" | "D" | null {
  switch (raw.charAt(0).toUpperCase()) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "M":
    case "R":
    case "C":
      return "M";
    default:
      return null;
  }
}

const FEATURE_DIR_PREFIX_RE = /^(\d+)-/;

export function compactPathLabel(relativePath: string): string {
  const basename = path.posix.basename(relativePath);
  const dir = path.posix.dirname(relativePath);
  if (!dir || dir === "." || dir === "/") return basename;
  const parent = path.posix.basename(dir);
  if (!parent) return basename;
  const numbered = FEATURE_DIR_PREFIX_RE.exec(parent);
  return `${numbered ? numbered[1] : parent}/${basename}`;
}

export function computeNotableFiles(changes: RawFileChange[]): NotableFileChange[] {
  const out: NotableFileChange[] = [];
  for (const change of changes) {
    const status = normalizeStatus(change.status);
    if (!status) continue;
    const basename = path.posix.basename(change.path);
    const label = compactPathLabel(change.path);
    const ext = path.extname(change.path).toLowerCase();

    if (CONFIG_FILENAMES.has(basename)) {
      out.push({ path: change.path, label, kind: "config", status });
    } else if (change.path.endsWith(".md") || HTML_EXTENSIONS.has(ext)) {
      out.push({ path: change.path, label, kind: "doc", status });
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      out.push({ path: change.path, label, kind: "image", status });
    }
  }
  return out;
}

// Share the Docs panel's committed change set so both surfaces agree.
export async function notableFilesForBranch(
  git: GitManager,
  baseBranch: string,
): Promise<NotableFileChange[]> {
  const changes = await committedChangesVsBase(git, baseBranch);
  return computeNotableFiles(changes);
}
