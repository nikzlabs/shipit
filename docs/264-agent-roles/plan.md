---
issue: planning#363
title: Agent roles — design
description: The reviewer is one role; user roles carry the params and an optional prompt, invoked by name.
---

# 264 — Agent roles: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

Today an agent run is either **implicit** (`--role reviewer`, resolved from the two configured
slots — docs/261) or spelled out **ad hoc** per review (`--model NAME` / `--effort LEVEL` —
docs/263). The ad-hoc spelling is a *novelty*: it is spent the moment the run ends. This feature
generalizes the implicit side: the user preconfigures **roles** — named units of agent work —
and invokes one by name (reqs 1–4). The reviewer is the first role; user roles are additive.

The progression the product is built on:

| Invocation | What runs | Reusability |
|---|---|---|
| `--role reviewer` | the two ranked slots (docs/261) | none — always re-resolved |
| `--role reviewer --model X --effort Y` | that model, ad hoc (docs/263) | none — a novelty, spent |
| `--role deep-dive` | the named role | yes — an asset, reusable |

The ad-hoc path is not removed, warned at, or made harder. It is the **on-ramp** (req 6):
conversion is an **offer** at recurrence (req 7) that opens the Roles settings surface prefilled
(req 5 — creation is a UI act in v1), and a one-word invocation thereafter (req 4), or no word at
all when the intent alone resolves the role (req 3) — never a block.

## The shape: roles, not a reviewer namespace

The previous frame designed **named reviewer configurations** invoked by a separate
`--reviewer NAME` flag. The human's generalization (2026-08-13 receipt in `requirements.md`)
folds that namespace into the role namespace: **a named reviewer is a role**, and `--role NAME`
invokes it. One concept, one flag, one name-space.

Three reasons the generalization is the right call, not just a renaming:

- **The role namespace was always meant to extend.** `SUB_AGENT_ROLES = ["reviewer"]` carries the
  design note that "a second role (a summarizer, a test writer) would land here rather than
  growing another flag." The human's proposal makes that extension **user-facing** instead of
  code-authoring — which is also what req 2's "the reviewer is a role like any other" states.
- **It removes the second name-space.** The earlier frame had reviewer names *and* role names.
  Roles give one namespace, one lookup, one unknown-name refusal (req 8).
- **It dissolves the docs/261 req 6 tension, honestly.** That requirement says the agent "names
  the role, never the reviewer." A user role *is* a reviewer the user named. The invariant that
  survives, stated plainly: **the agent names a role and never names a param.** The user defines
  the role's params (req 1); the agent works out *which role* is meant and passes an explicitly
  named one through unchanged (req 3). The built-in `reviewer` role keeps the automatic
  resolution docs/261 built. Both cases agree on the only line that matters: the agent supplies
  no service, no model and no level.

  **Naming the role is the agent's job; naming a param never is.** An earlier draft had the agent
  relaying even the role name verbatim, which would have made "review the PR" un-actionable until
  the user recited a role name — docs/263's courier rule stretched past what it is for. It exists
  so an agent cannot invent a model or an effort level, values it has no way to know. Which role
  fits an intent is exactly the judgement an agent is for, and it is what already happens when
  "review this" becomes `--role reviewer`.

## What a role is

```
role = { name, prompt?, params }
params = (serviceId, billingMode, modelId, reasoningEffort)   // pinned — req 12
```

- **`name`** — a single CLI-safe token: lowercase letters, digits and dashes (kebab-case), so
  `--role NAME` is a valid word and cannot collide with a flag. Unique per install; creating a
  duplicate is a refusal.
- **`prompt`** — an optional free-text standing prompt (req 11). See *The prompt*.
- **`params`** — exactly the tuple a pinned reviewer holds (docs/261 reqs 1, 3, 5). The harness
  is **derived** (req 9, docs/261 req 3) and a role never *has* to name one. Whether it may
  **optionally constrain** it is open question 1, reopened by the human — the recommendation is
  an optional field that is absent by default and whose control appears only where a model is
  genuinely dual-harness, which is nowhere in today's catalogue. Designed for below, under
  *The harness constraint*.
- **The built-in `reviewer` role is not stored.** Its resolution *is* the two slots (docs/261).
  It is listed alongside user roles wherever roles are listed, but it has no row.

## The built-in reviewer

`--role reviewer` is unchanged: the distance ranking over the two configured slots, with the
auto-configured/pinned state and the *Eligible is not runnable* rule all as docs/261 ships them.
The ad-hoc override flags (`--model NAME`, `--effort LEVEL`, docs/263) attach to **this** role,
whose params are otherwise auto — they are the on-ramp, and a pinned user role is not the place
for them (req 13).

## The prompt (req 11)

A role may carry a **standing prompt** — its job description ("check the code against
requirements.md", "review the diff for correctness only"). At spawn the role's standing prompt
and the invocation's `--prompt-file` task compose into **one prompt channel** — the sub-agent
has a single prompt channel (docs/144), so there is no second channel to wire: the standing half
first, the task half after, one stable join at spawn. No prompt-architecture change (CLAUDE.md's
*prompts are content, not logic* holds: the composition is a fixed join in code, and a role's
prompt is **user data** stored in settings, not prompt text compiled into the binary).

The built-in `reviewer`'s brief stays as composed today (client-side, `compose-review-body.ts`)
for now; migrating it into the role is a later simplification, not a requirement of this feature.

## Storage

User roles live in the credential store as an **ordered list**, list-shaped for the same reason
the earlier design chose it:

- `getRoles(): Role[]`
- `setRole(name, role | null)` — upsert or delete
- `renameRole(oldName, newName)`

Order matters only for a future tie-break, so it is insertion order and reorderable in Settings
as a nicety. Nothing about the two slots changes.

## Resolution

`resolveRoleByName(name, implementer, deps)`:

1. **Built-in roles** — `reviewer` → `selectReviewer` (docs/261, unchanged): resolved and routed
   once, frozen.
2. **User roles** — look `name` up in the store. **Unknown → `ServiceError` listing the known
   roles** (built-in and user) and, because a role name and a model label are two name-spaces, a
   hint that `--model` is the flag for a model (req 8). Resolve the pin exactly as a pinned slot
   resolves today: eligibility + **usable route** (`firstRoutable`, the *Eligible is not
   runnable* rule), harness derived preferring one that is not the implementer's, effort = the
   pin's level (validated at save against the settings-time harness; the latent dual-harness
   caveat recorded in docs/261 phase 3 applies unchanged). Freeze the target with
   `source: "role"`, carrying the name.

The consult card's `runOn` reports the resolved tuple, as phase 4 already does for every review
(req 10); the role's name joins the ranking's log line. A user role whose credential or harness
has gone away is `pin_unavailable`, exactly as a pinned slot is today — the refusal says *why*
and points at Settings.

## The CLI (reqs 3, 4, 8)

`--role NAME` accepts any known role, built-in or user:

```
shipit agent run --role deep-dive --prompt-file - <<'EOF'
…
EOF
```

**The shim's role check changes shape.** Today the shim rejects an unknown role locally
(`SUB_AGENT_ROLES.includes(role)`) to give the agent a fast message. It cannot know the user's
roles — they live server-side — so the check becomes: the built-in set is validated locally (for
the message), and anything else is **passed through for the server to resolve**. The server's
`parseSubAgentSpawnTarget` resolves the role against built-in + store, and the refusal (req 8)
is the server's, listing the known roles. The shim buys a message for the built-in set and not
for user roles, which is the honest limit of what a stateless shim can know.

**Mutual exclusion, mirroring docs/261's role-vs-explicit refusal.** `--role NAME` names a
complete unit (req 1), so combining it with `--model` or `--effort` is refused (req 13). The
ad-hoc pair names the *built-in reviewer's* params; a user role already
fixed them.

**The agent chooses the role; it never chooses a param** (req 3). The system prompts say to map
the user's intent onto a role from the inventory (below) — "review the PR" reaches `reviewer`
without the user saying so — and to pass an explicitly named role through unchanged. What they
must not do is supply `--model`, `--effort`, `--service` or `--billing-mode`, which the agent has
no way to enumerate (the 2026-08-14 finding) and no business choosing.

## The inventory (req 14)

An agent can only map an intent onto roles it can see, so it has to be able to read them. Today
it cannot read anything of the sort: the session shim exposes `agent run` and `agent result` and
nothing that lists services, models, levels **or roles**.

The smallest thing that satisfies req 14 is a **read of the roles, and only the roles**:
`shipit agent roles` (or the same list on the existing spawn refusal). Each entry is a name and,
where the role has one, its prompt's first line as a description — enough to choose between
`deep-dive` and `spec-check`, and enough to tell the user what exists when they ask.

**Deliberately not the whole catalogue.** Exposing services, models, billing modes and levels to
the agent would make the fully-explicit path usable — and that is the path req 6 declines to
build on and open question 2 proposes to leave alone. Roles are the unit the user configured
precisely so the agent does not have to reason about params; handing it the params anyway would
undo that. So the inventory is scoped to what req 3 needs and stops there.

The refusal (req 8) carries the same list, which is what makes an unknown role self-correcting:
the agent learns the real names at the moment it guessed wrong.

## Creating a role (req 5)

**In v1 a role is created and edited in ShipIt's settings UI, not in chat.** An earlier draft had
the agent creating roles from a sentence; the human removed it, and the reasoning holds up:
choosing a role's params means choosing among the services, models and levels *this install*
actually offers, and the UI is the only surface that can show that set. A chat sentence would
have the agent naming params it cannot enumerate — the same defect the 2026-08-14 finding
records one flag over.

The server is still the authority on the write, reusing `resolveReviewerPinPatch` **verbatim** —
a role's params are a `ReviewerPin`, and that function already validates a triple against the
catalogue and the level against the *derived* harness, completing the tuple when the level is
omitted. The prompt (req 11) is an ordinary string field.

The settings surface gains the role list:

- `PUT /api/settings` carries `roles` alongside `reviewers` — create / edit / rename / delete as
  a patch, the same whole-payload shape the slot pins use, so the *server sends the resolution*
  rule and the `agent_list` rebroadcast hold for roles exactly as they do for the slots.
- The payload carries each role **resolved** — name, params, optional prompt, and what it
  resolves to today — so Settings renders the same state the runs use, and the agent can name it
  in a refusal.

Name validation lives server-side (kebab-case token, length bound, uniqueness), and a name the
user chooses is accepted as given — the user owns the word.

## The harness constraint (open question 1)

Req 9 keeps the harness **derived**, and a role never has to name one. The open question is
whether it may *optionally constrain* it, and the recommendation is yes — designed here so the
shape is visible rather than argued in the abstract:

- **An optional `harnessId` on the role.** Absent — the default, and the only state expressible
  today — means derived, exactly as now. Present means this role runs on that harness, and the
  save is **refused** if that harness cannot run the model, in the same place and the same way
  an invalid effort level is refused (`resolveReviewerPinPatch`).
- **The control follows docs/261 req 14**: it is rendered only where the chosen model is offered
  by more than one harness. On today's catalogue no model is, so the control never appears and
  the field is never set — the feature ships as though the answer were "no", and becomes
  available by itself the day a gateway row makes a model dual-harness.
- **It changes no resolution rule.** A constrained role skips the "prefer a harness that is not
  the implementer's" preference for that role only; every other rule — the routable check, the
  frozen target, the attribution — is untouched.

**Why this rather than the flat "no" recorded a turn earlier.** The reasons for "no" were
model-first consistency and the fact that a harness picker would have exactly one option today.
The second is true and is the real reason it looked settled — but it is an argument for *not
rendering a control*, not for making the state inexpressible. The first is weaker than it looked:
a harness is not a neutral pipe, and ShipIt's own ranking already treats it as a distance axis
(docs/261's `reviewerDistanceTier`), so a design that ranks on the harness while forbidding the
user to express it is asserting a rule it does not itself keep. **The honest cost of the
recommendation is that it is untestable end to end today** — the same gap docs/261 records for
tiers 3 and 5 — so it is pinned as a pure function and left unreachable through the shipped
catalogue, and that limit is stated rather than papered over.

## Recurrence conversion (req 7)

The mechanism is the **propose-actions pattern**, and the trigger is the **agent's own
judgement** — a design decision, not a requirement. It was briefly filed as an open question and
withdrawn (`requirements.md`, 2026-08-14 receipt): the user cannot observe whether an offer came
from the agent noticing or from a server-side detector, so both satisfy req 7 identically and
neither is the human's to ratify. The agent is the courier of every role request, so
it is the only surface that can see "the user has asked for GPT-5.6 at high effort twice." When
it recognizes a recurrence — a `--role reviewer --model NAME --effort LEVEL` combination the user
has asked for before — it offers, at the end of the turn, to save it as a role. **Accepting opens
the Roles settings surface prefilled** with that model and level, rather than writing the role
itself: creation is a UI act in v1 (req 5), and the offer is how the user gets there in one click
instead of re-deriving the combination from memory. A repeated *task* shape (a prompt the user
keeps attaching) prefills the prompt too, which is where req 11 pays off.

Two design notes:

- **Recurrence is observed from the conversation the agent already has**, cross-checked against
  the consult cards' `runOn` tuples (phase 4 persists `(model, effort)` on every card). No new
  store, no server-side detector — that would duplicate, in a place that cannot act, a sight the
  agent already has.
- **The offer is never required and never interrupts.** An offer is a card at a turn boundary;
  the run itself is unaffected. Declining is the end of it — conversion is the mechanism, not
  prohibition (req 6).

## The Settings tab

The Reviewer tab becomes (or grows into) a **Roles** surface: the built-in `reviewer` row (auto,
showing its two-slot resolution — the auto-configured/pinned state docs/261 ships) followed by
the user roles, each a name field, an optional prompt field (req 11), the three shared
controls (`ServiceSelector`, the model menu and the reasoning menu — all phase-6 shared pickers,
so docs/261 req 13 binds them by construction), a rename, a delete, and a *New role* row. User
roles are pinned by construction (a user created them), so the auto/pinned badge that the slots
carry applies to the built-in row only. Where a model is dual-harness, the row also carries the
optional harness control (open question 1); on today's catalogue it is never rendered.

**This surface is load-bearing rather than a convenience**, because req 5 makes it the only way a
role is created. It is also the answer to the question chat-native creation could not answer:
what *can* this install actually run? The three shared pickers already enumerate exactly that.

Nothing here is optimistic, for the same reason the slots are not: the server sends the
resolution and the response replaces the whole list, because nothing is safe to guess in the
browser.

## Cost assessment, honestly

The earlier frame's costs carry over; the prompt adds one. Each:

- **Stored state with staleness.** A role pinned to a retired model, a removed service or a spent
  credential is stranded — docs/261's `pin_unavailable` machinery. Reused wholesale: retirement
  resolves through the successor (docs/252 req 13) where the catalogue offers one, and a role
  that cannot run is *refused with a reason and a pointer to Settings*, never silently replaced.
- **Unbounded-list management.** Create, edit, rename, delete, order. CRUD is four routes of an
  existing settings surface; the tab is a list rendering shared controls. **There is no "default
  role" flag** — the automatic pick stays the built-in reviewer's distance ranking, not a user
  setting — so the list management is lighter than it first looks.
- **One name-space.** Role names and model labels are the two lookup tables, and they cannot
  collide at the flag level (`--role` and `--model` are distinct). The unknown-role refusal names
  the known set and points at `--model` for a model (req 8).
- **The prompt** (req 11) adds a content surface: a role prompt is **user data** in the
  settings store — the same store as pins, no prompt-architecture change — and a text field on
  the Settings row. Its only real cost is that a role with a prompt invites the user to treat it
  as a custom agent definition, which is exactly the invitation the generalization intends.
- **The bare-role ranking still has a clean answer.** User roles are pinned (req 12), so the
  automatic pick is unchanged — the two slots, ranked, with nothing new to integrate.
- **A new agent-facing read** (req 14). The inventory is one small list endpoint, and its cost is
  not the endpoint but the **boundary**: it must stay scoped to roles. Widening it to services
  and models would revive the fully-explicit path this design declines to build on, and would put
  the agent back in the business of choosing params.

## The pool question, settled (req 12)

The earlier frame's extend-vs-unify question is settled: **a user role's params are pinned**, and
the automatic resolution is the built-in `reviewer` role's — the human chose it as recommended.
The assessment that led there is worth keeping on record: the automatic pick is a **distance
ranking**, and the derived default is constructed to be distance-optimal, so an auto user role
would rarely win the automatic pick; the benefit would be one mental model ("all roles can be
auto") at the cost of docs/261's shipped two-slot shape. The storage stays list-shaped, so a
future fold would be a small change — but it is a stated non-goal, not a deferred one.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the role list, `resolveRoleByName` (built-in + user), the settings payload carrying roles | 1, 2, 8, 9, 10, 12 | A user role is stored, resolved and routed; an unknown role name is refused listing the known ones; nothing calls it yet |
| 2 | Settings: role CRUD, name validation, the Roles surface with the shared controls and the prompt field | 5, 1, 11 | A role is created, edited, renamed and deleted in the UI; nothing about creation lives in chat |
| 3 | CLI + inventory: `--role NAME` for user roles, the roles read, the intent-to-role guidance, exclusive with the ad-hoc flags | 2, 3, 4, 8, 13, 14 | `--role deep-dive` spawns that role; the agent can list roles and map "review the PR" onto one; `--role NAME` + `--model`/`--effort` is refused in both shim and server |
| 4 | Recurrence conversion: the agent-facing guidance and the propose-actions offer opening the prefilled Roles surface | 6, 7 | A second ask for the same combination produces an offer that lands the user in the UI with it filled in |

**Settings moved ahead of the CLI**, and that is a consequence of req 5 rather than a preference:
the UI is now the only way a role exists, so a CLI phase before it would ship `--role NAME` with
no way to create a NAME. The prompt (req 11) rides phases 1 and 2; the inventory (req 14) rides
phase 3, because it is what makes req 3's intent-mapping possible. The pool question is settled
(req 12): pinned only — deliberately not in the table. The harness constraint (open question 1)
rides phases 1 and 2 if it is taken.
