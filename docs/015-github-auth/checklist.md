# 015 — GitHub Auth: Remaining Work

Core auth (PAT entry, token storage, validation, repo creation, PR management) and auto-push are fully implemented. The remaining work is client UI for manual push/pull and a visible GitHub status indicator.

## Remaining

- [ ] Add push/pull buttons to `GitHistory.tsx` — server-side service functions (`gitPush`, `gitPull`) and HTTP endpoints already exist; no client UI triggers them manually
- [ ] Add component tests for the push/pull buttons in `GitHistory.test.tsx`
- [ ] Add GitHub status indicator to the header/navigation — currently only visible in the Settings tab
