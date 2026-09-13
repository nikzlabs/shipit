import type { GitHubRepoSummary } from "../github-auth-repos.js";

/** Personal matches kept above GitHub's own results, so search still has room. */
const MAX_PERSONAL_MATCHES = 10;
const MAX_RESULTS = 20;

/** Exact name, then prefix, then substring. `null` is no match. */
function nameTier(query: string, name: string): number | null {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return null;
}

/** Sorted on `ownerRank` first, then `nameRank`; lower is a better match. */
interface RepoMatch {
  ownerRank: number;
  nameRank: number;
}

/**
 * How well a personal repo matches the query, or `null` for no match. Mirrors
 * the `in:name` restriction GitHub's repo search uses, widened to the owner so
 * typing an owner name still surfaces their repos.
 *
 * An `owner/name` query is split on the slash rather than matched as a substring
 * of the full name: `me/ship` must not match `acme/ship-cli`, which contains
 * "me/ship" only by spanning the owner boundary. The owner is then matched by
 * prefix but ranked on exactness, so `me/ship` cannot be pushed out of the
 * result cap by ten repos belonging to `me-1`, `me-2`, …
 */
function matchRepo(query: string, repo: GitHubRepoSummary): RepoMatch | null {
  const fullName = repo.fullName.toLowerCase();
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);

  const querySlash = query.indexOf("/");
  if (querySlash !== -1) {
    const queryOwner = query.slice(0, querySlash);
    if (!owner.startsWith(queryOwner)) return null;
    const ownerRank = owner === queryOwner ? 0 : 1;

    const queryName = query.slice(querySlash + 1);
    // A bare "owner/" is a request for that owner's repos, in push order.
    if (!queryName) return { ownerRank, nameRank: 1 };
    const nameRank = nameTier(queryName, name);
    return nameRank === null ? null : { ownerRank, nameRank };
  }

  const nameRank = nameTier(query, name);
  if (nameRank !== null) return { ownerRank: 0, nameRank };
  return owner.includes(query) ? { ownerRank: 0, nameRank: 3 } : null;
}

/**
 * Personal repos matching `query` first, then GitHub's search results.
 *
 * GitHub's repo-search index lags behind repo creation and pushes, and its
 * relevance ranking regularly omits the caller's own repos entirely — so the
 * personal list is matched locally and prioritized instead of trusted to the
 * search API (docs/027-github-import).
 */
export function rankRepoSearchResults(
  query: string,
  personalRepos: GitHubRepoSummary[],
  searchResults: GitHubRepoSummary[],
): GitHubRepoSummary[] {
  const normalized = query.trim().toLowerCase();

  const personalMatches = personalRepos
    .map((repo, index) => ({ repo, index, match: matchRepo(normalized, repo) }))
    .filter((entry): entry is { repo: GitHubRepoSummary; index: number; match: RepoMatch } => entry.match !== null)
    // The input is already sorted by push recency, so the index breaks rank ties.
    .sort(
      (a, b) =>
        a.match.ownerRank - b.match.ownerRank ||
        a.match.nameRank - b.match.nameRank ||
        a.index - b.index,
    )
    .slice(0, MAX_PERSONAL_MATCHES)
    .map((entry) => entry.repo);

  const seen = new Set<string>();
  const ranked: GitHubRepoSummary[] = [];
  for (const repo of [...personalMatches, ...searchResults]) {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(repo);
    if (ranked.length >= MAX_RESULTS) break;
  }
  return ranked;
}
