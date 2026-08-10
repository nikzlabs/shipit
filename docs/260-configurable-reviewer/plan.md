---
issue: planning#349
title: Configurable reviewer — design
description: Two configured reviewers, ranked by distance from the implementer, reached by --role reviewer.
---

# 260 — Configurable reviewer: design

Implements [`requirements.md`](./requirements.md). Requirement numbers below refer to it.

## What this is

Today "get a second opinion" is assembled from two halves that do not know about each other:
a per-harness stored default (`SubAgentDefaults`, keyed by `AgentId`) supplies the model and
reasoning level, and the **agent** supplies the harness by writing `--agent codex`, because
`CLAUDE.md` tells it to. This feature makes the reviewer one configured thing (req 1) that
lives in ShipIt rather than in a repository (req 2), and reduces the agent's part to naming a
role (req 6).

The load-bearing simplification: **roles are the only implicit path.** Everything else a
spawned agent runs on is explicit at the call (req 7). That is what lets `SubAgentDefaults`
be deleted rather than re-keyed, and it is why there is no third place that answers "what
does a spawned agent run on".

## A reviewer is a model, not a harness

Req 3 keeps docs/252's direction: a reviewer names `(serviceId, billingMode, modelId)` plus a
reasoning level, and the harness is **derived**. This is not a new mechanism — it is the one
background work already uses, and the resolver is reusable as it stands:

- `harnessForNonTurnSelection(selection, credentials)` (`non-turn-model.ts:144`) returns the
  first installed harness that can run a selection, **and** follows docs/252 req 13's
  retirement successors, so a reviewer pinned to a retired model keeps working.
- `firstEligibleNonTurnSelection(credentials)` (`:169`) is req 8's derived default in the
  picker's own ordering — first service, first billing mode, first model.

Reasoning level is part of the reviewer (req 5) even though it is a property of the *harness*
(docs/252's 2026-08-08 receipt). That is consistent rather than contradictory: the harness is
known once the model is, so the Settings control offers the derived harness's levels. A level
the harness rejects is the harness's error to report, which is the corollary docs/252 already
recorded.

## Picking between the two: the distance ranking

Req 4 fixes the goal — the reviewer **furthest from the implementer** — and leaves the
ranking here. It is an ordered list of predicates, not a weighted score, because it has to be
explainable in one line to whoever reads the Settings screen:

Given the implementer's resolved `(harness, service, model)` and the configured reviewers in
user order, take the first reviewer satisfying the highest-priority predicate that any of
them satisfies:

1. different harness **and** different service — the ideal Nik named
2. different service
3. different harness
4. different model
5. otherwise the first configured reviewer

Service outranks harness at step 2 because the blind spot a second opinion exists to avoid
belongs to the model's vendor and training, not to the CLI that spawns it — a Claude Code
session driving DeepSeek shares nothing with Anthropic but the process it runs in. Step 3
still exists because a different harness is real independence when the service cannot differ.

A reviewer whose credential or harness has gone away is **skipped**, not selected and failed.
If neither reviewer resolves, the review does not run and says so — the same shape as
docs/252 req 9's dismissible notice, not a silent no-op.

**The ranking is computed against the implementer's *resolved* selection**, not the session's
stored pin: a session that failed over, or was remapped by a retirement, must be compared
against what it is actually running (docs/252 req 11).

## Defaults (req 8)

Both reviewers derive rather than naming a model:

- reviewer 1 — `firstEligibleNonTurnSelection`, unchanged.
- reviewer 2 — the same walk, skipping every model of reviewer 1's **service**. A small
  generalization of the existing helper (a `skipServiceId` parameter), not a second
  implementation.

If the install has only one service, reviewer 2 derives to nothing, the ranking falls to
step 5, and review runs on reviewer 1. That is the honest outcome for an install with one
credential, and it is visible in Settings rather than inferred.

## The CLI (reqs 6, 7)

`shipit agent run` gains `--role reviewer` and loses its stored defaults:

- `--role reviewer` — no `--agent`, `--model` or effort flag. Mutually exclusive with them;
  passing both is an invocation error, because a call that names a role *and* a harness is
  asking two different questions.
- `--agent X [--model M] [--effort E]` — unchanged in shape, but now the **only** source of
  those values. `--agent` stays required on this path, so today's callers keep working and
  an omitted flag stays a hard error rather than quietly becoming a review.
- The spawn reads `getAgentSubAgentDefaults` at `sub-agent.ts:285`; that read is replaced by
  the role resolution or by the explicit flags. The existing `fallbackModel` path (the
  harness's first eligible model) stays as what an unspecified model means.

`CLAUDE.md`'s "review with the other backend" line loses its harness instruction: it keeps
saying *when* to ask for a review, and stops saying *who* reviews (req 2).

## Settings

The audit (`../252-custom-models/ui-audit.md`, D16) found the per-vendor Claude/Codex tabs
uniquely held exactly one thing: `SubAgentDefaultsSection`. Req 7 deletes it, so:

- **`SubAgentDefaultsSection` is removed**, with `SubAgentDefaults` and its store, wire and
  route members (`credential-store.ts:1208`, `services/settings.ts:457`, the bootstrap and
  WS shapes).
- **`ClaudeTab` and `CodexTab` are removed**, and with them the `agent-claude` / `agent-codex`
  tabs and the "Agent" nav group (`Settings.tsx:23`, `:144-165`).
- **Services becomes the first tab and the default** (`Settings.tsx:68`), which is the audit's
  D1 and the complaint that started this.
- **A "Reviewer" tab** holds the two reviewers, each a model picker grouped by
  `(service, billing mode)` plus a reasoning select — the same control shape as
  `BackgroundWorkSection`, which is the closest existing precedent and already renders a
  derived default as a labelled option rather than a blank.

One consequence worth stating because it looks like a regression and is not: the API-key
panel on the vendor tabs disappears with them. It is not a loss — it writes through to the
same `(anthropic, key)` / `(openai, key)` credential route the Services add-flow writes
(`services/settings.ts:664`, `:634`), so the credential remains reachable, as a card.

## Phases

| # | Phase | Reqs | Done when |
|---|---|---|---|
| 1 | Storage + resolver: the two reviewer slots, the derived defaults, the distance ranking | 1, 3, 4, 5, 8 | Ranking and derivation are unit-tested against a fabricated catalogue; nothing calls them yet |
| 2 | `--role reviewer`, and the explicit-only `agent run` | 6, 7 | A review spawns on the ranked reviewer; `--agent X` still works; `SubAgentDefaults` is gone from the spawn path |
| 3 | Settings: the Reviewer tab, and the vendor tabs deleted | 1, 5 | Reviewer configurable in the UI; Services is first and default |
| 4 | `CLAUDE.md` and `shipit-docs` updated; attribution confirmed unchanged | 2, 9 | The repo rule names the role, not the backend |

Phase 3 also lands the audit's D1. The audit's other Services work — one card component
(D2) — is docs/252's and is deliberately **not** in this table; it touches
`ServicesPanel.tsx` / `ProviderAccountsCard.tsx`, which nothing here does, so the two can run
in parallel without conflicting.
