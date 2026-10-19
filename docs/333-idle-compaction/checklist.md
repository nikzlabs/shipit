# 333 — Idle compaction: checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## Verify first (plan.md, "Verify first")

- [ ] Probe: a Claude session resumed in a fresh container reads the warm cache on its first request. If not, take the ShipIt-update case of req 2 to the user before piece 3's container start.
- [ ] Probe: `cache_creation` with the 5m/1h split arrives on main-thread `assistant` messages in `--output-format stream-json` (CLI 2.1.300).

## Piece 1 — cache lifetime

- [ ] `cache_creation` in `ClaudeUsageIteration` and the result usage (`shared/types/claude-types.ts`).
- [ ] `cacheTtl` on `AgentResultEvent`, from main-thread messages only (`session/agents/claude/adapter.ts`).
- [ ] `usage_turns.cache_ttl` column + migration; `UsageManager` reads the newest non-null value.
- [ ] `idleCacheLifetimeMinutes` with the harness/model table, including the OpenCode Claude and Kimi rows.

## Piece 2 — deadline

- [ ] `services/idle-compaction.ts`: the deadline map, one timer at the earliest `due`.
- [ ] Arm after `usageManager.record` for ordinary turns; skip compaction turns; 200K floor with `undefined` = skip.
- [ ] Clear at every turn start.
- [ ] Boot re-derivation from the newest own-turn usage row per session.

## Piece 3 — firing

- [ ] Re-checks: setting, done, harness capability, `now < expires`.
- [ ] Runner: existing, reconnect (`wakeSessionWithTurn` pattern), or fresh container only inside the memory budget.
- [ ] Dispatch: `/compact`, `automatic`, `silent`, `whenBusy: "refuse"`, `countsAsActivity: false`; warn notice on setup failure.

## Piece 4 — not activity

- [ ] `countsAsActivity` through `AgentDispatchOptions` → `QueuedMessage` → turn input.
- [ ] When false: skip `track()` and the unmute at turn start, and `touchUnlessResolved` at the result.

## Piece 5 — idle enforcer

- [ ] Sort waiting sessions after the others in tier 1.
- [ ] Fire the compaction instead of stopping a waiting session; stop it on the next pass after `idle`.

## Piece 6 — setting

- [ ] `advanced.idleCompaction` (off by default, `propose: yes`), getter, `services/misc.ts` fallback.

## Tests

- [ ] Lifetime table, including 5-minute → no deadline (req 11) and unknown → 30 (req 10).
- [ ] Deadline: armed, cleared by a new turn, not armed under 200K or for a compaction turn, re-derived at boot.
- [ ] Fire: each re-check drops it; never after `expires`; refused when busy.
- [ ] An idle compaction does not move the session in the list, does not clear a merged session's resolved state, and does not unmute it.
- [ ] Enforcer: waiting sessions last; a waiting session is compacted, not stopped, and is stopped after its compaction.
- [ ] Integration: a silent idle compaction records the card; a missing card posts the warn notice; a message sent during it runs afterwards.

## Docs

- [ ] `src/server/shipit-docs/wiki/settings-and-accounts.md`, `wiki/chat.md`.
