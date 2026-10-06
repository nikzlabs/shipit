---
title: Compose services must be able to write the workspace
description: Per-session UIDs made the workspace unwritable to every Compose service, and containment made a wrong `user:` mandatory. Services and agents must both work.
---

# Requirements

1. Compose services and the agent must both work. A session must not come up
   with broken services, and must not come up with a broken agent.

## Notes on scope

Requirement 1 is the whole requirement, stated at the level it was given. It is
not a statement about UIDs, groups, file modes, or validation rules — those are
mechanism, and the design in [plan.md](./plan.md) chooses them.

Three observed failures are what requirement 1 rules out. They are recorded here
as evidence, not as separate requirements:

- A project that declares no `user:` has its **whole compose file refused** in a
  contained session, so none of its services start.
- A project that declares a `user:` to satisfy that refusal gets services that
  **start but cannot write the workspace**, so any dev server that writes a
  cache fails with `EACCES`.
- A project that declares no `user:` gets services whose **home directory is
  `/`, which they cannot write** (found 2026-10-06, planning#638), so a dev
  server that keeps a file below `$HOME` does not start: the Astro template
  exits with `EACCES: permission denied, mkdir '/.config/astro'`.

## Resolved questions

- **2026-08-17 — How far should the fix go?** Asked whether to correct the
  platform or only unblock the ShipIt repo. Answer: the full platform fix, and
  the requirements should contain essentially one line — that the thing needs to
  work, with no broken services or agents. Requirement 1 is that line.
- **2026-10-06 — Repair the platform, or only the two templates that failed?**
  planning#638 gave both options. Answer, by approval of the follow-up action
  that proposed it: the platform repair — a service whose user ShipIt supplies
  has a writable home directory — with one constraint, that a project which
  declares its own `HOME` or its own `user:` keeps what it declared. Requirement
  1 already covers it; the constraint is recorded here because the design in
  plan.md §4c depends on it.
