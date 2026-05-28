# GitHub Issues integration (P1)

GitHub doesn't have a first-class "agent" surface the way Linear does, so we use the closest available primitive: a GitHub App that listens for `issue_comment` events and reacts to a `/shipit` slash command. The app posts a single comment back on the issue per session, edited in place as the PR opens and merges — the GitHub-equivalent of Linear's AgentSession activities.

## GitHub App registration

The app lives in its own public repo under the ShipIt GitHub namespace (e.g. `shipit-github-app`), separate from `nicolasalt/shipit`. The App listing is created once in GitHub's developer settings under the ShipIt org/user; users install it from there onto their orgs or specific repos.

App configuration:

- **Permissions:**
  - `issues: read & write` — read issue body for context, post/edit comments
  - `pull_requests: read & write` — needed for PR body templating from the App identity
  - `metadata: read` — required default
- **Event subscriptions:**
  - `issue_comment` — catches the `/shipit` trigger
  - (later, optional) `pull_request` for PR-merged events — if we want to drive the comment edit from the App's webhook instead of from ShipIt's existing PR lifecycle poller
- **Webhook URL:** `<user-tunnel-url>/api/webhooks/github` — set per-installation by each user during connect.
- **Webhook secret:** generated per-install, stored in `CredentialStore`.

## Slash command parsing

The trigger is `/shipit` at the start of an issue comment, optionally followed by extra prose:

- `/shipit` — start a session with just the issue body as context.
- `/shipit focus on the Safari path` — append "focus on the Safari path" to the initial prompt.
- Anything not starting with `/shipit` on the first line is ignored.

We don't try to be clever with subcommands (`/shipit cancel`, `/shipit retry`) in v1; the chat surface in ShipIt itself is where users steer the agent. The slash command is the entry point only.

## Trigger-authorized identity

At App install time, GitHub provides the installer's username (`sender.login` on `installation.created`). We store this as the per-deployment trigger-authorized identity for the `github` provider.

Webhook handler check:

```
if comment.body does not start with "/shipit": return 200 (no-op)
if comment.user.login != deployment.github_trigger_allowlist: return 200 (silent ignore)
```

Silent on unauthorized triggers — no error comment back — so we don't leak "ShipIt is here, but you're not authorized" to org members the deployment owner hasn't allowlisted.

## HMAC signature verification

GitHub signs payloads with `X-Hub-Signature-256` using the per-install webhook secret. Standard HMAC-SHA256 verification; reject 401 on mismatch before any work. Use a constant-time comparison.

## Fast-ACK + async processing

GitHub retries on non-2xx or >10s response. Handler:

```
on POST /api/webhooks/github:
  verifyHmac(payload, secret)
  if dedupe.seen(deliveryId): return 200   // X-GitHub-Delivery
  enqueueBackgroundJob(payload)
  return 200
```

10s is more forgiving than Linear's 5s, but the architecture is identical.

## Issue context → initial prompt

The session's initial prompt is templated:

```
Working on <issue-title> (<issue-url>):

<issue-body>
```

If the `/shipit` command included extra prose, it's appended:

```
Working on <issue-title> (<issue-url>):

<issue-body>

Additional context from @<trigger-user>: <slash-command-remainder>
```

The agent treats the whole thing as a normal first user message. Chat history persistence captures it identically to a chat-typed prompt.

## Report back: edit-in-place comment

When the session is created, the App posts a single comment on the originating issue:

```
**ShipIt** → [Session](https://<tunnel-url>/sessions/<id>)
```

We store the comment ID on `SessionInfo.issueRef.providerData.commentId`. When the PR opens, edit:

```
**ShipIt** → [Session](…) — PR [#456](https://github.com/…/pull/456) opened
```

When the PR merges, edit again:

```
**ShipIt** → [Session](…) — PR [#456](https://github.com/…/pull/456) merged
```

One comment per session, edited twice. Multi-PR-per-issue means multiple comments on the issue (one per ShipIt session), which is the right cardinality — each re-trigger gets its own thread.

(The `**ShipIt**` text prefix is a placeholder for the visual marker; if the project wants an emoji or icon convention here, that's a content decision for ship time, not a design constraint.)

## PR body templating

When `session.issueRef.source === "github"`, append a single line to the PR body before calling `quickCreatePr`:

```
Closes #<n>
```

Skip if the body already contains `Closes #<n>` / `Fixes #<n>` (the agent may have written it itself). Standard GitHub close-on-merge mechanism.

## Re-trigger semantics

A second `/shipit` on the same issue creates a second session with branch `gh-<n>-<slug>-2`. The trigger handler does not look up prior sessions — multi-PR per issue is expected, and the prior ShipIt comments are part of the loaded issue context for the new session.

## Key files

- `src/server/orchestrator/services/issue-trackers/github/index.ts` (new) — `GitHubTrackerProvider` implementing `IssueTrackerProvider`
- `src/server/orchestrator/services/issue-trackers/github/webhook.ts` (new) — HMAC verification, slash command parsing
- `src/server/orchestrator/services/issue-trackers/github/comments.ts` (new) — edit-in-place comment helpers
- `src/server/orchestrator/api-routes-webhooks.ts` — dispatch `github` to provider
- `src/server/orchestrator/services/github.ts` — `quickCreatePr` body templating hook
- `src/client/components/SettingsIssueTrackers.tsx` — "Install ShipIt App" CTA
- (separate repo) `shipit-github-app/` — GitHub App listing metadata, icon, privacy policy

## References

- [GitHub Docs — Building GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [GitHub Docs — Webhook events: `issue_comment`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)
- [GitHub Docs — Verifying webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
