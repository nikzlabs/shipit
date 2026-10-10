# Sessions

A session is ShipIt's unit of work, and most questions about "how do I…" and
"why did it…" are really questions about sessions. This page covers the whole
life of one.

When a step here is something **you** can do, do it — do not read the command
out to the user. When it is a control in the sidebar, name the control and stop.

## What one session is

One session bundles, for the whole time it exists:

- **A conversation** — the chat history, kept and reloaded.
- **A container** — its own Docker container, its own user id, its own
  filesystem. Nothing it does reaches another session.
- **A checkout and a branch** — cut for this session when it started. The user
  never made this branch and does not have to manage it.
- **A preview** — the project's Compose services, running only for this session.
- **Usually one pull request.** A session works one PR at a time; that is the
  shape the whole product is built around.

Sessions are meant to be many and cheap. Running six at once on the same
repository is the intended use, not an edge case: separate containers and
separate branches mean six agents cannot collide.

## Starting one

The user can start a session from:

- **The "New session" button** in a repository's group in the sidebar.
- **The home screen**, which also offers starter prompts.
- **An issue** in the Issues tab — the session opens already pointed at it, and
  ShipIt moves the issue to *started* for them.
- **A fork** of an existing session, from any point in its conversation (below).
- **You**, when the user has asked for separate, independently reviewable work —
  `shipit session create`, covered in `/shipit-docs/sessions.md`.

A new session usually opens instantly because ShipIt keeps a warm one prepared
in the background. It becomes a real session, with a name derived from the first
message, the moment the user sends that message.

## Reading a session row

The sidebar groups sessions by repository, pinned ones first, then by recency,
with resolved ones demoted. The marks on a row are worth knowing because users
ask about them:

| Mark | Means |
|---|---|
| Pulsing green dot | The agent is working right now |
| Wrench | Auto-fix is running against failing CI |
| Tick / cross / spinner | CI passed, failed, or still running, with counts |
| Auto-merge glyph | The PR is armed to merge itself when checks pass |
| Archive glyph | Archived |
| Disk glyph, *"Dependencies cleared to save disk"* | Its `node_modules` and friends were dropped; opening it reinstalls them |
| Disk glyph, *"Workspace stored to save disk"* | The whole checkout went back to the cache; opening it re-clones. Slower to come back than the row above |
| Relative time | When it was last used |

There is a second sidebar view, **"Needs you"**, reached from the icon in the
sidebar header, which carries a count. It is a flat list — no repository
grouping — of only the sessions waiting on the user. A session that stops
needing attention while that view is open keeps its place and is marked as no
longer waiting, rather than vanishing under the cursor. A session of a
repository the user hid from the sidebar is listed there too, and counted,
when it waits on the user.

ShipIt can also raise a browser notification when a session starts needing the
user, where the browser permits it — some mobile browsers refuse notifications
raised this way, and there ShipIt stays silent rather than failing loudly. It
waits a couple of seconds before notifying, because a session that is
mid-handover briefly looks stopped.

## What is on a session's menu

Every row has an overflow menu. In order:

- **Rename** — the session's title only. It never renames the branch.
- **Pin to top** — see below; this is more than ordering.
- **Mute until next turn** — only offered when the session is actually asking
  for attention and its agent is not working.
- **Keep preview running** — a tick; exempts this session's services from being
  stopped when it goes idle.
- **Archive**.
- **Recover recent rewind** — undo a rewind.
- **Download chat** — the conversation as a file.
- **Investigate in Ops session** — opens ShipIt's own operations session pointed
  at this one. On any row except an Ops session's own.
- **Session settings** — the session's network access and its SSH destination
  grants. Network access is three ways: **Inherit** (follow the workspace setting,
  changed in Settings → Network), **Contained** (default-deny: only the allowlist
  — the LLM API, GitHub, package registries, and hosts the user has added — is
  reachable, with an inline prompt when something new is wanted), or **Open**
  (any internet host, no allowlist, no prompts). In both modes a session cannot
  reach the machine that runs ShipIt, private networks (the LAN) or the tailnet;
  an SSH destination granted in the same dialog is reachable on its own port
  only. Changing the mode restarts the session's container to apply. The same
  dialog also opens from the composer's permission-mode control, **including on
  a new session before its first message**, so the user can pick the network
  mode and grant SSH destinations in advance.

**Recover recent rewind**, **Download chat** and **Session settings** are on the
**open** session's row only, not on every row in the list. An archived row
offers **Restore** instead of all of it.

## "Where did my session go?"

Almost always the sidebar cap, and almost never a deletion. **Only the five
most recently resolved sessions per repository stay in the list.** A session is
"resolved" once its pull request has merged or closed; older resolved ones drop
out to stop finished work burying live work.

Several things exempt a session from that cap: a **pin**, a **Keep preview
running** reservation, a workspace ShipIt could not commit to (which needs the
user, so it is never hidden), and belonging to a live parent-and-children tree.
A session that is not resolved at all is never capped.

Nothing dropped is gone. **All sessions** — reached from a repository group's
header in the sidebar — lists everything, with a search box over titles and
repository names, and filters for sandbox and Ops sessions. Archived sessions
are there too, and opening one from that dialog restores it first. If the user
says a session vanished, that dialog is the answer; suggest a pin if they want
it to stay put.

## When a session is stuck

The **Terminal** tab carries a session health strip at the top, and everything
for a wedged session is on it, in increasing order of violence:

| Control | Does |
|---|---|
| **details** | Expands the health detail in place |
| **Diagnostics** | Opens the full diagnostics panel: services, runner state, recent logs — and a copy button that yields the whole payload as JSON, which is what a bug report wants |
| **Kill agent** | SIGKILL on the agent process. For when an interrupt did not take |
| **Restart agent container** | Destroys and recreates **just** the agent container, leaving the Compose stack up. The right one when the agent is wedged but the preview is fine |
| **Restart all** | Stops the Compose stack, destroys the agent container, rebuilds it and starts the `auto` services again. `manual` services stay stopped until started |

The agent restarts its own agent container: when a change applies only from the
next container start, run `shipit session restart --note "…"`. The restart
happens after the turn ends, and the note comes back as a new turn on the new
container, so the user clicks nothing. **Restart all** stays the user's.

When the user has to restart, name the button and say where it is: "click
**Restart all** on the health strip in the Terminal tab". "Restart the
container" alone does not tell them which control to use.

Read the diagnostics before reaching for a restart, and say what they show. A
restart that fixes nothing twice is worth a bug report rather than a third.

## Going back: rewind and fork

This is the answer to "can I undo all that?", "go back to before it did X", and
"try something else from here without losing this".

The control lives in the **gap between turns**, not on a message. The geometry
is the meaning: everything above the line is kept, everything below it goes. A
gap shows a faint hairline at rest and a pill on hover; the gap after the last
turn is more prominent, because it is the common case.

At a gap between turns, four actions:

| Action | Effect |
|---|---|
| Rewind chat | Drops the conversation below the line. The code is untouched. |
| Rewind code | Restores the files to that point. The conversation stays. |
| Rewind both | Both. |
| Fork | Leaves this session alone and starts a **new** one from that point. |

After the last turn, only **Fork** is offered — the three rewinds would do
nothing there.

Anything that touches files asks for confirmation first, and tells the user how
many files it will change. A rewind can be undone: a toast offers it
immediately, and **Recover recent rewind** on the session menu offers it after
that — that recovery is also refused mid-turn.

**The undo ends when the session moves on.** Once a new turn starts, the rewind
can no longer be undone, because undoing it would remove that turn: the toast
and **Recover recent rewind** go away, and a late click is refused. Undoing a
fork is the exception: it stays for its five minutes, since it leaves the
parent's later work alone.

**While a turn is running, the gaps offer fork and nothing else.** The three
rewinds are refused outright ("Cannot rewind while a turn is running"), so a
user who wants to go back interrupts first. Forking is not blocked, which is the
useful half: they can branch off the current state without stopping the work.

**Right after a turn ends, the rewinds and the recovery are refused too**
("This session's work is still being saved"). ShipIt is committing that turn's
work, and a rewind before the commit would throw away edits that nothing could
bring back. The refusal ends when that commit attempt has finished, so a user
who reports this error only has to choose the rewind again.

A fork is a real, separate session with its own branch and its own pull request,
and ShipIt moves the browser to it as soon as it exists — the user does not go
looking for it in the sidebar.

## Attention, and turning it off

A session needs attention when it has **stopped** and wants something: an answer
to a question, a failing check, a workspace it cannot commit to. Two cases that
look like attention and are not:

- **A merged or closed pull request raises nothing.** The work is done; the
  session goes quiet.
- **A permission prompt counts as the agent still working**, so the session is
  not "waiting on the user" in this sense and cannot be muted. It is still
  visibly blocked, and answering it is what unblocks it.

**Mute until next turn** silences an attention signal without changing anything
else — the session stays active and in the list, and looks like a session with
nothing pending. The mute lifts by itself when the next turn starts, however it
starts. The user can unmute earlier. A mute is stored with the session, so it
holds on their phone too.

Only a session that is currently asking for attention, and whose agent is not
working, can be muted. If the user wants to silence a *busy* session, the answer
is that there is nothing to silence yet.

## Going idle, and what ShipIt reclaims

Sessions do not run forever. **Two separate mechanisms** take things back, and
users conflate them constantly — answer with the right one, because the
exemptions are different.

**Memory.** When ShipIt is over its memory budget it reclaims running
containers, longest-idle first. It never takes a session someone is watching,
and never one whose agent is working.

1. **The agent container stops.** The conversation, the branch and the files are
   all intact; the next message starts a fresh container.
2. **The preview keeps running** while the budget allows — the whole Compose
   stack, not just the service on screen, because a preview URL serving errors
   because its database was stopped is worse than a clean stop. Coming back
   shows the app immediately.

The exemption here is **Keep preview running** on the session menu, which
reserves that session against the memory reclaim. Nothing else exempts it —
pinning does not.

**Done sessions.** A session under **Recently resolved**, or one the sidebar
hides because of the resolved-session cap, is *done*. About 10 minutes after
its pull request merged or closed, ShipIt stops its agent container and its
whole Compose stack, whatever the memory budget says — also while the user has
it open, but never while its agent is working. A pin, **Keep preview running**,
a broken workspace or a spawned session that is not done makes a session not
done. A merged session moves under **Recently resolved** at once, also when
the merge happens during one of its turns. A message sent after the merge makes
it active again, and the next message restarts it.

**New sessions nobody used.** Picking a repository for a new session hands the
user a ready session before they type anything. If it has no first message and
nobody has looked at it for about 10 minutes, ShipIt stops its agent container
and its whole Compose stack, whatever the memory budget says. Its files stay;
opening it again starts a fresh container.

**Disk.** Independently of memory, a session that has been idle long enough
descends a disk ladder. This happens even when memory is plentiful.

3. **Dependencies are cleared.** The row shows a mark reading *"Dependencies
   cleared to save disk — reinstalled when you open it"*. Opening the session
   reinstalls them.
4. **The workspace is stored**, and restored from the shared cache on next open.

The exemption here is a **pin**. Pinning sticks a session to the top of its
repository's group *and* keeps it: it is never silently dropped from the list,
and its workspace never descends the disk ladder. That is the reason to
recommend a pin, not the ordering. A pin does not keep its container or its
preview alive.

Two consequences to state plainly when they come up.

**Committed work is safe on this machine, and safe everywhere only once it is
pushed.** ShipIt commits after every turn and then pushes — but the push is
conditional, and it is worth knowing on which conditions. With **GitHub not
connected** nothing is pushed at all; the commit stays in the session's local
history. A push that **fails** leaves the commit there too. In both cases the
work is intact and the session will say so, but it exists on one host only, and
"it's on GitHub" would be the wrong reassurance to give.

**Anything started by hand inside the container does not survive** — a
background process, a `setInterval`, a dev server launched from the terminal.
It does not come back either. Long-running work belongs in
`docker-compose.yml`; one-time setup belongs in `shipit.yaml`.

## Archiving

Archiving is the tidy end of a session's life, not a delete. It stops the
session's container, removes its named volumes, and reclaims its checkout — and
it takes the session's **children** with it, since archiving a parent is one
user action. (Ops sessions are the exception: their children are independent
fixes and stay alive.)

**Archiving is the user's, in the UI — the agent cannot do it.** There is no
agent command for it, deliberately: a parent agent cannot read its children's
chats, so it cannot tell a child that is finished from one waiting on the user.
Point the user at the session's row menu, or **All sessions**.

**"Removes its named volumes" includes the project's own.** A volume declared in
the user's `docker-compose.yml` becomes a Docker volume belonging to this
session, so whatever is in it goes when the session is archived — the rows in a
development database, an upload directory, a cache built up over weeks of work.
That data was never durable and no backup covers it. If it matters to the user,
say so *before* they archive, and get it out first.

**The session's `/persist` files and uploads stay for a retention period, not
for ever.** Checkout reclaim and idle reclaim keep them. Archive starts a
period: 60 days by default, and 14 days when the files use 100 MB or more. When
it ends, ShipIt deletes the files. That includes what a service writes through a
`persist` mount (`/shipit-docs/compose.md`, "Data a service must keep").

- The archived row in **All sessions** shows the date of the deletion. Read the
  date from there; do not calculate it.
- Restore before the date keeps the files, and a later archive starts a new
  period. Restore after the date still works: the session opens with an empty
  `/persist`, no uploads, and a notice in the transcript that says what was
  deleted.
- A **finished** session that the user did not archive has the same period: one
  whose pull request merged or closed, and that was not used since. Its period
  starts at the merge or close, or at the last time it was used or opened. A
  pinned session is not finished, so a pin keeps its files.
- An archived **sandbox** session that has no remote also loses its checkout
  when the period ends, because nothing else holds that work. Restore gives it
  an empty workspace.

So when a user asks "can I archive this?", check what is in `/persist` first.
If it holds something they must not lose, say so before they archive.

**"If I archive this, do I lose my work?"** is the question users actually ask,
and the answer is no, for a reason worth giving them: before ShipIt reclaims a
checkout it commits anything outstanding and **verifies the branch is on the
remote**. If it cannot confirm that — commits that were never pushed, changes
git refused to commit, a detached HEAD, or a workspace it could not read — it
**keeps the files** and says so in as many words. A session with no remote at
all is never reclaimed either. The conversation is always kept.

So the branch and the pull request survive archiving; they are on GitHub, which
is what the check was for. One consequence to state plainly, because it
surprises people: **restoring gives the session a new branch**, cut fresh from
the repository. It does not resume the old one — that work already shipped, or
is still on the remote to be looked at. The exception is a session whose files
were kept because they were not safely on the remote: that one is restored where
it stands, branch and all.

Restore is on the archived row's menu, or from **All sessions**.

## Sessions that spawn sessions

A session can have children — separate sessions, nested under it in the sidebar,
each with its own branch, container and pull request. That is how a large piece
of work is split so each part can be reviewed on its own. You create them, and
coordinate with them, through `shipit session` — see `/shipit-docs/sessions.md`
for when that is the right shape and when a sub-agent or a consult is better.

Four things users ask about children:

- They report **upward only**. A child can raise a blocker to its parent; it
  cannot talk to its siblings, and cannot see them either — so children run as
  parallel trials of different prompts or models do not learn of each other.
- **A parent cannot end a child.** It can wait on one, message one, and be woken
  when one merges; archiving is the user's, above. A child steered by the user in
  its own chat is doing exactly that, and the parent has no way to see it.
- **Being told about a merge** does not need watching. `shipit session
  notify-on-merge` wakes the session when the pull request lands.
- A child sees the repository as of **main**, not the parent's uncommitted or
  unmerged work. Work it must build on has to be merged first, or carried in
  the prompt.

### A message to a session nobody can address

Those commands reach a session's **own children**, and reporting reaches its
**own parent** — nothing else, which is what stops one session from starting a
turn in an unrelated one. So a sibling cannot be reached at all, and neither can
a session that handed an agent a prompt without spawning it.

For that case the agent posts a **"Message for another session"** card naming
the target session and showing the whole message. The user reads it and sends
it or declines it; the send is what delivers it, and it starts a turn there just
as typing it would. Approving one card sends one message — the agent gets no
continuing access, so a second message means a second card. The receiving
session's transcript marks the message "From another session, approved by you",
with the sender's name, and the card stays in the sender's transcript recording
whether it was delivered or declined. Either way, a `[ShipIt]` line at the start
of the sender's next turn says what the user did, so the agent never asks.

## Scheduled sessions

A **schedule** makes ShipIt start a session by itself at set times — every
weekday at 09:00, say. Each start is a **run**: an ordinary session in the
schedule's repository, or a sandbox with the grants the schedule names, started
with the schedule's model, role and other session-start choices, and sent the
schedule's prompt as its first message. The user can open a run and work in it
like in any other session.

**Setting one up is a request to you.** The message box has no schedule
control. When the user asks for something to happen regularly, propose the
schedule with `shipit schedule propose` (`/shipit-docs/schedules.md`); it is
saved only when the user presses **Confirm** on the card. A change — another
time, another prompt, a pause — is a proposal too. `shipit schedule list` says
what each schedule is now.

When a schedule runs is a preset — every hour, every day, weekdays, every week —
or a cron expression, in a time zone, so a 09:00 run stays at 09:00 local time
across daylight-saving changes. Its run times must be at least an hour apart.

**Settings → Schedules** lists every schedule with when it runs, what it starts,
its next run, and its state: *Paused*, or the reason its last start failed.
There the user edits everything a schedule holds, and has four controls per
schedule:

- **Run now** — starts a run at once, at any time and also while a run is
  going. If an earlier run is not finished, ShipIt warns first, and the user
  chooses **Run anyway** or **Cancel**.
- **Pause** and **Resume** — a paused schedule starts nothing, and the times
  that pass while it is paused do not run when it resumes.
- **Edit** — applies from the next run. A run in progress keeps what it started
  with.
- **Delete** — removes the schedule, its run history and its runs' notes; the
  run sessions stay. It is refused while a run is not finished, and the refusal
  lists those runs, each with **Stop**.

Opening a schedule there shows its runs, newest first: the time (in the time
zone the run was made in, as in its title, so an earlier run keeps its zone
after the schedule's zone changes; named when it is not the user's own), a state — *Starting*, *Running*, *Needs you*, *Finished*,
*Stopping*, *Stopped*, *Skipped*, *Failed* or *Session deleted* — a one-line
result, **Stop** on a run that is not finished, **Open**, and **Notes** on a run
that has notes.

**Where the runs are.** Runs are not in the regular session list. The clock
button beside the "Needs you" button in the sidebar header, there while the user
has a schedule or a run, opens the **Scheduled** view: the same grouped list,
for runs only, with finished runs under **Recently resolved**. A run that needs
the user is in "Needs you" too. A run is *finished* when nothing is left for the
user: no question waiting, no manual step, no open pull request, and no error at
its end. So in a run, anything the user must decide has to be asked as a
question; a request written only in a message is filed away with the finished
runs.

**Inside a run**, the top of the chat says *Started by schedule …*, with **Open
schedule**, which opens Settings → Schedules at that schedule, **Notes**, and
**Stop run** while the run is not finished. Stopping a run — there, on its row
in Settings, or with the chat's own stop control — makes it finished and holds
every automatic turn until the user writes in it again. After the schedule is
deleted, that line says so and has no controls.

**Notes.** Each run has its own notes folder, where its agent can leave what a
later run should know. In the run it is `/schedule/notes/`, and the run's first
message says so. A run reads the earlier runs' notes with `shipit schedule
notes` (`/shipit-docs/schedules.md`). The user reads any run's notes, read-only,
from **Notes** on its row in Settings → Schedules or in the run's top line; the
notes stay when the run's session is archived or deleted. An agent in any other
session can read a schedule's notes only after the user allows it on a card in
that session's chat — `shipit schedule notes` posts the card — and one approval
covers that one schedule.

**When a run does not start.** A run that comes due while the previous run of
the schedule is still going is skipped, and the skip is in the history; a run
that waits for the user's answer does not count as going. After ShipIt was
down, one catch-up run starts, however many were missed. A start that fails — a
missing credential, no quota, an untrusted or removed repository, a deleted
role — is in the history with its reason, and the schedule shows that reason
until the next start that works, an edit, or a resume. Until then the schedule
is also a row of its own in "Needs you", counted in that button's number, and
its reason is at the top of the Scheduled view, whose clock button carries a
warning mark. Each of these opens Settings → Schedules at the schedule.

## Kinds of session

Most sessions are the ordinary repository-backed kind described above. The
others exist for a reason worth knowing:

| Kind | For |
|---|---|
| **Warm** | A prepared, empty session so "New session" is instant. Becomes ordinary on first message. |
| **Sandbox** | An empty workspace with no repository, and its own capability switches — a scratchpad that can still clone and open pull requests. See `/shipit-docs/sandbox-session.md`. |
| **Ops** | ShipIt's own operations session, for looking at ShipIt itself and at other sessions. Its agent can read the chat of any session on the host — read-only, with credentials redacted — and cannot write to one. Reached from a session's menu. See `/shipit-docs/ops-session.md`. |

## Who does what

| The user does | You do |
|---|---|
| Starts, pins, mutes, archives, forks and rewinds | Everything inside the session |
| Chooses the network mode in Session settings | Say which mode the work needs, and why |
| Merges the pull request | Open it, keep it current, fix what is failing |
| Decides a session is finished | Suggest archiving it once its PR has merged |
