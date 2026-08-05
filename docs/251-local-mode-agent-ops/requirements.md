---
title: The gh shim works in the dogfood inner ShipIt
description: Give RUNTIME_MODE=local an /agent-ops host so dogfood turns can open PRs and read CI, instead of hitting "gh: not found".
---

# Requirements — `gh` in the dogfood inner ShipIt

## Context

The dogfood inner ShipIt (`RUNTIME_MODE=local`, the `dev` Compose service) runs its
agent inside a container built from `docker/Dockerfile.dogfood`, which installs
neither the `gh` shim nor the `shipit` shim. A dogfood turn that tries to open a
PR gets `gh: not found` and reports that it cannot open one.

Asked for by Nik on 2026-08-05:

> why can't we support the gh shim in the dogfood shipit? Otherwise a whole
> branch of features can't be tested

## Requirements

1. In the dogfood inner ShipIt, an agent turn can open a pull request with
   `gh pr create`, and the PR appears on the session's real repository.
2. The rest of the PR surface the `gh` shim supports behaves the way it does in
   a normal session container: `pr view`, `pr list`, `pr status`, `pr edit`,
   `pr comment`, `pr ready`, `pr close`, `pr reopen`, `pr merge`.
3. The read-only GitHub Actions commands work the same way: `gh run list`,
   `gh run view`, `gh workflow list`, `gh workflow view`.
4. An operation that genuinely cannot work in the dogfood fails with a message
   that names the reason. Neither `gh: not found` nor a bare connection error
   is acceptable — the agent must be able to tell "unsupported here" from
   "broken".
5. An agent in one dogfood session cannot use these commands to read or act on
   a different session.
6. Real session containers are unaffected — same behavior, same security
   posture, no new reachable surface.

## Requirement provenance

Requirements 1–3 are the stated goal: the human named `gh` and named the
consequence (PR-shaped features cannot be tested in the dogfood loop).
Requirement 4 is the failure mode that prompted the investigation, restated as
a requirement. Requirements 5 and 6 are **preservation** requirements — they
assert that existing guarantees survive, and are not new asks. They are written
down because the obvious implementation (mounting `/agent-ops` on the
orchestrator keyed by a session id in the request path, which is the sketch in
SHI-303) would break requirement 5.

## Open questions

- **Should the `shipit` shim be installed alongside `gh`?** It shares the same
  missing plumbing, so it comes almost free — but unlike `gh` it would only
  work in part. `shipit issue`, `shipit release`, `shipit branch` and
  `shipit source` are relays and would work; `shipit service` needs a
  ServiceManager and local mode runs no Compose stacks; `shipit agent run`
  spawns a sub-agent. The human asked only about `gh`.

## Resolved questions

_(none yet)_
