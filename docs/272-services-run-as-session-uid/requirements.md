---
title: Compose services run as the session identity
description: Follow-up to docs/271 — group-write let a foreign-uid service write, but not run git, and never reached the dependency directories.
---

# Requirements

1. Compose services and the agent must both work. A session must not come up
   with broken services, and must not come up with a broken agent.

## Notes on scope

Requirement 1 is carried over verbatim from
[docs/271](../271-compose-workspace-writability/requirements.md). It is the same
requirement, still not met — this feature is the part of it docs/271 left open,
not a new ask.

Two observed failures, both from a session running docs/271:

- The dogfood inner orchestrator, running as a declared `user: "1000:1000"`,
  failed on every git repository in its own state dir: `fatal: detected dubious
  ownership in repository at /workspace/.inner-shipit/marketplace-cache/…`, owned
  by 2000006, mode 2775. It could *write* the tree and still could not use it.
- A dev server in another repository: `EACCES: permission denied, mkdir
  '/app/node_modules/.vite/deps_temp_…'`.

## Resolved questions

- **2026-08-17 — Is group-write enough for a foreign-uid service?** Answered by
  the first failure above rather than by a person: no. `safe.directory` is an
  ownership check, so no mode can satisfy it. Requirement 1 therefore needs
  services to run as the session identity, not merely to be able to write.
