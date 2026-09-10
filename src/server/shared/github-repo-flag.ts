export const REPO_FLAG_FORMS = "OWNER/NAME, github.com/OWNER/NAME, or https://github.com/OWNER/NAME";

const REPO_FLAG_RE = /^(?:https?:\/\/)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

// Empty strings are supplied values; treating them as absent can target the wrong repo.
export function isValidRepoFlag(repo: unknown): boolean {
  if (repo === undefined || repo === null) return true;
  if (typeof repo !== "string") return false;
  return REPO_FLAG_RE.test(repo.trim());
}

/** Validate first when absent and invalid values must be distinguished. */
export function repoFlagToUrl(repo: string | undefined): string | undefined {
  if (!repo || typeof repo !== "string") return undefined;
  const trimmed = repo.trim();
  if (!trimmed) return undefined;
  const match = REPO_FLAG_RE.exec(trimmed);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}.git`;
}
