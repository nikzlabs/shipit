---
issue: planning#542
title: Direct provider calls for background work — design
description: How the billing mode decides between a harness and a direct API call, the per-style direct clients, the always-on background-work container, and the removal of the Claude OAuth cleanup provider.
---

# 299 — Direct provider calls for background work: design

This implements [`requirements.md`](./requirements.md).

## The shape: the billing mode already decides

Background work is selected today as a triple — `{ serviceId, billingMode, modelId }` — stored
as `nonTurnModel` and resolved by `resolveNonTurnModel` (`src/server/orchestrator/non-turn-model.ts`),
which derives a harness. Req 3 needs no fourth field, because it maps exactly onto the mode
already in the triple:

| Billing mode | How background work runs |
|---|---|
| `sub` | The vendor's harness, derived as today (docs/252 req 9) |
| `key` | A direct call to the service's endpoint for that model's API style |

So the selector keeps its two controls and its one write. What changes is the sentence under
them: `BackgroundWorkSection.tsx` renders "Runs on Claude Code" from `resolved.harnessId`, and
now renders "Direct call to Anthropic" for a key. That line was already carrying the one fact
the controls cannot state (its own file comment says so), and this is the same job.

**`NonTurnTarget` becomes a discriminated union.** Today it always carries `harnessId`:

```ts
export type NonTurnTarget =
  | { execution: "harness"; harnessId: AgentId; /* …as today… */ }
  | { execution: "direct"; style: ApiStyle; endpoint: string; credentialSecret: string; /* … */ };
```

Every consumer is forced to handle both by the compiler. `recordNonTurnUsage` already branches
on `target` being present, and `turnAttributionFor(target.selection)` needs only the selection,
so usage reporting (req 7) needs no new concept: a direct call is a `key`-mode row, which
docs/252 req 16 already reports as metered spend.

## Eligibility widens

`isSelectionEligible` requires a harness that shares an API style with the service
(docs/252 req 6). A direct call has no harness, so for background work the rule becomes:

- `sub` mode — unchanged. The vendor's harness must be installed and must speak the style.
- `key` mode — eligible when the credential exists and ShipIt has a client for the model's
  style. No harness needs to be installed at all.

This is a widening, not a narrowing, except for one case req 3 removes deliberately: a
key-mode model previously offered on a harness is now offered only as a direct call. Session
model selection keeps the old rule — `harnessesForSelection` is shared, so the background-work
path needs its own entry point rather than a change in place.

## The direct clients: three styles, two already written

`src/server/shared/catalogue/types.ts` declares three API styles, and each service's mode
declares its endpoint per style:

- `anthropic-messages` — `POST /v1/messages`
- `openai-chat-completions` — `POST /v1/chat/completions`
- `openai-responses` — `POST /v1/responses`

Two of the three already exist as voice adapters. `voice/providers/openai-cleanup.ts` is a
chat-completions client and `voice/providers/claude-cleanup.ts` is a messages client. They move
to `src/server/orchestrator/direct-provider/<style>.ts` and lose their voice-specific parts: the
model id becomes a parameter instead of a constant, the prompt becomes a parameter, and the
credential comes from the resolved target instead of `AuthManager`. `openai-responses` is new.

Each client is one function of the same shape, so the caller never branches on the vendor:

```ts
type DirectCall = (req: {
  endpoint: string; apiKey: string; model: string; prompt: string;
  maxOutputChars: number; signal?: AbortSignal;
}) => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
```

Returning the token counts is what keeps req 7 honest — `recordNonTurnUsage` warns and records
nothing when a run reports no telemetry, so a client that drops the usage block would make
direct calls invisible in the usage split.

## The background-work container

Req 8 says harness-run background work must not have a first-run penalty, and the user chose an
always-running shared container to achieve it (see the receipt). It is one container per
install, not per session:

- Created at orchestrator start, and recreated by the health monitor if it dies.
- **Exempt from docs/284 idle reclaim.** The enforcer takes the longest-idle container first,
  and this one is idle by definition, so without an exemption it would be taken every time and
  req 8 would fail exactly as often as the install is under memory pressure.
- It holds **no resident harness process**. Each request spawns a one-shot CLI and exits, so the
  container's steady-state cost is the container itself, not a loaded agent. Persisting the
  container removes the 1 to 2 second start
  (`docs/051-session-containerization/plan.md:580`); persisting a harness process would remove
  about another 1.2 second of CLI boot, and is deliberately not built. It is the option to reach
  for if req 8's predictability turns out not to be enough.
- Tools are off. The flag is `--tools ""`, **not** `--allowedTools ""`: the second is a
  permission allowlist and leaves the tool set populated. `claude-goal.ts:119` records the
  measurement behind that distinction. The per-harness equivalents are part of the work.
- No repository is cloned into it. Background work is text in, text out.

Harness-run background work that *does* have a live session container keeps using it, so this
container is the home for work with nowhere else to run — cleanup always, and session naming or
a pull-request description whose session container has gone (req 4). Moving all harness-run
background work into it would delete the credential-borrowing dance in `runNonTurnSpawn`
(`provisionSubAgentSpawnHome` exists only to isolate from the live primary CLI in the same
container), and that is a follow-up, not part of this feature.

## Voice cleanup

`voice/cleanup.ts` loses `pickCleanupProvider` entirely. Cleanup no longer selects a provider;
it asks for the background-work target and runs it (req 5). The three sanity checks in
`isSane` — empty output, more than twice the input length, a "here is the cleaned version"
preamble — stay exactly as they are, because they guard against a model's behaviour and not
against a provider.

Three things must not change (req 6): a failure inserts the raw transcript, the mic button shows
its transient warning, and **nothing is written to the chat transcript**. That last one is why
cleanup cannot reuse `makeNonTurnGenerateText` unmodified — it calls `emitNonTurnFailure`, which
persists a card into chat history. Cleanup needs the resolution and the execution without the
failure card, so the card emission moves out of the shared path and into the two purposes that
want it.

`CLEANUP_TIMEOUT_MS` is 3000 today, which every harness run would exceed. It becomes two values:
the direct-call budget stays near today's, and the harness budget is around 15 seconds. One
timeout cannot serve both without either failing every harness run or leaving a dictation
hanging for 15 seconds on a fast path that should have answered in one.

`POST /api/voice/transcribe` gains no session id. It did not need one before and does not now:
the background-work container is not the session's.

## Measurements behind the numbers

Taken 2026-09-13 in a warm session container, CLI 2.1.260, `--tools ""`, `claude-haiku-4-5`:

| What | Time |
|---|---|
| One-shot, cleanup-shaped prompt | 3097 ms, 3032 ms, 4505 ms |
| One-shot, "Reply with exactly: OK" | 1960 ms, 1928 ms |
| Today's direct API call (`docs/144-voice-input/plan.md:185`) | 400–800 ms |

The gap between the two one-shot rows is roughly the CLI boot, at about 1.2 seconds. Container
start is in neither row — both were measured inside a container that was already up, which is
why persisting the container helps the first dictation after a pause and nothing else.

## Key files

- `src/server/orchestrator/non-turn-model.ts` — `NonTurnTarget` becomes a union; a
  background-work eligibility entry point that does not require a harness.
- `src/server/orchestrator/direct-provider/` — new. One client per API style, plus the shared
  `DirectCall` type.
- `src/server/orchestrator/services/non-turn-work.ts` — dispatch on `target.execution`; move
  `emitNonTurnFailure` out of the shared path.
- `src/server/orchestrator/voice/cleanup.ts` — drop `pickCleanupProvider`; keep `isSane`.
- `src/server/orchestrator/voice/providers/claude-cleanup.ts`, `openai-cleanup.ts` — deleted;
  their request shapes move into the direct clients.
- `src/client/components/Settings/BackgroundWorkSection.tsx` — the derived-harness line states a
  direct call for a key mode.
- `src/client/components/Settings/tabs/VoiceTab.tsx` — the read-only cleanup-provider status
  names the background-work choice, and points at that setting.

## Phases

1. **Stop the violation.** Delete the Claude OAuth cleanup provider, so cleanup falls to the
   OpenAI key path. Shippable on its own and does not wait for the rest.
2. Direct clients for the three styles, with the eligibility widening and the `NonTurnTarget`
   union. Session naming and pull-request descriptions get direct calls first, because they
   already have a container to fall back to if anything is wrong.
3. The background-work container.
4. Voice cleanup onto the background-work target, and the Settings copy in both tabs.
