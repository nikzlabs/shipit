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
   requirement 12.
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

   The workspace comes from the credential (req 23), not the declaration, so a
   `linear` entry identifies itself by team.

3. Both `github` and `linear` are supported kinds, and each is declared the same
   way.
4. A Linear tracker's team is part of its declaration. ShipIt's settings surface
   holds the credential and nothing that identifies a destination.
5. A `linear` declaration states the team's key (`SHI`), which is also the prefix
   its issue keys carry. That is what lets a bare `SHI-304` resolve to this
   declaration (req 10).
6. `name` is required, and unique within a repository. A destination is declared
   at most once: an entry naming a destination another entry already names is
   ignored with a warning (req 8), the same as any other malformed entry. Two
   names for one repository or team are not an alias — they are a mistake.
7. An entry whose `kind` this version of ShipIt does not recognize is ignored with
   a warning, rather than failing the session.
8. Declaration warnings — an unrecognized `kind`, a malformed entry, a duplicate
   `name` — surface in `shipit` CLI output, so the agent can fix the declaration
   or raise it with the user.
9. Each declaration appears as its own tab in the Issues UI, in declaration order.
   A repository may declare more than one.
9a. A tab shows the tracker's name, and nothing else — not the repository slug or
   team key behind it. A declaration may carry an optional `label` for the tab to
   show instead of its `name`, so an address like `planning` can read as
   "Planning" without becoming unaddressable.

## Naming a destination

10. ShipIt recognizes three reference forms, all resolving to the same issue:

    | Form | Example |
    |---|---|
    | tracker name + backend id | `roadmap#SHI-304`, `planning#123` |
    | tracker name + number | `roadmap#304` |
    | the backend's canonical issue address | `SHI-304`, `owner/repo#42` |

    Every backend's canonical address format is recognized — the one that backend's
    own users write and paste. This holds for kinds added later too: a new `kind`
    brings its canonical format with it, rather than being reachable only through a
    tracker name.
11. Recognizing an address is not the same as reaching it. A canonical address
    resolves through the declaration it identifies — a Linear key by its team prefix
    (req 5), a GitHub address by its `owner/repo` — and one that identifies no
    declared tracker fails closed, because requirement 1 leaves no destination
    outside the declarations except the session's own repository. Where more than
    one declaration matches, the reference is ambiguous and fails closed rather than
    resolving to one of them.

    Undoing a recorded write is the one exception: the card carries the destination
    its write reached, and reversing it stays available even after that destination
    stops being declared. Reversing a write grants no access the write did not
    already have.

    An undo acts on the destination it recorded, and is **not** re-targeted by a
    re-pointed name (the exception to requirement 16). If the name it was written
    with now points somewhere else, the undo fails rather than acting: the change
    being reversed belongs to the issue that was actually changed, and applying it
    to a different issue of the same number would write data that issue never had.
12. An operation that acts on an existing issue names its tracker by `name`. The
    single exception is the session's own repository's GitHub Issues, which needs
    no declaration and no name — though a repository may declare its own
    repository in order to give it one.
13. Creating an issue always names its destination. There is no default and no
    unnamed exception for a create, so an issue cannot be filed somewhere the
    caller did not name.
14. Renaming a tracking repository requires editing only that declaration's
    identifying field. No existing reference to its issues has to change.
15. Wherever ShipIt writes a reference itself, it writes the `name` form, and it
    instructs the agent to use that form in the text the agent authors — doc
    frontmatter, PR bodies and comments, chat prose. Any recognized form the agent
    writes still resolves (req 10); the instruction is what keeps generated
    references consistent, not a restriction enforced on the agent's text.
16. A reference resolves when it is used, not when it is written. Re-pointing a
    name at a different destination re-targets every reference written against it,
    recorded ones included — both the cards that record a write and the cards a
    lookup leaves in the transcript — and the UI shows what it now resolves to.

    In a name form that also carries a backend id (`planning#306`), **the name
    is authoritative and the embedded id is advisory**: after a re-point, the
    reference resolves through the name's current destination rather than failing
    on the now-mismatched id. This is what makes requirement 15's emitted form
    survive a re-point. It applies to resolving a *reference*; reversing a
    recorded write still acts on the issue that write actually touched (req 11).

## Routing safety

17. A named destination is used as named. ShipIt never substitutes another
    tracker for it, and never retries a failure against a fallback.
18. A destination that cannot be reached fails closed with an error that does not
    guess at the cause where the backend is ambiguous — GitHub returns the same
    response for "missing" and "inaccessible".
19. Every failure in requirements 11 and 18 — unresolvable reference, ambiguous
    reference, unreachable destination — surfaces where the operation was
    initiated: inline in the Issues UI for a user action, and in `shipit` CLI
    output for an agent action, alongside the declaration warnings of requirement 8.
    A failure is never silently dropped and never resolved to a guess.
20. These requirements are the whole specification. Behavior they do not state is
    not guaranteed, and anything that must hold is written here.

## Naming and disclosure

21. ShipIt itself writes an issue's details into three kinds of text: the pushed
    branch name, the comments it posts on an issue when a PR references or merges,
    and the cards it renders in its own UI. Where that text leaves both ShipIt and
    the tracker, it carries the reference and no other issue field — no title,
    body, comments, status, labels, or assignees. The branch name is the only such
    surface, and requirement 22 states its rule; ShipIt's own UI and the comments
    it posts back into the tracker are not restricted, since neither publishes
    anything the reader could not already see.
22. When a session starts from a tracker issue, the pushed branch name comes from
    the reference only, never from the issue title. This applies to every tracker
    issue: ShipIt cannot tell which trackers are private, so the rule is
    unconditional rather than a guess.

## Authorization

23. Tracker credentials are configured at deployment scope, and at Project scope
    once [Projects](../231-projects/requirements.md) ships. A declaration names a
    destination; it does not carry a credential.
24. The tracker's own service authorizes the credential; ShipIt adds no separate
    per-viewer membership check or tracker ACL. Anyone who can use the deployment —
    the Project, later — can therefore read and write a declared tracker regardless
    of their personal membership in it.
25. The user creates the tracker or repository and declares it. ShipIt neither
    creates nor initializes it.

## Open questions

None.

## Resolved questions

Receipts are carried forward from the superseded `247-private-github-issue-tracker`
doc, which held these requirements before the split; its full deliberation history
remains in git.

- 2026-08-05 — Asked whether undoing a recorded write should follow a re-pointed
  name, the user chose that **the undo fails**, reasoning that "the purpose of
  undo is to fix something the agent did a few minutes ago, not in a few months".
  Recorded in requirement 11 as the exception to requirement 16. Letting Undo keep
  reaching the original destination was rejected on that same reasoning: a write
  old enough to have outlived its declaration is not what Undo is for. Acting on
  the new destination was never viable — it would apply one issue's snapshot to
  another issue of the same number.

  This question was raised because two earlier decisions combined into a case
  neither considered, and answering it turned out to close a real defect rather
  than only settle wording: Undo previously preferred the recorded *name*, so a
  re-pointed `planning` sent the undo to a different **repository's** issue of the
  same number. Linear's team guard would have refused the equivalent attempt;
  GitHub had no such guard, so the wrong repository was silently rewritten — and
  a test asserted that behavior as correct.
- 2026-08-05 — Asked whether two declarations may name the same destination, the
  user chose to **refuse it**: a second entry pointing at a repository or team
  another entry already names is warned and skipped (req 6). Supporting aliases
  was rejected — it would mean identifying a *declaration* rather than the
  destination it points at, threading a new id through tabs, cards, routes and
  persisted rows, for a configuration nobody named a use for. Leaving it
  unspecified was rejected too: nothing would reject the config and the UI would
  stay visibly confused inside it.
- 2026-08-05 — Asked whether a Linear reference ShipIt wrote should survive
  re-pointing the name to another team, the user chose to **keep emitting
  `planning#306` and let the name win** (req 16): the embedded team key is
  advisory, so the reference re-targets instead of failing on the mismatch.
  Emitting `roadmap#304` instead — which would re-point cleanly with no
  precedence rule — was rejected in favour of keeping the form a Linear user
  recognizes. The accepted cost is that ShipIt now resolves past a reference whose
  two halves disagree, which is a deliberate exception to the fail-closed posture
  of requirements 11 and 17 rather than a hole in it. Accepting that Linear
  references simply do not re-point was also rejected.
- 2026-08-05 — Asked whether a recorded *read* card is a reference for
  requirement 16's purposes, the user chose **yes**: the jump-to-issue card
  records the name it was addressed through and re-resolves when clicked, exactly
  as a write card does. Exempting read cards as navigation aids was rejected —
  two cards for the same issue would then behave differently after a re-point.

- 2026-08-05 — Asked where a bare `shipit issue create` should file once there is
  no implicit fallback, the user chose to **require an explicit destination**
  (req 13), rather than letting it inherit req 12's unnamed exception or adding a
  declarable default. The reason is a footgun rather than tidiness: for a public
  code repository the unnamed destination is the *public* repo, so a forgotten flag
  would file a planning issue publicly — the thing
  [247](../247-shipit-private-planning/requirements.md) exists to prevent. A
  declarable create-default was rejected as re-introducing the implicit destination
  requirement 1 removes.
- 2026-08-05 — Asked whether Undo should still work on a card whose destination is
  no longer declared, the user chose **yes** — recorded in requirement 11 as its one
  exception. Reversing a write grants no access the write did not already have,
  since the card could only exist if the destination was declared when it was
  written; failing closed would instead strand every recorded action behind a
  config edit. This resolves the card-schema question that was open: a card records
  both the name it was written with (so req 16's re-point re-targets it) and the
  resolved destination (so an undeclared target stays undoable).
- 2026-08-06 — The user reported the Issues tab was too long (it rendered
  `planning · nikzlabs/shipit-planning`) and specified the fix: show the declared
  tab text from `shipit.yaml`, falling back to the `name` when there is none.
  Recorded as requirement 9a. Keeping the binding visible in the tab was rejected
  by that instruction; it survives as the tab's hover text, which costs no width.

  **This restores a requirement, rather than adding one.** The declaration
  carried an optional `label` ("optional; defaults to the repository name") in
  [247](../247-shipit-private-planning/requirements.md)'s requirement 5 before
  this feature was split out of it, and it shipped that way in v0.3.1
  (`5fbd3047`). The rework that introduced the required `name` (`06f5f757`)
  deleted the field with no receipt and no requirement saying to — `name` simply
  became both the address and the tab label, and the tab grew the `· <binding>`
  suffix to stay legible.

- 2026-08-06 — The field was first restored as `title`, on the reasoning that
  `label` reads as an *issue* label everywhere else in this codebase (`--label`,
  `IssueLabel`, the label filter). Shown that history, the user chose to keep the
  **original `label` spelling** instead. One name for one field beats a clearer
  name plus an alias to carry: a `shipit.yaml` written during the v0.3.1 window
  keeps parsing, the adapters' surviving `label` config lines up with the
  declaration that feeds it, and nothing has to explain why the same field has two
  names. The issue-label collision is confined to a doc comment on
  `declaredTrackerLabel()`.
- 2026-08-05 — Asked how deployments losing their Linear tab should be handled, the
  user chose a **clean break**: no migration warning and no auto-generated
  declaration. Writing to the user's `shipit.yaml` unprompted was rejected as
  something no other config path does.
- 2026-08-05 — Restored the self-declaration allowance to requirement 12. It had
  been recorded as a decision below and then dropped from the numbered list during
  an earlier restructuring, leaving only the receipt — so the requirement it
  documents was, briefly, not stated anywhere.
- 2026-08-05 — Reviewing this document, the user asked that requirements not
  describe how things used to work, since a reader would then need to know the
  previous implementation to follow them. Requirements 3, 4, 19 and 22 were
  restated as the state of the world rather than as a delta from it — "Linear is no
  longer a built-in default" became "both kinds are declared the same way", and the
  compatibility clause became "these requirements are the whole specification"
  instead of "existing behavior may break".
- 2026-08-05 — Asked what "ShipIt-generated text" meant, the vague phrase was
  replaced with the three places ShipIt actually writes an issue's details
  (req 21): the pushed branch name, the comments it posts on an issue at PR
  reference or merge (`issue-lifecycle.ts`), and its own UI cards. Only the branch
  name leaves both ShipIt and the tracker, so it is the only one the rule binds —
  which also corrected requirement 15, whose earlier wording claimed ShipIt writes
  references into PR bodies and docs. Those are agent-authored; ShipIt instructs
  the agent which form to use rather than writing them.
- 2026-08-05 — Asked where failures like an ambiguous reference surface, the user
  wanted this stated rather than left implicit. Requirement 18 now says every such
  failure appears where the operation was initiated — inline in the Issues UI for a
  user action, in `shipit` CLI output for an agent action — and is never dropped or
  guessed past.
- 2026-08-05 — The user removed the accepted-feature-set requirement as both
  inaccurate about current behavior and out of scope for this feature. Backend
  capability differences are no longer specified here; priority writes remain
  tracked as planning#312.
- 2026-08-05 — Asked whether GitHub's `owner/repo#42` stays recognized, the user
  generalized the answer: **every tracker's canonical issue address format is
  supported, current and future kinds alike** (req 10). So the third reference form
  is not a Linear special case — it is the rule that each backend's own way of
  writing an address keeps working, and a new `kind` brings its format with it.
  Requirement 11 was added to separate *recognizing* an address from *reaching* it:
  a well-formed address that identifies no declared tracker still fails closed,
  since requirement 1 leaves no destination outside the declarations.
- 2026-08-05 — Asked what a Linear reference looks like, the user chose to
  **recognize all three forms** — `planning#306`, `roadmap#304`, and the bare
  `planning#306` — rather than pick one (req 10), noting that the UI highlight and other
  surfaces need to match any of them and that the agent can simply be instructed
  which form to write (req 15). The user also moved the **Linear team binding out
  of the UI and into the declaration** (req 4), observing that the team prefix could
  be defined there — which is what makes the bare `SHI-304` resolvable to a
  declaration (req 5).
- 2026-08-05 — Asked whether the break with existing behavior is accepted, the
  user answered that ShipIt can "break everything, unless a specific behavior is in
  these requirements". Recorded as requirement 20, which inverts the usual default:
  compatibility is not assumed anywhere, and each surviving behavior is named. No
  migration path is owed for repositories that declare nothing, for
  `--tracker linear|github`, or for `shipit issue create`'s Linear default.
- 2026-08-05 — Reviewing this document, the user generalized it from GitHub to
  **all** issue trackers: `linear` becomes a declared `kind` and its built-in
  fallback is retired (req 3), and authorization is described per credential scope —
  global now, per Project later — rather than as a GitHub-specific gate (req 23).
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
  inside ShipIt, in the conversation, in PR body/comments, in docs" (req 15).
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
  the new destination and the UI shows it** (req 16), replacing an earlier
  guarantee that a recorded destination stays valid for what it resolved to when
  written. The accepted consequence is that re-pointing re-targets history,
  including a persisted Undo card's target. Freezing persisted routing while
  letting text follow the name, and freezing everything, were both rejected as more
  machinery than the case warrants.
- 2026-08-04 — Asked which issues get pointer-only branch names, the user chose
  **every issue** (req 22), so title-derived readable branch names go away for
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
  each viewer's membership independently of the credential (req 24).
- 2026-08-04 — The user removed priority-label writing from this feature as
  orthogonal. Priority writes are tracked under
  planning#312.
