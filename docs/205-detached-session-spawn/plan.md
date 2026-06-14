---
issue: https://linear.app/shipit-ai/issue/SHI-141
description: A --detached flag on `shipit session create` that spawns a completely separate, unlinked session for unrelated work — no parent link, no sidebar nesting, no coordination, no notification.
---

# 205 — Detached Session Spawn

## Summary

Add `shipit session create --detached`: a spawn that produces a session
**indistinguishable from one the user created by hand**. No parent linkage, no
sidebar nesting, no coordination handle, no parent-chat card. The spawning agent
hands the work off and forgets it exists.

This is the third rung of an escalating-separateness ladder. Today the agent has
two fan-out primitives (`Task` and the default coordinated `shipit session
create`); detached is for the case where the spawned work has **nothing to do
with the current task** and the agent should never hear about it again.

## Motivation

The driving use case: while implementing feature A, the agent (or the user)
notices an **unrelated** bug. The user says "spin off a session to fix that bug."
That fix has nothing to do with A — the current session won't wait on it, won't
rebase onto it, won't follow up, and doesn't care when it merges. The default
spawn is wrong for this: it links the child to the parent (`parentSessionId`),
nests it under the parent in the sidebar, emits a `session_spawned` card in the
parent chat, and advertises `wait`/`message`/`notify-on-merge` coordination —
all of which is noise for genuinely independent work.

The user's litmus test, which defines the whole boundary:

> **If you would ever want a notification about it, it should have been a child
> session.** Detached is exactly the set of spawns where the answer is "no."

## The three-primitive ladder

| Primitive | Workspace | Lifetime | Relationship to current task | Coordination | Sidebar |
|---|---|---|---|---|---|
| **`Task` tool** | shared (this container) | this turn | you synthesize its result into *this* reply | in-turn only | — (no session) |
| **`shipit session create`** (child, default) | own clone/branch | persistent | **related** — feeds back here | `wait` / `message` / `notify-on-merge` | nested under parent |
| **`shipit session create --detached`** | own clone/branch | persistent | **unrelated** — handed off for good | none | flat, top-level (like a manual session) |

## Design

The decoupling is almost entirely "don't write two columns."

Per [doc 201](../201-nested-child-session-visibility/plan.md), two distinct
fields back the parent relationship today, and they happen to be written together
on a normal spawn:

- **`rootSessionId`** — drives sidebar **nesting** (the visibility filter in
  `filterVisibleInSidebar()` and the brood render in `SessionSidebar.pushTree`).
- **`parentSessionId`** — drives **coordination** (the `shipit` shim scopes
  `list`/`view`/`wait`/`message`/`notify-on-merge` through `findChildren(parent)`)
  and lineage/provenance.

A detached spawn writes **neither**:

- **No `rootSessionId`** → the sidebar has nothing to bucket it under, so it
  renders as a normal top-level row. No new presentation flag is needed —
  null *is* the flat behavior.
- **No `parentSessionId`** → the session is uncoordinatable **by construction**.
  `findChildren(parent)` never returns it, so the shim literally cannot `view`,
  `wait` on, `message`, or `notify-on-merge` it. There is no leash to forget to
  drop, and no orphan-on-parent-archive problem to handle — there was never a
  link.
- **No `session_spawned` event / `SpawnedSessionCard`** → the parent chat shows
  nothing. The agent can still describe what it did in its own prose ("I spawned
  a separate session to fix the unrelated logging bug"), but there is no
  persistent card and no Undo affordance tying the two sessions together.

### The one thing that *is* retained: invisible quota accounting

`spawnedByTurn` is still stamped on a detached spawn — **not** as a relationship,
but because the **per-turn spawn cap** (`MAX_SPAWNED_SESSIONS_PER_TURN`, default
4) counts through it. A detached spawn still boots a full container, so it must
still count against the anti-runaway cap. This is purely internal accounting:
`spawnedByTurn` is never surfaced (the turn-scoped `shipit session list --turn`
still resolves through `findChildren`, which a parentless session is absent
from), so it does not make the session visible, listable, or linked. The
per-**parent** active-children cap does *not* apply to detached spawns (they
aren't anyone's child); they count only against whatever global/user session
limits exist, same as a manual session.

> Decision: keep `spawnedByTurn` for rate-limiting only. If we ever want
> detached spawns truly uncounted, that's a follow-up — but unbounded
> container creation from a single turn is a footgun we shouldn't open.

## Agent instruction (destined for `shipit-docs/sessions.md`)

This is the load-bearing deliverable — the guidance the running agent reads. It
ships into `sessions.md` **when the flag lands**, not before (documenting a flag
that errors would mislead the agent). Draft:

> ### Detached spawns — completely separate, fire-and-forget
>
> `shipit session create --detached` spawns a session that is **completely
> unlinked** from yours: it does not nest under you in the sidebar, you cannot
> `wait` / `message` / `view` / `notify-on-merge` it, and no card appears in
> this chat. It is identical to a session the user created by hand. Once you
> spawn it, your relationship to it is over.
>
> **Use `--detached` only when the work is unrelated to your current task and
> you will never need to hear about it again.** The test: *will I, or the user
> through this session, ever want to know what happened to it?* If yes — you'll
> want its result, you'll rebase onto it, you'll follow up, or you'll want to be
> told it merged — then it is **not** detached; use a plain `shipit session
> create` (a child) and keep the coordination handle. If no — it's incidental,
> unrelated work you're handing off for good — use `--detached`.
>
> **Canonical example.** While implementing feature A you spot an unrelated bug
> and the user asks you to spin off a fix. That fix has nothing to do with A:
> you won't wait on it, won't rebase onto it, don't care when it merges. Spawn
> it `--detached` and carry on with A.
>
> **Do NOT use `--detached`** when the spawned work merges into something you
> depend on, when you'll send it follow-ups, or when you want to be notified on
> merge — that is the whole point of a child spawn. When unsure, prefer the
> child (default): a coordination handle you don't use costs nothing, but a
> detachment you regret cannot be undone (there is no link to re-establish).
>
> All the usual spawn guardrails still apply: spawn only when the user has asked
> for it, `--title` is required, the prompt comes from `--prompt-file`.

## What detached deliberately does NOT do

- It does not become reachable later. There is no "re-link" or "adopt" — that's
  consistent with the existing refusal of `shipit session adopt`.
- It does not bypass the per-turn spawn cap (see above).
- It does not change push/PR semantics: like any session it auto-commits,
  auto-pushes, and opens its own PR. The PR is the only thread back to the work,
  and it lives in the normal PR surface, attributable to nobody in particular.

## Key files

- `src/server/orchestrator/sessions.ts` — `setParentSession()` (the write to
  skip for detached), `findChildren()`, `filterVisibleInSidebar()`.
- The `shipit session create` shim handler (orchestrator side) — add `--detached`
  parsing; when set, skip the parent/root write and the `session_spawned` emit,
  but still record `spawnedByTurn` and enforce the per-turn cap.
- `src/client/components/SessionSidebar.tsx` — no change needed; a row with no
  `rootSessionId` already renders top-level.
- `src/server/shipit-docs/sessions.md` — add the agent instruction above **when
  the flag ships**.
- Tests: spawn-with-`--detached` writes no `parentSessionId`/`rootSessionId`,
  is absent from the parent's `findChildren`, still counts against the per-turn
  cap, and emits no `session_spawned` event.

## Open questions

- **Flag name.** `--detached` (git/docker precedent for "no attachment") vs
  `--standalone` / `--separate`. Leaning `--detached`.
- **Per-turn cap for detached.** Kept (resource protection). Revisit only if a
  real workflow needs uncounted spawns.
