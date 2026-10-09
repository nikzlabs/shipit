import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";
import { workResolvedAt } from "../../../server/shared/session-resolution.js";
import { parseTimestampMs } from "../../../server/shared/utils.js";

/**
 * Group sessions by repo URL with a STABLE sort within each group.
 * Sessions are intentionally NOT sorted by `lastUsedAt`: that field updates on every
 * agent event during a turn, which would reshuffle the list under the user's cursor and
 * cause mis-clicks. Instead:
 *   - Non-merged sessions sort by `createdAt` desc (newest first) — never changes.
 *   - Done sessions sink to the bottom, most recently resolved first (`workResolvedAt`).
 *   - Archived sessions sink below everything (live > merged), within their parent's brood too.
 * Repo order is whatever the server returns — `display_order` first, then
 * `last_used_at` desc for repos the user has never reordered. We deliberately
 * do NOT re-sort here: it would override the user's drag-and-drop choice and
 * also break the optimistic UI update (which mutates the list order before
 * the server response).
 */
// `isDone` must come from the whole session list (docs/316-done-sessions-return-memory
// req 1), not from the repos shown, or a hidden repo's child changes the answer.
export function computeRepoGroups(
  repos: RepoInfo[],
  sessions: SessionInfo[],
  isDone: (s: SessionInfo) => boolean,
) {
  const grouped = new Map<string, SessionInfo[]>();

  const opsSessions = sessions.filter((s) => s.kind === "ops");

  // Parsed, not compared as text: a run's finish and a spawned session's merge can be in
  // different formats in one group.
  const resolvedMs = (s: SessionInfo) => parseTimestampMs(workResolvedAt(s) ?? s.createdAt ?? "") || 0;
  const byResolvedDesc = (a: SessionInfo, b: SessionInfo) => resolvedMs(b) - resolvedMs(a);

  // Only a scheduled run can be a done sandbox session, so in the regular view
  // this keeps the server's order.
  const sandboxSessions = sessions.filter((s) => s.kind === "sandbox");
  const sandboxDone = sandboxSessions.filter(isDone).sort(byResolvedDesc);
  const sandboxSorted = [...sandboxSessions.filter((s) => !isDone(s)), ...sandboxDone];

  for (const repo of repos) {
    grouped.set(repo.url, []);
  }

  for (const s of sessions) {
    if (s.kind === "ops" || s.kind === "sandbox") continue;
    const key = s.remoteUrl ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  // `archived` is the PRIMARY key so a hidden/archived session never sits
  // above a live one. Because children are bucketed under their parent in this

  const isRecentlyResolvedForGroup = isDone;
  for (const [, group] of grouped) {
    group.sort((a, b) => {
      const aArchived = a.archived || a.userArchived ? 1 : 0;
      const bArchived = b.archived || b.userArchived ? 1 : 0;
      if (aArchived !== bArchived) return aArchived - bArchived;
      const aResolved = isRecentlyResolvedForGroup(a) ? 1 : 0;
      const bResolved = isRecentlyResolvedForGroup(b) ? 1 : 0;
      if (aResolved !== bResolved) return aResolved - bResolved;
      if (aResolved === 1) return byResolvedDesc(a, b);
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
  }

  const known = repos.map((repo) => ({
    kind: "repo" as const,
    repo,
    sessions: grouped.get(repo.url) ?? [],
  }));
  const knownUrls = new Set(repos.map((repo) => repo.url));
  const orphan = [...grouped.entries()]
    .filter(([url, group]) => !knownUrls.has(url) && group.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, group]) => {
      let label: string;
      if (url === "") {
        label = "Local sessions";
      } else {
        try {
          label = new URL(url).host || url;
        } catch {
          label = url;
        }
      }
      return { kind: "orphan" as const, url, label, sessions: group };
    });

  const sandbox = sandboxSorted.length > 0
    ? [{ kind: "sandbox" as const, sessions: sandboxSorted }]
    : [];
  const ops = opsSessions.length > 0
    ? [{ kind: "ops" as const, sessions: opsSessions }]
    : [];

  return [...sandbox, ...ops, ...known, ...orphan];
}
