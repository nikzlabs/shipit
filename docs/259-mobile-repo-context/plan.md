---
issue: planning#336
title: Repo context bar on the mobile new-session screen
description: A tappable repo bar in the PR-card slot on /{slug}/new, plus per-repo new-session drafts.
---

# 259 — Repo context bar on the mobile new-session screen

Implements [`requirements.md`](requirements.md). The treatment is option **B**
in [`mocks/repo-context.html`](mocks/repo-context.html), chosen from five.

## Problem

Tapping `+` on the mobile tab bar calls `handleNewSessionForRepo`
(`hooks/useSessionActivation.ts:113`) with a repository the app picked
implicitly — the current session's repo, else `activeRepoUrl` — and navigates to
`/repo/{owner}/{repo}/new`. On that route the sessions drawer is closed, mobile
browsers hide the URL, and `showNewSessionView` suppresses the PR lifecycle card
that is a session's only piece of top chrome (`App.tsx:1866`). Header, empty
state, composer and tab bar are all repo-agnostic, so the implicit choice is
unverifiable (reqs 1, 2) and uncorrectable without backing out through the
drawer (req 3).

## Design

### 1. The bar (reqs 1–3)

A new `NewSessionRepoBar` renders in the chat panel exactly where
`PrLifecycleCard` renders, gated on `showNewSessionView && isMobile`. The two
are mutually exclusive by construction — the PR card's condition already
includes `!showNewSessionView` — so the slot has one occupant at a time and the
handover on graduation is automatic, with no vertical space added to the steady
state.

It is one full-width `<button>`:

- **A 3px left edge** in the repo's own docs/254 colour, plus a **band wash**
  behind it via the exported `groupBandFill` (`SessionSidebar/SessionGroup.tsx`)
  — the same two cues the sidebar's repo group header uses, so the identity
  colour means one thing across the app. Both are dropped when
  `repo.colorIndex` is undefined (a row older than the docs/254 backfill), which
  is the same fallback `SessionGroup` takes.
- **"New session in ⟨owner/repo⟩"**, matching the quick-capture picker's
  wording. The label comes from the route **slug**, not from the resolved repo
  record, so the bar names the repo on its very first frame instead of flashing
  empty while the repo list loads. (They are the same string once resolved —
  `newSessionRepoUrl` is found by matching `parseRepoLabel` against that slug.)
- **A trailing caret**, and tapping anywhere opens the repo picker.

Mobile only (req 6 is about the screen, and the desktop already answers the
question in its always-visible sidebar). Desktop rendering is literally
unchanged.

### 2. The picker (req 3)

A bottom sheet listing every repo with its colour swatch, the current one
checkmarked. Picking one calls the existing `handleNewSessionForRepo`, which
already resets state and navigates to that repo's `/new` — so switching repo is
the path the tab bar's `+` already takes, not a new mechanism. Re-picking the
**current** repo only closes the sheet: re-claiming the session the user is
already in would reset the view and take the draft they just typed with it.

Hidden repos (docs/222) are out of the list, since they are out of the sidebar —
except the repo the user is currently in, which is listed and checked even when
hidden, or the picker would claim they are somewhere they are not.

The sheet layout is bespoke inside the shared `Dialog` wrapper, which is what
`QuickCaptureOverlay` already does: the wrapper buys Back-button dismissal, and
`DialogContent` is fullscreen on mobile — a whole screen for a three-row repo
list. `StartSessionButton`'s dropdown picker (docs/236) is not reused either; it
is a desktop split-button whose caret half opens a `DropdownMenu`, and the point
here is one large mobile tap target.

### 3. Per-repo drafts (req 4)

Req 4 asks the switcher to respect draft behaviour the composer already has, so
this is a key change and no new machinery. `useMessageDraft` already saves the
outgoing `focusKey`'s text and loads the incoming key's during render, which is
what makes per-session drafts work. The single reason a repo switch does not
swap the draft today is that `App.tsx:1559` collapses every repo's new-session
view onto the one constant key `"new"`:

```ts
const messageInputFocusKey = showNewSessionView ? `new:${newSessionRepoSlug}` : wsSessionId;
```

Keyed on the **slug** parsed from the pathname, not on `newSessionRepoUrl`.
`newSessionRepoUrl` resolves the slug against the loaded repo list and is
`undefined` until that list arrives, so a URL-derived key would flip from
`new:undefined` to `new:owner/repo` mid-typing — which is exactly the draft-wipe
the existing comment at `App.tsx:1552` warns about. The slug is available
synchronously from the URL and changes only when the user deliberately switches
repo, which is precisely when the draft *should* swap.

No migration for the legacy `shipit-draft-message:new` key. At upgrade time
nothing records which repo that draft was for, and guessing would drop one
repo's text into another's composer; an unsent draft is the cheapest thing in
the app to lose. Nothing sweeps orphaned draft keys — `saveDraftMessage` only
removes a key when its own text goes empty — so the stale `new` entry simply
sits in `localStorage` as a few unread bytes.

## Known limitation: repos whose labels collide

`parseRepoLabel` truncates a repo name at its first dot, so `owner/api.v1` and
`owner/api.v2` both render as `owner/api` — as does `socketio/socket.io`, which
becomes `socketio/socket`. This predates docs/259 and already breaks routing:
`repoLabelToNewPath` builds the route from that label and `App.tsx` resolves it
back with a `find`, so the second colliding repo's new-session page is
unreachable today regardless of this feature.

What docs/259 does about it: the picker identifies rows by **URL**, so exactly
one row is marked current and the other stays switchable. What it does not do:
the draft key is the slug, so two colliding repos share one new-session draft.
Fixing that properly means fixing `parseRepoLabel` — an app-wide routing change
well outside this feature's fence, and pointless in isolation while the route
itself cannot tell the two apart.

## Accessibility of the sheet

Not using `DialogContent` means not inheriting its focus trap, its
outside-content hiding, or its Escape handling. The sheet supplies the parts
that matter for its own shape: `aria-modal`, an Escape listener via
`useEventListener`, and initial focus moved onto the current repo's row so
focus does not sit on the obscured bar behind it. It is still not a true focus
trap — Tab can reach the composer underneath. That trade buys not turning a
three-row list into a fullscreen takeover on mobile; revisit it if a
non-fullscreen sheet primitive ever lands.

## Key files

| File | Change |
|---|---|
| `client/components/NewSessionRepoBar.tsx` | New. The bar + its repo sheet. |
| `client/App.tsx` | Render the bar in the PR-card slot; per-repo `messageInputFocusKey`. |

`SessionGroup.tsx` is untouched: `groupBandFill` is already exported, and the
3px edge is three inline style properties, not worth exporting a helper for.

## Tests

- `NewSessionRepoBar.test.tsx` — names the repo (including from the slug alone,
  before the repo list loads); carries the docs/254 colour and drops it when
  `colorIndex` is undefined; the picker checks the current repo, calls back with
  a different one, and only closes when the current one is re-picked; hidden
  repos are omitted unless it is the repo the user is in; two repos whose labels
  collide are still told apart; Escape closes the sheet; focus lands on the
  current row; the bar meets the 44px touch floor.
- `MessageInput.test.tsx` — a draft typed under one new-session slug is restored
  after switching to another slug and back (req 4).

The gating (`showNewSessionView && isMobile`, never alongside the PR lifecycle
card) is a two-clause condition in `App.tsx` rather than component logic, and
`App` has no render-level test harness to hang an assertion on. It is verified in
the dogfood instance at a mobile viewport instead.
