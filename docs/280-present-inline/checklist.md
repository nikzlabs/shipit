# Inline present — checklist

- [x] `requirements.md` written from the user's answers, no open questions left
- [x] `inline` parameter on the `present` tool + when-to-use guidance
- [x] Worker: accept `inline`, sticky in `PresentRegistry`, carried on the SSE event
- [x] Types: `PresentInlineCard`, `WsPresentInlineCard`, `inline` on the present messages
- [x] Migrations: `messages.present_inline`, `presentations.inline`
- [x] `PresentStore` persists `inline` and returns `inlineCardIsNew` (the emit gate)
- [x] Runner emits the card via `emitChatCard`, exactly once per artifact
- [x] `chatHistoryManager` threaded to `ContainerSessionRunner`
- [x] Chat-history column wiring (`toRow`/`fromRow`, insert/update)
- [x] Client: WS handler, `CARD_MESSAGE_FIELDS`, `TRANSCRIPT_SCOPED_MESSAGES`
- [x] `PresentInlineCard` component (per-kind render, bounded height, open-in-tab)
- [x] `RenderedFrame` height reporting for inline frames
- [x] Agent Interface SDK live for inline HTML, gated on the card being on screen
- [x] Inline presents do not auto-reveal the Present tab
- [x] Tests: store gate, worker→runner→card integration, card component
- [x] `shipit-docs/present.md` updated
- [x] Verified in the browser (inline card renders, height fits, open-in-tab works)
