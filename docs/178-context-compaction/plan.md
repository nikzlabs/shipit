---
description: Normalized, agent-agnostic context compaction — a manual /compact trigger plus first-class rendering of the compaction signals both CLIs already emit.
---

# 178 — Context Compaction

## Summary

Make context compaction a first-class, backend-agnostic ShipIt capability:
a user can trigger it (`/compact` in the composer, on either backend), and
ShipIt renders the compaction inline — both the manual trigger and the
**automatic** compactions the CLIs already perform silently today.

This resolves the open question carved out of `docs/132-slash-commands`
(Bucket 4): *"does ShipIt trigger the CLI's own compaction (if the adapter
exposes a way) or implement its own context summarization?"* The
adapter-capability investigation is done (see below) — **both backends
expose a native manual-compaction trigger that works headlessly**, so
ShipIt proxies the CLI's compaction rather than building its own
summarizer.

## Investigation findings (live-probed 2026-06-05)

Both triggers were confirmed by driving the installed CLIs the exact way
ShipIt drives them — Claude over `--input-format stream-json`, Codex over
the `app-server` stdio JSON-RPC protocol.

### Claude Code 2.1.158

- **Trigger is in-band.** `/compact` is a `type:"local"` command with
  `supportsNonInteractive: true` (kill-switch: `DISABLE_COMPACT`). The CLI
  parses any leading-`/` text in a user message into `{commandName,args}`
  and dispatches it even in headless `--print` / stream-json mode. There is
  **no** `control_request` subtype for compaction — the only control
  subtypes are `interrupt`, `set_permission_mode`, `can_use_tool`,
  `mcp_message`, `hook_callback`, `set_model`, `initialize`.
- **It works through ShipIt's streaming path today.** Sending
  `{type:"user",message:{role:"user",content:[{type:"text",text:"/compact"}]}}`
  on stdin (exactly what `StreamingClaudeProcess.sendUserMessage()` does)
  triggers real manual compaction.
- **Signals emitted** (in order): `system/status status:"compacting"` →
  `system/status status:null compact_result:"success"` → a fresh
  `system/init` → `system/compact_boundary` → `result` with
  `input_tokens:0`. The boundary payload:

  ```json
  {"type":"system","subtype":"compact_boundary",
   "compact_metadata":{"trigger":"manual","pre_tokens":22362,
     "post_tokens":1437,"duration_ms":27691,"preserved_segment":{…}}}
  ```

  So Claude alone distinguishes `trigger: manual|auto` and reports
  before/after token counts.

### Codex CLI 0.135.0

- **Trigger is an out-of-band RPC.** The app-server protocol exposes a
  first-class method `thread/compact/start` with params
  `{ threadId: string }`, returning `{}` (accepted, not complete). This
  mirrors its existing `turn/interrupt` / `turn/steer` methods. Confirmed
  in the generated protocol schema (`codex app-server generate-ts` /
  `generate-json-schema`).
- **In-band `/compact` is NOT honored** — sent as `turn/start` text it is
  treated as an ordinary prompt (the exact opposite of Claude). The TUI's
  `/compact` is the manual trigger that the schema's `ActiveTurnNotSteerable`
  error refers to, but it does not flow through `turn/start` text.
- **Works headless** over `codex app-server` (stdio). Lifecycle:
  `initialize` → `initialized` → `thread/start` → `turn/start` →
  (await `turn/completed`) → `thread/compact/start`.
- **Signals emitted:** `turn/started` → `item/started` with
  `item.type:"contextCompaction"` → `thread/tokenUsage/updated` →
  `item/completed` with `item.type:"contextCompaction"` → `turn/completed`
  (and `thread/status/changed`). Token numbers arrive only on the separate
  `thread/tokenUsage/updated` notification (`tokenUsage.total.*`,
  `modelContextWindow`); the compaction item carries **no** pre/post counts
  and **no** trigger field. The older `thread/compacted` /
  `ContextCompactedNotification` is deprecated in favor of the
  `contextCompaction` item lifecycle.

### The two backends are mirror opposites

| Axis | Claude 2.1.158 | Codex 0.135.0 |
|---|---|---|
| Trigger | in-band `/compact` user-message text | RPC `thread/compact/start {threadId}` |
| In-band `/compact` honored? | yes | no (plain text) |
| Dedicated RPC/control method? | no | yes |
| Works headless | yes (stream-json) | yes (app-server stdio) |
| Completion signal | `system/compact_boundary` | `item/completed type=contextCompaction` |
| Progress signal | `system/status status:"compacting"` | `item/started type=contextCompaction` |
| Token numbers | pre/post on the boundary | separate `thread/tokenUsage/updated` (no pre/post) |
| Manual vs auto flag | yes (`trigger`) | no |

A single "send this string" approach cannot work across both — which is
exactly why the trigger belongs behind the `AgentProcess` abstraction.

## What's broken today

ShipIt is blind to compaction it already causes (and to auto-compaction):

- `ClaudeAdapter.mapEvent` handles only `init / assistant / user / result /
  rate_limit_event`; everything else hits `default: return null`. So
  `compact_boundary` and the `status:"compacting"` events are **silently
  dropped**. The Codex adapter likewise has no `contextCompaction` mapping.
- The only compaction awareness is `ContextDial.wasCompacted()`, a
  client-side *heuristic* (≥40% context drop between turns). It infers a
  compaction happened; it can't trigger one and it has no detail.
- The `ContextDial` hint tells users to "type `/compact`," which works on
  Claude streaming but **not** on Codex (in-band text is a no-op there).
- Claude's mid-stream second `system/init` flows through `mapEvent` as a
  fresh `agent_init` — the orchestrator uses init for guarded-availability
  detection, so a mid-turn re-init must not reset session state.

## Design

### 1. Capability flag

`AgentCapabilities.supportsCompaction: boolean` — `true` for both adapters
(same pattern as `supportsReview` / `supportsSteering`). Gates the `/`
autocomplete entry and the `send-message` interception.

### 2. `AgentProcess.compact()`

A new normalized method on the agent interface, implemented per-adapter:

- **Claude** → `sendUserMessage("/compact")` on the resident
  `StreamingClaudeProcess`. (One-shot PTY path: spawn `claude -p "/compact"
  --resume <sessionId>`; **verify** `supportsNonInteractive` honors the
  `-p` string form — only the stream-json form is proven.)
- **Codex** → emit `thread/compact/start` with the adapter's current
  `threadId`. (**Verify** the adapter has the live `threadId` available at
  call time — it's on the active turn params.)

### 3. Two normalized events

Both adapters map their native signals into one shared shape:

- `agent_compaction_started` — **transient** progress (spinner / "Compacting
  context…"). Emit-only; correctly disappears (it's not transcript content).
  - Claude ← `system/status status:"compacting"`
  - Codex ← `item/started` `type:"contextCompaction"`
- `agent_compacted` — **persisted** transcript card. Shape:
  `{ trigger?: "manual" | "auto", preTokens?: number, postTokens?: number,
  durationMs?: number }` — **all optional**, because Codex supplies none of
  them (pull `preTokens`/`postTokens` from the adjacent
  `thread/tokenUsage/updated` if we want numbers; otherwise render
  trigger-agnostic).
  - Claude ← `system/compact_boundary` (`compact_metadata.*`)
  - Codex ← `item/completed` `type:"contextCompaction"`

Because `agent_compacted` is **transcript content** (a card the user
expects to still be there tomorrow), it must be **persisted, not just
emitted** — follow the side-channel-card pattern in CLAUDE.md: `emitChatCard`
(`chat-card-persistence.ts`), a typed `PersistedMessage.compaction` field +
column + `toRow`/`fromRow` + `database.ts` migration, rehydrate in
`loadSessionHistory`, idempotent-by-id append, and a history round-trip
test. This is the same discipline as voice notes (docs/163) and bug-report
cards (docs/164). The transient `agent_compaction_started` is emit-only.

Once the authoritative `agent_compacted` event exists, `ContextDial`'s
`wasCompacted()` heuristic can be retired (or kept only as a pre-event
fallback).

### 4. `/compact` interception in `send-message.ts`

A leading `/compact` (optionally with custom-instruction args, which Claude
supports) routes to `agent.compact()` instead of starting a normal turn —
the docs/132 Bucket-1 treatment. This makes the command **agent-agnostic**
(it finally works on Codex) and the `ContextDial` hint honest on both
backends. Surfaced through the shared `/` composer autocomplete
(docs/132/138). Gated on `supportsCompaction`.

### 5. Handle Claude's mid-stream re-init

Ensure the second `system/init` emitted during compaction does not reset
permission mode, session identity, or guarded-availability state in the
orchestrator's init listener. Treat an init arriving mid-turn (after a
`compacting` status) as a no-op for session-state purposes.

## Why proxy the CLI, not build our own summarizer

Both CLIs compact natively, headlessly, and for free (no extra ShipIt
prompt engineering, no divergence from the CLI's own context model). A
ShipIt-side summarizer would duplicate that, drift from each backend's
semantics, and own a hard problem the CLIs already solve. The only ShipIt
work is plumbing: a normalized trigger and normalized events.

## Build order

1. **Render the signals first (no trigger).** Map `compact_boundary`
   (Claude) and `contextCompaction` (Codex) → `agent_compaction_started` /
   `agent_compacted`; persist the card; handle the mid-stream re-init. This
   alone fixes the silent-drop bug for the auto-compactions that already
   happen on both backends — independently valuable.
2. **Add the trigger.** `AgentCapabilities.supportsCompaction`,
   `AgentProcess.compact()` + both adapters, `/compact` interception in
   `send-message.ts`, `/` autocomplete entry.
3. **Retire / fall back** `ContextDial.wasCompacted()` to the authoritative
   event.

## Key files

- `src/server/session/agents/agent-process.ts` — `compact()` on the
  interface; `AgentCapabilities.supportsCompaction`.
- `src/server/session/agents/claude/adapter.ts`, `claude/process.ts` —
  map `compact_boundary` + `status:"compacting"`; `compact()` →
  `sendUserMessage("/compact")`; guard the mid-stream `init`.
- `src/server/session/agents/codex/adapter.ts` — map `contextCompaction`
  item lifecycle; `compact()` → `thread/compact/start`.
- `src/server/shared/types/agent-types.ts` — normalized
  `agent_compaction_started` / `agent_compacted` events; capability field.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `/compact`
  interception → `agent.compact()`.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — emit the
  transient progress, persist the card (`emitChatCard`).
- `src/server/orchestrator/chat-history.ts`,
  `src/server/shared/database.ts` — `PersistedMessage.compaction` field +
  migration.
- `src/client/components/ContextDial.tsx` — consume the authoritative
  event; retire/fallback `wasCompacted()`.
- `src/client/utils/session-data.ts` — rehydrate the compaction card.
- `src/client/components/MessageInput.tsx` — `/compact` in `/` autocomplete.
- `docs/132-slash-commands/plan.md` — the Bucket-4 parent; open question
  resolved here.

## Caveats / open verification

- **Claude one-shot PTY path** (`-p "/compact"`) is unverified; only the
  stream-json form is proven. Confirm before relying on it for
  non-streaming sessions.
- **Codex `thread/compact/start` is under `--experimental` tooling** and the
  protocol is mid-migration (`thread/compacted` deprecated →
  `contextCompaction`). Gate on CLI version + capability; don't assume the
  shape is stable across Codex bumps.
- **Codex `threadId` availability** at `compact()` call time must be
  confirmed in the adapter.
- **Auto-compaction during a live turn**: both CLIs may compact mid-turn on
  their own. The rendering work (step 1) must tolerate the events arriving
  unsolicited, not just in response to a user trigger.

## Implementation status (2026-06-06)

All three build-order steps are **implemented**; see `checklist.md` for the
item-level breakdown and the remaining live-CLI verification items (the doc's
"Caveats / open verification"). The implementation follows this spec, with two
notes worth recording:

- **Codex token figures.** The card's `postTokens` is taken from the adjacent
  `thread/tokenUsage/updated` snapshot's `last.totalTokens` (real context-window
  occupancy of the final call) captured at `item/completed`, and `preTokens`
  from the snapshot present at `item/started` — so the card shows the
  before→after delta even though the `contextCompaction` item carries no counts
  itself. All fields stay optional, so a missing snapshot degrades to a bare
  "Context compacted" row.
- **Codex `/compact` between turns.** Because Codex tears its app-server down on
  turn completion, the between-turns trigger goes through the spawn path
  (`run({ compact: true })`): a fresh app-server resumes the thread and issues
  `thread/compact/start` instead of `turn/start`, and the `contextCompaction`
  completion synthesizes the `agent_result` that ends the run. The live
  `agent.compact()` method covers the in-flight-turn case.
