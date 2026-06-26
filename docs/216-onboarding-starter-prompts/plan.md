---
issue: https://linear.app/shipit-ai/issue/SHI-175
title: Onboarding starter prompts (empty-session launchpad)
description: Clickable chips on every empty session that seed the composer with ShipIt-specific capability prompts, surfacing integrated features new users wouldn't discover.
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

A lightweight **discoverability launchpad**: a short lead-in line plus a few
clickable chips, anchored to the **top** of the empty chat area.

- **The chips teach hard-to-discover, ShipIt-specific capabilities** — not
  generic "build an app" tasks. Each chip seeds a prompt that exercises an
  integrated feature the user would otherwise never know to ask for in chat:
  opening a PR, deploying, getting a second opinion from another agent backend
  (Codex), planning with a rendered diagram, and filing a ShipIt bug report.
  The example itself is the discovery mechanism.
- **Clicking a chip seeds the composer** via `useSessionStore.setPrefillText()`
  — the sanctioned edit-then-send pattern (the chip fills the textarea, focuses
  it, drops the cursor at the end). The user reviews and presses Enter. This
  teaches the actual input surface rather than acting as a shell-shaped button
  (§5-aligned). It does **not** auto-send. Every seeded prompt is sendable as a
  *first* message — nothing assumes prior work in the session.
- **Context-aware prompts** keyed on `currentRepoUrl` (App.tsx). Both sets are
  ShipIt-specific; they differ only in framing:
  - *Scratch/sandbox* (no repo): build an app + open a PR, build + deploy to
    Vercel, plan with a diagram, second opinion from another agent, report a
    ShipIt bug.
  - *Repo-backed*: explain the project, find a bug + fix it + open a PR, second
    opinion from another agent, write tests for weak spots, report a ShipIt bug.
- **Shown on every empty session**, gated on the **same condition as the rocket**
  (`showRocket` = `messages.length === 0 && !isLoading && (historyLoaded ||
  showNewSessionView)`). It therefore appears on every empty session and
  disappears the instant the first message lands — nothing to dismiss, no
  first-run flag, no persisted state.
- **Top placement, clear of the rocket.** The rocket rests at the *bottom* of
  the empty chat area for its first ~7s and only then lifts off upward. Anchoring
  the chips to the **top** keeps them out of the rocket's resting position (an
  earlier bottom-anchored version visually collided with it). The launchpad
  layer is also `pointer-events-none` (only the chips re-enable pointer events)
  and the rocket sits at `z-index: -1` behind it; chips have a translucent
  blurred background so they stay legible.

## Feature inventory (chip source material)

The chips are drawn from a survey of ShipIt-specific, agent-reachable
capabilities documented in `src/server/shipit-docs/` — the ones a user would not
discover on their own. The fuller menu (for rotating chip sets later): open/label
a PR from chat, consult another agent backend (`shipit agent run`), run a code/
security review, tracker-neutral issue create/view/edit (`shipit issue`), link an
issue to a PR (`Closes`), write design docs + mockups, live preview + compose
service control, declare secrets, deploy to Vercel/Cloudflare, propose & cut a
release (`shipit release`), spawn & coordinate parallel sessions, sandbox/ops
sessions, present visual artifacts, voice summaries, and file a ShipIt bug
(`report_shipit_bug`). The initial five-per-variant set above picks the ones that
are both high-value and sendable as a first message.

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

`mockup.html` (this directory) — both variants side by side, showing the chips
anchored to the top of the chat area with the rocket glow layered behind/below.

## Rejected alternatives

- **Persistent dismissible banner** — see "Why not a banner".
- **First-session-only (localStorage flag)** — more "onboarding," but needs
  dismissal/first-run state and disappears for power users who'd still find a
  launchpad handy. Showing on every empty session is simpler and stays useful.
- **Seeded agent welcome message** — the agent "speaks first." Very on-brand but
  clutters chat history and needs transcript-persistence plumbing (CLAUDE.md
  "Chat transcript content MUST be persisted"). Not worth it for a launchpad.
