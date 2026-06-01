---
status: planned
priority: medium
description: A first-class inline "voice note" message type — a short spoken headline the agent emits only when it needs the user, rendered as a playable bubble that reuses the existing TTS infra.
---

# Voice notes — agent-authored spoken headlines

## Problem

ShipIt has two voice mechanisms today, and neither is the right surface for
"tell me, by voice, the thing I actually need to know."

1. **Per-turn playback** (`PlayTurnButton` → `/api/voice/speak` → TTS;
   `docs/144-voice-input`). You press Play on a finished turn and it reads the
   turn's prose aloud. The server strips code and markdown — but stripping
   *syntax* doesn't fix the *content*. The prose was written for eyes: it
   hedges, enumerates files, narrates tool calls ("let me now…"), and is far
   too long for the ear. Stripped of code it's still a transcript, not a
   script. Skimmable with eyes, useless as audio.

2. **`notify_turn_end`'s `voiceSummary`** (`docs/159-turn-end-notification-mcp`).
   This field is *already* an ear-optimized one-or-two-sentence summary, with a
   `needsAttention` boolean. But it's wired to **external** delivery (a personal
   MCP server → Telegram / voice call). The artifact ShipIt wants already
   exists; it's just thrown over the wall instead of rendered inline.

So the discipline of "write for the ear" is already present in the product —
it's only ever delivered outside ShipIt. This feature brings it **inline**,
which is squarely on-principle (§1 "ShipIt is the surface"; §2 "inline beats
link-out"): a voice user shouldn't depend on a separate notification service to
hear what their agent is doing.

## Core idea

A **voice note** is a distinct, first-class chat artifact: a short spoken
*headline*, authored for the ear, rendered inline as a compact playable bubble
(with a text fallback for the chat). It is separate from "voice the whole
turn," which remains as an escape hatch for when you genuinely want the full
detail read out.

Two invariants define the feature:

### Invariant 1 — a voice note is a *headline*, never the body

Its job, for a distracted/eyes-off user, is to (a) grab attention and
(b) orient them on *what it's about and what they need to do*. It does **not**
convey the payload — the screen still holds the options, the plan, the diff.

| Surface | Voiced headline | Never voiced |
|---|---|---|
| Turn-end summary | "Done — one test's still red, want me to dig in?" | the full turn prose |
| Structured question | "I've got a question about how delivery should work — options on screen, take a look." | the 4 options + descriptions |
| Plan approval | "I've drafted a plan to add voice notes, about six steps — want to review it?" | the plan body |

Because all three are the same artifact (a spoken headline that pulls you back
to the screen), questions and plan-mode aren't special cases — they're just two
more places that need a headline authored.

### Invariant 2 — voice notes fire *only when the user is needed*

The gate already exists as a signal: `notify_turn_end`'s `needsAttention`.

- **`needsAttention: true`** (question, decision, plan approval, blocking
  ambiguity, error needing input) → emit a voice note.
- **`needsAttention: false`** (work done, nothing to decide, auto-merge will
  carry it) → **silent**. The PR card / chat already shows it's done; reading
  it aloud is noise. This is the explicit ask: don't interrupt me when there's
  nothing for me to do.

The agent gets no new "should I voice this?" decision — it reuses the attention
judgment it already makes at turn end. One signal, no drift.

## Triggers and mechanism

**Key enabling fact (confirmed against the code):** the orchestrator already
observes every agent tool call and its full args server-side.
`wireAgentListeners` extracts `tool_use` blocks — `{ name, input }` — from each
`agent_assistant` event (`agent-listeners.ts:649-665`, via `recordToolUses`),
and already pattern-matches MCP tool names with `MCP_TOOL_NAME_RE`
(`/^mcp__([a-z][a-z0-9]*)__/`, ~`agent-listeners.ts:263`) for crash detection.
So ShipIt can read the name and `input` of `notify_turn_end`, `AskUserQuestion`,
and `ExitPlanMode` calls *as they happen*, with no agent-side change. This is
the hinge of the whole feature — and it's already true. (This resolves what was
Open Question #1.)

But *observing* a call only helps if the call is actually made. That splits the
triggers into ones ShipIt **owns** and ones that are **opportunistic**:

| Trigger | What's voiced | How it's authored | Owned by ShipIt? |
|---|---|---|---|
| Built-in `say` tool (turn-end + mid-task) | agent's headline | ShipIt-defined tool the agent is instructed to call | **Yes** — primary path |
| `mcp__*__notify_turn_end`, `needsAttention: true` | the external `voiceSummary` | reuse the call if the user configured the hermes MCP | No — opportunistic bonus |
| `AskUserQuestion` call observed | nudge derived from the question | server-side, from the observed `input` (headers/questions) | **Yes** — derived |
| `ExitPlanMode` call observed | "drafted a plan, want to review?" | server-side, generic + optional derived title | **Yes** — derived |
| Turn end, nothing needed | nothing | silent | — |

### Why the mechanism changed from "co-authored fields"

An earlier draft proposed adding an optional `voiceSummary` field to
`AskUserQuestion` and `ExitPlanMode` so the agent co-authors the headline. **That
is not implementable: those are built-in Claude CLI tools, not ShipIt-defined
ones — their input schemas are owned by the CLI, so ShipIt cannot add a field
the model will populate.** Likewise, relying on `notify_turn_end` as the
turn-end trigger silently does nothing for the majority of users who never set
up the optional external hermes MCP (`docs/159`, `status: low`, "an evening on
the receiver"). The flagship "no new agent action" case can't depend on optional
external setup.

The fix for both: **ShipIt owns the contract.**

- **A built-in `say` tool**, registered in the agent's catalog and documented in
  `shipit-docs/`, is the *primary* path. The agent calls it with a spoken
  headline and a `needsAttention` flag at turn end (when attention is needed)
  and for mid-task heads-up. ShipIt defines the schema, so the contract is
  stable; ShipIt observes the call, so rendering is guaranteed. This works with
  zero external setup.
- **Questions and plans** are handled by *observing the built-in CLI tool calls*
  (`AskUserQuestion`, `ExitPlanMode`) server-side and emitting a voice note from
  the observable `input`. Headline quality is the tradeoff — a derived nudge
  ("the agent has a question about *<first question header>* — options on
  screen") is weaker than an agent-authored sentence, but it requires nothing
  the CLI doesn't already give us and can't be forgotten. The agent may *also*
  precede the interrupt with a richer `say` call; if it does, prefer that and
  suppress the derived nudge to avoid double-speak.
- **`notify_turn_end` reuse is opportunistic only**: if the user *does* run the
  hermes MCP, ShipIt can render its `voiceSummary` inline too — but the feature
  does not depend on it, and must de-dup against it (see open questions).

## Delivery — gated on hands-free / voice mode

`docs/144` deliberately shipped playback as **manual, no auto-play** ("the chat
shouldn't be doing things the user didn't initiate") and deferred "what
hands-free mode should mean" to a follow-up. This feature is that follow-up.

- **Voice / hands-free mode ON** → the voice note autoplays with a short chime.
  This is the away-from-keyboard / mobile (Android WebView) case where eyes-off
  is the whole point.
- **Voice / hands-free mode OFF** (default) → no autoplay. The note renders as a
  prominent "▶ the agent needs you" prompt the user taps. Preserves the §144
  no-surprise-audio stance for keyboard users.

Mode is a persisted client toggle (settings-store), not a server concept — the
server always produces the note; the client decides whether to autoplay.

## Principles check

- **§1 / §2 (surface / inline):** moves a workflow the user currently runs
  through an *external* MCP service back *into* ShipIt. Strongly on-principle.
- **§5 (chat is input, agent is actor):** the agent emitting voice notes is the
  *agent acting* — the user only listens and responds. Not a shell-shaped
  affordance. The one new user-facing control is a mode toggle, which is a
  preference, not a command button.

## Touchpoints (for a future implementation pass — not yet built)

Reuses the existing voice stack; this is mostly a new message type plus a few
optional fields, not new audio infrastructure.

**Reused as-is:**
- `src/client/voice/playback-store.ts` — single-audio-element invariant, blob
  cache, play/pause/stop. A voice note is just another `(id, text)` to play.
- `src/server/orchestrator/voice/tts-cache.ts` — disk LRU keyed by
  `sha256(provider \n voice \n speed \n text)` (see `tts-cache.ts:28`).
  Voice-note text caches the same way.
- `src/server/orchestrator/services/voice.ts` `speakVoice()` /
  `POST /api/voice/speak` — synthesis endpoint. Voice notes hit the same route.
  Note: voice-note text is *already* clean, so `stripForTts()` is largely a
  no-op for it (vs. its heavy role for whole-turn prose).
- `src/server/shared/voice-catalog.ts` — provider/voice/speed selection.

**New / changed:**
- **A `voice_note` server→client WS message** (new type in
  `shared/types/ws-server-messages.ts`) carrying `{ id, headline,
  needsAttention, kind: 'turn-end' | 'question' | 'plan' | 'adhoc' }`. Emitted
  via `runner.emitMessage()` so it buffers into the turn-event log and survives
  reconnects (per the WS-lifecycle rules in CLAUDE.md).
- **A built-in `say` tool** (ShipIt-defined, in the agent's catalog) — the
  *primary* path. Schema is ShipIt's, so it's stable and observable. The agent
  is instructed (system prompt + `shipit-docs/`) to call it with a headline +
  `needsAttention` at turn end when attention is needed, and for mid-task
  heads-up.
- **Server-side observation of built-in CLI interrupts.** In
  `agent-listeners.ts`'s `agent_assistant` branch (where `tool_use` blocks are
  already extracted, ~lines 649-665), match `say`, `AskUserQuestion`,
  `ExitPlanMode`, and — opportunistically — `mcp__*__notify_turn_end`. Emit a
  `voice_note` from the observed `input`. No agent-side change needed; this is
  the same shape as the existing `MCP_TOOL_NAME_RE` crash-detection code.
  `AskUserQuestion` / `ExitPlanMode` headlines are *derived* from their args
  (ShipIt cannot add fields to CLI-owned schemas).
- **Client rendering:** a voice-note bubble component + integration in
  `MessageList.tsx`, distinct from `PlayTurnButton` (which stays on turn
  footers). Autoplay logic keyed off the mode toggle.
- **A hands-free / voice-mode toggle** in settings-store + settings UI.
- **`src/server/shipit-docs/`** — document the `say` tool and the
  question/plan `voiceSummary` fields for the agent.

## Relationship to existing features

- **`docs/144-voice-input`** — owns the manual per-turn Play button and the TTS
  provider/cache stack (`playback-store`, `tts-cache`, the `speak` route,
  `voice-catalog`, the voice settings). Voice notes coexist with it: Play-turn =
  "read me the whole thing, on demand"; voice note = "the curated headline, when
  I'm needed." This feature also resolves 144's explicitly-deferred "hands-free /
  auto-play" question — and in doing so **overrides 144's default "no auto-play"
  stance**, but only behind an opt-in mode that is OFF by default, so the
  no-surprise-audio promise holds for users who don't turn it on.
  **Hard dependency:** 163 reuses 144's entire TTS stack, so 163 cannot ship
  until 144's playback infrastructure has landed. The new mode toggle must be
  coordinated with 144's voice settings rather than added independently.
- **`docs/159-turn-end-notification-mcp`** — stays as the *external* push path.
  This feature is the *inline* counterpart and reuses its `voiceSummary` /
  `needsAttention` contract verbatim, so an inline note and an external
  notification say the same thing.

## Open questions

1. **Headline quality for derived question/plan nudges.** Since ShipIt can't add
   a field to `AskUserQuestion`/`ExitPlanMode`, the nudge is derived from
   observable args — e.g. the first question's `header`, or the plan's first
   line. Is a derived "the agent has a question about *<header>*" good enough, or
   do we want to *require* the agent precede these interrupts with a richer `say`
   call (and treat the derived nudge purely as a fallback)? Leaning: derive by
   default, prefer a preceding `say` when present, never block on it.
2. **Over-narration via `say`.** A freely-callable `say` tool invites exactly the
   mid-task chatter Invariant 2 exists to suppress. How do we keep the agent
   honest — instruction discipline only ("call `say` at turn-end when attention
   is needed, sparingly mid-task"), or a server-side rate limit / per-turn cap?
3. **De-dup across channels.** A user with both the hermes MCP and inline notes
   gets a Telegram/voice push *and* an in-app autoplay for the same
   `needsAttention: true` turn — two interruptions for one event, arguably worse
   than either. Should inline notes suppress when an external `notify_turn_end`
   MCP is configured, or should the opportunistic `notify_turn_end` reuse be
   dropped entirely once the built-in `say` path exists?
4. **`needsAttention: false` but the turn *failed*.** The gate treats `false` as
   "relax, nothing to do," but an agent that gave up without a decision for the
   user still goes silent — which a hands-free user would want to hear. Does the
   gate need a third state (failed-but-not-blocking), or does "failed" always
   imply `needsAttention: true`?
5. **Autoplay UX in hands-free mode** — chime sound; behavior when a note arrives
   while another is playing (reuse playback-store's one-at-a-time
   stop-and-start?); behavior when the tab is backgrounded.
6. **Should `say` respect the mode gate** when OFF — show a prompt only — or is an
   explicit agent voice note always at least surfaced (since the agent chose to
   send it)?
