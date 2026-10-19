# 333 — Idle compaction: checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## Before code

- [x] Probe: a Claude session resumed in a fresh container reads the warm cache on its first request. Result: it does not — the first resume writes the conversation again (plan.md, "Verify first").
- [ ] The user decides whether the ShipIt-update case becomes an exception to req 2 (requirements.md, Open questions); piece 3's container start follows the answer.
- [x] Probe: `cache_creation` with the 5m/1h split arrives on main-thread `assistant` messages in `--output-format stream-json` (CLI 2.1.300). Result: it does.

## Piece 1 — cache lifetime

- [ ] `cache_creation` on per-message usage in `ClaudeUsageIteration` (`shared/types/claude-types.ts`).
- [ ] `cacheTtl` on `AgentResultEvent`, from main-thread messages only (`session/agents/claude/adapter.ts`).
- [ ] `idleCacheLifetimeMinutes`: route-scoped observation, the provider table keyed by model vendor, 30 otherwise.

## Piece 2 — deadline

- [ ] `usage_turns.cache_ttl` and `cache_anchor_at` columns + migration; the anchor is the last tool result or the turn start, written only for ordinary turns.
- [ ] `services/idle-compaction.ts`: the deadline map, one timer at the earliest `due`.
- [ ] Arm after `usageManager.record`; 200K floor with `undefined` = skip.
- [ ] Drop on fire, rewind, and model or harness change; do not clear at turn start.
- [ ] Boot re-derivation from the newest anchored own-turn row per session.

## Piece 3 — firing

- [ ] Take the attempt synchronously; checks: setting, done, harness, expiry, busy (docs/324's check, exported).
- [ ] Runner: existing, reconnect (`wakeSessionWithTurn` pattern), or a fresh container whatever the budget.
- [ ] Re-check after the wake, immediately before dispatch.
- [ ] `runner.dispatch(prepareDispatch({ "/compact", automatic, silent, activity }), { whenBusy: "refuse" })`; warn notice on wake or setup failure.

## Piece 3a — past the question hold (req 12)

- [ ] `busyReason`'s question-hold arm is skippable; the idle fire skips it, docs/324 keeps it.
- [ ] `dispatchOnRunner` admits a silent compaction past the answer hold; the hold is not cleared and held work still waits.

## Piece 4 — maintenance

- [ ] A silent compaction turn skips `track()`, the unmute, `touchUnlessResolved` and `recordTurnEnd`.
- [ ] The in-flight record keeps the compaction class; adoption restores maintenance behaviour and the missed-card check.

## Piece 5 — idle enforcer

- [ ] Waiting sessions sort after the others in tier 1.
- [ ] Fire instead of stop; count the bytes; `compactingToReclaim` across passes; stop first once reclaimable.

## Piece 6 — setting

- [ ] `advanced.idleCompaction` (off by default, `propose: yes`), getter, `services/misc.ts` fallback.

## Tests

- [ ] Lifetime: observed per route; 5-minute → no deadline (req 11); unknown → 30 (req 10); a Kimi model on Codex → 5.
- [ ] Deadline: anchored on the last tool result; replaced by a new result; kept when a turn dies without one; not written by a compaction turn; dropped by rewind and model change; re-derived at boot, and not from a failed compaction's row.
- [ ] Fire: each check drops it; never after `expires`; refused when busy, including resident background work; re-checked after the wake.
- [ ] A silent compaction does not move the session in the list, does not clear a merged session's resolved state, does not unmute it, and does not change the last turn outcome — also after a restart mid-compaction.
- [ ] Enforcer: waiting sessions last; one pass fires only as many compactions as the shortfall needs; a compacted session is stopped by a later pass.
- [ ] Question hold: an idle compaction runs while a question waits; afterwards the hold is still on, held automatic work still waits, and the user's answer releases it.
- [ ] Integration: a silent idle compaction records the card; a missing card posts the warn notice; a message sent during it runs afterwards.

## Docs

- [ ] `src/server/shipit-docs/wiki/settings-and-accounts.md`, `wiki/chat.md`.
