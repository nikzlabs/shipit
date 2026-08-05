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
   requirement 11.
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

   The workspace comes from the credential (req 20), not the declaration, so a
   `linear` entry identifies itself by team.

3. Both `github` and `linear` are supported kinds. Linear is declared like any
   other tracker; it is no longer a built-in destination or a default.
4. A Linear tracker's team is declared here, not chosen in ShipIt's UI. The
   settings surface keeps the credential; it no longer carries a team binding.
5. A `linear` declaration states the team's key (`SHI`), which is also the prefix
   its issue keys carry. That is what lets a bare `SHI-304` resolve to this
   declaration (req 10).
6. `name` is required, and unique within a repository.
7. An entry whose `kind` this version of ShipIt does not recognize is ignored with
   a warning, rather than failing the session.
8. Declaration warnings — an unrecognized `kind`, a malformed entry, a duplicate
   `name` — surface in `shipit` CLI output, so the agent can fix the declaration
   or raise it with the user.
9. Each declaration appears as its own tab in the Issues UI, in declaration order.
   A repository may declare more than one.

## Naming a destination

10. ShipIt recognizes three reference forms, all resolving to the same issue:

    | Form | Example |
    |---|---|
    | tracker name + backend id | `roadmap#SHI-304`, `planning#123` |
    | tracker name + number | `roadmap#304` |
    | the backend's own id, unqualified | `SHI-304` |

    An unqualified id resolves through the declaration whose identity matches it —
    a Linear key by its team prefix (req 5). If more than one declaration matches,
    it is ambiguous and fails closed rather than picking one.
11. An operation names its tracker by `name`. The single exception is the session's
    own repository's GitHub Issues, which needs no declaration and no name.
12. Renaming a tracking repository requires editing only that declaration's
    identifying field. No existing reference to its issues has to change.
13. ShipIt writes the `name` form wherever it generates a reference: its own
    surfaces, the conversation, docs, and PR bodies and comments. Text the agent
    authors is not constrained by this — the agent writes whichever recognized form
    it is instructed to.
14. A reference resolves when it is used, not when it is written. Re-pointing a
    name at a different destination re-targets every reference written against it,
    recorded ones included, and the UI shows what it now resolves to.

## Routing safety

15. A named destination is used as named. ShipIt never substitutes another
    tracker for it, and never retries a failure against a fallback.
16. A destination that cannot be reached fails closed with an inline error that
    does not guess at the cause where the backend is ambiguous — GitHub returns
    the same response for "missing" and "inaccessible".
17. Nothing outside these requirements is preserved for backward compatibility.
    Existing behavior may break; where a specific behavior must survive, a
    requirement says so — requirement 10's unqualified form is the case that does.

## Naming and disclosure

18. ShipIt-generated text includes no issue fields beyond the reference itself —
    no title, body, comments, status, labels, or assignees.
19. When a session starts from a tracker issue, the pushed branch name comes from
    the reference only, never from the issue title. This applies to every tracker
    issue: ShipIt cannot tell which trackers are private, so the rule is
    unconditional rather than a guess.

## Authorization and feature set

20. Tracker credentials are configured globally for the deployment today, and per
    Project once [Projects](../231-projects/requirements.md) ships. A declaration
    names a destination; it does not carry a credential.
21. The tracker's own service authorizes the credential; ShipIt adds no separate
    per-viewer membership check or tracker ACL. Anyone who can use the deployment —
    the Project, later — can therefore read and write a declared tracker regardless
    of their personal membership in it.
22. The user creates the tracker or repository and declares it. ShipIt neither
    creates nor initializes it.
23. Each backend's feature set is accepted as-is; ShipIt does not emulate missing
    capabilities for parity. An unavailable operation is omitted or disabled with
    an inline explanation, and never silently no-ops or reports false success.

## Open questions

- **Does the unqualified GitHub form (`owner/repo#42`) stay recognized?**
  Requirement 10 keeps the unqualified *Linear* key because the user named it.
  Its GitHub counterpart is the analogous case — a form users paste from the
  GitHub UI — but it was not named, and requirement 17 says nothing survives
  unless a requirement says so. Recognizing it costs little and it resolves
  unambiguously; dropping it is also coherent.

## Resolved questions

Receipts are carried forward from the superseded `247-private-github-issue-tracker`
doc, which held these requirements before the split; its full deliberation history
remains in git.

- 2026-08-05 — Asked what a Linear reference looks like, the user chose to
  **recognize all three forms** — `roadmap#SHI-304`, `roadmap#304`, and the bare
  `SHI-304` — rather than pick one (req 10), noting that the UI highlight and other
  surfaces need to match any of them and that the agent can simply be instructed
  which form to write (req 13). The user also moved the **Linear team binding out
  of the UI and into the declaration** (req 4), observing that the team prefix could
  be defined there — which is what makes the bare `SHI-304` resolvable to a
  declaration (req 5).
- 2026-08-05 — Asked whether the break with existing behavior is accepted, the
  user answered that ShipIt can "break everything, unless a specific behavior is in
  these requirements". Recorded as requirement 17, which inverts the usual default:
  compatibility is not assumed anywhere, and each surviving behavior is named. No
  migration path is owed for repositories that declare nothing, for
  `--tracker linear|github`, or for `shipit issue create`'s Linear default.
- 2026-08-05 — Reviewing this document, the user generalized it from GitHub to
  **all** issue trackers: `linear` becomes a declared `kind` and its built-in
  fallback is retired (req 3), and authorization is described per credential scope —
  global now, per Project later — rather than as a GitHub-specific gate (req 20).
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
  `shipit` CLI output (req 8), so the agent can repair a bad declaration or raise
  it with the user rather than the warning being swallowed.
- 2026-08-05 — Asked which form ShipIt writes when it generates a reference
  itself, the user chose **the tracker name everywhere** — "this slug needs to work
  inside ShipIt, in the conversation, in PR body/comments, in docs" (req 13).
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
  the new destination and the UI shows it** (req 14), replacing an earlier
  guarantee that a recorded destination stays valid for what it resolved to when
  written. The accepted consequence is that re-pointing re-targets history,
  including a persisted Undo card's target. Freezing persisted routing while
  letting text follow the name, and freezing everything, were both rejected as more
  machinery than the case warrants.
- 2026-08-04 — Asked which issues get pointer-only branch names, the user chose
  **every issue** (req 19), so title-derived readable branch names go away for
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
  is ignored with a warning (req 7) so a config written for a newer ShipIt does not
  break an older one.
- 2026-08-04 — To keep authorization simple, ShipIt relies on ordinary tracker
  requests rather than proactive access or privacy polling, and does not verify
  each viewer's membership independently of the credential (req 21).
- 2026-08-04 — The user removed priority-label writing from this feature as
  orthogonal. Priority writes are tracked under
  [SHI-310](https://linear.app/shipit-ai/issue/SHI-310).
