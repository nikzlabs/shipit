---
issue: planning#363
title: Agent roles — design
description: A role names a harness, a model, a level and an optional prompt; agents start one by name.
---

# 264 — Agent roles: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

A **role** is a named unit of agent work the user configures once: the harness that runs it, the
model it runs, the reasoning level, and optionally a standing prompt describing the job. An agent
starts a role **by name** and supplies nothing else (reqs 3, 4).

The reviewer is a role (req 2). ShipIt's existing review path — `--role reviewer`, resolved from
two configured candidates ranked by distance from whatever is implementing (docs/261) — becomes
one role among many rather than the only one, and keeps resolving that way: it is the one role
whose params ShipIt supplies. See *The reviewer*.

## The shape

**One namespace, one flag.** A role is named where a role has always been named: `--role NAME`.
There is no second flag and no second name-space, so "review with `deep-dive`" and "review this"
differ only in whether the user said the name out loud.

**The agent names a role; it never names a param.** That is the whole boundary, and it is the one
docs/261 req 6 already draws — *name the role, never the reviewer*. Choosing which role fits an
intent is judgement, and judgement is what an agent is for: turning "review the PR" into the
reviewer role is the same act as turning "review this" into `--role reviewer` today. Choosing a
**model** or a **level** is not judgement — those are values an agent cannot enumerate (see
*The inventory*), so a guess is indistinguishable from a fact. Roles keep the agent on the right
side of that line by construction: the user configured the params, so the agent has nothing to
guess.

## What a role is

```
role   = { name, description, prompt?, params }
params = { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort }
       | { kind: "auto" }                                    // the shipped reviewer — reqs 2, 7
```

Every field of a `pinned` tuple is required, the harness included (reqs 1, 6).

- **`name`** — unique per install; a duplicate is refused. **Any further restriction is open
  question 2 and is deliberately not decided here**: the design assumes only uniqueness, and a
  name needing quoting on a command line is quoted. A lowercase-token rule would be a
  user-visible restriction nobody asked for.
- **`description`** — a short line saying what the role is for (req 9). Separate from the prompt
  and **not** derived from it: standing instructions are optional, so a role that has none would
  otherwise have nothing for the inventory or the Settings list to show.
- **`prompt`** — optional standing instructions (req 8). See *The prompt*.
- **`params`** — the complete tuple, including the harness. See *The harness is part of a role*.

## The harness is part of a role (req 6)

A role's harness is **required and stored**, which is a departure from docs/261 req 3's
model-first derivation and is scoped to roles. What it changes:

- **`harnessId` is validated at save** for *compatibility*: the harness is installed and can
  carry the model (the style overlap). A role naming a harness outside that set is **refused**, by
  the role validator described under *Settings* — which takes the harness as an input rather than
  deriving one.
- **Compatibility is not availability, and they are checked at different times.** Whether a
  credential can be routed *right now* is a run-time fact that changes without anyone editing a
  role — a subscription's quota resets. Requiring a live route at save would refuse a perfectly
  good role during an outage. So the save checks what cannot change on its own, and routing is
  checked when the role runs.
- **Nothing is derived at run time.** No harness derivation, and no "prefer a harness that is not
  the implementer's" preference — the role said what it runs on.
- **A stored harness can go stale**, and reports that it cannot run. For a job definition that is
  the better failure: being told the role cannot run beats being quietly handed a different agent,
  which is the difference requiring it exists to protect.

**It removes a whole failure mode.** docs/261 records a latent bug it deliberately left open
(`plan.md`, phase 3): a pin's reasoning level is validated against the *settings-time derived*
harness while the review may run on a **different** one, carrying a level the second harness may
not declare — fixable there only by choosing between refusing the review and silently
substituting a default. A role has no such gap: the level is validated against the one harness the
role names, and that is the harness it runs on.

**What it costs.** The pair (model, harness) can now disagree in a way a model alone could not, so
the save-time check is load-bearing rather than belt-and-braces. And the *choice* is
unexercisable on today's catalogue — no shipped model runs on both harnesses — so for now each
model has exactly one valid harness. That does not make the field derivation with extra steps:
stored-and-frozen behaves differently from derived the moment the install changes, which is why it
is required.

## The prompt (req 8)

A role may carry **standing instructions** — what the job is ("check the code against
requirements.md", "review the diff for correctness only"). At spawn they and the run's own task
compose into **one prompt channel**, because a sub-agent has only one (docs/144).

Three things the join has to get right, none of them free:

- **Framing.** The two halves are labelled — the role's instructions, then the task — so the
  callee can tell a standing brief from the thing it was asked to do now.
- **Length.** The two entry points enforce different task limits today (200,000 characters for a
  one-shot run, 50,000 for a child session), so an unbounded stored prompt can push a
  previously-valid task over the limit *after* resolution. The combined prompt is validated
  against the destination's limit, and the failure names the role rather than the task.
- **Identity when there is nothing to add.** A role with no standing instructions adds nothing:
  the join returns the task unchanged. That is a promise about the **join**, not end to end —
  child-session creation already trims an incoming prompt (`child-sessions.ts`), and this design
  does not change that. Claiming byte-identity all the way to the callee would be false.
- **A stored bound.** Standing instructions are stored in the settings payload, so they need a
  maximum of their own rather than only being caught after composition. Both checks stay: a bound
  at save, and the destination's own limit after the join.

No prompt-architecture change. CLAUDE.md's *prompts are content, not logic* holds: the composition
is a fixed join in code, and a role's prompt is **user data** stored in settings, not prompt text
compiled into the binary.

## Storage

Roles live in the credential store, keyed by name:

- `getRoles(): Role[]` — sorted by name at read time, so the list is deterministic without a
  stored rank
- `setRole(name, role | null)` — upsert or delete

**The reviewer is synthesized, not stored** (req 2). "Always present" needs a mechanism, and
seeding a record at first run is the wrong one: it would need a migration, an idempotent upgrade
path, and a story for an install whose record was deleted before the reserved-name rule existed.
Instead `getRoles()` **always yields the reviewer**, built from its two existing pins
(`getReviewerPin`) plus whatever editable metadata — description, standing instructions — has been
stored under its reserved key. Nothing migrates, the two shipped pins stay exactly where they are,
and an empty store still contains the reviewer because the store is not where it comes from.

**No reorder and no rename primitive.** Neither is in the requirements, and a rename is an
ordinary validated write followed by a delete — an atomic primitive would only be worth it if
something else held a reference to the old name, and nothing does. The reviewer cannot be renamed
or deleted at all (req 2), which the reserved key enforces rather than the UI.

## Resolution

`resolveRoleByName(name, implementer, deps)` looks the name up and returns a frozen target:

1. **Unknown name → `ServiceError` listing the roles that do exist** (req 13). The list is the
   whole remedy; nothing else needs saying.
2. **`auto` params** → delegate to `selectReviewer` (docs/261, unchanged), which ranks the two
   candidates against `implementer` and returns an already-routed target. This is the only branch
   that needs to know what is implementing.
3. **`pinned` params** → the role's own tuple. The harness is the one the role names (req 6 — not
   derived, no implementer preference), and the only question left is whether it still has a
   **usable route**. The level is the role's, already validated at save against that same harness.

Either way, freeze the target with the role's name on it.

The pinned branch is **simpler** than the auto one, not a parallel implementation of it: the
ranking machinery exists to *choose* a harness and a model, and a pinned role has already chosen.
What is shared is the routing and the freezing; what the pinned branch skips is every step that
was deciding something the role states.

A role that cannot run says which of the two it is: **stranded** (its model, service or harness is
gone — it needs a Settings edit, and is never silently repaired) or **temporarily unroutable** (its
subscription is spent — nothing to fix, it recovers when the quota resets). Route selection already
distinguishes these, and collapsing them would send a user to edit a role that is perfectly
correct.

## The reviewer (req 2)

There is **one kind of role**, and the variation lives in a role's params: the user pins them
(req 7), and ShipIt ships one role — the reviewer — whose params it resolves (req 2). In the data
that is a single discriminator:

```
params = { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort }
       | { kind: "auto" }
```

Not two kinds of object, which is what makes most of the design uniform:

- one store, one lookup, one refusal, one attribution path;
- `resolveRoleByName` branches **once** — an `auto` role delegates to `selectReviewer` (docs/261's
  ranking, unchanged: two candidates, distance from the implementer, the derived answer when
  nothing is configured), and a `pinned` role takes the simpler path above;
- `{ kind: "auto" }` is **rejected for every name but `reviewer`**. The discriminator exists to
  describe the one role that has automatic params, not to offer a state nobody can reach: leaving
  it settable would add an invalid-state surface with no user-visible value today.

**Why the reviewer resolves at all**, since it is the one asymmetry left: *"use whoever is
furthest from the model that wrote this"* is a rule evaluated **per run**, and a fixed set of
params cannot encode it — the answer depends on what is implementing at the moment of the call.
Pinning the reviewer would delete the three behaviours req 2 names, not simplify them.

**Where the uniformity genuinely stops, stated rather than glossed.** The reviewer's automatic
params are not one hidden tuple — they are docs/261's **two candidate slots**, which
`selectReviewer` loads and ranks (`reviewer-model.ts`). No single row of controls can configure
that, and the reviewer also cannot be renamed or deleted, so it does not belong in a list whose
every row offers those. **The Settings screen therefore has two parts, not one list**: a dedicated
**Reviewer** section — its description and standing instructions, above the two existing slot
cards, unchanged — followed by the list of pinned roles. Uniformity holds where it is true (one
store, one lookup, one refusal, one attribution path) and stops at the screen, which is the honest
place for it to stop.

**The reviewer is otherwise a role in every respect**: named the same way, started the same way
(both shapes below), refused the same way, reported the same way. It is also the one role whose
name is reserved and which cannot be renamed or deleted (req 2) — "review this" has to keep
resolving to something, and reviewing has to work on an install nobody has configured.

## Starting a role: the two shapes (req 11)

A role names what runs, and that question is the same whichever way a sub-agent is started:

| Shape | Command | What a role supplies |
|---|---|---|
| One-shot run | `shipit agent run --role NAME` | the harness, model and level for the consult |
| Child session | `shipit session create --role NAME` | the same, for the session's own agent |

**The child session is the one that gains most.** It accepts `--agent` and `--model` today and
**no reasoning flag at all**, so a parent can currently override two of the three parameters that
decide what a child runs on. A role supplies all of them at once, which is what makes it worth
naming there.

`--role NAME` on a child session **replaces inheritance** rather than layering over it: docs/261
req 10 has a child inherit its parent's parameters, and a role is a complete unit (reqs 1, 10), so
naming one answers the whole question. A child session with no `--role` inherits exactly as it
does today.

**A child session is not a frozen consult, and the difference is load-bearing** (req 11). A
one-shot run resolves *and routes* once and holds that target for its life — correct for
something that lasts minutes. A child session lives for days, across many turns and process
restarts, and must keep the routing, account failover and model-retirement behaviour every other
session has. So the role is resolved **once, at creation**: it seeds the new session's stored
harness, selection and reasoning level, and from then on that session is an ordinary session.
Carrying the consult's frozen provider route into it would pin a child to one credential for its
whole life and break failover — a bug that would surface only under quota exhaustion, days later.

Concretely: resolve the role before any disk work, write the complete tuple onto the session row,
and let normal session routing take it from there. `--role` decides what the child *starts as*,
not what it is permanently bound to.

**Mutual exclusion, both shapes.** `--role NAME` combined with any parameter that says what to run
on is refused (req 10). For a one-shot run that is all five of the explicit flags, which is what
the server already enforces for a role today (`sub-agent-target.ts`) — the role path must not
quietly narrow that to two. For a child session it is the flags that exist there now, `--agent`
and `--model`, and any override added later.

## The CLI

```
shipit agent run     --role deep-dive --prompt-file - <<'EOF'
…
EOF
shipit session create --role deep-dive --title "…" --prompt-file - <<'EOF'
…
EOF
```

**The shim's role check changes shape.** Today it rejects an unknown role locally against a
compiled-in list, to give the agent a fast message. It cannot know the user's roles — they live
server-side — so the local check becomes a pass-through and the server's resolution is the
authority, with the refusal (req 13) naming the roles that exist. The shim buys a message for
what it can know and does not pretend to know the rest.

## The inventory (req 12)

An agent can only map an intent onto roles it can see. Today it can see nothing of the sort: the
session shim exposes `agent run` and `agent result` and nothing that lists services, models,
levels **or roles**.

The smallest thing that satisfies req 12 is a **read of the roles, and only the roles** —
`shipit agent roles`, each entry a name and its description (req 9, which is why the description
is its own field rather than the prompt's first line: a role need not have a prompt, and one
without a description would be unchooseable).

**Roles only, and that is a scope choice rather than a consequence.** Exposing the service and
model catalogue would make the fully-specified path *enumerable*, and therefore usable — which is
not what req 15 forbids; req 15 is about not documenting a path the agent cannot use. So the
honest statement is narrower: the role list is the smallest surface that answers req 3, and it
keeps the division this feature is built on — the user chooses params, the agent chooses roles.
Whether ShipIt should ever expose the catalogue to an agent is a separate product question this
design does not settle.

The refusal (req 13) carries the same list, so an unknown role is self-correcting: the agent
learns the real names at the moment it guessed wrong.

## What the agent is told (req 15)

ShipIt injects instructions into every session, and today they document a run that names every
parameter — harness, service, billing mode, model and level, all mandatory, an incomplete call
refused. **An agent cannot satisfy that call**, because nothing in its environment enumerates
services, models, billing modes or levels; the only way to produce one is to guess, and a guessed
parameter is indistinguishable from a supplied one.

So that shape leaves the injected documentation. What the agent is told is: name a role, and if
you need one that does not exist, say so — the user creates it in Settings (req 5).

**The path stays implemented, and the repository override stays reachable.** docs/261 req 2 lets a
repository override the reviewer by naming all five parameters, and its phase 5 drew the line on
*what the caller was handed*: no complete target ⇒ use the role; a complete target ⇒ pass it
through. A flat "always name a role" would delete that carve-out, so the injected guidance keeps
it in the only form that cannot teach guessing: **if repository policy hands you a complete
target, pass it through unchanged; never assemble one yourself.**

**This collides with a shipped guard, and the collision is the work.**
`review-command-callers.test.ts` asserts that `shipit-docs/agent.md` contains at least one
*complete* five-flag invocation, precisely so the override stays documented — a test written to
stop this shape being lost. Req 15 removes it from the pages ShipIt injects into a session. Both
cannot hold for the same page, so the audiences separate: the complete shape belongs in the
human-facing reference for whoever writes repository policy, and the guard moves with it,
asserting it is documented *there*.

**The removal surface is wider than that one page, and the existing guard cannot see the rest.**
Both harness system prompts (`agents/claude/system-prompt.md`, `agents/codex/system-prompt.md`)
also spell the complete five-flag command out in full. The guard today rejects only *incomplete*
explicit runs in those prompts (`incompleteExplicitRuns`), so a complete one passes unnoticed —
which is correct for the rule it was written for and wrong for req 15's. So phase 4 needs the
mirror assertion: **no `completeExplicitRuns` in any `buildAgentSystemInstructions` variant or any
injected doc**, with the positive "it is documented somewhere" assertion pointed at the
human-facing reference instead. Without that, req 15 lands on one page and leaves the same command
in the two places every session actually reads.

## Settings (req 5)

**A role is created and edited in ShipIt's settings UI, and that is the only way it comes from.**
Choosing a role's params means choosing among the services, models, harnesses and levels *this
install* offers, and the UI is the only surface that can show that set — the three shared pickers
already enumerate exactly that.

The Reviewer tab becomes a **Roles** surface in two parts:

- a **Reviewer** section — its description and standing instructions, then the two existing slot
  cards exactly as docs/261 ships them. No rename, no delete, no single model control, because its
  params are two ranked candidates (req 2);
- a **list of pinned roles**, each with a name, a description (req 9), optional standing
  instructions (req 8), the shared service / model / reasoning controls (docs/261 req 13 binds
  them by construction), its harness, a rename, a delete, and a *New role* row.

**The harness is required in the data; it is not necessarily a required interaction.** Today every
model has exactly one harness that can run it, so the field is filled from that single valid
option and *shown* on the row rather than asked for. The day a model is offered by two harnesses
the same field becomes a real picker, and the stored shape does not change. It is shown read-only
from day one deliberately: a role's harness is part of what it *is* (req 6), so hiding it until it
becomes selectable would misrepresent the role.

The server is the authority on every write. It does **not** reuse `resolveReviewerPinPatch` as-is:
that function *derives* a harness (`harnessesForSelection(patch, …)[0]`, `reviewer-settings.ts`)
and validates the reasoning level against whichever it picked. Handing it a role would reproduce
exactly the defect the required harness exists to remove — a level checked against one harness and
run on another. A role needs a validator that **takes `harnessId` as an input**: the triple must
exist in the catalogue, the named harness must be installed, able to carry the model and
credentialed, and the level must be one that harness declares. The two validators share their
catalogue and credential checks; only the harness step differs, and it differs in the direction
that matters.

Name validation is server-side too, and its policy is open question 2.

**A role that cannot run still has to be editable, which is the case a picker-based UI gets
wrong.** When a stored model, service or harness no longer exists, the shared pickers have no
option to select and would either drop the row or silently show the first available value. So an
unresolved role renders its **raw stored tuple** as text, names the field that is no longer
valid, and keeps its edit and delete controls. It never disappears and is never quietly rewritten
to something the user did not choose.

Nothing here is optimistic: the server sends the resolution and the response replaces the list.

## Attribution (req 14)

**A one-shot run** is resolved and routed **once**, at spawn admission, and that frozen target is
what retries, attribution and the transcript card all read. The consult card reports the service,
billing mode, model, harness and level that actually ran — which docs/261 phase 4 already
persists — plus the role's name.

**A child session is attributed as a session, not as a consult**, and needs its own answer because
it outlives its target: its usage and cost are already attributed per turn by the ordinary session
machinery, and what a role adds is **provenance** — an immutable `originRoleName` on the session
row, recording what started it.

Provenance is a **snapshot and says so**: it names the role that created the session, not a live
link to it. Editing that role later does not change a running child, deleting the role does not
orphan or alter it, and the child may over time run on something other than what the role named
(req 11). A field that looked like a live reference would promise a relationship the design
deliberately does not have.

## Cost assessment, honestly

- **Stored state with staleness — and two kinds of it, which must not be reported alike.** A role
  whose model is retired, whose service is removed or whose harness is uninstalled is **stranded**:
  it cannot run until someone edits it, and req 7 means it is never silently re-pointed (the trade
  is open question 1). A role whose subscription is merely **quota-exhausted** is not stranded at
  all — routing already distinguishes that case, and it recovers on its own when the quota resets.
  Telling that user to go and edit a perfectly good role would be wrong, so the two report
  differently: one says the role needs fixing, the other says when to try again.
- **Unbounded-list management.** Create, edit, rename and delete, all through the existing
  settings mutation surface rather than new routes of their own; the list is displayed sorted by
  name, with no stored order and no reorder control. There is **no "default role" flag**, so the
  management is lighter than it first looks.
- **A second name-space.** Role names and model labels are two lookup tables. They cannot collide
  at the flag level, and the unknown-role refusal names the known set (req 13).
- **Standing instructions and a description** (reqs 8, 9) add a content surface: user data in the
  settings store, two text fields on the row, and a length rule where they meet the task. The real
  cost is that a role carrying instructions invites the user to treat it as a custom agent
  definition — which is the invitation this feature intends.
- **A new agent-facing read** (req 12). One small list endpoint, whose cost is not the endpoint
  but the **boundary**: widening it to the catalogue would put the agent back to assembling
  params, which is the division this feature exists to draw.
- **A required harness** (req 6) is one more thing that can go stale and one more pair that can
  disagree — answered by the save-time check and the stale-pin path. Set against that, it removes
  the effort-across-harnesses failure mode entirely.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the role record, the params discriminator, the synthesized reviewer, `resolveRoleByName`, the harness-explicit validator | 1, 2, 6, 7, 9, 13 | A role is stored, resolved and routed on the harness it names; a level is validated against *that* harness; `getRoles()` yields the reviewer on an empty store; stranded and quota-exhausted are reported differently; an unknown name is refused listing the known ones |
| 2 | Settings: role CRUD through the existing mutation surface, the Reviewer section above the pinned-role list, the unresolved-role view | 1, 2, 5, 6, 8, 9 | A role is created, edited, renamed and deleted in the UI; the reviewer has no rename or delete and keeps its two slot cards; a role whose model or harness is gone still renders its stored tuple and stays editable |
| 3 | Starting a role: `--role NAME` on the one-shot run and the child session, the roles read, the prompt join, the intent-to-role guidance | 3, 4, 8, 10, 11, 12, 14 | `--role deep-dive` starts that role either way; a child is seeded with the complete tuple and then routes like any other session, carrying an immutable `originRoleName`; `--role` plus any what-to-run-on parameter is refused; the combined prompt is bounded at save and checked against the destination's limit |
| 4 | Documentation split: the five-parameter shape leaves every injected surface and moves to the human-facing reference, with its guard inverted | 15 | Neither injected doc nor any system-prompt variant contains a complete five-flag command; the repository override is documented for whoever writes repository policy, and the guard asserts it *there* |

Phase 1 carries the params discriminator, so `selectReviewer` and the two-slot settings survive
intact behind the `auto` branch rather than being retired or reimplemented.
