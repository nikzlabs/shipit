# 265 — Transcript render cost: checklist

- [x] Cancel a superseded `/history` load instead of parsing and discarding it (req 8)
- [x] Stable element identity from `buildVisualElements` (design 1a)
- [x] Ref-backed handler context so upstream callbacks stop invalidating rows (design 1b)
- [x] Extract the memoized `TranscriptRow`; move per-row work into it (design 1a, 1c)
- [x] `matchesByMessage` memoized; row does its own lookup (req 7)
- [x] Guard test: appending a message, and growing the streaming one, must not
      re-render the rows above (`transcript-row-memo.test.tsx`)
- [x] ETag + `304` on `GET /history`; bounded per-session client cache (reqs 10, 11)
- [x] Drop `fileTree` from `/history`; ETag on `/files`; tree fetched under the same
      supersede guard as the transcript (req 12)

From independent review (all fixed, each with a regression test):

- [x] `useSearch` returned a fresh `[]` on every message change, so the no-search case
      rebuilt `matchesByMessage` and re-rendered every row — the fix was defeated in
      production while the guard test passed (reqs 1–4)
- [x] A fire-and-forget `/files` fetch had no session scope, so the outgoing session's
      tree could overwrite the incoming one's
- [x] Row callbacks were dereferenced during render, so a memoized row that never
      re-rendered held a stale closure
- [x] The history cache was FIFO despite the LRU intent — a 304 did not count as a use,
      so the most-revisited session was the one that aged out

Still open:

- [ ] Re-trace a streaming turn on a long session and compare against the table in
      `plan.md` — **not done**: the dogfood inner instance has no session carrying a
      transcript, so there was nothing to trace. The fix rests on the memo guard tests
      rather than on a measurement. Review rated reqs 1–4 unmet on that basis, and the
      production defect it found is exactly why a measurement, not an argument, is what
      closes them.
- [ ] Decide from that measurement whether explicit event batching is still needed
      (design 2) — blocked on the item above; deliberately not built on speculation.
- [ ] Hand-check Ctrl+F, select-all, pin-to-bottom, search jump-to-match on a long
      session (reqs 5, 6, 7, 9) — needs a real transcript; the DOM is unchanged by
      construction (every message still mounted), but that is an argument, not a check.
- [ ] `buildVisualElements` still walks the whole transcript per update. Cheap next to
      what it replaced, but unmeasured against req 3's "must not grow".
