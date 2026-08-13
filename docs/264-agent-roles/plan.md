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
conversion is an **offer** at recurrence (req 7), a chat-native sentence to save (req 5), and a
one-word invocation thereafter (req 4) — never a block.

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
- **It dissolves the req-6 tension, honestly.** docs/261 req 6 says the agent "names the role,
  never the reviewer." A user role *is* a reviewer the user named. The invariant that survives,
  stated plainly: **the agent names a role and never names a param.** The user defines the role's
  params (req 1); the agent relays the role's name verbatim (req 3). The built-in `reviewer`
  role keeps the automatic resolution docs/261 built — the agent names that role and ShipIt picks
  the performer. Both cases agree: the agent supplies no service, no model and no harness.

## What a role is

```
role = { name, prompt?, params }
params = (serviceId, billingMode, modelId, reasoningEffort)   // pinned — open question 2
```

- **`name`** — a single CLI-safe token: lowercase letters, digits and dashes (kebab-case), so
  `--role NAME` is a valid word and cannot collide with a flag. Unique per install; creating a
  duplicate is a refusal.
- **`prompt`** — an optional free-text standing prompt (open question 1; designed here for the
  recommended yes). See *The prompt*.
- **`params`** — exactly the tuple a pinned reviewer holds (docs/261 reqs 1, 3, 5). The harness
  is **derived** (req 9, docs/261 req 3), never stored.
- **The built-in `reviewer` role is not stored.** Its resolution *is* the two slots (docs/261).
  It is listed alongside user roles wherever roles are listed, but it has no row.

## The built-in reviewer

`--role reviewer` is unchanged: the distance ranking over the two configured slots, with the
auto-configured/pinned state and the *Eligible is not runnable* rule all as docs/261 ships them.
The ad-hoc override flags (`--model NAME`, `--effort LEVEL`, docs/263) attach to **this** role,
whose params are otherwise auto — they are the on-ramp, and a pinned user role is not the place
for them (open question 3, recommendation no).

## The prompt (open question 1; designed for the recommended yes)

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
complete unit (req 1), so combining it with `--model` or `--effort` is refused (open question 3,
recommendation no). The ad-hoc pair names the *built-in reviewer's* params; a user role already
fixed them.

The **agent passes the user's word verbatim** (req 3): the shim and the system prompts treat
`--role NAME` as a value to relay, never a choice to make.

## Chat-native creation (req 5)

"Create a role `spec-check` that checks the code against requirements.md, using GPT-5.6 at low
effort" is a sentence. The agent performs it: it reads the current settings (the roles, the
eligible models, the harnesses' reasoning options), validates what the user named, and writes via
a settings API. The server is the authority on the write, reusing `resolveReviewerPinPatch`
**verbatim** — a role's params are a `ReviewerPin`, and that function already validates a triple
against the catalogue and the level against the *derived* harness, completing the tuple when the
level is omitted. The prompt, if any (open question 1), is an ordinary string field.

The settings surface gains the role list:

- `PUT /api/settings` carries `roles` alongside `reviewers` — create / edit / rename / delete as
  a patch, the same whole-payload shape the slot pins use, so the *server sends the resolution*
  rule and the `agent_list` rebroadcast hold for roles exactly as they do for the slots.
- The payload carries each role **resolved** — name, params, optional prompt, and what it
  resolves to today — so Settings renders the same state the runs use, and the agent can name it
  in a refusal.

Name validation lives server-side (kebab-case token, length bound, uniqueness), and a name the
user chooses is accepted as given — the user owns the word.

## Recurrence conversion (req 7)

The mechanism is the **propose-actions pattern**, and the trigger is the **agent's own
judgement** (open question 5, recommendation). The agent is the courier of every role request, so
it is the only surface that can see "the user has asked for GPT-5.6 at high effort twice." When
it recognizes a recurrence — a `--role reviewer --model NAME --effort LEVEL` combination the user
has asked for before — it offers, at the end of the turn, to save it as a role; the offer's
payload is the exact command (or settings write) that creates it, so accepting costs the user one
click. A repeated *task* shape (a prompt the user keeps attaching) can earn the same offer with
that prompt in the role, which is where open question 1's prompt pays off.

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
the user roles, each a name field, an optional prompt field (open question 1), the three shared
controls (`ServiceSelector`, the model menu and the reasoning menu — all phase-6 shared pickers,
so docs/261 req 13 binds them by construction), a rename, a delete, and a *New role* row. User
roles are pinned by construction (a user created them), so the auto/pinned badge that the slots
carry applies to the built-in row only.

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
- **The prompt** (open question 1) adds a content surface: a role prompt is **user data** in the
  settings store — the same store as pins, no prompt-architecture change — and a text field on
  the Settings row. Its only real cost is that a role with a prompt invites the user to treat it
  as a custom agent definition, which is exactly the invitation the generalization intends.
- **The bare-role ranking still has a clean answer.** Under the recommended shape (user roles
  pinned), it is unchanged — the two slots, ranked, with nothing new to integrate.

## The pool question, reframed (open question 2)

The earlier frame's extend-vs-unify question survives, in the role vocabulary: **may a user role
carry auto (ShipIt-resolved) params?** "The params we have now" reads as pinned, and the
recommendation is pinned. If the human later wants auto roles, the pool generalization is
list-shaped already — but the earlier assessment holds and is worth repeating: the automatic pick
is a **distance ranking**, and the derived default is constructed to be distance-optimal, so an
auto user role would rarely win the automatic pick; the benefit would be one mental model ("all
roles can be auto") at the cost of docs/261's shipped two-slot shape. Not now.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the role list, `resolveRoleByName` (built-in + user), the settings payload carrying roles | 1, 2, 8, 9, 10 | A user role is stored, resolved and routed; an unknown role name is refused listing the known ones; nothing calls it yet |
| 2 | CLI: `--role NAME` for user roles, the shim's pass-through role check, exclusive with the ad-hoc flags | 2, 3, 4, 8 | `--role deep-dive` spawns that role; `--role NAME` + `--model`/`--effort` is refused in both shim and server |
| 3 | Chat-native creation: settings CRUD for roles, name validation, the Roles settings surface | 5, 1 | "Create a role `spec-check` = …" is a sentence the agent can act on; the tab shows and edits roles with the shared controls (and the prompt field, per open question 1) |
| 4 | Recurrence conversion: the agent-facing guidance and the propose-actions offer, cross-checked against consult `runOn` | 6, 7 | A second ask for the same combination produces an offer to save it as a role, with a one-click accept |

Open question 1's prompt rides phases 1 and 3 if the answer is yes; the pool question (open
question 2) is deliberately not in the table.
