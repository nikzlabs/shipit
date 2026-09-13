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

- [x] Per-credential direct-call capability, **absent means no**; author it per shipped service.
- [x] Author the two settled cases: Anthropic's API key may; Z.AI's coding plan may not.
- [x] API model id per model where it differs from the catalogue id — Anthropic's `haiku` alias is the founding case.
- [x] Declared endpoint join: base from the service, path suffix from the style. Cover `/v1`, `/api/v1`, `/api/paas/v4`.
- [x] Required request headers per credential, or declare that credential not directly callable. OpenCode Go needs a user agent and `x-opencode-session`.
- [x] `direct-provider/types.ts` with `DirectCall`, including cache-read and cache-write counts.
- [x] `anthropic-messages.ts` and `openai-chat-completions.ts` seeded from the deleted voice adapters; `openai-responses.ts` new.
- [x] Per-style test built from **real catalogue rows** — URL, API model id and headers. A fake-fetch shape assertion cannot fail on any of the three bugs above.

Shipped in PR #2760, which resolved three things the design left open. Read
`resolveDirectCall` in `src/server/shared/catalogue/index.ts` before building on it.

- **An `account` credential can never declare the capability.** The declaration is still
  per credential and still fails closed; `via: "string"` is now a necessary condition on
  top, because every login integration is a credential the vendor issued for its own client
  application, and a target resolved from one would have no credential to send anyway.
- **The cache-token contract is a normalisation, not a pass-through.** Both OpenAI styles
  report an input total that already includes the cached portion, so returning it beside the
  cache counts would bill cached tokens at the uncached rate. The clients subtract.
- **`perCallIdHeaders` mints an id per resolution.** A constant `x-opencode-session` would
  put every background job on every install into one conversation.

- [x] Migration making `usage_turns.session_id` nullable; null means install-level spend.
- [x] An explicit background-work classification that does **not** depend on a harness id. Guard test: a direct pull-request call with a session id must stay out of `getPerTurnUsage` (`usage.ts:309`) and must not change the composer's context reading (`session-data.ts:471`). Prove the guard red by removing the classification.
- [x] Usage records service and billing mode from the selection, not from execution. Test OpenCode Go: a `sub` mode called directly stays subscription usage.
- [x] Install-wide reporting shows install-level rows; a session's own view does not.
- [x] `UsageModal.tsx` renders the install-level background-work group install-wide, and a session's own view does not.

Shipped in PR #2757. `sub_agent_id` turned out to carry the meaning "not the session's own turn"
in **four** read paths, not the one the design named: the context dial, the last-credential-route
lookup, the cumulative-baseline chain, and the cost-source default. All four now read the
explicit classification. Two findings left for later, because they are outside the feature:
install-wide usage is reachable only through a session, and the "All sessions" heading now also
covers work that belongs to no session.

- [x] `NonTurnTarget` becomes a union on `execution`; fix every consumer the compiler names.
- [x] Background-work eligibility that does not require an installed harness.
- [x] Background-work option list not filtered by `agent.installed` (`model-choice.ts:32`), carried through bootstrap and credential-change updates.
- [x] Seeding and save validation in `services/settings.ts` accept an option with no installed harness.
- [x] `BackgroundWorkSection.tsx` derived line reads "Called directly · no harness, no container" where that is what runs; render test per state.

Shipped in PR #2762 (the union and eligibility) and PR #2766 (the option list, validation and the
derived line). The selector slice also added a filter nobody planned: `backgroundWorkHarnessFor`
in `non-turn-model.ts` now skips a harness carrying a `toolsOffRefusal`, so one that cannot run
with its tools off is never selected for background work at all.

## Phase 3 — Both callers onto the executor

- [x] Pull-request path: resolve and execute above the no-session and no-runner gates (`non-turn-work.ts:231`, `:252`).
- [x] Test that background work now succeeds with no session open and with the container reclaimed.
- [x] Session naming: extract prompt construction and result parsing from the `execFile` invocation in `session-namer.ts:443`; run the selected executor; keep its failure, usage and branch-finalisation behaviour.
- [x] Delete `harnessOnly` once naming stops asking for it; it has no other caller.

Shipped in PR #2769. The defect it removed was worse than "naming takes the slower route", and
both halves are gone: `services/graduate-session.ts` resolved with `harnessOnly: true`, so an
install whose background-work choice is reachable only as a direct call got `pin_unavailable` —
**no generated name on any session**, plus a card saying the model's credential or harness was
gone while that credential was present and working. The false cause was the damaging half,
because it sent the user to Settings to repair nothing.

- **Whether naming should keep its own definition of an eligible harness was a real decision,
  not a consequence.** It was taken deliberately and is recorded in [`plan.md`](./plan.md);
  measuring the one harness it costs is
  [planning#546](https://github.com/nikzlabs/shipit-planning/issues/546).
- **The dispatch route resolved no background-work model at all.** `POST
  /api/sessions/:id/agent/dispatch` passed none of the credential plumbing into graduation, so
  it named on the session's own harness and silently ignored the user's choice. Found by review,
  outside the slice as written.
- **The title parser was order-dependent.** It matched slug-before-title only, so a correct
  answer in the other key order was discarded after the provider had already billed for it.

**Sequencing, decided while shipping rather than in the design.** The union, the direct executor
and the pull-request caller ship together, ahead of the selector work. A selector that offered a
direct-call option before a resolver could run it would let the user save a choice that then
fails, so the server side leads and the option list follows it.

## Phase 4 — Cleanup container, deadline, voice key

- [x] Create the cleanup container at orchestrator start; recreate it from the health monitor.
- [x] Exempt it from `steady-state-reclaim` / the idle enforcer; test that a memory-pressure pass leaves it alone.
- [x] One-shot spawn with tools off — `--tools ""` for Claude, the equivalent per harness.
- [x] Reuse the existing spawn-home machinery for per-request isolation; do **not** delete `provisionSubAgentSpawnHome`, which also builds OpenCode's ChatGPT credential projection and publishes rotated tokens (`session-agent-credentials.ts:367`, `:397`).
- [x] `RUNTIME_MODE=local`: run the harness from the orchestrator as `session-namer.ts` does; test it, since local cleanup has no container path today.
- [x] Worker cancellation addressed by spawn id; `/agent/kill` targets the primary agent and is not it. Never kill the shared container to enforce one request's deadline.

Shipped in PR #2761. It also broke `main`: the switch it added over `AgentId` was written before
the Antigravity harness added a fifth member, and the two merged in that order. Neither pull
request's own checks could see it, because each was green against the base it forked from.
Antigravity turned out to have no way to run with its tools off at all — its adapter reads no
such flag — so background work refuses that harness rather than running it with every tool live.
Measuring it properly is [planning#546](https://github.com/nikzlabs/shipit-planning/issues/546).

- [x] Orchestrator-side deadline returning the raw transcript, not waiting on teardown.
- [x] Split the cleanup budget into a direct value and a harness value.
- [x] Remove `pickCleanupProvider`; keep `isSane`.
- [x] Move `emitNonTurnFailure` out of the shared path so cleanup writes nothing to chat (req 6).

Shipped in PR #2767, which also deleted `voice/providers/openai-cleanup.ts` — cleanup now runs
entirely on the background-work choice, with no provider of its own. Until the voice key is
adopted, an install whose only OpenAI key is that one has no cleanup.

- [ ] Adopt `voiceProviderKeys.openai` as an ordinary OpenAI service credential, per docs/252 req 20's precedent. Seed background work onto it only when nothing is set.
- [ ] The adoption notice in `VoiceTab.tsx`; declining leaves cleanup unavailable and says so, and never writes a background-work choice.
- [ ] `VoiceTab.tsx` status names the background-work choice, links to that setting, and says when cleanup will take a few seconds. Render test per state.
- [ ] Test: cleanup failure inserts the raw transcript and persists no chat card.

## Closing

- [ ] Re-review the branch diff against every numbered requirement.
- [ ] Comment the outcome on [planning#542](https://github.com/nikzlabs/shipit-planning/issues/542).
