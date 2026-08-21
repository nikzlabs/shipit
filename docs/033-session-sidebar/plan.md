
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

## Visual reference — repo group separation (open)

The rail now routinely holds 4+ repos, and the groups blend into each other: the
repo header, `New session`, `PINNED`, `RECENTLY RESOLVED` and the session rows
all sit on `--color-bg-primary`, separated only by a font-weight bump on the
repo name. The strongest horizontal lines in the rail (the pinned divider, the
sub-section labels) are *intra*-group, so they out-rank the *inter*-group
boundary they're competing with.

- [`mocks/repo-separation.html`](mocks/repo-separation.html) — ten treatments,
  each rendered in app context. Toggles for warm-light/dark and 4-repo/8-repo.
- [`mocks/repo-separation-cards.html`](mocks/repo-separation-cards.html) — six
  ways to get card-style containment, since the obvious one doesn't exist here.
- [`mocks/repo-separation-band.html`](mocks/repo-separation-band.html) — variant
  4 (the filled header band) worked through in Claude Light and Claude Dark
  specifically, with live sticky scrolling.
- [`mocks/repo-separation-spine.html`](mocks/repo-separation-spine.html) — the
  leading candidate (4e) extended so the per-repo accent edge spans the whole
  group rather than just the header band. Seven options, both Claude themes,
  live sticky scrolling, plus dense (8 repos) and collapsed toggles.

### The constraint any variant has to satisfy

**There is no third surface behind the repo groups.** The sidebar rail is
`--color-bg-primary` (`SessionSidebar.tsx:394`) and the chat panel it butts
against is `--color-bg-secondary` (`AppLayout.tsx:344`). That's the whole
hierarchy. So:

- In light themes the sidebar is the **lightest** surface in the app; a card
  cannot be lighter still. In dark themes it's the **darkest**; a card cannot be
  darker. Any *fill*-based containment therefore has to move in **opposite
  directions per theme** — which is why the first draft of the mock looked good
  in warm-light and inverted in dark.
- Outline- and edge-based containment sidesteps this entirely: a border behaves
  identically in both. That's why variants 3 and 10 are now outline-based.
- Two fill options do exist and are mocked, with their costs:
  **tinted well** (the *group* recesses to `bg-secondary`, which collides with
  the current-session row's own tint and forces it up to `bg-tertiary`) and
  **recessing the rail for real** (the sidebar becomes `bg-secondary`, which
  makes it match the chat panel and collapses the app's main left/right split to
  a 1px border).
- **Elevation-only containment is a non-starter.** A shadow on a `#0a0a0a` rail
  has nothing to darken, so the treatment vanishes in every dark theme.

No variant is chosen yet; nothing here is implemented.

### What the band variant turned up (Claude Light / Claude Dark)

The Claude palettes are the hard case for any fill-based treatment. Measured
against the rail (`--color-bg-primary`), the band fills available are:

| Fill | Claude Light | Claude Dark |
|---|---|---|
| `--color-bg-secondary` (as specced) | 1.12 : 1 | 1.09 : 1 |
| `--color-bg-tertiary` | 1.25 : 1 | 1.21 : 1 |
| `--color-accent-subtle` composited | 1.12 : 1 | 1.23 : 1 |

Three things fall out, all checkable:

1. **In Claude Dark, `--color-border-primary` is `#2e2519` — byte-identical to
   `--color-bg-tertiary`.** A tertiary band with `border-primary` rules has
   invisible rules there and visible ones in Claude Light, so the two themes
   don't match. Rules have to come from `--color-border-secondary`.

   > **No longer true as of the divider-contrast pass.** Claude Dark's
   > `--color-border-primary` is now `#413524`, so it is no longer identical to
   > `--color-bg-tertiary` and the collision this bullet describes is gone. The
   > *conclusion* still stands for a different reason: `border-primary` remains
   > below the 1.4 contrast floor against `--color-bg-tertiary` in every theme,
   > because that pass only raised it against `--color-bg-primary` and
   > `--color-bg-secondary`. Re-measure before reasoning from the numbers above.
2. **The band as specced is the same fill as the current-session row**
   (`SessionGroup.tsx:431` also uses `--color-bg-secondary`). At 1.09 : 1 against
   the rail, header and selection become the same object. A band has to sit at a
   different rank than the selection.
3. **A translucent band on a sticky header is a bug.** Every `*-subtle` token is
   `rgba()`, and the repo header is `position: sticky` (`SessionGroup.tsx:336`),
   so rows scroll *through* a tinted band rather than under it. Composite the
   tint over an opaque base — `linear-gradient(tint, tint), var(--color-bg-primary)`
   keeps the token rather than hardcoding the resulting hex. The mock keeps an
   uncomposited copy (option 4c-raw) as the visible guard. This applies to any
   hue-tinted band, including variant 5's spine if it ever moves onto the header.

Contrast ratio is luminance-only, and that matters here: the accent-tinted band
measures the same 1.12 : 1 as the as-specced one in Claude Light, yet reads far
more clearly, because it separates by **hue** rather than by lightness. Don't
pick the band fill off the numbers alone.

### Carrying the accent edge down the whole group

4e puts the per-repo hue on the header band's left border, so it labels the
*header*. Running the edge the full height of the group makes it label the
*group*: sessions, the `New session` row, and both sub-section labels all sit
inside one continuous vertical claim. It also collapses variant 4's band and
variant 5's spine into a single mechanism doing both jobs, which is a reason to
prefer it over shipping the two separately.

Implementation constraints found while mocking it:

- **Draw the edge as `border-left` on the group element, not on the header.** The
  repo header is `position: sticky`, so an edge on `.ghead` visibly breaks at the
  seam the moment the header pins. On the group it paints behind the pinned band
  and stays continuous. Variants that need rounding or a gradient can't use a
  border, so they need an absolutely-positioned pseudo-element with a `z-index`
  above the sticky header.
- **A per-repo body wash should use `color-mix`, not `rgba`.**
  `color-mix(in srgb, var(--accent) 6%, var(--color-bg-primary))` resolves to an
  *opaque* color, which is what the sticky-header rule above demands, and it
  derives the tint from the hue variable instead of needing a second pre-tinted
  token per repo.
- **Judge it at eight repos, not four.** A 3px colored line per group is the
  densest ink of any option explored; the failure mode is the rail reading as a
  barcode, and that only shows up at real repo counts. The mock's dense toggle
  exists for this.
