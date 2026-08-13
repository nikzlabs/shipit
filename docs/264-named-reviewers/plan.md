---
issue: planning#363
title: Named reviewer configurations — design
description: Reusable named reviewers, invoked by name, converted from ad-hoc combinations.
---

# 264 — Named reviewer configurations: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

Today a reviewer is either **implicit** (`--role reviewer`, resolved from the two configured
slots — docs/261) or spelled out **ad hoc** per review (`--model NAME` / `--effort LEVEL` —
docs/263). The ad-hoc spelling is a *novelty*: it is spent the moment the review runs. This
feature gives the user a **named, reusable reviewer configuration** — a stored, named full
tuple — and makes invoking one by name at least as easy as spelling it out again (req 3).

The progression the product is built on:

| Invocation | What runs | Reusability |
|---|---|---|
| `--role reviewer` | the two ranked slots (docs/261) | none — always re-resolved |
| `--role reviewer --model X --effort Y` | that model, ad hoc (docs/263) | none — a novelty, spent |
| `--role reviewer --reviewer deep-dive` | the named configuration | yes — an asset, reusable |

The ad-hoc path is not removed, warned at, or made harder. It is the **on-ramp**: you cannot
save a reviewer you have not tried (req 5). Conversion is an **offer** at recurrence (req 6), a
chat-native sentence to save (req 4), and a one-word invocation thereafter (req 3) — never a
block.

## The shape decision: extend now, unify later

The one structural question the exploration had to answer: do named configurations join the
**implicit `--role reviewer` pool** (unify), or are they **explicit-only** (extend)?

**Recommendation: extend.** Named configurations are a separate, additive namespace invoked
explicitly by `--reviewer NAME`. The two slots stay exactly as docs/261 ships them — the
auto-ranking pool for the bare role. The storage and the resolution are designed **list-shaped**
so the unify fold is a small, well-scoped later change if the human wants it — but it is not
recommended now.

Three arguments, in the order they weigh:

**1. The smallest mechanism that produces the stated experience.** The stated experience
(reqs 1–7) is: create any number of named configurations, invoke by name, chat-native save,
recurrence offer, refusal of unknown names. All of it is additive — a named store, a name
lookup, a flag, a Settings section. None of it touches the two-slot machinery. docs/261 is
shipped and its phases are tested; reworking it for a soft benefit is the failure CLAUDE.md's
"build the smallest mechanism" exists to prevent.

**2. Unify's headline benefit is largely illusory.** The mission's rationale for unify was
"adding a config improves the auto-pick." It does not, in the common case. The bare-role pick is
a **distance ranking** (`reviewerDistanceTier`), and the *derived default* is constructed to be
distance-optimal — slot 2 is literally "the furthest routable thing from slot 1." A user-chosen
configuration is, by construction, chosen for reasons other than maximum distance. So a named
configuration beats the derived baseline on the bare-role pick only in the narrow case where it
happens to be more distant — which is exactly the case the baseline already covers. The
observable difference between extend and unify, on an install where the user has set up named
configurations, is close to zero for the automatic pick. The real value of unify is **one mental
model** ("the reviewer pool") instead of two ("the two auto slots" and "my saved presets") — a
soft, presentation-level benefit.

**3. Unify's cost is real and is mostly not mechanical.** It reworks docs/261's shipped storage
(two named slots → a pool), the settings payload and the Reviewer tab (two fixed slot cards → a
list), and the tests. The hard part is the **auto-complement semantics**: what derived members
remain in the pool once the user has named configurations, and when — the "always two" baseline
usually beats user configs on distance (so the fold's benefit stays invisible); "empty-pool only"
drops the never-self-review guarantee (docs/261 req 4) for a user with one configuration that is
their own model; and a runtime "derive only the distance gap" is the most complex of the three
and the least legible in Settings. None of those is a good trade for a benefit the user cannot
see. (§ "The unify option, assessed" below.)

The **presentation** can still lean unified without the mechanism: Settings renders all reviewers
— the two auto slots and the named list — in one tab, so the user sees one surface, and the tab
text states plainly that the automatic pick uses the two auto reviewers while named ones are
invoked by name. Same mechanism, same cost, most of the mental-model benefit.

## What a named reviewer is

A named configuration is exactly a **`ReviewerPin` plus a name** (req 1): `(serviceId,
billingMode, modelId, reasoningEffort)`. The harness is **derived** (req 8, docs/261 req 3),
never stored. The name is a single CLI-safe token — lowercase letters, digits and dashes
(kebab-case), so `--reviewer NAME` is a valid word and cannot collide with a flag
(`--reviewer --foo` is refused at parse). A name is unique per install; creating a duplicate is
a refusal, not a second meaning.

```
type NamedReviewerPin = ReviewerPin & { name: string }
```

**Why no harness, despite the original ask's harness axis** (open question 2): docs/261 settled
model-first for *all* reviewers after the human chose "unify on model-first" over harness-first.
A named configuration that could name a harness would be a second configuration axis with no
first-class status anywhere else — the reviewer settings, background work and the composer all
derive the harness. The recommendation is to hold that line; reversing it for named
configurations only would make the harness an afterthought a user could *add* but not otherwise
choose.

## Storage: list-shaped, alongside the slots

The two slots keep `getReviewerPin(slot)` / `setReviewerPin(slot, …)`. Named configurations are
a separate **ordered list** in the same credential store:

- `getNamedReviewers(): NamedReviewerPin[]`
- `setNamedReviewer(name, pin | null)` — upsert or delete
- `renameNamedReviewer(oldName, newName)`

Order matters only for a future tie-break (below), so it is insertion order and reorderable in
Settings as a nicety. Nothing about the slots changes.

## Resolution

`resolveReviewerByName(name, implementer, deps)` mirrors docs/263's model-name resolution, over
the named store instead of the catalogue:

1. Look `name` up in the named store. **Unknown → `ServiceError` listing the known names** and,
   because a reviewer name and a model label are two name-spaces, a hint that `--model` is the
   flag for a model (req 7).
2. Resolve the pin exactly as a pinned slot resolves today: eligibility + **usable route**
   (`firstRoutable`, the *Eligible is not runnable* rule), harness derived preferring one that is
   not the implementer's, effort = the pin's level (the level was validated at save against the
   settings-time harness; the latent dual-harness caveat recorded in docs/261 phase 3 applies
   unchanged).
3. Freeze the target with `source: "named"`, no slot, carrying the name for the log line. The
   consult card's `runOn` reports the resolved tuple, as phase 4 already does for every review
   (req 9).

A named configuration whose credential or harness has gone away is `pin_unavailable`, exactly as
a pinned slot is today — it is skipped by nothing (it is invoked explicitly), so the refusal
says *why* and points at Settings.

## The CLI (reqs 2, 3, 7)

`--role reviewer` may carry `--reviewer NAME`, sitting beside docs/263's `--model NAME` and
`--effort LEVEL`:

```
shipit agent run --role reviewer --reviewer deep-dive --prompt-file - <<'EOF'
…
EOF
```

**Mutual exclusion, mirroring docs/261's role-vs-explicit refusal.** `--reviewer` names a
complete configuration (req 1), so combining it with `--model` or `--effort` is asking two
questions at once — "run my saved configuration" and "spell a reviewer out" — and is refused
(open question 3, recommendation no). The three flags that name a reviewer ad hoc are
`--model`, `--effort` and `--service`/`--billing-mode`; `--reviewer` replaces the whole group.

The shim parses `--reviewer`, rejects the combination, and sends `{ role: "reviewer", reviewer:
"deep-dive" }`; the server's `parseSubAgentSpawnTarget` enforces the same shape again (the shim
buys the message, the server is the authority — the same split docs/261 phase 2 records). The
**agent passes the user's word verbatim** (req 2): the shim and the system prompts treat
`--reviewer NAME` as a value to relay, never a choice to make.

## Chat-native creation (req 4)

"Save a reviewer called `deep-dive` = GPT-5.6 at high effort" is a sentence. The agent performs
it: it reads the current settings (the named list, the eligible models, the harnesses' reasoning
options), validates what the user named, and writes via a settings API. The server is the
authority on the write, reusing `resolveReviewerPinPatch` **verbatim** — a named configuration is
a `ReviewerPin` plus a name, and that function already validates a triple against the catalogue
and the level against the *derived* harness, completing the tuple when the level is omitted.

The settings surface gains the named list:

- `PUT /api/settings` carries `namedReviewers` alongside `reviewers` (create / edit / rename /
  delete as a patch — the same whole-payload shape the slot pins use, so the *server sends the
  resolution* rule and the `agent_list` rebroadcast hold for the list exactly as they do for the
  slots).
- The payload carries each named configuration **resolved** — name, pin, and what it resolves to
  today — so Settings renders the same state the reviews run, and the agent can name it in a
  refusal.

Name validation lives server-side (kebab-case token, length bound, uniqueness), and a name the
user chooses that collides with nothing is accepted as given — the user owns the word.

## Recurrence conversion (req 6)

The mechanism is the **propose-actions pattern**, and the trigger is the **agent's own
judgement** (open question 4, recommendation). The agent is the courier of every reviewer
request, so it is the only surface that can see "the user has asked for GPT-5.6 at high effort
twice." When it recognizes a recurrence — a `--model NAME --effort LEVEL` combination the user
has asked for before — it offers, at the end of the turn, to save it as a named configuration;
the offer's payload is the exact `shipit` command (or settings write) that creates it, so
accepting costs the user one click.

Two design notes:

- **Recurrence is observed from the conversation the agent already has**, cross-checked against
  the consult cards' `runOn` tuples (phase 4 persists `(model, effort)` on every card). The agent
  does not need a new store or a server-side detector — that would duplicate, in a place that
  cannot act, a sight the agent already has.
- **The offer is never required and never interrupts.** An offer is a card at a turn boundary;
  the review itself is unaffected. Declining is the end of it — conversion is the mechanism, not
  prohibition (req 5).

## The Settings tab

The Reviewer tab gains a **Named reviewers** section below the two slot cards: the named list,
each row a name field, the three shared controls (`ServiceSelector`, the model menu and the
reasoning menu — all phase-6 shared pickers, so req 13 of docs/261 binds them by construction), a
rename affordance, a delete, and a *New reviewer* row. Named configurations are pinned by
construction (a user created them), so the auto/pinned badge that the slots carry does not apply
to them — the state line instead names what each resolves to, exactly as a pinned slot's does.

Nothing here is optimistic, for the same reason the slots are not: the server sends the
resolution and the response replaces the whole list, because nothing is safe to guess in the
browser.

## Cost assessment, honestly

The mission asked for the costs named, not assumed. Each, and what this design does about it:

- **Stored state with staleness.** A named configuration pinned to a retired model, a removed
  service or a spent credential is stranded — the exact failure docs/261's `pin_unavailable`
  machinery exists for. Reused wholesale: retirement resolves through the successor (docs/252
  req 13) where the catalogue offers one, and a configuration that cannot run is *refused with a
  reason and a pointer to Settings*, never silently replaced.
- **Unbounded-list management.** Create, edit, rename, delete, order. The CRUD is four routes of
  an existing settings surface; the tab is a list rendering shared controls. **There is no
  "default reviewer" flag** — the automatic pick is the distance ranking's, not a user setting —
  so the list management is lighter than it first looks. Order matters only for a future
  tie-break.
- **A second name-space.** Reviewer names and model labels are two lookup tables. They cannot
  collide at the flag level (`--reviewer` and `--model` are distinct), and the unknown-name
  refusal names the known set and points at `--model` for a model (req 7), which turns the
  ambiguity into a one-shot learning moment.
- **The bare-role ranking still has a clean answer.** Under extend, it is unchanged — the two
  slots, ranked, with nothing new to integrate. That is the whole point of choosing extend now.

## The unify option, assessed

For the record, what the fold would cost and buy, since the mission asked for the assessment:

- **Cost:** rework docs/261's shipped storage (two named slots → a pool), the settings payload,
  the Reviewer tab (two fixed cards → a list view of the pool), and the phase tests. The hard
  part is the **auto-complement**: the derived default that guarantees the never-self-review
  promise (docs/261 req 4) and the works-with-no-config promise (req 8). Three shapes, each
  wrong in its own way — "always two derived members" makes user configurations invisible to the
  auto-pick (they lose every distance comparison to a baseline built to win them); "derive only
  when the pool is empty" drops the never-self-review guarantee the moment the user saves a
  single configuration that is their own model; "derive only the distance gap at runtime" is the
  most complex and the least legible in Settings.
- **Buy:** one mental model ("the reviewer pool") instead of two, and the narrow cases where a
  user-chosen configuration is genuinely the most distant thing available. The observable change
  to the automatic pick is, in the common case, none.
- **Verdict:** not now. The presentation (§ "The shape decision") captures most of the mental
  model; the mechanism stays extend; the fold is a small later change because the storage is
  list-shaped and the ranking already iterates a list of plans.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolution: the named list, `resolveReviewerByName`, the settings payload carrying named configurations | 1, 7, 8, 9 | A named configuration is stored, resolved and routed; an unknown name is refused listing the known ones; nothing calls it yet |
| 2 | CLI: `--reviewer NAME` through the shim and the spawn edge, exclusive with the ad-hoc flags | 2, 3, 7 | `--reviewer deep-dive` spawns that configuration; `--reviewer` + `--model`/`--effort` is refused in both shim and server |
| 3 | Chat-native creation: settings CRUD for the named list, name validation, the Reviewer tab's named section | 4, 1 | "Save a reviewer called `deep-dive` = …" is a sentence the agent can act on; the tab shows and edits the list with the shared controls |
| 4 | Recurrence conversion: the agent-facing guidance and the propose-actions offer, cross-checked against consult `runOn` | 5, 6 | A second ask for the same combination produces an offer to save it, with a one-click accept |

The unify fold (open question 1) is **not** in the table. If the human wants it, it is a fifth
phase whose design is § "The unify option, assessed" and whose storage and ranking this design
kept list-shaped on purpose.
