# 015 — GitHub Auth: Remaining Work

Core auth (PAT entry, token storage, validation, status indicator, repo creation) is fully implemented and tested. The one missing piece is the manual push/pull UI that the plan describes.

## Remaining

- [ ] Add push/pull buttons to `GitHistory.tsx` — the server-side `github_push` and `github_pull` handlers already exist in `index.ts`; no client UI sends them manually
- [ ] Add component tests for the push/pull buttons in `GitHistory.test.tsx`
