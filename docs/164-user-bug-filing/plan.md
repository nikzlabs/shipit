---
status: planned
priority: medium
description: Let a regular user file a redacted bug report against ShipIt itself from chat — the agent compiles it, the user confirms an inline card, and the server creates the issue with a ShipIt-owned credential.
---

# User bug filing

## Goal

A regular ShipIt user who hits a bug **in ShipIt itself** should be able to report
it without leaving the chat, without exposing their personal information, and
without needing any access to the ShipIt team's issue tracker. They describe the
problem to the agent; the agent compiles a **redacted** report; ShipIt renders an
inline review card showing the exact payload; the user confirms; the **server**
files the issue using a **ShipIt-owned, server-held credential**.

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

1. **The user never authenticates to the tracker and never sees a credential.**
   They produce redacted *text* only. The server files the issue with a
   ShipIt-owned service credential configured once at deploy time.
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
| Opaque session reference | Server | An internal id for the team to correlate, **not** the user's email or repo. |

**Never included:** the user's email, their project's repo URL/name, file contents
from their workspace, secrets, OAuth tokens, or full chat history. The user's
*project* is irrelevant to a ShipIt bug; only the redacted *interaction with
ShipIt* matters.

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
- "Submit" is the only path that calls the tracker. On success the card swaps to a
  "Filed — #1234" state with a secondary "View on GitHub/Linear" escape hatch in an
  overflow (principle §2: inline first, link-out is the escape hatch).
- "Cancel" discards; nothing is sent.

### Server flow & anti-spam

```
agent → report_shipit_bug (draft)
      → server: redact() → emit bug_report_card (no issue yet)
user  → submit_bug_report (edited title/body + confirm)
      → server: rate-limit check (per account/deployment: N/day + cooldown)
              → IssueTrackerProvider.createIssue(report)  [ShipIt-owned credential]
              → emit bug_report_filed (issue ref) | bug_report_rejected (rate limited)
```

**Anti-spam (v1 = rate-limit only, per decision):**

- Per-account/per-deployment cap (e.g. 5/day) + short cooldown, enforced
  **server-side** in the submit handler before `createIssue`.
- The raw-API spam vector is already closed: the client never holds the credential,
  and every report is forced through the agent → redact → confirm → server path.
- Rate-limit state persists in a small SQLite-backed store (sibling of
  `secret-store.ts`) so it survives orchestrator restarts (deploys).
- Dedup, similarity-collapse, and an LLM quality gate are **explicitly deferred** —
  see Rejected/deferred.

### Credential & destination model

- A **server-held ShipIt service credential**, configured once at deploy time via a
  secret (e.g. `SHIPIT_BUGREPORT_TOKEN` + `SHIPIT_BUGREPORT_TARGET`). Stored in
  `CredentialStore`, never sent to the client or the session container.
- Destination is **pluggable** behind `IssueTrackerProvider.createIssue(report):
  Promise<IssueRef>` (extends the interface in `docs/156`). Two concrete backends:
  - **GitHub Issues on the ShipIt repo** (bot/App token), labeled `user-reported`
    into a triage queue. **Recommended default** — the product's natural public
    tracker; doesn't pollute a private personal Linear; `gh issue` is blocked in the
    user-facing shim, so this is a *server-side* path with the team credential, not
    the shim.
  - **A dedicated ShipIt Linear intake team** (server-held Linear API key — a
    separate intake team, *not* a developer's personal workspace).

The deployment owner picks the backend via config; the code does not fork on it.

## Reconciliation with existing work

| Existing | Relationship |
|---|---|
| `docs/156` tracker→session | **Reused.** This feature adds the outbound `createIssue()` to the same `IssueTrackerProvider` abstraction. 156 = issue→session (inbound); this = session→issue (outbound). Mirror halves of one tracker integration. |
| `docs/023` session sharing | **Partially un-paused.** We build the shared redaction engine now; 023's full HTML/JSON export consumes it later. |
| `docs/128` ops session | **Closes the loop.** User files a redacted, consented report → issue → operator triages and uses 156's inbound path to spin an ops/fix session. The user never gets ops privileges; the operator does. |

## Rejected / deferred

- **A "Report a bug" button / command** — shell-shaped affordance (principle §5).
  Chat is the entry point.
- **Filing with the user's own GitHub/Linear credentials** — the user has no access
  to the ShipIt tracker and shouldn't; routing through their auth is wrong. The
  server files with the team credential. (This is the explicit clarification that
  motivated the credential model.)
- **Routing into the deployment owner's personal/private Linear workspace** — mixes
  external user reports into a private dev tracker. Use a dedicated intake target.
- **Reusing 156's per-deployment app for outbound** — wrong direction and wrong
  owner; outbound against the single fixed ShipIt tracker wants a central
  ShipIt-owned credential.
- **Dedup / similarity-collapse / LLM triage gate (v1)** — deferred. Decision for
  v1 is rate-limit only. Revisit once we see real report volume and quality.
- **Sending the full session or chat history** — only a redacted, scoped excerpt.

## Key files

- `src/server/orchestrator/services/redaction.ts` (new) + test — shared redaction.
- `src/server/orchestrator/services/issue-trackers/types.ts` — add `createIssue` to
  `IssueTrackerProvider` (created by `docs/156`; this feature may land the interface
  if 156 hasn't yet).
- `src/server/orchestrator/services/bug-report.ts` (new) — compile draft, redact,
  rate-limit, dispatch to provider.
- `src/server/orchestrator/credential-store.ts` — store the ShipIt service
  credential + bug-report rate-limit state.
- `src/server/orchestrator/ws-handlers/` — `report_shipit_bug` (draft) and
  `submit_bug_report` (confirm) handlers.
- `src/server/shared/types/ws-server-messages.ts` / `ws-client-messages.ts` —
  `bug_report_card`, `bug_report_filed`, `bug_report_rejected`, `submit_bug_report`.
- `src/server/orchestrator/agent-instructions.ts` — bug-filing capability prompt.
- `src/client/components/BugReportCard.tsx` (new) — the inline review card.
- `src/server/orchestrator/integration_tests/user-bug-filing.test.ts` (new) —
  end-to-end with a stubbed provider: redaction applied, rate limit enforced, issue
  created only after confirm.
