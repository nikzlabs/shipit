# 033 — Session Sidebar Checklist

## Server

- [ ] Add `remoteUrl?: string` to `SessionInfo` in `src/server/types.ts`
- [ ] Add `setRemoteUrl(id, url)` method to `SessionManager` in `src/server/sessions.ts`
- [ ] Lazy-populate `remoteUrl` in `list_sessions` handler (`src/server/index.ts`)
- [ ] Cache `remoteUrl` in `github_set_remote` handler
- [ ] Cache `remoteUrl` in `github_create_repo` handler
- [ ] Cache `remoteUrl` in `github_import_repo` handler

## Client

- [ ] Extract `formatRelativeDate` to `src/client/utils/dates.ts`
- [ ] Create `SessionSidebar.tsx` with grouping by remote URL
  - [ ] Collapsible group headers with chevron
  - [ ] `parseRepoLabel` helper (GitHub HTTPS/SSH, fallback)
  - [ ] Session items: active indicator, title, relative time
  - [ ] Hover actions: rename (pencil), delete (X, not current)
  - [ ] Inline rename with `editResolvedRef` blur guard
  - [ ] Collapsed state (narrow bar with expand icon)
  - [ ] "New Session" button
- [ ] Update `App.tsx` layout
  - [ ] Add sidebar collapsed state (localStorage persisted)
  - [ ] Place sidebar outside resizable `containerRef`
  - [ ] Remove `SessionSelector` from header
  - [ ] Send `list_sessions` on WebSocket connect
  - [ ] Mobile: slide-over overlay with backdrop

## Tests

- [ ] Integration: `list_sessions` returns cached `remoteUrl`
- [ ] Integration: `list_sessions` lazy-populates from git config
- [ ] Integration: `github_set_remote` caches `remoteUrl`
- [ ] Integration: handles missing workspace dirs gracefully
- [ ] Component: renders header, new button, session items
- [ ] Component: groups by remote, shows group headers
- [ ] Component: "No Remote" group for sessions without remote
- [ ] Component: extracts `owner/repo` from GitHub URLs
- [ ] Component: highlights current session
- [ ] Component: `onResume` on non-current session click
- [ ] Component: inline rename (Enter submits, Escape cancels)
- [ ] Component: delete button on non-current sessions
- [ ] Component: collapsed state and toggle
- [ ] Component: collapsible groups toggle on header click

## Cleanup

- [ ] Delete `SessionSelector.tsx`
- [ ] Delete `SessionSelector.test.tsx`

## Verification

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] Manual test: grouped sidebar, switch/create/rename/delete, collapse, mobile
