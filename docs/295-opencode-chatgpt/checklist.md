# ChatGPT subscriptions in OpenCode

## Design

- [x] Record user goal, proposed requirements, and scope.
- [x] Trace account ownership, routing, refresh, and background execution at source.
- [x] Specify delivery, failure behavior, validation gates, and alternatives.
- [x] Complete independent design and simplification review; address findings.

## Implementation — separate from this design task

- [ ] Verify native auth enablement, access-only auth, and live replacement with the full pinned ShipIt spawn configuration.
- [ ] Isolate managed XDG state and verify one-time conversation migration and resume.
- [ ] Implement account projection, provenance, repush, and revocation.
- [ ] Add explicit account routing and verified model/capability eligibility.
- [ ] Cover foreground, resume, compaction, review, naming, and PR text paths.
- [ ] Connect OpenAI recovery and shared quota without API fallback.
- [ ] Test concurrency, expiry, restart, disconnect, and existing routes.
- [ ] Complete authenticated smoke validation and code quality checks.
- [ ] Update affected platform reference docs and enable the route.
