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

/**
 * Where a personal repo matches the query. Lower sorts first; `null` is no match.
 * Mirrors the `in:name` restriction GitHub's repo search uses, widened to the
 * owner so typing an owner name still surfaces their repos.
 *
 * An `owner/name` query is split on the slash rather than matched as a substring
 * of the full name: `me/ship` must not match `acme/ship-cli`, which contains
 * "me/ship" only by spanning the owner boundary.
 */
function matchTier(query: string, repo: GitHubRepoSummary): number | null {
  const fullName = repo.fullName.toLowerCase();
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);

  const querySlash = query.indexOf("/");
  if (querySlash !== -1) {
    if (!owner.startsWith(query.slice(0, querySlash))) return null;
    const queryName = query.slice(querySlash + 1);
    // A bare "owner/" is a request for that owner's repos, in push order.
    return queryName ? nameTier(queryName, name) : 1;
  }

  const tier = nameTier(query, name);
  if (tier !== null) return tier;
  return owner.includes(query) ? 3 : null;
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
    .map((repo, index) => ({ repo, index, tier: matchTier(normalized, repo) }))
    .filter((entry): entry is { repo: GitHubRepoSummary; index: number; tier: number } => entry.tier !== null)
    // The input is already sorted by push recency, so the index breaks tier ties.
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
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
