---
status: planned
priority: medium
description: One voice-summary primitive the agent emits when it needs the user, with a ShipIt delivery setting (native inline / external webhook / both) — not two separate tools.
---

# Voice notes — one spoken-summary primitive, user-chosen delivery

## Problem

ShipIt has two voice mechanisms today, and neither is the right surface for
"tell me, by voice, the thing I actually need to know."

1. **Per-turn playback** (`PlayTurnButton` → `/api/voice/speak` → TTS;
   `docs/144-voice-input`). You press Play on a finished turn and it reads the
   turn's prose aloud. The server strips code and markdown — but stripping
   *syntax* doesn't fix the *content*. The prose was written for eyes: it
   hedges, enumerates files, narrates tool calls ("let me now…"), and is far
   too long for the ear. Stripped of code it's still a transcript, not a script.

2. **`notify_turn_end`'s `voiceSummary`** (`docs/159-turn-end-notification-mcp`).
   This field is *already* an ear-optimized one-or-two-sentence summary with a
   `needsAttention` boolean. But it's delivered **externally** (a personal MCP
   server → Telegram / voice call), and — critically — it's wired up as **a tool
   in the agent's catalog**: the agent calls `mcp__hermes__notify_turn_end`
   directly because an instructions block tells it to.

The artifact ShipIt wants already exists; it's only ever delivered outside
ShipIt. Bringing it inline is on-principle (§1 "ShipIt is the surface"; §2
"inline beats link-out"): a voice user shouldn't depend on a separate
notification service to hear what their agent is doing.

## The core realization

`say` (a native inline note) and `notify_turn_end` (an external push) are **not
two ideas**. They are *one* idea — "the agent produced an ear-shaped summary
with a `needsAttention` flag" — wearing two delivery mechanisms.

The design mistake to avoid is letting the **delivery mechanism leak into the
agent's tool choice** ("call the native tool, or the MCP tool if hermes is
configured"). The agent must never know how its summary is delivered. **Delivery
is the user's setting, not the agent's decision.**

So there is exactly one agent-facing primitive and a router behind it:

```
  SOURCES                       ROUTER (user setting)     SINKS
  ───────                       ─────────────────────     ─────
  agent calls the               Delivery:                 Native   → inline voice note + TTS
  built-in voice tool   ───┐      ○ Native                           (autoplay gated by hands-free mode)
  (turn-end + mid-task)    │      ○ External
                           ├────▶  ○ Both         ─────▶  External → webhook POST of the same
  ShipIt observes          │                                         payload to the user's endpoint
  AskUserQuestion /     ───┘                                         (Telegram, voice call, push…)
  ExitPlanMode (derived)
```

- **One payload contract** — `{ summary, needsAttention, context }`, the exact
  shape `notify_turn_end` already uses — identical regardless of source or sink.
- **One agent-facing tool**, ShipIt-defined and ShipIt-observed. The agent always
  calls the same thing; its only instruction is "call it at end of turn when
  attention is needed, sparingly mid-task."
- **One router** with a user setting: **Native / External / Both.** This is where
  "the user chooses the mechanism" lives.

## Two invariants

### Invariant 1 — a voice note is a *headline*, never the body

Its job, for a distracted/eyes-off user, is to (a) grab attention and
(b) orient them on *what it's about and what they need to do*. It does **not**
convey the payload — the screen still holds the options, the plan, the diff.

| Surface | Voiced headline | Never voiced |
|---|---|---|
| Turn-end summary | "Done — one test's still red, want me to dig in?" | the full turn prose |
| Structured question | "I've got a question about how delivery should work — options on screen." | the 4 options + descriptions |
| Plan approval | "I've drafted a plan to add voice notes, about six steps — want to review it?" | the plan body |

### Invariant 2 — voice notes fire *only when the user is needed*

The gate is `needsAttention`. `true` (question, decision, plan approval,
blocking ambiguity, error needing input) → emit. `false` (work done, nothing to
decide, auto-merge carries it) → **silent**. The agent reuses the attention
judgment it already makes; it gets no new "should I voice this?" decision.

## Sources

**Key enabling fact (confirmed against the code):** the orchestrator already
observes every agent tool call and its full args server-side.
`wireAgentListeners` extracts `tool_use` blocks — `{ name, input }` — from each
`agent_assistant` event (`agent-listeners.ts:649-665`, via `recordToolUses`),
and already pattern-matches MCP tool names with `MCP_TOOL_NAME_RE`
(`/^mcp__([a-z][a-z0-9]*)__/`, ~`agent-listeners.ts:263`). So ShipIt can read the
name and `input` of the built-in voice tool, `AskUserQuestion`, and
`ExitPlanMode` *as they happen*, with no agent-side hook. This is the hinge of
the feature — and it's already true.

1. **The built-in voice tool** (primary). ShipIt-defined, in the agent's
   catalog, documented in `shipit-docs/`. The agent calls it with `{ summary,
   needsAttention, context }` at turn end (when attention is needed) and for
   occasional mid-task heads-up. ShipIt owns the schema (stable) and observes the
   call (guaranteed render). Works with zero external setup.

2. **Observed CLI interrupts** (derived). `AskUserQuestion` and `ExitPlanMode`
   are **built-in Claude CLI tools — their schemas are owned by the CLI, so
   ShipIt cannot add a `voiceSummary` field to them.** Instead ShipIt observes
   the call server-side and *derives* a headline from the observable `input`
   (e.g. the first question's `header`, the plan's title/first line). The agent
   may also precede the interrupt with a richer voice-tool call; if it did in the
   same turn, prefer that and suppress the derived nudge.

All sources produce the same payload and feed the same router.

## Router — the delivery setting

A persisted user setting (settings-store + settings UI): **Native / External /
Both.** Default **Native**.

- **Native** → render an inline voice-note message + synthesize via the existing
  TTS stack. Autoplay is gated by hands-free mode (below); otherwise a prominent
  "▶ the agent needs you" prompt.
- **External** → ShipIt POSTs the payload to the user's configured webhook
  (below). No inline note.
- **Both** → inline note *and* webhook POST. This is a deliberate choice to be
  reached on two channels; because there is one payload and one router, there is
  no accidental double-fire to de-dup.

### External delivery is a webhook (decided)

Under this model the external receiver stops being **a tool the agent calls** and
becomes **a delivery backend ShipIt forwards to**. We do this as a **webhook**,
not by having ShipIt act as an MCP client:

- ShipIt POSTs `{ summary, needsAttention, context }` as JSON to a user-supplied
  URL with an `Authorization: Bearer <token>` header (constant-time compared by
  the receiver, 401 on mismatch). Token + URL stored in the credential store,
  never echoed to the UI — same handling as the existing MCP server config.
- The receiver decides the channel exactly as docs/159 describes (route by
  `needsAttention`; speak `summary` verbatim on voice channels; render
  `context.prTitle`+`prUrl` as one link on text channels; never speak `prUrl`).
- **Migration:** the docs/159 MCP receivers already speak this payload. A webhook
  is a thinner contract than full Streamable-HTTP MCP, so existing receivers need
  a small plain-HTTP endpoint added (or a tiny shim) — but the body and the
  bearer-auth pattern are unchanged. docs/159 is not invalidated; it becomes "the
  External backend, MCP flavor," with webhook now the recommended flavor.

Why webhook over MCP-client forwarding: ShipIt POSTing JSON is far simpler than
ShipIt standing up an MCP client session against a user server, it has no
streaming/handshake surface, and it matches how every other outbound integration
in ShipIt behaves. The cost is the one-time receiver change above.

## Delivery gating — hands-free mode (Native sink only)

`docs/144` shipped playback as manual, no auto-play, and deferred "what
hands-free mode should mean." This is that follow-up, and it **overrides 144's
no-auto-play default** — but only behind an opt-in mode that is OFF by default,
so the no-surprise-audio promise holds for users who don't enable it.

- **Hands-free ON** → native notes autoplay with a chime (debounced — one chime
  to re-grab attention after a quiet period, not on every note). Away-from-
  keyboard / mobile (Android WebView) case.
- **Hands-free OFF** (default) → no autoplay; a prominent tap-to-play prompt.

Mode is a client toggle; the server always produces the note, the client decides
whether to autoplay. (Browser autoplay policy may require a one-time user gesture
to unlock audio — an implementation constraint to handle.)

## Resolved design decisions

Leans settled in discussion; recorded so they aren't re-litigated:

- **Over-narration:** the built-in tool respects the gate uniformly — a call with
  `needsAttention: false` renders as a *silent* chat bubble (no audio, no chime,
  no webhook unless the user routes FYIs externally), so a chatty agent costs
  nothing. Backstop: cap attention-grabbing notes per turn server-side.
- **`say` and the mode gate:** the mode toggle is the single source of truth for
  "does audio happen." The voice tool does **not** get an override flag to force
  autoplay when the mode is off — that would erode the opt-in guarantee that lets
  us override 144's default at all.
- **De-dup:** dissolved by the single-router model. "Both" is a deliberate
  user choice, not an accident.

## Principles check

- **§1 / §2:** moves a workflow the user runs through an *external* service into
  ShipIt as the default (Native), with External as a user-chosen escape hatch.
- **§5:** the agent emitting a summary is the *agent acting*; the user only
  listens/responds. The one new user control is a delivery setting + a mode
  toggle — preferences, not command buttons.

## Touchpoints (for a future implementation pass — not yet built)

Reuses the existing voice stack; mostly a new message type, one tool, and a
router, not new audio infrastructure.

**Reused as-is (all from docs/144):**
- `src/client/voice/playback-store.ts` — single-audio-element invariant, blob
  cache, play/pause/stop. A native note is another `(id, text)` to play (needs a
  synthetic id, since the cache key is built from `turnId`, `playback-store.ts:42,99`).
- `src/server/orchestrator/voice/tts-cache.ts` — disk LRU keyed by
  `sha256(provider \n voice \n speed \n text)` (`tts-cache.ts:28`).
- `src/server/orchestrator/services/voice.ts` `speakVoice()` /
  `POST /api/voice/speak`. Note: voice-summary text is already clean, so
  `stripForTts()` (`strip-for-tts.ts:14`) is largely a no-op for it.
- `src/server/shared/voice-catalog.ts` — provider/voice/speed selection.

**New / changed:**
- **A built-in voice tool** (ShipIt-defined) in the agent's catalog +
  `shipit-docs/` instructions. Payload `{ summary, needsAttention, context }`.
- **Source observation** in `agent-listeners.ts` (`agent_assistant` branch where
  `tool_use` blocks are already extracted, ~649-665): match the built-in tool,
  `AskUserQuestion`, `ExitPlanMode`; build a payload; hand it to the router. CLI
  interrupts derive their headline from observed `input`.
- **The router** — a small module that takes a payload + the delivery setting and
  fans out to the native sink and/or the webhook sink.
- **Native sink:** a `voice_note` server→client WS message (new member of the
  discriminated union in `shared/types/ws-server-messages.ts`) carrying
  `{ id, headline, needsAttention, kind }`, emitted via `runner.emitMessage()` so
  it buffers into the turn-event log and survives reconnects (per the
  WS-lifecycle rules in CLAUDE.md). Client renders a voice-note bubble in
  `MessageList.tsx`, distinct from `PlayTurnButton`.
- **Webhook sink:** outbound `POST` with bearer auth; URL + token in the
  credential store; webhook config UI in settings.
- **Settings:** delivery-mode setting (Native/External/Both) + hands-free toggle
  in settings-store and settings UI, coordinated with 144's voice settings.

## Relationship to existing features

- **`docs/144-voice-input`** (`in-progress`) — owns the manual Play button and the
  whole TTS stack the native sink reuses. **This dependency is effectively
  already satisfied:** an audit of the code confirms the entire playback
  pipeline — `playback-store`, `use-voice-playback`, `extract-turn-prose`,
  `PlayTurnButton` + MessageList integration, `POST /api/voice/speak`,
  `services/voice`, `strip-for-tts`, `tts-cache`, the OpenAI/ElevenLabs provider
  registry, `voice-catalog`, and the TTS settings — is built, tested, and wired
  end-to-end. 144 remains `in-progress` only for manual QA / cross-browser items
  (Android device testing, Safari/Firefox, hotkey conflict matrix), not
  implementation. So 163 can build directly on the existing stack now and need
  not wait for 144 to flip to `done`. 163 also resolves 144's deferred
  hands-free/auto-play question and overrides its no-auto-play default behind an
  opt-in mode.
- **`docs/159-turn-end-notification-mcp`** (`done`) — its `voiceSummary` /
  `needsAttention` / `context` contract is adopted verbatim as the payload. Its
  receiver is **re-scoped from "an agent tool" to "the External webhook
  backend."** This is the notable change to flag: the agent no longer calls
  `mcp__hermes__notify_turn_end`; it calls the built-in tool, and ShipIt forwards
  to the webhook when delivery is External/Both.

## Open questions

1. **Derived headline quality for questions/plans.** A derived
   "the agent has a question about *<first header>*" is hostage to a terse 12-char
   chip. Acceptable as the floor, with a preceding voice-tool call preferred when
   present — or should we require the agent to author these via the tool and treat
   derivation purely as a fallback? Leaning: derive by default, prefer authored,
   never block.
2. **`needsAttention: false` but the turn *failed*.** A give-up with no decision
   for the user still goes silent under the gate, yet a hands-free user wants to
   hear it. Fold "failed" into `needsAttention: true` by instruction, or add a
   third state? Leaning: failed implies attention-needed.
3. **Webhook payload versioning.** docs/159 receivers expect the MCP tool shape;
   the webhook body is the same JSON but arrives over plain HTTP. Do we version
   the body (`{ v: 1, ... }`) now to leave room, and what's the exact migration
   note for existing receivers?
4. **Autoplay edge UX** — chime debounce window; behavior when a note arrives
   mid-playback (reuse playback-store's one-at-a-time stop-and-start?); behavior
   when the tab is backgrounded; the browser autoplay-unlock gesture.
