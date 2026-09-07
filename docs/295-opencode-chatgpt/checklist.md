# ChatGPT subscriptions in OpenCode

## Design

- [x] Record user goal, proposed requirements, and scope.
- [x] Trace account ownership, routing, refresh, and background execution at source.
- [x] Specify delivery, failure behavior, validation gates, and alternatives.
- [x] Complete independent design and simplification review; address findings.

## Implementation

- [x] Verify native auth enablement, access-only auth, and live replacement with the full pinned ShipIt spawn configuration.
- [x] Isolate managed XDG state and verify one-time conversation migration and resume.
- [x] Implement account projection, provenance, repush, and revocation.
- [x] Add explicit account routing and verified model/capability eligibility.
- [x] Cover foreground, resume, compaction, review, naming, and PR text paths.
- [x] Connect OpenAI recovery and shared quota without API fallback.
- [x] Test concurrency, expiry, restart, disconnect, and existing routes.
- [x] Complete authenticated smoke validation and code quality checks.
- [x] Update affected platform reference docs and enable the route.

Validation: 1,070 affected tests and 33 installer tests passed, including naming
isolation and an OpenCode-only installation.
The pinned CLI contract probe and an authenticated GPT-5.5 smoke test passed.
