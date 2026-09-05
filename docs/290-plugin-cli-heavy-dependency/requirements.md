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
answer, and it generalises past Blender — the requirement below is about any
heavy dependency, not about one tool.

## Requirement provenance

Requirements 1–3 are the user's own words, dated above. Requirement 4 is
**derived** by the agent from requirement 2 and is marked as such: a cost
guarantee that cannot be observed cannot be relied on. It is listed as a
requirement rather than an open question because it states an outcome, not a
mechanism — but its provenance is the agent, and a human may strike it.

`why not dockerfile?` and `could a CLI just run inside one of the services
defined in the docker compose?` were both asked by the user on 2026-09-05.
Neither is recorded as a requirement: they are candidate **mechanisms**, and
they are weighed as such in [plan.md](plan.md). Promoting either one here would
make the design its own source of requirements.

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
4. *(Derived — see provenance above.)* A plugin author can **tell** whether
   requirement 2 is in effect for their plugin. When the near-zero property
   does not apply, that is reported, not silent.

## Open questions

- **Does requirement 2 bind the first session on a host?** Something must pay
  the download or the build once. The agent reads "a new session" as *any
  session after the first on that host*, so the first one may take minutes.
  Is that the intended reading, or must even the first session be cheap?
- **May a heavy dependency require system packages?** Blender turned out to be
  installable with `pip` as an unprivileged user (measured — see plan.md), so it
  needs no root and no `apt`. A dependency that needs `apt-get` cannot be
  installed this way at all, and that single fact decides whether this feature
  needs a container image or not. Should the design cover the `apt` case, or is
  a language-level package manager enough?
- **Must each CLI call get a fresh container?** Today it does: a call gets its
  own container, its own `/tmp`, and nothing survives between calls. Reusing a
  long-lived container would make calls cheaper and would let them share
  in-memory state — and would also let one call leave state that changes the
  next. Which does the user want?
- **Must the near-zero property survive a plugin commit that does not change
  the dependency?** Requirement 2 names a new session. A plugin repository
  commits often, and a new commit is a different question from a new session.

## Resolved questions

- 2026-09-05 — Asked whether a heavy plugin dependency may be delivered as a
  pre-published container image the plugin names. The user's answer was
  **self-contained** ("I want a plugin with blender support to be
  self-cotained"), which is recorded as requirement 3. A published image is not
  ruled out as an intermediate step, but it does not satisfy requirement 3 on
  its own.
