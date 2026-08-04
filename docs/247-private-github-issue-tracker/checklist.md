# Private GitHub issue tracker — checklist

## Design

- [x] Record the initial cost/parity constraints and their subsequent supersession.
- [x] Separate this option from the broader tracker comparison.
- [x] Document the current cross-repository wrong-target risk.
- [x] Define repository identity as authoritative routing data.
- [x] Cover UI, CLI, Undo, seeded sessions, and PR lifecycle paths.
- [x] Document configuration, authentication, validation, and non-goals.

## Product decisions

- [x] Use one deployment-wide private tracker until Projects makes bindings per Project.
- [x] Require the user to create the private repository; ShipIt only connects it.
- [x] Accept GitHub Issues' feature set without a separate capability-parity gate.
- [x] Use fully qualified private tracker pointers in public PR bodies and accept their metadata disclosure.
- [x] Use the contextual GitHub credential and let GitHub enforce repository access; do not add a separate per-viewer tracker ACL.
- [ ] Decide whether private issue titles may appear in pushed branch names and public PR titles.
- [ ] Decide whether the active code repository's GitHub Issues remain a third destination.
- [ ] Decide rebinding and historical qualified-reference behavior.
- [ ] Decide post-connection privacy/access revalidation behavior.
- [ ] Decide whether priority operations may create convention labels on demand.

## Implementation

- [ ] Convert the resolved decisions into implementation acceptance tests.
- [ ] Preserve structured repository identity through parsing and all issue operations.
- [ ] Add private tracker repository configuration and permission validation.
- [ ] Represent unsupported normalized operations and GitHub feature differences honestly.
- [ ] Add same-numbered code/tracker repository regression coverage.
- [ ] Add repository-qualified deduplication, lifecycle-card, and persisted effect keys.
- [ ] Preserve repository targets through agent operations and persisted Undo cards.
- [ ] Keep public user bug reports routed to ShipIt's public repository while private planning issues use the private tracker.
- [ ] Verify private issue content does not reach public surfaces beyond explicitly accepted disclosures.
- [ ] Run focused tests, `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck`.
- [ ] Complete a fresh-context requirements review.
