---
issue: planning#699
title: Idle compaction — design
description: An orchestrator deadline at 90% of the provider's cache lifetime, anchored on the last model request and persisted in the usage row, starts the existing silent compaction turn — which stops counting as activity — and the idle enforcer compacts a waiting session before it stops it.
---

# 333 — Idle compaction: design

Implements [requirements.md](./requirements.md). Reuses the silent compaction
turn of [docs/295](../295-compact-context-on-merge/plan.md) and
[docs/324](../324-agent-requested-compaction/plan.md), and the compaction
triggers of [docs/178](../178-context-compaction/plan.md) and
[docs/276](../276-headless-compaction-triggers/plan.md).

## Shape

```
ordinary turn ends (agent_result) ──► usage row: context, cache_ttl, cache_anchor_at ──► arm(session)
  arm: lifetime L ──► L < 30 min? no deadline                                        (req 11)
       context < 200K? no deadline                                                   (req 6)
       deadlines[session] = { due: anchor + 0.9·L, expires: anchor + L }             (req 1)
one host-wide timer at the earliest `due` ──► fire(session)
  fire: take the deadline (one attempt) ──► re-check setting · done · harness · busy · expiry
        get a runner (reconnect, or start a container)                               (req 2)
        re-check ──► dispatch silent "/compact", refused when busy                   (req 3, 4)
a silent compaction turn is maintenance: no last-used, no unmute, no turn outcome
idle enforcer over budget: waiting sessions last; compact one instead of stopping it (req 8)
rewind, model or harness change ──► drop the deadline
orchestrator boot ──► re-derive every deadline from usage_turns
```

Nothing runs inside the container, because the container can be gone
(requirements, Background). Nothing is polled: one timer for the whole
orchestrator, at the earliest deadline.

## Pieces

### 1. The cache lifetime (req 1, 9, 10, 11)

`idleCacheLifetimeMinutes(session)` in a new `services/idle-compaction.ts`
answers in minutes, or "none" when the harness cannot compact (Antigravity,
`supportsCompaction: false` in `shared/catalogue/harnesses.ts`). Three rules,
in order:

1. **Observed.** The newest non-null `usage_turns.cache_ttl` among the rows
   whose `credential_route_id` matches the session's newest row: `1h` → 60,
   `5m` → 5. Scoped to the route because caches are per account and per
   endpoint: a 1-hour reading from the Anthropic subscription says nothing
   about a later turn on z.ai, which reports no split and must fall to rule 3
   (req 10).
2. **Documented for the model's provider**, keyed by the model's vendor
   (`shared/catalogue/model-identity.ts`), not by the harness — Codex also
   runs DeepSeek and Kimi models through Responses-compatible endpoints
   (`shared/catalogue/services.ts`):

   | Model provider | Lifetime | Source |
   |---|---|---|
   | Anthropic, through OpenCode | 5 | OpenCode 1.18.34 sends `cacheControl: {type: "ephemeral"}` with no `ttl`: Anthropic's 5-minute default |
   | Kimi | 5 | Kimi documents a 5-minute default; no harness sets `prompt_cache_options` |
   | OpenAI | 30 | "at least 30 minutes after the latest write or reuse" on GPT-5.6 and later. Unverified on the ChatGPT backend; req 10 gives the same number |

3. **Otherwise 30** (req 10): xAI, z.ai, DeepSeek ("hours to days", no
   number), OpenRouter, OpenCode Zen.

A lifetime under 30 minutes produces no deadline (req 11). The two 5-minute
rows are what keep req 11 true where no observation exists: without them,
rule 3 would compact a cache that died at minute 5 — a full re-read that saves
nothing.

**Observing Claude's lifetime.** The CLI's API usage carries
`cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
(seen in a 2.1.300 transcript; the SDK schema calls it "cache writes by
TTL"). ShipIt drops it today: `ClaudeUsageIteration` in
`shared/types/claude-types.ts` leaves it out, and `recordCall` in
`session/agents/claude/adapter.ts` copies three fields. Add it there, read it
from **main-thread** `assistant` messages only (subagents default to 5
minutes, so turn totals mix the two), and put `cacheTtl?: "5m" | "1h"` on
`AgentResultEvent`: `5m` if the turn wrote any 5-minute entry, else `1h` if it
wrote a 1-hour one, else unset — the CLI's own rule. A turn that only read the
cache sets nothing; rule 1 takes the newest non-null value. The result-level
usage type is not changed: only the per-message reading is used.

### 2. The deadline (req 1, 6)

**One record: the usage row.** Two nullable columns on `usage_turns`, written
in the same `usageManager.record` call:

- `cache_ttl` — piece 1.
- `cache_anchor_at` — when the turn's **last model request started**. A cache
  lifetime runs from the request that reads or writes the prefix, not from
  the end of the reply, so a long final reply anchored on `agent_result`
  would fire after the cache is cold. The orchestrator sees an
  `agent_tool_result` for every harness, and each one is followed at once by
  the next request; so the anchor is the time of the turn's last tool result,
  or the turn's start when it had none. Where the approximation errs (a
  subagent's tool result, a steer with no tool result), it errs **earlier**,
  which compacts sooner and never cold.
- **Written only for ordinary turns.** A compaction turn — this one, docs/295,
  docs/324, a typed `/compact` — leaves `cache_anchor_at` null, so neither a
  success (small context) nor a failure (no card) can start a new deadline.

`deadlines: Map<sessionId, { due, expires }>` holds the armed ones, with
**one** `setTimeout` at the earliest `due`, re-armed whenever the map changes.
No per-session interval (CLAUDE.md, "never per-session polling").

- **Armed** after `usageManager.record` in the `agent_result` listener
  (`ws-handlers/agent-listeners.ts`), from the row just written: `due = anchor
  + 0.9·L`, `expires = anchor + L`. The new entry replaces the old.
- **Context** is `usageManager.latestContextTokens(id, latestCompactionCard)`
  (`usage.ts`), the reading docs/295 req 15 uses. Under 200K, or `undefined`,
  arms nothing (req 6). Unlike docs/295, `undefined` means "skip".
- **Not cleared when a turn starts.** A running turn refuses the fire anyway
  (piece 3), and its own result replaces the entry. A turn that dies with no
  result leaves the previous entry in place, which is still right: that
  turn's requests could only make the cache warmer.
- **Dropped** when it fires (one attempt), and when the conversation stops
  being the one the reading describes: a rewind
  (`ws-handlers/rollback-handlers.ts`), and a change of the session's model or
  harness — the next turn would read another model's cold cache, and the
  context reading would describe the old conversation.
- **Re-derived at boot**: for each session, the newest own-turn row
  (`sub_agent_id IS NULL AND background_work = 0`) with a non-null
  `cache_anchor_at` younger than 60 minutes arms as above. No schedule column:
  the row is the record.

### 3. Firing (req 2, 3, 4, 5, 7, 9)

`fireIdleCompaction(sessionId)`:

1. **Take the attempt** — delete the entry first, synchronously, so no second
   fire or enforcer pass starts another.
2. **Check**, because the world moved since the deadline was armed:
   - the setting is on (req 5) — read here, so turning it on covers sessions
     that are already idle;
   - the session is not done: `doneSessionTest(sessionManager.listAll())`
     (req 7);
   - the harness can compact (req 9);
   - `now < expires` — a cold cache is never compacted (the t3code rule);
   - the session is not busy. This is docs/324's check
     (`busyReason` in `services/agent-compaction-request.ts`, exported for
     both): a running turn, a merge or session hold, **resident background
     work** — which `dispatchOnRunner` does not check, and which a compaction
     spawn could end (`dispatched-turn.ts`) — and the question hold (see
     "Open question").
3. **Get a runner**, following `wakeSessionWithTurn` (`wake-session.ts`):
   - a runner with a live container is used as is;
   - no runner but a live container — every session after an orchestrator
     restart, because runners are re-created only for in-flight turns
     (`restart-turn-reattach.ts`) — `getOrCreate` reconnects;
   - **no container** (req 2): a ShipIt update destroys a stale, idle
     container at boot and does not recreate it (`reattachInFlightTurns`). The
     fire starts a fresh one, as a user's message would, **whatever the
     memory budget**: req 8 then orders the enforcer to stop other idle
     sessions before this one. The other stops do not reach here — the
     enforcer compacts first (piece 5), and a done session has no deadline
     (req 7). This case **depends on a fact not yet verified**: see "Verify
     first".
4. **Check again** after the awaits of step 3 — the user can come back, the
   session can become done, the cache can expire — immediately before the
   dispatch.
5. **Dispatch** the docs/324 compaction turn:

   ```ts
   runner.dispatch(
     prepareDispatch({ text: "/compact", automatic: true, silent: true, activity: "Compacting context…" }),
     { whenBusy: "refuse" },
   );
   ```

   - `whenBusy: "refuse"` is the admission argument, not a dispatch field
     (`session-runner.ts` `dispatch(opts, admission)`). Without it an
     automatic dispatch is queued, and could run after the cache is cold.
   - `silent` shows no user bubble, says "Compacting context…" in the status
     bar, records the ordinary "Context compacted" card (req 3), and posts
     `MISSED_COMPACTION_NOTICE` when no card follows (req 4)
     (`dispatched-turn.ts`, `compact-before-turn.ts`).
   - A failure in step 3 or in dispatch setup posts the same warn notice, as
     docs/324's `warnUser` does (req 4). A fire dropped by a check posts
     nothing: no compaction was due.
   - The default `postTurn` stays, so the turn's drain runs a message that the
     user queued during the compaction.

### 4. A silent compaction turn is maintenance

Today every turn start calls `sessionManager.track()`, which sets
`last_used_at` to now, and unmutes the session (`turn-executor.ts:217-223`);
the result calls `touchUnlessResolved` (`ws-handlers/agent-listeners.ts:736`)
and records the turn's outcome (`recordTurnEnd`, `turn-executor.ts`). For an
idle compaction each is wrong:

- `last_used_at` moves a session nobody touched to the top of the sidebar,
  and on a merged or closed session it clears the resolved state, so the
  session is no longer done;
- the unmute undoes the user's mute;
- the outcome overwrites the last real turn's: a scheduled run that ended in
  an error would read as finished (`run-finished.ts`).

So a **silent compaction turn** — `silent` with compaction text, the class
`dispatched-turn.ts` already recognises — skips all four. This is the existing
classification, not a new flag, and it changes docs/295 and docs/324 too.
That is harmless there: each of their compactions sits next to a real turn
that does the bookkeeping. `retireRewindUndo` still runs: a rewind's Undo
restores a conversation that the compaction has replaced.

**Restart adoption keeps the class.** A turn adopted after an orchestrator
restart (`turn-adoption.ts`) is restored with neither `compact` nor `silent`,
so an adopted compaction would touch the session, take steering, and lose its
missed-card check. The in-flight record that adoption reads gains the
compaction class, and adoption restores the maintenance behaviour and the
missed-card check (req 4). This fixes docs/295 and docs/324 compactions as
well.

### 5. The idle enforcer (req 2, 8)

`idle-enforcer.ts`, tier 1 (agent containers, over budget):

- **Order.** `byReclaimOrder` gets a first key: a session that waits for its
  idle compaction (`idleCompaction.isWaiting(sessionId)`: it has a deadline
  and piece 3's step-2 checks pass) sorts after every session without one.
  Inside each group, today's order (`lastViewerDetachAt`) stands.
- **Compact, then stop.** When the pass still needs memory and reaches a
  waiting session, it calls `fireIdleCompaction(sessionId)` instead of
  stopping it, counts that session's measured bytes against `need`, and adds
  it to `compactingToReclaim`. Counting the bytes is what stops one pass
  from starting a compaction on every waiting session.
- **Later passes** keep subtracting the bytes of the sessions in
  `compactingToReclaim`, so the shortfall is not counted twice while their
  compactions run, and stop each one first as soon as it is reclaimable. The
  running compaction makes the session `agentBusy`, so no pass stops it
  halfway; after it, the post-turn lease (`post-turn-hold.ts`) holds it a
  little longer — the runner's `idle` event fires **before** that lease
  releases (`turn-executor.ts`, the `idle` step precedes `settle`), so the
  stop comes from the next periodic pass, at most 30 s later. Memory comes
  back about a minute after the pass, which is req 8's accepted consequence.
- The set forgets a session once it is stopped, disposed by another path, or
  no longer has a live container.

The turn's own `running` flag is the hold, not the post-turn lease: that lease
is capped at 120 s, and a 200K compaction can take longer. The done-session
pass and the abandoned-draft pass do not change.

### 6. The setting (req 5)

`advanced.idleCompaction` — *Compact idle sessions before the prompt cache
expires* — Settings → Advanced, section Agent, a boolean, **off by default**,
declared once in `shared/settings-catalogue/global-settings.ts` next to
`advanced.agentCompaction` (docs/308). `propose: yes`, like its neighbour. A
typed getter on `CredentialStore`, injected into the service as `isEnabled`,
and the fallback payload in `services/misc.ts`.

## Open question

**docs/322 forbids it while a question waits.** docs/322 req 1–2: when an
agent turn ends on a question or a plan, ShipIt starts no automatic turn —
"any turn the user did not start", including ones added later — until the
user responds. An idle compaction is such a turn, so as designed a session
that ended on a question gets none (and docs/322 req 4's "held, not dropped"
does not fit it either: held until the user replies, the cache is cold). It
is listed in requirements.md for the user to decide; step 2 of piece 3
follows the answer.

## What can interrupt an idle compaction

The t3code review found that settling a thread could cancel its idle
compaction. In ShipIt (traced in source):

| Event during the compaction | Result |
|---|---|
| The user sends a message | Queued (`turnTakesMessages` is false during a compaction); the drain runs it after. The user waits for the compaction first. |
| The user presses **Stop** | The compaction is interrupted. Queued user messages go back to the input box (docs/330); the warn notice follows (req 4). The user's choice. |
| CI fix, conflict fix (docs/146, docs/186) | Wait for `idle`, which is not emitted while a turn runs. |
| A merge wakes the session (docs/196) | Queued behind the compaction. Its own docs/295 compaction then stands down: the new card's `postTokens` is under the 50K floor. |
| The idle enforcer | Cannot stop it: the session is `agentBusy`. |
| Archive, full reset, shutdown | Forced disposal ends it, as it ends any turn. |
| An orchestrator restart | Adopted with its class (piece 4). A message queued behind it is lost, as a message queued behind **any** running turn is today (docs/324, docs/329). Req 4 keeps the existing guarantee and this design does not weaken it. |

## Verify first

Two facts this design rests on, to be established by probe before the code
that depends on them is written:

1. **A resumed CLI reads the warm cache.** Run a turn in a container, destroy
   the container, start a fresh one, and resume: the first request's
   `cache_read_input_tokens` must be close to the context. The 2.1.300
   transcript stores the session context (`session_context` attachment,
   `api-request-blob`), which suggests the prefix is rebuilt byte for byte —
   suggestive, not proof. **If it is false**, the ShipIt-update case of
   piece 3 would compact cold, which saves nothing; that case then goes back
   to the user as an exception to req 2. Nothing else depends on it.
2. **`cache_creation` reaches ShipIt on `--output-format stream-json`**, on the
   main-thread `assistant` messages, with the split filled in. Seen in the
   transcript the CLI writes; confirm on the wire before piece 1 relies on it.

## Known limits

- **A retry after a restart.** A failed attempt is not retried, except once
  more if the orchestrator restarts before `expires`: boot re-derives from the
  same ordinary row, because the failed compaction left no card.
- **The user may be at the composer.** A user who has read and typed for 54
  minutes sees the compaction start, and their message waits for it.
- **An account move.** If the compaction turn itself is routed to another
  account (docs/260), it reads that account's cold cache. Moves are rare
  (`pickKeepingCurrent`), so no dry-run of the routing is made.
- **The lifetime table reads each provider's documentation** and pinned CLI
  versions. It drifts with them, like docs/276.

## Rejected alternatives

- **Turn on the CLI's own idle compaction.** It arms only for an interactive
  CLI or a first-party entrypoint; spoofing `CLAUDE_CODE_ENTRYPOINT` would
  change other CLI behaviour, is gated by Anthropic's feature flag, and would
  cover Claude only (req 9).
- **A timer in the container.** Dies with the container (req 2).
- **A per-minute sweep over every session.** One timer at the earliest
  deadline does the same with no idle work.
- **Anchor on `agent_result`.** Fires late after a long final reply (piece 2).
- **Clear the deadline when a turn starts.** Loses it when that turn dies
  without a result (piece 2).
- **A new `countsAsActivity` dispatch flag.** The silent-compaction class
  already exists and covers every caller (piece 4).
- **Drop a stopped session's deadline while over budget.** Would narrow req 2
  without the user's decision; req 8 already says which sessions stop first.
- **Precompute a summary and swap it in only if the user comes back after
  expiry** (the CLI's `compact_on_return` mode). Needs a fork of the agent's
  session that no harness offers headlessly, for the user who comes back
  between minute 54 and 60.

## Review resolution

ShipIt reviewer run 8b795f37-438b-497a-b71e-5e4446787241 reviewed the first
draft against every requirement, and for what could be removed. Accepted and
fixed: the anchor was `agent_result` (late after a long reply); boot could
re-arm from a failed compaction's row; resident background work was not
checked; `whenBusy` was put in the wrong argument; no re-check after the
asynchronous wake; one enforcer pass could start every waiting compaction, and
the claim that `idle` stops it at once was wrong; adoption dropped the
compaction class; the turn outcome was overwritten; a rewind left a stale
deadline; the lifetime was not scoped to the route, and "Codex is all GPT-6"
was false; two known limits narrowed req 1 and req 2 without the user. From
the simplification brief: the result-level usage change and the new dispatch
flag are gone. The question-hold conflict is the one open question.

## Docs to change

- `src/server/shipit-docs/wiki/settings-and-accounts.md` — the Advanced row.
- `src/server/shipit-docs/wiki/chat.md` — an idle session can be compacted
  while the setting is on.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/idle-compaction.ts` (new) | Lifetime, deadlines, the one timer, boot re-derivation, `fireIdleCompaction`, `isWaiting` |
| `src/server/shared/types/claude-types.ts`, `session/agents/claude/adapter.ts`, `shared/types/agent-types.ts` | `cache_creation` on per-message usage; `cacheTtl` on `AgentResultEvent` |
| `src/server/shared/database.ts`, `src/server/orchestrator/usage.ts` | `usage_turns.cache_ttl`, `cache_anchor_at`; route-scoped lifetime; newest anchored row per session for boot |
| `src/server/orchestrator/ws-handlers/agent-listeners.ts` | The anchor (last tool result); arm after `usageManager.record`; skip `touchUnlessResolved` for a silent compaction |
| `src/server/orchestrator/turn-executor.ts` | Skip `track`, unmute and `recordTurnEnd` for a silent compaction |
| `src/server/orchestrator/turn-adoption.ts` and the in-flight record it reads | Keep the compaction class across a restart |
| `src/server/orchestrator/services/agent-compaction-request.ts` | Export the busy check |
| `src/server/orchestrator/ws-handlers/rollback-handlers.ts`, the model and harness switch paths | Drop the deadline |
| `src/server/orchestrator/idle-enforcer.ts` | Waiting sessions last; compact instead of stop; `compactingToReclaim` |
| `src/server/shared/settings-catalogue/global-settings.ts`, `orchestrator/credential-store.ts`, `services/misc.ts` | `advanced.idleCompaction` |
| `src/server/orchestrator/bootstrap-managers.ts` | Build the service, re-derive at boot |
