---
issue: https://linear.app/shipit-ai/issue/SHI-175
title: Onboarding starter prompts (empty-session launchpad)
description: Clickable example prompts on every empty session that seed the composer, teaching first-time users how to drive ShipIt.
---

# Onboarding starter prompts

## Problem

A first-time user who opens a new session sees the rocket animation, an empty
message list, and a composer — but nothing tells them *what to do* or that
ShipIt is integrated end-to-end (the agent writes code, runs a live preview,
and opens PRs). The `HomeScreen` welcome only shows when **no** session is
active; the moment the user is actually about to type their first prompt, we
give them no guidance.

## Why not a banner

The first instinct was a persistent "how to use ShipIt" banner at the top of
the chat. Rejected on two grounds:

1. **It tells instead of shows.** ShipIt's model is CLAUDE.md §5 — *chat is the
   input surface, the agent is the actor*. The on-brand way to teach that is to
   put example prompts in the user's hands, not prose above the fold.
2. **It fights the rocket.** The empty chat area is exactly where the
   `RocketLaunch` overlay lives. A persistent banner either covers it or pushes
   it around, and it costs permanent real estate.

## Design

A lightweight **empty-state launchpad**: a short lead-in line plus a few
clickable example-prompt chips, rendered in front of the rocket in the same
empty chat area.

- **Clicking a chip seeds the composer** via `useSessionStore.setPrefillText()`
  — the sanctioned edit-then-send pattern (the chip fills the textarea, focuses
  it, drops the cursor at the end). The user reviews and presses Enter. This
  teaches the actual input surface rather than acting as a shell-shaped button
  (§5-aligned). It does **not** auto-send.
- **Context-aware prompts** keyed on `currentRepoUrl` (App.tsx): repo-backed
  sessions get "work on existing code" prompts (explain the project, find & fix
  a bug + open a PR, add a feature, write tests); scratch/sandbox sessions get
  "build from zero" prompts (landing page, portfolio, to-do app, browser game).
  Each prompt is a real end-to-end task, so the example itself communicates that
  ShipIt is integrated.
- **Shown on every empty session**, gated on the **same condition as the rocket**
  (`showRocket` = `messages.length === 0 && !isLoading && (historyLoaded ||
  showNewSessionView)`). It therefore appears on every empty session and
  disappears the instant the first message lands — nothing to dismiss, no
  first-run flag, no persisted state.
- **Coexists with the rocket.** The launchpad layer is `pointer-events-none`
  (only the chips re-enable pointer events) and renders in normal stacking
  context; the rocket sits at `z-index: -1` behind it. Chips have a translucent
  blurred background so they stay legible while the rocket launches behind them.

## Key files

- `src/client/components/StarterPrompts.tsx` — the component. Two prompt sets
  (`SCRATCH_PROMPTS`, `REPO_PROMPTS`), a `repoBacked` prop selecting which set +
  lead-in, and an `onPick(prompt)` callback. Chips are rounded pills with a
  Phosphor icon, short label, and a hover arrow.
- `src/client/App.tsx` — renders `<StarterPrompts>` inside the empty-state
  container right after the rocket layer, gated on `showRocket`, with
  `repoBacked={!!currentRepoUrl}` and `onPick` wired to `setPrefillText`.
- `src/client/components/StarterPrompts.test.tsx` — variant selection (repo vs
  scratch) and that clicking seeds the full prompt, not the short label.

## Visual reference

`mockup.html` (this directory) — both variants side by side, showing chip
placement above the composer and the rocket glow layered behind.

## Rejected alternatives

- **Persistent dismissible banner** — see "Why not a banner".
- **First-session-only (localStorage flag)** — more "onboarding," but needs
  dismissal/first-run state and disappears for power users who'd still find a
  launchpad handy. Showing on every empty session is simpler and stays useful.
- **Seeded agent welcome message** — the agent "speaks first." Very on-brand but
  clutters chat history and needs transcript-persistence plumbing (CLAUDE.md
  "Chat transcript content MUST be persisted"). Not worth it for a launchpad.
