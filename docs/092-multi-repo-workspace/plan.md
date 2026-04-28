---
status: planned
---

# 092 — Multi-Repo Workspace

## Problem

ShipIt currently supports multiple repos, but the sidebar shows only one repo's sessions at a time. Users who work across several repos (e.g., a frontend app + backend API + shared library) constantly switch between repos via the dropdown, losing context. There's no way to see or jump between sessions across repos without first switching the active repo.

## Current state

- **Repo switcher dropdown** (top of sidebar) — selects one "active repo" at a time.
- **Session list** — shows only sessions belonging to the active repo.
- **File tree** — shows files for the currently active session.
- Sessions are scoped to a single repo via `remoteUrl`.
- `activeRepoUrl` is persisted to localStorage and controls what's visible.

## Goals

1. Let users see and access sessions from **multiple repos simultaneously** in the sidebar.
2. Preserve fast navigation — switching between sessions (even cross-repo) should feel instant.
3. Don't break the single-repo experience — users with one repo should see no extra complexity.
4. Keep the data model intact: one session = one repo. This is about UI organization, not monorepo support.

## Non-goals

- Monorepo / multi-folder workspaces within a single session.
- Cross-repo code references or linking.
- Merging file trees from multiple repos into one view.

---

## Design Options

### Option A: Grouped Session List (recommended)

**Concept:** Remove the repo switcher dropdown. Instead, show all sessions grouped by repo in a single scrollable sidebar list. Each repo group reuses the same visual slot that the current "Sessions" header occupies — the repo name + icon *replaces* the "Sessions" label, and "View All" moves into the same row.

**Current sidebar layout (single repo):**
```
┌─────────────────────────┐
│ [≡]  🐙 acme/frontend ⚙│  ← repo header (today)
│ ─────────────────────── │
│  Sessions     View All  │  ← sticky subheader
│    ● Fix auth bug       │
│    ○ Add dark mode      │
│    [+ New Session]      │
└─────────────────────────┘
```

**Proposed multi-repo layout:**
```
┌─────────────────────────┐
│ [≡]              [+ Add]│  ← top bar (collapse toggle + add repo)
│ ─────────────────────── │
│  🐙 frontend   View All│  ← repo header = replaces "Sessions" row
│    ● Fix auth bug       │
│    ○ Add dark mode      │
│    [+ New Session]      │
│                         │
│  🐙 api        View All│  ← second repo header
│    ● Migrate to v3      │
│    [+ New Session]      │
│                         │
│  🐙 shared-lib ▸       │  ← collapsed, no active sessions
└─────────────────────────┘
```

The key insight: the current sidebar already has a sticky "Sessions / View All" subheader inside the scrollable area (line 354-365 in `SessionSidebar.tsx`). In the multi-repo version, each repo group gets its own copy of that row — with the repo name + GitHub icon replacing the "Sessions" text, and "View All" staying in the same position. This means:

- **Single-repo users** see almost the same layout as today — the only difference is the header says `🐙 frontend` instead of `Sessions`.
- **Multi-repo users** see the pattern repeat for each repo, which reads naturally as a grouped list.

**Behavior:**
- Each repo gets a collapsible section header showing the repo short name + GitHub icon, with "View All" on the right.
- The top bar loses the repo name (it moves into the group header) and gains an "Add Repository" button.
- Sections are sorted by most-recently-used session within each repo.
- Clicking a session activates it (and implicitly its repo) — the file tree, preview, and chat all switch.
- Repo headers are clickable to collapse/expand. Chevron indicates state.
- Repo headers have a context menu (right-click): remove repo, copy URL, open on GitHub.
- "New session" button appears at the bottom of each repo group (inline, not the full-width primary button).
- Repos with no active sessions show collapsed by default.
- Collapse state is persisted to localStorage.
- "View All" on a repo header opens the AllSessionsDialog filtered to that repo.

**Pros:**
- Full visibility across all repos at a glance.
- No mode switching — everything is one list.
- Minimal backend changes (purely client-side).
- Natural grouping makes it easy to find sessions.
- Reuses existing visual pattern (the "Sessions" subheader row), so it feels familiar.
- Single-repo users see essentially the same UI.

**Cons:**
- Gets tall with many repos/sessions — needs good collapse UX.
- Repo headers consume vertical space (one row per repo).
- Users with 10+ repos might find the list overwhelming (mitigated by collapse + future search).

**Key changes:**
- Remove `RepoSwitcher` dropdown component.
- Replace the top bar repo name with a simpler bar: collapse toggle + "Add Repo" button.
- Extract a new `RepoGroup` component that renders: repo header row (icon + name + "View All") → session list → inline "+ New Session".
- Refactor `SessionSidebar` to render `RepoGroup` for each repo.
- Remove `activeRepoUrl` from repo-store (or repurpose as "last interacted repo" for scroll-into-view).
- Add `collapsedRepos: Set<string>` to repo-store, persisted to localStorage.
- "New session" on home screen still needs a repo picker since there's no single active repo context.

---

### Option B: Tabbed Repos with Pinning

**Concept:** Keep the current single-repo sidebar view, but add a horizontal tab bar at the top for pinned/recent repos. Users can pin repos they actively work across and click tabs to switch instantly.

```
┌─────────────────────────┐
│ [frontend] [api] [+]    │  ← repo tabs (horizontal, scrollable)
│ ─────────────────────── │
│  Sessions — acme/frontend│
│    ● Fix auth bug       │
│    ○ Add dark mode      │
│    + New session         │
│                         │
│  Files                  │
│    ▸ src/               │
│    ▸ public/            │
└─────────────────────────┘
```

**Behavior:**
- Tabs show short repo names (e.g., `frontend`, `api`).
- Clicking a tab switches the sidebar to that repo's sessions.
- `[+]` tab opens the add/search repo dialog.
- Tabs can be reordered via drag-and-drop.
- Badge on tab shows running agent count or unread activity.
- Right-click tab for context menu (close, open on GitHub).

**Pros:**
- Compact — doesn't consume vertical space for repos.
- Familiar pattern (browser tabs, IDE tabs).
- Activity badges give cross-repo awareness without leaving current context.
- Preserves current single-repo sidebar flow almost entirely.

**Cons:**
- Still switches context — can't see sessions from two repos simultaneously.
- Tab bar consumes horizontal space in an already narrow sidebar.
- Requires new state management for tab order, pinning, badges.
- Doesn't fundamentally solve the "I want to see everything" problem.

**Key changes:**
- New `RepoTabs` component replacing `RepoSwitcher` dropdown.
- Tab state (order, pinned) persisted to localStorage.
- SSE events need to carry repo context so badges can update for non-active repos.
- `activeRepoUrl` still drives the sidebar content — just controlled by tab clicks.

---

### Option C: Split Sidebar Panels

**Concept:** The sidebar can be split into independent panels, each pinned to a different repo. Users drag a divider to allocate vertical space.

```
┌─────────────────────────┐
│  acme/frontend          │
│    ● Fix auth bug       │
│    ○ Add dark mode      │
│ ════════════════════════ │  ← draggable divider
│  acme/api               │
│    ● Migrate to v3      │
│    + New session         │
└─────────────────────────┘
```

**Behavior:**
- Default: single panel (same as today).
- User can "split" to add another repo panel below.
- Each panel independently shows sessions for its pinned repo.
- Draggable divider between panels, resizable.
- Max 3 panels to prevent tiny unusable sections.
- Clicking a session in any panel activates it in the main area.

**Pros:**
- True simultaneous multi-repo view.
- Users control exactly which repos are visible and how much space each gets.
- Familiar split-pane pattern from IDEs like VS Code.

**Cons:**
- High implementation complexity (nested resizable panels).
- Limited vertical space — two panels at 240px sidebar width get cramped quickly.
- Unclear interaction model: what happens when you have 5 repos but max 3 panels?
- Doesn't scale well — still needs a fallback for repos not pinned to a panel.

**Key changes:**
- New `SplitSidebarContainer` with resizable panel management.
- Per-panel state: which repo, collapse state, divider position.
- Significant layout refactoring in `AppLayout.tsx`.
- Need fallback UX for "other repos" not in a panel.

---

### Option D: Unified Flat List with Repo Badges

**Concept:** Show all sessions from all repos in a single flat list, with a small repo badge/tag on each session. Provide a filter/search bar at the top to narrow by repo.

```
┌─────────────────────────┐
│  🔍 Filter sessions...  │
│  [all] [frontend] [api] │  ← filter chips
│ ─────────────────────── │
│  ● Fix auth bug          │
│    frontend · 2h ago    │
│  ● Migrate to v3         │
│    api · 4h ago         │
│  ○ Add dark mode         │
│    frontend · 1d ago    │
│                         │
│  + New session           │
└─────────────────────────┘
```

**Behavior:**
- All sessions shown in a single MRU-sorted list.
- Each session row includes a small repo label (short name, colored).
- Filter chips at top let you narrow to one repo or "all".
- Search bar filters by session title and repo name.
- Filter state persists to localStorage.

**Pros:**
- Global MRU view — most recently active sessions bubble up regardless of repo.
- Minimal UI overhead — no grouping, no tabs, just one list.
- Search/filter handles scale well for many repos.
- Easy to implement — extends current list with metadata.

**Cons:**
- Loses visual grouping — harder to scan "all sessions for repo X".
- Repo badges add visual noise to every row.
- Filter chips don't scale past ~5 repos (need overflow menu).
- "New session" needs a repo picker since context isn't obvious from a flat list.

**Key changes:**
- Extend `SessionSidebar` to show all sessions (remove repo filtering).
- Add repo badge to session row component.
- New filter bar component with repo chips.
- Home screen "new session" still needs explicit repo selection.

---

## Comparison Matrix

| Criteria | A: Grouped | B: Tabs | C: Split Panels | D: Flat + Badges |
|----------|-----------|---------|-----------------|-----------------|
| Cross-repo visibility | All at once | One at a time + badges | 2-3 at once | All at once |
| Vertical space efficiency | Medium | High | Low | High |
| Implementation complexity | Low | Medium | High | Low |
| Scales to 10+ repos | Medium (collapse) | Good (scroll tabs) | Poor (max 3) | Good (filter) |
| Single-repo experience | Identical | Identical | Identical | Slightly noisier |
| Backend changes needed | None | Minor (badges) | None | None |
| Familiar pattern | VS Code, Slack | Browser, IDEs | VS Code panels | Slack, Linear |

## Recommendation

**Option A (Grouped Session List)** is the best balance of visibility, simplicity, and implementation cost. It solves the core problem — seeing and accessing sessions across repos — without adding new UI paradigms. The collapsible groups scale reasonably to ~10 repos, and the implementation is almost entirely client-side.

For power users with many repos, Option A can be enhanced later with:
- A search/filter bar at the top (borrowing from Option D).
- "Starred" repos that always expand, others collapse.
- Keyboard shortcuts to jump between repo groups.

## Key files (to change)

| File | Change |
|------|--------|
| `src/client/components/SessionSidebar.tsx` | Grouped layout with collapsible repo sections |
| `src/client/components/RepoSwitcher.tsx` | Remove or repurpose as "Add Repo" button |
| `src/client/stores/repo-store.ts` | Remove `activeRepoUrl`, add `collapsedRepos: Set<string>` |
| `src/client/stores/session-store.ts` | Remove repo filtering from selectors |
| `src/client/App.tsx` | Update sidebar props — no longer pass `activeRepoUrl` |
| `src/client/AppLayout.tsx` | Minor prop changes |
| `src/client/hooks/useApi.ts` | Fetch all sessions, not repo-scoped |
