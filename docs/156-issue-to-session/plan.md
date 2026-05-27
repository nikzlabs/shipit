---
status: planned
priority: medium
description: Pick a GitHub or Linear issue from inside ShipIt and turn it into a fully-seeded session — branch named from the issue, chat seeded with the body, PR auto-closes the issue on merge.
---

# Issue → Session

## Goal

A user looking at their backlog should be able to click an issue and have ShipIt do the rest: create a session on the right repo, on a branch named after the issue, with the issue title + body already dispatched as the first chat message, and a PR (when it eventually opens) wired to auto-close the issue on merge (`Closes #N` / `Fixes ENG-123`).

Today the equivalent flow is: open GitHub or Linear in another tab, copy the title, switch to ShipIt, click *+ New Session*, pick the repo, paste the title, paste the body, eventually remember to add `Closes #N` to the PR body. Every step of that is the user doing manual data shuffling between two tabs — exactly the link-out pattern §1 and §2 in `CLAUDE.md` say we should design away.

This is also a natural pair with the existing quick-capture overlay (doc 145): quick-capture is the "I just thought of something" entry point; issue-picker is the "I have a planned thing on my backlog" entry point. Both end in the same place — a dispatched session in the sidebar.

## Why this matters

Issues are where most planned work originates. If ShipIt isn't a first-class consumer of the issue tracker, the user's workflow always starts in a different tab — which means the next thing they do (assign themselves, leave a comment, mark in-progress) tends to also happen there. The cycle has to start somewhere; we want it to start in ShipIt.

Two specific user motions this unblocks:

1. **"Pick up the next ticket."** User scans their assigned issues, picks one, clicks it, and the session is already running by the time they switch to it. No copy-paste.
2. **"Close the loop on merge."** The PR auto-closes the issue. Today the agent sometimes remembers `Closes #N` and sometimes doesn't, depending on whether the URL was in chat context. Making it metadata on the session instead of free text in chat makes it deterministic.

## Non-goals

- **Not** a full issue tracker inside ShipIt. We list and start, we don't create / edit / comment on issues from the picker. (The agent can already do that mid-session via `gh` or Linear MCP.)
- **Not** automatic issue assignment / status flips ("set to In Progress when session starts"). Possible later, but it's a side-effect on a third-party system and worth keeping behind an explicit user action initially.
- **Not** bidirectional sync. Closing a session does not reopen the issue; reopening an issue does not respawn a session.

## Design

### UX

A new **Issues** tab on the home screen, alongside whatever ends up being the existing "+ New Session" entry. Layout:

```
┌─ Home ──────────────────────────────────────────────┐
│  [ Prompt ]  [ Issues ]  [ Repos ]                  │
│                                                     │
│  Issues                                             │
│  ─────────                                          │
│   Source: ( GitHub ▾ )    Filter: ( Assigned ▾ )    │
│                                                     │
│   #456  Fix broken auth redirect on Safari          │
│         owner/repo · 2 days ago · bug               │
│                                                     │
│   #441  Add CSV export to the reports page          │
│         owner/repo · 5 days ago                     │
│                                                     │
│   ENG-123  Rename "workspace" to "project" globally │
│            (Linear) · today                         │
│                                                     │
│  [ Open in new session ]                            │
└─────────────────────────────────────────────────────┘
```

Clicking a row creates a session in the background (existing `headless-sessions` flow) and navigates to it. The new-session animation already exists.

### Data model

Add an `issueRef` to `SessionInfo` (persisted in session metadata):

```ts
type IssueRef = {
  source: "github" | "linear";
  // GitHub: "owner/repo#NNN"; Linear: "ENG-123"
  identifier: string;
  // For UI rendering and the "open in tracker" escape hatch
  url: string;
  title: string;
};
```

Carried in `SessionInfo.issueRef`. Used by:
- PR creation, to append `Closes #N` / `Fixes ENG-123` to the body
- Sidebar / session header, to render an issue chip next to the session title
- PR lifecycle card, to render the issue link inline

### Server changes

1. **`GitHubAuthManager.listIssues(opts)` / `getIssue(owner, repo, number)`** — new file `github-auth-issues.ts` alongside `github-auth-prs.ts`. REST `/issues` with `assignee=@me` default; supports `state`, `labels` filters. Cached per-repo with the same TTL as PR data.

2. **`LinearAuthManager`** (new) — orchestrator-side OAuth. **Cannot reuse** the existing `mcp-oauth-providers.ts` Linear entry because that flow stores tokens *inside the session container* for the agent's MCP client — the orchestrator has no access. Native OAuth flow modeled on `GitHubAuthManager`, token stored in `CredentialStore`. GraphQL queries for `viewer.assignedIssues` and `issue(id:)`.

3. **`createHeadlessSession(opts)` extension** — accepts optional `issueRef: IssueRef`. When present:
   - Branch defaults to `<source-prefix>-<id>-<slugified-title>` (e.g. `gh-456-fix-auth-safari`, `lin-eng-123-rename-workspace`). User can still override.
   - Initial prompt is templated from the issue: `Working on <title> (<url>):\n\n<body>`. The agent treats it as a normal first message.
   - `issueRef` persisted on `SessionInfo`.

4. **PR body templating** — in `services/pr-lifecycle.ts` / `services/github.ts`, when `session.issueRef` is set, append a closing line to the PR body before calling `createPullRequest()`:
   - GitHub: `\n\nCloses #456`
   - Linear: `\n\nFixes ENG-123` (Linear's [Magic Words](https://linear.app/docs/github#link-using-pull-requests))
   - Skip if the body already contains a `Closes`/`Fixes` reference for the same identifier (agent may have written it itself).

5. **HTTP routes** —
   - `GET /api/github/issues?repoUrl=&filter=assigned` → `IssueSummary[]`
   - `GET /api/linear/issues?filter=assigned` → `IssueSummary[]`
   - Existing `POST /api/sessions/headless` gains an optional `issueRef` field.

### Client changes

1. **`IssuesPanel.tsx`** (new) — fetches from the two endpoints, renders rows grouped by source. Source toggle persists in `ui-store`.
2. **`useIssues()` hook** — wraps the API calls + SSE invalidation on `github_auth_changed` / `linear_auth_changed`.
3. **Session creation action** — extend `session-actions.ts` to pass `issueRef` through to `POST /api/sessions/headless`.
4. **Session header chip** — when `session.issueRef` is set, render an issue badge linking to the tracker (overflow / secondary, not primary — see §2 of `CLAUDE.md`).
5. **Linear connection UI** — a "Connect Linear" button in settings, modeled on the existing GitHub connect flow.

### Branch naming

```
github:  gh-<number>-<slug>      e.g. gh-456-fix-broken-auth-redirect
linear:  lin-<identifier>-<slug> e.g. lin-eng-123-rename-workspace
```

Slug taken from issue title, lowercased, non-alphanumerics → `-`, truncated to ~40 chars. Falls back to `gh-456` / `lin-eng-123` if title is empty.

Branch name uniqueness is the existing `RepoGit` concern — if the branch already exists we suffix with a short random slug, same pattern as `generateBranchPrefix()`.

## Phasing

### Phase 0 — Paste-a-URL (zero new code, ships today)

Document in the in-app prompt help that pasting an issue URL into a new-session prompt works: the agent inside the container can fetch GitHub issues via `gh issue view` and Linear issues via the existing Linear MCP. No branch/PR auto-wiring, but it covers the "I have an issue URL, I want a session" case in the meantime.

This is **not** the design — it's the temporary state we're improving on. Worth calling out so we're explicit that the Phase 1 work is justified.

### Phase 1 — GitHub Issues (the bulk of the feature)

Everything above, scoped to `source: "github"`. Builds entirely on the existing `GitHubAuthManager` and `CredentialStore`. The Linear column on the picker is hidden / "coming soon" in this phase.

Ship gate: a user with `assignee=@me` can pick an issue from a repo they've added, get a session running on a properly-named branch with the body in chat, and have the eventual PR close the issue on merge.

### Phase 2 — Linear

Adds orchestrator-side `LinearAuthManager` + connect-Linear settings UI. The main risk is that **Linear issues don't carry a repo** — the picker needs a way to resolve "this Linear issue → which repo do I open the session on?"

Two options for the repo mapping:

- **(a) Per-team mapping in settings.** User configures `team ENG → repo owner/foo` once; the picker uses that. Clean, but only works for orgs where the team-to-repo correspondence is 1:1.
- **(b) Pick-the-repo step in the flow.** User clicks a Linear issue, gets a "which repo?" prompt before the session is created. Defaults to most-recent.

Recommendation: ship (b) first — no configuration required, works for everyone — and add (a) as an opt-in optimization for users on a stable team/repo mapping. The picker remembers the last-used repo per Linear team as a soft default.

## Rejected alternatives

- **MCP-only Linear (no orchestrator OAuth).** The MCP Linear integration already exists and lives in the session container — why not just have the agent fetch the issue list at session start? Because the picker is a *browser UI element* that needs to render the list before any session exists. There's nowhere for an MCP client to run on the orchestrator side. We'd be inventing a way to proxy MCP from the orchestrator just to avoid a second OAuth, which costs more than the OAuth.
- **Auto-assign issue to user on session start.** Side-effect on a third-party system, easy to surprise the user, easy to leave wrong if the session is abandoned. Keep it behind an explicit chat instruction.
- **Auto-comment on the issue with the PR link.** Same reasoning — the user can ask the agent for this and it's already doable.
- **Putting the picker behind a hotkey instead of on the home screen.** Quick-capture already owns the hotkey-for-fast-input pattern; adding a second one fragments the muscle memory. Issues live on the home screen where the user is already deciding what to work on next.

## Open questions

- **Filters on the picker.** Default is `assignee=@me`. Do we expose label / status / sprint filters in v1, or save that for after we see how people use the picker?
- **Multiple GitHub accounts.** Today a user has one GitHub connection. If/when we support multiple, the picker needs an account selector. Out of scope for v1 but worth not painting ourselves into a corner with the API shape (`GET /api/github/issues` should take an optional `accountId`).
- **Issue → existing session, not new.** If a session for the issue already exists, do we offer to jump to it instead of creating a duplicate? Probably yes — match by `issueRef.identifier` and surface "Resume" alongside "Open in new session".
- **Webhooks vs polling.** Phase 1 polls on focus + when the GitHub event SSE fires. Webhook-driven invalidation is nice but requires us to expose a webhook endpoint per-deployment.

## Key files

Implementation will touch (or add):

- `src/server/orchestrator/github-auth-issues.ts` (new) — REST `/issues` wrappers
- `src/server/orchestrator/github-auth.ts` — re-export issue methods
- `src/server/orchestrator/linear-auth.ts` (new, Phase 2) — Linear OAuth + GraphQL
- `src/server/orchestrator/credential-store.ts` — `setLinearToken`/`getLinearToken`
- `src/server/orchestrator/services/headless-sessions.ts` — accept `issueRef`, branch/prompt derivation
- `src/server/orchestrator/services/pr-lifecycle.ts` — append `Closes`/`Fixes` line
- `src/server/orchestrator/services/github.ts` — `quickCreatePr` body templating
- `src/server/orchestrator/api-routes-github.ts` — `GET /api/github/issues`
- `src/server/orchestrator/api-routes-linear.ts` (new, Phase 2)
- `src/server/shared/types/domain-types.ts` — `IssueRef`, extend `SessionInfo`
- `src/client/components/IssuesPanel.tsx` (new)
- `src/client/components/HomeScreen.tsx` — slot in the Issues tab
- `src/client/hooks/useIssues.ts` (new)
- `src/client/stores/actions/session-actions.ts` — pass `issueRef` through
- `src/client/components/PrLifecycleCard.tsx` — issue chip rendering
- `src/server/orchestrator/integration_tests/issue-to-session.test.ts` (new) — end-to-end coverage with stubbed GitHub/Linear auth
