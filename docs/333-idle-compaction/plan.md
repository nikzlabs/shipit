---
issue: planning#699
title: Idle compaction — design
description: An orchestrator deadline at 90% of the provider's cache lifetime, derived from the last turn's usage row, starts the existing silent compaction turn — which must not count as activity — and the idle enforcer compacts a waiting session before it stops it.
---

# 333 — Idle compaction: design

Implements [requirements.md](./requirements.md). Reuses the silent compaction
turn of [docs/295](../295-compact-context-on-merge/plan.md) and
[docs/324](../324-agent-requested-compaction/plan.md), and the compaction
triggers of [docs/178](../178-context-compaction/plan.md) and
[docs/276](../276-headless-compaction-triggers/plan.md).

## Shape

```
ordinary turn ends (agent_result) ──► usage row recorded ──► arm(session)
  arm: lifetime L for the session ──► L < 30 min? no deadline                      (req 11)
       context < 200K? no deadline                                                 (req 6)
       otherwise deadlines[session] = { due: end + 0.9·L, expires: end + L }       (req 1)
any turn starts ──► deadlines.delete(session)
one host-wide timer, armed at the earliest `due` ──► fire(session)
  fire: setting off · session done · harness cannot compact · now ≥ expires ──► drop   (req 5, 7, 9)
        no live container ──► start one only when inside the memory budget          (req 2)
        dispatch "/compact" — silent, automatic, refused when busy, NOT activity    (req 3)
idle enforcer, over budget, reaches a session with a deadline ──► fire it now; stop it after (req 8)
orchestrator boot ──► re-derive every deadline from usage_turns
```

Nothing runs inside the container, because the container can be gone
(requirements, Background). Nothing is polled: one timer for the whole
orchestrator, at the earliest deadline.

## Pieces

### 1. The cache lifetime (req 1, 9, 10, 11)

`idleCacheLifetimeMinutes(session)` in a new
`services/idle-compaction.ts`. It answers in minutes, or "none" when the
harness cannot compact.

| Harness | Lifetime | Why |
|---|---|---|
| Claude | the lifetime the last cache write used: **60** for `1h`, **5** for `5m`; **30** if no write was ever seen | observed per turn (below); req 10 for an endpoint that reports nothing (z.ai, DeepSeek and the other `anthropic-messages` endpoints) |
| Codex | **30** | OpenAI documents "at least 30 minutes after the latest write or reuse" for GPT-5.6 and later; ShipIt's Codex models are all GPT-6 (`shared/catalogue/services.ts`). Unverified on the ChatGPT backend; req 10 gives the same number |
| Grok | **30** | xAI documents no lifetime (req 10) |
| OpenCode, Claude model | **5** | OpenCode sends `cacheControl: {type: "ephemeral"}` with no `ttl` (1.18.34), which is Anthropic's 5-minute default |
| OpenCode, Kimi model | **5** | Kimi documents a 5-minute default; OpenCode sets no `prompt_cache_options` |
| OpenCode, other models | **30** | OpenAI documents 30; the others document none or more (req 10) |
| Antigravity | none | `supportsCompaction: false` (`shared/catalogue/harnesses.ts`) |

A lifetime under 30 minutes produces no deadline (req 11). The two 5-minute
OpenCode rows are what keep req 11 true there: with no row, req 10 would
assume 30 and compact a cache that died at minute 5 — a full re-read that
saves nothing.

**Observing Claude's lifetime.** The CLI's API usage carries
`cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
(seen in a 2.1.300 transcript; the SDK schema calls it "cache writes by
TTL"). ShipIt drops it today: `ClaudeUsageIteration` and the result usage in
`shared/types/claude-types.ts` leave it out, and `recordCall` in
`session/agents/claude/adapter.ts` copies three fields. Add it there, read it
from **main-thread** `assistant` messages only (subagents default to 5
minutes, so turn totals mix the two), and put `cacheTtl?: "5m" | "1h"` on
`AgentResultEvent`: `5m` if the turn wrote any 5-minute entry, else `1h` if it
wrote a 1-hour one, else unset — the CLI's own rule. A turn that only read the
cache sets nothing, so the lifetime is the newest **non-null** value.

It is persisted in a new nullable `usage_turns.cache_ttl` column, because it
must survive an orchestrator restart: a 5-minute session that read as
"unknown, so 30" after a restart would be compacted cold, against req 11.

### 2. The deadline (req 1, 6)

`deadlines: Map<sessionId, { due, expires }>` in `services/idle-compaction.ts`,
plus **one** `setTimeout` armed at the earliest `due` and re-armed whenever
the map changes. No per-session interval (CLAUDE.md, "never per-session
polling").

- **Armed** at the `agent_result` of an ordinary turn, right after
  `usageManager.record` (`ws-handlers/agent-listeners.ts`). `end` is that
  moment: the turn's last API call, which is what refreshed the cache. A
  compaction turn arms nothing — its context is small on success, and on
  failure one attempt per idle period is enough.
- **Context** is `usageManager.latestContextTokens(id, latestCompactionCard)`
  (`usage.ts`), the reading docs/295 req 15 already uses. Under 200K, or
  `undefined`, arms nothing (req 6). Note the difference from docs/295: there
  `undefined` means "compact"; here it means "skip".
- **Cleared** when any turn starts (`turn-executor.ts`, next to `track()`), so
  a user who comes back cancels it.
- **Re-derived at boot**, so a deploy does not lose a pending deadline: for
  each session whose newest own-turn usage row (`sub_agent_id IS NULL AND
  background_work = 0`) is younger than the longest lifetime (60 minutes), arm
  from that row's `timestamp`. No new schedule column: the row is the record.

### 3. Firing (req 2, 3, 5, 7, 9)

At `due`, `fireIdleCompaction(sessionId)` re-checks everything, because the
world moved since the deadline was armed:

1. The setting is on (req 5). It is read here, not at arm time, so a user who
   turns it on gets it for sessions that are already idle.
2. The session is not done: `doneSessionTest(sessionManager.listAll())` (req 7).
3. The session's harness can compact (req 9), re-read now in case it changed.
4. `now < expires`. A cold cache is never compacted — it would cost a full
   re-read and save nothing (the t3code rule).

Then it needs a runner:

- **A runner with a live container** — the usual case — is used as is.
- **No runner but a live container** — every session after an orchestrator
  restart, because runners are re-created only for in-flight turns
  (`restart-turn-reattach.ts`) — follows `wakeSessionWithTurn`
  (`wake-session.ts`): `getOrCreate` reconnects to the running container.
- **No container** (req 2). The stops are: the idle enforcer over budget —
  piece 5 compacts first, so this does not arise; a done session — excluded
  by req 7; and a ShipIt update — `reattachInFlightTurns` destroys a stale,
  idle container at boot and does not recreate it. For that last case the
  fire starts a fresh container through the same `wakeSessionWithTurn`
  pattern, **only while ShipIt is inside its memory budget**
  (`bytesOverBudget(stats) <= 0`). Over budget, it drops the deadline: the
  enforcer is already stopping sessions, and starting one would undo its
  work. **This depends on a fact not yet verified** — that a CLI resumed in a
  fresh container sends the same prompt prefix and reads the warm cache. See
  "Verify first".

Then it dispatches the docs/324 compaction turn:

```ts
runner.dispatch(prepareDispatch({
  text: "/compact", automatic: true, silent: true,
  activity: "Compacting context…", whenBusy: "refuse",
  countsAsActivity: false,          // new — piece 4
}));
```

- `silent` shows no user bubble, says "Compacting context…" in the status bar,
  records the ordinary "Context compacted" card (req 3), and posts
  `MISSED_COMPACTION_NOTICE` when no card follows (req 4)
  (`dispatched-turn.ts`, `compact-before-turn.ts`).
- `whenBusy: "refuse"` gives up when a turn runs or a hold is on: without it,
  an automatic dispatch is queued, or kept in the answer-hold store. A refused
  fire is one attempt; the next ordinary turn arms a new deadline.
- A dispatch that fails during setup posts the warn notice through
  `onTurnComplete`, as docs/324's `warnUser` does (req 4).
- The default `postTurn` stays, so the turn's drain still runs a message the
  user queued during the compaction.

### 4. A compaction is not activity

Every turn start calls `sessionManager.track()`, which sets `last_used_at` to
now (`turn-executor.ts:217-218`, `sessions.ts`). For an idle compaction that is
wrong three times over: it moves a session nobody touched to the top of the
sidebar; on a merged or closed session it clears the resolved state, so the
session is no longer done; and it unmutes the session (`setMuted(sessionId,
null)`, the same block). The `agent_result` listener's `touchUnlessResolved`
(`ws-handlers/agent-listeners.ts:736`) bumps `last_used_at` again.

So the dispatch carries `countsAsActivity: false`, threaded through
`AgentDispatchOptions` → `QueuedMessage` → the turn input. When it is false,
the turn start skips `track()` and the unmute, and the result skips
`touchUnlessResolved`. Everything else about the turn is unchanged —
including `retireRewindUndo`: a rewind's Undo restores a conversation that the
compaction has replaced, so it must still retire.

### 5. The idle enforcer (req 2, 8)

`idle-enforcer.ts` tier 1 (agent containers, over budget) changes in two ways:

- **Order.** `byReclaimOrder` gets a first key: a session with a deadline
  (`idleCompaction.isWaiting(sessionId)`, which applies piece 3's checks 1–4)
  sorts after every session without one. Inside each group, today's order
  (`lastViewerDetachAt`) stands.
- **Compact, then stop.** When the pass still needs memory and reaches a
  waiting session, it calls `fireIdleCompaction(sessionId)` instead of
  stopping it, frees nothing for it in this pass, and goes on to the next
  candidate. The enforcer is synchronous and cannot wait; it does not need
  to. The running compaction makes the session `agentBusy`, so no pass stops
  it halfway (`isReclaimable`, and a non-forced `dispose()` declines). When it
  ends, the runner's `idle` event re-runs the enforcer
  (`runner-registry-factory.ts`), the deadline is gone, and the session is an
  ordinary candidate. Memory comes back about a minute later, which is req
  8's accepted consequence.

The turn's own `running` flag is the hold, not the post-turn lease
(`post-turn-hold.ts`): that lease is capped at 120 s, and a 200K compaction
can take longer.

The done-session pass and the abandoned-draft pass do not change: a done
session has no deadline (req 7), and a draft has no conversation.

### 6. The setting (req 5)

`advanced.idleCompaction` — *Compact idle sessions before the prompt cache
expires* — Settings → Advanced, section Agent, a boolean, **off by default**,
declared once in `shared/settings-catalogue/global-settings.ts` next to
`advanced.agentCompaction` (docs/308). `propose: yes`. A typed getter on
`CredentialStore`, injected into the service as `isEnabled`, and the fallback
payload in `services/misc.ts`.

## What can interrupt an idle compaction

The t3code review found that settling a thread could cancel its idle
compaction. In ShipIt (traced in source):

| Event during the compaction | Result |
|---|---|
| The user sends a message | Queued (`turnTakesMessages` is false during a compaction); the drain runs it after. Nothing lost. The user waits for the compaction first. |
| The user presses **Stop** | The compaction is interrupted. Queued user messages go back to the input box (docs/330); the warn notice follows (req 4). The user's choice, so nothing to fix. |
| CI fix, conflict fix (docs/146, docs/186) | Wait for `idle`, which is not emitted while a turn runs. |
| A merge wakes the session (docs/196) | Queued behind the compaction. Its own docs/295 compaction then stands down: the new card's `postTokens` is under the 50K floor. |
| The idle enforcer | Cannot stop it: the session is `agentBusy`. |
| Archive, full reset, shutdown | Forced disposal ends it, as it ends any turn. |
| An orchestrator restart | The turn's phase and the in-memory queue are lost — the existing limit of docs/324 and docs/329. |

## Verify first

Two facts this design rests on, to be established by probe before the code
that depends on them is written:

1. **A resumed CLI reads the warm cache.** Run a turn in a container, destroy
   the container, start a fresh one, and resume: the first request's
   `cache_read_input_tokens` must be close to the context. The 2.1.300
   transcript stores the session context (`session_context` attachment,
   `api-request-blob`), which suggests the prefix is rebuilt byte for byte —
   suggestive, not proof. **If it is false**, the ShipIt-update case of req 2
   cannot be met by starting a container (it would compact cold, which saves
   nothing), and that becomes a question for the user. The rest of the
   design does not depend on it.
2. **`cache_creation` reaches ShipIt on `--output-format stream-json`**, on the
   main-thread `assistant` messages, with the split filled in. Seen in the
   transcript the CLI writes; confirm on the wire before piece 1 relies on it.

## Known limits

- **A question that waits holds it.** An automatic turn waits while the
  agent waits for the user's answer (docs/322), and the fire is refused. A
  session that ended its turn on a question gets no idle compaction. Kept
  deliberately: letting one automatic turn past the hold needs a new class of
  automatic turn, for a case nobody has asked about.
- **One attempt per idle period.** A refused or failed fire is not retried
  until the next ordinary turn. After an orchestrator restart, a failed
  attempt can be tried once more, because boot re-derives from the usage row
  and the failed compaction left no card.
- **The user may be at the composer.** A user who has read and typed for 54
  minutes sees the compaction start, and their message waits for it.
- **An account move.** If the compaction turn itself is routed to another
  account (docs/260), it reads that account's cold cache. Moves are rare
  (`pickKeepingCurrent`), so no dry-run of the routing is made.
- **The lifetime table is a reading of each provider's documentation** and of
  pinned CLI versions. It drifts with them, like docs/276.

## Rejected alternatives

- **Turn on the CLI's own idle compaction.** It arms only for an interactive
  CLI or a first-party entrypoint; spoofing `CLAUDE_CODE_ENTRYPOINT` would
  change other CLI behaviour, is gated by Anthropic's feature flag, and would
  cover Claude only (req 9).
- **A timer in the container.** Dies with the container (req 2).
- **A per-minute sweep over every session.** One timer at the earliest
  deadline does the same with no idle work.
- **A new schedule column.** The newest usage row already holds the time and
  the context size; only the Claude lifetime needed a column.
- **Precompute a summary and swap it in only if the user comes back after
  expiry** (the CLI's `compact_on_return` mode). Needs a fork of the agent's
  session that no harness offers headlessly, for the user who comes back
  between minute 54 and 60.
- **Dry-run the account routing before firing.** See Known limits.

## Docs to change

- `src/server/shipit-docs/wiki/settings-and-accounts.md` — the Advanced row.
- `src/server/shipit-docs/wiki/chat.md` — an idle session can be compacted
  while the setting is on.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/idle-compaction.ts` (new) | Lifetime, deadlines, the one timer, boot re-derivation, `fireIdleCompaction`, `isWaiting` |
| `src/server/shared/types/claude-types.ts`, `session/agents/claude/adapter.ts`, `shared/types/agent-types.ts` | `cache_creation` in usage; `cacheTtl` on `AgentResultEvent` |
| `src/server/shared/database.ts`, `src/server/orchestrator/usage.ts` | `usage_turns.cache_ttl`; latest non-null lifetime; newest own-turn row per session for boot |
| `src/server/orchestrator/ws-handlers/agent-listeners.ts` | Arm after `usageManager.record`; skip `touchUnlessResolved` when not activity |
| `src/server/orchestrator/turn-executor.ts`, `session-runner.ts`, `ws-handlers/agent-execution.ts` | `countsAsActivity`; clear the deadline at turn start |
| `src/server/orchestrator/idle-enforcer.ts` | Sort waiting sessions last; compact instead of stop |
| `src/server/shared/settings-catalogue/global-settings.ts`, `orchestrator/credential-store.ts`, `services/misc.ts` | `advanced.idleCompaction` |
| `src/server/orchestrator/bootstrap-managers.ts` | Build the service, re-derive at boot |
