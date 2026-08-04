# Projects — product requirements

This feature predates ShipIt's requirements-document workflow. This file records human-owned requirements added after the original design; the existing `plan.md` remains the record for earlier design decisions until they are separately restated by the user.

1. Additional GitHub issue trackers are declared per repository in `shipit.yaml` (see [doc 247](../247-private-github-issue-tracker/requirements.md) req 5), so Projects need no tracker binding of their own and no phase-1c work for one. A declaration is already scoped by the repository that carries it; a Project's sessions see the trackers declared by their own repositories and no others.
2. The private planning tracker remains distinct from ShipIt's public user bug tracker. Project scoping must not redirect the existing in-product bug-report flow away from the public ShipIt repository.
3. A declared tracker uses the same GitHub credential as that Project's other GitHub operations. GitHub enforces whether the credential can access the repository; ShipIt does not add a separate per-viewer tracker ACL or repository-membership check. Anyone who can use the Project can therefore operate on its declared trackers through ShipIt regardless of their personal GitHub membership.
4. A declared tracker does not replace the GitHub Issues tracker of any code repository in that Project. Code-repository issues continue to use their own repository; the fixed public ShipIt bug-report destination remains specific to ShipIt product reports.

## Open questions

None for these added requirements.

## Resolved questions

- 2026-08-04 — The user specified that the private GitHub planning tracker is deployment-wide before Projects exists and becomes per Project when the Projects feature ships. This requirement is shared with [doc 247](../247-private-github-issue-tracker/requirements.md).
- 2026-08-04 — Superseded: the user moved tracker declarations into each repository's `shipit.yaml`, so no deployment-wide binding exists to scope. Projects inherit the scoping for free and phase 1c gains no tracker work.
- 2026-08-04 — Public issues reported by ShipIt users remain in ShipIt's public repository; Project-private planning bindings coexist with that public destination rather than replacing it.
- 2026-08-04 — The user specified that private tracker access uses the same GitHub token as other GitHub operations and that GitHub, rather than ShipIt, enforces repository access.
- 2026-08-04 — The user clarified that code repositories keep their own GitHub Issues trackers. A Project's private planning tracker is an additional destination, while the fixed public bug-report destination is available only for ShipIt product reports.
