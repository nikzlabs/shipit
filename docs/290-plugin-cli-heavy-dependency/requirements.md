---
issue: planning#510
title: A plugin CLI can carry a heavy dependency
description: A companion CLI can depend on hundreds of megabytes of tooling while a new session on the consuming project pays close to nothing in disk or install time.
---

# A plugin CLI can carry a heavy dependency — requirements

Human-owned. Numbered statements are what the feature must do, in the user's
terms — observable outcomes, never mechanism. Gaps the agent had to fill live
under **Open questions** until a human answers them.

## Context, in the user's words

The user wants a plugin that gives an agent Blender, so the agent can design 3D
models. Blender is roughly a gigabyte of tooling. The plugin should be
**self-contained** (2026-09-05): the plugin repository alone carries what it
needs, and adding it to a project should not require publishing a second
artifact or asking whoever operates the ShipIt instance to do anything.

Shown a recipe that installs the dependency through the plugin's `install:`
step, the user's objection was the cost: *"this cost is paid for every session,
time and disk"* (2026-09-05). That objection is what this feature exists to
answer, and it generalises past Blender — the requirements below are about any
heavy dependency, not about one tool.

## Requirement provenance

All four numbered requirements are the user's own words, dated above.
Requirement 4 came from a direct answer to an open question, with its receipt
below.

**On the number 4.** An earlier draft used it for an observability statement the
agent had derived. That statement was demoted to an open question and then
scoped out to planning#511 before any implementation cited it, so the number is
reused here deliberately rather than left as a gap.

Two things the agent supplied are deliberately **not** requirements:

- Whether a plugin author is told when the near-zero property is not in effect.
  An earlier draft made this requirement 4 on the reasoning that a cost
  guarantee nobody can observe cannot be relied on. That reasoning is the
  agent's, so it went under Open questions instead — and the user then ruled it
  a separate bug (planning#511). It is not part of this feature.
- `why not dockerfile?` and `could a CLI just run inside one of the services
  defined in the docker compose?`, both asked by the user on 2026-09-05. They
  are candidate **mechanisms**, and they are weighed as such in
  [plan.md](plan.md). Promoting either here would make the design its own
  source of requirements.

One open question was **withdrawn** rather than answered: an earlier draft asked
whether a heavy dependency may require system packages. Requirement 1 already
classifies that case — a dependency needing `apt` is exactly one "the
session-worker image does not already carry" — so the question asked the user to
narrow their own requirement. It is recorded here rather than deleted silently,
because it changed the design's conclusion when it went away.

## Requirements

1. A plugin's companion CLI can depend on a **heavy** dependency — one that is
   too large to fetch per call, and that the session-worker image does not
   already carry.
2. Opening a **new session** on a project that declares such a plugin costs
   close to zero in **disk** and close to zero in **install time**. The
   dependency is not re-fetched, and it is not stored a second time, for each
   session that uses it. This binds **every session after the first** on a given
   host; the first session may pay the full cost once.
3. The plugin stays **self-contained**: the plugin repository alone carries
   what its CLI needs. Consuming it requires no separately published artifact
   and no action from whoever operates the ShipIt instance.
4. Moving an **already-running session** to a new plugin commit — a
   `shipit plugin refresh` — also costs close to zero when the heavy dependency
   itself did not change. A plugin repository commits often, and an ordinary
   commit must not make a session re-fetch or rebuild what it already has.

## Open questions

None open.

## Resolved questions

- 2026-09-05 — Asked whether requirement 2 holds across a `shipit plugin
  refresh` of an already-running session, when the plugin commits but its heavy
  dependency does not change. The user's answer: **yes**. Recorded as
  requirement 4. The constraint it carries is sharp: whatever identifies the
  delivered dependency must be keyed to the **dependency's own content**, not to
  the plugin commit — a commit-keyed identity would rebuild or re-fetch on every
  ordinary commit, which is exactly what this requirement forbids.
- 2026-09-05 — Asked whether requirement 2 binds the first session on a given
  host, which must pay the download or build once. The user's answer: **"No,
  only 2+ session."** Requirement 2 now says so. The constraint it carries: a
  mechanism may cost minutes on first use, so a design is not disqualified by a
  cold build — only by a cost that recurs per session.
- 2026-09-05 — Asked whether a plugin author should be told when the near-zero
  cost property is not in effect. The user's answer: **that is a separate bug**,
  not a requirement of this feature. Filed as **planning#511** and scoped out
  here. The constraint it carries: this feature is about *delivering* a heavy
  dependency cheaply, and the existing store's silence about its own
  applicability is fixed independently of it.
- 2026-09-05 — Asked whether a heavy plugin dependency may be delivered as a
  pre-published container image the plugin names. The user's answer was
  **self-contained** ("I want a plugin with blender support to be
  self-cotained"), which is recorded as requirement 3. A pre-published image
  therefore does not satisfy this feature.
