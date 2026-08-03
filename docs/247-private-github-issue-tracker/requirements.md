# Private GitHub issue tracker — product requirements

1. ShipIt must be able to use GitHub Issues in a dedicated private GitHub repository as an issue tracker.
2. The tracker repository must be separate from ShipIt's public source repository, and issue data must remain private to people and integrations granted access to that repository.
3. The tracker must be usable without a paid subscription.
4. The private-GitHub option must support every capability classified **Required** in the [issue-tracker product requirements](../246-native-issue-tracker-evaluation/requirements.md). Capabilities classified **Optional** may be absent, but each gap must be explicit in the design and UI rather than silently failing.
5. ShipIt must remain the primary issue-tracker surface for users and agents. GitHub's issue UI may be an administrative escape hatch, not a required step in the normal workflow.
6. No issue operation may silently target the active code repository when the configured tracker repository or an explicitly qualified issue pointer names a different repository.
7. The private planning tracker must coexist with ShipIt's public GitHub issue tracker. Issues reported by ShipIt users, including reports created through ShipIt's existing bug-reporting flow, continue to use the public ShipIt repository; the dedicated private repository is for the owner's private planning work.

## Open questions

- Choose the binding scope: one private tracker repository for the ShipIt deployment, or a separate tracker repository per ShipIt Project.
- Choose repository provisioning: select an existing private repository for the first release, or also let ShipIt create and initialize one.
- Choose what public code-repository PR bodies may disclose: use bare tracker issue numbers resolved through ShipIt's private binding, or permit fully qualified private-repository pointers such as `owner/private-repo#42` to appear publicly.

## Resolved questions

- 2026-08-02 — The user selected a dedicated private GitHub repository as an option worth designing separately from the broader native/open-source tracker evaluation.
- 2026-08-02 — The repository may be hosted on GitHub, but it must not be ShipIt's public source repository.
- 2026-08-02 — The tracker must be private, free without a subscription, and provide every current ShipIt wrapper capability that the user ultimately classifies as Required.
- 2026-08-03 — The user distinguished two coexisting uses: public issues reported by ShipIt users remain in the public ShipIt repository, including the existing in-product bug-report flow; the dedicated private tracker is for the owner's planning work. The private binding therefore does not replace public GitHub Issues.
