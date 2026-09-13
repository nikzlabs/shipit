---
issue: planning#542
title: Direct provider calls for background work — design
description: How a per-credential catalogue capability decides between a harness and a direct API call, the per-style direct clients and their request contract, the always-on cleanup container, and the removal of the Claude OAuth cleanup provider.
---

# 299 — Direct provider calls for background work: design

This implements [`requirements.md`](./requirements.md).

Two independent reviews each refuted a simpler version of the central rule. The receipts in
`requirements.md` record what was tried; this file states only what survived.

## What decides how background work runs

**A per-credential capability, declared in the catalogue, failing closed.** Nothing already in
the catalogue answers the question:

- Not the **billing mode** — GLM's coding plan is a `sub` mode carried by Claude Code
  (`catalogue/services.ts:290`), and `BillingMode` is documented as "independent of credential
  delivery" (`catalogue/types.ts:11`).
- Not the credential's **`via`** — Anthropic's subscription accepts a pasted
  `ANTHROPIC_AUTH_TOKEN` restricted to Claude Code (`services.ts:124`), and deployment-supplied
  OAuth tokens enter eligibility as strings (`service-routing.ts:95`). A pasted credential can be
  client-bound.

So each credential declaration gains a field saying whether it may be used for a direct call, and
absent means no. As built, `via: "string"` is a **necessary** condition on top of the declaration
rather than a substitute for it: every login integration is a credential the vendor issued for its
own client application, so an `account` credential may never declare the capability, while a
pasted one still declares it explicitly or does without. `resolveDirectCall`
(`shared/catalogue/index.ts`) is the single answer; `credentialPermitsDirectCall` says only what
the terms allow, which is not the same question as what a shipped client can send. Authoring it is per-service research into that vendor's terms — the same kind of
work as authoring a price. Two are already settled: Anthropic's API key may, and Z.AI's coding
plan may not, because Z.AI's own documentation restricts it to supported tools.

The user-facing selection is unchanged: still `{ serviceId, billingMode, modelId }`, still two
controls, still one write. Execution is derived from that triple plus the catalogue, so there is
no fourth field. `BackgroundWorkSection.tsx` already renders one derived fact under the controls
("Runs on Claude Code"); it now renders "Called directly" where that is what happens. The exact
copy is settled in the UI section below.

`NonTurnTarget` becomes a discriminated union on `execution`, so the compiler names every
consumer of the old always-present `harnessId`.

## Two callers, not one

`makeNonTurnGenerateText` is the pull-request path. **Session naming does not go through it**: it
calls `generateSessionName` (`services/graduate-session.ts:234`), which runs a CLI directly from
the orchestrator with `execFile` and `cwd: "/tmp"` (`session-namer.ts:443`). Both need the new
executor, and neither can reach it by a change in the other.

For the pull-request path, resolution and execution move **above** two existing gates:
`makeNonTurnGenerateText` returns the pre-feature fallback when there is no `sessionId`
(`services/non-turn-work.ts:231`) and fails when there is no runner (`:252`). A direct call needs
neither. A session id, where one exists, is reporting context passed alongside rather than a
precondition.

For naming, the integration is to extract its prompt construction and result parsing from its CLI
invocation, run the selected executor, and keep its existing failure, usage and
branch-finalisation behaviour. Its `/tmp` working directory is not a session container, so naming
already does not depend on one.

Both prompts were checked: naming and both pull-request-description prompts supply their own
inputs and none instructs the model to read the repository, so tools-off execution is safe for
them.

## The direct clients, and the contract they need

Three styles are declared (`catalogue/types.ts:6`): `anthropic-messages`,
`openai-chat-completions`, `openai-responses`. Two request shapes exist as voice adapters and seed
the first two. **Parameterising them is not enough**, in three ways:

- **The catalogue's model id is not always the API's.** Anthropic's row is `haiku`
  (`services.ts:150`), a harness alias; the Messages API needs the dated identifier. A model needs
  an explicit API id, defaulting to the catalogue id where they agree.
- **Endpoint bases are heterogeneous.** `https://api.anthropic.com`, `https://api.openai.com/v1`,
  OpenRouter's `/api/v1`, GLM's `/api/paas/v4`. The base belongs to the service and the path
  suffix to the style, and the join must be declared rather than assumed.
- **Some services require specific request metadata.** OpenCode Go answers `403 error code: 1010`
  to a generic user agent and `400 MissingSessionID` without an `x-opencode-session` header
  (`docs/252-custom-models/pair-verification.md:487`). A generic adapter fails there even with a
  correct URL and model. Either the credential is declared not directly callable, or the
  catalogue carries its required headers.

```ts
type DirectCall = (req: {
  baseUrl: string; apiModelId: string; apiKey: string; headers?: Record<string, string>;
  prompt: string; maxOutputChars: number; signal: AbortSignal;
}) => Promise<{
  text: string;
  inputTokens?: number; outputTokens?: number;
  cacheReadTokens?: number; cacheCreateTokens?: number;
}>;
```

Cache-read and cache-write counts are separate because pricing treats them separately
(`shared/codex-token-usage.ts:22`); folding them into `inputTokens` gives a wrong spend figure
rather than a missing one. The same hazard runs the other way at the wire, and as built the
clients normalise for it: both OpenAI styles report an input total that already **includes** the
cached portion, so passing it through beside the cache counts prices cached tokens at the uncached
rate.

A fake-`fetch` test that asserts the request shape would pass while sending a harness alias to a
wrong URL without a required header. So each style also needs a test built from **real catalogue
rows**, one per shipped service that declares a direct call.

## Usage

Three separate things, and only the first is about the session id.

**Install-level spend.** `usage_turns.session_id` is `TEXT NOT NULL` (`shared/database.ts:550`)
and `recordNonTurnUsage` requires both a session id and a harness id
(`services/non-turn-work.ts:73`). Neither holds for a dictation cleaned with no session open. The
column becomes nullable, and null means install-level spend (req 7). Those rows belong to
install-wide reporting; a session's own view must not show them, since they are not that
session's spend. Every read path that groups by session must skip a null cleanly rather than
crash on one.

**The background-work marker must survive losing the harness id.** Today `recordNonTurnUsage`
writes `subAgentId: harnessId` (`services/non-turn-work.ts:121`), and `getPerTurnUsage` excludes
background work from the session's context dial **solely** through that field —
`if (r.sub_agent_id !== null) continue` (`usage.ts:309`). The client then reads the last remaining
row for the composer's context and model (`client/utils/session-data.ts:471`). So a direct
pull-request call that carries a session id and no harness id would be counted as a primary turn,
and the composer would report the background model's context occupancy. The classification must
therefore be explicit and independent of whether a harness exists.

**Billing mode comes from the selection, not the execution.** OpenCode Go is a `sub` mode with a
pasted key and ordinary API endpoints (`services.ts:474`), so a direct call there is subscription
usage with an at-API-rates comparison, not money spent. `turn-attribution.ts:52` already keeps
that distinction; the union must not lose it by treating "direct" as "metered".

## Selector eligibility reaches further than the resolver

`BackgroundWorkSection` gets its options from `eligibleModelsOf(agentList)`, which skips every
uninstalled harness (`client/components/pickers/model-choice.ts:32`). A server-side resolver that
accepts a key-only service therefore changes nothing the user can see. Background work needs its
own option list, carried through the same bootstrap and credential-change paths, plus matching
changes to seeding and save validation in `services/settings.ts`. The union change will not
surface this — nothing about it fails to compile.

## UI changes

Prototyped in [`mockup.html`](./mockup.html), which draws today's state beside the new one for
each surface. Four surfaces, and one of them changes by *not* changing.

**Terminology.** What this document calls a *service* — the catalogue concept, `serviceId`,
`ServicesPanel` — is called a **model provider** everywhere the user can read it: the Settings tab
is "Model providers" (`Settings.tsx:93`), its action is "Add a model provider"
(`ServicesPanel.tsx:367`), the usage split heads "by provider" and its unattributed row says "No
provider recorded" (`UsageModal.tsx:374`). New copy uses the user-facing term; new code keeps the
existing identifiers.

**Background work (`BackgroundWorkSection.tsx`).** One line and two picker contents. The derived
line beneath the controls already carries the fact the controls cannot state, so it now reads
"Called directly · no harness, no container" where that is what happens. The wording deliberately
avoids "Direct call to Anthropic": the provider is named by the control beside it, and what the
user needs from this line is the consequence, not a repetition. The pickers gain providers whose
credential permits a direct call with no harness installed, and lose the harness rows for a model
already reachable directly (req 3).

**Voice cleanup status (`VoiceTab.tsx`).** Today the line names a provider ShipIt picked —
"Cleanup via your Claude subscription" — which describes a decision the user can neither see nor
change. It now names their own choice and links to it, and says plainly when cleanup will take a
few seconds, so a pause does not read as a fault. A dictation is the one place in ShipIt where
several seconds of silence is indistinguishable from a bug.

**The voice-key adoption notice** is the migration in visible form: an offer to add the existing
OpenAI voice key as a model-provider credential, with declining leaving cleanup unavailable and
saying so. It exists because the alternative — silently writing a background-work choice on the user's
behalf — would decide something req 9 of docs/252 reserves for them.

**Usage (`UsageModal.tsx`).** One new group row for background work belonging to no session,
install-wide only. It is deliberately *not* the existing unattributed group, which holds volume
whose provider and billing mode are unknown; this row knows both.

**The composer's context dial does not change**, and the mockup records that state on purpose.
It is what a regression would look like if the background-work classification were lost: the dial
would report the background model and its occupancy instead of the session's own.

## The cleanup container

One container per install, holding no repository and no resident harness process. Each request
spawns a one-shot CLI with tools off and exits, so the steady-state cost is the container rather
than a loaded agent.

- **Never stopped** (req 8), and therefore **exempt from docs/284 idle reclaim**, which takes the
  longest-idle container first and would otherwise take this one every time.
- **Tools off is `--tools ""`, not `--allowedTools ""`.** The second is a permission allowlist and
  leaves the tool set populated; `claude-goal.ts:119` records the measurement. Each harness needs
  its own equivalent.
- **Cleanup only.** An earlier draft moved *all* harness-run background work here, on the first
  review's advice that the branch between the session container and this one served no
  requirement. The second review refuted the premise: `provisionSubAgentSpawnHome` is not merely
  isolation from a co-resident primary CLI — it creates OpenCode's private ChatGPT credential
  projection and records credential provenance (`session-agent-credentials.ts:367`), and its
  release publishes refreshed tokens and keeps the home when deleting it would lose the only
  rotated token (`:397`). Those guarantees have no replacement in this design, and no requirement
  asks for the move. Session naming and pull-request descriptions stay where they are.
- Concurrent cleanup requests inside the container still need isolated homes, so the existing
  machinery is reused here rather than reimplemented.
- **`RUNTIME_MODE=local` has no container manager** (`app-lifecycle.ts:141` returns
  `containerManager: null`). There is no existing session-independent harness path to fall back
  to either — local cleanup today uses the direct voice adapters. So in local mode a
  harness-execution choice runs the CLI from the orchestrator the way `session-namer.ts` already
  does, which is the only session-independent harness invocation ShipIt has.

## Bounding a cleanup that does not answer

Req 9 exists because changing a constant bounds nothing. `cleanTranscript` aborts on an
`AbortSignal`, but `spawnSubAgent` exposes no caller signal and enforces its own transport
deadline defaulting to 35 minutes (`container-session-runner.ts:346`), and aborting `workerPost`
does not cancel the worker's spawn — `/agent/spawn` awaits its own handle
(`session/agent-controller.ts:182`).

Two separable things follow. **Returning the raw transcript** is the orchestrator's own deadline
and must not wait for anything downstream. **Cancelling the run** is a new worker operation
addressed by spawn id; the existing `/agent/kill` targets the primary agent and is not it. Killing
the container to enforce one dictation's deadline is not available, because it would interrupt
every other request in flight (req 9).

`CLEANUP_TIMEOUT_MS` splits into a direct budget near today's 3000 ms and a harness budget of
roughly 15 seconds, but those numbers are tuning; the enforced deadline is the requirement.

## Voice cleanup, and the key that does not carry over

`voice/cleanup.ts` loses `pickCleanupProvider`; cleanup asks for the background-work target and
runs it (req 5). `isSane` stays as it is — its three checks guard against a model's behaviour, not
a provider's.

**The OpenAI voice key is not a service credential.** It lives in `voiceProviderKeys`
(`credential-store.ts:569`) and is read by `services/voice.ts:126`, while the background-work
target comes from the service credential registry. An install whose only OpenAI key is the voice
one has working cleanup today and would have none after this change, which the requirements'
preservation preamble does not allow.

So the key is **adopted** as an ordinary OpenAI model-provider credential, following the precedent
docs/252 req 20 already set for deployment-supplied environment credentials: visible, renameable,
removable, and taking part in the same ordering rules. Background work then seeds onto it only if
nothing is set, matching `seedNonTurnModel`'s existing narrow rule, so adoption can never
overwrite a choice the user made.

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
isolates generation, not boot. The minimal row bounds boot plus a minimal completion at about
1.93 s; boot alone is not measured. Container start is in neither row, since both ran in a
container already up — which is why persisting the container helps the first dictation after a
pause and nothing else. All of it is one harness on one model, so it bounds nothing about Codex,
OpenCode or Grok.

## Key files

- `src/server/shared/catalogue/` — a per-credential direct-call capability, an API model id where
  it differs from the catalogue id, the endpoint join, and any required request headers.
- `src/server/orchestrator/non-turn-model.ts` — `NonTurnTarget` union; background-work eligibility
  that does not require an installed harness.
- `src/server/orchestrator/direct-provider/` — new. One client per API style plus the shared type.
- `src/server/orchestrator/services/non-turn-work.ts` — dispatch above the session and runner
  gates; an explicit background-work classification for usage; `emitNonTurnFailure` out of the
  shared path.
- `src/server/orchestrator/session-namer.ts`, `services/graduate-session.ts` — naming's own path
  onto the same executor.
- `src/server/orchestrator/usage.ts`, `src/server/shared/database.ts` — nullable session id and
  the context-dial exclusion that must not depend on a harness id.
- `src/server/orchestrator/services/settings.ts`, `src/client/components/pickers/model-choice.ts`
  — background-work options not filtered by installed harnesses.
- `src/server/orchestrator/voice/cleanup.ts` — drop `pickCleanupProvider`; keep `isSane`.
- `src/server/orchestrator/voice/providers/claude-cleanup.ts`, `openai-cleanup.ts` — deleted;
  their request shapes seed the direct clients.
- `src/client/components/Settings/BackgroundWorkSection.tsx`, `tabs/VoiceTab.tsx` — the derived
  execution line, and the cleanup status naming the background-work choice.

## Phases

1. **Stop the violation.** Delete the Claude OAuth cleanup provider, so cleanup falls to the
   OpenAI voice key. Shippable on its own and does not wait for the rest.
2. Catalogue contract — the direct-call capability, API model ids, endpoint joins, request headers
   — then the three direct clients, the `NonTurnTarget` union, the usage changes, the eligibility
   widening and the selector option list.
3. Both callers onto the executor: the pull-request path above its gates, and session naming.
4. The cleanup container, the end-to-end deadline and spawn-id cancellation, the voice-key
   adoption, and the Settings copy in both tabs.
