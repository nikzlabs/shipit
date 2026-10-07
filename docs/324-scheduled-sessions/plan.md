---
issue: planning#640
title: Scheduled sessions — design
description: A stored session-start description plus a time rule; the agent proposes schedules in chat, the user confirms and edits them in Settings, and runs get their own sidebar view.
---

# Scheduled sessions — design

Implements [requirements.md](./requirements.md), cited as `(req N)`. Prior art
and the code facts behind the choices: [research.md](./research.md). UI sketch:
[mockup.html](./mockup.html).

## What this builds

1. **A schedule** — a stored session-start description (target, parameters,
   prompt) plus a time rule. Stored by the orchestrator, not in a repository,
   because a sandbox schedule has no repository (req 3).
2. **A way to make one by chat** — `shipit schedule propose` posts a card; the
   schedule exists only after the user confirms it (reqs 8, 9).
3. **Settings → Schedules** — list, editor, run history, Run now / Pause /
   Delete, Stop on a run (reqs 10, 11, 19, 24, 32, 33).
4. **A scheduler** — a 30-second pass in the orchestrator that starts due runs
   through the existing headless session start (reqs 1, 2, 14–18, 23, 29).
5. **A "finished" decision** for runs (reqs 22, 31, 33), and how it reaches the
   sidebar and "needs you".
6. **A Scheduled sidebar view** — the regular grouped list, filtered to runs
   (reqs 20, 21).
7. **Notes folders** — one per run, readable by later runs, by the user, and by
   other sessions the user approves (reqs 13, 27, 28, 30).

Nothing here adds an element to the message input panel (req 12).

## One session-start description (reqs 4, 5, 11)

The composer applies its choices to a warm draft session one message at a time,
and keeps the permission mode in the browser (research.md, "ShipIt facts"). A
schedule needs the same choices as data. So the choices get one type, in
`src/server/shared/types/`:

```ts
/** Every choice a user makes when starting a session, apart from where and what. */
interface SessionStartParams {
  role?: string;
  agent?: AgentId;
  model?: string;
  serviceId?: string;
  billingMode?: BillingMode;
  reasoning?: string;
  permissionMode?: PermissionMode;
  networkMode?: boolean | null;   // true contained, false open, null inherit
  sshHosts?: string[];
  armAutoMerge?: boolean;         // Quick Capture's "Auto-merge when ready"
}

type SessionStartTarget =
  | { kind: "repo"; repoUrl: string }
  | { kind: "sandbox"; capabilities: SessionCapabilities };

interface SessionStartSpec {
  target: SessionStartTarget;
  params: SessionStartParams;
  prompt: string;
}
```

The spec is stored as JSON, so storing a new key needs nothing. Req 5 is held at
the two places a key can be forgotten:

- **Applying it.** The session start applies parameters through
  `START_PARAM_APPLIERS: { [K in keyof SessionStartParams]-?: Applier<K> }`,
  and the cards and the Settings list describe them through
  `START_PARAM_LABELS` of the same shape. A key added to the type does not
  compile until it is applied and described.
- **Reaching the type at all.** A guard test lists every input through which a
  user picks a session-start choice today and fails on one that maps to no
  `SessionStartParams` key: the composer's `set_*` WebSocket messages and URL
  seed keys (`useSessionWebSocket.ts`), the per-message `permissionMode`, the
  `POST /api/sessions/headless` body keys, and the HTTP routes the composer
  and Session settings use for session choices — `PUT /api/egress/session/:id`
  (network mode) and `PUT /api/sessions/:id/ssh-hosts`. The sandbox routes
  (`POST /api/sessions/sandbox`, `PUT /api/sessions/:id/capabilities`) map to
  the target.

`CreateHeadlessSessionOptions` takes `SessionStartParams` instead of its own
copy of the fields, so Quick Capture and runs share one path.

The Settings editor is built from the composer's own controls — `RoleSelector`,
`HarnessSelector`, `ModelSelector`, `ReasoningSelector`,
`PermissionModeSelector` — and the sandbox grants are
`SandboxCapabilityToggles`, which `SandboxDialog` and Session settings already
share. One control can set several keys (the model picker sets the model,
service and billing mode), so the editor's coverage is checked by a component
test that edits every key. A role replaces the harness, model and reasoning
controls as it does in the composer (docs/272-user-selectable-roles), and is
optional (req 6).

## Storage

Orchestrator SQLite, migrations in `database.ts`:

- **`schedules`** — `id`, `name`, `enabled`, `timing` (JSON: a preset or a cron
  expression), `time_zone` (IANA name), `spec` (JSON `SessionStartSpec`),
  `active_since`, `needs_user_reason` (req 18), `created_at`, `updated_at`.
- **`schedule_runs`** — `id`, `schedule_id`, `slot_at` (null for Run now),
  `spec` (the copy this run starts with), `outcome` (`starting` | `started` |
  `skipped` | `failed`), `reason`, `session_id`, `result` (the one-line result,
  copied when the run finishes, so the history outlives the session),
  `started_at`, `created_at`; unique on (`schedule_id`, `slot_at`). This is the
  run history (req 24) and the record of which slots were handled.
- **`sessions`** gains `schedule_id`, `schedule_run_id`, `run_finished_at`,
  `run_stopped_at`, `last_turn_outcome` and `schedule_notes_grants`. The run id
  is stamped when the session is created; it is the first dispatch's
  `deliveryId` too (recovery, below). `last_turn_outcome` (`ok` | `errored` |
  `quota-refused`) is the persisted end of the last turn, which "finished"
  needs (req 31) and which today lives only inside the turn executor.

The run row holds the spec it starts with, so an edit applies from the next run
and never changes a run in progress (req 19), also when recovery restarts it.

## Cards: proposals and approvals (reqs 8, 9, 28, 30)

Two cards ask the user: the **schedule proposal card** (req 9) and the **notes
access card** (req 28). Their bodies are new. Their mechanics already exist for
docs/299's settings proposals — a persisted card (docs/188-persist-transcript-cards),
an atomic claim of the user's decision that updates the card's history record
(`claimSettingsProposal`, `settings-proposal.ts`), and a durable outcome notice
on the agent's next turn (`prepareSettingsOutcomeNotice`,
`settings-outcome-notice.ts`). Both are written for settings today: the claim
updates the settings card's own transcript field, and the notice reads settings
rows and points the agent at `shipit settings get`. So they are generalized
into a claim and a notice keyed by card kind, with settings as the first kind
and these two cards as the next, rather than copied. A decision on a card whose
record no longer exists is refused before anything is written. The decision
routes are browser-only, so a container cannot confirm its own proposal or
grant its own access.

### Making and changing a schedule by chat (reqs 8, 9)

Agent CLI, in the session shim beside `shipit settings`:

- `shipit schedule list` — the schedules with their ids.
- `shipit schedule propose [--id <id>] --file -` — a new schedule, or a change
  to one, as YAML: `name`, `when` (a preset or `cron:`), optional `timeZone`,
  `target`, `params`, `prompt`, `enabled`. With `--id`, only the fields the YAML
  gives change, so "move it to 10:00" cannot reset the prompt or the grants by
  omission.

The orchestrator validates a proposal the way the Settings editor does
(repository known, role exists, model valid, cron parses, the req 17 check
below) and refuses it by name. A valid proposal posts the proposal card: every
value through `START_PARAM_LABELS`, or before → after for a change; the next
three run times in the browser's time zone; **Confirm**, **Open in Settings**
and **Cancel**. If the proposal names no time zone, Confirm sends the
browser's. A change card records the schedule's `updated_at`; if the schedule
changed since, Confirm refuses, because the card's "before" is no longer true.
The command needs no repository, so it works in a sandbox too.

## Settings → Schedules (reqs 10, 11, 19, 24, 32, 33)

A `schedules` section registered beside `roles` in
`Settings/components/registry.ts`.

- **List**: name, when (in words), target, next run, and a state — Paused, or
  the req 18 reason. Row actions: Run now, Pause / Resume, Edit, Delete.
- **Editor**: name; when — a preset (hourly, daily, weekdays, weekly) with time
  and weekday, or a cron field; time zone (default: the browser's); target — a
  repository, or Sandbox with its grants; the parameter controls above; the
  prompt; the next three run times.
- **Runs**, newest first. Each row shows the time, a state, a one-line result,
  links to the session and its notes (req 27), and **Stop** while the run is
  not finished (req 33). States: Starting and Skipped and Failed from the run
  row; Running, Needs you, Finished or Stopped from the session; "Session
  deleted" when it is gone. The one-line result is the run's status-card
  `lastTurn` (docs/303) when there is one, or else the first line of the run's
  last agent message — the status card is off by default
  (`advanced.sessionStatusCard`). It is copied into the run row when the run
  finishes, so it stays after the session is deleted. Skipped and failed rows
  show their reason.

**Delete (req 32)** removes the schedule and its notes and keeps its run
sessions. It is refused while any run of the schedule is not finished —
archived runs included, since req 32 says any — and the refusal lists those
runs, each with **Stop**. It is also refused while a stopped run's agent is
still winding down (`agentBusy`), so no notes folder is removed under live
work. A run whose schedule was deleted keeps its banner, which then says so and
has no links.

**Stop (req 33)** writes `run_stopped_at` and interrupts the run's turn if one
is going. It is reached four ways: the chat's own stop control inside the run —
`handleInterruptAgent` (`ws-handlers/misc-handlers.ts`), which the
`interrupt_agent` message reaches, writes `run_stopped_at` when the session is
a run — and **Stop** on the run's row, in the Delete refusal, and in the run's
banner. The last three also work while no turn is going, for a run that waits
for an answer. Stop on a `starting` row cancels the start before its dispatch
(the scheduler re-checks, below).

A stopped run takes no automatic turn until the user's next turn in it: the
docs/322 admission gate, which holds automatic turns while a question waits,
also holds them while `run_stopped_at` is later than the last user turn. That
covers quota continuation, whose own check reads only archive state and
`lastUsedAt` (`quota-continuation.ts`), and every other automatic turn the
same way. A user turn after the stop makes the run active again, so "stop,
then tell the agent to do something else" works as in any session (req 7).

## The scheduler (reqs 1, 2, 14–18, 23, 26, 29)

`ScheduleRunner`, started from `startup-monitors.ts`: one pass at startup, then
every 30 seconds, like the idle enforcer, with an in-flight flag so two passes
never overlap. Cron evaluation uses `croner` 10.0.1 (published 2026-02-01, no
dependencies, so it passes `check-deps`); presets compile to cron (daily 09:00
is `0 9 * * *`, weekdays `0 9 * * 1-5`).

**Run times come from one forward walk, never from `croner`'s `previousRuns`
or `nextRuns`.** Both are wrong on clock-change days (checked 2026-10-07): at
03:00 Berlin time on the spring day, `previousRuns(1, now)` returns 03:30 that
day, a time that has not come yet; `nextRuns(n)` lists a moved spring time
twice; and `nextRun` from inside the repeated autumn hour returns an earlier
instant. So `runsAfter` (`shared/schedule-timing.ts`) steps `nextRun` from 3
hours before its start point and keeps only the instants after it. A pass walks
from the later of `active_since` and the schedule's latest non-null `slot_at`
(`dueSlots`: the latest due slot, plus a count and range of the missed ones).
The walk moves a missing time by the size of the clock change and runs a
repeated time once (req 29); tests pin Berlin and Lord Howe Island's 30-minute
change, where the repeated time runs at its second occurrence. The same
module's `nextRuns(n)` gives the next run times for the cards and the editor.

**One queue per schedule.** Every start — due or Run now — and every change to
the schedule — edit, pause, resume, delete, Stop on a `starting` row — goes
through one queue per schedule, so none of them interleave. A pass starts due
runs one at a time; ten schedules due at 09:00 start one after another, which
also spreads container starts on the host.

Each pass, for each enabled schedule:

1. **Collect** the due slots (above). None → nothing to do.
2. **Missed slots.** When more than one slot is due — ShipIt was down, or busy
   past a slot — only the latest runs (req 15). The others
   are recorded as one skipped row ("3 runs missed between … and …"), so no
   slot disappears without a trace.
3. **Claim** the latest slot by inserting a `starting` row with a copy of the
   spec. The unique constraint makes a second claim of the same slot fail.
4. **Skip** — mark the row `skipped` with the reason — when another run of the
   schedule is still going (req 14): its row is `starting`, or its session's
   runner has `agentBusy` true (a turn, background tasks, sub-agent spawns,
   post-turn work, or an install), or after a restart its worker is still being
   re-attached (`restart-turn-reattach.ts`). A run that waits for an answer
   (`awaiting_answer`) never counts as still going, even with background work
   left (req 23). The one-hour rule (req 17) counts scheduled times: the save and propose check below already keeps a schedule's
   times an hour apart, so it needs no check here.
5. Otherwise **start** the run (below).

`active_since` is set on create, on resume, and on any edit of the timing, so
slots that passed while a schedule was paused, or before its time changed, do
not run.

**One hour apart (req 17).** Saving or proposing a timing whose run times, as
the schedule gives them, include two less than an hour apart is refused — for
example, the cron's next 100 times evaluated in UTC. Clock changes are not
counted, so a timing is accepted or refused the same on every date. On a day
with a 30-minute clock change, a moved run (req 29) can come 30 minutes before
the next one; the overlap rule (req 14) still skips the next while the moved
run is going. Run now is not counted (req 26).

**Run now (req 26)** goes through the queue without steps 1–4. Before it
starts, the control checks every run of the schedule — archived ones included
— with `isRunFinished` (below); if any is not finished, it shows a warning that
lists them, with **Run anyway** and **Cancel**. A Run now run is an ordinary
run of the schedule, so a slot that comes due while it is still going is
skipped by step 4.

### Starting a run — `startScheduledRun(row)`

1. **Pre-flight**, before anything is created, so the common failures have a
   clear reason: the repository is still added and trusted
   (`assertSessionCanDispatch` would refuse it at dispatch), the role still
   exists, the model is still offered.
2. `createHeadlessSession` with the row's spec. It gains:
   - a `target` union. The sandbox branch composes `createSandboxSession` with
     the same parameter application and dispatch, since `createSandboxSession`
     today takes no prompt, model or role;
   - `permissionMode` on the first dispatch, which already has the slot and
     passes `undefined` today (`headless-sessions.ts`);
   - `networkMode`, applied before the container starts, because a sandbox's
     Network and Docker grants take effect only at container start
     (`sandbox-capabilities.ts`); and `sshHosts`, applied before the first
     dispatch — for a repository target once the container runs, because a
     claimed warm session already has one, through the live firewall reload
     that Session settings uses;
   - `title` = "*schedule name* · *date*", with AI naming off, so the history
     and the sidebar name runs the same way. Sandboxes never graduate, so the
     title must be set at creation;
   - `scheduleId` and `scheduleRunId` on the session row;
   - the run id as the first dispatch's `deliveryId`, and the dispatch handle
     returned to the caller instead of dropped;
   - a fetch of the base before the clone, as `spawnChildSession` asks for. It
     is best effort there (`refreshClaimedSession` logs a failure and goes on),
     and the same is accepted here: the agent can fetch, and failing a run for a
     slow fetch would be worse.
3. **Re-check, then dispatch.** Inside the queue, just before the dispatch, the
   start re-reads the schedule and the row: a schedule paused or deleted, or a
   row stopped, since the claim cancels the start, and the row becomes `failed`
   with that reason.
4. **Watch the first turn** through its handle. A dispatch that fails during
   setup does not throw to the caller; `dispatchOnRunner` reports it through
   the settlement (`turnErrored`, `session-runner.ts`). A quota refusal can
   settle as `completed` with the refusal only in the text; the executor's
   refusal detection (`turn-executor.ts`, docs/306-quota-continuation) writes
   `last_turn_outcome = quota-refused` once its retries are spent. Either way
   the row becomes `failed` with the reason, and the session is linked.

The first dispatch is not `automatic`: it is a new session's own task, so the
docs/322 hold does not apply to it.

**Recovery after a restart.** The startup pass finishes `starting` rows:

- no session with that `schedule_run_id` → start the run from the row's spec;
- a session → the runner's delivery tracking for the run's `deliveryId`
  (`hasDelivery`, `rebindDelivery`, `session-runner.ts`) and the session's
  chat history tell whether the prompt reached it. Delivered → the row becomes
  `started`, and the turn is the business of `restart-turn-reattach.ts`, as for
  any session. Not delivered → the row's prompt is sent into that session.

In `RUNTIME_MODE=local` there is no worker to re-attach; a run whose turn was
cut off by a restart there is marked `failed` ("ShipIt restarted during the
run").

**Failed starts (req 18)** set the schedule's `needs_user_reason`. It shows in
Settings → Schedules, at the top of the Scheduled sidebar view, and in "needs
you" (req 31); the Scheduled view's control carries a warning mark. The next
successful start, an edit, or a resume clears it — each is the user acting on
the reason, and a reason that still holds comes back on the next start.

## Finished runs (reqs 22, 31, 33)

`isRunFinished` is the requirement's "finished", and reqs 26, 32 and 33 use
exactly it. A run the user stopped (`run_stopped_at`, req 33) is finished until
a user turn after the stop. Otherwise a run is finished when all of these hold:

- it is not awaiting an answer (`awaiting_answer`, docs/322);
- it has no manual steps: with the status card on, its card has no `needsYou`
  entries;
- it has no open PR;
- its last turn did not end in an error (`last_turn_outcome`, req 31).

With the status card off — the default — a run has no manual steps to show, so
anything the user must act on has to be a question. The run's first-turn block
says so (below): a run that only *writes* "please review #3060" in its last
message would otherwise be filed as finished.

ShipIt decides it again, and writes `run_finished_at` or clears it, when one of
its inputs changes **and the runner is not busy**: when a turn's post-turn hold
is released (`endPostTurnWork`, the last thing a turn does — after the commit,
the PR flows, `signalIdleIfIdle` and quota detection), when the runner's
background work drains, when the PR poller sees the run's PR change state, when
the user answers, and on Stop. While the runner is busy nothing is decided, so
a PR update in the middle of a turn changes nothing until the turn is over.

**Where "finished" shows.** Sidebar placement is not the same question as
"finished". A regular session goes under **Recently resolved** only when its PR
resolved *and* it is not pinned, not workspace-blocked, not holding a preview
reservation, and has no unfinished descendant (`isOwnWorkFinished`,
`doneSessionTest`, `session-resolution.ts`). Runs follow the same rule — req 20
asks for the same UI — with `isRunFinished` in place of the PR test:

- `isWorkResolved(session)` is the stored `isRunFinished` decision
  (`runFinishedAt` set) for a run and `isTerminalPrResolved` for any other
  session; `workResolvedAt` is `runFinishedAt` or `resolvedAt`. The client
  cannot work out `isRunFinished` itself, so the stored decision is what the
  sidebar reads.
- `isOwnWorkFinished` uses `isWorkResolved`, so `doneSessionTest` — Recently
  resolved, the sidebar cap, and the idle enforcer's container stop (docs/316)
  — treats runs like sessions. `touchUnlessResolved` (`sessions.ts`) and the
  cap's ranking in `filterVisibleInSidebar` use `isWorkResolved` and
  `workResolvedAt`.

**"Needs you" (reqs 21, 31).** `computeAttentionReason` (`useAttentionInfo.ts`)
stays silent for a merged or closed PR, pending checks and armed auto-merge,
even when the session is not resolved. For a run, a waiting question, an error,
or a manual step is reported first, before those silences, so a run whose PR
merged but whose question is open still shows. The attention call sites
(`SessionItem.tsx`, `useAttentionSessions.ts`, `useAttentionNotifications.ts`)
pass `isWorkResolved` instead of `isTerminalPrResolved`.

The "needs you" view lists sessions today. A schedule with a
`needs_user_reason` becomes a row of its own: `AttentionSessionList` takes a
union of session rows and schedule rows, keeps them in one arrival order with
the same append-only and sticky rules (docs/260-attention-sidebar-view reqs 7
and 8), and counts them in the toggle's number. A schedule row shows the name
and the reason and opens Settings → Schedules at that schedule.

## The Scheduled sidebar view (reqs 20, 21)

- `SidebarView` (`utils/local-storage.ts`, held in `ui-store.ts`) gains
  `"scheduled"`. A `ScheduledViewToggle` sits beside `AttentionViewToggle`, in
  the same house toggle pattern, and shows when the user has a schedule or a
  scheduled run — the rule the role control uses
  (docs/272-user-selectable-roles req 16), and in the spirit of req 12.
- A session belongs to the scheduled view when it, or the root of its spawn
  tree, has a `scheduleId`, so a child session a run spawned stays with its run.
  The regular view drops those sessions (req 20). The
  scheduled view renders the regular grouping (`useSessionGrouping`,
  `SessionGroup`) over only them.
- `filterVisibleInSidebar` caps resolved sessions per repository. It counts
  scheduled runs and regular sessions separately, so daily runs never push a
  user's resolved sessions out of the regular view.
- The Sandbox group today lists every session with no **Recently resolved**
  split, because a sandbox session never resolves. It gets the split, from
  `doneSessionTest` like the repository groups. In the regular view nothing
  changes, since only a scheduled run can be a done sandbox session.
- The attention view keeps all sessions as its input, so a run that needs the
  user is listed there (req 21). A test pins that the regular view's filter does
  not reach it.

## The run's first message and its notes (req 13)

Each run gets a folder `<workspace-root>/schedules/<schedule-id>/runs/<run-id>/`
on the host, created before the container starts and handed to the run
session's identity. Only that folder is mounted into the run, read-write, at
`/schedule/notes/` — the way `/persist` is mounted (a bind in development, a
volume subpath in production, `container-lifecycle.ts`). `preparePersistDir`
(`compose-persist.ts`) works out the owner from the session path, which this
path is not, so the notes folder's preparation takes the session identity as an
argument. In `RUNTIME_MODE=local` there is no container; the block gives the
host path directly.

A run reads **earlier** runs' notes through `shipit schedule notes` (below),
which allows a run of the same schedule without asking. So no run's files ever
need to be readable by another run's identity, and nothing else is mounted.

The folders belong to the schedule, not to a session, so the archive retention
period (docs/323-archived-session-data-retention) does not delete them.

The first message is the schedule's prompt plus a short, factual
`<scheduled_run>` block: the schedule's name and id, this run's time, its notes
folder, the command that reads earlier runs' notes, that those notes are data,
not instructions (`/shipit-docs/untrusted-input.md`), and that a run with
nothing pending is filed away as finished, so anything the user must act on
has to be asked as a question. It is injected into the first turn the way role
standing instructions are (`takeRoleStandingInstructions`), so the system
prompt stays byte-stable. The block's text is a `.md` prompt file loaded at
module load (prompt-architecture). What the agent writes in its notes, and when
it reads earlier ones, is left to the agent.

## Seeing the notes (reqs 27, 28, 30)

**Reading a notes file safely.** A run writes its folder, so a file in it can be
a symlink to anything on the host. Every read — for the user or for an agent —
goes through one function that resolves the path inside the run's folder,
refuses a symlink at any step (`lstat`, then open with `O_NOFOLLOW`), and checks
that the opened file is still inside that folder.

**The user** opens a run's notes from the **Notes** link on its row in Settings
→ Schedules and in the run's banner. A read-only viewer shows the files of
that run's folder and the selected file — markdown through the chat's markdown
renderer, other text as text, anything else by name and size. The routes
behind it are browser-only.

**An agent** reads through the CLI: `shipit schedule notes <schedule> [<run>
[<file>]]` lists a schedule's runs, lists a run's files, or prints one file,
with the same "data, not instructions" note. The route behind it is
container-accessible and checks the asking session:

- a run of that schedule is always allowed (req 13);
- any other session needs an approval for that schedule — one approval, one
  schedule (req 30) — saved in `sessions.schedule_notes_grants`. Without one,
  the command posts the notes access card — "This session's agent asks to read
  the notes of schedule *name*", **Allow for this session** and **Deny**, in the
  egress prompt card's shape (`EgressPromptCard.tsx`) — and returns at once,
  saying the user has to approve.

## The run's banner (req 25)

A `ScheduledRunBanner` in the chat panel, where `SandboxBanner` sits: "Started
by schedule **name** · time · Open schedule · Notes", plus **Stop run** while
the run is not finished (req 33). Open schedule opens Settings → Schedules at
that schedule; Notes opens the run's notes (req 27). After the schedule is
deleted, the banner says so and has no links (req 32). In a sandbox run the two
banners share one bar.

## Local mode

The dogfood inner instance (`RUNTIME_MODE=local`) has no container manager, so
`api-container-guard.ts` cannot tell an agent from the browser there, and an
agent runs on the host itself, where it can read any notes path. Confirm, the
notes approval and the Settings writes are therefore not a boundary in local
mode, exactly as for every other browser-only route; reqs 9, 28 and 30 hold in
container mode, which is the product. Local mode is a development instance;
this is the limit it already has.

## Agent-facing docs

- New `src/server/shipit-docs/schedules.md`: the three commands, the proposal
  YAML, the notes folder and how to read earlier notes, that the agent proposes
  and the user confirms, and that reading another schedule's notes waits for
  the user's approval.
- `src/server/shipit-docs/wiki/sessions.md`: a "Scheduled sessions" section —
  what a schedule is, where Settings → Schedules and the Scheduled view are.

## Requirement map

| Req | Where |
|---|---|
| 1, 2 | The scheduler; `startScheduledRun` |
| 3 | `SessionStartTarget` |
| 4, 5, 11 | `SessionStartParams`, exhaustive appliers and labels, the guard test, shared controls, the editor test |
| 6 | `spec.prompt`; role optional |
| 7 | Runs are ordinary sessions |
| 8, 9 | `shipit schedule propose`, the proposal card on the generalized claim and notice |
| 10, 24 | Settings → Schedules; `result` copied into the run row |
| 12 | No input-panel change |
| 13 | The run's notes folder; earlier notes through `shipit schedule notes`; the `<scheduled_run>` block |
| 14, 23 | Scheduler step 4; `awaiting_answer` never counts as still going |
| 15 | Step 2 |
| 16, 29 | IANA zone; due slots by stepping `nextRun` forward |
| 17 | The spacing check at save and propose, clock changes not counted; catch-ups and Run now not counted |
| 18 | Pre-flight, the re-check, the first-turn watch, `needs_user_reason` |
| 19 | Run now / Pause / Edit; the spec is copied into the run row |
| 20 | `SidebarView` `"scheduled"`, membership by spawn root, separate caps, Sandbox group split |
| 21, 31 | Attention for runs reported before the PR silences; schedule rows in "needs you"; `last_turn_outcome` |
| 22 | `isRunFinished`, decided when inputs change and the runner is idle |
| 25 | `ScheduledRunBanner` |
| 26 | Run now through the queue without the checks; the `isRunFinished` warning |
| 27 | Notes viewer; the safe read |
| 28, 30 | `shipit schedule notes`, the notes access card, `schedule_notes_grants` per schedule |
| 32 | Delete, refused while a run is not finished or still winding down |
| 33 | `run_stopped_at` from the chat's stop control and the Stop links; the stopped-run gate on automatic turns |

## Rejected

- **A schedule mode in the composer** — the user ruled it out (req 12).
- **One standing session per schedule, a new turn per run** — against req 7's
  "each run is a session"; the context grows run after run, and a repository
  session's branch resets after each merge.
- **Schedules as a file in the repository** — a sandbox schedule has no
  repository, and the user chose chat (req 8).
- **A `last_slot_at` cursor written before the start** — it stops a double
  start, but a restart between the write and the start loses that run, which
  req 15 does not allow. The run row is the claim instead.
- **`previousRuns` for the due slot** — it returns a future time on a spring
  change day.
- **A spacing check over the real run times** — in a zone with a 30-minute
  clock change, it refused an hourly timing only when the change day was among
  the next 100 runs, so the same timing was refused on some dates and not
  others. The user chose to ignore the shift (requirements, req 17).
- **A `dispatched_at` timestamp** — a crash between the dispatch and the write
  makes a delivered prompt look undelivered; the runner's own delivery tracking
  is the record.
- **"Finished" from the status card's freshness** — the card is off by default,
  and any write marks it fresh, so freshness proves nothing about the end of a
  turn.
- **Mounting the schedule's whole notes tree into each run** — runs can have
  different session identities, so earlier runs' files would need to be
  readable across them; the notes command already reads them.
- **Mounting notes into an approved session** — a mount takes effect only when
  the container starts, so an approval would restart the session.
- **Registering schedules as settings** — docs/299 proposes one scalar change
  per card and rejected multi-change cards; a schedule is a whole object. Its
  claim and notice are generalized instead.
- **Auto-pause after repeated failures** — not asked for; req 18 makes every
  failure visible, and a failed start costs nothing.
- **A deterministic pre-check that skips the agent** (Devin, gh-aw) — a quiet run
  already leaves the user's sight by itself (req 22).
- **Event triggers** — scope is the clock only, for now (resolved 2026-10-07).
