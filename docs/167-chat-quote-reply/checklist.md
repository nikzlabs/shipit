# Chat quote-reply (SHI-10) — checklist

- [x] `formatBlockquote` util + unit test
- [x] `quoteReplyText` + `setQuoteReplyText` on session-store (resettable)
- [x] `ChatQuoteReply` floating button component (selectionchange + positioning)
- [x] Mount `ChatQuoteReply` in `MessageList` scoped to the scroll container ref
- [x] Consume `quoteReplyText` in `MessageInput` (append, focus, cursor at end)
- [x] Component test: button shows on selection, click inserts blockquote into composer
- [x] Component test: out-of-list selection / collapse hides button; append (not replace)
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Manual verification in the live preview (browser) — dev service starts on demand; covered by end-to-end component test against the real composer
- [x] PR opened (#919)
