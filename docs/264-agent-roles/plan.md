---
issue: planning#363
title: Agent roles — design
description: A role names a harness, a model, a level and an optional prompt; agents start one by name.
---

# 264 — Agent roles: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

A **role** is a named unit of agent work the user configures once: the harness that runs it, the
model it runs and the reasoning level, plus an optional description and standing instructions. An
agent starts a role **by name** (reqs 3, 4), optionally overriding any parameter the user asked to
change (req 10) — through the same API surface whether it wants a one-shot consult or a child
session (req 16).

The reviewer is a role (req 2). ShipIt's existing review path — `--role reviewer`, resolved from
two configured candidates ranked by distance from whatever is implementing (docs/261) — becomes
one role among many rather than the only one, and keeps resolving that way: it is the one role
whose params ShipIt supplies. See *The reviewer*.

## The shape

**One namespace, one flag.** A role is named where a role has always been named: `--role NAME`.
There is no second flag and no second name-space, so "review with `deep-dive`" and "review this"
differ only in whether the user said the name out loud.

**The agent chooses a role; it never chooses a parameter.** Choosing which role fits an intent is
judgement, and judgement is what an agent is for: turning "review the PR" into the reviewer role
is the same act as turning "review this" into `--role reviewer` today.

A parameter is different, and the difference survives overrides being allowed (req 10). An agent
may **relay** one — "review this with Opus at high effort" is the user's instruction and the agent
carries it verbatim — and may not **decide** one. The distinction is invisible to ShipIt: a model
the agent remembered and a model the user named arrive identically. So it is held in two places at
once — the agent is told to relay and not decide, and the inventory (below) means a relayed value
can at least be checked against what this install actually has, rather than being taken on faith
from the agent's memory of models that may not exist here.

**The default stays a bare role**, which is what keeps this from drifting back to the agent
assembling targets: a run with no override names one word and inherits a complete, user-configured
tuple.

## What a role is

```
role   = { name, description?, prompt?, params }
params = { kind: "pinned", harnessId, serviceId, billingMode, modelId, reasoningEffort }
       | { kind: "auto" }                                    // the shipped reviewer — reqs 2, 7
```

Every field of a `pinned` tuple is required, the harness included (reqs 1, 6).

- **`name`** — **any name the user types, with only uniqueness enforced.** No token shape, no
  case rule, no length rule beyond what storage needs; a name that needs quoting on a command line
  is quoted. A restriction here would be user-visible and nobody asked for one.
- **`description`** — an optional short line saying what the role is for (req 9). Separate from
  the standing instructions and **not** derived from them, since either may be absent; where both
  are absent the inventory and the Settings list fall back to the name.
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

**It removes a whole failure mode, and that failure mode is live rather than hypothetical.**
docs/261 records a latent bug it deliberately left open (`plan.md`, phase 3): a pin's reasoning
level is validated against the *settings-time derived* harness while the review may run on a
**different** one, carrying a level the second harness may not declare — fixable there only by
choosing between refusing the review and silently substituting a default. A role has no such gap:
the level is validated against the one harness the role names, and that is the harness it runs on.

**Corrected 2026-08-15: two shipped models are dual-harness, so this is reachable today.**
`deepseek/key/deepseek-v4-flash` and `deepseek/key/deepseek-v4-pro` declare
`styles: [O_CC, O_RESP, A_MSG]` (`services.ts:250-251`), and `resolveStyle` needs one style in
common with the harness — `claude` declares `anthropic-messages`, `codex` declares
`openai-responses` (`harnesses.ts:35`, `:95`), so both harnesses carry both models. They are the
only two: no other row in the catalogue declares both styles. The bug was reproduced on shipped
code with a DeepSeek key as the only credential — a pin accepted at effort `max` (validated against
the derived `claude`) resolves onto `codex`, whose levels stop at `xhigh`.

**What it costs.** The pair (model, harness) can now disagree in a way a model alone could not, so
the save-time check is load-bearing rather than belt-and-braces. The *choice* is exercisable on
today's catalogue for those two models and unexercisable for every other, so each model but two has
exactly one valid harness. That does not make the field derivation with extra steps:
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

`resolveRoleByName(name, overrides, implementer, deps)` looks the name up, applies whatever the
caller overrode, and returns a frozen target:

1. **Unknown name → `ServiceError` listing the roles that do exist** (req 13). The list is the
   whole remedy; nothing else needs saying.
2. **`pinned` params** → the role's tuple, with any override substituted over it. The harness is
   the role's unless overridden (req 6 — never derived), and the only question left is whether the
   result has a **usable route**.
3. **`auto` params** (the reviewer) → a run with **no** override ranks exactly as it does today,
   distance guarantee and all. A run **with** an override is where the care is needed, and two
   facts about the existing code shape the rule:

   - **`selectReviewer` can fail.** When neither configured slot has a usable route it returns no
     target at all (`reviewer-model.ts:492-500`, `pin_unavailable` / `nothing_eligible`).
   - **The reviewer's "automatic" params are not all ShipIt's choices.** A slot may be
     **user-pinned**, and `slotPlans` reads those pins directly (`reviewer-model.ts:317`), with a
     pinned reasoning level preserved rather than derived (`reviewer-model.ts:540`). docs/261 req 8
     is explicit that a pin wins.

   So the rule is **rank only when the call needs a base**, and never discard a pin that still
   applies:

   **(a) A complete override needs no base.** Where the caller names all five, resolve it directly
   and do not call `selectReviewer` at all. Ranking first would let a failed ranking reject a
   perfectly valid target the caller fully specified — which reqs 10 and 16 both forbid, since
   "any subset" includes the whole set.

   **(b) A partial override completes from the ranked winner**, because that is the only thing
   that supplies the rest. An override naming only a reasoning level or only a harness identifies
   no target by itself, and this is what lets it resolve. If the ranking fails here, the call fails
   with the ranking's own reason — there is genuinely nothing to complete from, and inventing one
   would be the substitution req 7 forbids.

   **(c) A pin is a `(service, billing mode, model)` triple, not three independent fields.**
   Overriding the **model** replaces the triple as a whole and re-resolves where that model lives —
   not because pins may be discarded, but because a service pinned *for model M* says nothing about
   model X, so there is no surviving decision to honour. Overriding the **level** or the **harness**
   leaves the triple untouched. Nothing the user chose that still applies is ever dropped.

   **(d) What remains incoherent is refused, naming the parameter** — an overridden harness that
   cannot carry the pinned model, a model no service offers. Refusal here matches the pinned-role
   case exactly, which is why there is no longer an asymmetry to justify.

   The earlier objection to overlaying at all ("half a ranked winner plus a swapped field is a
   tuple nobody chose") was really an objection to *silently* losing req 2. Said out loud, it stops
   being a problem: the caller chose the swapped field, and req 2 was never promised for that run.

Either way, freeze the target with the role's name on it.

**Both cases refuse an incoherent override, and that uniformity is the point.** An earlier draft
had the reviewer *re-derive* around an override while a pinned role refused, justified by the claim
that ShipIt chose the reviewer's dependent fields anyway. **That claim is false**: a reviewer slot
may be user-pinned, and `slotPlans` reads those pins directly. Once the premise goes the asymmetry
has nothing holding it up, and removing it makes the design smaller — one refusal rule, stated
once, for every params kind.

What survives from that draft is only rule (c) above, which is not re-derivation: overriding a
model re-resolves where *that model* lives, because the pinned triple it replaces made no claim
about it.

**An overridden tuple is validated exactly as a stored one is** — the model exists on that service
and billing mode, the harness can carry it, the level is one that harness declares. The same
harness-explicit validator does both, because an override reaching the run is the same object as a
role reaching the run; the only difference is where the fields came from. An override that does
not validate is **refused, naming the parameter**, never quietly dropped: a dropped override runs
something other than what was asked for, which is the failure this whole design exists to prevent.

**Overriding cannot make a role run something it could not be saved as.** That symmetry matters
because it is what stops the override path from being a hole in req 6: there is no combination
reachable through `--role X --model Y` that a role could not have been configured to hold.

**Precedence, stated once:** an override beats the role; the role beats derivation; nothing beats
an override. Every field the caller did not name comes from the role, and every field the role does
not carry (the reviewer's case) is derived.

A role that cannot run says which of **three** things it is, because the remedy differs in each and
collapsing them sends the user to the wrong place:

- **stranded** — its model, service or harness no longer exists. It needs a **Settings edit**, and
  is never silently repaired.
- **disconnected** — the tuple is still structurally valid, but the service it names has no usable
  credential any more. The remedy is to **reconnect the service**, and the role itself is correct;
  editing it would be the wrong advice. Route selection reports this as `auth_required`
  (`service-routing.ts:383`, `:479`), separately from exhaustion.
- **temporarily unroutable** — its subscription is spent. Nothing to fix; it recovers when the
  quota resets, and the tuple is kept exactly. Reported as `all_exhausted` (`service-routing.ts:469`).

The first is a stored-state problem, the second an account problem, the third a clock problem. Only
the first is the role's fault.

## The reviewer (req 2)

There is **one kind of role**, and the variation lives in a role's params: the user pins them
(req 1), and ShipIt ships one role — the reviewer — whose params it resolves (req 2). In the data
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
(both shapes below), reported the same way, and — since the asymmetry came out — refused the same
way, an incoherent override naming its parameter whichever params kind it lands on. It is also the one role whose
name is reserved and which cannot be renamed or deleted (req 2) — "review this" has to keep
resolving to something, and reviewing has to work on an install nobody has configured.

## One spawn vocabulary, two commands (reqs 11, 16)

A role names what runs, and that is the same question whichever way a sub-agent is started. Today
the two commands answer it in two different vocabularies, and req 16 collapses that.

**What each can say today, and what it becomes:**

| | `shipit agent run` | `shipit session create` |
|---|---|---|
| **Today** | a role, or all five params; an omission refused | `--agent` and `--model` only, forwarded as bare values — no service, no billing mode, **no reasoning level at all**; everything else inherited |
| **Becomes** | a role, a role ± overrides, or a complete target | the same three, plus the parent as a base — so its existing partial form is one of the general cases rather than an exception |

**The child session gains the most, and that is the point.** It cannot express a complete target
at all right now: `session create` parses `--agent`/`--model` and forwards them bare
(`shipit-session.ts`), so a service, a billing mode and a reasoning level are unsayable. A parent
that wants a child on a specific model at a specific effort cannot ask for it. Unification is
therefore additive there rather than only restrictive.

**One resolver, two call sites.** The shared piece is "what does this spawn run on" — a role name
or a complete target in, a resolved `(harness, selection, effort)` out, with one refusal rule.
`sub-agent-target.ts` already is that function for the one-shot path; roles extend it, and
`session create` calls the same thing instead of its own two-flag reading. That is what makes the
two commands *consistent by construction* rather than by two implementations agreeing.

**Where they legitimately differ, and it is one thing only.** A child has a parent available as a
base; a one-shot run does not, so naming a role (or a complete target) is how it says anything at
all. Everything else — the role, the overrides, the refusal — is identical, which is what req 16
asks for.

**Overriding is not the same as inheriting, and the two do not stack confusingly.** An override
modifies whatever base the caller named: a role, or the child's inheritance. It is always
*something the caller wrote* over *something the caller can point at*, which is the property that
keeps docs/261 req 7's rule intact — no blank is ever filled from a place the caller cannot see.

**The resolver takes a base and a set of overrides, and that is the whole shape.** What counts as
a base is where the two commands differ, and it is the only place they do:

| Base | Available to | Completed from |
|---|---|---|
| a **role** | both commands | the role's params (resolved, for the reviewer) |
| the **parent session** | `session create` only | the parent's harness, selection and level |
| **nothing** | both commands | nothing — so the call must name all five itself |

Overrides apply over whichever base was named. This is what makes req 16 true without a carve-out:
partial is ordinary, the child's existing `--model X` is not a special case but a partial call over
the *parent* base, and the refusal narrows to its real target — **a call with no base and only some
parameters**, which is the one shape ShipIt would have to guess at.

**What "base" does and does not mean, because an earlier draft overreached here.** That draft said
a parent completes a partial call *exactly* as a role does. It does not, and the difference is
deliberate, documented, and must be preserved rather than unified away:

- a bare `--model X` inherits **no** service or billing mode from the parent
  (`child-sessions.ts:519` — `if (opts.model) return { model: opts.model }`), because a model id
  names one backend's catalogue;
- a harness switch **clears** the inherited selection entirely, for the same reason spelled out at
  `child-sessions.ts:521-525`;
- a reasoning level carries only where the target harness declares it, and is otherwise **dropped**
  (`child-sessions.ts:599-604`) — a level is a depth that means the same thing on either backend,
  a model id is not;
- the stored child target stays **partially optional** (`child-sessions.ts:605`), so a parent does
  not even always hold a complete tuple to copy.

So "base plus overrides" is the **shape of the call**, not a claim that every base completes the
same way. A role completes from its own params; a parent completes by the rules above, which are
docs/261's and stay exactly as they are. Unifying the *surface* — same flags, same parser, same
refusal rule — is what req 16 asks for; unifying the *completion semantics* would silently change
child behaviour nobody asked to change.

**What a role does to a child, once resolved.** A role decides what the child *starts as*, not
what it is bound to (req 11). The resolution happens once, before any disk work; it seeds the new
session's stored harness, selection and reasoning level — passing a resolved selection and effort
**directly**, not squeezed through today's `agent`/`model` options, which would silently drop the
service, billing mode and level. From then on the child is an ordinary session: normal routing,
account failover and retirement behaviour, per turn. The one-shot path's frozen route must not be
carried in, or a child is pinned to one credential for its whole life and failover breaks days
later under quota exhaustion.

**Overrides replace the old mutual exclusion.** `--role NAME` alongside a parameter used to be
refused; it is now the override path (req 10). What stays refused is a call that names *no* role
and *some* parameters — an incomplete target with nothing to complete it from, which is docs/261
req 7's rule and is untouched. So the refusal moves rather than disappearing: it now fires on
incompleteness, not on the combination.

## The CLI

```
shipit agent run      --role deep-dive --prompt-file - <<'EOF'
…
EOF
shipit session create --role deep-dive --title "…" --prompt-file - <<'EOF'
…
EOF
```

A role name may contain anything the user typed, so it is quoted where it needs quoting —
`--role "deep dive"` — exactly as a title already is.

An override rides alongside, on either command, and names only what changes:

```
shipit agent run      --role deep-dive --model claude-opus-5 --prompt-file - <<'EOF'
…
EOF
shipit session create --role deep-dive --effort high --title "…" --prompt-file - <<'EOF'
…
EOF
```

The role supplies everything not named. **The same flags mean the same thing on both commands**,
which is the whole of req 16: one parser, one validator, one refusal rule.

On `session create` the role may also be left out, and then the **parent** is the base — this is
the form docs/261 req 10 already ships, and it is unchanged:

```
shipit session create --model claude-opus-5 --title "…" --prompt-file - <<'EOF'
…
EOF
```

Not a special case: a partial call over a base, where the base happens to be the parent rather than
a role. The same call on `shipit agent run` is refused, because a one-shot run has no parent and
so nothing to complete itself from — which is the *only* difference between the two commands.

**The shim's role check changes shape.** Today it rejects an unknown role locally against a
compiled-in list, to give the agent a fast message. It cannot know the user's roles — they live
server-side — so the local check becomes a pass-through and the server's resolution is the
authority, with the refusal (req 13) naming the roles that exist. The shim buys a message for
what it can know and does not pretend to know the rest.

## The inventory (req 12)

An agent can only name what it can see. Today it can see nothing: the session shim exposes
`agent run` and `agent result` and nothing that lists roles, models, harnesses or levels.

Req 12 needs two reads, and they exist for different reasons:

- **The roles** — name and description (req 9), so an intent can be mapped onto one (req 3) and
  the user can be told what exists. Where a role has no description the name stands alone.
- **The parameters this install actually has** — the eligible models with their service and
  billing mode, the harnesses, and each harness's reasoning levels. This is what makes an override
  (req 10) name something real.

**The second read is the one that changed, and it changed a boundary this design had twice drawn
the other way.** While a role was a unit, withholding the catalogue kept the agent out of the
business of choosing params. Once an override is allowed, withholding it does the opposite: the
agent still names a model, but names it from memory, and a remembered model may not exist on this
install at all. **Allowing overrides and withholding the list is strictly the worst combination**,
so the two ship together.

What this does *not* become is an invitation to assemble targets from scratch — that is req 15's
subject, and the answer there is unchanged: a role is the path, an override is a modification to
it, and the parameter list exists to make the modification honest rather than to make the
five-parameter form attractive.

The refusal (req 13) carries the role list, so an unknown role is self-correcting; an override
that names something this install does not have is refused the same way, naming the parameter.

## What the agent is told (req 15)

ShipIt injects instructions into every session, and today they document a run that names every
parameter — harness, service, billing mode, model and level, all mandatory. That shape leaves the
injected documentation, and req 12's inventory changes *why* rather than whether.

**The reason is no longer "the agent cannot".** With the parameter list available, an agent could
assemble such a call. The reason is that it should not have to: **a role, with an override where
one is wanted, does the same job in less and keeps what runs anchored to something the user
configured.** A five-flag call names a target nobody chose in Settings and that nothing in the
product remembers; `--role deep-dive --model X` says the same thing while staying attached to a
role the user owns.

So the agent is told: name a role; carry an override when the user asked for one; if the role you
need does not exist, say so — the user creates it in Settings (req 5).

**The path stays implemented, and the repository override stays reachable.** docs/261 req 2 lets a
repository override the reviewer by naming all five parameters, and its phase 5 drew the line on
*what the caller was handed*: no complete target ⇒ use the role; a complete target ⇒ pass it
through. The injected guidance keeps that carve-out in the form that cannot teach assembly: **if
repository policy hands you a complete target, pass it through unchanged.**

**This collides with a shipped guard, and the collision is the work.**
`review-command-callers.test.ts` asserts that `shipit-docs/agent.md` contains at least one
*complete* five-flag invocation, precisely so the override stays documented. Req 15 removes it from
the pages ShipIt injects into a session. Both cannot hold for the same page, so the audiences
separate: the complete shape belongs in the human-facing reference for whoever writes repository
policy, and the guard moves with it.

**The removal surface is wider than that one page, and the existing guard cannot see the rest.**
Both harness system prompts (`agents/claude/system-prompt.md`, `agents/codex/system-prompt.md`)
also spell the complete five-flag command out in full. The guard today rejects only *incomplete*
explicit runs there (`incompleteExplicitRuns`), so a complete one passes unnoticed. Phase 4 needs
the mirror assertion: **no `completeExplicitRuns` in any `buildAgentSystemInstructions` variant or
any injected doc**, with the positive "it is documented somewhere" assertion pointed at the
human-facing reference instead.

**Two things about that mirror assertion, both of which would otherwise let it pass while req 15
is still violated.**

*The surface is four pages, not three.* `shipit-docs/sandbox-session.md:93-97` teaches the same
five parameters — "names all five of `--agent`, `--service`, `--billing-mode`, `--model`,
`--effort`" — and it is injected like the others. Any enumeration that lists only `agent.md` and
the two system prompts leaves it behind. The enumeration should be derived from what is injected
rather than written out by hand, so the next page added is covered without anyone remembering.

*A matcher for a literal command does not see prose.* `completeExplicitRuns` detects a complete
*invocation*; `sandbox-session.md` names the five flags in a **sentence**, and would pass a
command-shaped matcher untouched. So the negative assertion has to catch the parameter names
appearing together as guidance, not only a runnable line — otherwise the guard reports success on
a page that still teaches assembly.

*The positive assertion needs a named destination.* Saying it "moves to the human-facing
reference" is not yet a target a test can point at. The complete shape lands in **`docs/261-
configurable-reviewer/plan.md`**, which already documents the repository-override path for exactly
this audience, and the guard asserts against that path. Naming it here is what stops the positive
assertion from being quietly dropped when `agent.md` stops serving the role.

## Settings (req 5)

**A role is created and edited in ShipIt's settings UI, and that is the only way it comes from.**
Choosing a role's params means choosing among the services, models, harnesses and levels *this
install* offers, and the UI is the only surface that can show that set — the three shared pickers
already enumerate exactly that.

The Reviewer tab becomes a **Roles** surface in two parts:

- a **Reviewer** section — its description and standing instructions, then the two existing slot
  cards exactly as docs/261 ships them. No rename, no delete, no single model control, because its
  params are two ranked candidates (req 2);
- a **list of pinned roles**. Each row is a *summary* — the name, the description, and what it
  resolves to — plus open and delete. Editing happens in a **role editor** (req 17), not in the
  row. (An earlier draft also offered *duplicate*. No requirement or receipt asks for it, and every
  requirement is satisfied without it, so it is gone — a role takes one name and five choices to
  make from scratch.)

**The harness is required in the data, and it is a required interaction for the models that have a
choice.** Where a model has exactly one harness that can run it, the field is filled from that
single valid option and *shown* rather than asked for. Where a model has two, it is a **real
picker**, because nothing else can say which harness the role means.

**Corrected 2026-08-15.** An earlier draft said every model has exactly one harness, so the field
could ship read-only and become a picker "the day a model is offered by two harnesses". That day
has already passed: `deepseek-v4-flash` and `deepseek-v4-pro` are carried by both harnesses (see
*The harness is part of a role*). A read-only readout would make a DeepSeek role unable to express
which harness it runs — the exact expressiveness req 6 exists to give it — so the picker is phase 2
work, not deferred work. The stored shape is unchanged either way; only the control is.

It is shown from day one deliberately, picker or readout: a role's harness is part of what it *is*
(req 6), so hiding it until it becomes selectable would misrepresent the role.

The server is the authority on every write. It does **not** reuse `resolveReviewerPinPatch` as-is:
that function *derives* a harness (`harnessesForSelection(patch, …)[0]`, `reviewer-settings.ts`)
and validates the reasoning level against whichever it picked. Handing it a role would reproduce
exactly the defect the required harness exists to remove — a level checked against one harness and
run on another. A role needs a validator that **takes `harnessId` as an input**: the triple must
exist in the catalogue, the named harness must be installed, able to carry the model and
credentialed, and the level must be one that harness declares. The two validators share their
catalogue and credential checks; only the harness step differs, and it differs in the direction
that matters.

Name validation is server-side too, and is only uniqueness (req 18): any name the user types is
accepted.

**The role editor (req 17).** A role carries a name, a description, standing instructions and
five parameters. That is more than a row of inline dropdowns can hold legibly, and standing
instructions are free text that needs room — so opening a role gives one place to edit all of it,
and saving is one write of the whole role rather than a control-by-control trickle. The shared
service / model / reasoning controls live inside it (docs/261 req 13 still binds their appearance),
with the harness beside them.

The reviewer opens the same editor for its name-less, description-and-instructions half; its
params stay the two slot cards, because they are two candidates rather than one tuple.

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
  it cannot run until someone edits it, and req 7 means it is never silently re-pointed — including
  through a catalogue retirement successor, which is the settled divergence from how a reviewer pin
  behaves. A role whose subscription is merely **quota-exhausted** is not stranded at
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
- **Two new agent-facing reads** (req 12) — the roles, and the parameters this install has. The
  second is the real cost, and it is a **product** cost rather than an engineering one: an agent
  that can see every model is an agent that can be asked to pick one, and the only thing keeping
  it from doing so is what it is told (req 10's relay-don't-decide rule). That rule is
  unenforceable by construction, which is worth stating plainly rather than discovering later.
  The mitigation is that the default path — a bare role — remains shorter and easier than
  assembling anything.
- **A required harness** (req 6) is one more thing that can go stale and one more pair that can
  disagree — answered by the save-time check and the stale-pin path. Set against that, it removes
  the effort-across-harnesses failure mode entirely.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the role record, the params discriminator, the synthesized reviewer, `resolveRoleByName` with overrides, the harness-explicit validator | 1, 2, 6, 7, 8, 9, 10, 13 | A role resolves on the harness it names; an override substitutes over it and is validated as a stored tuple would be, refused by name when invalid; a **complete** override on the reviewer resolves without ranking at all, a **partial** one completes from the ranked winner, and an incoherent one is refused exactly as on a pinned role; `getRoles()` yields the reviewer on an empty store |
| 2 | Settings: role CRUD through the existing mutation surface, the Reviewer section above the pinned-role list, the **role editor**, the unresolved-role view | 1, 2, 5, 6, 8, 9, 17, 18 | A role is created, edited and deleted from one editor rather than inline controls; the reviewer has no rename or delete and keeps its two slot cards; a role whose model or harness is gone still renders its stored tuple and stays editable |
| 3 | One API surface: the shared target resolver behind both commands, `--role NAME` plus override flags on each, both reads, the prompt join, the intent-to-role guidance | 3, 4, 10, 11, 12, 14, 16 | Both commands take a role, a role with overrides, and a complete target through **one** parser and validator; a child can finally name a service, billing mode and level; a child seeded from a role then routes like any other session, carrying an immutable `originRoleName`; the agent can list roles *and* available parameters |
| 4 | Documentation split: the five-parameter shape leaves every injected surface and moves to the human-facing reference, with its guard inverted | 15 | Neither injected doc nor any system-prompt variant contains a complete five-flag command; the agent is told to name a role and relay an override rather than assemble a target; the repository override is documented for whoever writes repository policy, and the guard asserts it *there* |

Phase 1 carries the params discriminator, so `selectReviewer` and the two-slot settings survive
intact behind the `auto` branch rather than being retired or reimplemented.
