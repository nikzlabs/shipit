# Declared issue trackers — checklist

## Shipped (requirements 1–9, 15–19)

- [x] Preserve structured repository identity through parsing and all issue operations.
- [x] Add `--repo owner/name` to `shipit issue`; no-`--repo` keeps meaning the session's code repo. *(The agent-ops relay passes `tracker` through verbatim, so no schema change was needed.)*
- [x] Parse the `issues.trackers` block in `shipit.yaml` as a `kind`-discriminated list; warn and skip on a malformed entry, a `github` entry missing `repo`, or an unrecognized `kind`, rather than failing the session.
- [x] Widen `TrackerId` for derived `github:owner/repo` ids; make `GitHubTracker`'s id/label configurable; register one tracker per declaration.
- [x] Render a declared tracker as its own Issues tab, with reachability failures inline on that tab.
- [x] Add same-numbered code/tracker repository regression coverage.
- [x] Repository-qualified deduplication, lifecycle-card, and persisted effect keys. *(Falls out of the qualified tracker id.)*
- [x] Preserve repository targets through agent operations and persisted Undo cards. *(Undo resolves `card.tracker`, which is now qualified — no new persisted field, no migration.)*
- [x] Keep each code repository's GitHub Issues routed independently of any declared tracker.
- [x] Derive pushed branch names from the pointer only, for every tracker issue.
- [x] Represent unsupported normalized operations and GitHub feature differences honestly.
- [x] Run focused tests, the full suite, `npm run lint:dev`, and `npm run typecheck`.

## Aliases (requirements 10–14) — designed, not implemented

- [ ] Decide the mechanism open points: duplicate/conflicting aliases across declarations, alias-vs-owner-name collisions, and how an unresolvable alias renders (fail closed, stay legible).
- [ ] Add `alias` to the `issues.trackers` schema (req 10) and to `shipit-docs/shipit-yaml.md`.
- [ ] Resolve alias pointers in a layer above `parseIssueRef`, keeping the parser pure and context-free; audit every call site.
- [ ] Emit the alias form everywhere ShipIt generates a reference (PR bodies and comments, provenance and read cards, `shipit issue` output, doc frontmatter) through a single formatter rather than per-call-site.
- [ ] Honor a self-declaration: remove the registry's skip of a declaration matching the session's own repo, without producing a duplicate tab.
- [ ] Audit the places that assume a recorded target is immutable — requirement 14 removes that guarantee.
- [ ] Add the alias test coverage listed in `plan.md` → Validation.

## Follow-on

- [ ] `issues.default` — `shipit issue create` hardcodes Linear as its fallback tracker, and declaring a tracker does not change it. Needs its own requirements doc before implementation.
- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination, so it cannot enumerate a tracker larger than that.
