# 110 — Pinned Sessions · checklist

## Phase 1 — pin/unpin + persistence

- [x] `pinnedAt?: string` on `SessionInfo` + `pinned_at` migration + `SessionRow`/`fromRow`
- [x] `SessionManager.setPinned`; `archive` clears `pinned_at`
- [x] `filterVisibleInSidebar` exempts pinned sessions (visibility immunity)
- [x] `disk-janitor.ts` `canAutoDescend` pin guard (eviction immunity) + defensive sweep skips
- [x] `pinSession`/`unpinSession` services + `POST`/`DELETE /api/sessions/:id/pin` routes (broadcast `session_list`)
- [x] Client `setPinned` optimistic action
- [x] `SessionSidebar` pinned sub-section + Pin/Unpin overflow item + pin glyph
- [x] Tests: persist/unpin, archive-clears-pin, per-repo scoping, visibility immunity, eviction immunity, sidebar component
- [x] `lint:dev` + `typecheck` clean

## Phase 2 — reorder within pins (deferred)

- [ ] `SessionManager.reorderPins(remoteUrl, ids)`
- [ ] `POST /api/sessions/pin-order` + client `reorderPins` action
- [ ] Native HTML5 drag-and-drop on pinned rows (`application/x-shipit-pinned-session` MIME, drop indicator)
