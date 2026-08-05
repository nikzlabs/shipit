# ShipIt private planning — product requirements

How ShipIt tracks its own planning work, and the migration off Linear. The
platform mechanism this relies on — declared trackers, repository-qualified
routing, aliases — is a separate feature
([248](../248-declared-issue-trackers/requirements.md)).

## The planning tracker

1. ShipIt's planning issues live in a private GitHub repository, separate from
   ShipIt's public source repository.
2. Planning issue content — titles, bodies, comments, status, labels, assignees —
   is not published to public surfaces.
3. Three disclosures are accepted:
   - a public PR body reveals a referenced issue's number and its existence;
   - the committed `shipit.yaml` publishes the planning repository's slug, and its
     `alias → owner/repo` mapping where an alias is declared;
   - a reference written without an alias discloses the repository slug too.

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
   ones included.
9. Every copied comment is carried over, preserving its original author and date.
   The copying account is not presented as the author.
10. Every reference to a migrated issue is updated to its new location: doc
    `issue:` frontmatter, inline mentions in docs, references in code comments,
    and `CLAUDE.md`.
11. After the copy and the rewrite, ShipIt stops using Linear for its own
    planning: no new issues are filed there, and the Linear tab is removed from
    ShipIt's own sessions.

## Open questions

- **What is the private planning repository?** ShipIt does not create it (req 5),
  so the migration cannot start without the `owner/name` the user has created. The
  deployment's GitHub credential must also reach it — that credential is
  account-wide rather than repo-scoped, so a fine-grained token limited to the
  source repository would fail there.
- **Does "fully retire Linear" extend to the product, or only to ShipIt's own
  planning?** Requirement 11 states the latter. Removing `LinearTracker` from the
  product is a different and much larger change, and other repositories edited
  inside ShipIt depend on it. The distinction has not been confirmed.

## Resolved questions

Receipts about the tracker *mechanism* live in
[248](../248-declared-issue-trackers/requirements.md); these are the ones specific
to ShipIt's own planning. The full deliberation history of the superseded
`247-private-github-issue-tracker` doc remains in git.

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
  reference takes was later changed to the alias — see 248's receipts.)
- 2026-08-04 — The user resolved that ShipIt's planning tracker uses the same
  GitHub token as other GitHub operations, and that ShipIt does not independently
  verify each viewer's repository membership.
- 2026-08-04 — The user clarified that every code repository keeps its own GitHub
  Issues tracker. The fixed public bug-report destination applies only to ShipIt
  product reports.
