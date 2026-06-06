# 178 — Context Compaction · checklist

## Done

- [x] Normalized `agent_compaction_started` + `agent_compacted` events (`agent-types.ts`)
- [x] Claude adapter: map `system/status compacting` + `system/compact_boundary` (`ClaudeSystemEvent` is now a discriminated union)
- [x] Codex adapter: map `contextCompaction` item started/completed + token correlation
- [x] Mid-stream second `system/init` no longer resets guarded/permission state
- [x] `AgentCapabilities.supportsCompaction` (both backends) + wired into every agent-list payload
- [x] `AgentProcess.compact()` on both adapters + `ProxyAgentProcess` + worker `/agent/compact`
- [x] `AgentRunParams.compact` spawn path (Claude `/compact` prompt / Codex `thread/compact/start`)
- [x] `/compact` interception in `send-message.ts` (live-turn + spawn paths)
- [x] `/compact` entry in the `/` autocomplete, gated on `supportsCompaction`
- [x] Persisted `CompactionCard` (DB column + migration + `toRow`/`fromRow` + `emitChatCard`)
- [x] Client: `compaction_card` / `compaction_status` handlers, `CompactionCard.tsx`, transient "Compacting…" indicator
- [x] `ContextDial.wasCompacted()` retired to a fallback behind the authoritative signal
- [x] Tests: adapter unit (both), listener persistence, `/compact` interception integration, history round-trip, client handler idempotency
- [x] lint:dev + typecheck clean

## Remaining — needs a live, authenticated CLI to verify (the doc's "open verification")

- [ ] Confirm `claude -p "/compact" --resume <id>` actually compacts (one-shot path). Only the stream-json form is proven; if `-p` is a no-op, gate the spawn path to streaming sessions and surface a clear message.
- [ ] Confirm the Codex compact-spawn lifecycle: `thread/compact/start` on a resumed thread emits the `contextCompaction` items, and the synthetic `agent_result` is the correct turn terminus (vs. a real `turn/completed`). `compactionTerminated` guards against a double result.
- [ ] Confirm Codex `threadId` is live at `compact()` call time, and that `thread/compact/start` stays stable across Codex bumps (it's under `--experimental` and mid-migration from the deprecated `thread/compacted`).
- [ ] Visually confirm the inline card + transient indicator + dial pill in the live preview.
