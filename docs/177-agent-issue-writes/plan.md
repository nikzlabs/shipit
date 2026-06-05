---
issue: https://linear.app/shipit-ai/issue/SHI-86/agent-issue-writes-via-unified-tracker-interface
title: Agent issue writes — through the unified tracker interface, not MCP
description: Let the agent comment on, edit, re-status, and re-assign issues across all trackers via one ShipIt-brokered Tracker write interface, with a do-then-surface provenance card. Includes the cross-tracker status/assignee mapping.
---

# Agent issue writes

## What this decides

docs/175 gives the agent **read** access to issues through ShipIt's tracker
registry. This doc extends that to **writes** — commenting, editing title/
description, setting status, and setting assignee — and makes the load-bearing
architectural decision behind it:

> Issue writes go through **one ShipIt-brokered tracker interface**
> (`shipit issue comment`/`edit`/`status`/`assign`), implemented per-tracker as an
> in-house `Tracker` adapter method. They do **not** go through an external
> per-tracker MCP or a tracker-specific CLI (`gh issue`).

**Settled decisions** (confirmed with the user):

- **Gating: do-then-surface.** The agent writes immediately; an inline, persisted
  provenance card records the write with an undo affordance. No per-action modal.
- **v1 scope: comment + edit + status + assignee** — the full common-denominator
  write surface, including the cross-tracker status/assignee mapping designed
  below. (Issue *creation* stays out — see Out of scope.)
- **External MCPs: unchanged.** This design neither relies on nor prescribes the
  role of user-connected MCPs; ShipIt's existing MCP support stands as-is and
  this doc takes no position on it.

## Why not "MCP for Linear + `gh` for GitHub"

The tempting alternative is each tracker's "native" tooling: the Linear MCP for
Linear, `gh issue` for GitHub. We reject it for the unified interface. The
reasons, in order of weight:

### 1. Tracker coverage must not depend on a third-party MCP

This is the deciding argument. Whether a tracker *has* an MCP — and whether that
MCP is complete, well-maintained, and secure — is outside ShipIt's control. Jira
may ship a mediocre MCP; a self-hosted or internal tracker may ship none. If
writes are MCP-shaped, ShipIt's support for a tracker is hostage to someone
else's integration quality and release cadence.

Through the `Tracker` interface, adding a tracker's writes is a **bounded,
in-house adapter** — the same adapter that already does reads — that ShipIt owns,
tests, and gives uniform behavior: identical `TrackerIssue` shape, identical error
handling, the same untrusted-content provenance envelope (docs/176), the same
confirmation/visibility flow. **Coverage becomes a ShipIt decision, not an
ecosystem bet.**

### 2. Containment — the token must stay out of the container (docs/172)

ShipIt keeps the Linear token **orchestrator-side, never in the container** (the
same posture as the GitHub token, brokered by the `gh` shim). An in-container MCP
that writes needs that token *inside* the container, regressing exactly the
credential-isolation property docs/172 Gap 2-R protects, and talks straight to the
tracker API outside ShipIt's planned egress allowlist (Gap 1). A brokered write
keeps the token in the orchestrator **and** routes the mutation through ShipIt,
where it is observable and gateable. For a mutating, identity-attributed action,
brokered beats MCP decisively.

### 3. Consistency — one contract, not three inconsistencies

docs/175 already routes **reads** through the unified interface. MCP+`gh` would
make reads and writes use different mechanisms even for the *same* tracker, and
different trackers use different mechanisms. The unified write interface collapses
all of it — same surface, same behavior, regardless of backing tracker.

### 4. Visibility — ShipIt is the surface (§1/§2)

A write made via MCP is invisible to ShipIt: it can't render it in the Issues tab,
show a provenance card, or persist it to chat history. A brokered
`shipit issue comment` lets ShipIt render and persist "agent commented on SHI-28"
inline.

### Scope of the interface (and what stays outside it)

The unified interface covers the **common denominator the coding agent needs** —
read, comment, edit title/body, status, assignee — which maps across GitHub,
Linear, and a future Jira. Tracker-specific richness (Linear projects, cycles,
documents, sub-issues) is **out of scope for the interface**; this design does not
route it through ShipIt and takes no position on whether a user connects an
external MCP for it. That is deliberately left unchanged.

## Design

Extend the read-only `Tracker` interface with write methods, implement them per
adapter, and expose them through the `shipit issue` shim docs/175 introduces:

```
shipit issue comment <pointer> -b <body>            # add a comment
shipit issue edit    <pointer> [--title T] [--body B]   # edit title/description
shipit issue status  <pointer> <state>              # set status (see mapping)
shipit issue assign  <pointer> <user|me|--none>     # set/clear assignee
```

### Interface additions

```ts
interface Tracker {
  // …existing read methods (listIssues, getIssue, info, isConfigured)…
  addComment(id: string, body: string): Promise<TrackerComment>;
  updateIssue(id: string, patch: { title?: string; description?: string }): Promise<TrackerIssue>;
  setStatus(id: string, status: string): Promise<TrackerIssue>;       // normalized type OR native name
  setAssignee(id: string, assignee: string | null): Promise<TrackerIssue>; // login/email/name/"me"/null
}
```

The transport already exists in both adapters — only the mutations are new:

- **Linear** (`trackers/linear/adapter.ts`): reuse `linearGraphql()` with
  `commentCreate`, `issueUpdate` (title/description/`stateId`/`assigneeId`).
- **GitHub** (`github-auth-issues.ts` already does `createIssue` via `fetchGitHub`):
  `POST issues/:n/comments`, `PATCH issues/:n` (title/body/state/assignees).

### Status mapping across trackers

Status is the genuinely hard part, because trackers model it differently:

| Tracker | Status model |
|---|---|
| GitHub | Binary `open`/`closed` (+ `state_reason`: completed / not_planned). No workflow states. |
| Linear | Team-defined workflow states, each carrying a normalized **type**: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. State *names* are team-specific ("In Progress", "In Review", "Done"). |
| Jira (future) | Project workflow; you cannot set a status directly — you apply a valid **transition** from the current state. |

`TrackerIssue.status` already exposes `{ name, type }` (the read adapters normalize
into the six types). `setStatus(id, status)` accepts **either** a normalized type
**or** a native state name, and the adapter resolves it:

- **Normalized type** (portable, the common denominator): the agent passes e.g.
  `started` / `completed` / `canceled`. Each adapter maps it:
  - GitHub: `completed` → close (state_reason completed); `canceled` → close
    (not_planned); `started`/`unstarted`/`backlog`/`triage` → open. Lossy but
    deterministic.
  - Linear: pick the team's state whose `type` matches; if several share a type
    (e.g. two `started` states), choose the team's default for that type, and
    surface the alternatives (see error contract).
  - Jira: find a transition whose target status category matches the type and
    apply it.
- **Native name** (precise override): the agent passes the literal state, e.g.
  `"In Review"`. The adapter matches it against the tracker's available states /
  transitions.

**Discovery + error contract (makes this usable):** the read path
(`getIssue`) gains an optional `availableStatuses: { name, type }[]` so the agent
can pick a valid target up front; and a `setStatus` that fails on an unknown/
ambiguous value returns a structured error **listing the valid options** rather
than a bare 4xx, so the agent retries with a concrete name. This keeps the
common case one-shot (`status completed`) while making the precise case
self-correcting.

### Assignee mapping across trackers

Assignee needs **identity resolution** — the agent has a handle/name/email, the
tracker wants an internal id:

- `setAssignee(id, "me")` → the identity behind ShipIt's stored token. **Note the
  asymmetry:** the GitHub token is the *acting user's* own token, so `me` is that
  user. The Linear token is a **single deployment-wide personal API key**
  (`CredentialStore`, per `linear/adapter.ts`), so Linear `viewer`/`me` resolves
  to whoever issued that PAT — the same identity for *every* ShipIt user, not the
  acting user. See *Identity & attribution* below.
- `setAssignee(id, "<login|email|display name>")`:
  - GitHub: treat as a login; `PATCH issues/:n { assignees: [login] }` (must be a
    collaborator — surface GitHub's error if not).
  - Linear: resolve the string against workspace users (by displayName/email) to an
    `assigneeId`; on no/ambiguous match, return candidates (same error contract as
    status).
  - Jira (future): resolve to accountId.
- `setAssignee(id, null)` (`--none`) → unassign.

### Do-then-surface: the write provenance card

The agent calls the verb; the broker performs the write synchronously and returns
the result. ShipIt then **emits and persists a provenance card** in the transcript
— "Agent commented on github:owner/repo#1047", "set SHI-28 → In Review",
"assigned #42 to @alice" — with an **undo** affordance:

- **Undo is a reverse brokered write.** To make it possible, each write captures
  what it needs to revert: `addComment` returns the new comment id (undo =
  delete it); `updateIssue`/`setStatus`/`setAssignee` snapshot the **prior value**
  (the service reads the issue immediately before mutating) so undo restores it.
  The card carries that snapshot. **The assignee snapshot must capture the prior
  assignee's tracker-internal id** (GitHub login / Linear `assigneeId`) read from
  the raw API response — *not* `TrackerIssue.assignee` (which carries only
  `{ name, avatarUrl }`, no id). Undoing from the display name would re-run the
  same name→id resolution that `setAssignee` itself flags as ambiguous, so undo
  could mis-resolve or fail; replaying an exact id avoids that.
- **No pre-confirmation modal.** The card is the review surface, consistent with
  how ShipIt treats commits and PR creation (agent acts, card surfaces inline),
  not a per-action gate — which would be shell-shaped friction (§5).
- **Persisted, not emit-only.** "Agent commented on …" is transcript content, so
  it follows the `emitChatCard` + `PersistedMessage`-field pattern (CLAUDE.md
  "Chat transcript content MUST be persisted") and is idempotent-by-id so
  reconnect/reload never double-render or clobber an undone state.

**Identity & attribution.** Token isolation holds for both trackers (the token
stays orchestrator-side; only the result returns to the container). But
*attribution* differs and the card wording must not overstate it: a GitHub write
is made with the acting user's own token, so it is genuinely "the user's" action.
A **Linear** write is made with the deployment-wide PAT, so on Linear it is
attributed to the PAT owner — the same identity for all ShipIt users on the
deployment, not the acting user. The provenance card (and any audit text) should
therefore not claim per-user authorship for Linear writes; it should attribute
them to the ShipIt agent / workspace PAT. Closing this gap (true per-user Linear
attribution) would require per-user Linear auth, which is out of scope here and
noted as a limitation rather than solved.

This is the outward-action backstop in place of a pre-gate: every write is
visible, attributable, and reversible. It composes with docs/176 (so a write the
agent was *steered* into by malicious issue content is still surfaced and
undoable) and docs/172 (egress/token isolation).

### Brokering path (same shape as docs/175 reads)

`shipit issue comment` → worker `/agent-ops/issue/comment` (allowlisted, injects
trusted `SESSION_ID`) → orchestrator `POST /api/sessions/:id/issue/comment` →
`commentOnIssueForTracker()` service → `TrackerRegistry.get(tracker).addComment()`.
Token stays in `CredentialStore`; only the result (and the undo snapshot) returns
to the container.

## Out of scope

- **Creating issues** — stays human-gated via the bug-filing review card
  (docs/164). This doc updates issues the work already concerns; it does not file
  new ones.
- **Tracker-specific richness** (projects, cycles, documents, sub-issues) — not
  routed through the interface; external MCP support is unchanged and unprescribed.
- **Injection hardening of content the agent reads before writing** — docs/176.

## Implementation notes

- **Builds on the docs/175 read path (landed separately on `main`).** docs/175's
  read slice — `src/server/shared/issue-ref.ts` (`parseIssueRef`), `shipit issue
  view/list`, the `/agent-ops/issue/{view,list}` relay, the session-scoped read
  routes, and `getIssueForTracker` — landed independently on `main`; this PR was
  rebased onto it and adds **only the writes** on top of that foundation (the
  write methods on the `Tracker` interface + adapters, the write services +
  `undoIssueWrite`, the `/issue/{comment,edit,status,assign}` routes + relay, the
  write shim verbs, and the provenance card). Writes reuse the read path's
  `getIssue` to snapshot prior state for undo and `parseIssueRef` for pointer
  resolution.
- **GitHub write calls live in `trackers/github/adapter.ts`, not
  `github-auth-issues.ts`.** The adapter already injects `fetchImpl` (so reads
  and writes are testable against a fake) using the same headers as
  `fetchGitHub`; `github-auth-issues.ts` uses the un-injectable global `fetch`
  and stays as-is for the bug-filing `createIssue`.
- **Undo transport:** the card's Undo button sends a `undo_issue_write` WS
  message → `ws-handlers/issue-write-handlers.ts`, which reads the persisted
  card (`findIssueWriteCard`), runs `undoIssueWrite`, and patches the card via
  `updateIssueWriteCard`. The prior assignee's internal id is surfaced on the
  read type as `TrackerIssue.assigneeId` (populated from the raw API node), so
  the snapshot captures an exact id rather than the display name.

## Key files

- `src/server/orchestrator/trackers/tracker.ts` — add write methods + `TrackerComment`, optional `availableStatuses` on read types.
- `src/server/orchestrator/trackers/linear/adapter.ts` — `commentCreate`/`issueUpdate` + state/user resolution via `linearGraphql()`.
- `src/server/orchestrator/trackers/github/adapter.ts` — `addComment`/`deleteComment`/`updateIssue`/state/assignees via the adapter's injectable `fetchImpl` + `githubHeaders` (the `fetchGitHub` header pattern; testable against a fake). `github-auth-issues.ts` is unchanged — it keeps the global-`fetch` `createIssue` for bug-filing only.
- `src/server/orchestrator/services/issues.ts` — `commentOnIssueForTracker` / `updateIssueForTracker` / `setIssueStatusForTracker` / `setIssueAssigneeForTracker`, each snapshotting prior state for undo.
- `src/server/orchestrator/api-routes-issues.ts` — session-scoped write routes.
- `src/server/session/agent-shim/shipit.ts` — `shipit issue comment`/`edit`/`status`/`assign`.
- `chat-card-persistence.ts`, `chat-history.ts`, `session-data.ts` — persist + rehydrate the write provenance card; wire undo.

## Related docs

- `docs/175-agent-issue-access/` — the read interface this extends.
- `docs/176-issue-content-injection-hardening/` — safe consumption of issue content the agent reads before acting.
- `docs/172-agent-containment/` — why the token stays out of the container (Gaps 1, 2-R).
- `docs/164-*` (bug-filing) — issue *creation* as a human-gated act.
- `docs/170-inline-tracker-issues/` — the read-only `Tracker` registry + adapters being extended.
