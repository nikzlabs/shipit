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
3. On a failed request, `src/server/session/orchestrator-client.ts` returns
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

**A second, narrower duplicate source sat in the same file.**
`OrchestratorClient.request` loops over `resolveOrchestratorBaseUrls()` — the
configured host plus the `shipit` Compose alias — and on a thrown request it
*continued to the next base URL*, whatever the failure was. For a
non-idempotent POST that was a blind retry: if the first host processed the
spawn and only the response was lost, the second host spawned again, inside one
invocation. It did not fire in the observed incident, where both names deduped
to one entry and the error listed a single failure — but it was live whenever
`SHIPIT_HOST` was not `shipit`. It is closed by
[the rule below](#no-second-send-after-the-request-left-req-6).

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
retry after a genuine error is a real retry and not a replayed failure. That is
safe only because a failed spawn leaves no session: `spawnChildSession` removes a
child it created before it rethrows (verified at `services/child-sessions.ts`;
docs/243-agent-messaging-trust-gate `plan.md`, "Spawned sessions"). Before that
rule, a spawn that failed after the claim left a child and dropped the key, so
each retry made another.

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

### No second send after the request left (req 6)

The loop over the host names exists for one case: `SHIPIT_HOST` goes stale when
ShipIt's container is recreated, and the next name still reaches it
(docs/319-api-reach-through-host, planning#626). In that case the request never
left the worker. So the rule is: **a request that is not a read goes to the next
host only while it cannot have arrived.** After the connection is made, a
failure ends the call with a message that says the request may have been
carried out, and that it was not sent again. A `GET` keeps the old behaviour and
goes to the next host after any failure, because a read does no harm twice.

**The signal is the socket's `connect` event.** Measured on Node 24 against
local servers, for a `POST`:

| The first host | `connect` fired | The request's `finish` fired |
|---|---|---|
| refuses the connection | no | no |
| has a name that does not resolve | no | no |
| closes at once, reads nothing | yes | yes |
| reads the request, then closes | yes | yes |
| closes in the middle of its answer | yes | yes |
| never reads an 8 MB body, then closes | yes | no |

`finish` is not the signal: it is true for a host that read nothing, and false
for a host that already has part of the request. `connect` is the last moment at
which the worker knows that nothing was sent.

Two things follow from that choice.

- **Each call has a connection of its own** (`agent: false`). Node's default
  agent keeps connections open and uses them again, and a connection that was
  used before has no `connect` event: a failure on it could be before or after
  the request arrived. A new connection costs about 0.2 ms more than a kept one
  on loopback, which is less than the pooled `fetch` path took.
- **Every call goes over Node `http`; the `fetch` path is gone.** `fetch` shows
  only an error code, and the code is not enough: a name that does not resolve
  was `EAI_AGAIN` in a session container, not the `ENOTFOUND` that a list from
  memory would hold, and a time limit that ends gives no code at all. `fetch`
  also read an answer that was cut off as a success with an empty body. Two
  limits take the place of the ones `fetch` had, with the same numbers and not
  exactly the same meaning. A host gets 10 s to take the TCP connection, now
  also in a call with `timeoutMs: 0`. An attempt that names no limit gets 300 s
  from its start to the end of the answer; `fetch` counted 300 s to the headers
  and 300 s between parts of the body, which is the same thing for a relay
  because none answers in parts. Both limits are for one attempt, as before, so
  a call with two hosts can take twice as long.

A time limit that ends is classified in the same way as any other failure:
before the connection, the next host; after it, no second send.

**What this does not do.** It stops the second send inside one call of the
client, which is one request of a command. It does not make a second *run* of
the command safe: an agent that runs `shipit issue create` again after "may
have carried it out" still makes a second issue. That is the table below.

`shipit session create` is the only command that sends its request again by
design, under its key (the exception in req 6). The new failure is a transient
status for it like any other, so its one retry still resolves a lost answer.
One case moved: an answer that was cut off was a 200 with an empty body on the
`fetch` path, which the shim reported as uncertain without a retry. It is now a
transient status, so the shim retries once under the key. That is the better
result while ShipIt keeps running, and it has the limit that req 2 always had:
a restart between the two attempts loses the key.

Reproduced over the real relay, with a first host that takes
`plugin/exec`, starts the command and loses the connection: before the rule the
command ran twice and the relay answered 200; with it the command runs once and
the relay answers 502 with the message above.

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
`shipit plugin refresh` re-reads one. `shipit branch reset-to-base` and
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
| `src/server/session/orchestrator-client.ts` | One transport on Node `http`, a connection for each call, and the next host only before the connection is made (req 6) |
