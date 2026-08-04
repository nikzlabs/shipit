# Private GitHub issue tracker — checklist

## Design

- [x] Record private, free/no-subscription, and required-capability constraints.
- [x] Separate this option from the broader tracker comparison.
- [x] Document the current cross-repository wrong-target risk.
- [x] Define repository identity as authoritative routing data.
- [x] Cover UI, CLI, Undo, seeded sessions, and PR lifecycle paths.
- [x] Document configuration, authentication, validation, and non-goals.

## Product decisions

- [x] Use one deployment-wide private tracker until Projects makes bindings per Project.
- [x] Require the user to create the private repository; ShipIt only connects it.
- [x] Accept GitHub Issues' feature set without a separate capability-parity gate.
- [ ] Decide whether public PR bodies may expose qualified private tracker pointers.

## Implementation

- [ ] Convert the resolved decisions into implementation acceptance tests.
- [ ] Preserve structured repository identity through parsing and all issue operations.
- [ ] Add private tracker repository configuration and permission validation.
- [ ] Represent unsupported normalized operations and GitHub feature differences honestly.
- [ ] Add same-numbered code/tracker repository regression coverage.
- [ ] Add repository-qualified deduplication, lifecycle-card, and persisted effect keys.
- [ ] Preserve repository targets through agent operations and persisted Undo cards.
- [ ] Keep public user bug reports routed to ShipIt's public repository while private planning issues use the private tracker.
- [ ] Run focused tests, `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck`.
- [ ] Complete a fresh-context requirements review.
