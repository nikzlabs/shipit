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
- [x] Keep private issue titles out of pushed branch names and public PR titles.
- [x] Preserve each active code repository's GitHub Issues as a distinct tracker destination.
- [x] Decide how historical references and Undo actions behave after the configured private repository changes or is removed.
- [x] Validate on connection and rely on ordinary GitHub authorization afterward; do not add proactive polling.
- [x] Name the destination with an explicit `--repo owner/name` on the existing `github` tracker rather than a new tracker identity.
- [x] Move priority-label writes out of this feature (SHI-310, both GitHub destinations).

## Implementation

- [x] Convert the resolved decisions into implementation acceptance tests.
- [x] Preserve structured repository identity through parsing and all issue operations.
- [x] Add `--repo owner/name` to `shipit issue`, the `/agent-ops/issue/*` schema, and the HTTP routes; no-`--repo` keeps meaning the session's code repo. *(The agent-ops relay passes `tracker` through verbatim, so no schema change was needed.)*
- [x] Parse the `issues.trackers` block in `shipit.yaml` as a `kind`-discriminated list; warn and skip on a malformed entry, a `github` entry missing `repo`, or an unrecognized `kind`, rather than failing the session.
- [x] Widen `TrackerId` for derived `github:owner/repo` ids; make `GitHubTracker`'s id/label configurable; register one tracker per declaration.
- [x] Render a declared tracker as its own Issues tab, with reachability failures inline on that tab.
- [x] Represent unsupported normalized operations and GitHub feature differences honestly. *(`--priority` / `--parent` are rejected identically on a named repository; SHI-310 covers priority writes for both destinations.)*
- [x] Add same-numbered code/tracker repository regression coverage.
- [x] Add repository-qualified deduplication, lifecycle-card, and persisted effect keys. *(Falls out of the qualified tracker id — `parseIssueRef`'s dedup key and the PR-body pointers are qualified without separate key changes.)*
- [x] Preserve repository targets through agent operations and persisted Undo cards. *(Undo resolves `card.tracker`, which is now qualified — no new persisted field, no migration, no legacy-card path.)*
- [x] Keep public user bug reports routed to ShipIt's public repository while private planning issues use the private tracker. *(`services/bug-report.ts` stays outside the tracker registry; untouched by this change.)*
- [x] Keep each active code repository's GitHub Issues routed independently of the private planning tracker.
- [x] Requirement 1's public-surface derivation: pushed branch names come from the qualified pointer only, for **every** tracker issue (the user resolved the "which issues" question as unconditional).
- [x] Verify private issue content does not reach public surfaces beyond explicitly accepted disclosures. *(The branch is the only public surface ShipIt itself generates from an issue; PR titles are agent-authored via `gh pr create -t`, so there is no ShipIt-generated PR title to derive.)*
- [x] Run focused tests, the full suite, `npm run lint:dev`, and `npm run typecheck`.

Remaining:

- [ ] Complete a fresh-context requirements review.
- [x] Resolve requirement 10's open questions (which form ShipIt emits, whether the session's own repo is covered, and rename-vs-re-point for recorded destinations).
- [ ] Design and implement alias references (requirement 10), including the two behavior changes the answers imply: ShipIt emits the alias form wherever it generates a reference (requirement 7), and a declaration matching the session's own repository is honored as an alias rather than skipped.
- [ ] Re-check the shipped surfaces that requirement 3's simplification changes: a recorded destination is no longer pinned to the `owner/repo` it resolved to when written.
