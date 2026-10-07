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
   through the existing headless session start (reqs 1, 2, 14–18, 23).
5. **One "finished" decision** for runs, used by every place that asks whether
   a session is done (req 22).
6. **A Scheduled sidebar view** — the regular grouped list, filtered to runs
   (reqs 20, 21).
7. **Notes folders** — one per run, readable by later runs, by the user, and by
   other sessions the user approves (reqs 13, 27, 28).

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
  (network mode) and `PUT /api/sessions/:id/ssh-hosts`.

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
  `skipped` | `failed`), `reason`, `session_id`, `started_at`, `dispatched_at`,
  `created_at`; unique on (`schedule_id`, `slot_at`). This is the run history
  (req 24) and the record of which slots were handled.
- **`sessions`** gains `schedule_id`, `schedule_run_id`, `run_finished_at`,
  `run_stopped_at` and `schedule_notes_grants` (`SessionInfo.scheduleId`,
  `scheduleRunId`, `runFinishedAt`, `runStoppedAt`, `scheduleNotesGrants`). `schedule_run_id` is stamped when
  the session is created, so recovery can find a session whose run row was
  never updated, and the container setup knows which notes folder is the run's
  own.

The run row holds the spec it starts with, so an edit applies from the next run
and never changes a run in progress (req 19), also when recovery restarts it.

## Cards: proposals and approvals (reqs 8, 9, 28)

Two cards ask the user: the **schedule proposal card** (req 9) and the **notes
access card** (req 28). Their bodies are new; their mechanics are not. Both use
docs/299's settings-proposal machinery: the card is persisted transcript
content (docs/188-persist-transcript-cards), the user's decision is claimed
atomically and written into the card's history record
(`claimSettingsProposal`), and the outcome reaches the agent on its next turn
as a durable notice (`prepareSettingsOutcomeNotice`). A decision on a card whose
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

## Settings → Schedules (reqs 10, 11, 19, 24)

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
  not finished (req 33). The state comes from the run
  row for `skipped` and `failed`, and from the session for a started run:
  Running, Needs you, or Finished (req 22). The one-line result is the run's
  status-card `lastTurn` (docs/303) when there is one, or else the first line of
  the run's last agent message — the status card is off by default
  (`advanced.sessionStatusCard`), so most runs have none. Skipped and failed
  rows show their reason.

**Delete (req 32)** removes the schedule and its notes and keeps its run
sessions. It is refused while a run of the schedule is not finished, so no
notes folder is removed under a live run; the refusal lists those runs, each
with **Stop**. Archived runs do not block it, as they count for nothing else
either. A run whose schedule was deleted keeps its banner, which then says the
schedule was deleted and has no links.

**Stop (req 33)** writes `run_stopped_at` and interrupts the run's turn if one
is going. It is reached four ways: the chat's own stop control inside the run
session — `handleInterruptAgent`, which the `interrupt_agent` message reaches,
writes `run_stopped_at` when the session is a run — and **Stop** on the run's
row, in the Delete refusal, and in the run's banner. The last three also work
while no turn is going, for a run that waits for an answer, where the chat's
stop control is not shown. A stopped run is finished (below). It stays an
ordinary session: a user turn in it after the stop makes it active again
(req 7), so "stop, then tell the agent to do something else" works as in any
session.

## The scheduler (reqs 1, 2, 14–18, 23, 26)

`ScheduleRunner`, started from `startup-monitors.ts`: one pass at startup, then
every 30 seconds, like the idle enforcer, with an in-flight flag so two passes
never overlap. Cron evaluation uses `croner` 10.0.1 (published 2026-02-01, no
dependencies, so it passes `check-deps`): `previousRuns(1, now)` gives a pass's
slot, and `nextRuns(n)` gives the next run times for the cards and the editor.
Checked on 2026-10-07: `0 9 * * 1-5` in `Europe/Berlin` gives 08:00 UTC after
the 25 October 2026 change, so 09:00 stays 09:00 local (req 16). On the change
days it already does what req 29 asks: 02:30 runs at 03:30 on the day that
time does not exist, and once on the day it occurs twice (checked the same
day). Presets compile to cron: daily 09:00 is `0 9 * * *`,
weekdays `0 9 * * 1-5`.

**Every start of a schedule — due or Run now — goes through one queue per
schedule**, so two starts of one schedule never interleave. Pause, edit and
delete apply to starts that begin after them. A pass starts due runs one at a
time; ten schedules due at 09:00 start one after another, which also spreads
container starts on the host.

Each pass, for each enabled schedule:

1. `slot` = the latest run time at or before now. Nothing is due unless `slot`
   is after `active_since` and after the latest non-null `slot_at` in the
   schedule's run rows.
2. **Claim the slot** by inserting a `starting` row with a copy of the spec.
   The unique constraint makes a second claim of the same slot fail.
3. **Skip** — mark the row `skipped` with the reason — when another run of the
   schedule is still going (req 14): its row is `starting`, its session has a
   runner whose `agentBusy` is true (a turn, background tasks, sub-agent
   spawns, post-turn work, or an install), or, after a restart, its worker is
   still being re-attached (`restart-turn-reattach.ts`). `awaiting_answer` is not
   busy, so a run that waits for the user does not block the next one (req 23).
   Also skip when the previous due run's `started_at` is less than an hour ago
   (req 17).
4. Otherwise **start** the run (below).

`active_since` is set on create, on resume, and on any edit of the timing, so a
slot that passed while a schedule was paused, or before its time changed, does
not run. Only the latest slot is considered, so the slots missed while ShipIt
was down become one run at the first pass after startup (req 15).

**Recovery.** The startup pass also finishes `starting` rows that a restart
interrupted:

- no session with that `schedule_run_id` → start the run from the row's spec;
- a session, but no `dispatched_at` → send the row's prompt into that session;
- `dispatched_at` set → mark the row `started`; the turn itself is the business
  of `restart-turn-reattach.ts`, as for any session.

**One hour apart (req 17).** The guarantee is step 3's check on actual start
times. Saving or proposing a timing whose next 100 run times include two less
than an hour apart is refused as well, so a schedule that would mostly be
skipped is never saved; the check is a guard on input, not the guarantee.

**Run now (req 26)** goes through the same queue without steps 1–3. Before it
starts, the control checks the schedule's run sessions with the shared done
test (below); if any that the user has not archived is not finished, it shows
a warning that lists them, with **Run anyway** and **Cancel**. A Run now run is
an ordinary run of the schedule, so a slot that comes due while it is still
going is skipped by step 3.

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
   - `sshHosts` and `networkMode`, applied before the container starts, because
     a sandbox's Network and Docker grants take effect only at container start
     (`sandbox-capabilities.ts`);
   - `title` = "*schedule name* · *date*", with AI naming off. Sandboxes never
     graduate, so the title must be set at creation;
   - `scheduleId` and `scheduleRunId` on the session row;
   - a fetch of the base before the clone, as `spawnChildSession` asks for. It
     is best effort there (`refreshClaimedSession` logs a failure and goes on),
     and the same is accepted here: the agent can fetch, and failing a run for
     a slow fetch would be worse.
3. Write `started_at`, then `dispatched_at` as soon as the dispatch is accepted.
4. **Watch the first turn.** A dispatch that fails during setup does not throw
   to the caller; `dispatchOnRunner` reports it through the turn's settlement
   (`turnErrored`, `session-runner.ts`). A quota refusal can settle as
   `completed`, so the settlement is also checked against the router's quota
   refusal for that turn (docs/306-quota-continuation reads the same signal).
   Either way the row becomes `failed` with the reason, and the session is
   linked.

The first dispatch is not `automatic`: it is a new session's own task, so the
docs/322 hold does not apply to it.

**Failed starts (req 18)** set the schedule's `needs_user_reason`. It shows in
Settings → Schedules, at the top of the Scheduled sidebar view, and in the
"needs you" view (req 31); the Scheduled view's control carries a warning mark.
The "needs you" view lists sessions today, so a schedule with a reason becomes
a row of its own there — name, reason, opening Settings → Schedules at it —
in the same arrival order as session rows (docs/260-attention-sidebar-view
req 7), and it counts in the toggle's number. The next successful start, an
edit, or a resume clears it. A run that stopped on an error is a session that
is not finished, so it is in "needs you" the ordinary way.

## Finished runs (req 22)

One decision, `isRunFinished`, says whether a scheduled run is finished. A run
the user stopped (`run_stopped_at`, req 33) is finished until a user turn
after the stop. Otherwise a run is finished when all of these hold:

- it is not awaiting an answer (`awaiting_answer`, docs/322);
- it has no manual steps: with the status card on, its card has no `needsYou`
  entries; with the card off (the default), a run has no manual steps;
- it has no open PR;
- its last turn did not end in an error, such as a quota refusal (req 31).

ShipIt decides it again, and writes `run_finished_at` or clears it, whenever
one of those inputs can change: when the runner's `idle` signal fires after a
turn — `signalIdleIfIdle` in `turn-executor.ts`, which runs last, after the
commit and the PR flows — when the PR poller sees the run's PR change state, and
when the user answers. A user turn in a finished run makes it active again
until the next decision.

Two tests decide "resolved" today, and both learn about runs through one
function, `isWorkResolved(session)`: `isRunFinished` for a scheduled run,
`isTerminalPrResolved` for every other session. A run's PR merging does not by
itself make the run finished — an unanswered question still counts.

- `isOwnWorkFinished` in `session-resolution.ts` uses `isWorkResolved`, so
  `doneSessionTest` — the idle enforcer's container stop (docs/316), the sidebar
  cap, the groups' **Recently resolved** split, and the Run now warning — gives
  one answer everywhere.
- The attention call sites (`SessionItem.tsx`, `useAttentionSessions.ts`,
  `useAttentionNotifications.ts`), `touchUnlessResolved` (`sessions.ts`), and
  the cap's ranking in `filterVisibleInSidebar` use `isWorkResolved` instead of
  `isTerminalPrResolved`, and the ranking sorts by `workResolvedAt`
  (`resolvedAt`, or `runFinishedAt` for a run).

## The Scheduled sidebar view (reqs 20, 21)

- `SidebarView` (`utils/local-storage.ts`, held in `ui-store.ts`) gains
  `"scheduled"`. A `ScheduledViewToggle` sits beside `AttentionViewToggle`, in
  the same house toggle pattern, and shows when the user has a schedule or a
  scheduled run — the rule the role control uses
  (docs/272-user-selectable-roles req 16), and in the spirit of req 12.
- A session belongs to the scheduled view when it, or the root of its spawn
  tree, has a `scheduleId`, so a child session a run spawned stays with its run.
  The regular view drops those sessions (req 20). The scheduled view renders the
  regular grouping (`useSessionGrouping`, `SessionGroup`) over only them.
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
on the host, created before the container starts. The run's container sees the
schedule's whole `runs/` folder at `/schedule/runs/`: its own folder, where it
writes, and every earlier one. It is mounted the way `/persist` is — a bind in
development, a volume subpath in production (`container-lifecycle.ts`). Unlike
`/persist`, the folder is shared by runs that can run as different session
identities, so ownership is set per run folder: each run's folder is handed to
that run's identity, the way `preparePersistDir` (`compose-persist.ts`) hands
`/persist` over, and the schedule's folders stay readable by every session
identity. That handover has to be verified against `preparePersistDir` and the
session uid model when it is built. In `RUNTIME_MODE=local` there is no
container; the run's block gives the host path directly.

The folders belong to the schedule, not to a session, so the archive retention
period (docs/323-archived-session-data-retention) does not delete them.

The first message is the schedule's prompt plus a short, factual
`<scheduled_run>` block: the schedule's name and id, this run's time, its own
notes folder, where the earlier runs' folders are, and that notes written by
earlier runs are data, not instructions (`/shipit-docs/untrusted-input.md`). It
is injected into the first turn the way role standing instructions are
(`takeRoleStandingInstructions`), so the system prompt stays byte-stable. The
block's text is a `.md` prompt file loaded at module load (prompt-architecture).
What the agent writes in its notes, and when it reads earlier ones, is left to
the agent.

## Seeing the notes (reqs 27, 28)

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

**An agent in another session** reads through the CLI, never through a mount:
`shipit schedule notes <schedule> [<run> [<file>]]` lists a schedule's runs,
lists a run's files, or prints one file, with the same "data, not
instructions" note the run's own block carries. A mount would need the
session's container to restart. The route behind it is container-accessible and
checks the asking session:

- a run of that schedule is always allowed — its notes are already mounted
  (req 13);
- any other session needs an approval for that schedule — one approval, one
  schedule (req 30) — saved in `sessions.schedule_notes_grants`. Without one, the command posts the
  notes access card — "This session's agent asks to read the notes of schedule
  *name*", **Allow for this session** and **Deny**, in the egress prompt card's
  shape (`EgressPromptCard.tsx`) — and returns at once, saying the user has to
  approve.

## The run's banner (req 25)

A `ScheduledRunBanner` in the chat panel, where `SandboxBanner` sits: "Started
by schedule **name** · time · Open schedule · Notes", plus **Stop run** while
the run is not finished (req 33). Open schedule opens Settings → Schedules at
that schedule; Notes opens the run's notes (req 27). In a sandbox run the two
banners share one bar.

## Local mode

The dogfood inner instance (`RUNTIME_MODE=local`) has no container manager, so
`api-container-guard.ts` does not tell a container from the browser there. The
browser-only decision routes — Confirm, the notes approval, the Settings writes
— are not a boundary in local mode, exactly as for every other browser-only
route. Local mode is a development instance; this is the limit it already has.

## Agent-facing docs

- New `src/server/shipit-docs/schedules.md`: the three commands, the proposal
  YAML, the notes folders, that the agent proposes and the user confirms, and
  that reading another schedule's notes waits for the user's approval.
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
| 8, 9 | `shipit schedule propose`, the proposal card on docs/299's machinery |
| 10, 24 | Settings → Schedules |
| 12 | No input-panel change |
| 13 | Notes folders, `<scheduled_run>` block |
| 14, 15, 23 | Scheduler steps 1–4, the per-schedule queue, recovery |
| 16 | IANA zone, `croner` |
| 17 | Step 3's check on start times; the input guard at save and propose |
| 18 | Pre-flight, first-turn watch, `needs_user_reason` |
| 19 | Run now / Pause / Edit; the spec is copied into the run row |
| 20, 21 | `SidebarView` `"scheduled"`, membership by spawn root, separate caps, Sandbox group split |
| 22 | `isRunFinished`, `isWorkResolved`, `workResolvedAt` |
| 25 | `ScheduledRunBanner` |
| 26 | Run now through the queue without the checks; the done-test warning |
| 27 | Notes viewer; the safe read |
| 28, 30 | `shipit schedule notes`, the notes access card, `schedule_notes_grants` per schedule |
| 29 | `croner`'s handling of the change days |
| 31 | Schedule rows in "needs you"; an errored run is not finished |
| 32 | Delete, refused while a run is not finished |
| 33 | The chat's stop control in a run, and Stop on a run row, in the Delete refusal and in the banner; `run_stopped_at` |

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
- **"Finished" from the status card's freshness** — the card is off by default,
  and any write marks it fresh, so freshness proves nothing about the end of a
  turn.
- **Earlier runs' notes mounted read-only** — no requirement protects them, and
  it costs a second, nested mount.
- **Mounting notes into an approved session** — a mount takes effect only when
  the container starts, so an approval would restart the session.
- **New claim and notice machinery for the two cards** — docs/299's already
  claims a decision atomically and delivers its outcome durably.
- **Auto-pause after repeated failures** — not asked for; req 18 makes every
  failure visible, and a failed start costs nothing.
- **A deterministic pre-check that skips the agent** (Devin, gh-aw) — a quiet run
  already leaves the user's sight by itself (req 22).
- **Event triggers** — scope is the clock only, for now (resolved 2026-10-07).
