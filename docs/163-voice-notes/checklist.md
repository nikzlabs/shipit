# Voice notes — implementation checklist

Design is settled (all open questions resolved in `plan.md`). Remaining work,
grouped by the touchpoints section. Nothing here is built yet.

## Agent-facing tool

- [x] Define the built-in voice tool (ShipIt-owned) in the agent's catalog with
      payload `{ summary, needsAttention, context }`.
- [x] Document it in `src/server/shipit-docs/` — "call at end of turn when
      attention is needed, sparingly mid-task; author a headline before
      `AskUserQuestion`/`ExitPlanMode`; mark failed/abandoned turns as
      `needsAttention: true`."
- [x] Update `agent-instructions.ts` so the built-in tool replaces the
      `mcp__hermes__notify_turn_end` instruction block.

## Source observation (`agent-listeners.ts`)

- [x] In the `agent_assistant` `tool_use` extraction (~649-665), match the
      built-in voice tool and read its `input`.
- [x] Match `AskUserQuestion` / `ExitPlanMode`; derive a fallback headline from
      observed `input` (first question `header`, plan title/first line).
- [x] Prefer an authored voice-tool call when present in the same turn; suppress
      the derived nudge in that case.
- [x] Hand the assembled payload to the router.

## Router

- [x] New module: takes payload + delivery setting (Native/External/Both) and
      fans out to the native and/or webhook sinks.
- [x] Server-side per-turn cap on attention-grabbing notes (over-narration
      backstop).

## Native sink

- [x] Add `voice_note` member to the `ws-server-messages.ts` discriminated union
      carrying `{ id, headline, needsAttention, kind }`.
- [x] Emit via `runner.emitMessage()` (buffers into turn-event log, survives
      reconnects).
- [x] Render a voice-note bubble in `MessageList.tsx`, distinct from
      `PlayTurnButton`.
- [x] Reuse `playback-store` with a synthetic id (cache key is built from
      `turnId`, so a non-turn note needs its own id).
- [x] Synthesize via existing `POST /api/voice/speak` / `services/voice` stack.

## Hands-free mode + autoplay UX (client)

- [x] Hands-free toggle (OFF by default) in settings-store + settings UI.
- [x] Autoplay native notes when ON; prominent tap-to-play prompt when OFF.
- [x] Chime debounce: one chime per 20s quiet window; bursts autoplay without
      re-chiming; window resets after 20s idle.
- [x] Mid-playback arrival = latest-wins (stop current, start new) via
      playback-store's single-element invariant; superseded note stays
      tap-to-replay.
- [x] One-time autoplay unlock primed on the hands-free toggle gesture; re-arm via
      tap-to-play after a page reload.

## Webhook sink

- [x] Outbound `POST` of `{ v: 1, summary, needsAttention, context }` with
      `Authorization: Bearer <token>`.
- [x] Store webhook URL + token in the credential store; never echo to UI.
- [x] Webhook config UI in settings.

## Settings

- [x] Delivery-mode setting (Native/External/Both), default Native, in
      settings-store + settings UI, coordinated with 144's voice settings.

## docs/159 migration

- [x] Re-scope docs/159 receiver from "agent tool" to "External webhook backend";
      add the plain-HTTP endpoint / shim and the `v: 1` envelope note.

## Tests

- [x] Unit: router fan-out per delivery setting; per-turn cap.
- [x] Unit: source observation (authored-preferred, derived-fallback, failed →
      attention).
- [x] Integration: `voice_note` WS message emitted + buffered across reconnect.
- [x] Client: voice-note bubble render; hands-free autoplay vs tap-to-play; chime
      debounce; latest-wins mid-playback.
- [x] `npm run lint:dev` + `npm run typecheck` clean.

## Docs

- [x] Flip `plan.md` status to `in-progress` when work starts, `done` when
      complete (all items here checked).
- [x] Update `src/server/shipit-docs/` for the new agent-facing tool.
