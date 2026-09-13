# 299 — Direct provider calls for background work: checklist

Design in [`plan.md`](./plan.md), requirements in [`requirements.md`](./requirements.md).

## Phase 0 — Requirements and design

- [x] Write `requirements.md` from the user's direction; record both answers as dated receipts.
- [x] Measure one-shot harness latency against the cleanup budget.
- [x] Write `plan.md`.

## Phase 1 — Stop the terms violation

- [ ] Delete `voice/providers/claude-cleanup.ts` and its test.
- [ ] Drop the Claude branch from `pickCleanupProvider`, so cleanup uses the OpenAI key only.
- [ ] Update `GET /api/voice/cleanup/status` and the `CLEANUP_STATUS_LABELS` entry in `VoiceTab.tsx`.
- [ ] Check no other caller uses `AuthManager.getAccessToken()` for inference.

## Phase 2 — Direct clients

- [ ] `direct-provider/types.ts` with the shared `DirectCall` shape, including token counts.
- [ ] `anthropic-messages.ts` and `openai-chat-completions.ts`, seeded from the deleted voice adapters.
- [ ] `openai-responses.ts`, new; unit tests against a fake fetch for all three.
- [ ] `NonTurnTarget` becomes a union on `execution`; fix every consumer the compiler names.
- [ ] Background-work eligibility that does not require an installed harness for a `key` mode.
- [ ] `key` mode stops offering harness rows for background work; session selection unchanged.
- [ ] Dispatch on `target.execution` in `runNonTurnSpawn`; assert direct-call usage reaches `recordNonTurnUsage` with real token counts.
- [ ] `BackgroundWorkSection.tsx` states "Direct call to <service>" for a key mode.

## Phase 3 — Background-work container

- [ ] Create it at orchestrator start; recreate it from the health monitor.
- [ ] Exempt it from `steady-state-reclaim` / the idle enforcer; test that a memory-pressure pass leaves it alone.
- [ ] One-shot spawn with tools off — `--tools ""` for Claude, the equivalent per harness.
- [ ] Route harness-run background work here when the session has no live container; test the `non-turn-work.ts:254` path now succeeds.

## Phase 4 — Voice cleanup

- [ ] Remove `pickCleanupProvider`; resolve the background-work target instead. Keep `isSane`.
- [ ] Split `CLEANUP_TIMEOUT_MS` into a direct budget and a harness budget.
- [ ] Move `emitNonTurnFailure` out of the shared path so cleanup writes nothing to chat (req 6).
- [ ] `VoiceTab.tsx` status line names the background-work choice and links to that setting.
- [ ] Test: cleanup failure inserts the raw transcript and persists no chat card.

## Closing

- [ ] Independent review against every numbered requirement, via `shipit agent run --role reviewer`.
- [ ] Comment the outcome on [planning#542](https://github.com/nikzlabs/shipit-planning/issues/542).
