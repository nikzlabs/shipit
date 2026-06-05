---
title: Agent issue writes — through the unified tracker interface, not MCP
description: Let the agent comment on and edit issues across all trackers via one ShipIt-brokered `Tracker` write interface, rather than per-tracker MCPs/CLIs — for consistency, containment, visibility, and tracker coverage ShipIt controls.
---

# Agent issue writes

## What this decides

docs/175 gives the agent **read** access to issues through ShipIt's tracker
registry. This doc extends that to **writes** — adding a comment, editing an
issue's title/description, and (near-term) setting status/assignee — and makes
the load-bearing architectural decision behind it:

> Issue writes go through **one ShipIt-brokered tracker interface**
> (`shipit issue comment`/`edit`), implemented per-tracker as an in-house
> `Tracker` adapter method. They do **not** go through an external per-tracker
> MCP (the Linear MCP) or a tracker-specific CLI (`gh issue`).

External MCPs remain available as an **optional, user-opt-in power tool** for
tracker-specific richness beyond issue CRUD — but they are not the sanctioned
path for the core write operations.

## Why not "MCP for Linear + `gh` for GitHub"

The tempting alternative is to use each tracker's "native" tooling: the Linear
MCP for Linear, `gh issue` for GitHub. We reject it. The reasons, in order of
weight:

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
ecosystem bet.** The MCP path makes every new tracker a question of "does a good
MCP exist?"; the interface path makes it "write ~40 lines against their API."

### 2. Containment — the token must stay out of the container (docs/172)

ShipIt deliberately keeps the Linear token **orchestrator-side, never in the
container** (the same posture as the GitHub token, which the `gh` shim brokers).
An in-container MCP that writes to Linear needs that token *inside* the container,
regressing exactly the credential-isolation property docs/172 Gap 2-R protects.
It also talks straight to the tracker's API from the container — outside ShipIt's
planned egress allowlist (Gap 1) and invisible to ShipIt. A brokered write keeps
the token in the orchestrator **and** routes the mutation through ShipIt, where it
is observable and gateable. For a **mutating, identity-attributed** action,
brokered beats MCP decisively.

### 3. Consistency — one contract, not three inconsistencies

docs/175 already routes **reads** through the unified interface. The MCP+`gh` path
would produce: read-Linear-via-ShipIt but write-Linear-via-MCP (inconsistent
*within* a tracker), and Linear-via-MCP but GitHub-via-`gh` (inconsistent *across*
trackers). Three axes of inconsistency. The unified write interface collapses all
of them — same surface, same behavior, regardless of backing tracker.

### 4. Visibility — ShipIt is the surface (§1/§2)

A comment made via MCP is invisible to ShipIt: it can't render it in the Issues
tab, can't show a provenance card, can't persist it to chat history. The action
happens in a system ShipIt doesn't observe — link-out-shaped by nature. A brokered
`shipit issue comment` lets ShipIt render "agent commented on SHI-28" inline and
persist it.

### 5. It isn't even symmetric today

The Linear MCP is **not** a ShipIt-provisioned capability — ShipIt wires only
Playwright + internal bridges; the `mcp__linear__*` tools only exist when a user
manually connects them, and they're **absent in headless/cron runs**. GitHub has
**no** write path at all (`gh issue` blocked, no GitHub-issues MCP). So "writes
already work via MCP" holds only for interactive Linear in a hand-configured
session — you cannot build "the agent updates the issue when it ships the PR" on a
channel that disappears headless, and the GitHub half must be built regardless.

### Where MCP genuinely wins (the honest concession)

The Linear MCP is far richer than issue CRUD: projects, cycles, milestones,
documents, sub-issues, labels, attachments. The unified `Tracker` interface should
cover the **common denominator the coding agent needs** — read, comment, edit
title/body, set status/assignee — which maps cleanly across GitHub, Linear, and a
future Jira. For deep tracker-specific project management beyond that, an external
MCP stays available as a **user-opt-in escape hatch**. It is simply not the path
for routine "comment on the issue I'm working on."

## Design

Extend the read-only `Tracker` interface (`trackers/tracker.ts`) with write
methods, implement them in each adapter, and expose them through the same
`shipit issue` shim surface docs/175 introduces — read-only verbs gain mutating
siblings:

```
shipit issue comment <pointer> -b <body>          # add a comment
shipit issue edit <pointer> [--title T] [--body B] # edit title/description
shipit issue status <pointer> <state>              # (near-term) set status
```

### Interface + adapters

```ts
interface Tracker {
  // …existing read methods…
  addComment(id: string, body: string): Promise<TrackerComment>;
  updateIssue(id: string, patch: { title?: string; description?: string }): Promise<TrackerIssue>;
  // near-term: setStatus(id, state), setAssignee(id, assignee)
}
```

The plumbing already exists in both adapters — only mutations are new:

- **Linear** (`trackers/linear/adapter.ts`): reuse `linearGraphql()` (auth headers,
  POST, error handling already there) with the `commentCreate` / `issueUpdate`
  mutations. ~2 mutations, no new transport.
- **GitHub** (`github-auth-issues.ts` already does `createIssue` via `fetchGitHub`):
  add `addComment` → `POST /repos/{o}/{r}/issues/{n}/comments`, `updateIssue` →
  `PATCH /repos/{o}/{r}/issues/{n}`. Same `fetchGitHub` pattern.
- **A future tracker**: implement the same two methods against its API. Done.

### Brokering path (same as docs/175 reads)

`shipit issue comment` → worker `/agent-ops/issue/comment` (allowlisted, injects
trusted `SESSION_ID`) → orchestrator `POST /api/sessions/:id/issue/comment` →
`commentOnIssueForTracker()` service → `TrackerRegistry.get(tracker).addComment()`.
Token stays in the orchestrator's `CredentialStore`; only the *result* returns to
the container.

### Writes are outward-facing — confirmation, attribution, persistence

Unlike reads, a write mutates the user's tracker **under the user's identity**, so
it needs the outward-action treatment:

- **Creation stays human-gated.** Filing a *new* issue remains a deliberate human
  act via the bug-filing review card (docs/164). This doc is about *updating*
  issues the work already concerns — comment, edit, status — not creating them.
- **Do-then-surface for updates, with an inline provenance card.** Consistent with
  how ShipIt treats commits and PR creation (agent acts, card surfaces inline for
  review) rather than a per-comment modal, which would be shell-shaped friction
  (§5). *Open decision:* whether the first write per session also takes a
  lightweight confirm, or a setting gates auto-writes. Lean: do-then-surface +
  undo affordance; revisit if it feels too loose.
- **Persist the card (chat-transcript rule).** "Agent commented on SHI-28" is
  transcript content, so it follows the `emitChatCard` + `PersistedMessage`-field
  pattern (CLAUDE.md "Chat transcript content MUST be persisted"), not emit-only —
  and idempotent-by-id so reconnect/reload don't double-render.

## Scope

**v1:** `comment` and `edit` (title/description) for GitHub + Linear.
**Near-term:** `status` and `assignee` — deferred only because state/assignee
models differ most across trackers (GitHub open/closed vs Linear workflow states
vs Jira transitions) and want a small mapping design of their own.

## Out of scope

- **Creating issues** — stays human-gated (docs/164).
- **Tracker-specific richness** (projects, cycles, documents, sub-issues) — the
  optional MCP escape hatch, not the `Tracker` interface.
- **Injection hardening of content the agent *reads* before writing** — docs/176.
  (Note the loop: an agent told by a malicious issue to post a comment is covered
  by docs/176's framing + docs/172's egress; a write confirmation card is an extra
  backstop.)

## Key files

- `src/server/orchestrator/trackers/tracker.ts` — add write methods to the interface.
- `src/server/orchestrator/trackers/linear/adapter.ts` — `commentCreate`/`issueUpdate` via existing `linearGraphql()`.
- `src/server/orchestrator/trackers/github/adapter.ts` + `github-auth-issues.ts` — `addComment`/`updateIssue` via existing `fetchGitHub()`.
- `src/server/orchestrator/services/issues.ts` — `commentOnIssueForTracker` / `updateIssueForTracker`.
- `src/server/orchestrator/api-routes-issues.ts` — session-scoped write routes.
- `src/server/session/agent-shim/shipit.ts` — `shipit issue comment`/`edit` (drop these from `REJECTED_ISSUE_SUBCOMMANDS`).
- `chat-card-persistence.ts`, `chat-history.ts` — persist the write provenance card.

## Related docs

- `docs/175-agent-issue-access/` — the read interface this extends (its "writes out of scope" note now points here).
- `docs/176-issue-content-injection-hardening/` — safe consumption of issue content the agent reads before acting.
- `docs/172-agent-containment/` — why the token stays out of the container (Gaps 1, 2-R).
- `docs/164-*` (bug-filing) — issue *creation* as a human-gated act.
- `docs/170-inline-tracker-issues/` — the read-only `Tracker` registry + adapters being extended.
