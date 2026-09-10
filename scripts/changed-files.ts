import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function gitOutput(root: string, cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function findMergeBase(root: string): string | null {
  for (const ref of ["origin/main", "main"]) {
    const base = gitOutput(root, `merge-base ${ref} HEAD`);
    if (base) return base;
  }
  return null;
}

export function listUntrackedFiles(root: string): string[] {
  return splitLines(gitOutput(root, "ls-files --others --exclude-standard"));
}

export interface ChangedFilesOptions {
  mergeBase?: string | null;
}

// Include untracked files before auto-commit; exclude deleted paths that lint cannot read.
export function listChangedFiles(root: string, options: ChangedFilesOptions = {}): string[] {
  const sources: string[][] = [];
  if (options.mergeBase) sources.push(splitLines(gitOutput(root, `diff --name-only ${options.mergeBase}...HEAD`)));
  sources.push(splitLines(gitOutput(root, "diff --name-only")));
  sources.push(splitLines(gitOutput(root, "diff --staged --name-only")));
  sources.push(listUntrackedFiles(root));
  return [...new Set(sources.flat())].filter((file) => existsSync(path.join(root, file)));
}

export function isLintableSource(file: string): boolean {
  return file.startsWith("src/") && /\.(ts|tsx)$/.test(file);
}

function splitLines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}
