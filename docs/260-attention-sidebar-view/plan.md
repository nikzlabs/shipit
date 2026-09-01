---
issue: planning#345
title: Sidebar "Needs you" view — design
description: How the second sidebar view is derived, ordered, held stable, and switched.
---

# 260 — Sidebar "Needs you" view: design

**Requirements:** [`requirements.md`](./requirements.md) — human-owned, the source
of truth for what this does. Numbers like (req 7) point there. The visual
reference is [`mockup.html`](./mockup.html), built by
[`build-mockup.py`](./build-mockup.py).

## Shape of the change

The feature is a **projection of state that already exists**. It adds no server
field, no store slice for session data, and no new attention signal:

- **Membership** is `computeAttentionReason() !== null` — the function that
  already drives the row marker, the row tooltip and notifications (req 9).
- **Rows** are the existing `SessionItem` with its `repoLabel` prop set. That is
  the same call `AllSessionsDialog` already makes for its cross-repo list, so a
  row is byte-for-byte the row of the first view (req 11) and gets its repository
  name for free (req 12).

What is genuinely new is small: a view flag, a sticky membership set, one colour
token, one keybinding, and two components.

## The switch

`AttentionViewToggle` is a ghost icon button in the sidebar's existing header
row, in the **left** slot beside the collapse control — not in the right-hand
cluster of create/act controls (req 4). Desktop has the collapse button to its
left; the mobile bar has no collapse button, so the slot is free and the switch
is first (req 15).

The glyph is `ChatsIcon` (a session *is* a chat). An exclamation/warning glyph
was rejected: `WarningCircleIcon` already appears ~40 times in the client for
real warnings, and "something is broken" is the wrong meaning for "your turn".

The pressed state follows the house pattern already used by
`IssuesViewer.tsx`'s "Show done" toggle — `aria-pressed`, `weight="fill"`, a
coloured glyph, and a quiet `--color-bg-tertiary` chip. It is deliberately **not**
a saturated amber button: the header has no other filled control, and an earlier
draft that filled the square put the count badge on top of the glyph and hid it.
Glyph and count sit **side by side in a pill**, so they can never occlude.

The count renders in both views (req 5) and counts sessions that need attention
*right now* — not the sticky set below, which would let it disagree with the
markers on screen.

### The collapse control beside it (req 17)

While the "Needs you" view is showing, the header's leftmost button **leaves the
view**; only the press after that collapses. Its tooltip and `aria-label` change
with it, to **"Back to all sessions"**.

Deliberately *not* the switch's own "Show all sessions", tempting as the symmetry
is: with the count at zero the switch reads exactly those words, so the two
adjacent buttons would carry one name — ambiguous to a voice command ("click Show
all sessions") and noise in screen-reader navigation. Distinct wording, same
destination.

This is a deliberate exception to "one control, one meaning". Overloading a
control on a mode normally *causes* mode errors rather than curing one, and three
things make it safe here:

- **The label follows the press**, so the state is visible, not hidden. Without
  that clause the fix would move the original mistake into the screen reader.
- **Collapsing from this view is worse than a no-op.** The rail carries no
  attention count (see "No view switch on the collapsed rail" below), so it hides
  what the view exists to show and leaves the view on but invisible.
- **`SidebarSimpleIcon` marks the sidebar, not the collapse direction**, so it
  stays true of both presses. The button is the sidebar-*state* control, which is
  also the mental model that produces the mistake.

Two alternatives are out. **Hiding the button** in this view shifts the header and
makes collapsing unreachable. **Swapping the two buttons** so the switch takes the
corner just moves the same mistake into the all-sessions view.

Desktop only — the mobile bar has no collapse control (req 15), and there is no
keyboard chord for collapse, so this button is the single entry point.

### Contrast (req 16)

`--color-attention` is `#f59e0b` on dark themes and `#d97706` on light ones.
Measured against the pressed chip (`--color-bg-tertiary`), the light themes land
at **2.35–2.89:1** — under the 4.5:1 WCAG AA wants for small text, and under even
the 3:1 for a non-text element. Dark themes are fine at 5.25–8.43:1.

So this adds one token, **`--color-attention-text`**: the same amber on dark
themes, and the lightest shade of the amber ramp that clears 4.5:1 on each light
theme — `#b45309` (amber-700) for `light`, `#92400e` (amber-800) for the five
warmer light themes. The switch's glyph **and** count both use it, which keeps
the control one colour rather than two.

`--color-attention` itself is untouched, so the docs/187 row marker is unchanged.
That marker measures 2.94–3.19:1 on light themes — marginally under the 3:1 for a
non-text element. It is a **pre-existing** defect, visible in today's first view,
out of scope here, and recorded separately on the tracker.

A guard test (`attention-contrast.test.ts`) reads the theme CSS and asserts the
new token clears 4.5:1 on every theme, so a future palette edit cannot silently
reintroduce this.

## The list

`AttentionSessionList` renders one flat list — no sections, no sub-groups, no
band, label or exit control above it (reqs 6, 10). The lit icon is the whole mode
indicator. An earlier draft had an amber "Needs you · 4 — Show all" strip; it
cost ~28px (the height that disqualified a segmented control) and repeated what
was already on screen — the count is on the badge, the exit is a second click on
the same icon, and each row carries its own reason in its tooltip.

**Order is arrival order, and it is append-only** (req 7). The rows present when
the view opens are seeded by `createdAt` descending — the only key in the session
model that never changes, and already the first view's within-repo order. A
session that starts needing attention *later* is appended to the end, never
inserted.

A plain `createdAt` sort is **not** enough, and an early draft made exactly that
mistake: a newly-qualifying session lands in its date slot and pushes every row
below it down one — the mis-click req 7 exists to prevent. Sorting by urgency is
the same failure one step worse: it re-orders on every reason change.

**Membership is sticky for the same reason.** A row that stops qualifying would
otherwise vanish from under the pointer, so the order list keeps it until the
view is left and entered again — the list is component state and the component
unmounts on the way out, which is what makes "entered again" the reset (req 8). A
session that leaves the sidebar altogether (archived, hidden, removed) is dropped
at once: stickiness covers a session that stopped *needing* you, not one that
stopped existing.

The order list is **state adjusted during render**, not a ref mutated inside a
memo. React's documented "adjust state while rendering" path is concurrent-safe —
an abandoned render's `setOrder` is discarded with it — whereas a ref written
during render survives a render that never commits, and an effect would let the
list paint once without a row that already qualifies.

A settled row needs no invented marker: it loses the amber one, because
`SessionItem` derives that itself, and it dims to `opacity-60` like an archived
row — req 8's "marked as no longer needing attention" in the human's own words.

Empty state is an inbox-zero line inside the list. This is not the chrome req 10
excludes — that is about a band *above* the list.

Sessions from **hidden repos** (docs/222) are excluded, as is anything archived
or warm, so the view can never show a row the first view has hidden.

## Design choices the requirements do not settle

Recorded here rather than promoted into `requirements.md`, which is human-owned.
Each is reversible and worth a glance:

- **Hidden-repo sessions are out of the view and out of the count.** docs/222
  removes a hidden repo's sessions from the sidebar entirely; a second sidebar
  view that showed them would undo that. Note this leaves the view and
  *notifications* observably different — notifications look at every session.
  That divergence is notifications' existing behaviour, unchanged here.
- **The rows are flat, so a spawned child loses its indentation and a parent its
  caret.** Parent/child nesting is grouping, and req 3 drops grouping;
  `AllSessionsDialog`'s flat list drops it for the same reason.
- **A session with no repository shows no repository name** — ops, sandbox and
  local sessions have none. They keep their existing kind badge instead.
- **The count is hidden at zero rather than shown as "0"**, per the approved
  mockup's inbox-zero drawing: "the count disappears from the switch, so the All
  view carries no permanent amber mark."
- **No view switch on the collapsed rail.** Req 5 asks for the count in both
  *views*, not both collapse states, and a 40px rail can show no list — a control
  there could only mean "expand into the attention view", a different action
  behind the same glyph. The rail carries no session information today.
- **The inactive glyph keeps `--color-text-tertiary`**, like every other header
  icon beside it. That token measures ~2.5:1 on the light themes; raising it for
  this one control would make it louder than its siblings. It is an app-wide
  token question, not this feature's.

## Remembering the view (req 13)

`sidebarView: "all" | "attention"` lives in `ui-store`, seeded from and written
to localStorage under `shipit-sidebar-view` — the same shape as
`sidebarCollapsed` right beside it. Browser-local view state, not server
persisted.

## Keyboard (req 14)

A new registry entry (docs/180), `toggle-attention-view`, group **Sessions**,
default **`mod+alt+a`**, `requiresSecondModifier: true`. Registering it rather
than hard-coding a keydown handler is what puts it in the `?` overlay and the
Keyboard settings tab and makes it rebindable, which is what req 14 asks for.

The chord is deliberately in the `mod+alt+…` family that quick-capture already
uses. `mod+shift+a` was rejected: macOS Chrome reserves it for tab search at the
browser level, where a page cannot `preventDefault` it, so the binding would
simply never fire for a large share of users.

## Key files

- `src/client/components/SessionSidebar/AttentionViewToggle.tsx` — the switch (new).
- `src/client/components/SessionSidebar/AttentionSessionList.tsx` — the flat list + sticky set (new).
- `src/client/hooks/useAttentionSessions.ts` — one pass of `computeAttentionReason` over every session; returns the id set (new).
- `src/client/components/SessionSidebar/SessionSidebar.tsx` — header slot and body swap.
- `src/client/stores/ui-store.ts`, `src/client/utils/local-storage.ts` — `sidebarView` + persistence.
- `src/client/keybindings/registry.ts`, `src/client/hooks/useKeyboardShortcuts.ts` — the chord.
- `src/client/themes/*.css` — `--color-attention-text`.
- `src/client/hooks/useAttentionInfo.ts` — **unchanged**; it is the shared definition (req 9).
