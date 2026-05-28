# Linear integration (P0)

Linear gives us most of this feature out of the box. We register ShipIt as a Linear OAuth app with the agent scopes; ShipIt then shows up in Linear's native delegation picker on every issue. When a user delegates an issue to ShipIt, Linear fires a structured `AgentSessionEvent` webhook with full issue context, and ShipIt emits typed *activities* back into the session — `thought`, `action`, `response`, `error`, `elicitation` — which Linear renders as an inline status surface on the issue.

This is meaningfully better UX than any label/comment hack we could build, and it's why Linear is P0 instead of P1.

## Linear app registration

The Linear app lives in its own public repo under the ShipIt GitHub namespace (e.g. `shipit-linear-app`) — separate from `nicolasalt/shipit` so its listing metadata, icon, and privacy policy don't churn with main-repo work. The app is published once to Linear's developer console under the ShipIt project's name; users install it from there into their own workspaces (workspace admin required by Linear).

App configuration:

- **OAuth mode:** `actor=app` — we operate as the app identity, not on behalf of the installing user. Required by Linear's agent surface.
- **Scopes:**
  - `read` — fetch issue context at session start
  - `write` — emit activities, post comments
  - `app:assignable` — makes ShipIt show up as a delegate option on issues
  - `app:mentionable` — makes ShipIt @-mentionable in issues and documents
- **Webhook URL:** `<user-tunnel-url>/api/webhooks/linear` — set per-installation by each user during connect.
- **Webhook events:** `Agent session events` — gives us `AgentSessionEvent.created` and `AgentSessionEvent.prompted`.
- **Webhook secret:** generated per-install, stored in `CredentialStore`.

Note: `admin` scope cannot be combined with `actor=app`; this is fine, we don't need it.

## AgentSession — the central concept

Linear creates an `AgentSession` automatically whenever a user delegates an issue to ShipIt (or @-mentions ShipIt). It's Linear's persistent thread for the agent's work on the issue:

- Has a Linear-managed state: `pending` / `active` / `awaitingInput` / `complete` / `error` / `stale`.
- Accumulates *activities* (typed events emitted by the agent) rendered as a timeline on the issue.
- User follow-ups on the issue arrive as `prompted` events into the same session.

We don't build a separate ShipIt-status surface — the AgentSession *is* the surface. We just emit into it.

## Webhook events

- **`AgentSessionEvent.created`** — fired when a user delegates an issue or @-mentions ShipIt. Payload includes the `agentSession` object with the originating issue, comment (if any), and full prompt context (`promptContext` field).
- **`AgentSessionEvent.prompted`** — fired when the user sends a follow-up into an existing AgentSession (e.g. comments on the issue with ShipIt mentioned). The follow-up text is in `agentActivity.body`.

## Activity emission

Activities are how the agent reports progress back. Five types, all used:

| Activity | When ShipIt emits it |
|---|---|
| `thought` | Within 10s of `created` — "Starting a ShipIt session…" (required, see timing constraints) |
| `elicitation` | When a per-team default repo isn't configured — "Which repo should I open the session on?" |
| `action` | When the session opens a PR — `{ action: "Opened pull request", parameter: "shipit/foo#456", result: <PR URL> }` |
| `response` | When the PR merges — marks the session `complete` |
| `error` | Session creation failed, or unrecoverable error in the session |

We deliberately *don't* emit per-turn activities. Cadence is one `action` per PR open, one `response` per PR merge — the minimal cadence agreed on across this design. Linear handles state transitions; we don't need extra activity for state alone.

## Timing constraints

Two deadlines, both load-bearing:

- **Webhook ACK ≤ 5s** — HTTP response must return 2xx within 5 seconds or Linear treats the webhook as failed and retries.
- **First `thought` activity ≤ 10s** — Linear marks the session unresponsive if no activity (or external-URL update) is emitted within 10s of `created`. Independent of the webhook ACK.

Handler shape:

```
on POST /api/webhooks/linear:
  verifyHmac(payload, secret)         // reject if invalid
  if dedupe.seen(eventId): return 200
  enqueueBackgroundJob(payload)
  return 200                          // <5s deadline met

background job:
  parse payload → resolve repo
  emit "thought" activity              // <10s deadline met
  spawn ShipIt session (slow)
  emit "action" with session URL once created
```

## Multi-turn via `prompted`

When a `prompted` event arrives for an existing session:

1. Look up the ShipIt session by AgentSession ID (stored on `SessionInfo.issueRef.providerData.agentSessionId`).
2. Dispatch `agentActivity.body` into the existing session as a follow-up user message — same flow as a normal chat message.
3. The agent's response is summarized into a `response` or `action` activity emitted back.

Free bidirectional channel: the user can keep talking to the agent from inside the Linear issue thread. No extra UI work.

## Repo resolution

Two paths:

1. **Configured (recommended):** user sets a per-Linear-team default repo in ShipIt settings (one row per team). The trigger handler reads `agentSession.issue.team.key`, looks up the mapping, resolves immediately.
2. **Unconfigured fallback:** if no mapping exists for the issue's team, ShipIt emits an `elicitation` activity ("Which repo?"). The user's reply arrives as a `prompted` event; we resolve and remember the choice for this team.

## PR body still gets `Fixes ENG-123`

Even though AgentSession activities give us a richer status surface, we still append `Fixes ENG-123` to the PR body:

1. **Belt-and-suspenders close-on-merge.** If the user has Linear's native GitHub integration installed, `Fixes ENG-123` triggers issue-close on merge via GitHub-side magic words. Independent of our AgentSession.
2. **Cross-referencing in GitHub.** GitHub's PR UI uses the magic word to render "linked issues"; without it, the PR looks unanchored on the GitHub side even if Linear knows about it.

## Developer Preview risk

Linear's agent APIs are marked Developer Preview at the time of writing — they may change before GA. Mitigation:

- Linear-specific code lives behind the `IssueTrackerProvider` interface in `services/issue-trackers/linear/`. A breaking change is a localized refactor.
- Snapshot the version of Linear's docs we built against in a header comment on the adapter so a future contributor can diff against then-current docs.
- Subscribe to Linear's developer changelog / release notes via the developer mailing list when we register the app.

## Key files

- `src/server/orchestrator/services/issue-trackers/linear/index.ts` (new) — `LinearTrackerProvider` implementing `IssueTrackerProvider`
- `src/server/orchestrator/services/issue-trackers/linear/oauth.ts` (new) — `actor=app` OAuth flow
- `src/server/orchestrator/services/issue-trackers/linear/activities.ts` (new) — typed activity emission helpers
- `src/server/orchestrator/services/issue-trackers/linear/webhook.ts` (new) — HMAC verification, event parsing
- `src/server/orchestrator/api-routes-webhooks.ts` — dispatch `linear` to provider
- `src/client/components/SettingsIssueTrackers.tsx` — "Connect Linear" + per-team default-repo UI
- (separate repo) `shipit-linear-app/` — Linear app listing metadata, icon, privacy policy

## References

- [Linear Developers — Getting Started (Agents)](https://linear.app/developers/agents)
- [Linear Developers — Agent Interaction](https://linear.app/developers/agent-interaction)
- [Linear Docs — AI Agents in Linear](https://linear.app/docs/agents-in-linear)
- [Linear Developers — Webhooks](https://linear.app/developers/webhooks)
