# 281 — checklist

- [x] Verify finding 1 against the code: trace the `historyLoaded` gate from the
      reconnect through the queue, the install and the drain (req 1).
- [x] Verify finding 2 against the code: confirm the attach replay does not skip
      card messages, and that `upsertCard` writes an absent card as `pending`
      (req 2).
- [x] Extract the four card seeds into `seedCardStoresFromHistory`, unconditional,
      with the reasoning in its docstring (req 2, req 3).
- [x] Memoize the payload → `ChatMessage[]` map onto the history cache entry so a
      `304` re-installs the identical array of identical rows (req 4).
- [x] Weigh and reject the conditional-install alternative in `plan.md` (req 4).
- [x] Tests: row identity across a `304`, restore-from-same-rows after a clear,
      fresh rows on a moved tag, per-session isolation, the seed on a `304`
      (req 5).
- [x] Test: finding 1 end-to-end on the cached path, with the response held so
      the snapshot races the load (req 5).
- [x] Confirm each new test goes red against the regression it names.
- [x] File the ghost card-store entry as its own issue (req 5 resolution).
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev`.
- [x] Verify in the running product, not only in jsdom.
- [x] Independent review via `shipit agent run --role reviewer`.
