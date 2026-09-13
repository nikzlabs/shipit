# 299 — Direct provider calls for background work: checklist

Design in [`plan.md`](./plan.md), requirements in [`requirements.md`](./requirements.md).

## Phase 0 — Requirements and design

- [x] Write `requirements.md` from the user's direction; record both answers as dated receipts.
- [x] Measure one-shot harness latency against the cleanup budget.
- [x] Write `plan.md`.
- [x] Independent review; fold its findings back into both documents.
- [x] Answer the open question on how a dictation's spend appears in usage.

## Phase 1 — Stop the terms violation

- [ ] Delete `voice/providers/claude-cleanup.ts` and its test.
- [ ] Drop the Claude branch from `pickCleanupProvider`, so cleanup uses the OpenAI voice key only.
- [ ] Update `GET /api/voice/cleanup/status` and the `CLEANUP_STATUS_LABELS` entry in `VoiceTab.tsx`.
- [ ] Confirm no other caller uses `AuthManager.getAccessToken()` for inference. `limits-provider.ts` reads the user's own usage and runs none — leave it and say why.

## Phase 2 — Catalogue contract and direct clients

- [ ] Per-credential direct-callable flag, defaulting to **not** callable; author it per shipped service.
- [ ] Research whether GLM's coding plan permits direct API use; until then it stays harness-only.
- [ ] API model id per model where it differs from the catalogue id — Anthropic's `haiku` alias is the founding case.
- [ ] Declared endpoint join: base from the service, path suffix from the style. Cover the `/v1`, `/api/v1` and `/api/paas/v4` bases.
- [ ] `direct-provider/types.ts` with `DirectCall`, including cache-read and cache-write token counts.
- [ ] `anthropic-messages.ts` and `openai-chat-completions.ts` seeded from the deleted voice adapters; `openai-responses.ts` new.
- [ ] Per-style test that the URL and the API model id are built from **real catalogue rows**, one per shipped service — a fake-fetch shape assertion cannot fail on either bug.
- [ ] `NonTurnTarget` becomes a union on `execution`; fix every consumer the compiler names.
- [ ] Migration making `usage_turns.session_id` nullable; a null means install-level spend.
- [ ] `recordNonTurnUsage` accepts no session id and no harness id for a direct call.
- [ ] Every usage read path that groups by session renders the install-level row instead of skipping it or failing on a null — usage modal, per-session cost, by-spend ranking.
- [ ] Background-work eligibility that does not require an installed harness.
- [ ] Background-work option list that is not filtered by `agent.installed` (`model-choice.ts:32`), carried through bootstrap and credential-change updates.
- [ ] Seeding and save validation in `services/settings.ts` accept an option with no installed harness.
- [ ] `BackgroundWorkSection.tsx` states "Direct call to <service>" where that is what runs.

## Phase 3 — Background-work container

- [ ] Create it at orchestrator start; recreate it from the health monitor.
- [ ] Exempt it from `steady-state-reclaim` / the idle enforcer; test that a memory-pressure pass leaves it alone.
- [ ] One-shot spawn with tools off — `--tools ""` for Claude, the equivalent per harness.
- [ ] Per-request credential isolation inside the shared container.
- [ ] Move all harness-run background work here; delete the live-session branch and the `provisionSubAgentSpawnHome` borrow it existed for.
- [ ] Verify session-naming and pull-request-description prompts are self-contained under tools off.
- [ ] `RUNTIME_MODE=local` has no container manager (`app-lifecycle.ts:141`) — keep today's behaviour there and test it.
- [ ] Test that the `non-turn-work.ts:252` container-gone failure no longer occurs.

## Phase 4 — Voice cleanup

- [ ] Resolve and execute above the session and runner gates, so a direct call needs neither.
- [ ] Remove `pickCleanupProvider`; keep `isSane`.
- [ ] Orchestrator-side deadline with cancellation and process teardown; prove the raw transcript still arrives when the worker stops answering.
- [ ] Split the cleanup budget into a direct value and a harness value.
- [ ] Move `emitNonTurnFailure` out of the shared path so cleanup writes nothing to chat (req 6).
- [ ] Voice-key transition: offer the existing `voiceProviderKeys.openai` for adoption as a service credential, or say cleanup is unavailable. Never silently write a background-work pin.
- [ ] `VoiceTab.tsx` status names the background-work choice and links to that setting.
- [ ] Test: cleanup failure inserts the raw transcript and persists no chat card.

## Closing

- [ ] Re-review the branch diff against every numbered requirement.
- [ ] Comment the outcome on [planning#542](https://github.com/nikzlabs/shipit-planning/issues/542).
