---
status: in-progress
---

# 033 — Session Sidebar with Remote Grouping

## Overview

Replace the session dropdown in the header with a persistent vertical sidebar that shows all sessions at a glance, grouped by their Git remote repository. Makes it easy to see which sessions belong to which project and to switch between them.

## Problem

The current `SessionSelector` is a dropdown that requires a click to open and shows a flat list sorted by last-used time. With many sessions across different projects, it's hard to find the right one. There's no visual grouping by project/repo.

## Design

### Sidebar layout (desktop, expanded ~240px)

```
┌─────────────────────┐
│ Sessions    [«]     │  header + collapse toggle
├─────────────────────┤
│ [+ New Session]     │  prominent button
├─────────────────────┤
│ ▼ owner/repo (3)    │  collapsible group header
│   ● Session A  2h   │  active = green dot + highlight
│     Session B  1d   │  hover: pencil + X icons
│     Session C  3d   │
│ ▼ No Remote (1)     │
│     Session D  5m   │
└─────────────────────┘
```

### Sidebar layout (collapsed ~40px)

Narrow strip with an expand icon. Smooth width transition.

### Mobile

Sidebar renders as a slide-over overlay (fixed position, left-0, full height, z-50 with backdrop). Toggle from a button in the header. Auto-closes on session select.

### Grouping

- Sessions grouped by `remoteUrl` on `SessionInfo`
- Display label: `owner/repo` extracted from GitHub URLs (HTTPS/SSH), or `domain/path` for other remotes
- Groups sorted alphabetically by display name
- "No Remote" group at the bottom for sessions without a remote
- Each group is collapsible (chevron toggle, follow `FileTree.tsx` pattern)

### Session items

- Active session: green dot + highlighted background
- Title (truncated), relative time on the right
- Hover reveals: rename (pencil) and delete (X, not on current session) icons
- Inline rename with `editResolvedRef` blur guard (existing pattern from `SessionSelector`)

## How it works

### Server: Cache `remoteUrl` on `SessionInfo`

Git remotes live in each session's `.git/config`. Rather than reading N git configs on every `list_sessions`, we cache `remoteUrl` in the session metadata (`.vibe-sessions.json`).

**`SessionInfo` type** (`src/server/types.ts`):
```typescript
export interface SessionInfo {
  id: string;
  agentSessionId?: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  workspaceDir?: string;
  remoteUrl?: string;  // NEW — cached origin remote URL
}
```

**`SessionManager`** (`src/server/sessions.ts`):
```typescript
setRemoteUrl(id: string, remoteUrl: string | undefined): void
```
Same pattern as existing `setAgentSessionId`.

**Cache population** (`src/server/index.ts`):

| Event | Action |
|-------|--------|
| `list_sessions` | Lazy-populate: for sessions with `workspaceDir` but no `remoteUrl`, read origin from git config and cache. `Promise.all()` for concurrency. One-time cost. |
| `github_set_remote` | After `git.addRemote()`, cache the URL when remote name is `"origin"` |
| `github_create_repo` | After adding origin, cache `result.cloneUrl` |
| `github_import_repo` | After `sessionManager.track()`, cache the clone URL |

### Client: `SessionSidebar` component

**New file**: `src/client/components/SessionSidebar.tsx`

Props:
```typescript
interface SessionSidebarProps {
  sessions: SessionInfo[];
  currentSessionId: string | undefined;
  onResume: (sessionId: string) => void;
  onNew: () => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onRefresh: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}
```

Helper to extract display name from remote URL:
```typescript
function parseRepoLabel(remoteUrl: string): string {
  // "https://github.com/owner/repo.git" → "owner/repo"
  // "git@github.com:owner/repo.git" → "owner/repo"
  // Other URLs → "domain/path"
}
```

Grouping: `Map<remoteUrl | "__no_remote__", SessionInfo[]>` rendered as collapsible sections.

### Client: `App.tsx` layout change

Sidebar is **outside** the resizable `containerRef` so the resize handle only controls chat vs. right panel:

```
<div class="flex flex-1 min-h-0">
  <SessionSidebar />                        ← fixed width
  <div ref={containerRef} class="flex flex-1 min-h-0">
    <div (chat) style="width: fraction%">
    <ResizeHandle />
    <div (right panel) style="width: (1-fraction)%">
  </div>
</div>
```

New state:
- `sidebarCollapsed` — boolean, persisted to localStorage (`"vibe-sidebar-collapsed"`)
- `list_sessions` sent on WebSocket connect (not just on dropdown open)

### Shared utility

Extract `formatRelativeDate` from `SessionSelector.tsx` into `src/client/utils/dates.ts` for reuse.

### Cleanup

Remove `SessionSelector.tsx` and `SessionSelector.test.tsx` after sidebar is verified working.

## Key files

| File | Change |
|------|--------|
| `src/server/types.ts` | Add `remoteUrl?: string` to `SessionInfo` |
| `src/server/sessions.ts` | Add `setRemoteUrl()` method |
| `src/server/index.ts` | Cache remote URL in 4 handlers |
| `src/client/components/SessionSidebar.tsx` | **New** — sidebar component |
| `src/client/components/SessionSidebar.test.tsx` | **New** — component tests |
| `src/client/App.tsx` | Wire sidebar into layout, remove dropdown |
| `src/client/utils/dates.ts` | **New** — extract `formatRelativeDate` |
| `src/client/components/SessionSelector.tsx` | **Delete** after migration |
| `src/client/components/SessionSelector.test.tsx` | **Delete** after migration |

## Patterns to follow

- `FileTree.tsx` — collapsible tree with chevrons, expand/collapse state
- `FeaturesPanel.tsx` — grouped list with section headers
- `SessionSelector.tsx` — inline rename with `editResolvedRef` blur guard
- `useResizablePanel.ts` — localStorage persistence pattern for sidebar collapsed state

## Tests

### Integration tests (add to `src/server/integration_tests/session-management.test.ts`)

1. `list_sessions` returns `remoteUrl` when cached in metadata
2. `list_sessions` lazy-populates `remoteUrl` from git config
3. `github_set_remote` caches `remoteUrl` in session metadata
4. `list_sessions` handles missing workspace dirs gracefully

### Component tests (`src/client/components/SessionSidebar.test.tsx`)

1. Renders header, "New Session" button, session items
2. Groups sessions by `remoteUrl`, shows correct group headers
3. Shows "No Remote" group for sessions without remoteUrl
4. Extracts `owner/repo` from GitHub URLs
5. Highlights current session
6. `onResume` called on non-current session click
7. `onNew` called on "New Session" click
8. Inline rename: edit on pencil click, submit on Enter, cancel on Escape
9. Delete button on non-current sessions
10. Collapsed state shows narrow bar with expand button
11. Collapsible groups toggle on header click

## Verification

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass
3. `npm run lint` — clean
4. Manual: sidebar visible with grouped sessions, switch/create/rename/delete work, collapse/expand animates, mobile slide-over works
