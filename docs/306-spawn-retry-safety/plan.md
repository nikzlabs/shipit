---
issue: planning#570
title: Spawn retry safety — design
description: Why a lost spawn response looks identical to a failed one, the deterministic key that makes the retry safe, and which sibling commands share the flaw.
---

# Spawn retry safety — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`. Remaining work: [`checklist.md`](./checklist.md).

## The failure, traced

`shipit session create` reaches the orchestrator through two hops, and the
ambiguity is created at the second one.

1. The shim posts to the **session worker** — `callBroker` in
   `src/server/session/agent-shim/shim-common.ts:157`, against
   `/agent-ops/session/create`.
2. The worker relays to the **orchestrator** — `relay` in
   `src/server/session/agent-ops-routes.ts:48`, which calls
   `OrchestratorClient.request`.
3. On a thrown fetch, `src/server/session/orchestrator-client.ts:81-89` returns
   a synthetic `{ ok: false, status: 0 }` carrying "Could not reach
   orchestrator". `relay` maps `status: 0` to **502**
   (`agent-ops-routes.ts:61`).
4. The shim treats any non-2xx as fatal
   (`src/server/session/agent-shim/shipit-session.ts:147-150`) and exits 1.

Step 3 is where the information is lost. A request that never arrived and a
request that arrived, spawned a session, and lost its response both become the
same 502. Observed live: two `shipit session create` calls reported
"Could not reach orchestrator (http://shipit:4123: fetch failed)", both sessions
had in fact been created, and retrying produced two duplicate children that had
to be stopped mid-turn and archived.

**A second, narrower duplicate source sits in the same file.**
`OrchestratorClient.request` loops over `resolveOrchestratorBaseUrls()` — the
configured host plus the `shipit` Compose alias — and on a thrown request it
*continues to the next base URL* (`orchestrator-client.ts:70-80`). For a
non-idempotent POST that is a blind retry: if the first host processed the
spawn and only the response was lost, the second host spawns again, inside one
invocation. It did not fire in the observed incident, where both names deduped
to one entry and the error listed a single failure — but it is live whenever
`SHIPIT_HOST` is not `shipit`.

## The fix, in two halves

Neither half alone is enough, and the reason is worth stating: the key (req 2)
makes a retry safe *while the orchestrator keeps running*, and the honest
message (req 3) is what covers the case where it does not.

### A derived idempotency key (req 2, req 4)

The shim computes a key from the request itself — the title, the prompt, and
the resolved target flags — and sends it with the create. The orchestrator
keeps a map of key → outcome for **10 minutes** and returns the first result on
a repeat instead of spawning again.

Derived, not caller-supplied, and that is the load-bearing part. The retry of a
failed `shipit session create` is a **new process** with no memory of the
previous invocation, so any key it generates itself would be fresh and would
dedupe nothing. Deriving it from content is what makes the same command carry
the same key without the caller holding state (`requirements.md`, resolved
2026-09-14).

The claim is registered **synchronously, before the spawn is awaited**, and
holds a promise rather than a result — two concurrent requests with one key
must not both pass a check-then-act gap. A failed spawn drops its entry, so a
retry after a genuine error is a real retry and not a replayed failure.

Ten minutes is what keeps req 4 intact. Two deliberate identical spawns further
apart both succeed; inside the window they collapse, and varying the title is
the escape.

### An honest failure (req 1, req 3)

On a transient status the shim no longer fails flat. It:

1. **Retries the create once**, with the same key. If the first attempt landed,
   the key returns that session; if it never landed, this one spawns it. Either
   way the common case ends in success rather than in a question.
2. If that also fails, says the session **may** have been created and names
   where to check — `shipit session list`, or the sidebar for a `--detached`
   spawn, which is not a child and appears in no children list.

**There is deliberately no "look for the session by title" step**, and the
reason is worth recording because it looks like an obvious third step. The
children list is served by the same orchestrator that just failed to answer
twice. If it is reachable, step 1 already succeeded; if it is not, the lookup
fails too. It would add a mechanism that cannot fire in the case it was written
for, and a title match is not proof of identity in any case — an older
same-titled child would be reported as the new one.

A `deduplicated` flag comes back when the key collapsed a retry, and the shim
says so on stderr: the caller is told its first attempt *did* reach ShipIt and
that this is the same session rather than a second one.

`isTransientStatus` (`shim-common.ts:152`) already classifies exactly this set
(0, 502, 503, 504) and is already used for the same purpose by
`shipit session wait` (`shipit-session.ts:651`). This reuses it rather than
adding a second classification.

## The sibling commands (req 5)

Every non-GET shim command inherits the same synthetic-502 ambiguity, because
they all pass through `relay`. What differs is what a retry costs.

**Worth fixing — a retry produces a visible duplicate:**

| Command | Endpoint | Cost of a retry |
|---|---|---|
| `shipit session create` | `/agent-ops/session/create` | A duplicate child session, container and branch. **Fixed here.** |
| `shipit agent run` | `/agent-ops/agent/spawn` | A second consult: real money, and a second inline card. Worst cost on the list. |
| `shipit session message` | `/agent-ops/session/message/:id` | Another turn in the child. `sendChildMessage` dispatches with `deliveryId: undefined` (`services/child-sessions.ts:637`), so nothing downstream can tell the two apart — it repeats the work and spends the quota twice. |
| `shipit session report` | `/agent-ops/session/report` | A duplicate card in the parent *and* a duplicate queued turn — it costs the parent a turn each time. |
| `shipit issue create` | `/agent-ops/issue/create` | A duplicate issue in the tracker, visible to everyone. |
| `shipit issue comment` | `/agent-ops/issue/comment` | A duplicate comment. |
| `gh pr comment` | `/agent-ops/pr/:num/comment` | A duplicate comment on the pull request. |
| `shipit settings propose` | `/agent-ops/settings/propose` | A duplicate proposal card for the user to resolve. |
| `shipit issue label create` | `/agent-ops/issue/label/create` | A second create against a name that now exists — a refusal rather than a duplicate on most trackers, but it depends on the backend. |
| `shipit plugin exec` | `/agent-ops/plugin/exec` | Whatever the plugin's command does, again. Unknowable from here, which is its own argument for a key. |

**Not worth fixing — the second call is a no-op, a refusal, or sets the same
value:**

`gh pr create` already returns the existing pull request and flags it with
`alreadyExisted` (`gh.ts:290`). `gh pr merge` fails as already merged.
`shipit session notify-on-merge` returns `alreadyArmed` rather than arming twice
(`services/child-sessions.ts:674`). `gh pr edit`, `shipit issue edit`,
`shipit issue status`, `shipit issue assign`, `shipit issue comment edit`,
`shipit issue label edit` and `shipit session rename` all set a value rather
than append one. `shipit service start`/`stop` set a state, and
`shipit plugin refresh` re-reads one. `shipit session archive` refuses a session
that is already archived. `shipit branch reset-to-base` and
`shipit session continue-after-rebase` re-check their own preconditions.
`shipit release plan` computes without writing, and `shipit release prepare`
updates the existing release PR rather than opening a second.

`gh run rerun` and `gh pr ready|close|reopen` sit between the two: a duplicate
CI run costs compute, and a state toggle re-applied is harmless but noisy on the
card. Both converge on their own.

**Deliberately out of scope.** Only the create is fixed here. Fixing the other
six means either a per-endpoint key or a general one in `relay`, and a general
mechanism designed off one incident is the thing this repo's workflow notes warn
against. The list above is what a follow-up would work from.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/spawn-idempotency.ts` | New — the keyed claim map, TTL, and register-before-await |
| `src/server/orchestrator/api-routes-session-spawn.ts` | Accepts `idempotencyKey` and routes the spawn through the claim |
| `src/server/session/agent-shim/shipit-session.ts` | Derives the key, retries once on a transient status, reports honestly |
