# ShipIt private planning — product requirements

How ShipIt tracks its own planning work, and the migration off Linear. The
platform mechanism this relies on — declared trackers, repository-qualified
routing, aliases — is a separate feature
([248](../248-declared-issue-trackers/requirements.md)).

1. ShipIt's planning issues live in a private GitHub repository, separate from
   ShipIt's public source repository. ShipIt does not publish private issue
   content — titles, bodies, comments, status, labels, or assignees — to public
   surfaces. The only approved disclosures are those in requirement 4.
2. All planning workflows are available inline in ShipIt. Missing inline coverage
   is a backlog or inline degraded-state concern, not a required GitHub step. A
   secondary GitHub link may remain for repository administration and exceptional
   manual recovery.
3. The user creates the private repository. ShipIt neither creates it nor performs
   initial repository setup or bulk initialization.
4. Three disclosures are accepted:
   - a public PR body naming a planning issue reveals that issue's number and its
     existence;
   - the repository's committed `shipit.yaml` publishes the planning repository's
     slug, and its `alias → owner/repo` mapping where an alias is declared;
   - where no alias is in use, a reference discloses the repository slug too.

   Readers without repository access still cannot inspect issue contents.
5. ShipIt's in-product bug-report flow is separate from planning and continues to
   file user reports in ShipIt's public repository. Planning work and user bug
   reports never route to the same destination.
6. Anyone who can use the deployment can read and write ShipIt's planning issues
   through ShipIt, regardless of their personal GitHub membership, because GitHub
   authorizes the deployment's credential rather than the viewer.
7. Every Linear issue is copied to the planning repository, including its
   comments. Each copied comment preserves its original author and date; the
   copying account is not presented as the author. Closed and canceled issues are
   copied as well — this follows from requirement 8, since most referenced issues
   are already closed.
8. Every reference to a migrated issue in the repository is updated to point at
   its new location. This covers doc `issue:` frontmatter, inline mentions in
   docs, references in code comments, and `CLAUDE.md`.
9. After the copy and the reference rewrite, ShipIt stops using Linear for its own
   planning: no new issues are filed there, and the Linear tab is removed from
   ShipIt's own sessions.

## Open questions

- **What is the private planning repository?** ShipIt does not create it
  (requirement 3), so the migration cannot start without the `owner/name` the user
  has created. The deployment's GitHub credential must also be able to reach it —
  that credential is account-wide rather than repo-scoped, so a fine-grained token
  limited to the source repository would fail on the planning repository.
- **Does "fully retire Linear" extend to the product, or only to ShipIt's own
  planning?** Requirement 9 states the latter: ShipIt stops using Linear for
  itself. Removing `LinearTracker` from the product is a different and much larger
  change, and other repositories edited inside ShipIt depend on it. The
  distinction has not been confirmed.

## Resolved questions

Receipts about the tracker *mechanism* live in
[248](../248-declared-issue-trackers/requirements.md); these are the ones specific
to ShipIt's own planning. The full deliberation history of the superseded
`247-private-github-issue-tracker` doc remains in git.

- 2026-08-05 — Asked what happens to the ~316 existing Linear issues, the user
  chose to **copy everything, including comments, fix all references, and fully
  retire Linear**. Leaving the existing issues in Linear and cutting over only new
  work, and moving only the in-flight issues by hand, were both rejected.
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
