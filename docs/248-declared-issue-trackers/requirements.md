# Declared issue trackers — product requirements

A repository declares which issue trackers it uses, and every issue operation
names the destination it acts on. This is the platform mechanism; it applies to
any repository edited inside ShipIt. ShipIt's own use of it — a private planning
repository, and the migration off Linear — is a separate feature
([247](../247-shipit-private-planning/requirements.md)).

## Routing

1. Every issue operation names its destination repository. `--repo owner/name`
   names it explicitly; an operation that names none means the active session's
   code repository, exactly as today.
2. A named repository is used as named. ShipIt never substitutes another
   repository for it, and never retries a failure against a fallback.
3. Any repository the GitHub credential can reach is reachable. ShipIt keeps no
   allow-list, and a repository the credential cannot access fails closed with an
   inline access error.
4. A bare issue number resolves against whichever repository the operation
   already resolved — never a different one.

## Declarations

5. Additional trackers are declared in the repository's `shipit.yaml`, not
   configured in ShipIt settings:

   ```yaml
   issues:
     trackers:
       - kind: github           # which tracker backs this tab
         repo: owner/planning   # GitHub Issues: `owner/name`
         label: Planning        # optional; defaults to the repository name
         alias: planning        # optional; see requirement 10
   ```

6. Each entry states its tracker `kind`, and the remaining fields are whatever
   that kind needs to identify itself. `github` is the only kind defined now.
7. An entry whose `kind` this version of ShipIt does not recognize is ignored with
   a warning, rather than failing the session.
8. Each declaration appears as its own tab in the Issues UI, in declaration order.
   A repository may declare more than one.
9. Declaring a tracker adds a destination and changes nothing else. Each code
   repository keeps its own GitHub Issues tracker, and no existing operation
   changes where it writes.

## Aliases

10. A declaration may carry an `alias`. `planning#123` then means issue 123 on
    that declared repository.
11. Renaming a tracking repository requires editing only `repo:` in the
    declaration. No existing reference to its issues has to change.
12. ShipIt writes the alias form wherever it generates a reference: its own
    surfaces, the conversation, docs, and PR bodies and comments.
13. A repository may declare its **own** repository, in order to give it an alias.
14. A reference resolves when it is used, not when it is written. Re-pointing an
    alias re-targets every reference written against it, recorded ones included,
    and the UI shows the repository it now resolves to.

## Naming and disclosure

15. ShipIt-generated text includes no issue fields beyond the reference itself —
    no title, body, comments, status, labels, or assignees.
16. When a session starts from a tracker issue, the pushed branch name comes from
    the pointer only, never from the issue title. This applies to every tracker
    issue: ShipIt cannot tell which repositories are private, so the rule is
    unconditional rather than a guess.

## Authorization and feature set

17. Tracker operations use the same GitHub credential as ShipIt's other GitHub
    operations, and GitHub authorizes that credential rather than the viewer.
    Anyone who can use the deployment can therefore read and write a declared
    tracker, regardless of their personal GitHub membership.
18. The user creates the repository and declares it. ShipIt neither creates it nor
    initializes it.
19. GitHub's feature set is accepted as-is; ShipIt does not emulate missing
    capabilities for parity. An unavailable operation is omitted or disabled with
    an inline explanation, and never silently no-ops or reports false success.

## Open questions

None.

## Resolved questions

Receipts are carried forward from the superseded `247-private-github-issue-tracker`
doc, which held these requirements before the split; its full deliberation history
remains in git.

- 2026-08-05 — Asked which form ShipIt writes when it generates a reference
  itself, the user chose **the alias everywhere** — "this slug needs to work
  inside ShipIt, in the conversation, in PR body/comments, in docs". Emitting the
  alias only on in-repo surfaces while keeping the qualified slug in public PR
  bodies, and treating the alias as an input-only form, were both rejected. Two
  accepted costs: GitHub cannot linkify `planning#42`, so the pointer is plain
  text anywhere outside ShipIt; and the alias does not make a repository secret,
  since the `alias → owner/repo` mapping is published in the committed
  `shipit.yaml`.
- 2026-08-05 — Asked whether aliases cover the session's own code repository, the
  user scoped them to **declared trackers only**, and added that a repository must
  be able to declare *its own* repository for alias purposes (req 13). That is a
  behavior change, not just a scope answer: the shipped registry deliberately
  skips a declaration matching the session's own repo, so a self-declaration is
  currently discarded.
- 2026-08-05 — Asked what happens to already-recorded references when an alias is
  later pointed at a different repository, the user chose **the links resolve to
  the new repository and the UI shows it** (req 14), replacing an earlier
  guarantee that a recorded destination stays valid for its recorded `owner/repo`.
  The accepted consequence is that re-pointing re-targets history written against
  the alias, including a persisted Undo card's target. Freezing persisted routing
  while letting text follow the alias, and freezing everything, were both rejected
  as more machinery than the case warrants.
- 2026-08-04 — Asked which issues get pointer-only branch names, the user chose
  **every issue** (req 16), so title-derived readable branch names go away for
  Linear and code-repository issues too. Scoping the rule to declared trackers,
  adding an explicit `private: true` opt-in, and dropping the requirement were all
  rejected. Public PR *titles* are not covered: the agent writes them with
  `gh pr create -t`, so ShipIt generates no PR title to derive.
- 2026-08-04 — Asked which repositories `--repo` may name, the user chose **any
  repository the GitHub credential can reach** (req 3). An allow-list limited to
  the session's code repository plus a configured binding was rejected, as was an
  allow-list with an opt-in escape hatch. The accepted consequence is that a
  mistyped `--repo` can write to a real repository the credential owns.
- 2026-08-04 — The user replaced a planned separate tracker identity with an
  explicit repository argument on the existing GitHub tracker (req 1), so no third
  tracker id, sub-tab name, or `--tracker` value is introduced.
- 2026-08-04 — The user replaced a stored deployment-wide binding with a
  declarative one (req 5). This removed the Settings connect flow, the
  credential-store field, connection-time validation, and the migration; it also
  dissolved the per-Project binding question, since the declaration travels with
  the repository. Two accepted consequences: `TrackerId` stops being a closed
  union, and with no connection step ShipIt no longer verifies that a declared
  repository is private.
- 2026-08-04 — The user required the declaration syntax to name the tracker kind
  explicitly rather than assuming GitHub Issues (req 6), citing Linear team
  assignment as a plausible later case. An unrecognized `kind` is ignored with a
  warning (req 7) so a config written for a newer ShipIt does not break an older
  one.
- 2026-08-04 — To keep authorization simple, ShipIt relies on ordinary GitHub
  requests rather than proactive access or privacy polling, and does not verify
  each viewer's repository membership independently of the credential (req 17).
- 2026-08-04 — The user removed priority-label writing from this feature as
  orthogonal. Priority writes are to be supported for **both** GitHub destinations
  under [SHI-310](https://linear.app/shipit-ai/issue/SHI-310).
