# 020 — Prompt Queuing: Remaining Work

Nothing has been implemented yet. `MessageInput` is still disabled during loading and there is no queue infrastructure.

## Remaining

- [ ] Add `WsCancelQueuedMessage`, `WsMessageQueued`, `WsQueueUpdated` types to `src/server/types.ts`
- [ ] Add per-connection `messageQueue` array and `isClaudeRunning` flag in `src/server/index.ts`; queue logic in `send_message` handler; dequeue in `done` handler; `cancel_queued_message` handler
- [ ] Remove `isLoading` from `MessageInput` disabled prop in `src/client/App.tsx`; add `queuedMessages` state; handle `message_queued` and `queue_updated` events
- [ ] Render queued messages with dimmed style and "Queued #N" badge in `src/client/components/MessageList.tsx`
- [ ] Create `src/client/components/QueueIndicator.tsx` (shows queue count, Clear Queue button)
- [ ] Create `src/server/integration_tests/prompt-queuing.test.ts` (queue while busy, multiple queued, cancel queued, error + dequeue, session switch clears queue)
