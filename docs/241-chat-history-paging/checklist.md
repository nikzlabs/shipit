# Checklist

Design only so far — nothing implemented. No schema change, no migration.

## 0. Measure first
- [ ] Instrument one real long session: total `/history` payload size, and the share from `tool_results` / `tool_use` / `images` / `subagent_events`
- [ ] Split the time: server `load()` + serialize vs transfer vs client parse vs render
- [ ] Decision gate: if a handful of heavy rows dominate bytes, do SHI-267 (lazy bodies) first and resequence this behind it
- [ ] Separate item, not a substitute: enable origin compression for the non-Cloudflare deployment paths (tailnet, local)

## 1. Server (inert until the client sends `limit`)
- [ ] `ChatHistoryManager.loadWindow(sessionId, { limit, beforeOffset? })` — leave `load()` intact
- [ ] **Snap the window start to a `role: "user"` row** — extend back to the nearest preceding one; if past a cap, snap forward to the next one instead
- [ ] `?limit=N` on `GET /history`; absent ⇒ byte-identical to today
- [ ] `&beforeOffset=` returns `{ messages, omittedBefore, hasMore }` only — skips git log + file tree
- [ ] `firstUserText` via `LIMIT 1` query (not via `load()`)
- [ ] `sentUploadPaths` via targeted user-row scan (not via `load()`)

## 2. Index translation (must land before the client sends `limit`)
- [ ] Rewind sends `omittedBefore + gapPosition`
- [ ] `commit_linked` applies `messageIndex - omittedBefore`
- [ ] Regression test: rewind from a windowed client rewrites the correct rows (`chat`, `both`, `code`, `fork`)

## 3. Client
- [ ] Store `omittedBefore` / `hasMore`; DOM keys become `omittedBefore + i` (replaces array-index keys)
- [ ] Scroll-top sentinel → fetch previous page → prepend, behind a single in-flight latch
- [ ] Scroll anchoring on prepend (element anchor; `content-visibility: visible` during correction)
- [ ] Prepend signal in `useMessageScroll` so the bottom-pin settle loop stands down
- [ ] Card-store seeding runs per prepended page, seed-if-absent
- [ ] `handleReleaseCard`: drop when card not found and `hasMore` (do not append)
- [ ] Ctrl+F with `hasMore`: one-shot full fetch, install, then search as today
- [ ] Download chat with `hasMore`: one-shot full fetch, keep client-side serialization
- [ ] Client starts sending `limit` — only after §2 and the search/export items above

## 4. Verification
- [ ] Load-older is stable while a turn is appending
- [ ] Scroll position holds on prepend, with and without images in the batch
- [ ] Card lifecycle state survives a prepend (older page does not overwrite newer)
- [ ] Search and export cover the whole conversation from a windowed client
- [ ] Sent uploads do not resurrect as draft chips when their row is outside the window
- [ ] **A window never opens mid-run:** a tool-group at the top of the window shows its full item count, not a truncated one
- [ ] Snap works when the boundary is a live steer (a steer is a user row, so it is a valid flush point)
- [ ] Cap case: a run longer than the cap snaps forward rather than opening mid-group
- [ ] Voice Play prose and `ExitPlanMode` plan lookup are correct for the topmost turn in the window
