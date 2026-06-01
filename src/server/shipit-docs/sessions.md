# Sessions

ShipIt sessions are independent workspaces — each with its own clone, its own
git branch, its own chat history, and its own running container. The sidebar
of the ShipIt UI shows the user's sessions; switching between them is a
one-click operation.

You normally work inside a single session: the one the user has open. But
when the user explicitly asks for *another session*, *a parallel branch*, or
*a separate workspace*, you can spawn one without making the user leave chat.

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
| `shipit session create -p "PROMPT" [--title T] [--base REF] [--agent claude\|codex] [--model M] [--turn ID] [--json]` | Spawn a sibling session with `PROMPT` as its first user message. The child's branch is auto-generated (`shipit/<random>`) — you cannot name it. Returns the child's id, branch, and status on stdout. |
| `shipit session list [--turn ID] [--json]` | List sessions spawned by this parent. With `--turn`, sessions spawned in the given turn bubble to the top. |
| `shipit session view <id> [--json]` | Read a child session: status (`running`/`idle`/`error`), branch, queue length, spawn timestamp, latest assistant message preview, PR URL when available. |
| `shipit session message <id> -m "TEXT" [--json]` | Send a follow-up prompt to a child this parent spawned. The orchestrator either starts a turn immediately (if the child is idle) or enqueues the prompt; exit is `0` either way and the response prints the queue position. |
| `shipit session wait <id> [--timeout SECONDS] [--json]` | Long-poll until the child is idle (`running=false && queueLength=0`) or the timeout elapses. Default 5 minutes, capped at 1 hour. Exits non-zero on timeout. |
| `shipit session archive <id> [--json]` | Archive a child this parent spawned. Refuses with a clear error when the child is still running — use `shipit session wait` first. |
| `shipit session help` | Print the subcommand reference. |

**Ops-only** (`kind: "ops"` sessions — see `ops-session.md`): pass
`--shipit-source` to `shipit session create` to spawn a fix session that targets
the **ShipIt repository itself**, branched from the exact deployed commit you
inspected with `shipit source`. The orchestrator verifies the operator's GitHub
account can push to the ShipIt repo before creating the child, seeds the child
with an incident packet (source ref, exactness, your diagnosis, constraints),
and otherwise behaves like a normal spawn — the child owns all edits, tests,
commits, push, and the PR. Add `--approximate` to acknowledge a non-exact source
ref. `--shipit-source` is rejected outside Ops sessions.

### Example

```sh
# User asked: "Spin up a separate session to port the API to TypeScript."
shipit session create \
  -p "Port the API in /server to TypeScript. Land it as a separate PR." \
  --title "Port API to TypeScript"
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

After spawning, you have three coordination levers — all read or write the
child via the parent → child linkage; you cannot operate on sessions you
didn't spawn.

```sh
# Spawn a long-running task on its own branch (branch name is auto-generated).
shipit session create -p "Migrate the API to Drizzle"
# session-id: ses_abc

# Block until the child is idle (or the timeout fires).
shipit session wait ses_abc --timeout 1800
# When the wait times out, the shim exits non-zero — handle in scripts.

# Send a follow-up prompt without the user switching sessions.
shipit session message ses_abc -m "Also update the README to mention Drizzle"

# Archive an idle child that's done its job. Refuses while the child is
# still running — `wait` first if you want a deterministic teardown.
shipit session archive ses_abc
```

Be conservative with `message` — every prompt you push lands in the
child's chat, visible to the user. Use it for coordination, not for
chattering at the child agent.

## What spawning a session does

Under the hood, `shipit session create`:

1. Asks the orchestrator to clone a fresh workspace (from the parent's bare
   cache, or by copying the parent's local repo when there's no remote).
2. Cuts the child's branch off the parent's current `HEAD` — so the child
   sees the parent's committed work but **not** any uncommitted edits in
   the parent's working tree.
3. Persists a parent linkage on the child's session row, so the sidebar can
   group it under the parent and `shipit session list` can scope by parent.
4. Enqueues `--prompt` as the child's first user message, so the child's
   agent starts working autonomously the moment its container is ready.
5. Surfaces the new session in the user's sidebar immediately.

The parent's chat shows a system note that a session was spawned. The
parent **cannot**:

- Read or write the child's files directly (no shared workspace).
- Approve permission prompts on the child's behalf.
- Cancel a running turn in the child.
- Change the child's branch, model, or permission mode.
- Merge the child's work into the parent's branch automatically — that goes
  through the existing PR/merge flow.

## Quotas

Spawn limits are enforced fail-closed:

- **Per-turn cap** — default 4 new spawns per turn. Counted via `--turn`.
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
