# Declared issue trackers — product requirements

A repository declares which issue trackers it uses, and every operation and
reference names the tracker it acts on. This is the platform mechanism; it applies
to any repository edited inside ShipIt and to every tracker backend, not just
GitHub. ShipIt's own use of it — a private planning repository, and the migration
off Linear — is a separate feature
([247](../247-shipit-private-planning/requirements.md)).

## Declarations

1. Every issue tracker a repository uses is declared in its `shipit.yaml`. ShipIt
   has no built-in tracker and no implicit fallback: the trackers available to a
   session are the ones its repository declared, plus the one exception in
   requirement 8.
2. Each entry states its `kind` and its `name`. `kind` selects the backend; the
   remaining fields are whatever that kind needs to identify itself; `name` is how
   everything else addresses it.

   ```yaml
   issues:
     trackers:
       - kind: github
         repo: owner/planning
         name: planning
       - kind: linear
         team: SHI                # Linear binds a tracker to one team
         name: roadmap
   ```

   The workspace comes from the credential (req 16), not the declaration, so a
   `linear` entry identifies itself by team.

3. Both `github` and `linear` are supported kinds. Linear is declared like any
   other tracker; it is no longer a built-in destination or a default.
4. `name` is required, and unique within a repository.
5. An entry whose `kind` this version of ShipIt does not recognize is ignored with
   a warning, rather than failing the session.
6. Declaration warnings — an unrecognized `kind`, a malformed entry, a duplicate
   `name` — surface in `shipit` CLI output, so the agent can fix the declaration
   or raise it with the user.
7. Each declaration appears as its own tab in the Issues UI, in declaration order.
   A repository may declare more than one.

## Naming a destination

8. Every issue operation and every reference names its tracker by `name`, as
   `planning#123`. The single exception is the session's own repository's GitHub
   Issues, which needs no declaration and no name.
9. Renaming a tracking repository requires editing only that declaration's
   identifying field. No existing reference to its issues has to change.
10. ShipIt writes the `name` form wherever it generates a reference: its own
    surfaces, the conversation, docs, and PR bodies and comments.
11. A reference resolves when it is used, not when it is written. Re-pointing a
    name at a different repository re-targets every reference written against it,
    recorded ones included, and the UI shows what it now resolves to.

## Routing safety

12. A named destination is used as named. ShipIt never substitutes another
    tracker for it, and never retries a failure against a fallback.
13. A destination that cannot be reached fails closed with an inline error that
    does not guess at the cause where the backend is ambiguous — GitHub returns
    the same response for "missing" and "inaccessible".

## Naming and disclosure

14. ShipIt-generated text includes no issue fields beyond the reference itself —
    no title, body, comments, status, labels, or assignees.
15. When a session starts from a tracker issue, the pushed branch name comes from
    the reference only, never from the issue title. This applies to every tracker
    issue: ShipIt cannot tell which trackers are private, so the rule is
    unconditional rather than a guess.

## Authorization and feature set

16. Tracker credentials are configured globally for the deployment today, and per
    Project once [Projects](../231-projects/requirements.md) ships. A declaration
    names a destination; it does not carry a credential.
17. The tracker's own service authorizes the credential; ShipIt adds no separate
    per-viewer membership check or tracker ACL. Anyone who can use the deployment —
    the Project, later — can therefore read and write a declared tracker regardless
    of their personal membership in it.
18. The user creates the tracker or repository and declares it. ShipIt neither
    creates nor initializes it.
19. Each backend's feature set is accepted as-is; ShipIt does not emulate missing
    capabilities for parity. An unavailable operation is omitted or disabled with
    an inline explanation, and never silently no-ops or reports false success.

## Open questions

- **What goes after the `#` for a Linear issue?** A Linear key like `SHI-304` is
  unique only within its workspace: the team prefix is unique per workspace, and
  the number per team. Today ShipIt binds one token and one team, so a bare
  `SHI-304` happens to be unambiguous — but once Linear is declared like any other
  tracker, a repository can declare two of them, and the bare key collides exactly
  the way GitHub's bare `#42` does. Requirement 8 already answers *that* half: the
  reference names its tracker. What is unsettled is the tail — `roadmap#SHI-304`
  keeps the key legible and searchable, `roadmap#304` is consistent with GitHub and
  puts the team wholly in the declaration. This has to be settled before Linear can
  be declared.
- **Requirements 1, 3 and 8 are a breaking change — is that accepted, and does
  anything keep working?** Today every repository edited inside ShipIt gets Linear
  and its own GitHub Issues without declaring anything, `shipit issue create`
  defaults to Linear, `--tracker linear|github` selects a backend, and pointers are
  written `SHI-28` or `owner/repo#42`. Under these requirements a repository that
  declares nothing has only its own GitHub Issues, and existing pointers name no
  tracker. Whether the old pointer forms continue to resolve, and whether existing
  repositories need a declaration added, are not decided here.

## Resolved questions

Receipts are carried forward from the superseded `247-private-github-issue-tracker`
doc, which held these requirements before the split; its full deliberation history
remains in git.

- 2026-08-05 — Reviewing this document, the user generalized it from GitHub to
  **all** issue trackers: `linear` becomes a declared `kind` and its built-in
  fallback is retired (req 3), and authorization is described per credential scope —
  global now, per Project later — rather than as a GitHub-specific gate (req 16).
- 2026-08-05 — The user replaced `--repo owner/name` with **naming the tracker**,
  and made the declaration field **mandatory** (reqs 4, 8), with the session's own
  GitHub Issues as the one exception that needs no declaration. Offered `name` or
  `ref` for the field, this doc uses **`name`** — it names a destination, and it is
  what both a declaration and a reference call it. This supersedes two earlier
  decisions: that `--repo` may name **any** repository the credential can reach
  (reachability is now what the repository declared), and that a declaration is
  purely additive and cannot change where an existing operation writes (requirement
  1 removes the implicit fallback, so it can).
- 2026-08-05 — The user asked where declaration warnings surface and specified
  `shipit` CLI output (req 6), so the agent can repair a bad declaration or raise
  it with the user rather than the warning being swallowed.
- 2026-08-05 — Asked which form ShipIt writes when it generates a reference
  itself, the user chose **the tracker name everywhere** — "this slug needs to work
  inside ShipIt, in the conversation, in PR body/comments, in docs" (req 10).
  Emitting it only on in-repo surfaces while keeping a fully qualified slug in
  public PR bodies, and treating it as an input-only form, were both rejected. Two
  accepted costs: GitHub cannot linkify `planning#42`, so the reference is plain
  text anywhere outside ShipIt; and a name does not make a repository secret, since
  the `name → destination` mapping is published in the committed `shipit.yaml`.
- 2026-08-05 — Asked whether names cover the session's own code repository, the
  user scoped them to declared trackers, and added that a repository must be able
  to declare *its own* repository to give it a name. That is a behavior change: the
  shipped registry deliberately skips a declaration matching the session's own
  repo, so a self-declaration is currently discarded.
- 2026-08-05 — Asked what happens to already-recorded references when a name is
  later pointed at a different repository, the user chose **the links resolve to
  the new destination and the UI shows it** (req 11), replacing an earlier
  guarantee that a recorded destination stays valid for what it resolved to when
  written. The accepted consequence is that re-pointing re-targets history,
  including a persisted Undo card's target. Freezing persisted routing while
  letting text follow the name, and freezing everything, were both rejected as more
  machinery than the case warrants.
- 2026-08-04 — Asked which issues get pointer-only branch names, the user chose
  **every issue** (req 15), so title-derived readable branch names go away for
  every tracker. Scoping the rule to declared trackers, adding an explicit
  `private: true` opt-in, and dropping the requirement were all rejected. Public PR
  *titles* are not covered: the agent writes them with `gh pr create -t`, so ShipIt
  generates no PR title to derive.
- 2026-08-04 — The user replaced a planned separate tracker identity with naming
  the destination on the operation, so no extra tracker id or sub-tab name is
  introduced. (The spelling later became the mandatory `name` — see above.)
- 2026-08-04 — The user replaced a stored deployment-wide binding with a
  declarative one (req 1). This removed the Settings connect flow, the
  credential-store field, connection-time validation, and the migration; it also
  dissolved the per-Project binding question, since the declaration travels with
  the repository. Two accepted consequences: `TrackerId` stops being a closed
  union, and with no connection step ShipIt does not verify that a declared
  repository is private.
- 2026-08-04 — The user required the declaration syntax to name the tracker kind
  explicitly rather than assuming GitHub Issues (req 2), citing Linear as a
  plausible later case — which requirement 3 now makes real. An unrecognized `kind`
  is ignored with a warning (req 5) so a config written for a newer ShipIt does not
  break an older one.
- 2026-08-04 — To keep authorization simple, ShipIt relies on ordinary tracker
  requests rather than proactive access or privacy polling, and does not verify
  each viewer's membership independently of the credential (req 17).
- 2026-08-04 — The user removed priority-label writing from this feature as
  orthogonal. Priority writes are tracked under
  [SHI-310](https://linear.app/shipit-ai/issue/SHI-310).
