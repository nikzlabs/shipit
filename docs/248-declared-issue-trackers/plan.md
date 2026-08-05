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

A first version shipped, built when this was an additive GitHub-only feature.
The requirements have since become general and non-additive, so the work now is a
**rework of the shipped mechanism**, not a greenfield build.

One part of the shipped design survives unchanged and carries the rest: the
destination lives in the tracker id. Everything else — how trackers come into
existence, how an operation names one, and what a reference resolves through —
changes.

Requirement 19 means the rework owes nothing to the current CLI surface, the
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

1. A destination named by an operation is used as named, verbatim (req 16).
2. ShipIt never substitutes one destination for another, and never retries a
   failure against a fallback (req 16).
3. An unreachable destination fails closed with no fallback (req 17).
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
  not as a picker that persists a binding.
- **`LinearTracker` takes its team from its declaration**, so a repository can
  declare two Linear trackers on different teams. Its `isConfigured()` already
  requires a token and a team; the team now arrives from config rather than
  storage.
- Deployments that have a stored team lose their Linear tab until the repository
  declares one. Req 19 permits this; it is worth calling out because it is the
  one change a user notices without doing anything.

### 2. A destination is addressed by name (reqs 6, 12)

`--repo owner/name` goes away, replaced by the declared name. The session's own
repository stays the one unnamed destination.

This inverts an asymmetry the shipped registry documents at length. `get()`
currently **synthesizes** a tracker for any well-formed `github:owner/repo` id it
does not hold, precisely so `--repo` could reach any repository the credential can
see. Req 11 forbids exactly that: an address identifying no declared tracker fails
closed. So the synthesizer is deleted and `get()` narrows to the registered set —
`list()` and `get()` stop disagreeing.

That deletion has a consequence worth stating, because the registry docstring
currently sells the synthesizer as load-bearing: it is what let a persisted Undo
card resolve `github:owner/repo` with no extra state. After the change, a card
whose destination is no longer declared fails closed on Undo. That is req 11
applied consistently rather than a regression, but it is a behavior change to the
Undo path and needs its own test.

### 3. References resolve through the declarations (reqs 10, 11, 14, 15)

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

**Emitting the name (req 14).** Only two places in the codebase produce a
reference string: `parseIssueRef`'s four branches, and `github/adapter.ts`, which
builds `${owner}/${repo}#${number}` from an API response. That is a much smaller
surface than "everywhere a reference is shown", and it is the argument for a single
formatter — both producers should call it, so a name is rendered wherever the
destination has one. The agent's own text is not rewritten; ShipIt instructs it
which form to write (req 14), which is an `agent-instructions` change, not a code
path.

**Resolution happens at use (req 15).** Nothing pins a name to what it resolved to
when written, including persisted Undo targets. Since a card stores a tracker id
and not a name, this needs care: storing the *resolved id* freezes the
destination, which is what req 15 forbids for a name-written reference. The design
question is whether a card records the name it was written with alongside the
resolved id. That is a persisted-field change, so it is the one place this rework
touches the database.

### 4. Failures surface where the operation started (reqs 8, 18)

Declaration warnings today reach two places, neither of them the agent:
`service-manager-setup.ts` posts a "shipit.yaml needs migration" chat message, and
`diagnostics.ts` exposes `cfg.warnings`. Req 8 puts them in `shipit` CLI output so
the agent can repair a declaration; req 18 extends the same rule to resolution and
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
viewer (req 23).

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

- Duplicate or conflicting names across declarations — req 6 makes `name` unique
  per repository, so this is a validation-and-warning shape, not a resolution rule.
- Whether a name may collide with a GitHub owner name, given `owner/repo#42` and
  `name#123` are distinguished by the slash.
- How an unresolvable name renders: it must fail closed and stay legible rather
  than degrade to a broken link.
- Whether a persisted card records the name alongside the resolved id (see §3).

## Key files

Current state; each is a rework site unless noted.

- `src/server/shared/tracker-id.ts` — qualified-id vocabulary. **Carries over.**
- `src/server/shared/shipit-config.ts` — `parseIssuesConfig` / `DeclaredTracker`.
  Gains `name`, `kind: linear`, and the team field. Nothing here throws: a
  declaration gates a tab, not the container.
- `src/server/shared/issue-ref.ts` — stays pure and context-free; a resolver layer
  goes above it.
- `src/server/shared/pr-issue-refs.ts` — inherits whatever the resolver returns.
- `src/server/orchestrator/trackers/registry.ts` — the largest change: build from
  declarations, drop the self-declaration skip, delete the `get()` synthesizer.
- `src/server/orchestrator/trackers/linear/adapter.ts` — team from declaration
  rather than `CredentialStore`.
- `src/server/orchestrator/trackers/github/adapter.ts` — `accessError()` carries
  over; `identifier` construction moves to the shared formatter.
- `src/server/orchestrator/credential-store.ts` — `getLinearTeam`/`setLinearTeam`
  and the stored `linear.team` retire.
- `src/client/components/SettingsTrackers.tsx` — team picker retires.
- `src/server/orchestrator/api-routes-issues.ts` — `resolveGitHubTrackerContext`
  reads `shipit.yaml` per request (uncached, so editing the file changes tabs on
  the next request; a parse failure degrades to no declarations). **Carries over.**
- `src/server/orchestrator/issue-lifecycle.ts` — resolves destinations from the
  pointer, which is what lets a `Closes` line target a different repository than
  the PR's own (GitHub never closes cross-repository itself). **Carries over**,
  with resolution routed through the new layer.
- `src/server/session/agent-shim/shipit-issue.ts` — `--repo` and the `"linear"`
  fallback in `resolveTrackerFlag` both go; verbs take a tracker name.
- `src/server/orchestrator/services/headless-sessions.ts` — `seedFromIssueRef`
  builds the branch from the identifier alone (req 21). **Carries over.**
- Agent-facing docs: `src/server/shipit-docs/issues.md`,
  `shipit-docs/shipit-yaml.md`, and `agent-instructions` for the reference form.

## Validation

Shipped and still valid: the two-repository fixture where both hold issue `#42`,
asserting every operation touches only the one it named — across list, detail,
create, edit, status, labels, assignees, comments, agent writes and Undo,
session-start, `Refs` comments and merged `Closes` effects, dedup and effect-guard
keys, reload/session-switch mid-effect, and the fail-closed cases.

The rework needs:

- a repository declaring nothing — only its own GitHub Issues, no Linear tab;
- `kind: linear` declared, including two teams declared at once;
- each of the three reference forms resolving, in the UI highlight and the CLI;
- a canonical address naming an undeclared destination failing closed;
- an ambiguous reference failing rather than resolving to one match;
- a self-declaration producing a name without a duplicate tab;
- a name re-pointed at a different destination re-targeting an existing recorded
  card (req 15);
- ShipIt-emitted references carrying the name form (req 14);
- declaration warnings and resolution failures appearing in CLI output (reqs 8, 18).

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
