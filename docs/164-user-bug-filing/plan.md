---
status: planned
priority: medium
description: Let a regular user file a redacted bug report against ShipIt itself from chat — the agent compiles it, the user confirms an inline card, and ShipIt opens a GitHub issue on the upstream repo under the user's own GitHub identity.
---

# User bug filing

## Goal

A regular ShipIt user who hits a bug **in ShipIt itself** should be able to report
it without leaving the chat and without accidentally exposing their personal
information. They describe the problem to the agent; the agent compiles a
**redacted** report; ShipIt renders an inline review card showing the exact
payload; the user confirms; ShipIt opens a **GitHub issue on the upstream ShipIt
repo under the user's own GitHub identity** — the same outcome as if the user had
filed it by hand on github.com.

This is the user-facing, outbound counterpart to the operator and inbound flows we
already have designed (see [Reconciliation](#reconciliation-with-existing-work)).

## Why this matters

Today there is no path for a regular user to report a ShipIt bug from inside ShipIt:

- **Ops sessions** (`docs/128`) are an *operator* tool — host journal mounts + a
  read-only Docker proxy, gated to the deployment owner. Handing one to a regular
  user would leak host logs. Not a user-facing reporting surface.
- **Tracker → session** (`docs/156`) is the *inbound* direction (an issue spins up
  a session) and assumes the deployment owner registered their own private app. It
  is the mirror image of what a user needs.
- **Session sharing / redaction** (`docs/023`) specced a redaction engine but it was
  never built ("we didn't fully implement reduction of sessions").

The product principles (`CLAUDE.md` §1, §2, §5) say the user builds, ships, and
reports **inside** ShipIt, the chat is the input surface, and the agent is the
actor. Filing a bug should therefore be: *talk to the agent → confirm a card →
done*, never *go open a GitHub/Linear tab and hand over your credentials*.

## Core principles for this feature

1. **File under the user's own GitHub identity — there is no trusted central
   party.** ShipIt is self-hosted: the orchestrator *is* the user's box, so a
   "server-held ShipIt credential" is a credential the user controls — it grants no
   privilege and enforces no trust boundary. The only credential that legitimately
   exists is the user's own GitHub auth (which the orchestrator already holds for
   PRs). ShipIt opens the issue on the upstream repo as that user. The result is
   identical to the user filing the issue by hand, so we inherit GitHub's identity
   and abuse model rather than inventing our own.
2. **Nothing leaves the box without explicit confirmation.** The agent drafts; the
   user reviews the exact redacted payload in an inline card; only an explicit
   "Submit" creates the issue. (Action-oriented for the *draft*; consent-gated for
   the *send* — sending to an external service is outward-facing.)
3. **Redaction is server-side and mandatory**, not an opt-in checkbox. The payload
   is scrubbed before it is ever shown in the card, so what the user confirms is
   what gets sent.
4. **The destination is deploy config, not a code fork.** It is pluggable behind
   `IssueTrackerProvider.createIssue()`.

## Design

### Entry point — chat only

No button, no palette (principle §5). The agent recognizes a "report a bug against
ShipIt" intent in conversation (e.g. "this is broken", "ShipIt keeps doing X",
"file this as a bug") and offers to compile a report. We add:

- A short section to the agent system prompt (`agent-instructions.ts`) describing
  the bug-filing capability and when to offer it.
- A `report_shipit_bug` agent tool (or WS message) the agent calls to hand a draft
  to the orchestrator. The tool **proposes** a report; it does **not** create the
  issue — creation only happens after the user confirms the card.

This keeps the agent in the loop and the chat history complete (principle
corollary: "saves an LLM round-trip is not a feature").

### What the report contains

| Field | Source | Notes |
|---|---|---|
| Title + description | Agent, from the conversation | The user's own words, summarized. |
| What happened / repro | Agent, from the redacted transcript excerpt | Recent turns around the failure, scrubbed. |
| ShipIt platform version / build | **Orchestrator, server-side** | The user can't know the platform commit; the server stamps it. Not from the session container. |
| Browser / environment | Client-supplied, coarse | UA family, viewport — no fingerprinting. |
| Author identity | GitHub (the user's own account) | The issue is attributed to the filer's real GitHub identity — same as a hand-filed issue. Expected and fine. |

**Never included:** the user's email (beyond what GitHub already exposes for the
author), their project's repo URL/name, file contents from their workspace,
secrets, OAuth tokens, or full chat history. The user's *project* is irrelevant to
a ShipIt bug; only the redacted *interaction with ShipIt* matters. Because the
issue is **public and carries the user's name**, redaction is the load-bearing
safety mechanism here.

### Redaction engine (fulfills part of `docs/023`)

Build a shared `redact()` utility, generalizing what already works:

- Lift and generalize `REDACTED_PATTERNS` from
  `src/server/orchestrator/services/shipit-source.ts` (`.env`, keys, `.git`, etc.).
- Add the secret scan from `docs/023`: `sk-…`, `ghp_…`, `Bearer …`, generic
  long-token heuristics → `[REDACTED]`.
- Add scrubbers for **email addresses**, **git/remote URLs** (reuse
  `stripUrlCredentials` from `git-utils.ts`, then drop the host/path), and absolute
  paths under the user's workspace dir.

New module: `src/server/orchestrator/services/redaction.ts` + `redaction.test.ts`.
This is the reusable core `docs/023` will later consume for full session export; we
build it now, scoped to the bug-report payload, and un-pause `docs/023` partially.

### Consent UI — inline bug-report review card

A new card type, sibling of `PrLifecycleCard`, emitted into the chat:

```
┌─ Report a bug to ShipIt ──────────────────────────────┐
│ Title:  [ editable ]                                  │
│ Body:   [ editable, pre-filled with redacted draft ]  │
│                                                       │
│ Will be sent (redacted):                              │
│   • ShipIt build a1b2c3d                              │
│   • Chrome / 1440×900                                 │
│   • transcript excerpt (3 turns, secrets removed)     │
│                                                       │
│ Nothing is sent until you click Submit.               │
│            [ Cancel ]            [ Submit report ]    │
└───────────────────────────────────────────────────────┘
```

- The card shows the **exact** payload (post-redaction). Title/body are editable.
- "Submit" is the only path that files the issue. On success the card swaps to a
  "Filed — #1234" state with a secondary "View on GitHub" escape hatch in an
  overflow (principle §2: inline first, link-out is the escape hatch).
- "Cancel" discards; nothing is sent.

### Server flow

```
agent → report_shipit_bug (draft)
      → server: redact() → emit bug_report_card (no issue yet)
user  → submit_bug_report (edited title/body + confirm)
      → server: GitHubAuthManager.createIssue(UPSTREAM_REPO, report)  [user's own token]
              → emit bug_report_filed (issue ref) | bug_report_failed (error)
```

### Anti-spam — GitHub's, not ours

We add **no rate-limiting of our own**, and v1's earlier "rate-limit only" decision
is moot under the corrected credential model. The issue is filed under the user's
real GitHub identity against a public repo, so it is *exactly* equivalent to the
user opening the issue by hand on github.com — same attribution, same abuse
surface. A user who wants to spam the repo can already script `POST /issues`
directly; ShipIt's flow does not create a new or cheaper vector, so adding our own
quota would be theater. Abuse is handled where it already is: GitHub's spam
detection, issue locking, and the maintainers' ability to block an account.

### Credential & destination model

- **Destination is fixed:** the upstream ShipIt GitHub repo, hard-coded as the
  bug-report target (`UPSTREAM_REPO`). Not the user's project repo.
- **Credential is the user's own GitHub auth** — the orchestrator already holds it
  via `GitHubAuthManager` for PRs. Opening an issue on a *public* repo only needs
  `public_repo` scope, which the user has even with no write access to ShipIt; the
  feature degrades to a clear "connect GitHub to file a bug" prompt if the scope is
  missing.
- **No central/service credential**, because a self-hosted deployment has no trusted
  central party to own one (see principle #1).
- **No Linear, no pluggable backend.** Linear requires access the user doesn't have
  (the team's workspace is private) and a server-held key that can't exist here.
  GitHub-issues-on-the-public-repo-as-the-user is the only model that works. We do
  **not** route through `docs/156`'s `IssueTrackerProvider` for the outbound call —
  that abstraction was built around a per-deployment app credential, which is the
  wrong owner for this.
- **This is a server-side GitHub API call, not the `gh issue` shim.** The shim
  intentionally blocks `gh issue`; this path adds a dedicated `createIssue` method
  on `GitHubAuthManager` against the fixed upstream repo, so the shim policy is
  untouched.

## Reconciliation with existing work

| Existing | Relationship |
|---|---|
| `docs/156` tracker→session | **Conceptually mirror, not code-shared.** 156 = issue→session (inbound) via a per-deployment app credential; this = session→issue (outbound) via the *user's own* GitHub auth. The credential owners differ, so the outbound call lives on `GitHubAuthManager`, not 156's `IssueTrackerProvider`. |
| `docs/023` session sharing | **Partially un-paused.** We build the shared redaction engine now; 023's full HTML/JSON export consumes it later. |
| `docs/128` ops session | **Closes the loop.** User files a redacted, consented report → issue → operator (on the upstream ShipIt deployment) triages and uses 156's inbound path to spin an ops/fix session. The user never gets ops privileges; the operator does. |

## Rejected / deferred

- **A "Report a bug" button / command** — shell-shaped affordance (principle §5).
  Chat is the entry point.
- **A server-held / ShipIt-owned service credential** — impossible in a self-hosted
  deployment: the server is the *user's* box, so any credential it holds is
  controlled by the user and grants no privilege or trust boundary. This was the
  clarification that reshaped the design.
- **Linear (any backend)** — the user has no access to the team's private Linear
  workspace, and there's no trusted server to hold a Linear key. Only
  GitHub-issues-on-the-public-repo, filed as the user, works.
- **A pluggable `IssueTrackerProvider` backend for outbound** — over-engineering
  given there is exactly one viable destination and credential owner.
- **Our own rate-limiting / quota** — adds no protection over GitHub's native abuse
  handling, since the issue is filed as the user against a public repo (the same
  thing they can already script). v1's earlier "rate-limit only" choice is moot.
- **Dedup / similarity-collapse / LLM triage gate** — deferred; revisit if report
  volume warrants it. Not a v1 concern.
- **Sending the full session or chat history** — only a redacted, scoped excerpt.

## Key files

- `src/server/orchestrator/services/redaction.ts` (new) + test — shared redaction.
- `src/server/orchestrator/services/bug-report.ts` (new) — compile draft, redact,
  stamp platform version, dispatch to `GitHubAuthManager`.
- `src/server/orchestrator/github-auth.ts` (+ `github-auth-*.ts`) — new
  `createIssue(repo, { title, body })` method against the fixed upstream repo,
  using the user's existing token; surfaces a clear error if `public_repo` scope is
  missing.
- `src/server/orchestrator/ws-handlers/` — `report_shipit_bug` (draft) and
  `submit_bug_report` (confirm) handlers.
- `src/server/shared/types/ws-server-messages.ts` / `ws-client-messages.ts` —
  `bug_report_card`, `bug_report_filed`, `bug_report_failed`, `submit_bug_report`.
- `src/server/orchestrator/agent-instructions.ts` — bug-filing capability prompt.
- `src/client/components/BugReportCard.tsx` (new) — the inline review card.
- `src/server/orchestrator/integration_tests/user-bug-filing.test.ts` (new) —
  end-to-end with a stubbed GitHub auth manager: redaction applied, issue created
  only after explicit confirm, scope-missing path surfaces a connect prompt.
