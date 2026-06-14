---
issue: https://linear.app/shipit-ai/issue/SHI-140
description: A collapsible chip strip on the PR card listing the docs and config files changed across the whole PR, each opening the file inline — no Docs-page detour.
---

# PR-scoped quick access to changed docs

**Visual reference:** [mockup.html](./mockup.html) — collapsed (zero-height) and expanded (Option B chips) states of the PR card.

## Problem

When the agent changes a design doc (or another file worth noticing — `shipit.yaml`,
`docker-compose.yml`, `CLAUDE.md`, `package.json`) somewhere in a multi-turn session,
there's no quick way to know it happened or to open it. The change is buried: you'd
have to open the Docs panel, or scan the full diff, or remember which turn touched it.
A doc changed on turn 1 is invisible by turn 12.

This violates principle §1/§2 — the thing you need ("which docs moved, open one") should
be **inline and on the happy path**, not a detour to another panel.

## Why the PR card

The surface must be **sticky** (always reachable regardless of scroll) and **PR-scoped**
(the whole branch, not a single turn). The PR lifecycle card is exactly that surface and
nothing else is:

- It is the **chat panel's top chrome** — rendered at `App.tsx` *outside* the message
  list (docs/156), always visible for the active session, pre-PR included. It is **not**
  a transcript message: it's backed by `pr-store` (keyed by session, updated in place via
  `updateCard`, stable `cardId: pr-card-${sessionId}`). It never scrolls away.
- It is already **PR-scoped** and already carries a `files?: PrFileStat[]` field on
  `WsPrLifecycleUpdate` (today populated from GitHub's files connection for open PRs; the
  pre-PR "ready" phase can derive it from `base...HEAD`).

A per-turn chat card was the rejected alternative: it's per-turn (wrong scope) and lives
in scrollback (not sticky) — it reproduces the exact "buried after N turns" problem.

## Design

A **two-document icon button** is added to the PR card header's action cluster, **left of
the ⋯ menu**. It appears **only when** the PR changed ≥1 notable file — its presence is the
signal, so there is **no count badge** (you can see/count them on expand).

- **Collapsed (default):** icon only. The header bar is pixel-identical to today — **zero
  added height**. Caret points up.
- **Expanded:** the icon turns active (purple, `--color-pr`), the caret flips **down**
  toward the panel, and a strip drops in below the header (inside the same card) listing the
  notable changed files as **compact chips** (Option B — chips wrap several-per-line for
  density; the strip caps its height and scrolls for big PRs).
- **Each chip:** doc/config icon + frontmatter **title** (or filename) + a colored status
  **dot** (amber = modified, green = added, red = deleted). Full path on hover (`title`).
  Click → `useFileStore.getState().openPreview(sessionId, path)` → rich-markdown preview
  modal. No Docs-page detour.

### What counts as "notable"

A small classifier over the PR's changed-file list, two tiers:

1. **Design docs** — `.md` files (the docs the user cares about; `docs/NNN-*` and any other
   markdown). Resolve the frontmatter `title` via the existing doc metadata path so the chip
   reads "Session lifecycle", not "plan.md".
2. **Config** — an allowlist: `shipit.yaml`, `docker-compose.yml`, `CLAUDE.md` / `AGENTS.md`,
   `package.json`. The "wait, what moved?" files.

Everything else stays in the full diff and is **not** shown here (keeps the strip signal,
not a second diff view). If the PR changed no notable file, the toggle is **hidden entirely**
(no empty state).

### Collapse state

Remembered **per session in localStorage** (not server-persisted): mobile and desktop can
differ independently, and it's pure view state. **Default collapsed** when no stored
preference exists.

## Data flow

1. **Server — compute the notable list per PR.** Reuse the file list that already feeds the
   PR card. For open PRs that's `WsPrLifecycleUpdate.files` (`PrFileStat[]`); for the
   pre-PR "ready" phase, derive it from `git.diffNameStatus(base, HEAD)` (sits next to the
   existing `git.diffStatVsBranch` call in `services/pr-lifecycle.ts`). Filter to the
   notable set, attach the resolved doc `title`, and send it as a new
   `notableFiles?: NotableFileChange[]` field on `WsPrLifecycleUpdate`
   (`{ path, title, kind: "doc" | "config", status: "M" | "A" | "D" }`).
2. **Client — store + render.** `pr-lifecycle-update.ts` already forwards the update into
   `pr-store` via `updateCard`; add `notableFiles` to `PrCardState`. A new
   `ChangedDocsToggle` (header button) + `ChangedDocsStrip` (chip panel) render off
   `card.notableFiles`, gated on `notableFiles.length > 0`.
3. **Client — open.** Chip click calls the existing `openPreview(sessionId, path)` — markdown
   renders as rich HTML in `FilePreviewModal`, code/config in Monaco.
4. **Collapse persistence.** A tiny `localStorage` helper keyed by sessionId; default
   collapsed.

No new persistence layer, no new chat-history card, no per-turn snapshotting — the strip is a
pure projection of the PR card's existing file data, so it's sticky and drift-free by
construction.

## Key files (to touch)

- `src/server/shared/types/github-types.ts` — `WsPrLifecycleUpdate.notableFiles`,
  `NotableFileChange` type.
- `src/server/orchestrator/services/pr-lifecycle.ts` — compute + attach `notableFiles`
  (open + ready phases).
- `src/server/orchestrator/markdown.ts` — reuse frontmatter `title` resolution for `.md`
  paths.
- `src/client/stores/pr-store.ts` — `notableFiles` on `PrCardState`; `updateCard` passthrough.
- `src/client/hooks/message-handlers/pr-lifecycle-update.ts` — forward `notableFiles`.
- `src/client/components/PrLifecycleCard.tsx` — header toggle button (left of `PrActionsMenu`)
  + the chip strip row.
- `src/client/components/ChangedDocsStrip.tsx` (new) — chip list, opens `openPreview`.
- localStorage helper for per-session collapse state (`utils/`).

## Open questions / later

- Chip layout is Option B (density). Option A (full-width rows) is kept in the prototype
  history if we want a denser-vs-legible toggle later. ("We can change it later.")
- Config allowlist is a starting set; easy to extend.
