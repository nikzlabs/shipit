---
issue: planning#720
title: Transient provider retry — design
description: How a temporary provider error becomes a delayed continuation turn through the docs/306 continuation manager.
---

# Transient provider retry — design

Implements [requirements.md](requirements.md). Builds on PR #3351, which classifies the
Cloudflare 403 in the OpenCode 2 adapter and keeps it out of `auth_required`; that branch
is merged into this one.

## Classification (req 2, 3, 8)

`src/server/shared/provider-errors.ts` holds both checks:

- `textIndicatesProviderEdgeBlock(text, status?)` — #3351's rule, moved here so both
  harnesses share it: the block page's title, or a 403 beside Cloudflare. A known status
  other than 403 is never a block. With a known 403, HTML alone counts (#3351's
  behaviour for OpenCode 2); without a status, the text must name Cloudflare, so a 403
  HTML sign-in page still reaches auth recovery.
- `transientProviderErrorKind(text)` — `edge-block`, `overloaded` or `server-error`. It
  is anchored at the START of the error text, because a failed Claude result can carry
  the model's prose (`error_max_turns`), and prose that quotes "API Error: 500" must not
  schedule a continuation. It matches Claude Code's `API Error: <status>` lead (also
  after "Failed to authenticate."), the OpenCode 2 block-page notice from #3351, an
  Anthropic error body on its own, or OpenCode 2's bare message ("Overloaded",
  "Bad Gateway", …). A 401, a JSON 403 and a 400 are not matches.

Claude Code (`session/agents/claude/process.ts`): the CLI codes a 403
`authentication_failed` and words it "Failed to authenticate", so the result and the
api-error assistant message used to be swallowed as an auth failure and the turn went
to `recoverAuth`. `textIndicatesAuthFailure`, `assistantEventIndicatesAuthFailure` and the
streaming stderr check now skip an edge block, so the error reaches the turn as an
errored result. This holds whether the setting is on or off.

OpenCode 2 (`session/agents/opencode2/adapter.ts`, from #3351): `isProviderEdgeBlock`
now calls the shared helper. Its result carries #3351's notice, which classifies as
`edge-block`. An error event with a 5xx status gets the result text
`API Error: <status> <message>`, because the stream keeps only the message and a
provider's 5xx message can be anything ("upstream connect error"). A 5xx is never
read as an auth failure.

## The continuation (req 4, 5, 6, 7)

The docs/306 `QuotaContinuationManager` already does what a delayed continuation needs:
a persisted per-session resume entry (`sessions.quota_resume`) with a `notBefore`, a
sweep that wakes the session with a continuation prompt through `wakeSessionWithTurn`
(refused, never queued, when the session is busy; skipped while `agentBusy`, so the
failed turn's commit and post-turn lease finish first), and the rule that any newer
turn — a user message — supersedes the entry (`lastUsedAt`). So the transient retry is
a new `cause: "transient"` on that entry rather than a new subsystem.

- **Executor** (`turn-executor.ts`): on an errored result, and on the adapter-error path,
  `noteTransientProviderError` classifies the error text and calls
  `deps.recordTransientProviderError` once per turn. Skipped for a stopped turn, a
  compaction, a turn that raised `auth_required`, a turn no longer current, or when a
  message is already queued (it continues the session anyway). It re-dispatches
  nothing and calls nothing on the auth side.
- **Manager** (`services/quota-continuation.ts`): `recordTransientProviderError` reads
  the setting, works out which attempt this is, writes the entry with
  `notBefore = now + TRANSIENT_RETRY_DELAYS_MS[n-1]` and `transientRetry: n`, arms one
  `setTimeout` at that deadline (the 60 s sweep is the restart fallback), and posts an
  info notice. Past the third attempt it posts a warn notice and records nothing.
- **Counting across the chain**: the wake gives its turn the delivery id
  `transient-provider-retry:<n>:<uuid>`, the pattern `stopped-background-jobs` uses. When
  that turn fails again, the executor reports its delivery id and the next attempt is
  `n + 1`; any other turn counts from 1. The worker keeps the delivery id with the
  process, so the count survives an orchestrator restart. A continuation that every
  credential refuses for quota keeps its `transientRetry` through the docs/306 quota
  wait, so the cap still holds.
- **The dispatched no-result retry** (`dispatched-turn.ts` `onNoResultExit`) is left as
  it is: it sends the prompt again only when the attempt produced no work at all, so no
  tool call ran. With partial work it raises an adapter error whose text starts with
  ShipIt's own summary, so the executor also classifies each stderr line as it arrives.
  When the error text itself does not classify, it uses the LAST stderr line, and only
  if it is a provider error and no agent event came after it — an earlier 503 the CLI
  recovered from does not count.
- **Prompt**: `prompts/transient-error-continuation-wake.md` starts with
  `[ShipIt] The last model call failed with a temporary provider error` and tells the
  agent not to repeat tool calls that already ran.
- **Cancellation**: a user message changes `lastUsedAt`, which drops the entry. Stop
  (`services/agent-interrupt.ts`) calls `cancelTransientRetry`; a stopped turn records
  nothing, so Stop during an automatic attempt ends the chain. Turning the setting off
  drops a waiting entry at the next sweep.

## Showing and cancelling a waiting continuation (reqs 9–11)

No turn runs while a continuation waits, so the chat's Stop button is not there.

- **State**: `SessionInfo.transientRetryAt` (`shared/types/domain-types/session.ts`) is
  derived in `SessionManager.listRowFromRow` from `quota_resume` — a `transient` entry's
  `notBefore`, and only while the entry's `lastUsedAt` still equals the row's, the same
  supersession rule the sweep applies, so a newer turn hides it at once. It is never
  stored on its own.
- **Push**: every manager write of the entry goes through `setResume`, which calls
  `onTransientRetryChanged` when the old or new entry is `transient`; bootstrap wires
  that to a `session_transient_retry` SSE event carrying the session's derived value.
  The client keeps it in a per-session map (`transientRetries`) that overrides the row,
  so neither a list fetch that started earlier nor a cached run-history row can bring
  back a wait that ended. The row still gives the value at page load, and each
  `session_list` drops the map entries of the sessions it carries — it comes later on
  the same stream, so those rows are current. On an SSE reconnect with entries in the
  map, the client clears it and reads All sessions again, so a session past the
  sidebar's cap is current too after a missed event. A turn's start
  already broadcasts the list.
- **Control**: `client/components/TransientRetryNotice.tsx`, a sibling of
  `MessageInput` in `App.tsx` with `RepoTrustNotice`'s card treatment, shows "ShipIt
  will ask the agent to continue in N s" with a **Cancel** button, and hides while a
  turn runs. It reads the displayed (URL) session's row through App's `bannerSession`
  (sidebar list, else All sessions), and renders only once the store's session agrees
  with the URL, so a switch never shows another session's wait. After Cancel answers,
  the client clears the session's entry itself rather than wait for the event. Placed by the input rather than on the transcript notice, because a
  notice is a persisted row that outlives the wait and would need the same live state
  to know whether its button still applies.
- **Cancel**: `POST /api/sessions/:id/agent/transient-retry/cancel`
  (`api-routes-agent.ts`) calls `cancelTransientRetry` by session id, so it needs no
  runner or container (req 10). Browser-only: not `containerAccessible`.

## Setting (req 1)

`advanced.retryTransientProviderErrors` in `shared/settings-catalogue/global-settings.ts`
(bool, default false, credential-store field), with
`CredentialStore.getRetryTransientProviderErrors()` and the bootstrap default in
`services/misc.ts`. The dialog renders it from the catalogue.

## Rejected

- **Re-dispatching from the executor the way `recoverAuth` does.** That re-sends the
  original prompt (its tool calls would run twice), and a 30 s–5 min wait inside a
  turn's terminal sequence would hold the post-turn lease and the queue.
- **A new manager with its own table and timer loop.** The docs/306 entry already has
  persistence, supersession and the busy checks this needs.
- **A max-attempts setting.** See the resolved question in requirements.md.

## Key files

- `src/server/shared/provider-errors.ts`
- `src/server/session/agents/claude/process.ts`
- `src/server/session/agents/opencode2/adapter.ts`
- `src/server/orchestrator/turn-executor.ts`
- `src/server/orchestrator/services/quota-continuation.ts`
- `src/server/orchestrator/services/agent-interrupt.ts`
- `src/server/orchestrator/prompts/transient-error-continuation-wake.md`
- `src/server/orchestrator/api-routes-agent.ts` (the cancel route)
- `src/client/components/TransientRetryNotice.tsx`
