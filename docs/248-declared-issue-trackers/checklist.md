# Declared issue trackers — checklist

## Blocked on the human

- [ ] Decide whether the unqualified GitHub form (`owner/repo#42`) stays recognized alongside the unqualified Linear key (open question).
- [x] Settle the reference syntax for Linear. *(All three forms are recognized — req 10.)*
- [x] Confirm the break with existing behavior. *(Accepted — req 17: nothing survives unless a requirement names it.)*

## Built against the earlier requirements

Shipped and working, but written for a GitHub-only, purely-additive design. Each
still stands unless a requirement below supersedes it.

- [x] Preserve structured destination identity through parsing and all issue operations.
- [x] Parse the `issues.trackers` block as a `kind`-discriminated list; warn and skip a malformed entry or an unrecognized `kind` rather than failing the session.
- [x] Widen `TrackerId` for derived per-destination ids; make the GitHub adapter's id/label configurable; register one tracker per declaration.
- [x] Render a declared tracker as its own Issues tab, with reachability failures inline on that tab.
- [x] Fail closed on an unreachable destination with an error naming both "missing" and "inaccessible" (req 16).
- [x] Add same-numbered code/tracker repository regression coverage.
- [x] Destination-qualified deduplication, lifecycle-card, and persisted effect keys.
- [x] Preserve destinations through agent operations and persisted Undo cards.
- [x] Derive pushed branch names from the reference only, for every tracker issue (req 19).
- [x] Represent unsupported normalized operations and backend feature differences honestly (req 23).

## Rework required by the current requirements

- [ ] Declare every tracker (req 1): remove the implicit Linear fallback and the assumption that a session always has a Linear destination.
- [ ] Add `kind: linear` as a declared backend (req 3), identified by its team key (req 5).
- [ ] Move the Linear team binding out of Settings and into the declaration (req 4); Settings keeps the credential only.
- [ ] Recognize all three reference forms — `name#KEY`, `name#number`, and the unqualified backend id — resolving an unqualified id through the matching declaration and failing closed when more than one matches (req 10). Covers the UI highlight as well as the CLI.
- [ ] Add the mandatory, repository-unique `name` field (req 2, 6) and the `shipit.yaml` docs for it.
- [ ] Replace `--repo owner/name` with naming the tracker (req 11), keeping the session's own GitHub Issues as the one unnamed exception.
- [ ] Resolve names in a layer above `parseIssueRef`, keeping that parser pure and context-free; audit every call site.
- [ ] Emit the name form everywhere ShipIt generates a reference (req 13) — PR bodies and comments, provenance and read cards, `shipit issue` output, doc frontmatter — through a single formatter rather than per-call-site.
- [ ] Surface declaration warnings in `shipit` CLI output (req 8).
- [ ] Honor a self-declaration: remove the registry's skip of a declaration matching the session's own repo, without producing a duplicate tab.
- [ ] Audit the places that assume a recorded destination is immutable — req 14 removes that guarantee.
- [ ] Decide the remaining mechanism points: duplicate/conflicting names across declarations, and how an unresolvable name renders (fail closed, stay legible).
- [ ] Add test coverage: a name resolving to its declared destination; a name re-pointed to a second destination re-targeting an existing recorded card; a self-declaration producing a name without a duplicate tab; ShipIt-generated PR bodies carrying the name form; an unresolvable name failing closed; a repository declaring nothing.

## Superseded

- ~~`issues.default`~~ — `shipit issue create`'s hardcoded Linear fallback disappears with requirement 1, which removes implicit destinations entirely. No default key is needed.

## Follow-on

- [ ] `shipit issue list` on Linear queries `first: 100` with no pagination, so it cannot enumerate a tracker larger than that.
