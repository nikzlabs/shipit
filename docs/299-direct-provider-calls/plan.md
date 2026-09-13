---
issue: planning#542
title: Direct provider calls for background work — design
description: How a credential's origin decides between a harness and a direct API call, the per-style direct clients and their catalogue contract, the always-on background-work container, and the removal of the Claude OAuth cleanup provider.
---

# 299 — Direct provider calls for background work: design

This implements [`requirements.md`](./requirements.md).

An independent review (run `c24cf98a`) rejected the first version of this design. Its central
claim — that the billing mode decides how background work runs — was false on the catalogue
ShipIt already ships. What survived and what changed is recorded below rather than quietly
rewritten, because the wrong rule is an easy one to reach for again.

## What decides how background work runs

**Not the billing mode.** `BillingMode` is "independent of credential delivery" by the
catalogue's own definition (`src/server/shared/catalogue/types.ts:11`), and two shipped services
prove it: GLM's coding plan is a `sub` mode whose credential is a pasted string carried by
Claude Code (`services.ts:290`), and a ChatGPT subscription is carried by both Codex and
OpenCode (`services.ts:164`).

**The credential's `via` decides** (req 3), and it is already in the catalogue:

| Credential | How background work runs |
|---|---|
| `via: "account"` — obtained by signing in to the vendor's own application | The harnesses listed in its `carriers`, derived as today (docs/252 req 9) |
| `via: "string"` — pasted by the user or supplied by the deployment | A direct call, when the catalogue says that credential may be used for one |

The second row needs a new per-credential catalogue field, and it **fails closed**: a string
credential is direct-callable only where the catalogue says so. GLM's coding plan is the case
that forces this. It is a pasted token, so nothing technical stops a direct call, but whether
Z.AI's plan permits use outside a coding client is a question about Z.AI's terms that the
catalogue must answer per service — exactly the question req 1 asks. Until someone reads those
terms, GLM stays harness-only and behaves as it does today.

The user-facing selection is unchanged: still `{ serviceId, billingMode, modelId }`, still two
controls, still one write. Execution is derived from that triple plus the catalogue, so there is
no fourth field. `BackgroundWorkSection.tsx` already renders one derived fact under the controls
("Runs on Claude Code"); it now renders "Direct call to Anthropic" where that is what happens.

`NonTurnTarget` becomes a discriminated union on `execution`, so the compiler names every
consumer of the old always-present `harnessId`.

## Where dispatch goes — above the session gates, not inside the spawn

The first draft put dispatch in `runNonTurnSpawn`. That is unreachable for the case reqs 2 and 4
exist to fix: `makeNonTurnGenerateText` returns the pre-feature fallback when there is no
`sessionId` (`services/non-turn-work.ts:231`) and emits a failure when there is no runner
(`:252`). A direct call needs neither.

So resolution and execution move **above** both gates. The executor takes a target and a prompt
and nothing else; a session id, where one exists, is reporting context passed alongside rather
than a precondition. `runNonTurnSpawn` keeps only what it is for — running a harness in a
container.

## The direct clients, and the contract they need

Three styles are declared (`catalogue/types.ts:6`): `anthropic-messages`,
`openai-chat-completions`, `openai-responses`. Two request shapes already exist as voice
adapters and are the seed for the first two. **Parameterising them is not enough**, and the
review named the two ways a naive port breaks:

- **The catalogue's model id is not always the API's.** Anthropic's row is `haiku`
  (`services.ts:150`), which is a harness alias; the Messages API needs the dated identifier. So
  a model needs an explicit API id in the catalogue, defaulting to the catalogue id where they
  agree, and the direct client must never send the alias.
- **Endpoint bases are heterogeneous.** Anthropic is `https://api.anthropic.com`, OpenAI is
  `https://api.openai.com/v1`, OpenRouter is `.../api/v1`, GLM's chat-completions base is
  `.../api/paas/v4`. Appending a fixed `/v1/chat/completions` produces wrong URLs. The path
  suffix belongs to the style and the base to the service, and the join must be declared rather
  than assumed.

The client interface is therefore:

```ts
type DirectCall = (req: {
  baseUrl: string; apiModelId: string; apiKey: string; prompt: string;
  maxOutputChars: number; signal: AbortSignal;
}) => Promise<{
  text: string;
  inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; cacheCreateTokens?: number;
}>;
```

Cache-read and cache-write counts are separate fields because pricing treats them separately —
`shared/codex-token-usage.ts:22` normalises them for exactly that reason, and folding them into
`inputTokens` produces a wrong spend figure rather than a missing one.

Tests against a fake `fetch` that assert the request shape would pass while sending a harness
alias to a wrong URL. So each style also needs a test that the URL and the model id are built
from real catalogue rows, one per shipped service.

## Selector eligibility reaches further than the resolver

`BackgroundWorkSection` gets its options from `eligibleModelsOf(agentList)`, which skips every
uninstalled harness (`client/components/pickers/model-choice.ts:32`). A server-side resolver
that accepts a key-only service therefore changes nothing the user can see: the row is still
absent. Background work needs its own option list, carried through the same bootstrap and
credential-change paths the current list uses, plus the matching changes to seeding and save
validation in `services/settings.ts`. The union change will not surface this — nothing about it
fails to compile.

## The background-work container

One container per install, holding no repository and no resident harness process. Each request
spawns a one-shot CLI with tools off and exits, so the steady-state cost is the container rather
than a loaded agent.

- **Never stopped** (req 8), and therefore **exempt from docs/284 idle reclaim**, which takes the
  longest-idle container first and would otherwise take this one every time.
- **Tools off is `--tools ""`, not `--allowedTools ""`.** The second is a permission allowlist and
  leaves the tool set populated; `claude-goal.ts:119` records the measurement. Each harness needs
  its own equivalent.
- **All harness-run background work goes here**, not only cleanup. The review asked which parts
  of this design nobody would miss, and answered: the branch between "use the live session's
  container" and "use the shared one". Removing it also removes the credential-borrowing dance in
  `runNonTurnSpawn` — `provisionSubAgentSpawnHome` exists only to isolate background work from a
  live primary CLI **in the same container**, which no longer happens. Per-request credential
  isolation is still needed inside the shared container.
- **`RUNTIME_MODE=local` has no container manager at all** (`app-lifecycle.ts:141` returns
  `containerManager: null`). The dogfood inner instance therefore cannot have this container, and
  harness-run background work there must keep running the way it does today. A design that
  assumes the container exists breaks the loop this repository is developed in.

One thing to verify before moving session naming and pull-request descriptions here: their
prompts must be self-contained. Today they run with `AUTO_TOOLS` and a working directory, so a
prompt that expects the harness to read the tree would break under tools off.

## Bounding a cleanup that does not answer

Req 9 exists because changing a constant does not bound anything. `cleanTranscript` aborts on an
`AbortSignal`, but `spawnSubAgent` exposes no caller signal and enforces its own transport
deadline, which defaults to 35 minutes (`container-session-runner.ts:346`). Passing a shorter
execution timeout to the worker does not help if the worker stops answering.

So the deadline is the orchestrator's: cancel at the deadline, insert the raw transcript, and
tear the spawned process down. `CLEANUP_TIMEOUT_MS` splits into a direct budget near today's
3000 ms and a harness budget of roughly 15 seconds, but those numbers are tuning. The deadline
being enforced where the caller can feel it is the requirement.

## Voice cleanup, and a credential that does not carry over

`voice/cleanup.ts` loses `pickCleanupProvider`; cleanup asks for the background-work target and
runs it (req 5). `isSane` stays exactly as it is — its three checks guard against a model's
behaviour, not a provider's.

**The OpenAI voice key is not a service credential.** It lives in `voiceProviderKeys`
(`credential-store.ts:569`) and is read by `services/voice.ts:126`, while `resolveNonTurnModel`
reads the service credential registry. So an install whose only OpenAI key is the voice one has
working cleanup today and would have none after this change. That transition must be explicit:
either the voice key is offered for adoption as an OpenAI service credential, or the user is told
cleanup is unavailable and why. What it must not do is silently stop working, and it must not
silently write a background-work pin the user did not choose.

Req 6 keeps the rest: a failure inserts the raw transcript, the mic button shows its transient
warning, and nothing reaches the chat transcript. That last point is why cleanup cannot reuse
`makeNonTurnGenerateText` unmodified — it calls `emitNonTurnFailure`, which persists a card. The
card emission moves out of the shared path into the two purposes that want it.

`POST /api/voice/transcribe` gains no session id: the container it uses is not the session's.

## Measurements

Taken 2026-09-13 in a warm session container, CLI 2.1.260, `--tools ""`, `claude-haiku-4-5`:

| What | Time |
|---|---|
| One-shot, cleanup-shaped prompt | 3097 ms, 3032 ms, 4505 ms |
| One-shot, "Reply with exactly: OK" | 1960 ms, 1928 ms |
| Today's direct API call (`docs/144-voice-input/plan.md:185`) | 400–800 ms |

**What these do and do not show.** Both one-shot rows include CLI boot, so their difference
isolates generation, not boot — an earlier version of this file claimed otherwise and was wrong.
The minimal row bounds boot plus a minimal completion at about 1.93 s; boot alone is not measured
here. Container start is in neither row, since both ran in a container that was already up, which
is why persisting the container helps the first dictation after a pause and nothing else.

## Key files

- `src/server/shared/catalogue/` — a per-credential direct-callable flag, and an API model id per
  model where it differs from the catalogue id.
- `src/server/orchestrator/non-turn-model.ts` — `NonTurnTarget` union; background-work eligibility
  that does not require an installed harness.
- `src/server/orchestrator/direct-provider/` — new. One client per API style, plus the shared
  `DirectCall` type and the endpoint join.
- `src/server/orchestrator/services/non-turn-work.ts` — dispatch above the session and runner
  gates; `emitNonTurnFailure` out of the shared path.
- `src/server/orchestrator/services/settings.ts` — seeding and save validation for options with no
  installed harness.
- `src/client/components/pickers/model-choice.ts` — a background-work option list that is not
  filtered by installed harnesses.
- `src/server/orchestrator/voice/cleanup.ts` — drop `pickCleanupProvider`; keep `isSane`.
- `src/server/orchestrator/voice/providers/claude-cleanup.ts`, `openai-cleanup.ts` — deleted;
  their request shapes seed the direct clients.
- `src/client/components/Settings/BackgroundWorkSection.tsx`, `tabs/VoiceTab.tsx` — the derived
  execution line, and the cleanup status that now names the background-work choice.

## Phases

1. **Stop the violation.** Delete the Claude OAuth cleanup provider, so cleanup falls to the
   OpenAI voice key. Shippable on its own and does not wait for the rest.
2. Catalogue contract — the direct-callable flag and API model ids — then the three direct
   clients, the eligibility widening, the selector option list, and the `NonTurnTarget` union.
3. The background-work container, including the `RUNTIME_MODE=local` path that has none.
4. Voice cleanup onto the background-work target, the end-to-end deadline, the voice-key
   transition, and the Settings copy in both tabs.
