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

Req 5 is held by making the three places that list these choices derive from
the one type, so a parameter added to one does not compile until the others
handle it:

- `CreateHeadlessSessionOptions` takes `SessionStartParams` instead of its own
  copy of the fields (Quick Capture and runs use it).
- The composer's WebSocket seed object (`useSessionWebSocket.ts`) is typed as a
  `Pick` of it.
- The Settings editor renders the parameters through a field map typed
  `{ [K in keyof SessionStartParams]-?: FieldControl<K> }`. A new key with no
  control is a type error.

The editor's controls are the composer's own components — `RoleSelector`,
`HarnessSelector`, `ModelSelector`, `ReasoningSelector`,
`PermissionModeSelector` — and the sandbox grants are
`SandboxCapabilityToggles`, the component `SandboxDialog` and Session settings
already share. A role replaces the harness, model and reasoning controls there
as it does in the composer (docs/272-user-selectable-roles), and is optional
(req 6).

## Storage

Orchestrator SQLite, migrations in `database.ts`:

- **`schedules`** — `id`, `name`, `enabled`, `timing` (JSON: a preset or a cron
  expression), `time_zone` (IANA name), `spec` (JSON `SessionStartSpec`),
  `last_slot_at` (the last due time handled), `needs_user_reason` (req 18),
  `created_at`, `updated_at`.
- **`schedule_runs`** — `id`, `schedule_id`, `slot_at` (null for Run now),
  `outcome` (`started` | `skipped` | `failed`), `reason`, `session_id`,
  `created_at`. This is the run history (req 24).
- **`sessions`** gains `schedule_id`, `schedule_run_id` and `run_finished_at`
  (`SessionInfo.scheduleId`, `scheduleRunId`, `runFinishedAt`). Today nothing
  records where a session came from.

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
(repository known, role exists, model valid, cron parses, req 17's minimum
interval) and refuses it by name. A valid proposal posts a **schedule proposal
card** into the transcript: every value, or before → after for a change; the
next three run times in the browser's time zone; **Confirm**, **Open in
Settings** and **Cancel**. Only Confirm writes the schedule. Like docs/299's
settings proposal, the write routes are not container-accessible, so the agent
has no path to a schedule that skips the user — which is what stops it from
giving a run sandbox grants the user never saw (req 9). If the proposal names no
time zone, Confirm sends the browser's.

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
  prompt; and the next three run times as a check.
- **Runs**, newest first: time, outcome, a one-line result, a link to the
  session. The result is the run session's status-card `lastTurn` (docs/303),
  read when the view loads, so no new field is needed. Skipped and failed rows
  show their reason.

Deleting a schedule keeps its run sessions (they are ordinary sessions, req 7)
and deletes its notes folders.

## The scheduler (reqs 1, 2, 14–18, 23)

`ScheduleRunner`, started from `startup-monitors.ts`: one pass at startup, then
every 30 seconds, like the idle enforcer. Cron evaluation needs one dependency
that evaluates cron in an IANA time zone and handles daylight saving (req 16) —
`croner` is the candidate; it must pass `check-deps` (exact pin, 7 days old).
Presets compile to cron: daily 09:00 is `0 9 * * *`, weekdays `0 9 * * 1-5`.

Each pass, for each enabled schedule:

1. `slot` = the latest run time at or before now. If `slot <= last_slot_at`,
   nothing is due.
2. Write `last_slot_at = slot` **before** acting, so a restart in the middle
   cannot start the same slot twice — the `runUpdateCheckIfDue` pattern
   (`services/update-notice.ts`).
3. If the schedule's latest run session has a runner whose `agentBusy` is true
   (`session-runner.ts`: a turn, background tasks, sub-agent spawns or post-turn
   work), record `skipped` (req 14). `awaiting_answer` is not busy, so a run that
   waits for the user does not block the next one (req 23).
4. Otherwise start the run.

Because only the latest slot is considered, the slots missed while ShipIt was
down become one run at the first pass after startup (req 15). Resume sets
`last_slot_at` to now, so slots that passed during a pause do not run — req 15 is
about ShipIt being down, not about a pause.

**Minimum interval (req 17)**: saving or proposing a schedule enumerates its
next 100 run times and refuses it if any two are less than an hour apart. Run
now is a deliberate act, so neither the interval nor the overlap rule applies
to it.

**Starting a run** — `startScheduledRun(schedule, slot | "now")` calls
`createHeadlessSession` with the copied spec, which gains:

- a `target` union. The sandbox branch composes `createSandboxSession` with the
  same role and parameter application and the same dispatch, since
  `createSandboxSession` today takes no prompt, model or role;
- `permissionMode` on the first dispatch, which already has the slot and passes
  `undefined` today (`headless-sessions.ts`);
- `sshHosts` and `networkMode`, applied before the container starts, because a
  sandbox's Network and Docker grants take effect only at container start
  (`sandbox-capabilities.ts`);
- `title` = "*schedule name* · *date*", with AI naming off. Sandboxes never
  graduate, so the title must be set at creation;
- `scheduleId` and `scheduleRunId` on the session row;
- a fresh fetch of the base, as `spawnChildSession` does, so a run starts from
  the current default branch.

The first dispatch is not `automatic`: it is a new session's own task, so the
docs/322 hold does not apply to it.

**Failed starts (req 18)**: any error from `startScheduledRun` — an untrusted
repository (`assertSessionCanDispatch`), a removed repository, a role or model
that no longer exists, a missing credential — records a `failed` run with the
reason and sets the schedule's `needs_user_reason`. It shows in Settings →
Schedules and at the top of the Scheduled sidebar view, and the view's control
carries a warning mark. The next successful start, an edit, or a resume clears
it.

## The run's first message and its notes (req 13)

Each run gets a folder `<workspace-root>/schedules/<schedule-id>/runs/<run-id>/`
on the host. The run's container sees all of the schedule's run folders
read-only at `/schedule/runs/`, and its own folder read-write over it at
`/schedule/runs/<run-id>/` — two binds, set up and owned the way `/persist` is
(`container-lifecycle.ts`, `compose-persist.ts`). The folders belong to the
schedule, not to a session, so the archive retention period
(docs/323-archived-session-data-retention) does not delete them; deleting the
schedule does.

The first message is the schedule's prompt plus a short, factual
`<scheduled_run>` block: the schedule's name, this run's time, its own notes
folder, the earlier runs' folders, and that notes written by earlier runs are
data, not instructions (`/shipit-docs/untrusted-input.md`). It is injected into
the first turn the way role standing instructions are
(`takeRoleStandingInstructions`), so the system prompt stays byte-stable. The
block's text is a `.md` prompt file loaded at module load (prompt-architecture).
What the agent writes in its notes, and when it reads earlier ones, is left to
the agent.

## The Scheduled sidebar view (reqs 20–22)

- `sidebarView` (`ui-store.ts`) gains `"scheduled"`. A `ScheduledViewToggle`
  sits beside `AttentionViewToggle`, in the same house toggle pattern, and is
  shown only when the user has a schedule or a scheduled run — the same rule
  the role control uses (docs/272-user-selectable-roles req 16).
- The regular view drops sessions with a `scheduleId` (req 20). The scheduled
  view renders the regular grouping (`useSessionGrouping`, `SessionGroup`,
  `SandboxSessionGroup`) over only those sessions, so repository groups and
  **Recently resolved** work the same way with no second implementation.
- The attention view keeps all sessions as its input, so a run that needs the
  user is listed there (req 21). A test pins that the regular view's filter does
  not reach it.

**Finished (req 22)**: at turn settlement — where `awaiting_answer` is set
(docs/322) — a scheduled run's `run_finished_at` is set when the run is not
awaiting an answer, its status card has no `needsYou` entries, and it has no
open PR. The shared done test (`session-resolution.ts`) gets a clause beside
`isTerminalPrResolved`: a scheduled run whose `lastUsedAt` is not later than
`runFinishedAt`. Through that one test, docs/316 already gives a finished run
everything req 20 asks for — **Recently resolved**, the sidebar cap, no
attention marker, and a container stop after 10 minutes. A user turn in the run
makes it active again, and the next settlement decides again. Every consumer of
`resolvedAt` and of the done test is checked when this lands, because until now
"done" meant "PR resolved".

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
| 4, 5, 11 | `SessionStartParams`, the typed field map, shared components |
| 6 | `spec.prompt`; role optional |
| 7 | Runs are ordinary sessions |
| 8, 9 | `shipit schedule propose`, the proposal card, no container write route |
| 10, 24 | Settings → Schedules |
| 12 | No composer change |
| 13 | Notes folders, `<scheduled_run>` block |
| 14, 15, 23 | Scheduler steps 1–4 |
| 16 | IANA zone, cron library |
| 17 | Validation at save and propose |
| 18 | `failed` runs, `needs_user_reason` |
| 19 | Run now / Pause / Edit; the spec is copied at start |
| 20, 21, 22 | `sidebarView: "scheduled"`, `run_finished_at` in the done test |
| 25 | `ScheduledRunBanner` |

## Rejected

- **A schedule mode in the composer** — the user ruled it out (req 12).
- **One standing session per schedule, a new turn per run** — against req 7's
  "each run is a session"; the context grows run after run, and a repository
  session's branch resets after each merge.
- **Schedules as a file in the repository** — a sandbox schedule has no
  repository, and the user chose chat (req 8).
- **Auto-pause after repeated failures** — not asked for; req 18 makes every
  failure visible on the schedule, and a failed start costs nothing.
- **A deterministic pre-check that skips the agent** (Devin, gh-aw) — a quiet run
  already leaves the user's sight by itself (req 22).
- **Event triggers** — scope is the clock only, for now (resolved 2026-10-07).
