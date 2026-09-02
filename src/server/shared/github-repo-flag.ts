/**
 * The `--repo` flag's accepted spellings, in one place.
 *
 * Two processes read this flag and they must agree. The `gh` shim (inside the
 * session container) refuses a malformed value before the network call, and the
 * orchestrator refuses it again at the route. If they parsed it differently the
 * shim would forward something the route then rejected — or worse, accept
 * something the route quietly reinterpreted — so the regex lives here rather
 * than being written out twice.
 */

/** Human-readable list of what `--repo` accepts, named in every rejection. */
export const REPO_FLAG_FORMS = "OWNER/NAME, github.com/OWNER/NAME, or https://github.com/OWNER/NAME";

const REPO_FLAG_RE = /^(?:https?:\/\/)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/**
 * Whether a **supplied** `--repo` value is one of the accepted spellings.
 *
 * Only `undefined`/`null` count as "the caller said nothing" and keep meaning
 * "use the session's or cwd's repository". Everything else was supplied and has
 * to parse:
 *
 * - `""` and whitespace are supplied. `gh pr close 11 --repo "$REPO"` with an
 *   unset variable reaches here as an empty string, and treating that as
 *   "absent" is how it would close PR 11 in the repository you happen to be
 *   standing in. Real `gh` refuses an empty `--repo` too.
 * - A non-string arrives from a JSON body, where the route's Fastify generic is
 *   a type annotation and not validation. It cannot be a repo, so it is not one.
 */
export function isValidRepoFlag(repo: unknown): boolean {
  if (repo === undefined || repo === null) return true;
  if (typeof repo !== "string") return false;
  return REPO_FLAG_RE.test(repo.trim());
}

/**
 * Normalize an explicit `--repo` value into a canonical github.com clone URL.
 * Returns undefined when absent or unparseable; callers that must refuse an
 * unparseable value check `isValidRepoFlag` first, since this function cannot
 * distinguish "nothing was supplied" from "what was supplied made no sense".
 */
export function repoFlagToUrl(repo: string | undefined): string | undefined {
  if (!repo || typeof repo !== "string") return undefined;
  const trimmed = repo.trim();
  if (!trimmed) return undefined;
  const match = REPO_FLAG_RE.exec(trimmed);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}.git`;
}
