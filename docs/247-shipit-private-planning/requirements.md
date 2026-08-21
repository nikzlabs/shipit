# ShipIt private planning — product requirements

How ShipIt tracks its own planning work, and the migration off Linear. The
platform mechanism this relies on — declared trackers, repository-qualified
routing, tracker names — is a separate feature
([248](../248-declared-issue-trackers/requirements.md)).

## The planning tracker

1. ShipIt's planning issues live in `nikzlabs/shipit-planning`, a private GitHub
   repository separate from ShipIt's public source repository. It is declared in
   ShipIt's own `shipit.yaml` under the name `planning`, so every reference to a
   planning issue reads `planning#123`.
2. Planning issue content — titles, bodies, comments, status, labels, assignees —
   is not published to public surfaces.
3. Three disclosures are accepted:
   - a public PR body reveals a referenced issue's number and its existence;
   - the committed `shipit.yaml` publishes the planning repository's slug, and its
     `name → destination` mapping;
   - a reference to the session's own repository discloses that repository, which is already public.

   Readers without repository access still cannot inspect issue contents.
4. All planning workflows are available inline in ShipIt. A GitHub link remains
   only for repository administration and exceptional manual recovery; missing
   inline coverage is a backlog item, not a required GitHub step.
5. The user creates the private repository. ShipIt neither creates it nor
   initializes it.
6. ShipIt's in-product bug-report flow keeps filing user reports in ShipIt's
   public repository. Planning work and user bug reports never share a destination.
7. Anyone who can use the deployment can read and write ShipIt's planning issues
   through ShipIt, because GitHub authorizes the deployment's credential rather
   than the viewer.

## Migration off Linear

8. Every Linear issue is copied to the planning repository, closed and canceled
   ones included. A copied issue is open or closed and nothing finer; the
   distinctions Linear drew above that are not preserved.
9. Dates are preserved. Every copied comment carries its original date, so the
   chronology of a discussion survives, and every copied issue records its own
   original creation date.
10. Every reference to a migrated issue is updated to its new location: doc
    `issue:` frontmatter, inline mentions in docs, references in code comments,
    and `CLAUDE.md`.
11. After the copy and the rewrite, ShipIt stops using Linear for its own
    planning: it removes Linear from its own `shipit.yaml` declarations, so no new
    issues are filed there and the tab disappears. Linear remains a supported
    tracker kind for any repository that declares it.
12. Issues are copied in ascending key order, so their relative order survives:
    of any two migrated issues, the one with the lower Linear key has the lower
    number in the planning repository.
13. The Linear workspace is the archive for whatever the copy could not carry.
    It is kept, not deleted, and no separate export is maintained as a
    long-lived artifact.

## Open questions

None.

## Resolved questions

Receipts about the tracker *mechanism* live in
[248](../248-declared-issue-trackers/requirements.md); these are the ones specific
to ShipIt's own planning. The full deliberation history of the superseded
`247-private-github-issue-tracker` doc remains in git.

- 2026-08-06 — The user required that issues be migrated **in order**, lowest key
  first, so the ordering of the resulting numbers matches the ordering of the
  originals (req 12). Numbers themselves cannot be preserved — GitHub assigns them
  and shares the sequence with pull requests — but their relative order can be,
  and that is what makes "later issue, higher number" still read correctly after
  the migration.
- 2026-08-06 — Asked whether Linear's six workflow states should survive a copy
  into a tracker that has only open and closed, the user chose to **let them
  collapse** (req 8). Encoding them as labels — either both splits or only
  `canceled`/`duplicate` — was rejected: a new tracker is better re-triaged than
  carried over with states GitHub does not model. The corpus this applies to is
  Done 219, Backlog 78, Canceled 10, In Progress 7, Todo 7, Duplicate 1.
- 2026-08-06 — Asked whether a copied issue keeps its original creation date, the
  user chose to **record it in the issue body** (req 9), alongside its `SHI-N`
  origin, so an issue reads consistently with its comments rather than appearing
  to have been created on the day of the copy. GitHub cannot set a creation date,
  and reading Linear's needs `createdAt` added to the adapter's issue query.
- 2026-08-05 — The requirement that a copied comment not present the copying
  account as its author was removed: the copying account and the original author
  are the same person, so the distinction has no observable effect. Comments still
  carry their original date (req 9), which is what preserves a discussion's
  chronology.
- 2026-08-05 — The user set the tracker's name to `planning` and, after weighing
  `nikzlabs/shipit-issue-tracker`, chose **`nikzlabs/shipit-planning`** as the
  repository (req 1). `shipit-issue-tracker` was rejected because it would sit
  beside a public repository whose codebase contains an actual issue-tracker
  feature, so a sibling by that name reads as that feature rather than as a
  planning board. Of the two identifiers the **name** is the load-bearing one: it
  is written into every reference, so it must be final before the reference
  rewrite, whereas renaming the repository later costs one line in `shipit.yaml`
  ([248](../248-declared-issue-trackers/requirements.md) req 13). Creating the
  repository remains a task rather than an open requirement.
- 2026-08-05 — "Does *fully retire Linear* extend to the product?" is answered by
  the user's decision to make `linear` a declared tracker kind
  ([248](../248-declared-issue-trackers/requirements.md) req 3): Linear support
  stays in the product, and what is retired is its status as an implicit built-in
  destination. ShipIt retires it *for itself* by not declaring it (req 11).
- 2026-08-05 — Asked what happens to the ~316 existing Linear issues, the user
  chose to **copy everything, including comments, fix all references, and fully
  retire Linear**. Leaving the existing issues in Linear and cutting over only new
  work, and moving only the in-flight issues by hand, were both rejected. "Every
  issue" is read as including closed and canceled ones (req 8), since most of the
  254 referenced keys are already closed and req 10 requires their references to
  resolve.
- 2026-08-02 — The user selected a private GitHub repository as an option worth
  designing separately from the broader native/open-source tracker evaluation. The
  repository may be hosted on GitHub, but it must not be ShipIt's public source
  repository.
- 2026-08-04 — The initial requirements included free/no-subscription and
  classified wrapper parity. The user superseded both: GitHub's cost and feature
  set are accepted assumptions rather than implementation gates.
- 2026-08-03 — The user distinguished two coexisting uses: public issues reported
  by ShipIt users remain in the public ShipIt repository, including the existing
  in-product bug-report flow; the private tracker is for the owner's planning work.
- 2026-08-04 — The user will create the private repository, including the one used
  for ShipIt itself. ShipIt only uses it; ordinary issue and label operations
  afterward are tracker use rather than repository initialization.
- 2026-08-04 — After reviewing the disclosure risks, the user accepted that a
  public PR reveals the referenced issue number and its existence. (The form that
  reference takes was later changed to the tracker name — see 248's receipts.)
- 2026-08-04 — The user resolved that ShipIt's planning tracker uses the same
  GitHub token as other GitHub operations, and that ShipIt does not independently
  verify each viewer's repository membership.
- 2026-08-04 — The user clarified that every code repository keeps its own GitHub
  Issues tracker. The fixed public bug-report destination applies only to ShipIt
  product reports.
- 2026-08-07 — Three things the copy could not carry were surfaced after the
  migration ran: workflow state finer than open/closed, the 226 byte-identical
  duplicate comments the write-dedup window collapsed, and Linear's attachment
  URLs. Offered the choice between preserving a durable export and keeping the
  Linear workspace as the archive, the user chose **Linear as the archive**
  (req 13). The `/persist/linear-export/` copy is therefore a working artifact of
  the migration, not a deliverable, and is expected to disappear with its session.
