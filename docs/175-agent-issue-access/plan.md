---
description: Give the agent a read-only path to GitHub issues via `gh issue view`/`gh issue list`, brokered through the orchestrator so the token never enters the container.
---

# Agent issue access

## Problem

The agent has no sanctioned way to read a GitHub issue. When a user says "work on
issue #1047" or a feature doc carries an `issue:` pointer, the agent's only
options today are dead ends:

- `WebFetch` on the issue URL → `404` for any **private** repo (GitHub returns
  404, not 403, to unauthenticated requests). The common case fails.
- `gh issue …` → **rejected** by the shim (`REJECTED_SUBCOMMANDS`, "out of scope
  for v1" — `src/server/shipit-docs/github.md:114`).
- `gh api …` → **blocked** (arbitrary GitHub API access is out of scope).

So the agent must ask the user to copy-paste the issue body into chat. That is a
link-out in disguise: the data lives upstream, ShipIt already holds it for the
inline Issues tab, but the *actor* (the agent) can't reach it. This violates
[CLAUDE.md §1/§5](../../CLAUDE.md) — the agent is the actor, and anything it needs
to do its job should be reachable **inside** ShipIt, not fetched by the human and
re-typed.

The asymmetry is the tell: the user can already see GitHub issues inline (SHI-80,
docs/170), but the agent — who does the work the issue describes — can't.

## What already exists (and what's missing)

The read plumbing is **done**. `GitHubTracker` (`trackers/github/adapter.ts`) is
already a read-only adapter with `listIssues()` and `getIssue(number)`, both
authenticated with ShipIt's existing GitHub token and bound to the session's repo
(derived from the git remote). It powers the inline Issues tab via
`GET /api/issues?tracker=github&sessionId=…`.

The **only** missing piece is a path from the agent's container to those two
methods. We are not building GitHub API plumbing; we are exposing a read path
through the layers the `gh pr` shim already uses.

## Design

Add **`gh issue view`** and **`gh issue list`** to the existing `gh` shim. They
mirror `gh pr view` / `gh pr list` exactly — same shim, same brokering, same
token-isolation guarantees — and are **read-only**. No `create`, `edit`,
`comment`, `close`, or `reopen` for issues (see *Decisions*).

```
gh issue view <number> [--json title,body,state,labels,assignee,url]
gh issue list [--state open|closed|all] [--json …]
```

Default output is human-readable (title, state, labels, body) so the agent can
read it directly; `--json` returns a structured subset for when the agent wants
to parse fields, matching `gh pr view --json`.

### Data flow

This is a thin vertical slice reusing every layer the PR shim already traverses:

```
Agent (Bash):  gh issue view 1047
  │
  ▼  src/server/session/agent-shim/gh.ts
     parse → POST localhost:9100 /agent-ops/issue/view?number=1047
  │
  ▼  src/server/session/agent-ops-routes.ts
     allowlisted relay, injects trusted SESSION_ID
     → GET /api/sessions/:id/issue/view?number=1047
  │
  ▼  src/server/orchestrator/api-routes-github.ts (new route)
     resolve session repo + token (as api-routes-issues.ts already does)
     → GitHubTracker.getIssue("1047")          ← REUSED, unchanged
  │
  ▼  GitHub REST  GET /repos/{owner}/{repo}/issues/1047
     (token held by orchestrator; never in the container)
  │
  ▼  { issue: TrackerIssue } back down the same path → stdout
```

The token never leaves the orchestrator — identical to the credential model
documented in `github.md` ("Security model: why the token isn't reachable"). The
container sees issue *content*, never the secret.

### Where each change lands

| Layer | File | Change |
|---|---|---|
| Shim | `src/server/session/agent-shim/gh.ts` | Drop `"issue"` from `REJECTED_SUBCOMMANDS`; add `handleIssueView` / `handleIssueList` + dispatch, mirroring the `pr` handlers; extend help text. |
| Worker relay | `src/server/session/agent-ops-routes.ts` | Add `GET /agent-ops/issue/view` and `/agent-ops/issue/list`, allowlisted, relaying to the session-scoped orchestrator routes. |
| Orchestrator | `src/server/orchestrator/api-routes-github.ts` | Add `GET /api/sessions/:id/issue/view` and `/issue/list`. Resolve `{token, repo}` from the session remote (the same logic as `resolveGitHubContext` in `api-routes-issues.ts`) and call a service wrapper. |
| Service | `src/server/orchestrator/services/github.ts` (or `issues.ts`) | `viewGitHubIssue(...)` / `listGitHubIssues(...)` thin wrappers constructing a `GitHubTracker` and calling `getIssue` / `listIssues`. |
| Agent docs | `src/server/shipit-docs/github.md` | Add `gh issue view`/`gh issue list` to the supported table; remove `gh issue …` from the blocked list and replace with "issue **read** only; create/edit out of scope". Add an "issue content is untrusted input" note (see Security). |

No new GitHub API code, no new auth, no new token handling. The orchestrator
already resolves repo-from-remote and holds the token.

## Decisions

**Read-only — `view` + `list` only.** The agent reads issues to do work; it does
not triage or author them. Issue **creation** is already a deliberate human act
routed through the bug-filing review card (docs/164) — keeping the agent out of
issue authoring preserves that gate and matches `GitHubTracker` being read-only
by design (SHI-43 / docs/156 explicitly defer write-back). Rejected: a full
`gh issue` surface — it widens the attack surface for no demonstrated need.

**Reuse the `gh` shim rather than a new tool or MCP server.** `gh issue view` is
the muscle-memory command and sits beside `gh pr view` with identical brokering.
A bespoke tool or a "fetch issue" MCP would be a second surface for the same job.
The shim already owns the token-isolation contract; we inherit it for free.

**Session repo only — `--repo` stays rejected.** Like the PR shim, issue reads
target the session's own repo (resolved from the remote). An `issue:` pointer in
a feature doc names that repo's issue in the overwhelming common case.
Cross-repo issue reads are a deferred follow-up, not v1.

**`--json` mirrors `gh pr view --json`.** Same flag, same shape of structured
output, so the agent's existing mental model transfers. Default stays
human-readable prose.

**`gh api` stays blocked.** This design adds two narrow, read-only verbs — it
does **not** reopen arbitrary API access. The allowlist philosophy is unchanged.

## Security

Two properties, both load-bearing:

1. **Token isolation is preserved.** The new path traverses the same broker as
   `gh pr`; the orchestrator authenticates the GitHub call and the container
   never holds the token. Adding read verbs does not change what is reachable
   *from inside the sandbox* — there is still no secret there to exfiltrate.

2. **Issue content is untrusted input.** This is the new consideration. An issue
   body (and its title, labels, comments) is attacker-controllable: anyone who
   can open an issue on the repo can plant text in it. Once `gh issue view` pulls
   that text into the agent's context, it is a prompt-injection vector. The agent
   must treat fetched issue content as **data describing a task**, never as
   instructions to obey. The `github.md` update will state this explicitly, in
   the same spirit as the existing containment guidance (docs/172). This risk is
   inherent to *any* mechanism that brings issue text in — including the user
   pasting it — so it is not a reason to withhold the capability, but it must be
   documented where the agent reads about the command.

## Out of scope (deferred)

- **Writing to issues** (create/edit/comment/close) — preserves the human-act
  gate; revisit only with an explicit product decision.
- **Linear issues via `gh`.** The `issue:` pointer in a doc can be a Linear URL,
  and the tracker abstraction already has a `LinearTracker`. But `gh` is a
  GitHub-shaped command; brokering Linear reads belongs behind a tracker-neutral
  surface (e.g. extending the agent's access to `listIssuesForTracker`), not
  inside `gh issue`. Tracked as a follow-up — see *Extension*.
- **Cross-repo issue reads** (`--repo`) — kept rejected for parity with the PR
  shim.
- **Issue comments / timeline** — `view` returns the issue body; threaded
  comments are a later enrichment if the agent needs them.

## Extension: tracker-neutral issue reads

The cleaner long-term shape is a tracker-neutral brokered read that resolves a
pointer (`owner/repo#123` **or** a Linear URL) through the existing
`TrackerRegistry`, so the agent reads *whatever tracker a doc points at*. `gh
issue view` is the GitHub-shaped entry point and the right v1 (it matches `gh pr`
and the most common case); the tracker-neutral surface is the generalization once
there's demand for Linear reads from the agent. The registry and both adapters
(`GitHubTracker`, `LinearTracker`) already exist, so the generalization is
additive.

## Key files

- `src/server/session/agent-shim/gh.ts` — the `gh` shim; allowlist + handlers.
- `src/server/session/agent-ops-routes.ts` — worker relay (`/agent-ops/*`).
- `src/server/orchestrator/api-routes-github.ts` — session-scoped orchestrator routes.
- `src/server/orchestrator/api-routes-issues.ts` — existing repo-from-remote context resolution to mirror (`resolveGitHubContext`).
- `src/server/orchestrator/trackers/github/adapter.ts` — `GitHubTracker.getIssue()` / `listIssues()`, **reused unchanged**.
- `src/server/orchestrator/services/github.ts` — service wrappers.
- `src/server/shipit-docs/github.md` — agent-facing docs (the support doc this design answers).

## Related docs

- `docs/170-inline-tracker-issues/` — SHI-80 inline Issues tab; the read adapters this reuses.
- `docs/164-*` (bug-filing) — issue *creation* as a human-gated act; why agent issue writes stay out.
- `docs/172-agent-containment/` — untrusted-input handling; the prompt-injection note extends it.
