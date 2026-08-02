# Private GitHub issue tracker — product requirements

1. ShipIt must be able to use GitHub Issues in a dedicated private GitHub repository as an issue tracker.
2. The tracker repository must be separate from ShipIt's public source repository, and issue data must remain private to people and integrations granted access to that repository.
3. The tracker must be usable without a paid subscription.
4. The private-GitHub option must support every capability classified **Required** in the [issue-tracker product requirements](../246-native-issue-tracker-evaluation/requirements.md). Capabilities classified **Optional** may be absent, but each gap must be explicit in the design and UI rather than silently failing.
5. ShipIt must remain the primary issue-tracker surface for users and agents. GitHub's issue UI may be an administrative escape hatch, not a required step in the normal workflow.
6. No issue operation may silently target the active code repository when the configured tracker repository or an explicitly qualified issue pointer names a different repository.

## Open questions

- Classify capabilities C1–C18 in the [parent product requirements](../246-native-issue-tracker-evaluation/requirements.md) as **Required**, **Optional**, or **Not needed**.
- Choose the binding scope: one private tracker repository for the ShipIt deployment, or a separate tracker repository per ShipIt Project.
- Choose repository provisioning: select an existing private repository for the first release, or also let ShipIt create and initialize one.

## Resolved questions

- 2026-08-02 — The user selected a dedicated private GitHub repository as an option worth designing separately from the broader native/open-source tracker evaluation.
- 2026-08-02 — The repository may be hosted on GitHub, but it must not be ShipIt's public source repository.
- 2026-08-02 — The tracker must be private, free without a subscription, and provide every current ShipIt wrapper capability that the user ultimately classifies as Required.
