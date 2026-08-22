# 281 — checklist

- [x] Verify finding 1 against the code: trace the `historyLoaded` gate from the
      reconnect through the queue, the install and the drain (req 1).
- [x] Fix the one path with no attach: `resumeSessionInternal` returns early when
      the session is already the current one, so a running turn's streamed tail
      survives a resume from the switcher (req 2).
- [x] Re-drive the two neighbouring tests that used a same-session resume as their
      vehicle, so they still pin `useConnectionSync`'s flag-keyed hydration.
- [x] Verify finding 2 against the code: confirm the attach replay does not skip
      card messages, and that `upsertCard` writes an absent card in its fresh
      actionable state (req 3).
- [x] Extract the four card seeds into `seedCardStoresFromHistory`, unconditional,
      with the reasoning in its docstring (req 3, req 4).
- [x] Memoize the payload → `ChatMessage[]` map onto the history cache entry so a
      `304` re-installs the identical array of identical rows (req 5).
- [x] Weigh and reject the conditional-install alternative in `plan.md` (req 5).
- [x] Tests: row identity across a `304`, restore-from-same-rows after a clear,
      fresh rows on a moved tag, per-session isolation, and the seed on a `304`
      across ALL FOUR card stores (req 6).
- [x] Test: finding 1 end-to-end on the cached path, with the response held so
      the snapshot races the load; and the same-session-resume tail loss (req 6).
- [x] Confirm each new test goes red against the regression it names.
- [x] File the ghost card-store entry as its own issue (resolved question).
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev`.
- [x] Verify in the running product, not only in jsdom.
- [x] Independent review via `shipit agent run --role reviewer`.
