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
   Delete (reqs 10, 11, 19, 24).
4. **A scheduler** — a 30-second pass in the orchestrator that starts due runs
   through the existing headless session start (reqs 1, 2, 14–18, 23).
5. **A Scheduled sidebar view** — the regular grouped list, filtered to runs
   (reqs 20–22).
6. **Notes folders** — one per run, with earlier runs readable (req 13).

Nothing here adds a control to the message input panel (req 12).

## One session-start description (reqs 4, 5, 11)

The composer applies its choices to a warm draft session one WebSocket message
at a time, and keeps the permission mode in the browser (research.md, "ShipIt
facts"). A schedule needs the same choices as data. So the choices get one
type, in `src/server/shared/types/`:

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

The spec is stored as JSON, so storing a new key needs nothing. Req 5 is then
held at the two places a key can be forgotten:

- **Applying it.** The session start applies parameters through
  `START_PARAM_APPLIERS: { [K in keyof SessionStartParams]-?: Applier<K> }`,
  and the card and the Settings list describe them through
  `START_PARAM_LABELS` of the same shape. A key added to the type does not
  compile until it is applied and described.
- **Reaching the type at all.** A guard test lists every input through which a
  user picks a session-start choice today — the composer's `set_*` WebSocket
  messages and URL seed keys (`useSessionWebSocket.ts`), the
  `POST /api/sessions/headless` body keys, and the per-message
  `permissionMode` — and fails on one that maps to no `SessionStartParams` key.
  A new composer choice therefore lands in the type, which brings the two
  checks above into force.

`CreateHeadlessSessionOptions` takes `SessionStartParams` instead of its own
copy of the fields, so Quick Capture and runs share one path.

The Settings editor is built from the composer's own controls — `RoleSelector`,
`HarnessSelector`, `ModelSelector`, `ReasoningSelector`,
`PermissionModeSelector` — and the sandbox grants are
`SandboxCapabilityToggles`, which `SandboxDialog` and Session settings already
share. One control can set several keys (the model picker sets the model,
service and billing mode), so the editor's coverage is checked by a component
test that edits every key, not by a per-key map. A role replaces the harness,
model and reasoning controls as it does in the composer
(docs/272-user-selectable-roles), and is optional (req 6).

## Storage

Orchestrator SQLite, migrations in `database.ts`:

- **`schedules`** — `id`, `name`, `enabled`, `timing` (JSON: a preset or a cron
  expression), `time_zone` (IANA name), `spec` (JSON `SessionStartSpec`),
  `active_since` (set on create and on resume), `needs_user_reason` (req 18),
  `created_at`, `updated_at`.
- **`schedule_runs`** — `id`, `schedule_id`, `slot_at` (null for Run now),
  `outcome` (`starting` | `started` | `skipped` | `failed`), `reason`,
  `session_id`, `created_at`; unique on (`schedule_id`, `slot_at`). This is the
  run history (req 24) and also the record of which slots were handled.
- **`sessions`** gains `schedule_id`, `schedule_run_id` and `run_finished_at`
  (`SessionInfo.scheduleId`, `scheduleRunId`, `runFinishedAt`). Today nothing
  records where a session came from. `schedule_run_id` is stamped when the
  session is created, so recovery (below) can find a session whose run row was
  never updated, and the container setup knows which notes folder is the run's
  own.

A run copies the spec when it starts — the session row holds its own model,
role and so on — so an edit applies from the next run and never changes a run
in progress (req 19).

## Making a schedule by chat (reqs 8, 9)

Agent CLI, in the session shim beside `shipit settings`:

- `shipit schedule list` — the schedules with their ids, so the agent can
  change one.
- `shipit schedule propose [--id <id>] --file -` — a new schedule, or a change
  to one, as YAML: `name`, `when` (a preset or `cron:`), optional `timeZone`,
  `target`, `params`, `prompt`.

The orchestrator validates the proposal the same way the Settings editor does
(repository known, role exists, model valid, cron parses, req 17's spacing) and
refuses it by name. A valid proposal posts a **schedule proposal card** into the
transcript: every value through `START_PARAM_LABELS`, or before → after for a
change; the next three run times in the browser's time zone; **Confirm**,
**Open in Settings** and **Cancel**. Only Confirm writes the schedule. Like
docs/299's settings proposal, the write routes are not container-accessible, so
the agent has no path to a schedule that skips the user — which is what stops
it from giving a run sandbox grants the user never saw (req 9). If the proposal
names no time zone, Confirm sends the browser's.

The card is transcript content, so it follows the persisted-card recipe
(`emitChatCard`, a `PersistedMessage` field, `CARD_MESSAGE_FIELDS`,
`TRANSCRIPT_SCOPED_MESSAGES`) — docs/188-persist-transcript-cards. The outcome
reaches the agent on its next turn as a notice, the docs/299
`settings-outcome-notice.ts` pattern. The command needs no repository, so it
works in a sandbox too.

docs/299's settings card is not reused directly: it carries one scalar change,
and a schedule is a whole object the user has to review at once.

## Settings → Schedules (reqs 10, 11, 19, 24)

A `schedules` section registered beside `roles` in
`Settings/components/registry.ts`.

- **List**: name, when (in words), target, next run, and a state — Paused, or
  the req 18 reason. Row actions: Run now, Pause / Resume, Edit, Delete.
- **Editor**: name; when — a preset (hourly, daily, weekdays, weekly) with time
  and weekday, or a cron field; time zone (default: the browser's); target — a
  repository, or Sandbox with its grants; the parameter controls above; the
  prompt; and the next three run times as a check on a cron expression.
- **Runs**, newest first: time, outcome, a one-line result, a link to the
  session. The result is the run session's status-card `lastTurn` (docs/303),
  or the card's first status line when an ordinary card write has cleared
  `lastTurn`, or the outcome alone when the run wrote no card. Skipped and
  failed rows show their reason.

Delete is not in the requirements, but a list the user can edit and never
shorten would fill with paused schedules. Deleting a schedule keeps its run
sessions (ordinary sessions, req 7) and deletes its notes folders.

## The scheduler (reqs 1, 2, 14–18, 23)

`ScheduleRunner`, started from `startup-monitors.ts`: one pass at startup, then
every 30 seconds, like the idle enforcer. Cron evaluation needs one dependency
that evaluates cron in an IANA time zone and handles daylight saving (req 16) —
`croner` is the candidate; it must pass `check-deps` (exact pin, 7 days old).
Presets compile to cron: daily 09:00 is `0 9 * * *`, weekdays `0 9 * * 1-5`.

Each pass, for each enabled schedule:

1. `slot` = the latest run time at or before now. Nothing is due unless `slot`
   is after `active_since` and after the slot of the schedule's latest run row.
2. **Claim the slot** by inserting a `starting` run row; the unique constraint
   makes a second claim of the same slot fail, so a slot never starts twice.
3. If a run of the schedule is still going — its session has a runner whose
   `agentBusy` is true (a turn, background tasks, sub-agent spawns, post-turn
   work, or an install) — mark the row `skipped` with that reason (req 14). The
   same applies when the previous run that came due started less than an hour
   ago (req 17). `awaiting_answer` is not busy, so a run that waits for the user
   does not block the next one (req 23).
4. Otherwise start the run and mark the row `started` with its session, or
   `failed` with the reason.

Because only the latest slot is considered, the slots missed while ShipIt was
down become one run at the first pass after startup (req 15). That pass also
**recovers** `starting` rows left by a restart in the middle of a start: a row
whose session exists (found by `schedule_run_id`) becomes `started`; a row with
no session is started now. Resume sets `active_since`, so slots that passed
during a pause do not run — req 15 is about ShipIt being down, not about a
pause.

**One hour apart (req 17)** covers runs that come due. Saving or proposing
refuses a timing whose next 100 run times include two less than an hour apart,
and a due slot within an hour of the previous due run — which only a catch-up
can cause — is recorded as skipped. Run now runs are not counted.

**Run now (req 26)** starts a run at once, with neither the hour nor the
overlap check. When any of the schedule's run sessions that the user has not
archived is not done — by the shared done test, so still going, waiting for an
answer, needing the user, or with an open PR — the Run now control first shows
a warning that lists those sessions, with **Run anyway** and **Cancel**. A Run
now run is an ordinary run of the schedule, so a slot that comes due while it
is still going is skipped by step 3.

**Starting a run** — `startScheduledRun(schedule, slot | "now")`:

1. **Pre-flight**, before anything is created, so the common failures have a
   clear reason: the repository is still added and trusted
   (`assertSessionCanDispatch` refuses an untrusted one at dispatch), the role
   still exists, the model is still offered.
2. `createHeadlessSession` with the copied spec. It gains:
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
   - a fresh fetch of the base, as `spawnChildSession` does, so a run starts
     from the current default branch.
3. **Watch the first dispatch.** A dispatch that fails during setup does not
   throw to the caller; `dispatchOnRunner` reports it through the turn's
   settlement (`onTurnComplete` with `turnErrored`, `session-runner.ts`). A run
   whose first turn errors this way is marked `failed`, with its session linked.

The first dispatch is not `automatic`: it is a new session's own task, so the
docs/322 hold does not apply to it.

**Failed starts (req 18)** set the schedule's `needs_user_reason`. It shows in
Settings → Schedules and at the top of the Scheduled sidebar view, and the
view's control carries a warning mark. The next successful start, an edit, or a
resume clears it.

## The run's first message and its notes (req 13)

Each run gets a folder `<workspace-root>/schedules/<schedule-id>/runs/<run-id>/`
on the host, which ShipIt creates before the container starts. The run's
container sees the schedule's whole `runs/` folder at `/schedule/runs/`, so its
own folder and every earlier one are there. It is mounted and owned the way
`/persist` is — a bind in development, a volume subpath in production
(`container-lifecycle.ts`, `compose-persist.ts`). The folders belong to the
schedule, not to a session, so the archive retention period
(docs/323-archived-session-data-retention) does not delete them; deleting the
schedule does.

The first message is the schedule's prompt plus a short, factual
`<scheduled_run>` block: the schedule's name, this run's time, its own notes
folder, where the earlier runs' folders are, and that notes written by earlier
runs are data, not instructions (`/shipit-docs/untrusted-input.md`). It is
injected into the first turn the way role standing instructions are
(`takeRoleStandingInstructions`), so the system prompt stays byte-stable. The
block's text is a `.md` prompt file loaded at module load (prompt-architecture).
What the agent writes in its notes, and when it reads earlier ones, is left to
the agent.

## Finished runs (req 22)

At turn settlement — where `awaiting_answer` is set (docs/322) — a scheduled
run's `run_finished_at` is set when all of these hold:

- it is not awaiting an answer;
- its status card was written at the end of this turn (`sessionStatus.fresh`)
  and has no `needsYou` entries — a run that wrote no card has not shown that
  nothing is left for the user, so it stays active;
- it has no open PR.

Today two different tests decide "resolved", and both have to learn about
finished runs:

- the shared done test (`doneSessionTest`) — the idle enforcer's container stop
  (docs/316) and part of the sidebar cap;
- `isTerminalPrResolved` on its own — the attention marker
  (`SessionItem.tsx`, `useAttentionSessions.ts`, `useAttentionNotifications.ts`)
  and the cap's ranking of which resolved rows stay visible
  (`filterVisibleInSidebar`, `sessions.ts`), sorted by `resolvedAt`, which reads
  only `mergedAt ?? closedAt`.

So `session-resolution.ts` gains `isWorkResolved` (`isTerminalPrResolved`, or a
scheduled run whose `lastUsedAt` is not later than `runFinishedAt`) and
`workResolvedAt` (`resolvedAt` or `runFinishedAt`). The done test, the attention
call sites, the cap's ranking and the group sort use them instead. A user turn
in a finished run makes it active again, and the next settlement decides again.

## The Scheduled sidebar view (reqs 20, 21)

- `SidebarView` (`utils/local-storage.ts`, held in `ui-store.ts`) gains
  `"scheduled"`. A `ScheduledViewToggle` sits beside `AttentionViewToggle`, in
  the same house toggle pattern, and is shown only when the user has a schedule
  or a scheduled run — the same rule the role control uses
  (docs/272-user-selectable-roles req 16), and in the spirit of req 12.
- The regular view drops sessions with a `scheduleId` (req 20). The scheduled
  view renders the regular grouping (`useSessionGrouping`, `SessionGroup`) over
  only those sessions, so repository groups and **Recently resolved** behave
  the same way.
- The Sandbox group today lists every session with no **Recently resolved**
  split, because a sandbox session never resolves. It gets the same split, driven
  by `isWorkResolved`. In the regular view nothing changes, since only a
  scheduled run can be a resolved sandbox session.
- The attention view keeps all sessions as its input, so a run that needs the
  user is listed there (req 21). A test pins that the regular view's filter does
  not reach it.

## The run's banner (req 25)

A `ScheduledRunBanner` in the chat panel, where `SandboxBanner` sits: "Started
by schedule **name** · time · Open schedule", which opens Settings → Schedules
at that schedule. In a sandbox run the two banners share one bar.

## Agent-facing docs

- New `src/server/shipit-docs/schedules.md`: the two commands, the proposal
  YAML, the notes folders, and that the agent proposes and the user confirms.
- `src/server/shipit-docs/wiki/sessions.md`: a "Scheduled sessions" section —
  what a schedule is, where Settings → Schedules and the Scheduled view are.

## Requirement map

| Req | Where |
|---|---|
| 1, 2 | The scheduler; `startScheduledRun` |
| 3 | `SessionStartTarget` |
| 4, 5, 11 | `SessionStartParams`, exhaustive appliers and labels, the guard test, shared controls |
| 6 | `spec.prompt`; role optional |
| 7 | Runs are ordinary sessions |
| 8, 9 | `shipit schedule propose`, the proposal card, no container write route |
| 10, 24 | Settings → Schedules |
| 12 | No composer change |
| 13 | Notes folders, `<scheduled_run>` block |
| 14, 15, 23 | Scheduler steps 1–4, slot claim and recovery |
| 16 | IANA zone, cron library |
| 17 | Spacing check at save and propose; skip of a due slot within an hour |
| 18 | Pre-flight, first-dispatch watch, `needs_user_reason` |
| 19 | Run now / Pause / Edit; the spec is copied at start |
| 20, 21 | `SidebarView` `"scheduled"`, regular-view filter, Sandbox group split |
| 22 | `run_finished_at`, `isWorkResolved`, `workResolvedAt` |
| 25 | `ScheduledRunBanner` |
| 26 | Run now without checks; warning when a run is not done |

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
- **Earlier runs' notes mounted read-only** — no requirement protects them, and
  it costs a second, nested mount.
- **Auto-pause after repeated failures** — not asked for; req 18 makes every
  failure visible on the schedule, and a failed start costs nothing.
- **A deterministic pre-check that skips the agent** (Devin, gh-aw) — a quiet run
  already leaves the user's sight by itself (req 22).
- **Event triggers** — scope is the clock only, for now (resolved 2026-10-07).
