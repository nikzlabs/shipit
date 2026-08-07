---
issue: planning#154
description: Bare issue references in chat/markdown prose (TRACKER-43, roadmap#SHI-319, planning#57) render as inline badges that open the in-app Issues viewer; on mobile the click also switches to the workspace panel.
---

# Inline issue badges for bare issue references

## Why this exists

ShipIt already does two related things:

- `docs/172-file-links-open-preview` auto-links **bare file paths** in prose
  (`docs/155-foo/plan.md`) into in-app preview links.
- `docs/170-inline-tracker-issues` + `docs/189-inline-issue-detail` render a
  **Linear/GitHub issue *URL*** as a click that opens the inline Issues viewer
  instead of bouncing to linear.app — "inline beats link-out" (CLAUDE.md §1/§2).

The gap: the agent (and humans) usually mention a Linear issue as a **bare key**
— "tracked in TRACKER-43", "blocked on TRACKER-79" — not as a full URL. A bare key was
left as plain text because `parseTrackerIssueLink` deliberately won't intercept
it (no absolute URL is derivable from a bare key without the workspace slug).
But the inline viewer doesn't need a URL — the key alone is the tracker-native
lookup id (`Tracker.getIssue(key)`). This feature closes that gap the same way
172 closed the bare-path one.

## What it does

- **Bare issue references become inline badges.** A reference-shaped token in
  chat / docs / PR-body / tooltip markdown renders as a small monospace pill in
  the accent color. Clicking it opens the issue in the inline Issues viewer.
  Both of docs/248 req 10's prose-legible forms are recognized: the **bare key**
  (`TRACKER-43`) and the **name form** (`roadmap#SHI-319`, `planning#57`).
- **The badge does not grow the line height.** It renders at `text-[0.85em]`
  with `leading-none` and horizontal-only padding, so it stays within the
  surrounding prose line box (an explicit requirement — badges must not push
  lines apart). Visual reference: `mockup.html` in this folder.
- **Mobile also switches to the workspace panel.** On a phone the Issues tab is
  only visible in the workspace (`preview`) column, so the click flips
  `mobilePanel` to `preview` *and* selects the `issues` right-tab — not just the
  tab within the workspace. The pre-existing issue-*URL* click already did this;
  the badge shares the same `openIssueInPanel` helper so both behave identically.
- **A declared-destination gate suppresses false positives.** A
  reference-shaped token collides with everyday strings (`GPT-4`, `UTF-8`,
  `COVID-19`, `PR#3`, `channel#2`). The remark plugin is intentionally liberal;
  the badge paints only when the token **resolves through the repository's
  declared trackers** and that destination is **connected**. Everything else —
  undeclared, ambiguous, disconnected — renders as its original text, byte for
  byte.

## Relationship to docs/248

docs/248 (declared issue trackers) introduced the **name form**, `<name>#<id>`,
as the way every reference addresses a destination (req 10), and req 11's two
fail-closed rules: a reference naming no declared destination, or matching more
than one, must never resolve to a guess.

Prose was the last surface that hadn't been brought onto that resolver. The
matcher here predated the name form, so `planning#321` badged only its
`SHI-319` tail and left `roadmap#` outside the pill, and `planning#57` — the form
ShipIt's own references take after docs/247's migration — matched nothing at all.
The gate was Linear-team-specific (compare the token's prefix against the
connected workspace's bound team key), which had no answer for a GitHub name
form and reproduced req 11's ambiguity rule by hand. planning#325 closed both halves:
the matcher learned the name form, and the gate became `resolveIssueRef` over the
declared destinations — the same shared implementation the markdown-href branch,
the doc `issue:` chips and the `shipit issue` shim already used. docs/248's own
checklist records a bug of exactly the shape hand-rolling that rule produces (a
bare key declared by two trackers opened the first match), which is why the badge
now has no gate logic of its own.

## How it works

1. `remarkLinkifyIssues` (`src/client/utils/linkify-issues.ts`) is a remark
   plugin appended to the shared `remarkPlugins` chain in `message-markdown.tsx`,
   **after** `remark-gfm` and `remarkLinkifyPaths`. It walks the mdast, and for
   each reference-shaped token in a `text`/`inlineCode` node splits out a `link`
   node whose `url` is a sentinel `shipit-issue:TOKEN`. It never descends into
   existing `link` nodes, so a key inside an autolinked
   `linear.app/.../issue/TRACKER-43` URL is left for the tracker-URL branch.
   Fenced `code` blocks stay verbatim.
   - `ISSUE_TOKEN_RE` is an **ordered** alternation: the **name form** first
     (`<name>#<planning#306|57>`, mirroring `NAMED_REF_RE` in `shared/issue-ref.ts`),
     the **bare uppercase key** second. The order is what makes a badge cover
     the whole reference — the bare-key branch would otherwise take just the
     `planning#321` tail of `planning#321`. The name form's lookbehind also
     rejects a leading `/`, so a GitHub short form (`owner/repo#42`) isn't
     half-matched as `repo#42`; the bare-key branch's lookbehind is unchanged
     (it still permits a leading `#`, so `issue #planning#5` keeps badging).
2. `react-markdown`'s default `urlTransform` would strip the unknown
   `shipit-issue:` scheme to `""`, losing the token — so `message-markdown.tsx`
   passes a small `urlTransform` that passes that scheme through and delegates
   everything else to `defaultUrlTransform` (which still filters `javascript:`,
   `data:`, etc.).
3. `MarkdownLink` (the `components.a` override) gets a new first branch: an href
   starting with `shipit-issue:` renders `IssueBadge` (not an anchor).
4. `IssueBadge` subscribes to `issues-store`'s `trackers` array and, in a
   `useMemo`, runs the **shared** `resolveIssueRef` (`shared/issue-ref-resolution.ts`)
   over `toTrackerDestinations(trackers)` — the same resolver and the same
   destination projection the href branch and the doc/PR chips use. When the
   token resolves AND the destination is `configured`, it renders the pill;
   clicking calls the shared `openIssueInPanel({ tracker, id: issueId,
   identifier })`, which sets the `issues` right-tab, flips the mobile panel to
   `preview`, and calls `issuesStore.openIssue`. Otherwise it renders the raw
   children (plain text) — no badge, no dead click. The **connected** check is
   the badge's own addition, not the resolver's: unlike an href branch there is
   no external new-tab fallback, so a click on a declared-but-unconfigured
   tracker would open the panel onto an error.
   - The subscription selects `s.trackers` (identity-stable) rather than
     computing destinations inside the selector, which would mint a new array
     on every store read and defeat zustand's snapshot cache. It's still the one
     render-time store read in the module (the link branches read in their click
     handlers), and it doesn't defeat the `MarkdownContent` memo.

## Key files

- `src/client/utils/linkify-issues.ts` — `remarkLinkifyIssues`, `ISSUE_TOKEN_RE`,
  `ISSUE_LINK_SCHEME` (+ test).
- `src/client/components/message-markdown.tsx` — `IssueBadge`, the `MarkdownLink`
  badge branch, `openIssueInPanel` (shared with the issue-URL branch), the
  `urlTransform` scheme passthrough, and the `remarkPlugins` chain.
- `src/client/stores/issues-store.ts` — `toTrackerDestinations` (the projection
  the badge's render-time `useMemo` needs) and `trackerDestinations` over it.
- `src/server/shared/issue-ref-resolution.ts` — `resolveIssueRef`, the shared
  gate (docs/248 req 11). The badge has no resolution logic of its own.
- `docs/207-inline-issue-badges/mockup.html` — line-height visual reference.

## Verification

- `npx vitest run src/client/utils/linkify-issues.test.ts src/client/components/message-markdown.test.tsx`
- In the app (tracker connected and declared): have the agent mention
  `roadmap#SHI-319`, `planning#57`, and a bare `SHI-319` in chat; confirm each
  renders as a pill covering the **whole** token — `roadmap#` inside the badge,
  not stranded beside it — and that clicking opens the inline Issues viewer. On a
  narrow viewport, confirm the click also switches from the chat column to the
  workspace column.
- Confirm `GPT-4` / `UTF-8` / `PR#3` stay plain text, an undeclared name form
  (`nosuch#12`) stays plain text, and a full `linear.app/.../issue/…` URL still
  opens the viewer via the existing URL branch.
