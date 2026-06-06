# 179 — Context Compaction · checklist

## Done

- [x] Normalized `agent_compaction_started` + `agent_compacted` events
- [x] Claude adapter: map `system/status compacting` + `system/compact_boundary`
- [x] Codex adapter: map `contextCompaction` item started/completed + token correlation
- [x] Mid-stream second `system/init` no longer resets guarded/permission state
- [x] `AgentCapabilities.supportsCompaction` (both backends) + wired into agent-list payloads
- [x] `AgentProcess.compact()` on both adapters + `ProxyAgentProcess` + worker `/agent/compact`
- [x] `AgentRunParams.compact` spawn path (Claude prompt / Codex `thread/compact/start`)
- [x] `/compact` interception in `send-message.ts` (live-turn + spawn paths)
- [x] `/compact` entry in the `/` autocomplete, gated on `supportsCompaction`
- [x] Persisted `CompactionCard` (DB column + migration + toRow/fromRow + `emitChatCard`)
- [x] Client: `compaction_card` / `compaction_status` handlers, `CompactionCard.tsx`, transient indicator
- [x] `ContextDial.wasCompacted()` retired to a fallback behind the authoritative signal
- [x] Tests: adapter unit (both), listener persistence, `/compact` interception integration, history round-trip, client handler idempotency
- [x] lint:dev + typecheck clean

## Remaining — needs a live, authenticated CLI to verify

- [ ] Confirm `claude -p "/compact" --resume <id>` actually compacts (one-shot path). If not, gate `compact()` to streaming sessions and surface a clear message.
- [ ] Confirm the Codex compact-spawn lifecycle: `thread/compact/start` on a resumed thread emits `contextCompaction` items, and that the synthetic `agent_result` is the correct turn terminus.
- [ ] Confirm the real field names/values: Claude `compact_metadata.{trigger,pre_tokens,post_tokens,duration_ms}` and Codex post-compaction `last.totalTokens`.
- [ ] Visually confirm the inline card + transient indicator + dial pill in the live preview.
