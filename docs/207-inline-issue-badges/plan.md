---
issue: https://linear.app/shipit-ai/issue/SHI-152
description: Bare Linear issue keys in chat/markdown prose (e.g. SHI-43) render as inline badges that open the in-app Issues viewer; on mobile the click also switches to the workspace panel.
---

# Inline issue badges for bare Linear keys

## Why this exists

ShipIt already does two related things:

- `docs/172-file-links-open-preview` auto-links **bare file paths** in prose
  (`docs/155-foo/plan.md`) into in-app preview links.
- `docs/170-inline-tracker-issues` + `docs/189-inline-issue-detail` render a
  **Linear/GitHub issue *URL*** as a click that opens the inline Issues viewer
  instead of bouncing to linear.app — "inline beats link-out" (CLAUDE.md §1/§2).

The gap: the agent (and humans) usually mention a Linear issue as a **bare key**
— "tracked in SHI-43", "blocked on SHI-79" — not as a full URL. A bare key was
left as plain text because `parseTrackerIssueLink` deliberately won't intercept
it (no absolute URL is derivable from a bare key without the workspace slug).
But the inline viewer doesn't need a URL — the key alone is the tracker-native
lookup id (`Tracker.getIssue(key)`). This feature closes that gap the same way
172 closed the bare-path one.

## What it does

- **Bare Linear keys become inline badges.** A key-shaped token (`SHI-43`) in
  chat / docs / PR-body / tooltip markdown renders as a small monospace pill in
  the accent color. Clicking it opens the issue in the inline Issues viewer.
- **The badge does not grow the line height.** It renders at `text-[0.85em]`
  with `leading-none` and horizontal-only padding, so it stays within the
  surrounding prose line box (an explicit requirement — badges must not push
  lines apart). Visual reference: `mockup.html` in this folder.
- **Mobile also switches to the workspace panel.** On a phone the Issues tab is
  only visible in the workspace (`preview`) column, so the click flips
  `mobilePanel` to `preview` *and* selects the `issues` right-tab — not just the
  tab within the workspace. The pre-existing issue-*URL* click already did this;
  the badge shares the same `openIssueInPanel` helper so both behave identically.
- **A team-key gate suppresses false positives.** A bare `[A-Z]+-\d+` token
  collides with everyday strings (`GPT-4`, `UTF-8`, `COVID-19`). The remark
  plugin is intentionally liberal, but the badge only paints when Linear is
  **connected** AND the token's team prefix matches the **bound team key**
  (`TrackerInfo.binding.key`, e.g. `SHI`). Everything else renders as plain text.

## How it works

1. `remarkLinkifyIssues` (`src/client/utils/linkify-issues.ts`) is a remark
   plugin appended to the shared `remarkPlugins` chain in `message-markdown.tsx`,
   **after** `remark-gfm` and `remarkLinkifyPaths`. It walks the mdast, and for
   each key-shaped token in a `text`/`inlineCode` node splits out a `link` node
   whose `url` is a sentinel `shipit-issue:KEY`. It never descends into existing
   `link` nodes, so a key inside an autolinked `linear.app/.../issue/SHI-43` URL
   is left for the tracker-URL branch. Fenced `code` blocks stay verbatim.
2. `react-markdown`'s default `urlTransform` would strip the unknown
   `shipit-issue:` scheme to `""`, losing the key — so `message-markdown.tsx`
   passes a small `urlTransform` that passes that scheme through and delegates
   everything else to `defaultUrlTransform` (which still filters `javascript:`,
   `data:`, etc.).
3. `MarkdownLink` (the `components.a` override) gets a new first branch: an href
   starting with `shipit-issue:` renders `IssueBadge` (not an anchor).
4. `IssueBadge` reads the connected Linear tracker from `issues-store` to apply
   the team-key gate. When matched it renders the pill; clicking calls the shared
   `openIssueInPanel({ tracker: "linear", id: KEY, identifier: KEY })`, which sets
   the `issues` right-tab, flips the mobile panel to `preview`, and calls
   `issuesStore.openIssue`. When NOT matched it renders the raw children (plain
   text) — no badge, no dead click. This is the one render-time store read in the
   module (the link branches read in their click handlers); it's a scoped leaf
   subscription that doesn't defeat the `MarkdownContent` memo.

## Key files

- `src/client/utils/linkify-issues.ts` — `remarkLinkifyIssues` + `ISSUE_LINK_SCHEME` (+ test).
- `src/client/components/message-markdown.tsx` — `IssueBadge`, the `MarkdownLink`
  badge branch, `openIssueInPanel` (shared with the issue-URL branch), the
  `urlTransform` scheme passthrough, and the `remarkPlugins` chain.
- `docs/207-inline-issue-badges/mockup.html` — line-height visual reference.

## Verification

- `npx vitest run src/client/utils/linkify-issues.test.ts`
- In the app (Linear connected, team `SHI` bound): have the agent mention
  `SHI-43` in chat; confirm it renders as a pill and clicking opens the inline
  Issues viewer. On a narrow viewport, confirm the click also switches from the
  chat column to the workspace column.
- Confirm `GPT-4` / `UTF-8` stay plain text, and a full `linear.app/.../issue/…`
  URL still opens the viewer via the existing URL branch.
