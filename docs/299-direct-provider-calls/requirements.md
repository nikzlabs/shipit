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

3. **The selector presents every option the user's credentials actually support.** What decides
   the options is **how the credential was obtained**, which is req 1's distinction:

   - A credential obtained by **signing in to the vendor's own application** is client-bound.
     It offers the harnesses that can carry it, and no direct call. An Anthropic subscription
     offers Claude Code; a ChatGPT subscription offers Codex and OpenCode.
   - A credential the user **pasted or the deployment supplied** offers a direct call.

   A service the user has configured both ways therefore offers both kinds of option. A service
   that only ever has a pasted key offers a direct call.

   A harness can run on a pasted key today, and background work no longer offers that. It is
   slower than a direct call, it needs a container, and it produces the same text — so the row
   would only ever be the worse of two ways to reach the same model. This narrows
   [`docs/252-custom-models`](../252-custom-models/requirements.md) req 8 for background work
   alone: session model selection is unchanged, and a key still reaches every harness there.

   **The rule is not the billing mode.** An earlier draft said a subscription offers its
   vendor's harness and a key offers a direct call. That is wrong on the catalogue ShipIt
   already ships: GLM's coding plan is a `sub` mode whose credential is a pasted string carried
   by **Claude Code**, which is not its vendor's harness
   (`src/server/shared/catalogue/services.ts:290`), and a ChatGPT subscription is carried by
   both Codex and OpenCode (`src/server/shared/catalogue/services.ts:164`). The catalogue says
   so itself: billing mode is "independent of credential delivery"
   (`src/server/shared/catalogue/types.ts:11`). Keying on the billing mode would have removed
   those working routes.

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

   **Background work that belongs to no session is still reported.** A dictation cleaned while
   no session is open spends the user's money, so it appears in usage as install-level spend in
   its own right, rather than being attributed to an unrelated session or dropped from the
   totals. This is the same principle docs/252 req 16 applies to work whose attribution does not
   exist: volume that is real is never silently omitted, and never priced at zero.

8. **Voice cleanup that runs a harness pays no container start.** The first dictation after a
   quiet period costs no container-start delay, and cleanup latency does not depend on which
   sessions happen to be open or on what ShipIt reclaimed while the user was away. Cleanup that
   runs a harness is slower than a direct call — that difference is req 3's visible trade — but
   it does not become slower still because the user paused.

   This is narrower than an earlier draft, which promised equal latency for *all* harness-run
   background work. The receipt below supports a warm cleanup container and nothing wider.

9. **A cleanup run that cannot finish quickly inserts the raw transcript anyway.** There is an
   end-to-end deadline the user can feel, not merely a timeout passed to whatever runs the work.
   A harness that stops answering must not leave the composer waiting.

## Open questions

_None._

## Resolved questions

- 2026-09-13 — How does a dictation's spend appear in usage, when a usage row requires a session
  id (`src/server/shared/database.ts:550`) and a dictation may have no session? **Chosen: make
  the session id nullable and report install-level spend as its own row.** The rejected
  alternatives were attributing the spend to whichever session happened to be active, which is
  cheapest and charges a session for work that was not its turn, and not recording cleanup spend
  at all, which would have made req 7 partly false — real money leaving the user's key and
  appearing in no total. The chosen answer is the most work, touching the schema and the usage
  views, and is the only one that reports every dictation honestly. Req 7 extended.

- 2026-09-13 — Does the billing mode decide whether background work runs a harness or calls the
  API directly? **Chosen: no — the credential's origin decides.** The independent review
  (`shipit agent run --role reviewer`, run `c24cf98a`) produced a counterexample from the shipped
  catalogue: GLM's coding plan is a `sub` mode carried by Claude Code, so "a subscription offers
  its vendor's harness" both names a harness GLM does not own and would have removed a working
  route; a ChatGPT subscription has two carriers for the same reason. Req 3 now keys on whether
  the credential came from signing in to the vendor's own application, which is the distinction
  req 1 was already drawing and which classifies every case the earlier wording got wrong. The
  user's three examples are unchanged by this: an Anthropic subscription is a sign-in, an
  Anthropic API key is pasted, and other services are pasted keys.

  The same review corrected two claims that were wrong rather than incomplete. Req 8 promised
  equal latency for all harness-run background work while its receipt supports only a warm
  cleanup container, and is narrowed. `plan.md` attributed the gap between two one-shot
  measurements to CLI boot; both measurements include boot, so the difference isolates nothing —
  corrected where the numbers are recorded.

- 2026-09-13 — When a service is configured with an API key, does the selector also offer that
  service's models under a harness? **Chosen: no — the direct call only.** The alternative was
  to mirror session model selection, where a key reaches every harness that speaks the service's
  API style. It was rejected because for background work every one of those extra rows is the
  worse of two ways to reach the same model. Req 3 says so, and says explicitly that it narrows
  docs/252 req 8 for background work alone rather than for sessions.

- 2026-09-13 — A user whose background-work choice is a subscription must run a harness, which
  needs a container. What runs cleanup for them? **Chosen: a shared cleanup container that is
  never stopped.** *"Shared cleanup container, but it shouldn't be stopped, to improve
  latency."* The agent had proposed starting it on the first dictation and stopping it when
  dictation stopped, to avoid holding memory; the user chose to hold the memory and remove the 1
  to 2 second container start from the first dictation after a pause. Req 8 states the
  observable half. Two consequences accepted with it: the container is exempt from docs/284's
  idle reclaim, which otherwise takes the longest-idle container first and would take this one
  every time; and it exists on installs whose users never dictate. Rejected alternatives were
  running cleanup only for direct calls, which switches the feature off for most users since
  most are on subscriptions, and borrowing whichever session container happened to be open,
  which makes cleanup work or fail on unrelated state with nothing on screen to explain it.

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
("forbidden by tos") stated as a rule.

Reqs 4, 6, 7 and 9 are the agent's. Req 4 names a benefit that falls out of reqs 2 and 3, req 6
preserves existing cleanup behaviour, req 7 applies docs/252 req 16 to the new case, and req 9
states a deadline the design needs and today's code does not provide. None was asked for. An
earlier version of this section called them "small enough to delete if it is wrong", which the
review rightly rejected: req 7 in particular has no cheap answer, which is why it now carries an
open question rather than a claim.

**Req 8 is the user's instruction narrowed.** What the user asked for was a mechanism — a
cleanup container that is never stopped — and a requirement states what is observable, so the
observable half is written here and the container is in `plan.md`. The first draft widened it to
all harness-run background work, which the receipt does not support; the review caught that and
it is now scoped to cleanup, which is what was actually asked for.
