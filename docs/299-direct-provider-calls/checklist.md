# 299 — Direct provider calls for background work: checklist

Design in [`plan.md`](./plan.md), requirements in [`requirements.md`](./requirements.md).

## Phase 0 — Requirements and design

- [x] Write `requirements.md` from the user's direction; record every answer as a dated receipt.
- [x] Measure one-shot harness latency against the cleanup budget.
- [x] Write `plan.md`.
- [x] First independent review; fold its findings in.
- [x] Second independent review of the corrected design; fold its findings in.
- [x] Prototype the UI changes as [`mockup.html`](./mockup.html); link it from `plan.md`.

## Phase 1 — Stop the terms violation

- [x] Delete `voice/providers/claude-cleanup.ts` and its test.
- [x] Drop the Claude branch from `pickCleanupProvider`, so cleanup uses the OpenAI voice key only.
- [x] Update `GET /api/voice/cleanup/status` and the `CLEANUP_STATUS_LABELS` entry in `VoiceTab.tsx`.
- [x] Confirm no other caller uses `AuthManager.getAccessToken()` for inference. `limits-provider.ts` reads the user's own usage and runs none — leave it and say why.

Shipped in PR #2754. Until phase 4 restores cleanup through the background-work model, an
install whose only transcription is Deepgram and which holds no OpenAI voice key has no
cleanup at all.

## Phase 2 — Catalogue contract, direct clients, usage

- [ ] Per-credential direct-call capability, **absent means no**; author it per shipped service.
- [ ] Author the two settled cases: Anthropic's API key may; Z.AI's coding plan may not.
- [ ] API model id per model where it differs from the catalogue id — Anthropic's `haiku` alias is the founding case.
- [ ] Declared endpoint join: base from the service, path suffix from the style. Cover `/v1`, `/api/v1`, `/api/paas/v4`.
- [ ] Required request headers per credential, or declare that credential not directly callable. OpenCode Go needs a user agent and `x-opencode-session`.
- [ ] `direct-provider/types.ts` with `DirectCall`, including cache-read and cache-write counts.
- [ ] `anthropic-messages.ts` and `openai-chat-completions.ts` seeded from the deleted voice adapters; `openai-responses.ts` new.
- [ ] Per-style test built from **real catalogue rows** — URL, API model id and headers. A fake-fetch shape assertion cannot fail on any of the three bugs above.
- [ ] `NonTurnTarget` becomes a union on `execution`; fix every consumer the compiler names.
- [ ] Migration making `usage_turns.session_id` nullable; null means install-level spend.
- [ ] An explicit background-work classification that does **not** depend on a harness id. Guard test: a direct pull-request call with a session id must stay out of `getPerTurnUsage` (`usage.ts:309`) and must not change the composer's context reading (`session-data.ts:471`). Prove the guard red by removing the classification.
- [ ] Usage records service and billing mode from the selection, not from execution. Test OpenCode Go: a `sub` mode called directly stays subscription usage.
- [ ] Install-wide reporting shows install-level rows; a session's own view does not.
- [ ] Background-work eligibility that does not require an installed harness.
- [ ] Background-work option list not filtered by `agent.installed` (`model-choice.ts:32`), carried through bootstrap and credential-change updates.
- [ ] Seeding and save validation in `services/settings.ts` accept an option with no installed harness.
- [ ] `BackgroundWorkSection.tsx` derived line reads "Called directly · no harness, no container" where that is what runs; render test per state.
- [ ] `UsageModal.tsx` renders the install-level background-work group install-wide, and a session's own view does not.

## Phase 3 — Both callers onto the executor

- [ ] Pull-request path: resolve and execute above the no-session and no-runner gates (`non-turn-work.ts:231`, `:252`).
- [ ] Session naming: extract prompt construction and result parsing from the `execFile` invocation in `session-namer.ts:443`; run the selected executor; keep its failure, usage and branch-finalisation behaviour.
- [ ] Test that background work now succeeds with no session open and with the container reclaimed.

## Phase 4 — Cleanup container, deadline, voice key

- [ ] Create the cleanup container at orchestrator start; recreate it from the health monitor.
- [ ] Exempt it from `steady-state-reclaim` / the idle enforcer; test that a memory-pressure pass leaves it alone.
- [ ] One-shot spawn with tools off — `--tools ""` for Claude, the equivalent per harness.
- [ ] Reuse the existing spawn-home machinery for per-request isolation; do **not** delete `provisionSubAgentSpawnHome`, which also builds OpenCode's ChatGPT credential projection and publishes rotated tokens (`session-agent-credentials.ts:367`, `:397`).
- [ ] `RUNTIME_MODE=local`: run the harness from the orchestrator as `session-namer.ts` does; test it, since local cleanup has no container path today.
- [ ] Orchestrator-side deadline returning the raw transcript, not waiting on teardown.
- [ ] Worker cancellation addressed by spawn id; `/agent/kill` targets the primary agent and is not it. Never kill the shared container to enforce one request's deadline.
- [ ] Split the cleanup budget into a direct value and a harness value.
- [ ] Remove `pickCleanupProvider`; keep `isSane`.
- [ ] Move `emitNonTurnFailure` out of the shared path so cleanup writes nothing to chat (req 6).
- [ ] Adopt `voiceProviderKeys.openai` as an ordinary OpenAI service credential, per docs/252 req 20's precedent. Seed background work onto it only when nothing is set.
- [ ] The adoption notice in `VoiceTab.tsx`; declining leaves cleanup unavailable and says so, and never writes a background-work choice.
- [ ] `VoiceTab.tsx` status names the background-work choice, links to that setting, and says when cleanup will take a few seconds. Render test per state.
- [ ] Test: cleanup failure inserts the raw transcript and persists no chat card.

## Closing

- [ ] Re-review the branch diff against every numbered requirement.
- [ ] Comment the outcome on [planning#542](https://github.com/nikzlabs/shipit-planning/issues/542).
