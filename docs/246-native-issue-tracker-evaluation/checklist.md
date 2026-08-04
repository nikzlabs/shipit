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
- [x] Evaluate every candidate against the capability-classification framework, privacy, and free/no-subscription product gates.
- [x] Document the existing GitHub Issues adapter with a dedicated private repository as a viable baseline.
- [x] Document Linear migration, archive, deployment scope, authentication, upgrade, and availability concerns.
- [x] Record that issues must stay private and outside ShipIt's public repository; a dedicated private GitHub repository is acceptable.
- [x] Add falsifiable gates for the dedicated-private-GitHub, Vikunja, and first-party decision sequence.
- [x] Extract the dedicated private-GitHub option into a focused requirements, design, and checklist document.
- [x] Record that public user bug reports and private owner planning issues are separate coexisting tracker destinations.

## Decision and implementation

- [ ] Classify capabilities C1–C18 as Required, Optional, or Not needed in `requirements.md`.
- [ ] Obtain a product decision to run the Vikunja spike or select another option.
- [ ] If selected, create implementation requirements from the product decision and resolve all open questions before coding.
- [ ] Run the selected implementation through an independent requirements review before completion.
