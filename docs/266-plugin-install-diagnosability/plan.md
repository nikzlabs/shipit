---
issue: planning#393
title: Plugin install diagnosability and forced re-install — design
description: How `shipit plugin status`, the refresh warning line, and `refresh --force` are built, and why each reuses machinery that already exists.
---

# Plugin install diagnosability and forced re-install — design

Implements [requirements.md](requirements.md). Requirements are cited as
`(req N)`; nothing here is a requirement that is not there.

## The shape of the problem

Everything the reporter needed already exists somewhere. Verified on
2026-08-16, and the reason this is three small changes rather than a subsystem:

| The fact | Where it lives today | Why a session cannot read it |
|---|---|---|
| "this version is active but was not installed" | the live generation's `manifestWarnings` (`plugin-generations.ts`) | reaches the Plugins card and the tab's HTTP snapshot only — deliberately not the refresh row, which carries this round's own warning |
| a failed install's output tail | the activation outcome's `reason` (`plugin-install.ts` `logTail`) | returned to the round that failed; a session opening onto an already-broken version has no round of its own |
| a withheld command, a rejected fragment, a settings mismatch | the same snapshot the card renders | the tab is a browser surface; `shipit plugin` has `refresh` and `exec` |
| "run the install again" | nothing | `activateGeneration` returns `unchanged` before staging when the resolved commit is the live one |

So: one **read** surface that reports what the card knows (reqs 1, 2, 9, 10),
one **durable** record for the install outcome that no generation survives to
carry (reqs 3, 4), one line in refresh's existing output (req 7), and one flag
that skips exactly one short-circuit (reqs 5, 6).

## 1. `shipit plugin status [name] [--json]` (reqs 1–4, 9, 10)

A read. It fetches nothing, activates nothing, and changes nothing that is live
— the property the browser snapshot GET already has, and the reason `status` is
not a flag on `refresh`.

**It reuses the tab's snapshot builder rather than defining a second notion of
"degraded"** (req 10). `api-routes-plugin-repos.ts` assembles credentials, host
reach, compose fragments, settings and command verdicts into
`buildPluginReposSnapshot`; that body is extracted into one helper both routes
call, so a reason that appears on the card cannot fail to appear here. A second
implementation would drift, and the drift would be invisible from exactly the
side that needs it.

Surface: `GET /api/sessions/:id/plugin/status`, `containerAccessible: true`
(orchestrator routes are default-denied to containers; the guard's session
scoping is what stops one session reading another's). Relayed by the worker's
`/agent-ops/plugin/status`, like refresh and exec.

The shim prints one block per declared repository: the declared ref, the live
commit, the last install's outcome, and every issue the card would show. `--json`
emits the same object for a machine reader. The docstring in
`agent-shim/shipit-plugin.ts` that says a `status` verb "was reviewed out of the
design" is corrected in place: it is true that the tab answers "what is live",
and this issue is the case that was missed — a session cannot read the tab, and
the version the reporter had to diagnose was degraded in a way only the tab
showed.

## 2. The durable last-install record (reqs 3, 4)

A failed install publishes no generation, so there is nowhere on the generation
to record it — which is why the reporter's session could see nothing. The
install runner writes `plugins/<repo>/last-install.json` beside the generations
root, on every terminal path, holding: the commit, the timestamp, one of
`succeeded | failed | skipped-stamp | skipped-store | not-run`, and the detail
string the round would have reported (`exited 1` plus the log tail, bounded as
`logTail` already bounds it).

It is written by the install runner rather than by the activation round because
the two "skipped" outcomes are decisions the runner makes and the round never
sees: an install skipped by the stamp and one skipped by a shared-store hit are
both `ok: true`, and telling them apart from a real run is precisely the
question the reporter could not answer.

Two things it deliberately does NOT record, both named because "every terminal
path writes a record" was an overclaim in the first draft (review finding).
A repository whose exports declare no install writes nothing — the absence is
the honest answer, and it is rendered as an absence with both of its causes
named rather than as "fine". And the record is the last attempt **for the
repository**, which is not necessarily the version that is live: a failed
refresh to B leaves A serving, so every reader compares the record's commit
against the live one before drawing a verdict from it (`describesLive`).

It is **per repository, not per generation**, and last-writer-wins: the question
is "what happened the last time ShipIt tried to install this repository", and a
record keyed by a generation that was never published cannot answer it.

## 3. The refresh warning line (req 7)

`services/plugin-refresh.ts` builds each row from this round's own outcome.
A second field is added — the live version's own degradation — so a refresh that
finds nothing to do still says the live version is not usable. It has **two**
sources, and needs both: the generation record's `manifestWarnings` carry
"active but not installed", and the durable install record carries a FAILED
install for the live commit, which no generation can carry because the round
that failed published none. Reading only the first left a plain refresh silent
after a failed forced retry (review finding). The exit code is unchanged: a
round that did what it was asked exits 0 (user, 2026-08-16), and the shim
already exits non-zero when a row's own status is `failed`.

## 4. `shipit plugin refresh <name> --force` (reqs 5, 6)

**It skips exactly one thing: the "already live" short-circuit.** Everything
after that is the ordinary round — stage, install, validate, publish, swap,
prune — so every property the subsystem already has holds unchanged.

The safety that makes this possible is `plugin-leases.ts`, which the re-stage
path already takes before it clears anything:

- the deletion claim **refuses** while any consumer holds this generation (a
  plugin service container, an in-flight companion CLI), so a force cannot pull
  a tree out from under a running container — it reports "still in use" and
  changes nothing;
- while the claim is held, `holdGeneration` returns `null`, so no NEW consumer
  can mount the version mid-round;
- the claim removes the runtime overlay volume, which is what lets the rebuilt
  layer be picked up: the volume is named per `(session, repo, commit)`, so
  without that removal a forced re-install would leave every consumer attached
  to the old one.

That last point is why force needs no new generation identity. An earlier
sketch gave a forced re-install its own generation id so it could stage
alongside the live one; it was dropped because it would have had to thread that
id through the generation directory, the work directory, the install stamp and
the overlay volume name — four keyed paths — to buy a property the deletion
claim already provides.

**Force also bypasses the install runner's two shortcuts**, or it is not a
retry: the install stamp (`recorded.stamp === stamp` → "install already done")
and the shared dependency store's `adoptPluginDepBases` hit (mount the store's
tree, run nothing). Both are correct for an ordinary activation and both would
make `--force` a no-op that reports success — the exact failure this feature
exists to stop.

**What force costs, stated because a consumer has to be able to weigh it.**
`prepareLayer` clears the writable layer before the install writes, so a forced
round that then fails leaves the version live with its install output gone —
or, precisely, replaced by whatever the failed attempt wrote before it died
(review finding; an earlier draft said only "without its install output"). That
is the state the consumer was already in or slightly worse, they are forcing
because the version is unusable, it is recorded in the last-install record from
§2, and every later refresh row says it. It is not a silent downgrade, and
`--force` is refused without an explicit repository name so it can never be a
blanket retry across every declared repository.

**The publish window had to change for this, and that is a real edit to a path
every activation takes** (review finding). Publish was `rm(finalDir)` then
`rename(staging, finalDir)`. For an ordinary round `finalDir` is absent or a
leftover, so the order did not matter; under force it IS the live generation,
and a recursive `rm` of a large checkout leaves `active` pointing at a
directory being emptied for seconds. A crash there left the repository with
NOTHING live — worse than the documented cost. It is now rename-aside,
rename-into-place, then delete: the gap is between two renames on one
filesystem, and a failed second rename puts the live version back. A leftover
`.replaced-*` is not a SHA, so the existing prune sweeps it.

## Key files

| File | Change |
|---|---|
| `session/agent-shim/shipit-plugin.ts` | `status` verb, `--force` flag, rendering, corrected docstring |
| `session/agent-ops-routes.ts` | `/agent-ops/plugin/status`; `force` on the refresh relay |
| `orchestrator/api-routes-plugin-repos.ts` | `GET /api/sessions/:id/plugin/status`; snapshot assembly extracted for reuse |
| `orchestrator/services/plugin-status.ts` (new) | the agent-shaped projection: live version, last install, issues |
| `orchestrator/plugin-install-record.ts` (new) | write/read `last-install.json` |
| `orchestrator/plugin-install.ts` | write the record on every terminal path; honour `force` |
| `orchestrator/plugin-generations.ts` | `force` skips the already-live short-circuit and reaches the install job |
| `orchestrator/services/plugin-activation.ts`, `plugin-refresh.ts` | thread `force`; add the live-degradation field to each row |
| `shipit-docs/plugins.md` | the two verbs, what force costs, and what a consumer does with a broken version |
