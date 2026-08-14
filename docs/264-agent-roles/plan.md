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
role   = { name, prompt?, params }
params = { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort }
       | { kind: "auto" }                                    // the shipped reviewer — reqs 2, 7
```

Every field of a `pinned` tuple is required, the harness included (reqs 1, 6).

- **`name`** — a CLI-safe token: lowercase letters, digits and dashes, so `--role NAME` is a
  valid word and cannot collide with a flag. Unique per install; a duplicate is refused.
- **`prompt`** — an optional free-text standing prompt (req 8). See *The prompt*.
- **`params`** — the complete tuple, including the harness. See *The harness is part of a role*.

## The harness is part of a role (req 6)

A role's harness is **required and stored**, which is a departure from docs/261 req 3's
model-first derivation and is scoped to roles. What it changes:

- **`harnessId` is validated at save**: it must be installed, must be able to carry the model
  (the style overlap), and must have a credential. `harnessesForSelection` answers all three; a
  role naming a harness outside that set is **refused**, in the same place an invalid reasoning
  level is refused (`resolveReviewerPinPatch`).
- **Nothing is derived at run time.** No harness derivation, and no "prefer a harness that is not
  the implementer's" preference — the role said what it runs on.
- **A stored harness can go stale**, and reports that it cannot run, exactly as a lost model pin
  does. For a job definition that is the better failure: being told the role cannot run beats
  being quietly handed a different agent, which is the difference requiring it exists to protect.

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

A role may carry a **standing prompt** — its job description ("check the code against
requirements.md", "review the diff for correctness only"). At spawn the role's standing prompt and
the run's own task compose into **one prompt channel** — a sub-agent has a single prompt channel
(docs/144), so there is no second channel to wire: the standing half first, the task half after,
one stable join at spawn.

No prompt-architecture change. CLAUDE.md's *prompts are content, not logic* holds: the composition
is a fixed join in code, and a role's prompt is **user data** stored in settings, not prompt text
compiled into the binary.

## Storage

Roles live in the credential store as an **ordered list**:

- `getRoles(): Role[]`
- `setRole(name, role | null)` — upsert or delete
- `renameRole(oldName, newName)`

Order is insertion order, reorderable in Settings as a nicety.

## Resolution

`resolveRoleByName(name, implementer, deps)` looks the name up and returns a frozen target:

1. **Unknown name → `ServiceError` listing the roles that do exist** (req 12), with a note that
   `--model` is the flag for a model — a role name and a model label are two different
   name-spaces, and the refusal is where that is cheapest to learn.
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

A role whose credential or harness has gone away reports that it cannot run and says why, pointing
at Settings — it is never silently repaired.

## The reviewer (req 2)

There is **one kind of role**, and the variation lives in a role's params: the user pins them
(req 7), and ShipIt ships one role — the reviewer — whose params it resolves (req 2). In the data
that is a single discriminator:

```
params = { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort }
       | { kind: "auto" }
```

Not two kinds of object, which is what makes the rest of the design uniform:

- one store, one lookup, one refusal, one settings list, one attribution path;
- `resolveRoleByName` branches **once** — an `auto` role delegates to `selectReviewer` (docs/261's
  ranking, unchanged: two candidates, distance from the implementer, the derived answer when
  nothing is configured), and a `pinned` role takes the simpler path above;
- "automatic" is already expressible on any role, so if it is ever wanted more widely, nothing
  needs re-cutting. Req 7 keeps it to the shipped reviewer for now — expressible in the data is
  not the same as offered in the UI.

**Why the reviewer resolves at all**, since it is the one asymmetry left: *"use whoever is
furthest from the model that wrote this"* is a rule evaluated **per run**, and a fixed set of
params cannot encode it — the answer depends on what is implementing at the moment of the call.
Pinning the reviewer would delete the three behaviours req 2 names, not simplify them.

**The reviewer is otherwise a role in every respect**: named the same way, started the same way
(both shapes below), refused the same way, reported the same way. `auto` describes where its
params come from and nothing else.

## Starting a role: the two shapes (req 10)

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
req 10 has a child inherit its parent's parameters, and a role is a complete unit (reqs 1, 9), so
naming one answers the whole question. A child session with no `--role` inherits exactly as it
does today.

**Mutual exclusion, both shapes.** `--role NAME` combined with `--model` or an effort flag is
refused (req 9) — a role is a unit, and naming both asks two questions at once.

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
authority, with the refusal (req 12) naming the roles that exist. The shim buys a message for
what it can know and does not pretend to know the rest.

## The inventory (req 11)

An agent can only map an intent onto roles it can see. Today it can see nothing of the sort: the
session shim exposes `agent run` and `agent result` and nothing that lists services, models,
levels **or roles**.

The smallest thing that satisfies req 11 is a **read of the roles, and only the roles** —
`shipit agent roles`, each entry a name and, where the role has one, its prompt's first line as a
description. Enough to choose between `deep-dive` and `spec-check`, and enough to tell the user
what exists when they ask.

**Deliberately not the whole catalogue.** Exposing services, models, billing modes and levels
would let an agent assemble a fully-specified run itself, which is the thing req 14 removes from
its instructions. Roles exist so the agent does not reason about params; handing it the params
anyway would undo that. The inventory is scoped to what req 3 needs and stops there.

The refusal (req 12) carries the same list, so an unknown role is self-correcting: the agent
learns the real names at the moment it guessed wrong.

## What the agent is told (req 14)

ShipIt injects instructions into every session, and today they document a run that names every
parameter — harness, service, billing mode, model and level, all mandatory, an incomplete call
refused. **An agent cannot satisfy that call**, because nothing in its environment enumerates
services, models, billing modes or levels; the only way to produce one is to guess, and a guessed
parameter is indistinguishable from a supplied one.

So that shape leaves the injected documentation. What the agent is told is: name a role, and if
you need one that does not exist, say so — the user creates it in Settings (req 5).

**The path stays implemented.** A caller that genuinely holds all five values — a repository that
hard-codes them, which docs/261 req 2 explicitly permits — keeps working exactly as it does now.
Req 14 governs what ShipIt *tells the agent*, not what the server accepts. The pages that document
the explicit shape for that caller are the ones to prune; the server-side refusal of an incomplete
call is untouched.

## Settings (req 5)

**A role is created and edited in ShipIt's settings UI, and that is the only way it comes from.**
Choosing a role's params means choosing among the services, models, harnesses and levels *this
install* offers, and the UI is the only surface that can show that set — the three shared pickers
already enumerate exactly that.

The Reviewer tab becomes a **Roles** surface: the reviewer's row first, then the user's roles,
each with a name, an optional prompt (req 8), the shared service / model / reasoning controls
(docs/261 req 13 binds them by construction), its harness, a rename, a delete, and a *New role*
row.

**The harness is required in the data; it is not necessarily a required interaction.** Today every
model has exactly one harness that can run it, so the field is filled from that single valid
option and *shown* on the row rather than asked for. The day a model is offered by two harnesses
the same field becomes a real picker, and the stored shape does not change. It is shown read-only
from day one deliberately: a role's harness is part of what it *is* (req 6), so hiding it until it
becomes selectable would misrepresent the role.

The server is the authority on every write, reusing `resolveReviewerPinPatch` — a role's params
are a reviewer pin plus a harness, and that function already validates a triple against the
catalogue and a level against a harness. Name validation is server-side too (token shape, length,
uniqueness); a name that passes is accepted as given, because the user owns the word.

Nothing here is optimistic: the server sends the resolution and the response replaces the list.

## Attribution (req 13)

A role's run is resolved and routed **once**, at spawn admission, and that frozen target is what
retries, attribution and the transcript card all read. The consult card reports the service,
billing mode, model, harness and level that actually ran — which docs/261 phase 4 already
persists — plus the role's name, so the card answers "what ran" and "why that" without asking the
reader to hold a ranking in their head.

## Cost assessment, honestly

- **Stored state with staleness.** A role pinned to a retired model, a removed service, a spent
  credential or an uninstalled harness is stranded. Handled by the machinery that already handles
  a stranded reviewer pin: retirement resolves through the catalogue's successor where one
  exists, and a role that cannot run is *refused with a reason and a pointer to Settings*.
- **Unbounded-list management.** Create, edit, rename, delete, order — four routes on an existing
  settings surface, and a list rendering shared controls. There is **no "default role" flag**, so
  the management is lighter than it first looks.
- **A second name-space.** Role names and model labels are two lookup tables. They cannot collide
  at the flag level, and the unknown-role refusal names the known set (req 12).
- **The prompt** (req 8) adds a content surface: user data in the settings store, a text field on
  the row. Its real cost is that a role with a prompt invites the user to treat it as a custom
  agent definition — which is the invitation this feature intends.
- **A new agent-facing read** (req 11). One small list endpoint, whose cost is not the endpoint
  but the **boundary**: it must stay scoped to roles, or it re-creates the problem req 14 removes.
- **A required harness** (req 6) is one more thing that can go stale and one more pair that can
  disagree — answered by the save-time check and the stale-pin path. Set against that, it removes
  the effort-across-harnesses failure mode entirely.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the role list including its required harness, `resolveRoleByName`, the settings payload carrying roles | 1, 2, 6, 7, 12, 13 | A role is stored, resolved and routed on the harness it names; a role whose harness cannot run its model is refused; an unknown name is refused listing the known ones; nothing calls it yet |
| 2 | Settings: role CRUD, name validation, the Roles surface with the shared controls, the harness field and the prompt field | 1, 5, 6, 8 | A role is created, edited, renamed and deleted in the UI; the harness is shown on every role and is selectable wherever a model has more than one |
| 3 | Starting a role: `--role NAME` on both the one-shot run and the child session, the roles read, the intent-to-role guidance | 3, 4, 9, 10, 11 | `--role deep-dive` starts that role either way; the agent can list roles and map "review the PR" onto one; `--role` plus a model or a level is refused |
| 4 | Injected documentation: the fully-specified run leaves the agent's instructions | 14 | No injected page tells an agent to assemble a run out of parameters it cannot enumerate; the server still accepts one from a caller that holds them |

Phase 1 carries the params discriminator, so `selectReviewer` and the two-slot settings survive
intact behind the `auto` branch rather than being retired or reimplemented.
