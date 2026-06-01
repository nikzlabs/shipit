# Chat quote-reply (SHI-10) — checklist

- [x] `formatBlockquote` util + unit test
- [x] `quoteReplyText` + `setQuoteReplyText` on session-store (resettable)
- [x] `ChatQuoteReply` floating button component (selectionchange + positioning)
- [x] Mount `ChatQuoteReply` in `MessageList` scoped to the scroll container ref
- [x] Consume `quoteReplyText` in `MessageInput` (append, focus, cursor at end)
- [x] Component test: button shows on selection, click inserts blockquote into composer
- [x] Component test: out-of-list selection / collapse hides button; append (not replace)
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [ ] Manual verification in the live preview (browser)
- [ ] PR opened
