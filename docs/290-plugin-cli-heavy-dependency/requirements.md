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

All three numbered requirements are the user's own words, dated above.

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
   session that uses it.
3. The plugin stays **self-contained**: the plugin repository alone carries
   what its CLI needs. Consuming it requires no separately published artifact
   and no action from whoever operates the ShipIt instance.

## Open questions

- **Does requirement 2 bind the first session on a host?** Something must pay
  the download or the build once. The agent reads "a new session" as *any
  session after the first on that host*, so the first one may take minutes.
  Is that the intended reading, or must even the first session be cheap?
- **Does requirement 2 hold across a plugin refresh of an existing session?**
  The requirement names a new session. A plugin repository commits often, and
  `shipit plugin refresh` moves a *running* session to a new commit. If the
  dependency itself did not change, must that refresh also cost close to zero?

## Resolved questions

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
