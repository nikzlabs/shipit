---
issue: planning#423
title: User-selectable roles — design
description: A role the user picks in the composer seeds the session and names itself there until a control moves.
---

# 272 — User-selectable roles: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

docs/264 built roles as a complete unit — a harness, a service, a billing mode, a model, a
reasoning level, and optional standing instructions — and gave **agents** two ways to start one
(`shipit agent run --role`, `shipit session create --role`). This feature gives the **user** the
same thing in the composer.

Nothing about a role changes. The whole feature is a fourth way to *start* one, plus the rule that
decides when its name is shown.

## The shape

**A role is a seed, and the composer says so by replacing the three controls it set.** The user
picks a role; the session starts on its harness, model and reasoning level; the composer shows the
role's name where the harness, model and reasoning selectors sit today (req 5). Change any one of
them and the row is back to today's three controls (req 15) — because the role is no longer true.

Three facts are one fact, and keeping them one is the whole design:

> **the name is shown ⟺ the user chose the role ⟺ the role's standing instructions are in force**

Req 13 is what forces this. A role is not its five parameters — selecting one also puts its
standing instructions in force, and no amount of moving three controls does that. So the name
reports the *choice*, never a match, and the state that backs it has to be stored rather than
derived.

## What is stored, and why it is two fields

| Field | Meaning | Lifetime |
|---|---|---|
| `session.roleName` | **new.** The role currently in force — what the composer names. | Written when the user selects a role. **Cleared** the moment the harness, model or reasoning changes (req 15). |
| `session.originRoleName` | docs/264 req 14. What the session was *started* on (req 6). | Write-once. Set from `roleName` at the session's first turn, or at creation for an agent-spawned child. |

They cannot be one field, and the reason is that reqs 3 and 6 pull in opposite directions: req 3
says the name stops being shown the moment the user moves a control, and req 6 says the record of
what the session was started as survives. A single field either keeps naming a role that is no
longer true, or loses the provenance the moment the user changes the model.

They are also not two *displays*: `originRoleName` is never rendered in the composer. It is the
record `shipit session whoami` already prints and the child card already shows.

**`originRoleName` is what makes the standing instructions a one-shot** (below), so the second
field pays for itself twice.

## Where a role is applied

One rule, four entry points, and none of them is a special case: **the role's params are written
onto the session row exactly as the three controls write them.** There is no parallel "role mode"
in the spawn path — by the time a turn starts, a session seeded from a role is indistinguishable
from one the user configured by hand, which is req 3 stated as an implementation property.

| Entry point | Where the role arrives | Applied by |
|---|---|---|
| Composer, session bound (the normal case, incl. from-issue and fork — req 11) | `set_role` over the per-session WS | `applyRoleToSession` |
| Composer, next new session (req 12) | `?role=` on the WS connect URL, from the browser's seed slot | the connect handler, after its existing agent/model reconciliation |
| Quick capture (req 11) | `role` in the headless creation body | `createHeadlessSession`, before the claim |
| `shipit session create --role` (docs/264, unchanged) | the spawn target | `spawnChildSession` — now also writes `roleName`, so the child's composer names it |

**The connect param is where req 12 lives.** The browser already seeds a new session's harness,
model and reasoning through `?agent=` / `?model=` / `?reasoning=`; the role rides the same
mechanism and, when it resolves, **overrides all three** — it is the thing that set them. It
applies only while the session is unpinned and carries no role of its own, which is the same guard
the other three params take.

## Selection is refused after the first turn (req 4)

`agentPinned` is already the "this session has taken its first turn" fact — it is set when the
first turn provisions credentials, and it is what makes the harness irreversible. `set_role`
refuses on it. Nothing else is needed: a role selected in a from-issue or forked session works
because neither of those *starts a turn*, which is exactly the receipt req 4 records.

## The standing instructions (req 2)

They ride the **prompt channel**, joined onto the first turn's text — the same channel and the
same `joinRolePrompt` a child session already uses (docs/264 req 8).

**Not the system prompt.** CLAUDE.md's prompt-cache contract is load-bearing:
`buildAgentSystemInstructions` renders each variant once at module load into a frozen constant, so
the per-turn path is a pure lookup and the CLI string stays byte-stable. A role's standing
instructions are per-session user data; putting them there would make the composition per-call and
break the contract for every session, role or no role.

**They do not appear in the transcript**, exactly as `<attached_images>` and `DICTATION_CONTEXT`
do not: `assembleAgentPrompt` gains one more context block, and the persisted user bubble stays the
user's verbatim text. A user who typed "fix the flaky test" must not find a page of standing
instructions inside their own message.

**Delivery is a one-shot, and `originRoleName` is the latch.** The block is emitted when the
session has a role in force and `originRoleName` is not yet set; emitting it also sets
`originRoleName`. So:

- turn 1 of a role-seeded session gets the instructions, and turns 2+ do not (they are in context);
- a child session, whose `originRoleName` was written at creation *and* whose creating prompt was
  already joined by docs/264, is skipped — no double delivery;
- req 6's record is written at the one moment req 4 says the role stops being selectable.

The latch is read and written on the shared `prompt-assembly` path, so both turn entry points — the
WS path and the dispatched path that serves quick capture — get it from one place.

**It is at-most-once, and that is a choice with a cost.** The latch closes when the prompt is
assembled, not when the agent acknowledges it, so a first turn that dies between those two points —
a failed spawn, an OOM — loses the role's standing instructions for good: the user's re-send runs
without them, and re-selecting the role will not bring them back either. The alternative shape
exists in this codebase (`consumePendingAgentNotice` is re-parked when its turn never reached the
agent) and was not taken here, because it needs a restore callback threaded through both entry
points for a failure that only lands in one narrow window. If it turns out to bite, re-parking is
the fix, and it is the same three lines that fix is elsewhere.

## Two paths move a parameter without the user touching a control

`leaveRoleOnParameterChange` covers the three handlers the user operates. It does **not** cover
the connect handler, which decides what a session should run every time a browser attaches — and
two of its answers move a session nobody touched:

- a **retired** model resolves to its successor (`applyModelRetirement`);
- a model the session's harness no longer lists is replaced with that harness's first.

Neither goes through `set_model`, so a role would go on naming a session running something else —
the one screen state req 13 exists to rule out. The connect handler therefore clears the role when
its own reconciliation moved the harness, the model or the level, compared against the row as it
was read at the top of the handler.

**And one derivation had to stop for a role.** The same block derives "which harness owns this
model" and persists the answer, which docs/252 made ambiguous: a dual-harness model (DeepSeek V4)
belongs to both, and the registry's first match wins. A session running a role on Codex would, on
its next *reconnect*, be moved to Claude and kept there while the composer still named the role.
A role in force means the three fields were written together from one tuple the user chose — there
are not two independent sources to reconcile — so the derivation is skipped. That is docs/264
req 6's "nothing is ever derived" reaching a path that predates it.

**What this deliberately does not need: a guard against the seed re-applying the role it just
cleared.** The browser's seed outlives the clear, so a later connect does arrive naming the role —
and `resolveUserRole` refuses it, because both things that clear a role here also make the role
itself unrunnable. A retired id lives in its mode's `retired[]` and not in its model list, so
`selectionExists` is already false; a model the harness cannot list fails the same check. Cross-agent
review predicted an oscillation here and it does not reproduce for that reason — which is a property
of the catalogue rather than of the connect block, so it is pinned by a test in
`services/session-role.test.ts` rather than left to be re-derived.

## Before a session is active, the seed is the display

The composer's role control has no session row to read on the two surfaces where picking a role is
most natural, and this shipped broken because of it: `/{repo}/new` sits on a **warm** session, and
`SessionManager.list()` filters `warm = 0`, so the browser's session list has no row for it. The
server received `set_role`, applied it, and answered — and the answer landed on nothing. The control
read "None" however many times it was clicked.

So the rule is the one the other three controls already follow through `seedFromHistory`: **while no
session is active the seed is what the composer displays**, and once one is active the server's
answer is the only thing it displays. The seed may name a role chosen for the *next* session, so
reading it for a live session would name a role that session never took — which is req 13's own
prohibition.

Two consequences fell out of fixing it, and both are simplifications:

- **The seed follows the server's answer** rather than being cleared by each of the three handlers
  on the way out. Leaving a role happens when a parameter *moves*, and only the server knows whether
  one did — re-selecting the harness a role already set is not a change (req 15). Clearing it at the
  call sites re-implemented that comparison and got it wrong in the one case the rule exists for.
- **Picking a role writes the three pickers' seeds from the role's resolved params**
  (`utils/role-seed.ts`). Without it, "Adjust parameters…" brought back controls showing whatever
  the seeds held from some earlier session — the role's own values were nowhere on screen, which is
  the opposite of what req 15 promises. It also means a session started while `?role=` could not be
  applied still runs the role's parameters.

  A role can also arrive from the slot on a **page load**, where nothing wrote those seeds this
  session, so the composer reconciles them there too. `applyRoleSeeds` reports whether it moved
  anything, which is what stops the write → re-render → write loop that reconciliation from an
  effect would otherwise be.

## What the composer shows

**Three states in the wide row**, and the row never grows: a selected role shows *fewer* controls
than today, not more (req 5).

1. **No roles configured** — byte-identical to today. Not even an icon (req 16).
2. **Roles exist, none selected** — today's three controls, plus a bare mark (`BaseballCapIcon`).
   No label: the mark is learned in Settings, where the same icon sits beside the word "Roles"
   (req 16). Neither half works alone, which is why the Settings change is part of this feature and
   not a follow-up.
3. **A role is selected** — the harness, model and reasoning selectors are **replaced** by the
   role's name. Clicking it opens the list of roles (req 14), like every other control in the row
   opens what it chooses between.

**And a fourth, which is state 3 after the session's first turn: the role locks and the parameters
come back.** `roleParamsRevealed` is true whenever the role is locked, so no one has to ask for
them — the reveal exists to say "you have just decided these", and at the first turn that sentence
stops being true while the controls stay useful. What the row then shows is the locked role pill,
the locked harness readout, and a live model and reasoning picker: exactly the controls a session
that never took a role has, plus the name.

This is the shape reported as broken. A locked pill has no menu (below), and "Adjust parameters…"
lives *inside* that menu — so a role-started session lost its model and reasoning controls at the
first turn and never got them back, while an identical hand-configured session kept both. Nothing
server-side was wrong: `set_model` and `set_reasoning` were reachable the whole time, and
`leaveRoleOnParameterChange` clears the role when one of them moves whether the session is pinned or
not. It was the composer refusing to draw them. The fix is that one condition, and both layouts read
it from the same place — `ComposerSettingsMenu` takes `roleParamsRevealed` as a prop rather than
recomputing it, which is why the narrow menu is fixed by the same line.

**The lock still means what it says**: no role can be selected after the first turn (req 4). The
server refuses `set_role` on `agentPinned` and that is unchanged — the pill stays a readout with no
menu, and its tooltip now names what is still changeable rather than only what is not, because a
lock with no such sentence is what made "I cannot adjust the parameters" the natural reading.

**"Adjust parameters…" is a footer inside that list** (req 15), not a second control. Choosing it
brings the three controls back beside the role name; the role stays in force until one of them
actually moves, and moving one is the whole of leaving the role. There is no "no role" entry and no
clear action — an action that only un-names a role while the session goes on running exactly as the
role set it up states nothing a user would want to state.

**Below 700px** this is the same fact in docs/260's shape: the role becomes a row in the one
composer settings menu, and when a role is selected the harness, model and reasoning rows are the
ones it replaces. **The anchor carries the role's name too**, not the model's. docs/260 req 4 gave
it the model on the grounds that the model was the most consequential of the four things behind it;
a role outranks it on exactly that test, being the harness, the model and the level at once — and
leaving the model there put two answers to "what does this session run on" on one row, with the
model the less true of the two. The Role panel carries all three parameters behind "Adjust parameters…",
**including the harness** — switching role can switch harness, and the harness pins irreversibly at
the first turn, so a role panel that hid it would hide the one consequence the user cannot undo.

**One appearance, both layouts.** "A role is in force" looks the same whether the composer is wide
or narrow: the tinted pill the prototype approved, worn by the wide row's control and by the narrow
anchor alike. They had drifted — the wide row followed the prototype while the anchor inherited
docs/260's plain settings control — so the same state wore two faces on nothing but the composer's
width. `ROLE_PILL_CLASS` is the one string both render, and it deliberately carries **appearance
only**: layout stays at each call site, because the two must differ there (the wide control is
`shrink-0`; the narrow anchor is the row's one elastic item, docs/260 req 8). A test compares what
the two actually render, since asserting the import would not catch a class overridden at the call
site — the lesson `picker-consistency.test.tsx` already encodes.

**The reviewer is never offered and never named** (reqs 10, 13), and it does not count towards "the
user has a role" (req 16) — it exists on every install, so counting it would make that condition
always true and the rule dead on arrival.

**An unavailable role is listed, disabled, with its reason** (req 9). The `RoleView` the settings
payload already carries has `unavailableReason` resolved server-side, so the composer renders what
Settings renders and no second implementation of "can this run" enters the browser.

## Refusals

Nothing is ever substituted (req 8, inheriting docs/264 req 7). `resolveUserRole` refuses, by name:

- an **unknown** role — the name is stale, e.g. the role was deleted in another tab;
- the **reserved reviewer** (req 10) — it resolves per run against whatever produced the work, and
  a session the user starts has no such thing;
- a role that **cannot run right now** — stranded, disconnected or out of quota, reported with the
  reason `checkRolePinnedParams` already distinguishes.

A refused `set_role` leaves the session exactly as it was, and says so — the same "decide
everything before mutating anything" rule `set_model` follows.

Because the reviewer is refused here, only `pinned` params ever reach this path, so this feature
calls `checkRolePinnedParams` directly rather than `resolveRoleByName`: there is no ranking to run,
no `ImplementerContext` to fabricate, and no `auto` branch to carry.

## Key files

**Server**

- `shared/types/domain-types/session.ts` — `roleName` on `SessionInfo`.
- `orchestrator/sessions.ts`, `orchestrator/database.ts` — the `role_name` column, `setRoleName`.
- `orchestrator/services/session-role.ts` — **new.** `resolveUserRole` (the refusals),
  `applyRoleToSession` (the write), `takeRoleStandingInstructions` (the one-shot latch).
- `orchestrator/route-registry.ts` — the `set_role` case, the clear in `set_agent` / `set_model` /
  `set_reasoning`, `roleName` on `model_selection_changed`, and the `?role=` connect block.
- `orchestrator/prompt-assembly.ts` — the `roleContext` block, ordered by the same slash-command
  rule as the others.
- `orchestrator/services/headless-sessions.ts` — `role` in the creation body (quick capture).

**Client**

- `client/components/MessageInput/RoleSelector.tsx` — **new.** The wide-row control and
  `useRolePickerState`, shared with the narrow menu so the two layouts cannot disagree.
- `client/components/MessageInput/MessageInput.tsx` — the three-state row.
- `client/components/MessageInput/ComposerSettingsMenu.tsx` — the Role row and panel.
- `client/utils/local-storage.ts` — the role seed slot (req 12).
- `client/hooks/useSessionWebSocket.ts` — `?role=`.
- `client/App.tsx` — `set_role`, and the seed clear on a harness/model/reasoning pick.
- `client/components/QuickCaptureOverlay.tsx` — the role in the creation params.
- `client/components/Settings/tabs/RolesTab.tsx` — the same mark beside "Roles" (req 16).

## Cost, honestly

- **A second stored field about roles**, with a rule about which is written when. Mitigated by both
  being written in one place each, and by the latch making them mutually load-bearing.
- **The composer row now has a state machine** (none / role / role-with-params) where it had one
  layout. It is small, but it is real, and it doubles the states the narrow menu has to render too.
- **A role selected in one tab is stale in another** until the settings payload refreshes. The
  refusal covers it — an unknown or unavailable role is refused by name rather than started on
  something else — so the failure is a message, not a wrong session.
- **`?role=` is a fourth seed param on the connect URL**, and it overrides three of the others.
  That precedence has to be stated somewhere; it is stated in the connect block and here.
- **The connect handler now has a role-shaped clause in it**, in a block that was already dense.
  It buys the two paths above, and both were reachable — but it is one more thing that has to stay
  true as that block changes.
