# Declared issue trackers — product requirements

A repository declares which issue trackers it uses, and every issue operation
names the destination it acts on. These requirements are about the platform
mechanism and apply to any repository edited inside ShipIt. ShipIt's own use of
it — a private planning repository, and the migration off Linear — is a separate
feature ([247](../247-shipit-private-planning/requirements.md)).

1. Every issue operation declares its destination, and the destination is a
   repository rather than a separate tracker identity. `github` continues to mean
   GitHub Issues. An operation names the repository explicitly (`--repo
   owner/name` on the CLI, the equivalent selection in the UI); one that names
   none uses the active session's code repository exactly as it does today; and a
   bare issue number resolves against whichever repository the operation
   resolved. A named repository is used as named: ShipIt does not restrict it to
   a known set, and never substitutes another repository — the active code
   repository included — for one that was named. GitHub authorization is the only
   gate on which repositories are reachable; a repository the credential cannot
   access fails closed with an inline access error.
2. A reference is resolved when it is used, not pinned when it is written. A
   reference that names a repository directly always means that repository, and a
   reference written against an alias (requirement 6) always resolves through the
   declaration as it stands now. Re-pointing an alias therefore re-targets every
   reference written against it, recorded ones included, and the UI shows the
   repository it currently resolves to.
3. Additional issue trackers are declared in the repository's `shipit.yaml`, not
   configured in ShipIt settings:

   ```yaml
   issues:
     trackers:
       - kind: github           # which tracker backs this tab
         repo: owner/planning   # GitHub Issues: `owner/name`
         label: Planning        # optional; defaults to the repository name
         alias: planning        # optional; see requirement 6
   ```

   Each entry states its tracker `kind`, and the remaining fields are whatever
   that kind needs to identify itself — so a tracker identified by something
   other than a repository can be added later without changing the shape.
   `github` is the only kind defined now; an entry whose `kind` this version of
   ShipIt does not recognize is ignored with a warning rather than failing the
   session.

   Each declaration appears as its own tab in the Issues UI, alongside the
   session's own code repository, in the order declared. `trackers` is a list, so
   a repository may declare more than one. Because the declaration travels with
   the repository, there is no deployment-wide binding and no separate per-Project
   binding is required when [Projects](../231-projects/requirements.md) ships.
4. The user creates the repository and declares it. ShipIt neither creates the
   repository nor performs initial repository setup or bulk initialization.
   Ordinary tracker operations against a declared repository remain allowed.
5. When a session starts from a tracker issue, the pushed branch name is derived
   from the pointer only, and never from the issue title. This applies to **every**
   tracker issue, not only ones on a declared repository: ShipIt has no way to tell
   which repositories are private, so the rule is unconditional rather than
   conditional on a judgement it cannot make. Readable branch names derived from
   issue titles are given up as the cost.
6. Renaming a declared tracking repository does not require editing the existing
   references to its issues. A tracker declaration may carry an `alias`, and the
   declaration is then the single place the real `owner/repo` is named:
   `planning#123` resolves to issue 123 on the declared repository, so changing
   `repo:` is the only edit a rename requires.

   The alias is the form ShipIt itself writes, everywhere it generates a
   reference: ShipIt's own surfaces, the conversation, docs, and PR bodies and
   comments. A reader outside ShipIt sees plain text where GitHub would have
   linkified a qualified pointer; that is accepted, because ShipIt renders the
   reference inline for the people who need to follow it. An alias does not make a
   repository secret — a repository that declares one publishes the
   `alias → owner/repo` mapping in its committed `shipit.yaml`.

   Aliases belong to tracker declarations, so they cover declared trackers only. A
   repository may declare its **own** repository as a tracker entry in order to
   give it an alias — a self-declaration is a legitimate way to alias a code
   repository's issues, not a redundant entry to be discarded.
7. When ShipIt adds an issue reference to a PR body, it writes the alias form
   where the tracker has one, and a fully qualified pointer (`owner/repo#42`)
   where it does not. ShipIt-generated text includes no other issue fields — no
   title, body, comments, status, labels, or assignees.
8. Each code repository keeps its own GitHub Issues tracker. A declared tracker is
   an additional destination, never a replacement, and declaring one does not
   change where any existing operation writes.
9. Tracker operations use the same GitHub credential as ShipIt's other GitHub
   operations. GitHub authorizes that credential against the repository; ShipIt
   adds no separate per-viewer repository-membership check or tracker ACL.
   Consequently, anyone who can use the deployment — the Project, once Projects
   ships — can use ShipIt to read and write a declared tracker regardless of their
   personal GitHub membership.
10. GitHub's feature set is accepted without a separate parity gate. ShipIt does
    not emulate missing capabilities solely for wrapper parity. A normalized
    operation unavailable for this backend is omitted or disabled with an inline
    explanation and must never silently no-op or report false success.

## Open questions

None.

## Resolved questions

Receipts are carried forward from the superseded `247-private-github-issue-tracker`
doc, which held these requirements before the split; its full deliberation
history remains in git.

- 2026-08-05 — Asked which form ShipIt writes when it generates a reference
  itself, the user chose **the alias everywhere** — "this slug needs to work
  inside ShipIt, in the conversation, in PR body/comments, in docs". Emitting the
  alias only on in-repo surfaces while keeping the qualified slug in public PR
  bodies, and treating the alias as an input-only form, were both rejected. Two
  accepted costs: GitHub cannot linkify `planning#42`, so the pointer is plain
  text anywhere outside ShipIt; and the alias does not make the repository secret,
  since the `alias → owner/repo` mapping is published in the committed
  `shipit.yaml`.
- 2026-08-05 — Asked whether aliases cover the session's own code repository, the
  user scoped them to **declared trackers only**, and added that a repository must
  be able to declare *its own* repository as a tracker entry for alias purposes.
  That is a behavior change, not just a scope answer: the shipped registry
  deliberately skips a declaration matching the session's own repo, so a
  self-declaration is currently discarded.
- 2026-08-05 — Asked what happens to already-recorded references when an alias is
  later pointed at a different repository, the user chose **the links resolve to
  the new repository and the UI shows it**, replacing the earlier guarantee that a
  recorded destination stays valid for its recorded `owner/repo`. The accepted
  consequence is that re-pointing an alias re-targets history written against it,
  including a persisted Undo card's target. Freezing persisted routing while
  letting text follow the alias, and freezing everything, were both rejected as
  more machinery than the case warrants.
- 2026-08-04 — Asked which issues get pointer-only branch names, the user chose
  **every issue**, so the rule is unconditional and title-derived readable branch
  names go away for Linear and code-repository issues too. Scoping the rule to
  declared trackers, adding an explicit `private: true` opt-in, and dropping the
  requirement were all rejected. Public PR *titles* are not covered: the agent
  writes them with `gh pr create -t`, so ShipIt generates no PR title to derive.
- 2026-08-04 — Asked which repositories `--repo` may name, the user chose **any
  repository the GitHub credential can reach**, with GitHub authorization as the
  only gate. An allow-list limited to the session's code repository plus a
  configured binding was rejected, as was an allow-list with an opt-in escape
  hatch. The accepted consequence is that a mistyped `--repo` can write to a real
  repository the credential owns.
- 2026-08-04 — The user replaced a planned separate tracker identity with an
  explicit repository argument on the existing GitHub tracker: `--tracker github
  --repo owner/name`. Repository identity is a parameter of the operation rather
  than a new destination name, so no third tracker id, sub-tab name, or
  `--tracker` value is introduced.
- 2026-08-04 — The user replaced a stored deployment-wide binding with a
  declarative one: trackers are listed in the repository's `shipit.yaml` and each
  appears as its own Issues tab. This removed the Settings connect flow, the
  credential-store field, connection-time validation, and the migration; it also
  dissolved the per-Project binding question, since the declaration travels with
  the repository. Two accepted consequences: `TrackerId` stops being a closed
  union, and with no connection step ShipIt no longer verifies that a declared
  repository is private.
- 2026-08-04 — The user required the declaration syntax to name the tracker kind
  explicitly rather than assuming GitHub Issues, since other trackers may be
  declared this way later (they cited Linear team assignment as a plausible case).
  An unrecognized `kind` is ignored with a warning so that a config written for a
  newer ShipIt does not break an older one.
- 2026-08-04 — To keep authorization simple, ShipIt relies on ordinary GitHub
  requests rather than proactive access or privacy polling, and does not verify
  each viewer's repository membership independently of the credential.
- 2026-08-04 — The user removed priority-label writing from this feature as
  orthogonal. Priority writes are to be supported for **both** GitHub
  destinations under [SHI-310](https://linear.app/shipit-ai/issue/SHI-310).
