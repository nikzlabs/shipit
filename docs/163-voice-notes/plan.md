---
description: One voice-summary primitive the agent emits when it needs the user, with a ShipIt delivery setting (native inline / external webhook / both) — not two separate tools.
---

# Voice notes — one spoken-summary primitive, user-chosen delivery

## Implementation status (done)

Built end-to-end on the existing voice stack. Key files added/changed:

- **Built-in tool:** `src/server/session/mcp-voice-bridge.ts` — stdio MCP bridge
  exposing `voice_note` (`shipit-voice`), wired through
  `AgentMcpVoiceBridge` (`shared/types/agent-types.ts`),
  `session-worker.ts#voiceBridgePaths`, and both adapters' `writeMcpConfig`.
  It POSTs to the worker `/agent-ops/voice/note` broker, which relays to the
  orchestrator's session-scoped `POST /api/sessions/:id/voice-note`.
- **Router:** `src/server/orchestrator/voice/voice-note-router.ts` —
  `routeVoiceNote(payload, deps)` fans out to the native sink
  (`runner.emitMessage` of a `voice_note` WS message) and the webhook sink
  (`POST { v: 1, summary, needsAttention, context }` with bearer auth).
  Per-turn attention cap (`MAX_ATTENTION_NOTES_PER_TURN = 3`) and the
  authored-this-turn flag live in a runner-keyed `WeakMap`, reset from
  `resetRunnerTurnState`.
- **Source observation:** `agent-listeners.ts` derives an `ask` / `plan`
  headline from a top-level `AskUserQuestion` / `ExitPlanMode` and routes it via
  the new `deliverVoiceNote` listener dep — suppressed when the agent authored a
  headline first (`hasAuthoredVoiceNoteThisTurn`).
- **Native sink + client:** `WsVoiceNote` (`ws-server-messages.ts`),
  `message-handlers/voice-note.ts`, `components/VoiceNoteCard.tsx`,
  `voice/voice-notes.ts` (hands-free autoplay, 20s chime debounce, latest-wins
  via `playback-store`, one-time unlock on the toggle gesture).
- **Settings:** delivery mode (server, `CredentialStore` + global settings) +
  webhook config (`POST/DELETE/GET /api/voice/webhook`, token never echoed) +
  hands-free toggle (client `localStorage`). UI in `Settings.tsx` Voice tab.
- **Agent instructions + docs:** `agent-instructions.ts` "Voice notes" section
  and `shipit-docs/voice-notes.md`.

### Post-ship fix — card render (visual-elements)

The native sink shipped non-functional: `voice_note` WS messages arrived and
`handleVoiceNote` appended the `{ role: "assistant", text: "", voiceNote }`
message, but `buildVisualElements` (`src/client/components/visual-elements.ts`)
silently dropped it. That grouping pass only emits a `message` element when a
message has tools, non-empty text, images, files, or is a user message — an
empty-text card message matched none of those and fell through to the
"no bubble needed" branch, so `MessageList`'s `voiceNote` render branch never
ran. The same latent gap affected every empty-text inline card —
`agentReview` (151), `bugReport` (164), `spawnedSession`, and `spawnFailed`.
Fixed by adding a `hasCardContent` guard so a card-bearing message always emits
its `message` element; covered by `visual-elements.test.ts`.

### Post-ship fix — card persistence (survives reload)

With the render fix in place the card appeared live but vanished a moment later:
voice notes arrive on a side channel, not the agent-event stream, so
`buildTurnMessages` never captured them and they were never written to the
`messages` table. Any `loadSessionHistory` (WS reconnect / refresh / ShipIt
restart) rebuilds the transcript from the DB and dropped the live-only card; the
turn-event buffer only bridges a same-turn reconnect before it's cleared. Fixed
by persisting the card like any other transcript content:

- New `voice_note` column on `messages` (additive migration in `database.ts`);
  `PersistedMessage.voiceNote` + `toRow`/`fromRow` in `chat-history.ts`.
- `routeVoiceNote` persists a finalized `{ role: "assistant", text: "",
  voiceNote }` row whenever the native sink fires.
- `handleVoiceNote` is now idempotent by `id` — the note is both persisted and
  buffered into the turn-event log, so a reconnect can deliver it twice (history
  load + buffer replay); the dedup skips the second append and the re-autoplay.

Note: the sibling empty-text cards (`agentReview`, `bugReport`, `spawnedSession`,
`spawnFailed`) share the same non-persistence gap and remain ephemeral across a
reload — out of scope here, tracked as follow-up.

### Post-ship fix #2 — card reload position (in-band persistence)

The persistence fix above used an out-of-band `chatHistoryManager.append` from
`routeVoiceNote`. That reproduced the exact id-reordering bug `SteeredMessage`
documents: the card row was inserted with a finalized (in_progress=0) id at the
moment the tool fired, but `replaceInProgress` then deleted and **re-inserted**
the turn's assistant rows with fresh, higher ids on every subsequent
tool-result / agent_result boundary. On reload (`ORDER BY id`) the card kept its
early id and floated **above the whole turn** — rendering before any of the
agent's work instead of where the tool was issued.

Fixed by persisting the card in-band, mirroring the live-steer mechanism:

- New `RecordedVoiceNote` (`session-runner.ts`) + a `voiceNotes` per-turn
  accumulator on the runner (interface, `SessionRunner`, `TurnAccumulator` /
  `ContainerSessionRunner`), cleared in `resetRunnerTurnState`.
- `recordVoiceNote(runner, note)` (in `voice-note-router.ts`, to avoid a value
  import cycle with `agent-listeners`) replaces the `append`. It anchors the
  card at `afterGroupIndex` = the count of persistable assistant groups so far.
- `buildTurnMessages` takes a `voiceNotes` arg and interleaves the cards at
  their anchor — same delete/reinsert cycle as the assistant rows, so the card
  is reborn at its true position on every rebuild. All callers updated
  (`persistTurnInProgress`, the in-progress + agent_result boundaries, the
  interrupted-turn finalize for derived ask/plan notes, and the error path).
- The now-unused `chatHistoryManager` dep was dropped from `RouteVoiceNoteDeps`
  and its three call sites.

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

2. **Observed CLI interrupts** (authored-first, derived as fallback).
   `AskUserQuestion` and `ExitPlanMode` are **built-in Claude CLI tools — their
   schemas are owned by the CLI, so ShipIt cannot add a `voiceSummary` field to
   them.** The agent is therefore **instructed to author the headline via the
   built-in voice tool immediately before the interrupt** (in the same turn), so
   the spoken note is a real one-sentence script rather than a terse chip. When an
   authored voice-tool call is present in the turn, ShipIt uses it and suppresses
   any derived nudge. **Derivation is the fallback only:** if the agent reaches
   the interrupt without an authored call, ShipIt derives a headline from the
   observable `input` (the first question's `header`, the plan's title/first line)
   so the user is never left silent — but the floor is a fallback, not the
   intended path. (Decided: require authored, derive as fallback.)

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

- ShipIt POSTs `{ v: 1, summary, needsAttention, context }` as JSON to a
  user-supplied URL with an `Authorization: Bearer <token>` header (constant-time
  compared by the receiver, 401 on mismatch). Token + URL stored in the credential
  store, never echoed to the UI — same handling as the existing MCP server config.
  The `v` field is the body version (decided: add it now); receivers branch on it
  and may reject unknown majors. Everything else is the verbatim docs/159 payload.
- The receiver decides the channel exactly as docs/159 describes (route by
  `needsAttention`; speak `summary` verbatim on voice channels; render
  `context.prTitle`+`prUrl` as one link on text channels; never speak `prUrl`).
- **Migration:** the docs/159 MCP receivers already speak this payload. A webhook
  is a thinner contract than full Streamable-HTTP MCP, so existing receivers need
  a small plain-HTTP endpoint added (or a tiny shim). The body gains the `v: 1`
  envelope field but is otherwise unchanged, as is the bearer-auth pattern;
  receivers that ignore unknown fields keep working, and new receivers should
  read `v` and reject unknown majors. docs/159 is not invalidated; it becomes "the
  External backend, MCP flavor," with webhook now the recommended flavor.

Why webhook over MCP-client forwarding: ShipIt POSTing JSON is far simpler than
ShipIt standing up an MCP client session against a user server, it has no
streaming/handshake surface, and it matches how every other outbound integration
in ShipIt behaves. The cost is the one-time receiver change above.

## Scope: foreground web delivery only

The **Native sink in this doc is foreground-only** — it works when ShipIt is the
active, visible tab/app: desktop, or mobile with the screen on and ShipIt
focused. It deliberately does **not** attempt background or screen-locked
delivery on mobile, because that is impossible in-browser: a backgrounded tab is
frozen (JS throttled, the per-session WS dropped, so the `voice_note` message
won't even arrive) and autoplay of fresh audio from a non-visible page is blocked
by browser policy. A WebView wrapper (`docs/116`) shares the same page lifecycle,
so it does not change this.

Reaching a backgrounded or closed mobile device requires *server-initiated* push
to a channel that survives a dead tab — an external push (the **External webhook**
sink here, e.g. Telegram / voice call), Web Push, or a native app. Those options
are analysed in their own doc, **`docs/164-mobile-voice-delivery`**; this doc
covers the foreground Native sink and the External webhook only.

## Delivery gating — hands-free mode (Native sink only)

`docs/144` shipped playback as manual, no auto-play, and deferred "what
hands-free mode should mean." This is that follow-up, and it **overrides 144's
no-auto-play default** — but only behind an opt-in mode that is OFF by default,
so the no-surprise-audio promise holds for users who don't enable it.

- **Hands-free ON** → native notes autoplay with a chime (debounced — one chime
  to re-grab attention after a quiet period, not on every note). The
  foreground-while-screen-on case (e.g. ShipIt open on a second monitor, or a
  phone propped up with the tab active).
- **Hands-free OFF** (default) → no autoplay; a prominent tap-to-play prompt.

Mode is a client toggle; the server always produces the note, the client decides
whether to autoplay.

### Autoplay edge UX (foreground, hands-free ON) — decided

These were open; pinning them down now since they govern how the native sink
feels. All three live client-side, layered on the existing `playback-store`.

- **Chime debounce.** The attention chime plays at most once per **quiet window of
  20s** — if notes arrive in a burst, only the first re-grabs attention with a
  chime; subsequent notes within the window autoplay their speech without
  re-chiming. The window resets after 20s of no notes. (The chime exists to
  re-orient an eyes-off user after silence, not to punctuate every sentence.)
- **Mid-playback arrival.** Reuse `playback-store`'s single-audio-element
  invariant: a newly arriving note **stops the current audio and starts the new
  one** (latest-wins), rather than queueing. A voice note is a fresh "you're
  needed now" headline; a stale one finishing first would mislead. The
  superseded note remains tap-to-replay in its chat bubble.
- **Autoplay-unlock gesture.** Browser policy blocks fresh audio from a page that
  has had no user gesture. On enabling hands-free mode the client performs a
  **one-time unlock** — the toggle interaction itself is the gesture; we prime the
  shared audio element (play a near-silent/zero-duration buffer) on that click so
  later server-driven autoplay is permitted. If the element ever loses the unlock
  (page reload), the next note falls back to the prominent tap-to-play prompt and
  re-arms unlock on that tap. Mode stays on; only autoplay is gated until re-armed.

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
- **Failed turns:** a give-up or error that leaves no decision for the user still
  needs to reach a hands-free user. **"Failed" folds into `needsAttention: true`
  by instruction** — the agent marks a failed/abandoned turn as attention-needed
  rather than going silent. No third state and no schema change; the existing
  gate carries it.
- **CLI-interrupt headlines:** authored-first — the agent authors the headline via
  the voice tool before `AskUserQuestion`/`ExitPlanMode`; derivation from observed
  `input` is the fallback floor only (see Sources §2).
- **Webhook body version:** the body carries `v: 1` from day one (see "External
  delivery is a webhook").
- **Autoplay edge UX:** chime debounce, mid-playback latest-wins, and the
  one-time unlock gesture are specified above ("Autoplay edge UX").

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

All previously open questions are resolved (recorded in "Resolved design
decisions" and the relevant sections):

1. **Derived headline quality** → require the agent to author the headline via the
   voice tool; derive from observed `input` only as a fallback floor (Sources §2).
2. **Failed turn with `needsAttention: false`** → "failed" folds into
   `needsAttention: true` by instruction; no third state.
3. **Webhook payload versioning** → ship `{ v: 1, ... }` now; receivers branch on
   `v` and may reject unknown majors.
4. **Autoplay edge UX (foreground)** → chime debounced to one per 20s quiet
   window; mid-playback arrival is latest-wins (stop-and-start via playback-store);
   one-time unlock primed on the hands-free toggle gesture, re-armed via
   tap-to-play after a reload. Backgrounded / screen-locked is out of scope — see
   `docs/164`.

No blocking questions remain; the feature is ready to move to implementation.
