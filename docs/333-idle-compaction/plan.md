---
issue: planning#699
title: Idle compaction — design
description: An orchestrator deadline at 90% of the provider's cache lifetime, anchored on the last model request and persisted in the usage row, starts the existing silent compaction turn — which stops counting as activity, and starts the session's container when none runs — and the idle enforcer compacts a waiting session before it stops it.
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
  arm: lifetime L ──► none (Grok)? no deadline                                       (req 15)
       L < 30 min? no deadline                                                       (req 11)
       context < 200K? no deadline                                                   (req 6)
       deadlines[session] = { due: anchor + 0.9·L, expires: anchor + L }             (req 1)
one host-wide timer at the earliest `due` ──► fire(session)
  fire: take the deadline (one attempt) ──► re-check setting · done · harness · account · busy · expiry
        get a runner: reconnect, take the idle resident over, or — no container —
        start one (the wake path), marked "woken"                                   (req 2, 13)
        re-check ──► dispatch silent "/compact", refused when busy                   (req 3, 4)
a silent compaction turn is maintenance: no last-used, no unmute, no turn outcome
idle enforcer over budget: waiting sessions last; compact one instead of stopping it (req 8)
idle enforcer, any budget: stop a woken container after its compaction, unless used  (req 13)
rewind pending, model or harness changed ──► the fire drops it
orchestrator boot ──► re-derive every deadline from usage_turns
```

Nothing runs inside the container, because the container can be gone
(requirements, Background). Nothing is polled: one timer for the whole
orchestrator, at the earliest deadline.

**planning#704 changed piece 3** (req 13 since its last 2026-10-20 answer): a
fire that finds no container starts one, and the idle enforcer stops it again
(piece 5); the check that Claude's resident process is held became a check of
the account ("Verify first" 1 shows why).

## Pieces

### 1. The cache lifetime (req 1, 9, 10, 11)

`cacheLifetimeMinutes` in a new `services/idle-compaction.ts` answers in
minutes, and `idleCompactionExclusion` says when the harness gets no idle
compaction at all:

- the harness cannot compact (Antigravity, `supportsCompaction: false` in
  `shared/catalogue/harnesses.ts`);
- **Grok**, until a probe shows its cache warm across processes (req 15).

**OpenCode is in** (req 14): planning#701 (PR #3239) gave it one
instruction-file path per prompt, and its control probe was warm — "Verify
first" 1b.

The per-harness facts — excluded, the Anthropic default a harness gets by
setting no ttl — are one table,
`HARNESS_CACHE`, keyed by harness id: a lint rule forbids comparing harness ids
outside `agents/<id>/`, and a `Record<AgentId, …>` makes a new harness declare
its row.

Otherwise three rules, in order:

1. **Observed.** The newest non-null `usage_turns.cache_ttl` among the
   session's own rows on the same route, harness and model as the turn that
   arms (`credential_route_id`, `cache_agent_id`, `cache_model`): `1h` → 60,
   `5m` → 5. Scoped to the route because caches are per account and per
   endpoint: a 1-hour reading from the Anthropic subscription says nothing
   about a later turn on z.ai, which reports no split and must fall to rule 3
   (req 10). Scoped to the harness and model because a cache is theirs alone:
   a Claude turn's 5-minute reading on a gateway key says nothing about an
   OpenCode turn on GPT through the same key.
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
- **And only for a turn that reached the model.** A turn whose result reports
  no tokens read or written (a request refused at once, a result with no
  usage) did not touch the cache; anchoring on it would put the deadline after
  the cache is cold. The previous turn's deadline stays.
- **A turn the CLI starts on its own** (a self-wake adopted on the same
  listeners) restarts the anchor and is ordinary, also on a process a
  compaction ran on.

`deadlines: Map<sessionId, { due, expires }>` holds the armed ones, with
**one** `setTimeout` at the earliest `due`, re-armed whenever the map changes.
No per-session interval (CLAUDE.md, "never per-session polling").

- **Armed** by the row just written: `UsageManager.record` tells its
  `onAnchoredTurn` listeners about every anchored own-turn row, and the
  service is one of them (`bootstrap-managers.ts`). `due = anchor + 0.9·L`,
  `expires = anchor + L`. The new entry replaces the old, or removes it when
  the new reading arms nothing. A listener, not a call in
  `agent-listeners.ts`: both turn paths (the WebSocket one and the dispatched
  one) build their own listener deps, and the store is the one place they
  share.
- **Context** is `usageManager.latestContextTokens(id, latestCompactionCard)`
  (`usage.ts`), the reading docs/295 req 15 uses. Under 200K, or `undefined`,
  arms nothing (req 6). Unlike docs/295, `undefined` means "skip".
- **Not cleared when a turn starts.** A running turn refuses the fire anyway
  (piece 3), and its own result replaces the entry. A turn that dies with no
  result leaves the previous entry in place, which is still right: that
  turn's requests could only make the cache warmer.
- **Dropped** when it fires (one attempt), and when the conversation stops
  being the one the reading describes: a rewind, and a change of the session's
  model or harness — the next turn would read another model's cold cache, and
  the context reading would describe the old conversation. Both are checks at
  the fire, not hooks where they happen: every own-turn row records the
  harness and model whose cache it read (`cache_agent_id`, `cache_model`, so
  boot sees them too), the deadline keeps the anchor row's, and a pending
  rewind (`agentResumeAt`) blocks the fire. The model and harness change in
  many places (the switch paths, roles, model retirement), and one check
  covers all of them; an Undo of a rewind
  clears `agentResumeAt`, so the deadline that still describes the restored
  conversation stands.
- **Re-derived at boot**: for each session, the newest own-turn row
  (`sub_agent_id IS NULL AND background_work = 0`) with a non-null
  `cache_anchor_at` younger than 60 minutes arms as above. No schedule column:
  the row is the record.
- **The account.** The deadline also keeps the anchor row's
  `credential_route_id`: the cache belongs to the account that wrote it
  (piece 3 step 4).

### 3. Firing (req 2, 3, 4, 5, 7, 9, 13)

`fireIdleCompaction(sessionId)`:

1. **Take the attempt** — delete the entry first, synchronously, so no second
   fire or enforcer pass starts another.
2. **Check**, because the world moved since the deadline was armed:
   - the setting is on (req 5) — read here, so turning it on covers sessions
     that are already idle;
   - the session is not archived, and not done:
     `doneSessionTest(sessionManager.listAll())` (req 7);
   - the harness and model are the ones the deadline was armed for, and no
     rewind is pending (piece 2);
   - `now < expires` — a cold cache is never compacted (the t3code rule);
   - a turn would run on the deadline's account (step 4);
   - the session is not busy. This is docs/324's check
     (`busyReason` in `services/agent-compaction-request.ts`, exported for
     both): a running turn, a merge or session hold, and **resident
     background work** — which `dispatchOnRunner` does not check, and which a
     compaction spawn could end (`dispatched-turn.ts`). The question hold is
     the one part of `busyReason` this caller skips (req 12; piece 3a).
3. **Get a runner; start a container when none runs** (req 2, 13).
   - A runner with a live container is used as is.
   - Otherwise the fire takes the wake path, `bootSessionRunner`
     (`wake-session.ts`: the part of `wakeSessionWithTurn` before its
     dispatch, which both now share). It restores a reclaimed workspace,
     disposes a runner whose container is gone, and calls `getOrCreate`,
     which reconnects to a live container — every session after an
     orchestrator restart, because runners are re-created only for in-flight
     turns (`restart-turn-reattach.ts`) — or creates one (verified at
     `app-lifecycle.ts`, the runner factory's cold path:
     `createContainerForRunner`). The new runner starts the session's install
     and preview services, as every wake does (`setupServiceManager`). In
     local mode the orchestrator process runs the agents, and there is no
     container to start.
   - Then docs/334's attach takes the worker's idle process over where one
     survived ([docs/334](../334-reattach-resident-claude/plan.md), which
     ended req 16's exception), so it keeps its background work. **When the
     worker still runs a process the runner could not take over** (an older
     worker kept no spawn facts, or the status did not read), the fire is
     dropped: a new process's `/agent/start` would end that one, and its
     background tasks with it (`postAgentStart`). The probe removed the need
     for the cache's own process, not this protection of the worker's work.
   - **A session the fire wakes is marked woken** before the wake, with its
     `lastUsedAt` and whether its preview services ran (`hasPreview`). Piece 5
     stops the container again. A container another path is starting
     (`starting`) is not the fire's, and is not marked. The stops that leave a
     session with no container: a ShipIt update destroys a stale, idle one at
     boot (`reattachInFlightTurns`, req 13); a crash or a missed exit; an
     enforcer stop of a session that did not wait at that pass. The enforcer
     compacts a waiting session first (piece 5), and a done session has no
     deadline (req 7).
   - **From the wake to the dispatch the session is held**: `isStarting`
     makes the idle enforcer treat it as busy. No turn holds the runner yet,
     and a session with no install is not `agentBusy` while it boots, so an
     over-budget pass would otherwise stop it and lose the one attempt.
   - **The fire waits for the worker and the install** (`whenReadyForAgent`),
     at most until the cache expires. A fresh process starts only after both
     (`startAgentOnWorker`), and `bootSessionRunner` stops waiting for the
     worker after 30 s, so the re-check of step 5 drops a compaction whose
     cache expired meanwhile.
   - **The memory budget is not checked before a wake.** Req 8 sets the order
     of reclaim: a session that waits for its compaction comes after other
     idle sessions, so the enforcer's next passes stop those, and the woken
     session is stopped right after its compaction. No other wake checks the
     budget either.
4. **The account must be the deadline's.** A cache belongs to the account
   (the organization) that wrote it, and the CLI records that organization
   in the transcript (`credential_org`, "Verify first" 1). The fire asks the
   turn's own route choice which route the compaction would take now —
   `nextTurnRouteId` (`session-agent-env.ts`) calls `selectTurnRoute` with
   the current route a turn uses (the runner's resident route, else the
   on-disk resident-route record, else the previous turn's route) — and
   drops the fire when the answer is not the deadline's route, or there is
   none. It does not keep a resident's route by force: a dispatch first
   retires a resident whose route that same selection would leave
   (`residentRouteNeedsRelease`, `dispatched-turn.ts`), so the selection is
   the route the compaction runs on.

   This replaced a check that Claude's resident process is held (with live
   steering on). That check rested on the "Verify first" 1 probe, whose cold
   first resume came from a confound: through ShipIt's spawn a new process
   reads the conversation warm. What the old check covered, case by case:
   - an orchestrator restart, whose runner holds no process: a new process
     is warm, and docs/334's attach still reuses a surviving one;
   - the recovery, rebase and plan-mode paths that release the resident
     (`setAgent(null)`): the next process resumes the same conversation on
     the same account and model, so it is warm;
   - the auth paths (a credential rejected or removed) and an account move:
     the next process can run on another account, whose cache is cold — the
     account check covers them;
   - a model or harness change: already a check (piece 2).
   With live steering off every Claude turn was already a new process, as on
   the other harnesses (docs/276).
5. **Check again** after the awaits of step 3 — the user can come back, the
   session can become done, the cache can expire — immediately before the
   dispatch. A woken session keeps its mark whatever happens here; piece 5
   decides from its use whether its container stops again.
6. **Dispatch** the docs/324 compaction turn:

   ```ts
   runner.dispatch(
     prepareDispatch({ text: "/compact", automatic: true, silent: true, activity: "Compacting context…" }),
     { whenBusy: "refuse" },
   );
   ```

   - `permissionMode` is the runner's applied mode, so the resident keeps the
     mode it has.
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

### 3a. Past the question hold (req 12)

An idle compaction runs while the agent waits for the user's answer, and is
not the user's response (docs/322 req 2's exception). Three places decide
that, and each needs the same answer:

- `busyReason` — the fire's step-2 check skips its `awaitingUserAnswer` /
  `answerHold` arm. docs/324 keeps it: an agent-requested compaction still
  waits.
- `dispatchOnRunner`'s answer-hold admission (`session-runner.ts`) holds an
  automatic dispatch while the agent waits. A **silent compaction** — the
  class of piece 4 — is admitted instead. docs/295's compaction runs in front
  of a user's turn, which already ends the hold, and docs/324's never reaches
  admission while a question waits, so the exemption changes nothing for
  them.
- The turn start clears the hold only for a turn that is not `automatic`
  (`turn-executor.ts`, the docs/322 req 3 block). The dispatch stays
  `automatic: true`, so the hold stays, and held automatic work keeps
  waiting for the user's own turn.

The question card stays answerable. The cost the user accepted: the agent
reads the answer against a summary of the conversation, not the conversation
itself.

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
`dispatched-turn.ts` already recognises — skips all four, and the
`last_turn_errored` flag too: a parent reads a child's status from it
(`child-sessions.ts`), so a failed compaction would show the child as errored. This is the existing
classification, not a new flag, and it changes docs/295 and docs/324 too.
That is harmless there: each of their compactions sits next to a real turn
that does the bookkeeping. `retireRewindUndo` still runs: a rewind's Undo
restores a conversation that the compaction has replaced.

**Restart adoption keeps the class.** A turn adopted after an orchestrator
restart (`turn-adoption.ts`) is restored with neither `compact` nor `silent`,
so an adopted compaction would touch the session, take steering, and lose its
missed-card check. The in-flight record that adoption reads is the worker's
`/agent/status`: the executor marks the process (`markSilentCompaction`, or
`silentCompaction` on the message into a resident), the worker keeps the mark
with the turn as it keeps the delivery id (`agent-controller.ts`) and reports
`silentCompaction`, and adoption restores `compact`, `silent`, the harness-
command mark and the missed-card check (req 4). An older worker reports
nothing, and its turn is adopted as before. This fixes docs/295 and docs/324
compactions as well.

### 5. The idle enforcer (req 2, 8, 13)

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
  used since the fire — a viewer now, a viewer-detach time other than the one
  the fire saw, a turn after the compaction's own (`turnEpoch` beyond the
  fire's by more than one), or another container than the fire saw. Its
  memory is then not on its way back. This runs at the start of every pass,
  also under budget.
- Once its compaction is over, a session is stopped only while memory is
  still short; when it no longer is, the session is forgotten and is an
  ordinary idle session again ("when it must still stop such a session",
  req 8).
- A session handled in a pass's compacting step is not a tier-1 candidate of
  the same pass: a stop's teardown is asynchronous, so its container is still
  listed.

The turn's own `running` flag is the hold, not the post-turn lease: that lease
is capped at 120 s, and a 200K compaction can take longer. The done-session
pass and the abandoned-draft pass do not change.

**A woken session is stopped again** (req 13), whatever the budget, next to
the done-session pass: every pass (every 30 s, and when a runner goes idle)
reads `idleCompaction.wokenSessions()`, and skips a session whose fire is
still starting it. A session used since the wake is forgotten and keeps its
container: a viewer, or any detach (the wake's runner is new), or a moved
`lastUsedAt` — every turn but a silent compaction moves it (piece 4), so a
retry inside the compaction turn is not use, and a turn during the wake is.
A session whose container is gone is forgotten too. Otherwise, once it is
reclaimable (the compaction and its post-turn lease are over), the pass
disposes the runner, not forced, and destroys the agent container. Disposal
stops the preview services the runner holds (`setupServiceManager`'s
`disposed` handler), unless they ran before the wake: then
`preserveComposeOnDispose` keeps them, as the tier-1 stop does. After an
update none ran, because shutdown disposes every runner and boot reaps the
surviving stacks (`reapSurvivingComposeStacks`). No pause notice: the user
saw no container start.

### 6. The setting (req 5)

`advanced.idleCompaction` — *Compact idle sessions before the prompt cache
expires* — Settings → Advanced, section Agent, a boolean, **off by default**,
declared once in `shared/settings-catalogue/global-settings.ts` next to
`advanced.agentCompaction` (docs/308). `propose: yes`, like its neighbour. A
typed getter on `CredentialStore`, injected into the service as `isEnabled`,
and the fallback payload in `services/misc.ts`.

## What can interrupt an idle compaction

The t3code review found that settling a thread could cancel its idle
compaction. In ShipIt (traced in source):

| Event during the compaction | Result |
|---|---|
| The user sends a message | Queued (`turnTakesMessages` is false during a compaction); the drain runs it after. The user waits for the compaction first. |
| The user presses **Stop** | The compaction is interrupted. Queued user messages go back to the input box (docs/330); the warn notice follows (req 4). The user's choice. |
| CI fix, conflict fix (docs/146, docs/186) | Wait for `idle`, which is not emitted while a turn runs. |
| A merge wakes the session (docs/196) | Queued behind the compaction. Its own docs/295 compaction then stands down: the new card's `postTokens` is under the 200K floor. |
| The idle enforcer | Cannot stop it: the session is `agentBusy`. |
| Archive, full reset, shutdown | Forced disposal ends it, as it ends any turn. |
| An orchestrator restart | Adopted with its class (piece 4). A message queued behind it is lost, as a message queued behind **any** running turn is today (docs/324, docs/329). Req 4 keeps the existing guarantee and this design does not weaken it. |

## Verify first

Two facts this design rests on, established by probe on 2026-10-19 before any
code.

**Setup.** Claude Code 2.1.300 (the pinned CLI), `claude-haiku-5-5`, the
user's subscription, a scratch git repo. Each process was started with
ShipIt's streaming flags (`process.ts`): `--print --input-format stream-json
--output-format stream-json --replay-user-messages --verbose --model haiku
--append-system-prompt-file <file> --exclude-dynamic-system-prompt-sections`,
one user message on stdin, `--resume <id>` for the later processes. Script and
raw output: `/persist/idlecompact/` (not committed).

### 1. A new process reads the conversation warm — true through ShipIt's spawn

The first probe concluded the opposite. Its runs, as recorded:

| Run | Process | State change before it | Context | cache read | cache write |
|---|---|---|---|---|---|
| A1 | new session | — | 21,278 | 11,102 | 10,174 |
| B1 | first resume of A1 | commit + untracked file | 21,315 | 14,022 | **7,291** |
| C1 | resume of B1 | none | 21,354 | **21,288** | 64 |
| A3 | new session | — | 21,306 | 12,732 | 8,572 |
| B3 | first resume of A3 | none | 21,343 | 14,050 | **7,291** |
| A2 | new session, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` | — | 20,828 | 0 | 20,826 |
| B2 | first resume of A2, same env | commit + untracked file | 20,865 | 13,572 | **7,291** |

It read the B rows as "a first resume in a new process misses from about 14K
tokens on". **That reading had a confound:** each B run was also the
conversation's second request, and a second request misses in the same
process too — docs/334's probe saw it through ShipIt's spawn (its A2 wrote
11,406 tokens in the process that built the cache), and with this raw
invocation a second turn in the first process wrote 8,571. The table cannot
tell a new-process effect from a second-request effect. C1, a third request,
was warm.

**docs/334's probe (2026-10-19)**, through ShipIt's own spawn path (a real
`SessionWorker` and `ClaudeAdapter`: ShipIt's flags, a full model id), found
the first resume in a new process warm in every run — `claude-sonnet-5-5`
read 67,204 of 67,277 tokens, also after a commit and an untracked file. Its
exchanges were short ([docs/334 plan, "Probe"](../334-reattach-resident-claude/plan.md#probe)).
On 2026-10-20 the same harness ran a long conversation (Sonnet 5.5, four
turns of file reads, a write and a commit, 179K tokens) and then waited 12
minutes: the first turn of a new process that resumed it read 179,159 tokens
from the cache and wrote 79, and the old process read 179,218 and wrote 79.
The user then kept requirement 13 on 2026-10-20 with a new reason: an update
usually changes the CLI version or ShipIt's instructions, which makes the
cache cold. The T rows below contradict that reason, and the user removed
the exception the same day (requirements.md, receipts).

**The planning#704 probe (2026-10-20)** repeated it on a large, tool-heavy
conversation, the same way: CLI 2.1.300, `claude-sonnet-5-5`, the user's
subscription, a clone of this repository, ShipIt's instructions, one worker
per process. A process was stopped by killing it and stopping its worker;
the next resumed the conversation in a new worker. Per request, as the
adapter reports it (`AgentResultEvent.requests`):

| Run | Process | Tool calls | Requests | Context after | First request: cache read / write |
|---|---|---|---|---|---|
| A1 | new session: read 4 source files | 4 | 5 | 173,189 | 14,128 / 52,961 |
| A2 | same process: 2 greps, a glob, 2 file reads | 5 | 6 | 229,476 | 173,187 / 192 |
| A3 | same process: 3 file reads | 4 | 4 | 303,087 | 229,474 / 165 |
| B1 | **new process, first resume** | 0 | 1 | 303,135 | **303,085 / 48** |
| B2 | same new process, next turn | 0 | 1 | 303,183 | 303,133 / 48 |
| C1 | **new process, 50 minutes after B2, `/compact` as its first message** | 0 | 1 | 3,526 | **303,133 / 5** |

C1 is the fire of a woken container. The CLI reports no usage for a
compaction turn (the result carries zeros), so its row comes from the
transcript's `cost-state` totals, before and after C1; those totals match
every other row's sum. The summary request also had 2,038 uncached input
tokens (the compaction instruction) and wrote 2,929 output tokens.

Then a smaller conversation (94K tokens, one file read) built on CLI 2.1.293,
the version pinned before 2.1.300, and resumed in a new process each time:

| Run | First resume in a new process | cache read / write |
|---|---|---|
| T1 | CLI 2.1.293 | 94,207 / 72 |
| T2 | CLI 2.1.300 | 94,254 / 73 |
| T3 | CLI 2.1.300, one line added to ShipIt's instructions | 94,302 / 73 |

**Why a new process is warm, also after an update.** The CLI writes a
`prompt_snapshot` attachment into the conversation's transcript — the system
prompt, ShipIt's appended instructions included, the tool list and the CLI's
first line — and a `credential_org` attachment with the account's
organization. A resumed conversation's request is built from the snapshot, so
its prefix stays the same across processes, containers, CLI versions
(2.1.293 → 2.1.300) and ShipIt builds. The control for T3: asked for a code
word added to ShipIt's instructions, the resumed conversation answered "NONE",
and a new conversation with the same instructions answered it.

**What still makes a new process cold:** another account (organization),
another model, an expired cache. Piece 2 checks the model and the expiry,
piece 3 step 4 the account.

**A finding beyond this feature:** a resumed conversation does not get
ShipIt's changed instructions; only a new conversation does.

**Consequence for piece 3.** A ShipIt update no longer ends a session's idle
compaction: the fire starts the container, and the new process reads the
conversation warm (req 13). Piece 3 step 4 checks the account, not the
process.

**Consequence beyond this feature.** A restart of a Claude session's process
— a container stopped to free memory, a ShipIt update — does not make the
next turn cold inside the cache lifetime; an account move does. Req 8's
compact-before-stop now saves the container start that a later fire would
need (piece 3 step 3).

### 1b. Across processes on the other harnesses — Codex warm, OpenCode warm after planning#701

Probed on 2026-10-19 by child sessions running each harness (a Claude
session cannot run their CLIs). The raw numbers and commands are on
planning#699. Each probe ran three one-request turns, each in a new process:
A new, B resumed after a scratch commit, C resumed again.

| Harness (route, model) | A input | B cached | C cached | Verdict |
|---|---|---|---|---|
| Codex 0.160.1 (ChatGPT subscription, `gpt-6-luna`, a fresh `codex app-server` per turn, `thread/resume`) | 17,745 | **17,536** | 17,536 | warm across processes |
| OpenCode 1.18.34 (OpenAI through the ChatGPT account route, `gpt-6-luna`, `opencode run --session`) | 20,374 | 3,584 | **0** | cold |
| Grok | — | — | — | not checked: no configured role runs Grok |

**Codex:** the first resume in a new process read 98.8% of the previous
input from the cache. Idle compaction works on Codex as designed.

**OpenCode: ShipIt itself breaks the cache.** `opencode/adapter.ts:156` writes
the system prompt to `/tmp/opencode-system-prompt-${Date.now()}.md` on every
turn, and OpenCode puts that path into the text the model reads
(`Instructions from: <path>`, `session/instruction.ts` at v1.18.34). The
prefix therefore changes on every turn, so every OpenCode turn in ShipIt reads
its conversation cold — not only an idle compaction. Not yet shown: that a
stable path makes OpenCode warm across processes. That needs a control run
with a fixed path.

**Decided (requirements.md, 2026-10-19):** OpenCode stays in scope once the
path is stable and a control probe is warm (req 14; the fix is planning#701).
Grok is out until a probe shows it warm (req 15).

**planning#701 merged (PR #3239), and its control probe was warm.** The
instruction-file path is now a SHA-256 key over the agent home, the workspace
and the prompt (`opencode/turn-files.ts`), so it no longer changes per turn.
Same setup as above (OpenCode 1.18.34, `openai/gpt-6-luna`, the ChatGPT
subscription route, a new CLI process per turn): A total input 20,399 (cache
read 3,584); B, resumed after a scratch commit, 20,423 (cache read 20,224 —
99.1% of A); C, resumed with no change, 20,447 (cache read 20,224). The full
table and commands are in PR #3239. OpenCode then takes the ordinary rules:
on an OpenAI model 30 minutes, on an Anthropic model the 5-minute default, so
no deadline (req 11).

### 2. `cache_creation` reaches ShipIt on stream-json — true

Every main-thread `assistant` message and the `result` carried
`usage.cache_creation` with the split filled in, for example
`{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 10174}` (A1). A
subscription session wrote 1-hour entries in every run. Piece 1 can rely on
it.

## Known limits

- **An orchestrator restart during a woken compaction** forgets the mark,
  which lives in memory: that container then stays, as any idle session's
  does, until the enforcer reclaims it.
- **A container that gets ready just before the cache expires.** The fire
  waits for the worker and the install and checks the expiry again, but the
  compaction's first request comes seconds later; a cache that expires in
  those seconds is read cold.
- **A worker from before docs/240** reports no turn liveness, so the first
  connect cannot tell an idle process from none, and the fire's check for a
  process it could not take over does not see it. A compaction there
  replaces the process, as the user's next turn would. Such a container
  survives an update only while it runs that process.
- **A wake that replaces a stale runner** (its container gone, its preview
  still running) disposes it with its preview, as every wake does
  (`bootSessionRunner`); the new runner starts the preview again, and the
  stop after the compaction keeps it (`previewBefore`).
- **The snapshot is the CLI's.** A CLI version that stops building a resumed
  request from the stored snapshot would make a new process cold again.
  Nothing detects it before the compaction; its usage row would show it.
- **A turn adopted after a restart arms nothing.** Its events are replayed,
  so their arrival times say nothing about when its requests ran; anchoring
  on them could put the deadline after the cache is cold. The session's next
  turn arms again.
- **A retry after a restart.** A failed attempt is not retried, except once
  more if the orchestrator restarts before `expires`: boot re-derives from the
  same ordinary row, because the failed compaction left no card.
- **The user may be at the composer.** A user who has read and typed for 54
  minutes sees the compaction start, and their message waits for it.
- **An account move during the turn.** The fire compares the deadline's
  account with the one a turn would take (piece 3 step 4). A move decided
  only during the compaction turn — a refusal at spawn that fails the turn
  over (docs/260) — still reads the new account's cold cache.
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
- **Skip a session whose container a ShipIt update destroyed** (req 13 until
  the user's last 2026-10-20 answer). Its first reason rested on the
  confounded first probe, its second on a premise the T rows of "Verify
  first" 1 contradict.
- **Drop the fire when the update changed the prompt** (another CLI version,
  other instructions). A new process read the conversation warm across both:
  the CLI builds a resumed request from the stored snapshot.
- **Keep the resident-process check next to the account check.** It dropped
  compactions that a new process runs warm (piece 3 step 4).
- **Check the memory budget before a wake.** Req 8 stops other idle sessions
  before a waiting one, and no other wake checks the budget.
- **Tell the compaction from other turns by the turn epoch**, as
  `compactingToReclaim` does. A retry inside the compaction turn moves the
  epoch too, and a fire dropped after its wake leaves room for one turn
  unseen; `lastUsedAt` moves for every turn but a silent compaction.
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
was false; two known limits narrowed req 1 and req 2 without the user. Both
went to the user: the question hold became the exception of req 12 (piece
3a), and the stopped-container case — after the probe — the exception of req
13 (piece 3). From the simplification brief: the result-level usage change
and the new dispatch flag are gone.

ShipIt reviewer run f9be17c0-99d9-4387-aa48-49780668a2e6 (Codex) reviewed the
implementation. Accepted and fixed: a silent-compaction mark sent behind a
turn the CLI started could land on the next ordinary turn (the worker now
keeps the mark only for the turn the message starts); the enforcer forgot a
visited session only during a pass over budget, and could count a stopped
compaction twice in one pass; the 200K floor was not checked again at the
fire; an adopted turn anchored on its replay time; boot re-derived a deadline
for the session's current model, not the turn's (the anchor row now carries
the harness and model). Kept as a known limit: an orchestrator restart that
keeps the build ends idle compaction for resident Claude sessions
(planning#700). The user made it an exception to reqs 1 and 2 (req 16).

A follow-up run, 2c413c1f-6b39-4bee-92e4-585a2f27f4ff (Codex), found three
more, all fixed: a replaced runner or container kept the old reclaim record
(it now also holds the container id and the turn epoch); the compacting step
stopped every compacted session, not only as many as memory was short of; a
cache lifetime one harness or model saw counted for another on the same
credential (the reading is now scoped to the harness and model). It agreed
the restart limit's reasoning holds, and that it left reqs 1 and 2 partly met
— which requirement 16 now records as an exception.

ShipIt reviewer run 2dd061e5-9eb9-441a-b762-c79c425f1762 reviewed planning#704
(the wake, the stop again, the account check). Accepted and fixed: without
the resident check, a failed take-over let a new process end the worker's
process and its background tasks (now dropped, piece 3 step 3); an
over-budget pass could stop a session while its fire booted it
(`isStarting`); the account prediction used the anchor's route instead of
the route a turn would keep (now `selectTurnRoute` itself); the turn-epoch
test took a retry of the compaction for use and could miss one other turn
(now `lastUsedAt`, read before the wake); a container id read before the
container existed lost the mark (the woken mark has none now); the stop
also stopped a preview that ran before the wake (`previewBefore`); a long
install could push the compaction past the cache's expiry (the fire now
waits for it and checks again).

A follow-up run, dc8f5393-069d-4d92-b562-911ad2351a8b, confirmed those fixes
and found more. Fixed: the route prediction kept a resident's route that a
dispatch retires for failover (now the plain selection, which is what the
dispatch moves to); a slow container creation passed the 30 s boot wait
with no install to wait for (the fire now waits for the worker too); a
woken mark was forgotten while its container was still being created; the
stop's dispose-with-preview code was duplicated (`disposeRunner`). Kept as
known limits: a worker from before docs/240, and a wake that replaces a
stale runner with its preview, which every wake does. Not changed: a stalled
workspace restore keeps `isStarting` set, but no container exists then, so
it holds nothing.

## Docs to change

- `src/server/shipit-docs/wiki/settings-and-accounts.md` — the Advanced row.
- `src/server/shipit-docs/wiki/chat.md` — an idle session can be compacted
  while the setting is on; a stopped container is started for it and stopped
  again (planning#704).

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/idle-compaction.ts` (new) | `HARNESS_CACHE`, lifetime, deadlines, the one timer, boot re-derivation, `fire`, `isWaiting`, the account check, the woken marks |
| `src/server/orchestrator/wake-session.ts` | `bootSessionRunner`: the wake path's container start, shared by `wakeSessionWithTurn` and the fire |
| `src/server/orchestrator/session-agent-env.ts` | `nextTurnRouteId`: the route a turn's preparation would select now |
| `src/server/orchestrator/container-session-runner.ts`, `session-runner.ts` | `whenReadyForAgent`: the worker and the install a fresh agent process waits for |
| `src/server/shared/types/claude-types.ts`, `session/agents/claude/adapter.ts`, `shared/types/agent-types.ts` | `cache_creation` on per-message usage; `cacheTtl` on `AgentResultEvent`; the silent-compaction mark on the agent and the worker wire types |
| `src/server/shared/database.ts`, `src/server/orchestrator/usage.ts` | `usage_turns.cache_ttl`, `cache_anchor_at`; route-scoped lifetime; `onAnchoredTurn`; newest anchored row per session for boot |
| `src/server/orchestrator/ws-handlers/agent-listeners.ts` | The anchor (last tool result); no anchor for a compaction or a turn that read nothing; skip `touchUnlessResolved` and `last_turn_errored` for a silent compaction |
| `src/server/orchestrator/turn-executor.ts` | Skip `track`, unmute and `recordTurnEnd` for a silent compaction; mark its process for the worker |
| `src/server/session/agent-controller.ts`, `orchestrator/proxy-agent-process.ts`, `container-session-runner.ts`, `worker-http.ts`, `turn-adoption.ts` | The worker keeps and reports the silent-compaction class; adoption restores it |
| `src/server/orchestrator/services/agent-compaction-request.ts` | Export the busy check, with the question hold as a separable arm |
| `src/server/orchestrator/turn-admission.ts`, `session-runner.ts` | `isSilentCompaction`; admit a silent compaction past the answer hold (req 12) |
| `src/server/orchestrator/idle-enforcer.ts` | Waiting sessions last; compact instead of stop; `compactingToReclaim`; stop a woken container again |
| `src/server/shared/settings-catalogue/global-settings.ts`, `orchestrator/credential-store.ts`, `services/misc.ts` | `advanced.idleCompaction` |
| `src/server/orchestrator/bootstrap-managers.ts`, `startup-monitors.ts`, `index.ts` | Build the service, subscribe it to the usage rows, re-derive at boot after adoption, stop its timer on close |
