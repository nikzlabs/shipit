# ShipIt private planning — product requirements

How ShipIt tracks its own planning work, and the migration off Linear. The
platform mechanism this relies on — declared trackers, repository-qualified
routing, tracker names — is a separate feature
([248](../248-declared-issue-trackers/requirements.md)).

## The planning tracker

1. ShipIt's planning issues live in a private GitHub repository, separate from
   ShipIt's public source repository, declared in ShipIt's own `shipit.yaml` under
   the name `planning` — so every reference to a planning issue reads
   `planning#123`.
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
   ones included.
9. Every copied comment is carried over, preserving its original date so the
   chronology of a discussion survives.
10. Every reference to a migrated issue is updated to its new location: doc
    `issue:` frontmatter, inline mentions in docs, references in code comments,
    and `CLAUDE.md`.
11. After the copy and the rewrite, ShipIt stops using Linear for its own
    planning: it removes Linear from its own `shipit.yaml` declarations, so no new
    issues are filed there and the tab disappears. Linear remains a supported
    tracker kind for any repository that declares it.

## Open questions

- **The planning repository has to be created.** ShipIt does not create it (req 5),
  so the migration cannot start until it exists. The deployment's GitHub credential
  must also reach it — that credential is account-wide rather than repo-scoped, so
  a fine-grained token limited to the source repository would fail there.

  On the slug: `nikzlabs/shipit-planning` reads better than
  `nikzlabs/shipit-issue-tracker`, because the latter sits next to a public
  repository whose codebase contains an actual issue-tracker feature, and a sibling
  by that name invites the reading that it *is* that feature. It also pairs with
  the `planning` name in requirement 1. Either way the slug is the cheap half of
  the decision: renaming the repository later costs one line in `shipit.yaml`
  ([248](../248-declared-issue-trackers/requirements.md) req 13). The **name** is
  the expensive half — it is written into every reference, so changing it after the
  rewrite means sweeping ~620 files a second time.
## Resolved questions

Receipts about the tracker *mechanism* live in
[248](../248-declared-issue-trackers/requirements.md); these are the ones specific
to ShipIt's own planning. The full deliberation history of the superseded
`247-private-github-issue-tracker` doc remains in git.

- 2026-08-05 — The requirement that a copied comment not present the copying
  account as its author was removed: the copying account and the original author
  are the same person, so the distinction has no observable effect. Comments still
  carry their original date (req 9), which is what preserves a discussion's
  chronology.
- 2026-08-05 — The user proposed `planning` as the tracker's name (req 1) and
  `nikzlabs/shipit-issue-tracker` as a candidate slug. The name is recorded because
  it is the load-bearing half — it is written into every reference, so it must be
  final before the reference rewrite. The slug remains open pending repository
  creation; `nikzlabs/shipit-planning` is recommended over
  `nikzlabs/shipit-issue-tracker` to avoid reading as a component of the product's
  own issue-tracker feature.
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
