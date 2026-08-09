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
- **"New session in ⟨owner/repo⟩"** — `parseRepoLabel`, matching the sidebar and
  the quick-capture picker's wording.
- **A trailing caret**, and tapping anywhere opens the repo picker.

Mobile only (req 6 is about the screen, and the desktop already answers the
question in its always-visible sidebar). Desktop rendering is literally
unchanged.

### 2. The picker (req 3)

A bottom sheet listing every non-hidden repo with its colour swatch, the current
one checkmarked. Picking one calls the existing `handleNewSessionForRepo`, which
already resets state and navigates to that repo's `/new` — so switching repo is
the path the tab bar's `+` already takes, not a new mechanism.

`StartSessionButton`'s dropdown picker (docs/236) is deliberately **not** reused:
it is a desktop split-button whose caret half opens a `DropdownMenu`, and the
whole point of this bar is one large mobile tap target.

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

## Key files

| File | Change |
|---|---|
| `client/components/NewSessionRepoBar.tsx` | New. The bar + its repo sheet. |
| `client/components/SessionSidebar/SessionGroup.tsx` | Export `groupEdgeStyle` beside the already-exported `groupBandFill`. |
| `client/App.tsx` | Render the bar in the PR-card slot; per-repo `messageInputFocusKey`. |

## Tests

- `NewSessionRepoBar.test.tsx` — renders the repo label; no colour treatment
  when `colorIndex` is undefined; picking a repo calls back with its URL.
- `App`-level: the bar renders only when `showNewSessionView && isMobile`, and
  never alongside the PR lifecycle card.
- `MessageInput.test.tsx` — a draft typed under one new-session slug is restored
  after switching to another slug and back (req 4).
