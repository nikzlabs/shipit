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
| A small disk glyph | The session was trimmed to save space — see idle reclaim below |
| Relative time | When it was last used |

There is a second sidebar view, **"Needs you"**, reached from the icon in the
sidebar header, which carries a count. It is a flat list — no repository
grouping — of only the sessions waiting on the user. A session that stops
needing attention while that view is open keeps its place and is marked as no
longer waiting, rather than vanishing under the cursor.

ShipIt can also raise a browser notification when a session starts needing the
user, including on a phone. It waits a couple of seconds before doing so,
because a session that is mid-handover briefly looks stopped.

## What is on a session's menu

Every row has an overflow menu. In order:

- **Rename** — the session's title only. It never renames the branch.
- **Pin to top** — see below; this is more than ordering.
- **Mute until next turn** — only offered when the session is actually asking
  for attention and its agent is not working.
- **Keep preview running** — a tick; exempts this session's services from being
  stopped when it goes idle.
- **Archive**.
- **Recover recent rewind** — undo a rewind, on the open session.
- **Download chat** — the conversation as a file.
- **Investigate in Ops session** — opens ShipIt's own operations session pointed
  at this one, when that is available.
- **Session settings** — currently the per-session network choice: contained, or
  open.

An archived row offers **Restore** instead.

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
that. Rewinding is refused while a turn is running; the user interrupts first.

A fork is a real, separate session with its own branch and its own pull request,
and ShipIt switches to it when it is ready.

## Attention, and turning it off

A session needs attention when it has stopped and wants something: an answer, a
permission decision, a failed run, a merged PR. **Mute until next turn** silences
that without changing anything else — the session stays active and in the list,
and looks like a session with nothing pending. The mute lifts by itself when the
next turn starts, however it starts. The user can unmute earlier. A mute is
stored with the session, so it holds on their phone too.

Only a session that is currently asking for attention, and whose agent is not
working, can be muted. If the user wants to silence a *busy* session, the answer
is that there is nothing to silence yet.

## Going idle, and what ShipIt reclaims

Sessions do not run forever. ShipIt reclaims resources when it is over its
memory budget, taking the longest-idle first — never a session with someone
watching it, and never one whose agent is working.

What that looks like, in order of severity:

1. **The agent container stops.** The conversation, the branch and the files are
   all intact; the next message starts a fresh container.
2. **The preview keeps running** while the budget allows — including the
   background services, not just the one on screen. Coming back to the session
   shows the app immediately. **Keep preview running** on the menu exempts a
   session from this being reversed.
3. **Dependencies are cleared** to save disk. The row shows a mark reading
   *"Dependencies cleared to save disk — reinstalled when you open it"*. Opening
   the session reinstalls them.
4. **The workspace is stored** and restored from the shared cache on next open.

Two consequences to state plainly when they come up. Anything **committed** is
safe, and ShipIt commits after every turn. Anything started by hand inside the
container — a background process, a `setInterval`, a dev server launched from
the terminal — does **not** survive, and does not come back. Long-running work
belongs in `docker-compose.yml`; one-time setup belongs in `shipit.yaml`.

**A pinned session is exempt.** Pinning sticks a session to the top of its
repository's group *and* makes it persistent: it is never silently dropped from
the list, and its workspace is never auto-reclaimed. That is the reason to
recommend a pin, not the ordering.

## Archiving

Archiving takes a session out of the way and frees what it was holding, keeping
the conversation. It is reversible from the archived row's **Restore**. Use it
when a session's pull request has merged and the work is done; it is the tidy
end of a session's life, not a delete.

## Sessions that spawn sessions

A session can have children — separate sessions, nested under it in the sidebar,
each with its own branch, container and pull request. That is how a large piece
of work is split so each part can be reviewed on its own. You create them, and
coordinate with them, through `shipit session` — see `/shipit-docs/sessions.md`
for when that is the right shape and when a sub-agent or a consult is better.

Three things users ask about children:

- They report **upward only**. A child can raise a blocker to its parent; it
  cannot talk to its siblings.
- **Being told about a merge** does not need watching. `shipit session
  notify-on-merge` wakes the session when the pull request lands.
- A child sees the repository as of **main**, not the parent's uncommitted or
  unmerged work. Work it must build on has to be merged first, or carried in
  the prompt.

## Kinds of session

Most sessions are the ordinary repository-backed kind described above. The
others exist for a reason worth knowing:

| Kind | For |
|---|---|
| **Warm** | A prepared, empty session so "New session" is instant. Becomes ordinary on first message. |
| **Sandbox** | An empty workspace with no repository, and its own capability switches — a scratchpad that can still clone and open pull requests. See `/shipit-docs/sandbox-session.md`. |
| **Ops** | ShipIt's own operations session, for looking at ShipIt itself and at other sessions. Reached from a session's menu. See `/shipit-docs/ops-session.md`. |

## Who does what

| The user does | You do |
|---|---|
| Starts, pins, mutes, archives, forks and rewinds | Everything inside the session |
| Chooses the network mode in Session settings | Say which mode the work needs, and why |
| Merges the pull request | Open it, keep it current, fix what is failing |
| Decides a session is finished | Suggest archiving it once its PR has merged |
