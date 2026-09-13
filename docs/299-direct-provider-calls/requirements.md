---
issue: planning#542
title: Direct provider calls for background work
description: Background work can run as a direct call to a provider's API, chosen in the selector alongside the harnesses, and voice transcript cleanup runs on that same choice.
---

# 299 — Direct provider calls for background work: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature amends [`docs/252-custom-models`](../252-custom-models/requirements.md) req 9,
which says the harness that runs background work is derived and never chosen. It stays derived
where a harness runs the work; what becomes a choice is whether a harness runs it at all.

## Requirements

1. ShipIt never calls a provider's API directly with a credential that provider issued for one
   of its own client applications. A subscription reached by signing in — an Anthropic
   subscription, a ChatGPT subscription — is usable only by running that vendor's own harness.
   Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) section 3
   permits automated access only under an API key, and ShipIt does not present itself as
   another client to get around that.

2. Background work can run as a **direct call to the provider's API**, with no harness and no
   container. It is an ordinary way to run background work, not a fallback.

3. **The selector presents every option the user's credentials actually support**, and the
   options differ by billing mode:

   - A **subscription** offers that vendor's harness, and nothing else. An Anthropic
     subscription offers Claude Code; a ChatGPT subscription offers Codex.
   - An **API key** offers a direct call to that provider.

   A service the user has configured both ways therefore offers both. A service that only ever
   has a key offers a direct call.

4. A direct call needs no session and no container, so background work that runs this way
   succeeds when no session is open and when a session's container has been reclaimed. Today
   background work fails in both cases
   (`src/server/orchestrator/services/non-turn-work.ts:254`).

5. **Voice transcript cleanup is background work and runs on the background-work choice.**
   There is no separate model setting for cleanup, and cleanup gets no provider selection rule
   of its own.

6. Cleanup keeps the behaviour it has today when it cannot run: the raw transcript is inserted,
   the mic button shows its non-fatal warning, and nothing is written to the chat transcript.
   It does not emit the failure card that other background work emits
   (`emitNonTurnFailure`), because a dictation is not an operation the user is watching.

7. A direct call is metered spend against the user's key, and is reported as such under
   [`docs/252-custom-models`](../252-custom-models/requirements.md) req 16's split by service
   and billing mode.

## Open questions

- When a service is configured with an API key, does the selector **also** offer that service's
  models under a harness, or only the direct call? A harness can run on a key today, so both are
  possible. For background work a harness on a key is slower and adds container failure modes
  for no gain, so the recommendation is to offer only the direct call — but req 3's phrasing came
  from three examples and does not settle it.

- A user whose only credential is a subscription must run background work through a harness,
  which needs a container. Voice cleanup then costs 3 to 4.5 seconds against 0.4 to 0.8 today
  (measured 2026-09-13; see `plan.md` when written). Does cleanup run the harness for those
  users, in a shared cleanup container started on demand, or does cleanup simply not run for
  them and insert the raw transcript?

## Resolved questions

- 2026-09-13 — Which model cleans voice transcripts? **Chosen: the background-work model, with
  no setting of its own.** Stated directly: *"the cleanup should work the same way as the other
  background work"*, and confirmed against the alternatives, which were a cleanup-only picker
  and a background-work choice silently pinned to the cheapest model of that service. The
  accepted consequence is that a user who points background work at an expensive model pays that
  model's price and latency on every dictation. Req 5.

- 2026-09-13 — Should background work be able to call a provider's API directly, instead of
  always running a harness? **Chosen: yes, and the choice is the user's.** *"For background work
  we should also support direct provider calls in the selector. All configured options should be
  presented to the user: i.e. if they have claude with subscription, only 'claude code' would be
  supported. If they have the anthropic api key, also 'direct anthropic call via api key'. Same
  for codex. For others, there is only a key, so always a direct call."* Reqs 2 and 3.

  This resolves a trade the agent had put as a question — whether to accept 3 to 4.5 second
  cleanup for everyone, or keep a fast path for key holders. Making the execution visible in the
  selector answers it without a hidden rule: a key holder can choose the fast direct call, and a
  subscription holder can see why theirs is slower.

- 2026-09-13 — Why is this feature being written at all? **Because the shipped cleanup provider
  breaks req 1.** `src/server/orchestrator/voice/providers/claude-cleanup.ts` posts to
  `https://api.anthropic.com/v1/messages` with the Claude Code subscription OAuth token, and
  sends `system: "You are Claude Code, Anthropic's official CLI for Claude."` — a line that does
  no work for the cleanup task and whose only effect is to present the caller as Claude Code. A
  test pins it (`claude-cleanup.test.ts:31`). Found when the user asked whether that call was
  permitted.

## Requirement provenance

Reqs 2, 3 and 5 are the user's, quoted in the receipts above. Req 1 is the user's concern
("forbidden by tos") stated as a rule. Reqs 4, 6 and 7 are the agent's: req 4 names a benefit
that falls out of reqs 2 and 3, req 6 preserves existing cleanup behaviour, and req 7 applies
docs/252 req 16 to the new case. None of the three was asked for, and each is small enough to
delete if it is wrong.
