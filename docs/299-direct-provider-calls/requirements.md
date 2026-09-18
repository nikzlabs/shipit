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

1. **ShipIt uses a credential only in the ways its provider permits.** A credential a provider
   issued for use inside one of its own client applications is usable only by running one of the
   harnesses the catalogue declares can carry it — never by calling that provider's API directly.
   Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) section 3 permits
   automated access only under an API key, and ShipIt does not present itself as another client
   to get around that.

2. Background work can run as a **direct call to the provider's API**, with no harness and no
   container. It is an ordinary way to run background work, not a fallback.

3. **The selector presents every option the user's credentials actually support**, and it never
   presents one the provider does not permit.

   - Where a credential may be used for a direct call, background work offers that call.
   - Where it may not, background work offers the harnesses the catalogue declares can carry it.

   **Whether a credential may be called directly is a fact about that credential, declared per
   credential, and it fails closed.** It is not derivable from the billing mode and it is not
   derivable from how the credential reached ShipIt. Anthropic's subscription accepts a pasted
   `ANTHROPIC_AUTH_TOKEN` restricted to Claude Code
   (`src/server/shared/catalogue/services.ts:124`), so "pasted" does not mean callable; GLM's
   coding plan is a `sub` mode carried by Claude Code (`services.ts:290`), so `sub` does not mean
   the vendor's own harness; and a ChatGPT subscription is carried by both Codex and OpenCode
   (`services.ts:164`), so a client-bound credential can have several carriers. The catalogue
   states the principle itself: billing mode is "independent of credential delivery"
   (`src/server/shared/catalogue/types.ts:11`).

   Where a credential permits a direct call, background work offers **only** that call, and no
   harness row for the same model. A harness can run on such a credential today, but for
   background work it is slower, needs a container, and reaches the same model — so the row would
   only ever be the worse of two ways to the same place. This narrows
   [`docs/252-custom-models`](../252-custom-models/requirements.md) req 8 for background work
   alone: session model selection is unchanged, and a key still reaches every harness there.

   *Terminology: what the catalogue calls a service is a **model provider** in every surface the
   user reads — the Settings tab, its action, the usage split. New copy uses that word.*

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

7. **Usage reports what was selected, not how it executed.** A run records its service and
   billing mode from the selection, so a direct call against a subscription is still subscription
   usage with an at-API-rates comparison, and a direct call against a key is still metered spend
   — exactly as [`docs/252-custom-models`](../252-custom-models/requirements.md) req 16 requires.
   Running without a harness changes neither. OpenCode Go is the case that makes this concrete: a
   `sub` mode with a pasted key and ordinary API endpoints (`services.ts:474`).

   **Background work stays out of the session's context accounting.** It has its own context
   window and must not be counted as one of the session's turns, whether a harness ran it or not.

   **Background work that belongs to no session is still reported.** A dictation cleaned while
   no session is open spends the user's money, so it appears in usage as install-level spend in
   its own right, rather than being attributed to an unrelated session or dropped from the
   totals — the same principle docs/252 req 16 applies to work whose attribution does not exist.
   It belongs in install-wide reporting, not inside a session's own view, where it is not that
   session's spend.

8. **Voice cleanup that runs a harness pays no container start.** The first dictation after a
   quiet period costs no container-start delay, and cleanup latency does not depend on which
   sessions happen to be open or on what ShipIt reclaimed while the user was away.

9. **A cleanup run that cannot finish quickly inserts the raw transcript anyway.** There is an
   end-to-end deadline the user can feel, not merely a timeout passed to whatever runs the work.
   A harness that stops answering must not leave the composer waiting, and enforcing one
   dictation's deadline must not disturb any other work in flight.

## Open questions

_None._

## Resolved questions

Two of the answers below were given by selecting a named option from a question that stated the
alternatives, rather than in free text. Those say so, and name the option, so the receipt can be
checked rather than taken on trust.

- 2026-09-13 — What decides whether background work may call a provider's API directly?
  **Chosen: an explicit per-credential capability in the catalogue, failing closed.** Two review
  passes each refuted a cheaper rule. The billing mode fails because GLM's coding plan is a `sub`
  mode carried by Claude Code. The credential's delivery — pasted versus signed-in — fails
  because Anthropic's subscription accepts a pasted `ANTHROPIC_AUTH_TOKEN` restricted to Claude
  Code, so a pasted credential can be client-bound. Nothing already in the catalogue answers the
  question, so the catalogue must state it per credential. Z.AI's own documentation restricts the
  coding plan to supported tools, so GLM is harness-only as settled fact rather than pending
  research. Reqs 1 and 3.

- 2026-09-13 — When a credential permits a direct call, does the selector **also** offer that
  provider's models under a harness? **Chosen: no — the direct call only.** Given by selecting the
  option labelled *"Direct call only"* over *"Direct call and the harnesses"*, which was
  described as the more faithful reading of "all configured options should be presented" and
  rejected for adding rows that are strictly worse. This is the one place the feature removes an
  existing route, and it removes it for background work alone. Req 3.

- 2026-09-13 — How does a dictation's spend appear in usage, when a usage row requires a session
  id (`src/server/shared/database.ts:550`) and a dictation may have no session? **Chosen: make
  the session id nullable and report install-level spend as its own row.** Given by selecting the
  option labelled *"Nullable session id"* over attributing the spend to whichever session was
  active — cheapest, but it charges a session for work that was not its turn — and over not
  recording it at all, which would leave real money in no total. The chosen answer is the most
  work and the only honest one. Req 7.

- 2026-09-13 — A user whose background-work choice is a subscription must run a harness, which
  needs a container. What runs cleanup for them? **Chosen: a shared cleanup container that is
  never stopped.** *"Shared cleanup container, but it shouldn't be stopped, to improve
  latency."* The agent had proposed stopping it between bursts to avoid holding memory; the user
  chose to hold the memory and remove the 1 to 2 second container start. Two consequences
  accepted with it: it is exempt from docs/284's idle reclaim, which would otherwise take it
  first every time, and it exists on installs whose users never dictate. Rejected alternatives
  were running cleanup only for direct calls, which switches the feature off for the majority who
  are on subscriptions, and borrowing whichever session container happened to be open, which
  makes cleanup work or fail on unrelated state with nothing on screen to explain it. Req 8.

- 2026-09-13 — Which model cleans voice transcripts? **Chosen: the background-work model, with
  no setting of its own.** *"the cleanup should work the same way as the other background
  work"*, confirmed against a cleanup-only picker and a choice silently pinned to the cheapest
  model of that service. The accepted consequence is that a user who points background work at an
  expensive model pays that model's price and latency on every dictation. Req 5.

- 2026-09-13 — Should background work be able to call a provider's API directly, instead of
  always running a harness? **Chosen: yes, and the choice is the user's.** *"For background work
  we should also support direct provider calls in the selector. All configured options should be
  presented to the user: i.e. if they have claude with subscription, only 'claude code' would be
  supported. If they have the anthropic api key, also 'direct anthropic call via api key'. Same
  for codex. For others, there is only a key, so always a direct call."* Reqs 2 and 3.

  This also resolves a trade the agent had put as a question — whether to accept 3 to 4.5 second
  cleanup for everyone, or keep a fast path for key holders. Making the execution visible in the
  selector answers it without a hidden rule.

- 2026-09-13 — Why is this feature being written at all? **Because the shipped cleanup provider
  breaks req 1.** `src/server/orchestrator/voice/providers/claude-cleanup.ts` posts to
  `https://api.anthropic.com/v1/messages` with the Claude Code subscription OAuth token, and
  sends `system: "You are Claude Code, Anthropic's official CLI for Claude."` — a line that does
  no work for the cleanup task and whose only effect is to present the caller as Claude Code. A
  test pins it (`claude-cleanup.test.ts:31`). Found when the user asked whether that call was
  permitted.

## Requirement provenance

**The user's**, quoted in the receipts: reqs 2 and 5, and req 1 as the rule behind the concern
they raised ("forbidden by tos").

**Req 3 is mixed, and the split matters.** That background work should offer direct calls and
present every configured option is the user's, in their own words. That a credential permitting a
direct call offers *no* harness row — the one place this feature removes a working route — was
not in those words; it was a named option the user then selected. And the deciding rule itself,
the per-credential capability, is the agent's, arrived at only after two reviews refuted the
simpler rules. Anyone re-opening req 3 should re-open those three parts separately.

**Req 8 is the user's instruction narrowed** to what is observable, since what they asked for was
a mechanism. An earlier draft widened it to all harness-run background work, which the receipt
does not support.

**The agent's**: reqs 4, 6, 7 and 9. Req 4 names a benefit falling out of reqs 2 and 3; req 6
preserves existing cleanup behaviour; req 7 applies docs/252 req 16 to the new case and adds the
context-accounting clause, which exists because dropping the harness id from a usage row would
silently make background work count as a session turn; req 9 states a deadline the design needs
and today's code does not provide. None was asked for, and req 7 in particular has no cheap
answer.
