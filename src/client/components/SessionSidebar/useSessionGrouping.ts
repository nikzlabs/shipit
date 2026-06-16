import type { SessionInfo, RepoInfo } from "../../../server/shared/types.js";
import { parseTimestampMs } from "../../../server/shared/utils.js";

/**
 * Client mirror of the server's `resolvedAt` (`sessions.ts`). The instant a
 * session's PR reached a terminal state — merged or closed-without-merge. Both
 * demote the session into the "Recently resolved" group.
 */
export function resolvedAt(s: SessionInfo): string | undefined {
  return s.mergedAt ?? s.closedAt;
}

/**
 * docs/161 — client mirror of the server's `reopenedAfterResolve` predicate
 * (`sessions.ts`). True when a resolved session (merged OR closed) has been
 * *worked in* since it resolved — the user returned to start a follow-up PR.
 * Keys on `lastUsedAt` (bumped only by turn activity), so it flips true the
 * instant the user sends a message in a resolved session.
 *
 * `mergedAt`/`closedAt` (`datetime('now')`, a UTC string with no timezone
 * suffix) and `lastUsedAt` (`toISOString()`, UTC with a trailing `Z`) are
 * format-incompatible. This runs in the BROWSER, so a plain `Date.parse` reads
 * the suffix-less resolve timestamp as *local* time: in a UTC+ timezone that
 * shifts the resolve instant earlier than a `lastUsedAt` recorded just before
 * it, falsely flagging the session as reopened and floating it back into the
 * Active group above genuinely active sessions. `parseTimestampMs` normalizes
 * both to UTC. (CI runs in UTC, so the test suite never reproduced this.)
 */
export function reopenedAfterResolve(s: SessionInfo): boolean {
  const resolved = resolvedAt(s);
  if (!resolved) return false;
  const resolvedMs = parseTimestampMs(resolved);
  const used = parseTimestampMs(s.lastUsedAt);
  if (Number.isNaN(resolvedMs) || Number.isNaN(used)) return false;
  return used > resolvedMs;
}

/**
 * docs/161 — the baseline predicate for the sidebar's demoted "Recently
 * resolved" group: its PR is merged or closed-without-merge and it has not been
 * reopened (worked in) since. Group-local parent/child rules can still keep a
 * resolved parent in Active when it has visible spawned children.
 */
export function isRecentlyResolved(s: SessionInfo): boolean {
  return !!resolvedAt(s) && !reopenedAfterResolve(s);
}

/**
 * Group sessions by repo URL with a STABLE sort within each group.
 * Sessions are intentionally NOT sorted by `lastUsedAt`: that field updates on every
 * agent event during a turn, which would reshuffle the list under the user's cursor and
 * cause mis-clicks. Instead:
 *   - Non-merged sessions sort by `createdAt` desc (newest first) — never changes.
 *   - Merged sessions sink to the bottom, sorted by `mergedAt` desc (most recently merged first).
 *   - Archived sessions sink below everything (live > merged), within their parent's brood too.
 * Repo order is whatever the server returns — `display_order` first, then
 * `last_used_at` desc for repos the user has never reordered. We deliberately
 * do NOT re-sort here: it would override the user's drag-and-drop choice and
 * also break the optimistic UI update (which mutates the list order before
 * the server response).
 */
export function computeRepoGroups(repos: RepoInfo[], sessions: SessionInfo[]) {
  const grouped = new Map<string, SessionInfo[]>();

  // docs/128 — ops sessions are a distinct kind, not repo-backed. Pull them
  // out before the repo/orphan distribution so they render in their own
  // pinned "Host / Ops" group instead of falling into "Other sessions".
  const opsSessions = sessions.filter((s) => s.kind === "ops");

  // Initialize groups for all known repos
  for (const repo of repos) {
    grouped.set(repo.url, []);
  }

  // Distribute sessions into groups
  for (const s of sessions) {
    if (s.kind === "ops") continue;
    const key = s.remoteUrl ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  // Sort sessions within each group: archived sink to the very bottom, then
  // active first (by createdAt desc), then recently-resolved (by resolve time
  // desc, falling back to createdAt desc). docs/161 — "active" includes a
  // *reopened* resolved session (worked in since the merge/close), so it
  // bubbles back up out of the resolved tail; only `isRecentlyResolved` sinks.
  //
  // `archived` is the PRIMARY key so a hidden/archived session never sits
  // above a live one. Because children are bucketed under their parent in this
  // same sorted order (see the `childrenByParent` build in RepoGroup), making
  // archived primary also sinks archived children below live siblings within a
  // parent's brood.
  for (const [, group] of grouped) {
    const parentsWithChildren = new Set<string>();
    for (const s of group) {
      if (s.parentSessionId) parentsWithChildren.add(s.parentSessionId);
    }
    const isRecentlyResolvedForGroup = (s: SessionInfo): boolean =>
      isRecentlyResolved(s) && !parentsWithChildren.has(s.id);
    group.sort((a, b) => {
      const aArchived = a.archived || a.userArchived ? 1 : 0;
      const bArchived = b.archived || b.userArchived ? 1 : 0;
      if (aArchived !== bArchived) return aArchived - bArchived;
      const aResolved = isRecentlyResolvedForGroup(a) ? 1 : 0;
      const bResolved = isRecentlyResolvedForGroup(b) ? 1 : 0;
      if (aResolved !== bResolved) return aResolved - bResolved;
      if (aResolved === 1) {
        const aKey = resolvedAt(a) ?? a.createdAt ?? "";
        const bKey = resolvedAt(b) ?? b.createdAt ?? "";
        return bKey.localeCompare(aKey);
      }
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

  // docs/128 — pin the ops group at the very top when it exists.
  const ops = opsSessions.length > 0
    ? [{ kind: "ops" as const, sessions: opsSessions }]
    : [];

  // Ops first (pinned), then server-provided repo order, then non-empty unmatched groups.
  return [...ops, ...known, ...orphan];
}
