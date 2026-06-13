# 201 — Nested Child Session Visibility — checklist

Implementation of Option C (track `rootSessionId` ancestor). All layers landed
and verified (`npm run typecheck`, `npm run lint:dev`, affected tests green).

- [x] Domain type: add optional `rootSessionId` to `SessionInfo` (`domain-types.ts`)
- [x] DB migration: `root_session_id` column + `idx_sessions_root` index, appended positionally
- [x] DB migration: one-time backfill walking each `parent_session_id` chain to its top (idempotent, cycle-guarded)
- [x] `SessionManager.fromRow` maps `root_session_id` → `rootSessionId`
- [x] `setParentSession` gains 4th `rootSessionId?` param and persists the column
- [x] `filterVisibleInSidebar` exemption keyed off the **root** (`liveRoots`) instead of the immediate parent — depth-independent
- [x] Spawn flow: `child-sessions.ts` computes `parent.rootSessionId ?? parentSessionId` and threads it through `GraduateSessionOpts`
- [x] `graduateSession` forwards `rootSessionId` to `setParentSession`
- [x] Client: `SessionSidebar` buckets the whole brood by `rootSessionId` (one indent level); orphan fallback to top level when root absent from group
- [x] Tests: backfill walk (chain, idempotent, cyclic guard) — `database.test.ts`
- [x] Tests: filter keeps merged grandchild visible while root live; reclaims when root archived — `sessions.test.ts`
- [x] Tests: grandchild inherits root not immediate parent — `graduate-session.test.ts`, `agent-spawned-session.test.ts`
- [x] Tests: sidebar renders grandchild under root, collapse hides whole brood, orphan top-level fallback — `SessionSidebar.test.tsx`

## Deferred (tracked, not in this work)

- [ ] D3 — provenance hint ("via &lt;middle child&gt;") on grandchild rows (pure presentation, no data change)
- [ ] D4 — root-wide active cap over `findBrood(rootId)`, gated on telemetry (SHI-132 follow-up)
