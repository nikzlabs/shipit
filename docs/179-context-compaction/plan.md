---
title: Context Compaction
description: Agent-agnostic context compaction for both backends — render the native compaction signals inline and expose a /compact composer command.
---

# 179 — Context Compaction

> Carved out of `docs/132-slash-commands` (Bucket 1/4: `/compact`). Numbered 179
> because 178 was taken by `repo-trust-gate`; the original spec referred to it as
> "178-context-compaction".

## Summary

Context compaction is now a first-class, **agent-agnostic** capability for both
backends (Claude Code + Codex), covering two axes:

1. **Viewing** — ShipIt no longer drops the native compaction signals both CLIs
   already emit. They are normalized into two `AgentEvent`s and rendered inline:
   a transient "Compacting…" indicator (emit-only) and a persisted "Context
   compacted" transcript card. This also covers **automatic** compactions the
   CLIs perform on their own mid-turn.
2. **Invoking** — a `/compact` composer command that works identically on both
   backends, surfaced in the `/` autocomplete and gated on a new
   `supportsCompaction` capability.

## Design

### Normalized events (the contract)

Two new variants on the `AgentEvent` union (`shared/types/agent-types.ts`):

- `agent_compaction_started` — transient progress, **emit-only**. The
  orchestrator forwards it as a `compaction_status {active:true}` WS message and
  returns before the message accumulator (same shape as `agent_rate_limits` /
  `agent_steer_rejected`). Never persisted.
- `agent_compacted` — **transcript content**. The orchestrator persists it as an
  inline card via `emitChatCard` (the one supported way to add a side-channel
  card), and clears the transient indicator.

Every detail field (`trigger`, `preTokens`, `postTokens`, `durationMs`) is
**optional** because Codex supplies none of them natively — the card degrades to
a bare "Context compacted" row.

### Adapter mapping

- **Claude** (`session/agents/claude/adapter.ts`): the `case "system"` now
  discriminates on `subtype` (it previously mapped *every* system event to a
  bogus `agent_init`). `status:"compacting"` → `agent_compaction_started`;
  `compact_boundary` → `agent_compacted` (from `compact_metadata.{trigger,
  pre_tokens, post_tokens, duration_ms}`). `ClaudeSystemEvent` is now a
  discriminated union (`claude-types.ts`).
- **Codex** (`session/agents/codex/adapter.ts`): an `item` of
  `type:"contextCompaction"` maps started→`agent_compaction_started`,
  completed→`agent_compacted`, with `postTokens` pulled from the adjacent
  `thread/tokenUsage/updated` snapshot. Codex emits no manual/auto field, so the
  adapter labels `trigger` by **correlation** (`compactionRequested` flag set
  when ShipIt issues the compaction).

### Mid-stream second `system/init`

The Claude CLI emits a second `system/init` after it compacts. The orchestrator's
`agent_init` handler now gates the guarded-mode availability check on
`isFirstInit` so a post-compaction re-init can't flip `guardedUnavailable` or
re-emit a downgrade notice. `pendingAgentSessionId` already resisted overwrite
via `??=`.

### The trigger

- `AgentCapabilities.supportsCompaction` — true for both backends.
- `AgentProcess.compact()` — operates on the **resident** process: streaming
  Claude injects `/compact` via `sendUserMessage`; live Codex sends the
  `thread/compact/start` RPC.
- `AgentRunParams.compact` — for the **spawn** path (no resident live process):
  Claude rides the `/compact` prompt (`claude -p "/compact"`); Codex resumes the
  thread and issues `thread/compact/start` instead of a normal `turn/start`,
  treating the `contextCompaction` completion as the turn terminus.
- `/compact` interception (`ws-handlers/send-message.ts`): a live in-flight turn
  → `agent.compact()` + transient indicator; otherwise a fresh compaction turn
  via `runAgentWithMessage({ userText: "/compact", compact: true })`.
- Transport: `ProxyAgentProcess.compact()` → `POST /agent/compact` →
  `agent.compact()` on the in-container adapter.

### Persistence (side-channel card pattern)

`agent_compacted` is transcript content, so it follows the voice-note /
bug-report precedent:

- `PersistedMessage.compaction: CompactionCard` + a `compaction` DB column +
  `toRow`/`fromRow` + a `database.ts` migration.
- Recorded in-band with the turn via `emitChatCard` (anchored by
  `afterGroupIndex`), so it lands at its true transcript position.
- Rehydrated on reload through the normal message field (lives on the message
  like `voiceNote`, so no separate store seeding is needed).
- Live append is idempotent by `card.id` so the reconnect buffer replay and the
  history reload never double-render.

### Client

- `compaction_card` / `compaction_status` WS messages + handlers.
- `CompactionCard.tsx` inline component; rendered from `MessageList` when a
  message carries `compaction`.
- Transient "Compacting…" indicator driven by `session-store.compacting`.
- `/compact` entry in the `/` menu (`SkillAutoComplete` gained a `commands`
  slot; commands are always `/`-prefixed, distinct from the `$` skill token).
- `ContextDial.wasCompacted()` is **retired to a fallback**: the dial now prefers
  the authoritative signal (a compaction card present after the last user
  message) and only falls back to the token-drop heuristic.

## Build order (done)

1. ✅ Render the signals (no trigger) — adapter mapping for both backends, the
   two normalized events, mid-stream-init guard.
2. ✅ Persist + render the card; transient indicator.
3. ✅ Add the trigger — capability, `compact()`, run-param, `/compact`
   interception, `/` autocomplete entry.
4. ✅ Retire/fallback `ContextDial.wasCompacted()`.

## Key files

- `src/server/shared/types/agent-types.ts` — events, `supportsCompaction`,
  `compact()`, `AgentRunParams.compact`.
- `src/server/shared/types/claude-types.ts` — `ClaudeSystemEvent` union.
- `src/server/shared/types/domain-types.ts` — `CompactionCard`.
- `src/server/shared/types/ws-server-messages.ts` — `WsCompactionStatus`,
  `WsCompactionCard`.
- `src/server/session/agents/{claude,codex}/adapter.ts` — event mapping +
  `compact()` + compact-spawn.
- `src/server/session/session-worker.ts` — `POST /agent/compact`.
- `src/server/orchestrator/proxy-agent-process.ts`,
  `container-session-runner.ts` — proxy transport.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — event handling +
  `emitChatCard` + init guard.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `/compact`
  interception.
- `src/server/orchestrator/chat-history.ts`, `src/server/shared/database.ts` —
  persistence + migration.
- `src/client/components/CompactionCard.tsx`, `MessageList.tsx`,
  `SkillAutoComplete.tsx`, `MessageInput.tsx`, `ContextDial.tsx`.
- `src/client/hooks/message-handlers/compaction-{card,status}.ts`.

## Caveats / must-verify against a live CLI

These were the spec's open items. The code is written to the documented protocol
but **could not be exercised against a real authenticated CLI** in this
environment — see `checklist.md`:

- **Claude one-shot `claude -p "/compact" --resume <id>`** triggering compaction
  is unverified; only the streaming (`sendUserMessage("/compact")`) form is
  proven. If `-p "/compact"` turns out to be a no-op, gate `compact()` /
  the spawn path to streaming sessions and surface a clear message.
- **Codex compact-spawn lifecycle** — that `thread/compact/start` on a freshly
  resumed thread emits `contextCompaction` items and that synthesizing
  `agent_result` on completion is the right turn terminus (vs. a real
  `turn/completed`) is unverified. The `compactionTerminated` guard prevents a
  double `agent_result` if both arrive.
- **Token figures** — Claude's `compact_metadata` field names and Codex's
  `last.totalTokens` as the post-compaction occupancy are best-effort; all card
  fields are optional so a mismatch degrades gracefully rather than breaking.
