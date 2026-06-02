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

### Producers: regular sessions *and* ops sessions

Both are first-class. They share one path (`report_shipit_bug` → redact → confirm →
file) and differ only in the evidence the agent can attach:

| Producer | Typical trigger | Evidence available | Credential |
|---|---|---|---|
| **Regular session** (default, common case) | A user building their own project hits a ShipIt bug ("the preview won't reload", "ShipIt keeps killing my container"). | Redacted transcript excerpt + server-stamped platform version + coarse browser/env. **No** Docker/journal — a normal session has no ops privileges. | The user's own GitHub auth (same token they use for their project PRs). |
| **Ops session** (`docs/128`, privileged) | An ops session diagnosed a host bug but its `--shipit-source` fix-spawn was denied for lack of push access to the ShipIt repo. | Everything above **plus** read-only Docker/journal evidence. That no-write branch routes *here* instead of dead-ending as a written incident report. | Same — the user's own GitHub auth. |

The ops session is the *richer* producer, not a separate mechanism. Everything
below (redaction pipeline, consent card, filing) is identical for both.

### What the report contains

| Field | Source | Notes |
|---|---|---|
| Title + description | Agent, from the conversation | The user's own words, summarized. |
| What happened / repro | Agent — it authors the body and chooses what's relevant | No separate excerpt-extraction step; whatever the agent includes is then redacted. |
| ShipIt build (commit SHA) | **Orchestrator, server-side** | The bare `SHIPIT_BUILD_ID` commit (stamped at image-build from `git rev-parse HEAD`) — the version actually running. `unknown` when unset (dev/local builds). No checkout cross-reference, so no "approximate" state. Not from the session container. |
| Browser / environment | Client-supplied, coarse | UA family, viewport — no fingerprinting. |
| Author identity | GitHub (the user's own account) | The issue is attributed to the filer's real GitHub identity — same as a hand-filed issue. Expected and fine. |

Every gathered field above (except the author identity, which is inherent to filing
as the user) is assembled into a **single editable issue body** shown in the card —
not separate non-editable attachments. The server *stamps* the build and *gathers*
the rest into that draft body; from there it is fully editable. See "Consent UI."

**Never included:** the user's email (beyond what GitHub already exposes for the
author), their project's repo URL/name, file contents from their workspace,
secrets, OAuth tokens, or full chat history. The user's *project* is irrelevant to
a ShipIt bug; only the redacted *interaction with ShipIt* matters. Because the
issue is **public and carries the user's name**, redaction is the load-bearing
safety mechanism here.

### Redaction pipeline (fulfills part of `docs/023`)

The dangerous field is the agent-composed **transcript excerpt** (plus, for ops
sessions, the Docker/journal evidence) — free text that can quote a token, an
email, workspace file contents, an internal hostname, or a third party's data
inline. Redaction runs server-side, **before** the payload is ever shown in the
card, as a two-stage pipeline. The two stages are complementary: the first is a
deterministic floor, the second is a semantic net for what the first can't see.

**Stage 1 — heuristic content scrubbing (deterministic floor).** Scan the text for
secret/PII *substrings* and replace with `[REDACTED]`:

- The patterns from `docs/023` (`sk-…`, `ghp_…`, `Bearer …`, generic long-token
  heuristics), **email addresses**, and **git/remote URLs** (reuse
  `stripUrlCredentials` from `git-utils.ts` to strip embedded creds, then drop
  host/path).
- Note `REDACTED_PATTERNS` / `isRedactedSourcePath` in `shipit-source.ts` match
  file *paths*, not content — they decide whether a whole file may be referenced.
  Reuse them only to *exclude* sensitive paths from the excerpt and to redact
  absolute workspace paths; do **not** mistake them for content redaction (lifting
  them alone yields a no-op redactor).

This stage is fully deterministic and unit-testable, and it is the **guaranteed
floor**: whatever happens next, known-shape secrets are already gone.

**Stage 2 — LLM redaction pass (last step, best-effort).** Heuristics miss the
unstructured stuff: a person's name, an internal hostname, a customer's data quoted
in prose, a secret in a novel format. After Stage 1, send the *already-scrubbed*
body to the model for a semantic privacy pass, using a **mid-tier (Sonnet-class)
model** of the session's provider (`claude-sonnet-4-6` for Claude; the provider's
mid-tier equivalent for Codex) — worth the small extra cost for a safety-critical
pass that's filed publicly under the user's name. The input is just the
agent-authored body (the agent already chooses what's relevant when it composes the
report — there is no separate excerpt-extraction step), with a sanity token ceiling
as a guard against a pathologically large body. Hard constraints:

- **Span-based, code-applied.** The model returns the **substrings/spans it judges
  sensitive**; our code applies the `[REDACTED]` replacement. The model never
  returns rewritten text. We verify its output describes deletions only — no
  additions, no rewrites — so it cannot inject content into a payload filed under
  the user's name.
- **Fail safe.** If the call errors or times out, we do **not** silently ship as
  though it ran. Stage 1's output stands as the floor, and the card is flagged
  ("deep privacy check didn't complete — review carefully") so the human knows the
  semantic net didn't run.
- **No new trust boundary, and it runs orchestrator-side.** The session transcript
  already passed through the same model provider during the session, so re-sending
  the scrubbed text for redaction exposes it to no new third party — *provided the
  pass runs on that same provider/credential*. It does: the **orchestrator already
  owns and refreshes the user's subscription OAuth token** (`agents/claude/auth-manager.ts`
  + `oauth-refresher.ts`, `agents/codex/auth-manager.ts`; see `docs/153`) — the same
  token it injects into the session container. So the Stage-2 call is a dedicated,
  single-purpose **structured call made by the orchestrator** using that already-held
  credential for the session's provider. No session-container round-trip, no new API
  key, and it's a deterministic orchestrator-controlled pipeline stage (not dependent
  on agent diligence). The model returns spans; orchestrator code applies them.
- **Not a substitute for consent.** Two redaction layers shrink what the user must
  catch; they do not replace the user confirming the exact payload in the card. We
  never present "LLM-redacted" as "safe to ignore."

New module: `src/server/orchestrator/services/redaction.ts` + `redaction.test.ts`
(Stage 1 deterministic; Stage 2 with a stubbed model). A test proves an inline
`ghp_…` / email / workspace path in free text is scrubbed by Stage 1, and that a
Stage-2 failure degrades to the Stage-1 floor with the card flag set rather than
leaking. Stage 1 is the reusable core `docs/023` will later consume for full
session export; we build it now and un-pause `docs/023` partially.

### Consent UI — inline bug-report review card

A new card type, sibling of `PrLifecycleCard`, emitted into the chat:

```
┌─ Report a bug to ShipIt ───────────────────────────────────┐
│ Title:  [ editable                                       ]  │
│                                                            │
│ Body — this is exactly what gets posted. Edit anything:    │
│ ┌────────────────────────────────────────────────────────┐│
│ │ <one-line description>                                 ││
│ │                                                        ││
│ │ ## What happened                                       ││
│ │ <redacted transcript excerpt — 3 turns>                ││
│ │ <ops only: redacted Docker/journal evidence>           ││
│ │                                                        ││
│ │ ---                                                    ││
│ │ ShipIt build a1b2c3d · Chrome / 1440×900               ││
│ └────────────────────────────────────────────────────────┘│
│                                                            │
│ ⚠ deep privacy check didn't run — review carefully  (cond) │
│ Filed as @you · public on the ShipIt repo                  │
│ Nothing is sent until you click Submit.                    │
│            [ Cancel ]              [ Submit report ]       │
└────────────────────────────────────────────────────────────┘
```

- **One editable Body = the entire payload (WYSIWYG).** There is no separate
  "attachments" or "will be sent" block. The redacted description, the transcript
  excerpt, the ops Docker/journal evidence, and the build/browser footer are *all*
  pre-filled into the single editable Body field. What is in that box is exactly
  what gets filed — nothing is sent outside it. This is load-bearing for consent:
  if the user spots a redaction miss in the excerpt, they delete it right there
  before submitting. No field is posted that they couldn't see *and* edit.
- **Deliberate tradeoff: the build/browser footer is editable too**, so a user can
  alter or remove it. We accept that — control over the exact payload outranks
  guaranteed triage metadata, and a mangled build string only makes a report less
  useful, never unsafe. The **author identity** (`@you`) is the one thing *not* in
  the Body: it's inherent to filing the issue as the user, shown for transparency.
- The card surfaces the Stage-2 "deep privacy check didn't run" flag when
  applicable, and states plainly that the issue is **public and attributed to the
  user**, so review carries real weight.
- "Submit" is the only path that files the issue. On success the card swaps to a
  "Filed — #1234" state with a secondary "View on GitHub" escape hatch in an
  overflow (principle §2: inline first, link-out is the escape hatch).
- "Cancel" discards; nothing is sent.

### Server flow

```
agent → report_shipit_bug (draft)
      → server: redact() = Stage 1 heuristics → Stage 2 LLM pass (fail-safe to Stage 1)
              → emit bug_report_card (exact redacted payload; flag if Stage 2 didn't run)
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

- **Destination is fixed:** `UPSTREAM_REPO = "nicolasalt/shipit"`, hard-coded with
  no env override. Not the user's project repo. (A fork that wants its own target
  changes the constant — a deliberate code edit, not config.)
- **Labels are markers, not API labels — because GitHub drops them.** GitHub
  **silently discards `labels` (and assignees/milestone) on issue creation when the
  filer lacks push access** — which is the common case here (a regular user has no
  push to the ShipIt repo). So passing `labels: [...]` would no-op for exactly the
  population this serves. Instead, the chosen markers — `user-reported` plus a
  **producer marker** (`source:ops` when an ops session produced it, `source:session`
  otherwise) — are encoded **in the issue body** (a visible footer line + a parseable
  HTML comment, e.g. `<!-- shipit-report source=ops build=abc123 -->`), which always
  survives. A small maintainer-side automation on `nicolasalt/shipit` reads the
  marker and applies the real repo labels. When the filer *does* have push access (a
  ShipIt developer), we additionally set the labels directly on the create call.
- **Credential is the user's own GitHub auth** — the orchestrator already holds it
  via `GitHubAuthManager` for PRs (a pasted PAT). The common case is a **classic
  `repo`-scoped PAT**, which already includes `public_repo`, so creating an issue on
  the upstream repo just works. **Do not pre-flight a scope check** — a *fine-grained*
  PAT scoped only to the user's own repos has no Issues:write on the upstream repo
  and will 403, and there is no reliable way to assume scope from the token. Instead,
  attempt the create and treat the GitHub 403/scope error as the gate, surfacing it
  as a clear "your GitHub token can't file issues on the ShipIt repo — reconnect with
  a token that can" prompt.
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
| `docs/128` ops session | **Forked producer + loop close.** A ShipIt deployment is one human per box, and that human may or may not have push access to the ShipIt repo. An ops session diagnosing a host bug forks on exactly that, via `checkRepoWriteAccess`: **with** push, it spawns a fix PR (`--shipit-source`); **without**, the spawn 403s and the diagnosis is filed as a redacted issue **through this flow** instead of dead-ending as text. The ops session is the *highest-quality* producer here — it has real Docker/journal evidence to redact and attach. Downstream, a developer with push picks the issue up via 156's inbound path. |

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

## Open questions

All four original open questions are resolved (Stage-2 runs orchestrator-side on the
already-held OAuth credential; Stage-2 model is Sonnet-class; build is the bare
`SHIPIT_BUILD_ID` SHA; target is hard-coded `nicolasalt/shipit` with body-marker
labels). One follow-up emerged, tracked separately:

- **Maintainer-side label automation** on `nicolasalt/shipit` — a small GitHub
  Action that reads the `<!-- shipit-report … -->` body marker and applies the real
  `user-reported` / `source:*` labels (needed because the filer's token usually
  can't set labels on a repo it can't push to). Lives in the upstream repo, not this
  codebase; not a blocker for the in-product flow.

## Key files

- `src/server/orchestrator/services/redaction.ts` (new) + test — shared redaction.
- `src/server/orchestrator/services/bug-report.ts` (new) — compile draft, redact,
  stamp platform version, dispatch to `GitHubAuthManager`.
- `src/server/orchestrator/github-auth.ts` (+ `github-auth-*.ts`) — new
  `createIssue(repo, { title, body })` method against the fixed upstream repo,
  using the user's existing token; no scope pre-check — surfaces the GitHub
  403/scope error as a reconnect prompt.
- `src/server/orchestrator/ws-handlers/` — `report_shipit_bug` (draft) and
  `submit_bug_report` (confirm) handlers.
- `src/server/shared/types/ws-server-messages.ts` / `ws-client-messages.ts` —
  `bug_report_card`, `bug_report_filed`, `bug_report_failed`, `submit_bug_report`.
- `src/server/orchestrator/agent-instructions.ts` — bug-filing capability prompt.
- `src/client/components/BugReportCard.tsx` (new) — the inline review card.
- `src/server/orchestrator/integration_tests/user-bug-filing.test.ts` (new) —
  end-to-end with a stubbed GitHub auth manager: redaction applied, issue created
  only after explicit confirm, scope-missing path surfaces a connect prompt.
