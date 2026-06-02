---
description: Per-file "viewed" checkbox in the diff viewer to track review progress across large PRs, mirroring GitHub's review UX.
issue: https://linear.app/shipit-ai/issue/SHI-34/mark-files-as-viewed-in-diff-viewer
---

# 103 — Mark Files as Viewed in Diff Viewer

## Summary

Per-file "viewed" checkbox in `DiffPanel.tsx`, mirroring GitHub's PR review UX (and Conductor v0.29.1). Once a file is marked viewed, it dims in the file tree, collapses by default, and is excluded from the unread file count. State is per-session and resets when the underlying diff changes (new commit on the branch).

## Motivation

ShipIt's diff viewer is full-featured (Monaco side-by-side, syntax highlighting, hide-unchanged, inline comments) but with a 30+ file diff there is no way to track review progress. Users currently have to keep mental state of "which files have I checked." Conductor added this in v0.29.1 and it's the single highest-leverage diff QoL improvement — useful both for solo Claude review and (with [102](../102-github-pr-comment-sync/plan.md)) team review.

## Design

### State

- New per-session map: `Record<filePath, { viewedAt: ISO timestamp, viewedAtSha: string }>`.
- Persisted on the **server** in session metadata (`SessionMetadata.diffViewed`) so the state survives reconnects and is shared across browser tabs viewing the same session.
- Keyed on `viewedAtSha = sha of the working tree at view time`. If the file is touched again after that, we treat it as unviewed without losing the timestamp record (it transitions to "you previously viewed an older version").

### UI

In the file-tree sidebar of `DiffPanel.tsx`:

- Checkbox to the left of each file. Click → toggles viewed.
- Viewed files dim to `text-gray-500` and the diff body for that file collapses by default.
- Header counter: `"3 / 14 files reviewed"` (replaces or augments the existing total-changes display).
- Re-touched files: small `↻` glyph next to the checkbox indicating "viewed an older revision."
- Bulk action: "Mark all viewed" / "Reset" in the file-tree header.

### Server

- Extend `SessionMetadata` (in `src/shared/types/domain-types.ts`) with `diffViewed?: Record<string, { sha: string; at: string }>`.
- New endpoints (live in existing `api-routes-files.ts` since the diff is file-scoped, or carve out `api-routes-diff.ts`):
  - `POST /api/sessions/:id/diff/viewed { path, sha }` — set viewed
  - `DELETE /api/sessions/:id/diff/viewed/:path` — unset
  - `DELETE /api/sessions/:id/diff/viewed` — reset
- Service: `services/diff-review.ts` with `markViewed`, `unmarkViewed`, `resetViewed`. Persists via `sessions.updateMetadata`.

### When do we reset?

Three triggers:

1. **Auto** — when a file's current SHA differs from the recorded `viewedAtSha`, the UI shows the "outdated view" state (still counts as viewed, but with a glyph). User can click again to re-confirm.
2. **PR merged** — auto-clear `diffViewed` for the session when `pr_lifecycle_update` reports `phase: merged`.
3. **Branch reset / rollback** — `git_rollback` ws message (`rollback-handlers.ts`) clears the map.

### Interaction with inline comments

Marking a file viewed does **not** suppress inline comments — unresolved threads stay visible regardless. The viewed state is independent of comment state, matching GitHub.

## Tests

`integration_tests/diff-mark-viewed.test.ts`:

1. Mark a file viewed → metadata persisted, GET /diff returns `viewed: true` for it.
2. Edit the file (new commit) → next diff load shows the file as outdated-but-viewed.
3. Merge PR → metadata cleared.
4. Multiple browser tabs see the same viewed state via a `diff_viewed_update` WS broadcast.

Component test for `DiffPanel.tsx` covering the file-tree checkbox toggle and the counter.

## Key files

| File | Change |
|---|---|
| `src/shared/types/domain-types.ts` | Add `diffViewed` to `SessionMetadata` |
| `src/server/orchestrator/services/diff-review.ts` | New service module |
| `src/server/orchestrator/api-routes-files.ts` | New diff-viewed routes |
| `src/server/orchestrator/sessions.ts` | Reset on rollback/merge |
| `src/shared/types/ws-server-messages.ts` | `diff_viewed_update` broadcast |
| `src/client/components/DiffPanel.tsx` | File-tree checkboxes, counter, collapse logic |
| `src/client/stores/git-store.ts` | `diffViewed` slice + actions |

## Future extensions

- **Auto-mark viewed on scroll-to-end** — file scrolls fully into view → auto-mark, like GitHub. Behind a setting.
- **Per-comment viewed** — finer-grained: marking individual comment threads as resolved-by-me without GitHub-side resolution.
