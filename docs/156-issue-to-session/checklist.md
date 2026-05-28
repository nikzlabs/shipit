# Tracker-triggered sessions — checklist

## Shared infrastructure (do first)

- [ ] `IssueRef` type with provider-specific `providerData`, threaded through `SessionInfo`
- [ ] `IssueTrackerProvider` interface in `services/issue-trackers/types.ts`
- [ ] `api-routes-webhooks.ts` — `POST /api/webhooks/:provider`, signature dispatch, fast-ACK + async pattern
- [ ] Per-provider webhook secret + OAuth token storage in `CredentialStore`
- [ ] Trigger-authorized identity allowlist (one slot per provider) on deployment settings
- [ ] Idempotency cache (in-memory ring buffer keyed by provider event ID)
- [ ] `headless-sessions.ts` accepts `issueRef`, derives branch + initial prompt
- [ ] PR body templating hook in `services/pr-lifecycle.ts` / `services/github.ts`, calls `provider.reportPrOpened()` / `reportPrMerged()` when `session.issueRef` is set
- [ ] Settings UI scaffold for tracker connections (`SettingsIssueTrackers.tsx`)
- [ ] Document the Cloudflare-Tunnel / Tailscale-Funnel / pure-tailnet behavior in the platform docs

## P0 — Linear

See `linear.md` for design detail.

- [ ] Linear app published to Linear developer console, listing repo `shipit-linear-app` created
- [ ] `LinearTrackerProvider` implementing `IssueTrackerProvider`
- [ ] `actor=app` OAuth flow with the four scopes (`read`, `write`, `app:assignable`, `app:mentionable`)
- [ ] Webhook handler — `AgentSessionEvent.created` and `.prompted`, HMAC verification
- [ ] Activity emission helpers — `thought`, `action`, `response`, `error`, `elicitation`
- [ ] `thought` emission within 10s of `created` (and 5s webhook ACK)
- [ ] Per-team default repo config UI in settings
- [ ] Elicitation fallback for unconfigured teams; remember user's repo choice
- [ ] `prompted` routes to existing session as a follow-up user message
- [ ] PR body still gets `Fixes ENG-123` appended
- [ ] Header-comment snapshot of the Linear docs version we built against (Developer Preview risk mitigation)
- [ ] Integration test: delegate-via-fake-webhook → session on `lin-eng-NNN-slug` → activity log emitted → PR body has `Fixes ENG-123`

## P1 — GitHub Issues

See `github.md` for design detail.

- [ ] GitHub App published to GitHub developer settings, listing repo `shipit-github-app` created
- [ ] `GitHubTrackerProvider` implementing `IssueTrackerProvider`
- [ ] App install flow, capture installer username for trigger allowlist
- [ ] Webhook handler — `issue_comment.created`, HMAC verification, slash command parsing
- [ ] Edit-in-place comment helper (post on session start, edit on PR open, edit on merge)
- [ ] PR body `Closes #N` templating, skip-if-present check
- [ ] Re-trigger on same issue → new session with `-2` / `-3` branch suffix
- [ ] Decide visual marker convention for the ShipIt comment (text-only `**ShipIt**` placeholder for now)
- [ ] Integration test: `/shipit`-via-fake-webhook → session on `gh-NNN-slug` → comment posted → PR body has `Closes #N` → comment edited on PR merge

## Decisions to revisit after P0/P1 ship

- [ ] GitHub Projects support — no native trigger surface, design separately
- [ ] Jira support — marketplace app + issue panel
- [ ] Polling-based fallback for air-gapped deployments (label-add poll) — only if there's demand
- [ ] Status flips (move issue to In Progress / Done) behind an explicit per-provider opt-in
- [ ] Resume-vs-new-session on re-trigger — currently always new
- [ ] Whether multi-deployment / multi-GitHub-account changes the API shape of `/api/webhooks/github`
