---
description: Trigger ShipIt sessions from the tracker — delegate-to-ShipIt in Linear (P0) or /shipit slash command in GitHub Issues (P1). Agent reports back on the issue thread, one update per PR. Multi-PR per issue is normal.
issue: https://linear.app/shipit-ai/issue/SHI-43/tracker-triggered-sessions
---

# Tracker-triggered sessions

## Goal

A developer browsing or triaging in their issue tracker should be able to push work to ShipIt with one click — no copy-paste, no tab switching, no "remember to add `Closes #N` to the PR." The trigger lives in the tracker (where the user already is); ShipIt is the executor. When the agent finishes a PR, it reports back on the issue thread so the work arc — possibly spanning multiple PRs — is visible from inside the tracker too.

## Why this matters

Issues are where most planned work originates. If ShipIt isn't a first-class consumer of the issue tracker, the user's workflow always starts in a different tab — and the cycle starting outside ShipIt drags subsequent actions (comments, follow-ups, status changes) outside too. The §1/§2 principles in `CLAUDE.md` push us to make ShipIt the entry point for work, not a downstream tool the user has to context-switch into.

A structural insight from the design discussion: **the issue is the persistent thread across multiple PRs.** A non-trivial feature might ship as a refactor PR, a feature PR, and a cleanup PR; the issue is the only place that thread is naturally captured. Reporting back on the issue (vs only on each PR) gives us the cross-PR coordination log for free.

## Non-goals

- **Not** an embedded issue tracker. We don't build board views, custom-field editors, or "create new issue" flows inside ShipIt. The tracker is the tracker; ShipIt is the executor. (A *read-only, priority-sorted* issue list with a start-session action is now in scope — but as a separate feature, `docs/168-tracker-backed-priorities`, not here. See the note under "Push, not pull" below.)
- **Not** issue status mutation. We don't move issues to "In Progress" / "In Review" / "Done." Side effects on third-party systems stay behind explicit user action. (Linear's AgentSession state is *not* the issue's state — it's a separate agent-task surface.)
- **Not** pulling lists of assigned issues into a ShipIt sidebar — *for this feature*. This doc is the push trigger only. **Superseded for the pull case:** `docs/168-tracker-backed-priorities` adds an inline, read-only, priority-sorted Issues tab once priority leaves the docs (see that doc's "Reconciling with docs/156's rejected 'Issue picker'"). The rejection below was made on the premise that docs still carry priority; SHI-28 removes that premise.
- **Not** universal "works with any tracker." First-class support for the two trackers our users actually use (Linear, GitHub Issues); other trackers wait until there's demand and we can design them properly.

## Design

### Push, not pull

The trigger is in the tracker, not in ShipIt:

- **Linear (P0):** user delegates an issue to ShipIt using Linear's native delegation picker. Linear treats ShipIt as a first-class assignable "agent." See `linear.md`.
- **GitHub (P1):** user comments `/shipit` (optionally with extra prose) on an issue. A ShipIt GitHub App listens for the webhook and triggers the session. See `github.md`.

Both providers terminate at the same internal endpoint and downstream flow:

```
tracker → webhook → IssueTrackerProvider.handleTrigger() → headless-sessions.create()
                                                          → ack back to tracker
```

> **Pull is no longer rejected — it's a sibling feature.** This doc owns the
> push trigger. The complementary *pull* surface (a read-only, priority-sorted
> Issues tab inside ShipIt, with a start-session action) is designed in
> `docs/168-tracker-backed-priorities`, which reuses this doc's
> `headless-sessions.create({ issueRef })` seeding primitive. The two are not in
> tension: push is "I'm already in the tracker, send this to ShipIt"; pull is
> "priority left the docs, so ShipIt must show what's next inline." See 168's
> reconciliation section.

### Per-deployment app registration

Both Linear apps and GitHub Apps store a **single webhook URL** on the app registration, and GitHub Apps additionally have **a single private key** used to sign installation-access-token requests. Neither value is overridable per installation. That means a single ShipIt-published Linear/GitHub app cannot serve N self-hosted deployments at different tunnel URLs — every deployment beyond the first would silently receive no events, and sharing one App's private key across deployments effectively makes it public.

Combined with the self-hosted-only stance (no centrally-hosted relay), the only workable model is **each ShipIt deployment registers its own private app**:

- The user creates a Linear OAuth app in their own Linear developer settings, with the webhook URL set to *their* tunnel URL and the scopes from `linear.md`. They paste the app's client ID, client secret, and webhook secret into ShipIt settings.
- The user creates a GitHub App in their own GitHub developer settings, with the webhook URL set to *their* tunnel URL and the permissions from `github.md`. They upload the App's private key and paste the webhook secret into ShipIt settings.

The `shipit-linear-app` and `shipit-github-app` public repos under the ShipIt namespace are **setup guides, manifest templates, and required-scope/permission lists** — not published apps. For GitHub specifically we can ship a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) so the "register your app" step is a single click that pre-fills permissions and the webhook URL.

This makes the install-time UX heavier than a marketplace install but it's the price of being self-hosted-only. It's a one-time setup per deployment.

### Provider abstraction

Even with only two providers in scope, the abstraction is load-bearing — agent reporting and trigger handling both have per-provider quirks, and "post a status update on the originating issue" call sites are scattered (PR open, PR merge, error). Designing the interface up front prevents retrofitting later.

```ts
interface IssueTrackerProvider {
  id: "linear" | "github";

  // Tracker → ShipIt
  handleTriggerWebhook(payload, signature): Promise<TriggerResult>;
  handleFollowUpWebhook?(payload, signature): Promise<void>; // Linear `prompted`; later: PR comments

  // ShipIt → tracker
  ackTrigger(ref, sessionUrl): Promise<void>;
  reportPrOpened(ref, pr): Promise<void>;
  reportPrMerged(ref, pr): Promise<void>;
  reportError(ref, message): Promise<void>;

  // Helpers
  formatClosingKeyword(ref): string; // "Fixes ENG-123" / "Closes #456"
}
```

`reportPrOpened` and friends map to **activity emission** in Linear (structured) and **comment edit-in-place** in GitHub (plaintext). The interface hides the difference; the per-provider docs describe the implementation.

### Reporting cadence — minimal

One agent-to-tracker update per PR, with two states (opened, merged). On error, a single error update. No turn-by-turn progress, no status flips on the issue itself, no comment-per-push.

The user's argument stands: actual progress lives in the checklist and the code; the issue is just the coordination breadcrumb. When the agent later picks up an issue that already has prior ShipIt activity, that activity is part of the issue context loaded at session start — multi-PR continuity comes for free.

### Repo resolution

| Provider | Source of repo |
|---|---|
| GitHub Issues | Issue carries it (`owner/repo#N`). Trivial. |
| Linear | Issue doesn't carry one. Per-Linear-team default repo configured in ShipIt settings ("issues in team `ENG` default to repo `owner/foo`"). If unconfigured, Linear's `elicitation` activity asks the user inline. |

The Linear per-team mapping is the recommended setup; the elicitation fallback means we degrade gracefully instead of hard-failing.

### Trust boundary = app install scope

ShipIt has no notion of users — each deployment is one human. With per-deployment app registration, the natural trust boundary is **the scope where the deployment owner installed their app**:

- **Linear:** the workspace(s) the deployment owner installed their app on. Any workspace member who can interact with an issue can delegate it to ShipIt.
- **GitHub:** the org / repos the deployment owner installed their app on. Any user with comment access on those repos can `/shipit`.

The deployment owner has already exercised consent at install time by choosing which workspace / repos to install on. Restricting further (e.g. "only the installer themselves can trigger") would break the most natural use case — a teammate triages an issue and delegates it to the team's ShipIt — for no real security gain over "uninstall the app from this workspace."

Webhook handlers verify the payload's HMAC signature and the trigger originates from an installation scope we recognize; beyond that we don't gate per-user in v1. A future per-user allowlist UI is a tightening, not a default.

When a payload arrives whose installation scope we don't recognize (stale install, deleted from settings, etc.), we silently 200 it — we don't ack back to avoid leaking "ShipIt is here" to unfamiliar installs.

### Webhook architecture (shared)

1. **Public URL required.** Both Cloudflare Tunnel and Tailscale Funnel expose the orchestrator on a public hostname without opening inbound ports — both work natively for webhooks. Pure-tailnet deployments (no Funnel) can't receive webhooks; for those users this feature is unsupported, documented as a known limitation. **No hosted webhook relay** — that would conflict with the self-hosted-only stance.
2. **Fast ACK + async processing.** Webhook handlers return 200 within the provider's deadline (Linear: 5s, GitHub: 10s). Session-creation work runs in a background task. Linear has an additional 10s deadline to emit a first `thought` activity — fast-ACK + background-create + emit-thought must interleave correctly.
3. **HMAC signature verification.** Both providers sign payloads with a shared secret. Unverified payloads are rejected with 401 before any work. Secrets live in `CredentialStore`.
4. **Idempotency, persisted.** Both providers can retry on timeout. Each event has a unique ID (`X-GitHub-Delivery`, Linear's `webhookId`); we record the IDs in a small SQLite-backed dedupe store (sibling of `secret-store.ts`) keyed by `provider:eventId` with a short TTL (24h). An in-memory cache would double-spawn around orchestrator restarts (which happen on every deploy), and a duplicate trigger here surfaces as a duplicate branch + duplicate PR + duplicate comment — far more visible than the typical "best-effort retry" contract.
5. **Failure visibility.** If session creation fails after we've ACKed the webhook, we report back through the provider's normal channel (Linear `error` activity / GitHub error comment). Silent drops are the worst failure mode here.

### Multi-PR per issue and re-trigger

Re-triggering on the same issue is normal, not a duplicate. Default: create a new session on a new branch (`-2`, `-3` suffix). Prior ShipIt activity on the issue is part of the new session's loaded context. We don't dedupe.

## Phasing

### P0 — Linear

Linear gets first-class treatment because the platform already models exactly the interaction we want: a delegated agent that emits typed activities into an `AgentSession` rendered inline on the issue. We end up writing less code than the GitHub path because Linear hands us the status surface; we just emit into it.

**Ship gate:** a workspace admin can install the ShipIt Linear app, configure a per-team default repo, delegate an issue to ShipIt, and see the session start on the right branch with an activity log emitted back to Linear culminating in an `Opened pull request` `action` and a `complete` `response` on merge.

### P1 — GitHub Issues

Adds the GitHub App, the `/shipit` slash command, HMAC verification, and the edit-in-place ShipIt comment. The session-creation downstream is the same code path as Linear — only the trigger and report-back surfaces differ.

**Ship gate:** a user installs the ShipIt GitHub App on a repo, comments `/shipit` on an issue, gets a session on `gh-<n>-<slug>`, sees a "Started in ShipIt" comment that edits in place when the PR opens and merges, and the PR body auto-includes `Closes #N`.

### Later (not in scope)

- **GitHub Projects** — no native trigger affordance on the project board UI; needs separate design.
- **Jira** — marketplace app + issue panel; defer until there's demand.
- **Polling fallback for air-gapped deployments** — if pure-tailnet users actually show up, label-add polling can come back as a Phase 3.
- **Universal "magic URL" fallback** — explicitly de-prioritized in favor of two high-quality deep integrations.

## Rejected alternatives

- **Issue picker in ShipIt** (list issues, click to start). ~~The user's job in the tracker is to triage and pick what to work on next; doing that *also* in ShipIt with worse filtering would be a strict loss.~~ **Superseded by `docs/168-tracker-backed-priorities`.** This rejection assumed docs still carry `priority`, so ShipIt already had an internal "what's next" surface and a picker would be a redundant second triage surface. SHI-28 removes priority from docs, leaving no such surface — so an inline, read-only, *priority-sorted* picker (explicitly **not** a triage/filter UI: no JQL/Linear-view/GitHub-query builder) is now required by §1/§2, and lives in `docs/168`. The original concern — don't chase per-tracker filter UIs we'll always be behind on — is honored by keeping 168's picker read-only and priority-sorted only.
- **Universal "magic URL" fallback** (`shipit.app/start?issue=...` as a custom-link template). Cheap, but the user chose quality of the deep integrations over breadth.
- **Hosted webhook relay** for air-gapped deployments. Conflicts with the self-hosted-only stance. Users who want webhooks expose a public URL via Cloudflare Tunnel or Tailscale Funnel.
- **Issue status mutation** (move to "In Progress" / "Done"). High surprise risk; the user has not asked for it. Easy to add later behind an explicit per-provider opt-in.
- **Auto-comment on every meaningful event.** Noisy; the user explicitly chose minimal cadence.
- **A single centrally-published ShipIt app.** Even publishing it from the ShipIt project namespace (rather than Anthropic's) doesn't work for self-hosted deployments: both Linear and GitHub Apps store a single webhook URL per registration, and GitHub Apps additionally require the App's private key for installation auth — which can't be safely shared across deployments. Each ShipIt deployment registers its own private app; the `shipit-linear-app` and `shipit-github-app` repos publish setup guides and manifest templates, not the apps themselves. See "Per-deployment app registration" above.
- **Label-based trigger as the primary Linear UX.** Made obsolete by Linear's first-class agent assignment / delegation surface (see `linear.md`); a label hack would now be a strict downgrade.

## Open questions

- **App listing repo layout.** The Linear app and the GitHub App probably each live in a small public repo under the ShipIt GitHub namespace (separate from `nicolasalt/shipit`), since they each have their own listing metadata, icon, privacy policy. Naming convention TBD (`shipit-linear-app`, `shipit-github-app`?).
- **Resume vs new session on re-trigger.** Default is always-new; revisit once we see usage.
- **Multi-deployment users** (laptop + VPS installing the same App twice). Webhook URL is per-installation so this works naturally, but worth confirming the install UX makes this clear.

## Per-provider details

- **`linear.md`** — Linear app registration, AgentSession model, activity types, 5s/10s timing, multi-turn via `prompted`, Developer Preview risk.
- **`github.md`** — GitHub App registration, slash command parsing, HMAC verification, edit-in-place comment, `Closes #N` templating, re-trigger semantics.
- **`checklist.md`** — work items, grouped by shared infrastructure / P0 / P1.

## Key files (shared infrastructure)

Per-provider files are listed in `linear.md` / `github.md`. Shared touch points:

- `src/server/orchestrator/services/issue-trackers/` (new) — `IssueTrackerProvider` interface, dispatch
- `src/server/orchestrator/services/issue-trackers/types.ts` (new) — `IssueRef`, `TriggerResult`, activity/comment types
- `src/server/orchestrator/services/headless-sessions.ts` — accept `issueRef`, derive branch + initial prompt
- `src/server/orchestrator/pr-status-poller.ts` — add a new `onPrFirstSeenCb` hook symmetric to the existing `onMergeDetectedCb`. Both `reportPrOpened()` and `reportPrMerged()` are driven from the poller, not from `pr-lifecycle.ts`. The poller is the only path that uniformly observes all four PR-create routes (the lifecycle-card auto-create, the two manual API routes `/pr/quick` and `/pr`, the agent-create route `/pr/agent-create`) plus PRs the agent creates directly via the `gh pr create` shim mid-turn. Driving both hooks from the poller avoids silently missing "PR opened" in any of those cases.
- `src/server/orchestrator/services/github.ts` — `quickCreatePr` body templating hook, appends `provider.formatClosingKeyword()` to the PR body
- `src/server/orchestrator/credential-store.ts` — per-provider webhook secrets + OAuth tokens
- `src/server/orchestrator/api-routes-webhooks.ts` (new) — `POST /api/webhooks/:provider`, signature verification, fast-ACK, dispatch
- `src/server/shared/types/domain-types.ts` — `IssueRef`, extend `SessionInfo`
- `src/client/components/SettingsIssueTrackers.tsx` (new) — install/connect UI, per-Linear-team default-repo config
- `src/client/components/PrLifecycleCard.tsx` — issue chip rendering
- `src/server/orchestrator/integration_tests/tracker-triggered-session.test.ts` (new) — end-to-end coverage with stubbed providers
