# Projects — product requirements

This feature predates ShipIt's requirements-document workflow. This file records human-owned requirements added after the original design; the existing `plan.md` remains the record for earlier design decisions until they are separately restated by the user.

1. When Projects is implemented, each Project has its own private planning issue-tracker binding. Sessions and repositories in that Project use its binding and do not read or mutate another Project's private planning issues.
2. The private planning tracker remains distinct from ShipIt's public user bug tracker. Project scoping must not redirect the existing in-product bug-report flow away from the public ShipIt repository.

## Open questions

None for these added requirements.

## Resolved questions

- 2026-08-04 — The user specified that the private GitHub planning tracker is deployment-wide before Projects exists and becomes per Project when the Projects feature ships. This requirement is shared with [doc 247](../247-private-github-issue-tracker/requirements.md).
- 2026-08-04 — Public issues reported by ShipIt users remain in ShipIt's public repository; Project-private planning bindings coexist with that public destination rather than replacing it.
