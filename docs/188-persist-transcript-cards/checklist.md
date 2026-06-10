# Checklist

- [x] Foundation: `PersistedMessage` fields + columns + toRow/fromRow + migration
- [x] `spawnedSession` / `spawnFailed` persisted via `emitChatCard` (+ client dedup)
- [x] `agentReview` persisted via `emitChatCard` (+ client dedup by reviewId)
- [x] `userReview` threaded through `send_message` → `persistUserMessage`
- [x] `system_notice` persisted with stable id (`emitNoticeInTurn` / `emitNoticePostTurn`) + client dedup
- [x] Rewind action-feedback notices documented as intentionally ephemeral
- [x] Tests: chat-history serialization contract, handler dedup, helper coverage
- [x] Prevention: `CARD_MESSAGE_FIELDS` single source of truth drives `hasCardContent`
- [x] Prevention: guard tests (chat-history enumerates the list; visual-elements renders each)
- [x] Fixed live regression: `issueRef` card was render-dropped (missing from `hasCardContent`)
- [x] CLAUDE.md updated with the executable-contract steps
- [x] Docs updated: 117, 138, 151 + this doc; tracker SHI-94 linked
