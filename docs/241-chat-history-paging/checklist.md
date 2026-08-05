# Checklist

Design only so far — nothing implemented. No schema change, no migration.

## 0. Measure first
- [ ] Instrument one real long session: total `/history` payload split by component — message columns (`tool_results` / `tool_use` / `images` / `subagent_events`) **and** fileTree / commits / turnUsage
- [ ] Time split: server `load()` vs serialize, transfer, client `JSON.parse`, and React mount/markdown-parse separately
- [ ] Measure how often a foreground reconnect fires in normal use
- [ ] Decision gate keyed on **time**: mount/render dominates ⇒ paging first; transfer/parse of a few heavy rows dominates ⇒ SHI-267 first and resequence this behind it
- [ ] Separate item, not a substitute: enable origin compression for the non-Cloudflare deployment paths (tailnet, local)

## 1. Server (inert until the client sends `limit`)
- [ ] `ChatHistoryManager.loadWindow(sessionId, { limit, beforeId? })` — **id cursor, not a tail offset** (a tail offset shifts under concurrent appends); leave `load()` intact
- [ ] Window counted in **turns** (back to the Nth-newest user row), with a row floor (~50) and cap (~500); N = 10 to start
- [ ] **Snap the window start to a `role: "user"` row** — extend back to the nearest preceding one; if past the cap, snap forward to the next one instead
- [ ] `?limit=N` on `GET /history`; absent ⇒ byte-identical to today
- [ ] `&beforeId=` returns `{ messages, omittedBefore, hasMore }` only — skips git log + file tree
- [ ] `omittedBefore` is a **head-anchored** count, not a tail offset
- [ ] The running turn is exempt from the row cap (else `turn_snapshot` reintroduces rows below the window)
- [ ] Cursor invalidation + window reload after any history rewrite, incl. the cross-tab broadcast path
- [ ] `firstUserText` via `LIMIT 1` query (not via `load()`)
- [ ] `sentUploadPaths` via targeted user-row scan (not via `load()`)

## 2. Destructive-action safety (must land before the client sends `limit`)
- [ ] **Do not do ordinal arithmetic over the live array.** Fully hydrate canonical history (or use a server-issued boundary token) before opening the rewind affordance
- [ ] `commit_linked` keys on the server-known row id, not a translated index
- [ ] Rewind confirmation **preview** computed server-side from the canonical position
- [ ] Handle absolute gap zero vs window-local position zero
- [ ] Cover every index-bearing exchange: rewind preview request + response, rewind action, `rewind_complete`
- [ ] Generalize the `historyLoadSeq` epoch to cover page loads, search expansion and rewind restore
- [ ] Regression test: rewind from a windowed client rewrites the correct rows (`chat`, `both`, `code`, `fork`)

## 3. Client
- [ ] Store `omittedBefore` / `hasMore`; DOM keys become `omittedBefore + i`
- [ ] Tool-group keys too (`tg-${messageIndices[0]}`) — they are usually the anchor element
- [ ] Memoize `buildVisualElements` (currently inline in render, O(n) per prepend)
- [ ] Scroll-top trigger → fetch previous page → prepend, behind a single in-flight latch
- [ ] Scroll anchoring on prepend (element anchor; `content-visibility: visible` during correction)
- [ ] Prepend signal in `useMessageScroll` — must also suppress the `appendedUserMessage` branch (`:143-145`), which bypasses the scrolled-away guard
- [ ] **Reconnect preserves the loaded span**: refetch with `limit = max(window, loadedCount)`, or merge instead of replace
- [ ] Card-store seeding runs per prepended page, seed-if-absent
- [ ] `handleReleaseCard`: drop when card not found and `hasMore` (do not append)
- [ ] Client starts sending `limit` — only after §2 and the search/export items below

## 4. Visible seam + navigation
- [ ] Persistent element at the top of the window: label → spinner → "Couldn't load earlier messages · Retry"
- [ ] Nothing shown when `hasMore` is false (short sessions look exactly like today)
- [ ] "Jump to latest" control when the user is far from the bottom (none exists today)

## 5. Search and export
- [ ] Ctrl+F fetches on **search-bar open**, not first query; via the messages-only endpoint
- [ ] While in flight: suppress the match count (never show `0`), disable next/previous
- [ ] Full install runs through the same anchor correction as a prepend
- [ ] Download chat: one-shot full fetch, keep client-side serialization
- [ ] Document that search scans `msg.text` only — not tool output, not card content

## 6. Verification
- [ ] A window never opens mid-run: a tool-group at the top shows its full item count
- [ ] Snap works when the boundary is a live steer (a steer is a user row, so a valid flush point)
- [ ] `ExitPlanMode` plan lookup: persist the plan reference, or degrade visibly — `findPlanContent` scans past user rows so the snap does not protect it
- [ ] A window cut during a long running turn does not desync against `turn_snapshot`
- [ ] A tool-heavy turn does not consume the whole window (turn-counted, floor/cap respected)
- [ ] Foreground reconnect does not collapse a scrolled-open span
- [ ] Prepend during the send→first-output window does not yank to the bottom
- [ ] Load-older is stable while a turn is appending
- [ ] Scroll position holds on prepend, with and without images in the batch
- [ ] Card lifecycle state survives a prepend (older page does not overwrite newer)
- [ ] Search and export cover the whole conversation from a windowed client
- [ ] Sent uploads do not resurrect as draft chips when their row is outside the window
- [ ] Failed load-older shows the retry affordance, not a silent stop
