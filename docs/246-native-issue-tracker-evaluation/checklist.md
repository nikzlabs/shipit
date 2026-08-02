# Native issue tracker evaluation checklist

## Evaluation

- [x] Separate the human-owned product requirements from the research/evaluation requirements.
- [x] Document Vikunja as a ShipIt-managed backend option.
- [x] Document Forgejo as a ShipIt-managed backend option.
- [x] Document Plane as a ShipIt-managed backend option.
- [x] Document Leantime as a ShipIt-managed backend option.
- [x] Document Huly as a ShipIt-managed backend option.
- [x] Document a first-party ShipIt implementation.
- [x] Compare the options against common qualitative criteria, including implementation effort.
- [x] Evaluate every candidate explicitly against feature parity, privacy, and free/no-subscription product gates.
- [x] Document the existing GitHub Issues adapter with a dedicated private repository as a viable baseline.
- [x] Document Linear migration, archive, deployment scope, authentication, upgrade, and availability concerns.
- [x] Record that issues must stay private and outside ShipIt's public repository; a dedicated private GitHub repository is acceptable.
- [x] Add falsifiable gates for the dedicated-private-GitHub, Vikunja, and first-party decision sequence.

## Decision and implementation

- [ ] Obtain a product decision to run the Vikunja spike or select another option.
- [ ] If selected, create implementation requirements from the product decision and resolve all open questions before coding.
- [ ] Run the selected implementation through an independent requirements review before completion.
