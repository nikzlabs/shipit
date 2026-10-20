# 333 — Idle compaction: checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## Before code

- [x] Probe: a Claude session resumed in a fresh container reads the warm cache on its first request. Result then: it does not. Corrected by planning#704: it does; the cold first resume was a confound (plan.md, "Verify first" 1).
- [x] The user decided the ShipIt-update case: an exception to req 2 (req 13). No container is started. Removed on 2026-10-19 (planning#704, below), kept and then removed on 2026-10-20 (requirements.md, receipts).
- [x] Probe: `cache_creation` with the 5m/1h split arrives on main-thread `assistant` messages in `--output-format stream-json` (CLI 2.1.300). Result: it does.
- [x] Cross-spawn check for Codex and OpenCode (plan.md, "Verify first" 1b): Codex is warm across processes; OpenCode is cold, because ShipIt gives it a new instruction-file path every turn. No configured role runs Grok, so Grok is unchecked.
- [x] The user decided: OpenCode stays once its prompt is stable (req 14); Grok is out until tested (req 15).
- [x] For OpenCode only: planning#701 (one stable instruction-file path per session) merged, and its control probe warm. Merged as PR #3239; B read 99.1% of A from the cache (plan.md, "Verify first" 1b).

## Piece 1 — cache lifetime

- [x] `cache_creation` on per-message usage in `ClaudeUsageIteration` (`shared/types/claude-types.ts`).
- [x] `cacheTtl` on `AgentResultEvent`, from main-thread messages only (`session/agents/claude/adapter.ts`).
- [x] `idleCacheLifetimeMinutes`: route-scoped observation, the provider table keyed by model vendor, 30 otherwise.

## Piece 2 — deadline

- [x] `usage_turns.cache_ttl` and `cache_anchor_at` columns + migration; the anchor is the last tool result or the turn start, written only for ordinary turns.
- [x] `services/idle-compaction.ts`: the deadline map, one timer at the earliest `due`.
- [x] Arm after `usageManager.record`; 200K floor with `undefined` = skip.
- [x] Drop on fire, rewind, and model or harness change (checked at the fire); do not clear at turn start.
- [x] Boot re-derivation from the newest anchored own-turn row per session.

## Piece 3 — firing

- [x] Take the attempt synchronously; checks: setting, done, harness, expiry, busy (docs/324's check, exported).
- [x] Runner: existing, or reconnect (`wakeSessionWithTurn` pattern); no container → drop (req 13). Replaced by planning#704: no container → start one.
- [x] Claude with live steering: drop when the runner holds no resident agent; live steering off: proceed. Replaced by planning#704: the account check.
- [x] Re-check after the wake, immediately before dispatch.
- [x] `runner.dispatch(prepareDispatch({ "/compact", automatic, silent, activity }), { whenBusy: "refuse" })`; warn notice on wake or setup failure.

## Piece 3a — past the question hold (req 12)

- [x] `busyReason`'s question-hold arm is skippable; the idle fire skips it, docs/324 keeps it.
- [x] `dispatchOnRunner` admits a silent compaction past the answer hold; the hold is not cleared and held work still waits.

## Piece 4 — maintenance

- [x] A silent compaction turn skips `track()`, the unmute, `touchUnlessResolved` and `recordTurnEnd`.
- [x] The in-flight record keeps the compaction class; adoption restores maintenance behaviour and the missed-card check.

## Piece 5 — idle enforcer

- [x] Waiting sessions sort after the others in tier 1.
- [x] Fire instead of stop; count the bytes; `compactingToReclaim` across passes; stop first once reclaimable.

## Piece 6 — setting

- [x] `advanced.idleCompaction` (off by default, `propose: yes`), getter, `services/misc.ts` fallback.

## Tests

- [x] Lifetime: observed per route; 5-minute → no deadline (req 11); unknown → 30 (req 10); a Kimi model → 5; Grok → none (req 15); OpenCode on an OpenAI model → 30, on an Anthropic model → no deadline (req 14).
- [x] Deadline: anchored on the last tool result; replaced by a new result; kept when a turn dies without one; not written by a compaction turn; dropped by rewind and model change; re-derived at boot, and not from a failed compaction's row.
- [x] Fire: each check drops it; never after `expires`; refused when busy, including resident background work; re-checked after the wake; dropped with no container and, for resident Claude, with no resident agent. The last two replaced by planning#704 (below).
- [x] A silent compaction does not move the session in the list, does not clear a merged session's resolved state, does not unmute it, and does not change the last turn outcome — also after a restart mid-compaction.
- [x] Enforcer: waiting sessions last; one pass fires only as many compactions as the shortfall needs; a compacted session is stopped by a later pass.
- [x] Question hold: an idle compaction runs while a question waits; afterwards the hold is still on, held automatic work still waits, and the user's answer releases it.
- [x] Integration: a silent idle compaction records the card; a missing card posts the warn notice; a message sent during it runs afterwards.

## Docs

- [x] `src/server/shipit-docs/wiki/settings-and-accounts.md`, `wiki/chat.md`.

## planning#704 — the update case (req 13)

- [x] Probe through ShipIt's spawn on a 303K-token, tool-heavy conversation: a new process reads it warm (plan.md, "Verify first" 1).
- [x] Probe: a new process stays warm across CLI 2.1.293 → 2.1.300 and a change to ShipIt's instructions (the CLI's stored prompt snapshot).
- [x] Probe: a new process resumed with `/compact` 50 minutes after the last request. Result: it read 303,133 tokens from the cache and wrote 5.
- [x] Req 13 rewritten after the user's 2026-10-20 answer, with a dated receipt.
- [x] `bootSessionRunner` (`wake-session.ts`), shared by `wakeSessionWithTurn` and the fire: no container → start one, marked woken before the wake (`lastUsedAt`, `previewBefore`).
- [x] The account check (`nextTurnRouteId` over `selectTurnRoute`) replaces the resident check; `workerIdleResident` removed.
- [x] A process the runner could not take over drops the fire; `isStarting` holds the session from the wake to the dispatch; the fire waits for the worker and the install (`whenReadyForAgent`) and checks the expiry again.
- [x] The idle enforcer stops a woken container again, whatever the budget, unless the session was used; a preview from before the wake stays.
- [x] Tests: a wake and its mark; a stale runner replaced; the mark kept when the check after the wake drops the fire; the hold; the failed take-over; the readiness wait and an expiry during it; a mark kept while the container is created; failover in the route prediction; the account check; a new Claude process compacts; the enforcer's stop, its "used" cases, a retry that is not use, the kept preview, the hold over budget; `nextTurnRouteId`.
- [x] Wiki: `chat.md`.
- [x] Independent review (runs 2dd061e5 and dc8f5393); findings fixed or kept as known limits (plan.md, "Review resolution").
