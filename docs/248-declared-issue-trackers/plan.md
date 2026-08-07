---
issue: https://linear.app/shipit-ai/issue/SHI-318
title: Declared issue trackers
description: Declare every issue tracker in shipit.yaml, address destinations by name, and resolve references through the declarations.
---

# 248 — Declared issue trackers

Implements [requirements.md](./requirements.md). ShipIt's own use of the mechanism
is [247](../247-shipit-private-planning/plan.md); the comparison that led here is
the [evaluation](../246-native-issue-tracker-evaluation/plan.md).

## Status

**Implemented.** A first version shipped as an additive GitHub-only feature; the
requirements then became general and non-additive, and this document describes
the reworked mechanism as built. Everything below is the state of the code, not a
plan — where the implementation diverged from the design that led to it, the
divergence is called out inline.

One part of the shipped design survives unchanged and carries the rest: the
destination lives in the tracker id. Everything else — how trackers come into
existence, how an operation names one, and what a reference resolves through —
changes.

Requirement 20 means the rework owes nothing to the current CLI surface, the
implicit Linear destination, or the `--tracker` flag.

## What carries over: the destination lives in the tracker id

The shipped implementation collapsed onto one idea. `TrackerId` is not a closed
union: `` `github:${owner}/${repo}` `` names a destination explicitly, and every
surface already round-trips the id, so a single widening routed all of them at
once:

| Surface | Why it routes correctly |
|---|---|
| `?tracker=` on the routes + `/agent-ops/issue/*` | Carries the id verbatim; the relay is a pass-through, so no schema change. |
| `IssueWriteCard.tracker`, persisted in chat history | Undo resolves `card.tracker`, so it replays against the destination the write hit — no column, no migration. |
| `parseIssueRef` dedup key (`tracker:issueId`) | Qualified for free, so `a/x#42` and `b/y#42` stop colliding. |
| PR-body `Closes` / `Refs` pointers | `parsePrBodyIssueRefs` delegates to `parseIssueRef` and inherits the destination. |
| The Issues sub-tab | Already keyed by tracker id. |

The rejected alternative — a `repo` field beside `tracker: "github"` — re-creates
the bug it was meant to fix: a display-ish `tracker` next to the real routing data
invites the reduction the invariant forbids, and it needs a persisted-card field,
a DB migration, and a legacy-card path. Comparisons go through
`isGitHubTracker(id)` in `shared/tracker-id.ts`, never `=== "github"`.

**This is the substrate for names.** A name resolves to a tracker id; nothing
downstream of resolution needs to learn what a name is. The rework is therefore
concentrated at two seams — where trackers are built, and where a reference is
turned into an id — rather than spread through the operation paths.

## Destination identity is routing data

Unchanged from the shipped design, and still the point of the feature:

1. A destination named by an operation is used as named, verbatim (req 17).
2. ShipIt never substitutes one destination for another, and never retries a
   failure against a fallback (req 17).
3. An unreachable destination fails closed with no fallback (req 18).
4. Every identity key derived from an issue — parser deduplication, persisted
   merge-effect guards, deterministic card IDs — includes the destination as well
   as the issue number.

These hold for reads and mutations alike, including Undo and post-merge effects.
The destination is resolved at the operation boundary and captured for
asynchronous work, never reread from whichever session is active later.

The bug this exists to prevent: the pointer parser used to keep `owner/repo` in a
display string while downstream services got a bare number and rebuilt context
from the code remote — so `other-owner/other-repo#42` could mutate the session
repository's issue `#42`.

## The rework

### 1. Every tracker is declared (reqs 1, 3–5)

Today `buildTrackerRegistry` constructs a `LinearTracker` unconditionally from
`credentialStore.getLinearToken()` and `getLinearTeam()`, and a bare-`github`
tracker from the session's remote. Linear is therefore present in every session
whether or not the repository wants it.

Under req 1 the registry is built from the declarations plus the session's own
repository. `kind: linear` becomes a declared backend identified by its team key
(req 5), which means:

- **The team binding moves out of `CredentialStore` into the declaration** (req 4).
  `getLinearTeam` / `setLinearTeam` and the stored `linear.team` field retire, as
  does the team picker in `SettingsTrackers.tsx`. Settings keeps the token.
  `listLinearTeams` stays useful — but as a lookup for *writing* a declaration,
  not as a picker that persists a binding. The card is **workspace-scoped and
  renders nothing repository-scoped**: it briefly carried a `shipit.yaml`
  declaration snippet, which is per-repository configuration in a dialog that has
  no repository, so that came back out. Repo-scoped tracker state surfaces where
  it is actionable — the Issues tab's declared sub-tabs — and repo-scoped settings
  belong in the Project Settings dialog.
- **`LinearTracker` takes its team from its declaration**, so a repository can
  declare two Linear trackers on different teams. Its `isConfigured()` already
  requires a token and a team; the team now arrives from config rather than
  storage.
- Deployments with a stored team lose their Linear tab until the repository
  declares one. That is a **clean break** by decision: no auto-generated
  declaration, no migration warning. It is the one change a user notices without
  doing anything, and the only signal is the tab's absence.

#### The tab shows a label, not an address (req 9a)

A declaration's `name` is an **address**: it has to be writable as `planning#42`,
so it is a reference-safe slug and reads like one. The Issues sub-tab rendered
`name · <backend key>` — `planning · nikzlabs/shipit-planning` — which
spent most of a narrow panel's width on the repository slug, and pushed a
two-tracker bar past the panel edge.

So a declaration carries an optional `label`, purely cosmetic, and the tab shows
`label ?? name` and nothing else. Keeping them separate fields is the point: a
tab label wants a human heading ("Planning") and takes no character-set
constraint, while widening `name` to allow one would make some names unwritable
as references. The binding survives as the tab's `title=` hover text, which costs
no width.

A bad `label` (blank, non-string) warns and falls back to the name rather than
dropping the declaration — unlike the identifying fields, a cosmetic one must not
cost a repository its tracker. Path: `declaredTrackerLabel()`
(`declared-tracker.ts`) → `buildTrackerRegistry` → the adapters' existing
`label` config → `TrackerInfo.label` → `IssuesViewer`'s sub-tab.

*This is a restoration, under the original name.* The pre-split version of this
feature (docs/247, shipped in v0.3.1 as `5fbd3047`) had exactly this field,
spelled `label` and defaulting to the repository name. Introducing the required
`name` (`06f5f757`) dropped it — silently: no requirement asked for the removal
and no receipt recorded it, so `name` became both the address and the tab label
and the `· <binding>` suffix appeared to keep the tab legible. The giveaway that
the drop was accidental is that `GitHubTrackerConfig.label` /
`LinearTrackerConfig.label` survived the rework with nothing left to feed them —
that dead parameter is the one the declaration feeds again, so the adapters
needed no change.

Restoring the exact spelling was chosen over a clearer `title`: a `shipit.yaml`
written during the v0.3.1 window parses as-is, there is no alias to maintain, and
the config field lines up with the adapter parameter it feeds. The cost is that a
tracker's `label` sits near issue labels in the vocabulary — confined to the
`declaredTrackerLabel()` docstring, which is the only place the two meet.

### 2. A destination is addressed by name (reqs 6, 12)

`--repo owner/name` goes away, replaced by the declared name. The session's own
repository stays the one unnamed destination for operations that act on an
existing issue — but **`create` always names its destination** (req 13). Without
that carve-out, a forgotten flag files into the session's own repository, which for
a public repo means filing a planning issue publicly; the whole point of
[247](../247-shipit-private-planning/plan.md) is that this cannot happen by
omission.

This inverts an asymmetry the shipped registry documents at length. `get()`
currently **synthesizes** a tracker for any well-formed `github:owner/repo` id it
does not hold, precisely so `--repo` could reach any repository the credential can
see. Req 11 forbids exactly that: an address identifying no declared tracker fails
closed. So the synthesizer is deleted and `get()` narrows to the registered set —
`list()` and `get()` stop disagreeing.

Undo is carved out of that (req 11). The registry docstring currently sells the
synthesizer as load-bearing precisely because it let a persisted card resolve
`github:owner/repo` with no extra state, and dropping it would have stranded every
Undo written against a destination the repository later stopped declaring.
Reversing a write grants no access the write did not already have — the card could
only exist if the destination was declared when it was written — so an Undo
resolves against the destination recorded on the card, declared or not. That path
keeps its own resolution and needs its own test.

**What a card therefore stores.** Two requirements pull in different directions
and together settle the schema:

- Req 16 — a *re-pointed* name re-targets recorded references, so the card must
  remember the **name** it was written with, or it would stay pinned to the old
  destination.
- Req 11 — an *undeclared* destination must still be undoable, so the card must
  also remember the **resolved destination**, or it would have nothing to fall
  back to.

So a card records both. A card written from a canonical address has no name and
simply uses the destination.

**Undo, however, uses the destination — not the name.** An earlier reading had
Undo prefer the name so that req 16's re-point would re-target it too; that turned
out to be wrong, and dangerous. The snapshot an undo restores belongs to the issue
that was actually changed, so following a re-pointed name applies it to a
different issue of the same number. On Linear the team guard refuses the attempt;
on GitHub nothing did, and the wrong repository's issue was silently rewritten.
Undo therefore acts on `card.tracker`, and **refuses** when `card.trackerName`
now points somewhere else — "undo is for fixing something done minutes ago, not
months ago" (req 11). A name that no longer resolves at all is not a conflict:
that is req 11's original carve-out and the undo proceeds.

### 3. References resolve through the declarations (reqs 10, 11, 15, 16)

Three forms resolve: `planning#123`, `roadmap#304`, and each backend's canonical
address (`SHI-304`, `owner/repo#42`).

`name#123` is a free slot in the existing grammar — `GITHUB_SHORT_RE` requires the
slash, and bare `#42` is deliberately rejected as ambiguous — so no existing form
becomes ambiguous by adding it.

The structural problem is that **`parseIssueRef` is pure and context-free**, which
is why the client chip and the server shim share it. A name cannot be resolved
without the declarations. Two shapes:

- thread a context parameter through every call site, or
- **resolve in a thin layer above the parser**, which stays pure.

Prefer the second. `parseIssueRef` keeps answering "what shape is this string",
and a resolver answers "which declared tracker does that identify" — which is also
where req 11's fail-closed and ambiguity rules live, in one place rather than at
each caller.

The call sites to audit, all current:

| Site | Needs |
|---|---|
| `client/utils/tracker-link.ts` | resolution — it decides what a chip links to |
| `client/components/DocsViewer.tsx` | resolution — `issue:` frontmatter |
| `client/components/MarkdownSelectionComments/FrontmatterHeader.tsx` | resolution |
| `server/shared/pr-issue-refs.ts` | resolution — `Closes`/`Refs` destinations |
| `server/session/agent-shim/shipit-issue.ts` (3 uses) | resolution — pointers and `--parent` |
| `server/orchestrator/issue-lifecycle.ts` | resolution — seed and merge effects |

The client sites need the declarations in the browser. They are already fetched
for the tab list, so the resolver should read from that same store rather than a
second fetch.

**Emitting the name (req 15).** Only two places in the codebase produce a
reference string: `parseIssueRef`'s four branches, and `github/adapter.ts`, which
builds `${owner}/${repo}#${number}` from an API response. That is a much smaller
surface than "everywhere a reference is shown", and it is the argument for a single
formatter — both producers should call it, so a name is rendered wherever the
destination has one. The agent's own text is not rewritten; ShipIt instructs it
which form to write (req 15), which is an `agent-instructions` change, not a code
path.

**Resolution happens at use (req 16).** Nothing pins a name to what it resolved to
when written: `resolveIssueRef` consults only the declarations as they are *now*,
so a chip, a `Closes` line or a read card written months ago opens whatever its
name means today. A card records `trackerName` alongside `tracker` to make that
possible.

The exception is the **Undo target**, which is not a reference but a reverse-write
against a specific issue: `getRecorded(id)` uses the recorded destination, and
`undoIssueWrite` refuses when the recorded name has since moved (req 11).

*Client follow-up (SHI-321).* "At use" holds server-side because
`readDeclaredTrackers` re-reads `shipit.yaml` on every request, but the browser's
copy of that list is a cached fetch, so an edit made with the app open used to
resolve against the previous declarations until a session switch or an
Issues-tab re-activation. The refresh now hangs off the change event the file
watcher already delivers: `handleFilesChanged` (`client/hooks/message-handlers/
files-changed.ts`) sees `shipit.yaml` in a `files_changed` batch and re-runs
`fetchTrackers()`, which reports whether the declared set actually changed so the
issue *list* — a real tracker-API round-trip, unlike the local-file
`GET /api/trackers` — is refetched only when it did and the tab is showing.
Subscribed consumers (the PR card reads `useIssuesStore((s) => s.trackers)`)
re-resolve immediately; the render-time `getState()` readers (doc chips,
markdown links, kept non-reactive so they don't defeat the `MarkdownContent`
memo) resolve correctly from their next render on. Local mode (`RUNTIME_MODE=
local`, the dogfood inner ShipIt) runs no file watcher at all, so there the older
session-switch/tab-activation refresh remains the only trigger — the same
documented degradation as the file tree and terminal.

*Client follow-up (SHI-325) — the browser's copy also has to be **dropped**, not
just refreshed.* An issue opened in the Issues tab survived a switch to a session
on another repository, leaving a destination the new session cannot reach on
screen (req 11 fails closed). Two halves, because neither is sufficient alone:

- **`fetchTrackers` is the authoritative check.** What the store holds for a
  tracker id survives only while that id still names the *same destination* —
  same `kind`, same `binding.key`. Presence of the id is deliberately not the
  test: the session's own repository's GitHub Issues are the bare `github` id in
  **every** repository (req 12), so a cross-repo switch changes the destination
  without changing the id, and an open issue would otherwise keep rendering — and
  refreshing, and mutating — against the *other* repository's issue of the same
  number. That is the same failure the pointer parser was fixed for. A re-pointed
  `name` is the same case and is caught by the same comparison. Unreachable
  entries are dropped from `issuesByTracker`/`statusesByTracker`/`labelsByTracker`
  and the open detail closes back to the list; a tracker that still names the same
  destination keeps its cache.
- **`setRepoScope` covers the window before that answer arrives.** The check
  above needs a round-trip, and until it lands the previous repository's detail
  and sub-tabs would still be painted. So a session switch to a *different*
  repository synchronously drops the store's repo-scoped contents — including the
  declared-tracker list, which is also `trackerDestinations()`, the resolution
  context every inline issue chip renders against. It is called from
  `resetSessionState`/`resumeSessionInternal` (`stores/actions/session-actions.ts`,
  the repo's one place for cross-store resets) and is a no-op within one
  repository, so switching between two sessions of the same project leaves the
  open issue alone. A session the sidebar list doesn't know yet re-scopes rather
  than borrowing the sidebar's active repo, which is only a guess. During the
  window the panel renders "Loading issues…" — neither "not connected" nor the
  previous repository's trackers is true there.

The list is repo-scoped for the same reason the detail is, so the session-change
effect in `App` now refetches it when the tab is open; keyed on `rightTab`, the
fetch-on-open effect never re-ran for a switch that left the tab open, and the
GitHub tab kept the previous repository's issues.

*Divergence from the design:* this was expected to need a database migration. It
does not. `IssueWriteCard` is persisted as a JSON blob in the existing
`issue_write` column (`chat-history.ts` `toRow`/`fromRow`), so a new optional
field round-trips with no column and no migration — and, because no new
`PersistedMessage` field was added, none of the `CARD_MESSAGE_FIELDS` /
`EVERY_OPTIONAL_FIELD_MESSAGE` guards apply either. The rework touches no
database schema at all.

### 4. Failures surface where the operation started (reqs 8, 19)

Declaration warnings today reach two places, neither of them the agent:
`service-manager-setup.ts` posts a "shipit.yaml needs migration" chat message, and
`diagnostics.ts` exposes `cfg.warnings`. Req 8 puts them in `shipit` CLI output so
the agent can repair a declaration; req 19 extends the same rule to resolution and
reachability failures — inline in the Issues UI for a user action (the viewer
already renders an inline error bar), in CLI output for an agent action.

## Configuration

Trackers are declared in the repository's `shipit.yaml`, alongside `agent`,
`compose`, and `release`. Each entry is a tagged union on `kind` — the same
discriminator the issue domain types use for `IssueWriteUndo` — so the identifying
fields belong to the kind and a backend identified by something other than a
repository needs no reshaping. An unrecognized `kind` is skipped with a warning, so
a config written against a newer ShipIt degrades instead of failing the session.

This is the pattern the product already uses for stack shape: declared in the repo,
versioned with it, reconciled by ShipIt. It buys **no configuration subsystem** (no
connect flow, no credential-store binding, no validation endpoint, no migration),
**Project scoping for free** (`shipit.yaml` is per repository, so
[Projects](../231-projects/plan.md) needs no tracker work), and **plurality at no
cost**.

Because nothing is saved, there is no moment at which to validate. ShipIt does not
check that a declared destination exists, is private, or has Issues enabled; a
declaration is exercised by ordinary requests and its tab surfaces an inline error
when one fails. Two accepted consequences: declaring a *public* repository is not
caught, and on a public repository the committed `shipit.yaml` discloses what it
declares.

## Authentication

Tracker calls use the same contextual credential as ShipIt's other operations
against that backend: the deployment credential now, the owning Project's after
Projects phase 1c. There is no second tracker credential, no tracker ACL, and no
per-viewer membership check — the backend authorizes the credential, not the
viewer (req 24).

For GitHub the credential is the **account-wide** token
(`githubAuthManager.getToken()`), not the repo-scoped installation token, so a
fine-grained PAT scoped to one repository fails on every other one. For Linear the
token defines the workspace, which is why a declaration identifies a *team* and
not a workspace.

Credentials stay outside session containers. GitHub returns `404` for a private
repository the credential cannot see, so "missing" and "inaccessible" are
indistinguishable and the error names both. Repository-scoped `403`s are also
access failures. Neither invalidates otherwise valid credentials; only an
authentication failure may. There is no poller and no periodic visibility check.

## Open design points

Mechanism choices, not requirements questions:

All four are now settled; recorded here with the reasoning that settled them.

- **Duplicate names** — the parser drops the second entry with a warning and keeps
  the first, so a duplicate never mints two destinations under one name. The
  resolver *also* fails closed on a duplicate it is somehow handed, because the
  parser is not the only way a destination list can be built (the browser builds
  one from `TrackerInfo[]`).
- **A name colliding with a GitHub owner name** — allowed, with no warning.
  `acme#3` and `acme/planning#3` are distinguished by the slash and can never
  collide in the grammar, so a warning would only be noise; and ShipIt has no way
  to know GitHub's owner namespace to check against.
- **How an unresolvable reference renders** — it stays exactly what it already
  was, and never becomes an in-app link. A markdown href keeps its ordinary
  external link (`tracker-link.ts` returns `null`); a doc's `issue:` chip and a
  PR card's related-issue chip render a static badge; a bare Linear key in prose
  stays plain text. The CLI reports the failure with the declared names listed.
- **Whether a card records the name** — yes, `trackerName`; see §3.

## Key files

Current state; each is a rework site unless noted.

- `src/server/shared/tracker-id.ts` — qualified-id vocabulary. **Carries over.**
- `src/server/shared/declared-tracker.ts` — **new.** The `DeclaredTracker` union,
  `TrackerDestination`, and the pure declaration→destination helpers. Split out of
  `shipit-config.ts` because that module imports `node:fs`, and both the resolver
  and the browser need the shape without it.
- `src/server/shared/shipit-config.ts` — `parseIssuesConfig`. Gains `name`,
  `kind: linear`, and the team field; re-exports the types. Nothing here throws: a
  declaration gates a tab, not the container.
- `src/server/shared/issue-ref.ts` — stays pure and context-free. Gains the two
  name forms and `formatIssueReference`, the single reference producer (req 15).
- `src/server/shared/issue-ref-resolution.ts` — **new.** The resolver layer:
  `resolveIssueRef`, `resolveParsedIssueRef`, `resolveDestinationByName`, and
  requirement 11's fail-closed/ambiguity rules.
- `src/server/shared/pr-issue-refs.ts` — unchanged; `issue-lifecycle.ts` resolves
  the references it finds.
- `src/server/orchestrator/trackers/registry.ts` — the largest change: built from
  declarations, the self-declaration skip is gone (it now *replaces* the unnamed
  tab), the `get()` synthesizer is deleted, and `getRecorded()` is the Undo
  carve-out. `destinations()` is the resolution context every caller reads.
- `src/server/orchestrator/trackers/linear/adapter.ts` — team from declaration
  rather than `CredentialStore`.
- `src/server/orchestrator/trackers/github/adapter.ts` — `accessError()` carries
  over; `identifier` construction moves to the shared formatter.
- `src/server/orchestrator/credential-store.ts` — `getLinearTeam`/`setLinearTeam`
  and the stored `linear.team` retire.
- `src/client/components/SettingsTrackers.tsx` — team picker retires; the card
  stays credential-only (no repository-scoped declaration content).
- `src/server/orchestrator/api-routes-issues.ts` — `resolveGitHubTrackerContext`
  reads `shipit.yaml` per request (uncached, so editing the file changes tabs on
  the next request; a parse failure degrades to no declarations). **Carries over.**
- `src/server/orchestrator/issue-lifecycle.ts` — resolves destinations from the
  pointer, which is what lets a `Closes` line target a different repository than
  the PR's own (GitHub never closes cross-repository itself). **Carries over**,
  with resolution routed through the new layer.
- `src/server/session/agent-shim/shipit-issue.ts` — `--repo` and the
  `github|linear` `--tracker` vocabulary are gone; `--tracker` names a declared
  tracker. The shim fetches the destinations from a new
  `GET /api/sessions/:id/issue/trackers` (relayed as `/agent-ops/issue/trackers`)
  and resolves references **locally** against them, which is what lets a routing
  failure be reported in CLI output with the declared names in hand (reqs 8, 19)
  instead of arriving as an opaque 404 from a write that should never have run.
- `src/server/orchestrator/services/headless-sessions.ts` — `seedFromIssueRef`
  builds the branch from the identifier alone (req 22). **Carries over.**
- `src/server/orchestrator/services/issue-seeded-session.ts` — the same
  derivation applied on the **in-app** path (SHI-320). The Issues tab prefills
  the composer rather than creating the session (docs/236), so the issue reaches
  ShipIt on the first message; `handleSendMessage`'s warm graduation renames the
  claimed branch to `seedFromIssueRef`'s pointer slug and pins the title, which
  is what stops AI naming from deriving a branch from a prompt that opens with
  the issue's title. The same message fires `markIssueStartedFromSeed`.
  **Carries over**, with req 22 now held on both session-start paths rather than
  only the headless one.
- `src/client/stores/issues-store.ts` — `trackerDestinations()` /
  `resolveUiIssueRef()` build the browser's resolution context from the
  `TrackerInfo[]` it already fetched for the tabs, rather than a second fetch.
  `TrackerInfo` gains `name` and `kind` to carry what the resolver matches on.
- Agent-facing docs: `src/server/shipit-docs/issues.md`,
  `shipit-docs/shipit-yaml.md`, `shipit-docs/design-docs.md`, and the
  `prompts/skeleton.md` / `prompts/pull-requests.md` fragments for the reference
  form (req 15).
- `shipit.yaml` — ShipIt's own repository declares its Linear team, because
  requirement 1 means it would otherwise lose the tab this repository's workflow
  depends on.

## Validation

The shipped two-repository fixture — both repositories holding issue `#42`, every
operation asserted to touch only the one it named — carries over as the
regression guard for the routing invariant
(`integration_tests/issues-declared-trackers.test.ts`).

Added for the rework, and passing:

| Case | Where |
|---|---|
| A repository declaring nothing has only its own GitHub Issues — no Linear tab, even with a stored credential | `issues-declared-trackers.test.ts` |
| `kind: linear` declared, including two teams at once | `issues-declared-trackers.test.ts`, `registry.test.ts`, `shipit-config.test.ts` |
| Each of the three reference forms resolving, in the resolver, the client chip and the CLI | `issue-ref-resolution.test.ts`, `tracker-link.test.ts`, `agent-issue-access.test.ts` |
| A canonical address naming an undeclared destination failing closed | `issue-ref-resolution.test.ts`, `issues-declared-trackers.test.ts`, `agent-issue-access.test.ts` |
| An ambiguous reference failing rather than resolving to one match | `issue-ref-resolution.test.ts`, `agent-issue-access.test.ts` |
| A self-declaration producing a name without a duplicate tab | `registry.test.ts`, `issues-declared-trackers.test.ts` |
| A declared `label` labelling the tab, a missing/blank one falling back to `name`, and the tab rendering the label alone | `shipit-config.test.ts`, `registry.test.ts`, `IssuesViewer.test.tsx` |
| A bare `create` rejected rather than filing into the session's own repository | `agent-issue-access.test.ts`, `shipit.test.ts` |
| Undo working against an undeclared destination, and following a re-pointed name | `registry.test.ts`, `issues.test.ts` |
| ShipIt-emitted references carrying the name form | `issues-declared-trackers.test.ts`, `issues-routes.test.ts`, `issues.test.ts` |
| Declaration warnings and resolution failures in CLI output | `agent-issue-access.test.ts`, `issues-declared-trackers.test.ts` |

### What an adversarial cross-agent review changed

A second reviewer (a different backend, given the requirements as the oracle and
told to find defects) found five that the tests did not. All are fixed; each was
a case where a *rule* held in the resolver but a *caller* reached around it:

| Defect | Why the tests missed it |
|---|---|
| A write's `tracker` and `trackerName` were never checked against each other, while Undo re-resolves through the name first — so an incoherent pair wrote to one destination and undid against another | Every test built the pair the way the shim does, from one resolution, so the two always agreed |
| Linear's `deleteComment` / `deleteUnusedLabel` took workspace-global ids with no team assertion, so a re-pointed name let the new team's adapter mutate the old team's data | The read-side guard was tested; the two undo-only mutations were not |
| The merge-effect key and deterministic card id omitted the destination, so a PR naming `alpha#42` and `beta#42` completed only one | No test merged a PR naming two trackers — and the docstring already *claimed* the tracker was in the key |
| Merge-time resolution failures reached only `console.warn`, so a `Closes` that resolved to nothing silently did nothing (req 19) | Assertions checked that the wrong destination was *not* written, never that the user was told |
| The client's bare-Linear-key badge picked the first matching declaration instead of failing closed on ambiguity | The resolver's ambiguity rule was tested; this caller doesn't use the resolver |

The pattern worth keeping: a centralized rule is only as good as the number of
callers that go through it, and the reviewer that finds the exceptions is the one
reading the callers rather than the rule. Three findings were reported that are
*not* defects — a qualified tracker id on `create` (req 13 asks the caller to
name a destination, which a qualified id does), and two the checklist already
recorded as open.

### Four precedence rules the review forced into the open

The review's remaining findings were not defects but *unstated* rules — cases
where two requirements were each satisfiable alone and silently disagreed
together. The user settled all four; they are now requirements 6, 11 and 16.

- **A destination is declared at most once.** `TrackerId` *is* the destination,
  so two names for one repository collapse onto one id no matter what the UI
  does. Refusing the configuration (`parseIssuesConfig`, warn-and-skip) was
  chosen over making a *declaration* the unit of identity, which would have
  threaded a new id through tabs, cards, routes and persisted rows to support
  something nobody wanted. One consequence worth naming: with the duplicate
  refused at *declaration* time, a canonical address can no longer match two
  declarations, so the resolver's ambiguity branch became unreachable through the
  config path. It is kept as a defensive invariant — `resolveIssueRef` takes its
  destinations from callers, not only from the parser — and is now exercised
  directly in `issue-ref-resolution.test.ts` rather than through a `shipit.yaml`
  fixture, which is what the integration test used to do.
- **In a name form, the name wins.** `roadmap#SHI-304` re-targets after `roadmap`
  moves to team `OPS`, rather than failing on the stale key. This is the feature's
  one deliberate departure from fail-closed, and it is narrow on purpose: the name
  already identifies exactly one declared destination, so the rule *prefers one of
  two stated things* rather than guessing among candidates. It lives in
  `resolveNamedSuffix` and nowhere else — notably not on the undo path, which
  still acts on the issue its write actually touched.
- **A read card is a reference.** `IssueRefCard` gained `trackerName` and
  re-resolves on click, matching the write card. It rides the existing
  `issue_ref` JSON blob, so — like the write card's `trackerName` — the "schema
  change" the design anticipated turned out to be no schema change at all.

- **Undo does not follow a re-pointed name.** It acts on the destination it
  recorded and refuses if the name has moved (`undoIssueWrite`, via the registry's
  new `destinationForName`). Asking this question is what exposed the sharpest
  defect of the round: `getRecorded` preferred the recorded *name*, so re-pointing
  `planning` made an Undo rewrite a **different repository's** issue of the same
  number. Linear's team guard would have refused the equivalent attempt — GitHub
  had none, and `issues.test.ts` asserted the wrong-repository PATCH as the
  expected behavior. The question was raised as a wording gap and closed as a bug.

The pattern behind all three: `TrackerId` being the *physical destination* is what
made this feature cheap (one id round-trips through every surface), and it is also
what makes each of these cases pinch. That trade was worth taking, but it is the
thing to check first when a new tracker question comes up.

### Live run against two real repositories

Run against the dogfood inner ShipIt (`docs/118`), which serves this branch's
orchestrator, with a session on `nicolasalt-shipit/todo-list` declaring
`nicolasalt-shipit/template-nextjs` as `planning`. Both are real GitHub
repositories reached with the inner deployment's own token; each declaration
change below was a `shipit.yaml` edit with no restart.

| Confirmed live | Observed |
|---|---|
| A declared tracker resolves and reads the **other** repository | `shipit issue list --tracker planning` returned `template-nextjs`, not the session's own repo |
| The routing invariant, at the wire | Declared forms → `tracker=github:nicolasalt-shipit/template-nextjs`; a bare `#2` → `tracker=github` (todo-list) |
| Req 13 — `create` must name its destination | Bare `create` refused with exit 2 and the declared names listed; `--tracker planning` filed into `template-nextjs` |
| Req 15 — emitted references carry the name form | The create reported `planning#2`; a *canonical* address (`nicolasalt-shipit/template-nextjs#2`) also rendered back as `planning#2` |
| Req 11 — fail-closed | An undeclared address, an unknown name, and a mismatched suffix (`planning#SHI-3`) each failed with the declared names, never a guess |
| Req 11 — ambiguity | Declaring the same repository under two names made the canonical address fail naming both, while each name still resolved |
| Req 12 — self-declaration | Declaring the session's own repository produced one tab under its name, not a duplicate |
| Case-insensitive destination identity | A declaration written `nicolasalt-shipit/Template-NextJS` matched the lowercase address |
| Cards record both name and destination | Persisted `issue_write` rows carried `trackerName: planning` **and** `tracker: github:nicolasalt-shipit/template-nextjs` |
| Req 11's Undo carve-out | With the declaration **deleted** — so every new operation on `planning#2` failed closed — Undo of a recorded comment still reached GitHub and removed it |
| Req 8 — warnings | Four malformed entries (missing `name`, Linear without `team`, `kind: jira`, a bad repo slug) each warned, were skipped, and left the valid entry working |

**The `shipit` shim could not be driven through the inner agent.** The dogfood
image deliberately installs only the `gh` shim, and `local-agent-ops.ts`'s
allowlist maps no `issue/*` paths — a documented limitation tracked as SHI-303,
not a defect of this branch. The runs above therefore invoked this branch's shim
binary directly against this branch's orchestrator through a relay reproducing
the worker's 1:1 `/agent-ops/issue/*` mapping. The one link not exercised is the
worker's own router, which is a pure pass-through with its own unit coverage.

**Not covered live.** `kind: linear` is exercised only against a stubbed Linear
GraphQL API. The deployment that runs the dogfood loop has a GitHub token and no
Linear credential, so no end-to-end Linear run was possible; requirements 3–5 rest
on unit and integration coverage with fakes.

## How requirement 22 came to be held on both paths

Worth recording, because the gap was invisible until someone checked. Requirement
22 says the pushed branch name comes from the reference only, never from the issue
title. `seedFromIssueRef` (`headless-sessions.ts`) does exactly that, and this
document once listed it as "carries over" — but that was a claim about a
*mechanism*, not a verified guarantee, and checking it showed the in-app path had
stopped going through that mechanism.

Clicking **Start session** on an issue did not fire a seeded headless session.
`App.tsx`'s `handleIssueStartSession`, reshaped by docs/236, **pre-filled the chat
input** with `You are working on issue <ref>: <title>` so the user could edit it
before sending. That prompt became the session's first message, and ordinary
graduation fed the first message to `generateSessionName` (`session-namer.ts`),
whose slug became the branch (`graduate-session.ts`). So the issue title could
reach a pushed branch name — exactly what requirement 22 forbids, and
unconditionally, since the rule is not scoped to private trackers. The same root
cause meant the session carried no `issueRef`, so the seed-time **→ started**
transition never fired from the Issues tab either.

Closed in SHI-320 by `issue-seeded-session.ts`, which keeps docs/236's prefill and
pins the branch and title at warm graduation instead. The lesson generalizes past
this feature: an inherited guarantee is a claim until you read the code that would
have to hold for it, and "carries over" is where that claim usually hides.

## Out of scope

Backend capability differences — status workflows beyond Open/Closed, priority
conventions, parent/sub-issue mapping — are not part of this feature. Priority
writes are tracked as [SHI-310](https://linear.app/shipit-ai/issue/SHI-310), as a
property of the shared GitHub adapter rather than of any declaration.

## Non-goals

- Making a backend's own web UI the primary issue workflow.
- Inferring a declared destination from the active code remote.
- Silently routing an address that names no declared tracker.
- Any issue migration or synchronization between trackers.
