# Private GitHub issue tracker — product requirements

1. ShipIt must be able to use GitHub Issues in a dedicated private GitHub repository as an issue tracker.
2. The tracker repository must be separate from ShipIt's public source repository, and issue data must remain private to people and integrations granted access to that repository.
5. ShipIt must remain the primary issue-tracker surface for users and agents. GitHub's issue UI may be an administrative escape hatch, not a required step in the normal workflow.
6. No issue operation may silently target the active code repository when the configured tracker repository or an explicitly qualified issue pointer names a different repository.
7. The private planning tracker must coexist with ShipIt's public GitHub issue tracker. Issues reported by ShipIt users, including reports created through ShipIt's existing bug-reporting flow, continue to use the public ShipIt repository; the dedicated private repository is for the owner's private planning work.
8. Until ShipIt Projects is implemented, one private planning tracker is configured for the deployment and is available from sessions working in any of the owner's ShipIt-related private code repositories. When [Projects](../231-projects/plan.md) is implemented, the private tracker binding becomes per Project, consistently with that feature's rule that every user-visible tracker binding belongs to exactly one Project.
9. The user creates the private GitHub repository. ShipIt connects to the existing repository and does not create or initialize it.

## Open questions

- Confirm whether public code-repository PR bodies may contain fully qualified private-tracker pointers such as `owner/private-repo#42`. This is the simplest unambiguous routing syntax, but it exposes the private repository owner/name, the referenced issue number, and the existence of that planning issue in the public PR and its edit history. Readers without repository access cannot inspect the issue. Bare numbers disclose less but are ambiguous between the public bug tracker and private planning tracker; an opaque ShipIt pointer would require additional mapping machinery.

## Resolved questions

- 2026-08-02 — The user selected a dedicated private GitHub repository as an option worth designing separately from the broader native/open-source tracker evaluation.
- 2026-08-02 — The repository may be hosted on GitHub, but it must not be ShipIt's public source repository.
- 2026-08-02 — The initial focused requirements included free/no-subscription and classified wrapper parity. The user superseded both on 2026-08-04: GitHub's cost and feature set are accepted assumptions for this design rather than implementation gates.
- 2026-08-03 — The user distinguished two coexisting uses: public issues reported by ShipIt users remain in the public ShipIt repository, including the existing in-product bug-report flow; the dedicated private tracker is for the owner's planning work. The private binding therefore does not replace public GitHub Issues.
- 2026-08-04 — The user removed the free/no-subscription requirement from this focused design because GitHub Issues already satisfies it. The broader option comparison may still record current pricing as evaluation context.
- 2026-08-04 — The user removed capability-set selection from this focused design. Choosing GitHub Issues is assumed, so this feature accepts GitHub's feature set instead of gating the implementation on a separately classified parity list.
- 2026-08-04 — The private tracker is deployment-wide initially so sessions for the owner's ShipIt-related private repositories can share it. The existing Projects design later makes the tracker binding per Project; “workspace” is not introduced as a second scope term.
- 2026-08-04 — The user will create the private repository, including the one used for ShipIt itself. ShipIt only connects an existing repository, avoiding repository-creation permissions and provisioning behavior.
- 2026-08-04 — Fully qualified private-repository pointers are the simplest proposed PR syntax. The decision remains open until the user accepts or rejects the public metadata disclosure recorded above.
