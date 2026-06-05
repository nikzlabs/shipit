---
issue: https://linear.app/shipit-ai/issue/SHI-84/agent-issue-access-tracker-neutral-read-path-shipit-issue-viewlist
description: Give the agent a tracker-neutral, read-only path to issues (GitHub and Linear alike) via `shipit issue view`/`list`, brokered through the existing tracker registry so tokens never enter the container.
---

# Agent issue access

## Problem

The agent has no sanctioned way to read an issue. When a user says "work on
issue #1047" or a feature doc carries an `issue:` pointer, the agent's only
options today are dead ends:

- `WebFetch` on the issue URL → `404` for any **private** repo (GitHub returns
  404, not 403, to unauthenticated requests). The common case fails.
- `gh issue …` → **rejected** by the shim ("out of scope for v1").
- `gh api …` → **blocked** (arbitrary GitHub API access is out of scope).
- Linear issues → no path at all.

So the agent must ask the user to copy-paste the issue body into chat. That is a
link-out in disguise: the data lives upstream, ShipIt already holds it for the
inline Issues tab, but the *actor* (the agent) can't reach it. This violates
[CLAUDE.md §1/§5](../../CLAUDE.md) — the agent is the actor, and anything it needs
to do its job should be reachable **inside** ShipIt, not fetched by the human and
re-typed.

The asymmetry is the tell: the user can already see GitHub **and** Linear issues
inline (SHI-80, docs/170), but the agent — who does the work the issue describes —
can't.

## The interface must be tracker-neutral

An earlier draft of this design added `gh issue view`/`gh issue list` to the `gh`
shim. That was rejected. The reasoning is the heart of this doc:

ShipIt treats trackers as a **first-class, tracker-neutral concept**. The Issues
tab renders GitHub and Linear behind one `Tracker` interface; a doc's `issue:`
pointer can be a GitHub `owner/repo#N` *or* a Linear URL, and the tracker is
inferred from the pointer's shape (docs/168). A `gh issue`-only path would give
the agent full access when the work is GitHub-tracked and **zero** access when
the same work is tracked in Linear — the access surface would depend on which
tracker a repo happens to use. That is precisely the inconsistency the tracker
abstraction exists to remove.

`gh issue` is *convenient* (it matches muscle memory and sits beside `gh pr`), but
convenience for one tracker is not worth a contract that silently differs per
tracker. The agent should have **one** issue interface whose behavior and output
shape are identical regardless of the backing tracker — the same guarantee the
user already gets in the Issues tab.

So: the surface is a tracker-neutral `shipit issue` command, and `gh issue`
stays unimplemented.

## What already exists (and what's missing)

The read plumbing is **done and already tracker-neutral**:

- `Tracker` interface (`trackers/tracker.ts`) with `listIssues()` / `getIssue(id)`,
  implemented by **both** `GitHubTracker` and `LinearTracker`. Both return the
  same `TrackerIssue` shape (`id`, `identifier`, `title`, `url`, `description`,
  `status`, `priority`, `assignee`).
- `TrackerRegistry` (`trackers/registry.ts`) resolves a tracker by id and injects
  each tracker's auth automatically: the GitHub token + session-derived repo for
  GitHub, the deployment-wide Linear token + team binding for Linear. Tokens live
  in the orchestrator's `CredentialStore`, never the container.
- The inline tab already drives this via `GET /api/issues?tracker=…` and
  `listIssuesForTracker()` (`services/issues.ts`).

The **only** missing pieces are: (a) a single-issue `getIssueForTracker()`
service, (b) routes the agent's broker can call, and (c) the agent surface
itself. We are not building issue plumbing — we are exposing the tracker-neutral
plumbing that already backs the UI.

## Design

Add a **`shipit issue`** subcommand to the existing `shipit` CLI shim
(`agent-shim/shipit.ts`, which already hosts `shipit session` and `shipit
source`). It is **read-only**:

```
shipit issue view <pointer> [--json]
shipit issue list [--tracker github|linear] [--state open|closed|all] [--json]
```

- **`<pointer>`** is whatever the user or a doc's `issue:` field says —
  `owner/repo#123`, a GitHub issue URL, `SHI-28`, or a Linear issue URL. The
  tracker is **inferred from the pointer's shape**, so the agent can pass the
  pointer verbatim. `--tracker` is an explicit override for ambiguous input.
- Output is human-readable by default (identifier, title, status, priority,
  assignee, body) so the agent reads it directly; `--json` emits the
  `TrackerIssue` object for parsing. **The output shape is identical across
  trackers** — that is the whole point.

### Shared pointer parsing — move **and extend**

`parseIssueRef()` infers tracker-from-shape today, but only partially, and it
lives client-side (`src/client/utils/issue-ref.ts`) for the jump-to-issue chip.
Making "pass the pointer verbatim" hold end to end requires **moving it to
`src/server/shared/issue-ref.ts`** (one source of truth for the chip, the shim, and the
server route) **and extending it on two points the current implementation gets
wrong for this use case**:

1. **It does not recognize a bare Linear key.** The Linear branch matches only a
   full `https://linear.app/.../issue/SHI-28` URL (`LINEAR_URL_RE`). A bare
   `SHI-28` — the form the agent most often holds, e.g. from a doc's `issue:`
   pointer or the user saying "work on SHI-28" — falls through to
   `{ tracker: "unknown" }`. Add a `[A-Za-z]+-\d+` key pattern so `SHI-28`
   resolves to `tracker: "linear"`.
2. **It exposes only a combined display `identifier`, not the id `getIssue`
   needs.** `getIssue(id)` wants the **tracker-native** id: `GitHubTracker`
   builds `/repos/{owner}/{repo}/issues/${id}` and needs the **bare number**
   (`42`), while `parseIssueRef` returns `identifier: "owner/repo#42"`; passing
   that yields `/issues/owner%2Frepo%2342` → 404. `LinearTracker.getIssue` takes
   the **key** (`SHI-28`). So `parseIssueRef` must additionally surface a
   tracker-native `issueId` field — the bare number for GitHub, the key for
   Linear — which the shim/route forwards to `getIssue`. (For GitHub the owner/
   repo are re-derived server-side from the session remote via
   `resolveGitHubContext`, so only the number needs to flow through.)

Without both extensions the two cases this design centers on — `view SHI-28` and
`view owner/repo#42` — do not work.

### Data flow

A thin vertical slice over the registry that already backs the Issues tab:

```
Agent (Bash):  shipit issue view SHI-28
  │
  ▼  src/server/session/agent-shim/shipit.ts
     parseIssueRef (extended) → { tracker: "linear", issueId: "SHI-28" }
       (a GitHub `owner/repo#42` → { tracker: "github", issueId: "42" })
     GET localhost:9100 /agent-ops/issue/view?tracker=linear&id=SHI-28
  │
  ▼  src/server/session/agent-ops-routes.ts
     allowlisted relay, injects trusted SESSION_ID
     → GET /api/sessions/:id/issue/view?tracker=linear&id=SHI-28
  │
  ▼  src/server/orchestrator/api-routes-issues.ts (new route)
     resolve GitHub context from session remote (Linear ignores it)
     → getIssueForTracker(credentialStore, "linear", "SHI-28", …)   ← new service
  │
  ▼  TrackerRegistry.get("linear").getIssue("SHI-28")               ← REUSED
     LinearTracker (token from CredentialStore)  /  GitHubTracker (token + repo)
  │
  ▼  tracker API (token held by orchestrator; never in the container)
  │
  ▼  { tracker, issue: TrackerIssue } back down the same path → stdout
```

For **GitHub**, the broker already injects the trusted `SESSION_ID`, so the route
resolves `{owner, repo}` from the session's remote exactly as
`resolveGitHubContext()` does for the Issues tab — no `--repo`, no cross-repo
reach. For **Linear**, the binding is the deployment-wide team, so the session is
irrelevant. Both tokens stay in the orchestrator's `CredentialStore`; the
container sees issue *content*, never a secret — identical to the credential
model in `github.md`.

### Where each change lands

| Layer | File | Change |
|---|---|---|
| Shared | `src/server/shared/issue-ref.ts` (moved from `client/utils/`) | `parseIssueRef()` becomes the one pointer→tracker resolver for client + server. Client import updated. |
| Shim | `src/server/session/agent-shim/shipit.ts` | Add `issue` as a top-level subcommand with `view`/`list` handlers (mirroring `session`/`source`); a `REJECTED_ISSUE_SUBCOMMANDS` set keeps it read-only. |
| Worker relay | `src/server/session/agent-ops-routes.ts` | Add allowlisted `GET /agent-ops/issue/view` and `/issue/list`, relaying to the session-scoped orchestrator routes. |
| Orchestrator | `src/server/orchestrator/api-routes-issues.ts` | Add session-scoped `GET /api/sessions/:id/issue/view` and `/issue/list`; reuse `resolveGitHubContext`. |
| Service | `src/server/orchestrator/services/issues.ts` | Add `getIssueForTracker(...)` (registry → `getIssue`); `list` reuses `listIssuesForTracker`. |
| Agent docs | `src/server/shipit-docs/` | Document `shipit issue view/list` (tracker-neutral, read-only) and remove the "ask the user to paste the issue" guidance. Point at the hardening doc for untrusted-content handling. |

No new tracker code, no new auth, no new token handling. The registry and both
adapters are reused unchanged.

## Decisions

**Tracker-neutral `shipit issue`, not `gh issue`.** One interface, identical
behavior and output across GitHub and Linear — see *The interface must be
tracker-neutral*. `gh` stays PR-focused; `gh api`/`gh issue` stay blocked.

**Read-only — `view` + `list` only.** The agent reads issues to do work; it does
not triage or author them. Issue **creation** is already a deliberate human act
routed through the bug-filing review card (docs/164); `GitHubTracker` and
`LinearTracker` are read-only by design (write-back deferred — SHI-43 /
docs/156). A `REJECTED_ISSUE_SUBCOMMANDS` set enforces this at the shim, matching
how `shipit session` rejects `delete`/`adopt`.

**Pointer shape-inference, with `--tracker` override.** The agent passes the
doc's `issue:` value verbatim; the shared (and extended — see *Shared pointer
parsing*) `parseIssueRef` resolves both the tracker and the tracker-native
`issueId`. This is strictly better than forcing `shipit issue view github
owner/repo#N`, because the pointer the agent already has *is* the input.
`--tracker` covers the rare ambiguous/unknown shape.

**Session repo only for GitHub.** Like the PR shim, GitHub issue reads target the
session's own repo (resolved from the remote). Cross-repo reads are a deferred
follow-up.

## Security

This design pulls **attacker-controllable content** (issue titles, bodies,
labels, comments — anyone who can file an issue can plant text) into the agent's
context, which is a prompt-injection vector. **That concern is real but
orthogonal to the access mechanism** — it applies equally to `shipit issue`, to
the old `gh issue` idea, and to a user pasting an issue by hand. It therefore
gets its **own** design, **docs/176-issue-content-injection-hardening**, rather
than being bolted onto this doc.

Two things this doc *does* guarantee, which that doc builds on:

1. **Token isolation is preserved.** The new path reuses the registry's
   orchestrator-side auth; no tracker token ever enters the container. Reading a
   malicious issue cannot exfiltrate a secret that isn't there.
2. **A single ingestion point.** Because every issue read flows through one
   broker → one service, there is exactly one place for docs/176 to attach the
   untrusted-content envelope/provenance framing — it can't be bypassed by a
   second code path.

## Out of scope (deferred)

- **Writing to issues** — comment/edit/status are designed in **docs/177**
  (through this same unified `Tracker` interface, not MCP). Issue *creation*
  stays human-gated (docs/164).
- **Injection hardening** — designed separately in docs/176.
- **Cross-repo GitHub reads** (`--repo`) — kept rejected for parity with the PR
  shim.
- **Issue comments / timeline** — `view` returns the issue body; threaded
  comments are a later enrichment (and interact with docs/176, since comments are
  the lowest-trust content).

## Key files

- `src/server/session/agent-shim/shipit.ts` — the `shipit` shim; add `issue`.
- `src/server/session/agent-ops-routes.ts` — worker relay (`/agent-ops/*`).
- `src/server/orchestrator/api-routes-issues.ts` — issue routes + `resolveGitHubContext`.
- `src/server/orchestrator/services/issues.ts` — `listIssuesForTracker`, new `getIssueForTracker`.
- `src/server/orchestrator/trackers/` — `Tracker` interface, registry, GitHub + Linear adapters (**reused unchanged**).
- `src/server/shared/issue-ref.ts` — shared pointer→tracker parser (moved from `client/utils/`).

## Related docs

- `docs/170-inline-tracker-issues/` — SHI-80 inline Issues tab; the tracker registry + adapters this reuses.
- `docs/168-tracker-backed-priorities/` — `issue:` pointer shape inference.
- `docs/176-issue-content-injection-hardening/` — safe consumption of untrusted issue content (companion to this doc).
- `docs/177-agent-issue-writes/` — extends this read interface to comment/edit through the same unified `Tracker` surface.
- `docs/164-*` (bug-filing) — issue *creation* as a human-gated act; why agent issue writes stay out.
- `docs/172-agent-containment/` — the containment model docs/176 extends.
