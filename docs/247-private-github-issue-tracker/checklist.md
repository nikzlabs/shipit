# Private GitHub issue tracker — checklist

## Design

- [x] Record private, free/no-subscription, and required-capability constraints.
- [x] Separate this option from the broader tracker comparison.
- [x] Document the current cross-repository wrong-target risk.
- [x] Define repository identity as authoritative routing data.
- [x] Cover UI, CLI, Undo, seeded sessions, and PR lifecycle paths.
- [x] Document configuration, authentication, validation, and non-goals.

## Product decisions

- [ ] Choose deployment-wide or per-Project repository binding.
- [ ] Choose existing-repository selection only or ShipIt-managed repository creation.
- [ ] Decide whether public PR bodies may expose qualified private tracker pointers.

## Implementation

- [ ] Convert the resolved decisions into implementation acceptance tests.
- [ ] Preserve structured repository identity through parsing and all issue operations.
- [ ] Add private tracker repository configuration and permission validation.
- [ ] Implement every Required capability and expose Optional gaps.
- [ ] Add same-numbered code/tracker repository regression coverage.
- [ ] Add repository-qualified deduplication, lifecycle-card, and persisted effect keys.
- [ ] Preserve repository targets through agent operations and persisted Undo cards.
- [ ] Keep public user bug reports routed to ShipIt's public repository while private planning issues use the private tracker.
- [ ] Run focused tests, `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck`.
- [ ] Complete a fresh-context requirements review.
