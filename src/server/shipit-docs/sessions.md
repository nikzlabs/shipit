# Sessions

ShipIt sessions are independent workspaces — each with its own clone, its own
git branch, its own chat history, and its own running container. The sidebar
of the ShipIt UI shows the user's sessions; switching between them is a
one-click operation.

You normally work inside a single session: the one the user has open. But
when the user explicitly asks for *another session*, *a parallel branch*, or
*a separate workspace*, you can spawn one without making the user leave chat.

> A **sandbox session** is a different shape: a repo-less workspace where you
> clone and manage your own repos with capability toggles for git/docker/network.
> If you are *in* one (empty `/workspace`, no PR card), **none of this page
> applies**: spawning claims the parent's repo, and a sandbox has no bound repo,
> so `shipit session create` is refused. See
> [sandbox-session.md](sandbox-session.md).

## When to spawn a sibling session

Spawn a new session when **the user has asked for it**. Concretely, when the
phrasing includes:

- "spin up a separate session for X"
- "open another session to work on Y while we keep going here"
- "a parallel workspace to try Z"
- "do this in a different branch so I can review them independently"
- anything where the user clearly wants the work to **land as its own PR**.

If the user has not asked, **don't spawn**. Spawned sessions are heavy:
each one is a full container with its own resource limits, its own clone
on disk, and a separate chat surface for the user to monitor. They are not
a fan-out optimization for your own work.

### Decision rule (Claude)

You have two fan-out primitives:

- **`Task` (built-in tool)** — in-turn fan-out. Same workspace, same
  container, parallel research / parallel codegen / anything you'll
  synthesize into your current reply. Use this by default for any "do
  several things in parallel" within a single turn.
- **`shipit session create` (this shim)** — separate session, separate
  container, separate branch. Use only when the user has explicitly asked
  for "another session" / "a parallel branch" / a workspace they will
  review independently as a PR.

If you're unsure, ask the user. Spawning a session is a heavier action than
running a `Task`.

### Decision rule (Codex)

Codex has no in-process subagent primitive. `shipit session create` is your
only fan-out primitive — and that doesn't make it cheap. The same
"user-prompted, sidebar-visible" guardrails apply: only spawn when the user
has signaled they want parallel work. Don't reach for it as a generic
optimization for your own work.

### Child vs detached spawns

A `shipit session create` spawn comes in two shapes. Pick deliberately:

- **Child (default).** The new session is **linked** to yours: it nests under
  you in the sidebar, and you can coordinate it — `list`, `view`, `wait`,
  `message`, `notify-on-merge`. Use this when the spawned work is **related to
  what you're doing here** and you'll want to track it: you'll want its result,
  you'll rebase onto it, you'll follow up, or you'll want to be told when it
  merges.

- **Detached (`--detached`).** The new session is **completely separate** — no
  parent link, no sidebar nesting, no coordination, and **no card in this
  chat**. It is identical to a session the user created by hand. Once you spawn
  it, your relationship to it is over: you **cannot** `wait` / `view` /
  `message` / `notify-on-merge` it (those only reach children). Use it **only**
  for work that is **unrelated to your current task and that you will never need
  to hear about again**.

**The test:** *will I, or the user through this session, ever want to know what
happened to it?* If **yes** → child (omit `--detached`). If **no** — it's
incidental, unrelated work you're handing off for good — → `--detached`. Put
another way: **if a notification would ever be useful, it should have been a
child.**

**Canonical `--detached` case.** While implementing feature A you (or the user)
notice an unrelated bug, and the user asks you to spin off a session to fix it.
That fix has nothing to do with A — you won't wait on it, won't rebase onto it,
don't care when it merges. Spawn it `--detached` and carry on with A:

```sh
shipit session create --detached --prompt-file - --title "Fix unrelated logging bug" <<'EOF'
There's an unrelated bug: the request logger double-encodes the trace id. Fix it
and open a PR. This is independent of any other in-flight work.
EOF
```

**Do NOT use `--detached`** when the spawned work merges into something you
depend on, when you'll send it follow-ups, or when you want to be notified on
merge — that is exactly what a child spawn is for. When unsure, prefer the child:
an unused coordination handle costs nothing, but a detachment you regret cannot
be undone (there is no link to re-establish, and no `adopt`). `--detached` is
rejected together with `--shipit-source` (a fix session is inherently tracked).

## The `shipit` shim

`shipit` is a **ShipIt-provided shim**, not a generic CLI. It exposes a
narrow allowlist of session-management operations brokered through the
orchestrator. The agent never touches a session-management API directly —
the worker injects this container's session id as the parent on every
request, so you can only spawn / view / list children **of your own
session**.

Operations on sessions you didn't spawn are rejected. There is no flag to
override the parent.

### Supported subcommands

| Subcommand | Notes |
|---|---|
| `shipit session create --prompt-file FILE --title T [--agent claude\|codex] [--model M] [--turn ID] [--detached] [--json]` | Spawn a sibling session with the prompt from `FILE` (or `-` for stdin) as its first user message. The child always branches off the parent repo's freshly-fetched `origin/main`, so a change you just merged (e.g. a design doc) is visible to it — there is no `--base` to pin it elsewhere. `--title` is **required** — you name the session. There is no inline `-p`/`--prompt` — the prompt must come from a file or stdin so backticks and `$(...)` aren't evaluated by the shell. The child's branch is auto-generated (`shipit/<random>`) — you cannot name it. `--detached` makes the new session **completely separate** instead of a child — see *Child vs detached* below. Returns the child's id, branch, and status on stdout. **`--agent`/`--model` selection (set these only when the user asks for a specific backend/model — e.g. "do this part with Codex"):** the **model is the source of truth** — pass `--model gpt-5.5` alone and the child is routed to its owning backend (Codex) automatically; you don't also need `--agent`. Pass `--agent` on its own to switch backend while keeping that backend's default model. A bad value fails fast before the child boots: an unknown `--agent`, or a `--model` that belongs to a *different* backend than the `--agent` you named, is rejected with a clear error (a model the picker hasn't surfaced yet is still accepted — the CLI forwards it as-is). When neither flag is set, the child inherits the parent's agent and model. |
| `shipit session list [--turn ID] [--json]` | List sessions spawned by this parent. With `--turn`, sessions spawned in the given turn bubble to the top. |
| `shipit session view <id> [--json]` | Read a child session: status (`running`/`idle`/`error`), branch, queue length, spawn timestamp, latest assistant message preview, PR URL when available, and the resolved `agent` + `model` the child actually runs on (use these to confirm the backend/model rather than trusting the child's own self-report, which models are unreliable at). |
| `shipit session message <id> -m "TEXT" [--json]` | Send a follow-up prompt to a child this parent spawned. The orchestrator either starts a turn immediately (if the child is idle) or enqueues the prompt; exit is `0` either way and the response prints the queue position. |
| `shipit session wait <id...> [--timeout SECONDS] [--any\|--all] [--json]` | Wait until the child reaches a terminal state, or the timeout elapses. **Resilient**: it polls in short segments and absorbs connection resets / orchestrator redeploys beneath you, so a single call is the robust unit — you never script your own retry loop. Default 5 minutes, capped at 1 hour. Outcomes are distinguishable by exit code: `idle`/`archived` → `0`, child **error** → `3`, timed-out → `1`. Pass multiple ids with `--any` (resolve on the first finisher) or `--all` (resolve when every child finishes); the `--timeout` is shared across all of them. See *Coordinating* below. Note: `wait` blocks only until the child's *agent turn* goes idle (code written / PR opened) — it does **not** wait on a human **merge**. For that, use `notify-on-merge`. |
| `shipit session notify-on-merge <id> [--json]` | **Async** — arm a watch and return immediately (exit `0`, "armed"); the turn ends. When the child's PR later **merges**, the orchestrator wakes *this* session with a queued, self-describing system turn (child id, branch, merged PR ref, merge SHA, and the intent: "proceed with the planned rebase unless the user has since redirected you") and surfaces a "Child PR merged" card in this chat. If the PR **closes without merging**, you get a *distinct* wake-turn telling you the work did **not** ship — don't proceed as if it had. Use this instead of blocking a turn on a human merge (which can take days). The child's PR need not exist yet — the watch fires once it appears and resolves. Fires once. Only the parent that spawned the child may watch it. If the wake-turn itself can't be delivered (this session's container won't resume, for instance) the orchestrator retries it on a backoff; after repeated failures it gives up and posts a "Couldn't resume this session" card in this chat naming the merged PR, so the merge is never silently dropped — send a message here to continue by hand. |
| `shipit session notify-on-merge --self [--json]` | **Async, and about YOUR own PR.** Arm a watch on this session's currently-open PR and return immediately; the turn ends. When that PR merges — by hand, from ShipIt or GitHub, or via auto-merge — the orchestrator wakes **this** session with a turn telling you to run `shipit branch reset-to-base` and then continue the work you were already asked for. Use it when the user asked for several PRs in a row and the next step can only start after this one lands. Refuses if the branch has no open PR (open one first; if your PR has *already* merged, just keep going in this turn). Arming always **replaces** any previous self-watch, so re-arming mid-chain is normal. **Nothing re-arms on your behalf** — after you open the next PR, run it again if more work remains. See *Chaining several PRs* below. |
| `shipit session archive <id> [--json]` | Archive a child this parent spawned. Refuses with a clear error when the child is still running — use `shipit session wait` first. |
| `shipit session whoami [--json]` | Resolve **this** session: id, title, branch, status, its parent, its cohort siblings, and any children it spawned. `view <id>` is descendant-scoped, so passing your own id doesn't work — use this. A bare `shipit session view` (no id) is the same thing. |
| `shipit session report -b TEXT \| --body-file FILE [--severity fyi\|warn\|blocker] [--subject T] [--to parent\|cohort] [--json]` | Push a report **up** to the session that spawned you (and, with `--to cohort`, to every live sibling). Each recipient gets a card in its chat **and** a queued system turn, so the report is pushed, not waiting to be pulled. See *Reporting upward* below. |
| `shipit session help` | Print the subcommand reference. |

Every supported subcommand accepts `--help` (or `-h`) and points to the
canonical agent-facing documentation for its full usage and examples. This
applies across the `session`, `source`, `issue`, `agent`, `service`, `release`,
and `branch` command groups.

The prompt is passed via `--prompt-file` — a file path, or `-` to read from
stdin — never an inline flag. A prompt on the command line gets mangled when it
contains backticks or `$(...)`, which the shell evaluates before the shim sees
the value (the same reason `gh pr create` uses `--body-file`). Use a
single-quoted heredoc so the prompt is preserved verbatim:

```sh
shipit session create --prompt-file - --title "Port API to TypeScript" <<'EOF'
Port the API in /server to TypeScript. Land it as a separate PR.
Keep the public `routes` table and the $(generated) types intact.
EOF
```

The `EOF` delimiter must be single-quoted. Passing `-p`/`--prompt`/`-m` exits
non-zero with a pointer back to `--prompt-file`.

`--title` is **required** for every spawn. You — the spawning agent — already
know what the session is for, so you name it: pass a short, human-readable title
(e.g. `--title "Port API to TypeScript"`) that identifies the session in the
sidebar. A spawn with no title exits non-zero before any session is created.

**Ops-only** (`kind: "ops"` sessions — see `ops-session.md`): pass
`--shipit-source` to `shipit session create` to spawn a fix session that targets
the **ShipIt repository itself**, branched from the exact deployed commit you
inspected with `shipit source`. The orchestrator verifies the operator's GitHub
account can push to the ShipIt repo before creating the child, seeds the child
with an incident packet (source ref, exactness, your diagnosis, constraints),
and otherwise behaves like a normal spawn — the child owns all edits, tests,
commits, push, and the PR. Add `--approximate` to acknowledge a non-exact source
ref. `--shipit-source` is rejected outside Ops sessions.

`--title` is **required** for every spawn (above), and it matters doubly here:
the diagnosis is wrapped in the incident packet, so it could never name the
session even if title naming fell back to the prompt. Pass a short, human-readable
title describing the fix (e.g. `--title "Fix container recreate loop"`) so the
spawned session is identifiable in the sidebar.

The child branch *starts* at the inspected deployed commit (so it can reproduce
the production bug), which is usually behind the repo's default branch; the
incident packet tells the child to rebase onto the latest default branch before
opening its PR so the PR stays mergeable. Fix-session spawns have their own
per-turn cap (default 6, env `MAX_SHIPIT_FIX_SESSIONS_PER_TURN`) — an Ops
investigation that turns up several independent defects can spin up a fix
session per defect in a single turn rather than batching them into one PR.

### Example

```sh
# User asked: "Spin up a separate session to port the API to TypeScript."
shipit session create --prompt-file - --title "Port API to TypeScript" <<'EOF'
Port the API in /server to TypeScript. Land it as a separate PR.
EOF
# session-id: ses_abc123
# branch:     shipit/k7p2qz
# status:     running
```

```sh
# Coordinate later in the conversation:
shipit session list
# ses_abc123    running    shipit/k7p2qz    Port API to TypeScript
shipit session view ses_abc123
# Port API to TypeScript (ses_abc123)
# status:     running
# branch:     shipit/k7p2qz
# queue:      0
# spawned-at: 2026-05-04T14:22:31Z
```

### Subcommands that are intentionally unavailable

These exist in the agent's mental model of ShipIt but the shim refuses to
expose them — either because the operation is destructive (and belongs to
the user, not the agent), or because it widens the surface in ways doc 117
explicitly declined to ship in v1:

- `shipit session delete <id>` — destructive; user-only.
- `shipit session fork|rename|switch` — owned by the UI, not the agent.
- `shipit session adopt <id>` — adopting an unrelated session into the
  parent's tree is not supported.
- `--repo`, `--owner` on any subcommand — spawned sessions inherit the
  parent's repo and owner. No cross-repo spawns in v1.

If you try one, the shim exits non-zero with an error pointing back to this
file.

### Coordinating with a spawned session

After spawning, you have four downward coordination levers — `wait`, `message`,
`notify-on-merge`, `archive` — all reaching the child via the parent → child
linkage; you cannot operate on sessions you didn't spawn. (The upward direction
is `shipit session report`, below.)

```sh
# Spawn a long-running task on its own branch (branch name is auto-generated).
shipit session create --prompt-file - --title "Migrate API to Drizzle" <<'EOF'
Migrate the API to Drizzle
EOF
# session-id: ses_abc

# Block until the child reaches a terminal state (or the timeout fires).
shipit session wait ses_abc --timeout 1800
# The wait is resilient: it polls in short segments and silently retries
# through connection resets and orchestrator redeploys, so you don't need
# to re-issue it yourself. Branch on the exit code, NOT on transport noise:
#   exit 0 → child idle / archived (finished its turn(s), nothing queued)
#   exit 3 → child's last turn ERRORED — do NOT treat as success
#   exit 1 → timed out while the child was still running (or it was not found)
# With --json the same outcome is in the `outcome` field, and a swallowed
# transport hiccup (if any) is reported in `lastTransportError` — it is never
# itself an outcome, so "exit 1" always means a real timeout, not a blip.

# Orchestrate a fleet with one call. --any wakes you on the first finisher
# so you can act on it, then wait on the rest; --all waits for everyone.
shipit session wait ses_a ses_b ses_c --any --timeout 1800
shipit session wait ses_a ses_b ses_c --all --timeout 1800

# Send a follow-up prompt without the user switching sessions.
shipit session message ses_abc -m "Also update the README to mention Drizzle"

# Be woken when the child's PR MERGES — without blocking this turn. `wait`
# only blocks until the child's agent goes idle (PR opened); the human merge
# can take days, so don't wait on it. Arm a watch and end your turn instead:
shipit session notify-on-merge ses_abc
# notify-on-merge: armed
# …turn ends. Later, when ses_abc's PR merges, THIS session gets a queued
# system turn ("child PR merged — proceed with the planned rebase") plus a
# merge card. If the PR is closed unmerged, you get a distinct "did not ship"
# wake-turn instead. The watch fires once and survives an orchestrator restart.

# Archive an idle child that's done its job. Refuses while the child is
# still running — `wait` first if you want a deterministic teardown.
shipit session archive ses_abc
```

Be conservative with `message` — every prompt you push lands in the
child's chat, visible to the user. Use it for coordination, not for
chattering at the child agent.

### Reporting upward (and to your cohort)

Everything above is parent → child. `shipit session report` is the other
direction: it is how a **spawned session** tells the session that spawned it —
and, optionally, its siblings — something they need to know. Without it, a
finding can only sit in your PR body or your final turn summary, where nobody
learns about it until they go and look.

First, know where you are:

```sh
shipit session whoami
# session:  Elementalist catalog (ses_def)
# status:   running
# branch:   shipit/9fq2xa
# parent:   Spell catalogs (ses_abc)
#
# siblings:
#   ses_ghi  running  shipit/k1m4tz  Druid catalog
#   ses_jkl  idle     shipit/p8w0rd  Necromancer catalog
# children: (none)
```

Then push what travels:

```sh
shipit session report --severity blocker --to cohort \
  --subject "regen command deletes every catalog" --body-file - <<'EOF'
`npm run regen` clears data/catalogs/ before writing, so running it destroys the
druid and necromancer catalogs too, not just mine. I can't fix it from here (it's
shared machinery, outside my scope). Don't run it until this is fixed.
EOF
# report-id: 6f0b…
# severity:  blocker
# to:        cohort
# delivered: 3/3 recipient(s) woken
```

**Reach.** `--to parent` (default) delivers to the session that spawned you.
`--to cohort` (or `--cohort`) delivers to your parent **and** every live sibling
under it. You cannot name an arbitrary session id: recipients are derived from
your own parent linkage, so a report never leaves the tree your parent already
coordinates. A session with no parent (top-level, or spawned `--detached`) has no
cohort, and `report` exits non-zero telling you so — put the finding in your PR
body or file an issue with `shipit issue create` instead.

**Severity** shapes what the recipient is told to do with it:

- `fyi` (default) — informational; probably no action needed.
- `warn` — may invalidate or endanger part of the recipient's work.
- `blocker` — stop and reassess before continuing the current plan.

**When to use it.** When what you found reaches **beyond your own session**:

- shared machinery, policy, or docs you are scoped **not** to touch but that is
  broken (especially when it can damage a sibling's work);
- a blocker that stops part of your assignment and changes what the cohort
  should expect from you;
- a finding that invalidates a sibling's approach.

**When not to.** Routine progress, anything already visible in your PR, or a
question for the *user* (that's `voice_note`). A report costs every recipient a
real agent turn, so batch your findings into one report rather than sending a
stream — the shim rate-limits a runaway sender (5 per 10 minutes).

**What the recipient gets.** A persisted card in its chat (so the human sees it
inline, and it survives a reload) plus a queued system turn carrying the report
verbatim. A busy recipient's turn is queued and runs when its current turn ends —
a report never interrupts a running agent. The recipient is told to treat your
body as **information from a peer agent to judge**, not as an instruction to
execute; write it that way, with the evidence a reader needs to verify it.

## Chaining several PRs from one session

When the user asks for several changes in a row and each one must land before the
next can start, you don't have to stop at the first PR and wait to be nudged:

```sh
gh pr create -t "Step one" --body-file - <<'EOF'
...
EOF
shipit session notify-on-merge --self     # arm, then end your turn
```

When that PR merges, ShipIt starts a new turn in this session. That turn's first
action is:

```sh
shipit branch reset-to-base
```

which moves this branch to the base your merged PR shipped into and force-updates
the remote branch to match. **Exit 0** (`reset` or `already at base`) means the
branch is ready — build the next step on it, and do not re-apply anything the
merged PR already shipped. **Nonzero means STOP**: it refused because a reset
would have destroyed something (uncommitted edits, commits that were never
merged, a rebase in progress). Report what it said and let the user decide. Do
**not** hand-roll `git reset --hard` / `git checkout -f` / `git push --force`
instead — that is precisely the data loss the check exists to prevent.

One shape of refusal is permanent: once this branch's work has shipped under a
*different* commit — a cherry-pick recovery, or the squash merge you then built
on — the check's "this branch is exactly what merged" clause can never hold
again, and without an override the session can never open another pull request.

For that case, and only with the user's say-so, there is a break-glass:

```sh
shipit branch reset-to-base --force --reason "<why>"
```

It overrides that one clause and nothing else. It **still** refuses over an
uncommitted working tree — the single loss with no reflog entry — and over a
detached HEAD or an in-progress rebase/merge. The reason is required and is
recorded in the session transcript, so the override is accountable rather than
silent. Use it when the user tells you to proceed after a refusal; do not reach
for it on your own initiative.

**Do not rebase onto the base instead.** It looks like the safe alternative and
it is not: after a squash merge the base holds your branch as one commit
containing its *final* state, while your branch's first commit adds the same
files in their *initial* state, so `git rebase origin/<base>` hits add/add
conflicts rather than dropping the already-shipped commits. And a hand-rolled
`git reset --hard` is worse than the `--force` above, not equivalent: no
clean-tree check, no recorded reason, no transcript card. It is also blocked.

That last point is **enforced, not just advised**: while a session sits on a
merged branch (ShipIt has recorded the merged head commit), `git reset --hard`,
`git checkout -f` and force-pushes are blocked before they run, and the refusal
points you back here. `shipit branch reset-to-base` is unaffected — it relays to
the orchestrator rather than running git in your shell. The block is scoped to
that window only: on an ordinary session, discarding a local mess with
`git reset --hard` still works normally.

Then continue the work, open the next PR, and — if more remains after it — run
`shipit session notify-on-merge --self` again. Each link re-arms itself; ShipIt
models no chain, so a link you don't arm is where the chain ends. If the user
cancels the watch (there's a Cancel on the card the arm posts), no wake fires and
nothing re-arms.

Notes:
- Only arm it when work genuinely remains. A session that is done should just
  finish — an armed watch on a finished session wakes it up for nothing.
- If the PR is **closed without merging**, no turn runs: the watch is cleared and
  a note explains why (the commits were rejected, so there is nothing to build
  on).
- A session cannot be self-watching *and* watched by its parent at the same time
  (one watch per session); `--self` is refused in that case and says so.

## What spawning a session does

Under the hood, `shipit session create`:

1. Asks the orchestrator to clone a fresh workspace (from the parent's bare
   cache, or by copying the parent's local repo when there's no remote).
2. Cuts the child's branch off the parent's current `HEAD` — so the child
   sees the parent's committed work but **not** any uncommitted edits in
   the parent's working tree.
3. Persists a parent linkage on the child's session row, so the sidebar can
   group it under the parent and `shipit session list` can scope by parent.
   **With `--detached` this step is skipped** — no parent linkage is written, so
   the session is top-level (not nested) and uncoordinatable (see *Child vs
   detached spawns* above).
4. Enqueues the `--prompt-file` contents as the child's first user message, so
   the child's agent starts working autonomously the moment its container is ready.
5. Surfaces the new session in the user's sidebar immediately.

For a **child** spawn the parent's chat shows a system note that a session was
spawned; a **detached** spawn shows nothing in this chat (its only trace is its
own PR, when it opens one). In both cases the parent **cannot**:

- Read or write the child's files directly (no shared workspace).
- Approve permission prompts on the child's behalf.
- Cancel a running turn in the child.
- Change the child's branch, model, or permission mode.
- Merge the child's work into the parent's branch automatically — that goes
  through the existing PR/merge flow.

## Quotas

Spawn limits are enforced fail-closed:

- **Per-turn cap** — default 6 new spawns per turn. Counted via `--turn`.
- **Per-parent cap on active children** — default 16 non-archived spawned
  children per parent. Archive a child via the UI before spawning another
  if you hit this cap.

When a quota is hit, the orchestrator returns HTTP 429 and the shim prints
a helpful error pointing back here.

## Push and PR semantics

The child session is a regular session in every way. It auto-commits on
each turn, auto-pushes (if GitHub is connected), and opens PRs through the
same `gh pr create` shim documented in `github.md`. The user merges via the
UI.

## Permission modes

The user picks a permission mode per turn from the chat input. There are three
(oversight ladder, most → least):

- **Plan** — read-only. You can research and write a plan but the write/edit/
  shell tools are not available. Use `ExitPlanMode` (Claude) to surface the
  plan for approval.
- **Guarded** — autonomous, but every shell/network command you issue is
  reviewed by a separate Claude safety classifier *before* it runs. Read-only
  actions and edits to files in the working directory are auto-approved;
  anything risky (e.g. `curl | bash`, force-push, pushing to `main`, deleting
  pre-existing files, exfiltrating secrets) is **blocked** and you receive the
  reason as a tool result. When blocked, find a safer path or tell the user
  what you'd need them to run. A single block doesn't end the turn, but
  repeated blocks will. Guarded mode is Claude-only and requires a Sonnet or
  Opus model on a Max/Team/Enterprise plan; when unavailable the turn silently
  falls back to auto and the user is told.
- **Auto** — autonomous with no classifier. The default. Safety here rests on
  the tool allowlist, the branch-block hook, and container isolation.

Independently of the mode, the branch-block hook always prevents branch
operations, and conversational boundaries the user states ("don't push until I
review") are honored under guarded mode.
