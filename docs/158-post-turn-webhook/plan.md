---
status: planned
priority: medium
description: User-configurable HTTP webhook fired after each agent turn, so external agents (e.g. a personal assistant on another server) can react to ShipIt activity.
---

# Post-turn webhook

## Summary

Let a user configure a single outbound HTTP endpoint that ShipIt POSTs to after every agent turn ends, with a structured JSON payload summarising what just happened. The motivating use case is a personal "general-purpose" agent (Hermes) running elsewhere on the user's network that wants to know when a ShipIt agent has stopped, so it can push the summary to the user (voice, Slack, push notification, etc.). The feature is generic: ShipIt knows nothing about the receiver, just the URL and an optional bearer token.

## Motivation

ShipIt agents can run unattended. The user is not always watching the chat. Today the only signal that something is finished is the UI itself — and if the user is in another room, on their phone, or doing something else, they don't get one.

MCP already lets the *agent itself* call out to external services mid-turn, but that's agent-decided and unreliable for "always notify me when a turn ends." A post-turn webhook fills the other half: a server-side hook that fires deterministically when the turn boundary is crossed, regardless of what the model decided to do.

This is the same reliability tradeoff as the existing PR-creation flow: not 100%, but good enough to play with. Auto-PR creation lives in the same post-turn slot and is acknowledged as imperfect; the webhook accepts the same profile.

The feature is **opt-in and decentralised** — no URL configured means nothing fires. ShipIt is not building an integration with anyone's specific external agent; it's exposing a hook anyone can plug into.

## Design

### Storage — account-level credential

Mirror the MCP server config pattern: store in `CredentialStore`, account-scoped (not per-repo, not per-session), persisted to `/credentials/shipit-credentials.json`. One webhook per user account.

Extend `CredentialData` in `src/server/orchestrator/credential-store.ts`:

```typescript
interface CredentialData {
  // ... existing fields
  postTurnWebhook?: {
    url: string;            // https:// only, validated at write time
    bearerToken?: string;   // optional, sent as `Authorization: Bearer <token>`
    enabled: boolean;       // soft kill-switch without losing config
  };
}
```

Getter/setter methods on `CredentialStore`:
- `getPostTurnWebhook(): CredentialData["postTurnWebhook"] | undefined`
- `setPostTurnWebhook(config: CredentialData["postTurnWebhook"]): void`
- `clearPostTurnWebhook(): void`

The bearer token is the only sensitive value; it lives in this same blob (file is `0o600`, in the credentials volume). No separate secret-namespace plumbing like MCP's `mcp__<server>__*` — there's exactly one secret per user, so the extra indirection is overkill.

### Validation — `services/webhook.ts`

New service module `src/server/orchestrator/services/webhook.ts`:
- `validatePostTurnWebhookConfig(input)` — URL must parse, scheme must be `https:` OR `http:` to a private/loopback/Tailscale address (the user's case is `http://hermes.tail-xyz.ts.net/...`, which is fine; we don't force HTTPS on private networks). Bearer token, if present, must be a non-empty string ≤ 4 KB.
- `getPostTurnWebhookForApi()` — returns config with the bearer token redacted (`"***"`) for UI consumption.

### HTTP routes — `api-routes-webhook.ts`

New route file `src/server/orchestrator/api-routes-webhook.ts`, registered from `api-routes.ts`:
- `GET /api/post-turn-webhook` → `{ url, enabled, hasToken }` (token never returned)
- `PUT /api/post-turn-webhook` → set/update; full token replacement only
- `DELETE /api/post-turn-webhook` → clear

Use `ServiceError(400, …)` for validation failures so the route handler can return proper status codes.

### Fire point — after PR lifecycle, in both turn-end paths

`src/server/orchestrator/ws-handlers/agent-execution.ts` already calls `postTurnCommit()` then `emitPrLifecycleAfterCommit()` in two places:
- Streaming path: around the `agent_result` event handler (~lines 451–519)
- Non-streaming path: around `agent.on("done", …)` (~lines 603–643)

Add a third step after PR lifecycle in both spots:

```typescript
await firePostTurnWebhook(ctx, {
  sessionId: capturedSessionId,
  sessionDir: capturedSessionDir,
  runner,
  commitHash,
  // pulled from agent_result event metadata if available
  durationMs,
  costUsd,
  wasInterrupted: runner?.wasInterrupted ?? false,
});
```

`firePostTurnWebhook` is a new helper in `src/server/orchestrator/ws-handlers/post-turn-webhook.ts` (sibling to `post-turn.ts`). It:
1. Reads `credentialStore.getPostTurnWebhook()`. If absent or `enabled === false`, return immediately — zero overhead for users who don't configure it.
2. Resolves the latest session metadata (name, branch, remote, last known PR URL) via `sessionManager.getSession(sessionId)`.
3. Builds the payload (schema below).
4. Fires `fetch(url, { method: "POST", … })` with a 10-second timeout via `AbortSignal.timeout(10_000)`.
5. Logs success/failure but never throws. The webhook must not be able to break the turn.

It is **fire-and-forget for turn semantics** but **awaited locally** so we can log timing and outcome. If a user wants no blocking at all, we can revisit and make it truly background, but a 10-second cap is fine for v1.

### Payload schema

POST body, `Content-Type: application/json`:

```json
{
  "event": "turn_ended",
  "schemaVersion": 1,
  "timestamp": "2026-05-29T14:32:11.482Z",
  "shipit": {
    "version": "0.x.y",
    "host": "shipit.example.com"
  },
  "session": {
    "id": "ses_abc123",
    "name": "Add post-turn webhook feature",
    "branch": "shipit/abc123",
    "repoUrl": "https://github.com/owner/repo",
    "url": "https://shipit.example.com/sessions/ses_abc123"
  },
  "turn": {
    "summary": "Wired the webhook into post-turn and added settings UI.",
    "wasInterrupted": false,
    "durationMs": 45123,
    "costUsd": 0.124,
    "toolUseCount": 14,
    "commitHash": "abc1234def5678",
    "prUrl": "https://github.com/owner/repo/pull/42"
  }
}
```

Field rules:
- `event` is currently always `"turn_ended"` — present so we can add other event types later (`pr_status_changed`, `deploy_finished`, etc.) without breaking receivers.
- `schemaVersion` lets receivers refuse unknown shapes cleanly.
- `session.url` is omitted if ShipIt doesn't have a public base URL configured.
- `turn.summary` is `runner.turnSummary` (the first-line description the model already produces for chat history). Empty string if the turn was interrupted before any assistant output.
- `turn.commitHash` and `turn.prUrl` are nullable. Commit hash is null if there were no working-tree changes. PR URL is null if no PR exists for the branch yet.
- `turn.costUsd` and `turn.durationMs` come from `agent_result` event metadata; null if the underlying agent doesn't report them.

We deliberately **do not** include the full transcript. The summary plus session URL is enough for the receiver to either notify the user or fetch more detail itself.

### Auth — bearer token only

If `bearerToken` is set, the request includes `Authorization: Bearer <token>`. That's it for v1. No HMAC signing, no request IDs, no replay protection. The expected deployment is "user's own server on user's own private network," not public webhook receivers handling third-party traffic, so the threat model is small and a shared bearer is enough.

If we later need stronger guarantees we can add HMAC-SHA256 over the body with `X-ShipIt-Signature` and a separate signing secret. That's a non-breaking addition.

### Reliability profile — match the PR hook

- One attempt. No retries. No queue. No persistence.
- 10-second timeout.
- Log success (`[post-turn-webhook] 200 in 312ms`) and failure (`[post-turn-webhook] failed: timeout after 10s`) to stdout.
- Never block the user-facing turn-end UI on this.

The PR-creation flow is similarly best-effort; the user has explicitly accepted that this webhook should match its reliability profile. We can revisit if it turns out to be a real problem in practice, but the simplest thing first.

### UI — Settings panel

Add a "Post-turn webhook" section to the existing global Settings panel (the same one that hosts MCP servers). Fields:

- **URL** — text input, validated client-side as a parseable URL.
- **Bearer token** — password-style input, optional. Stored as `***` placeholder once set; explicit "Clear" button to remove.
- **Enabled** — checkbox, defaults to true on first save.
- **Test button** — sends a `{"event":"test"}` POST to the URL with the current token and shows the response status / error inline. This is the most important UX affordance — debugging webhooks blind is awful.

Reuse existing settings styling; no new design language.

### Out of scope (explicitly)

- **Multiple webhooks.** One URL per user. If somebody needs fan-out, they can run a small dispatcher behind their single URL.
- **Event filtering.** Every turn fires. If the receiver doesn't care about certain turns it filters its own side.
- **Other event types.** Only `turn_ended` for v1. The `event` field exists so we can add `pr_merged`, `deploy_failed`, etc. later without breaking the schema.
- **Per-repo overrides via `shipit.yaml`.** Account-level only. The use case (notify *me* about *my* sessions) is naturally user-scoped.
- **Outbound MCP-style tool calls from the agent.** That's already covered by configured MCP servers.

### Key files

New:
- `src/server/orchestrator/ws-handlers/post-turn-webhook.ts` — the fire-and-forget helper
- `src/server/orchestrator/services/webhook.ts` — validation + redacted-config getter
- `src/server/orchestrator/api-routes-webhook.ts` — REST routes
- `src/client/components/settings/PostTurnWebhookSettings.tsx` (or whatever the settings-panel convention is) — UI

Modified:
- `src/server/orchestrator/credential-store.ts` — add `postTurnWebhook` to `CredentialData`, getters/setters
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — call `firePostTurnWebhook(...)` after `emitPrLifecycleAfterCommit(...)` in both turn-end paths
- `src/server/orchestrator/api-routes.ts` — register the new route file
- `src/server/orchestrator/services/settings.ts` — include `postTurnWebhook` (redacted) in global settings response so the client can render current state

### Tests

- Unit tests for `services/webhook.ts` validation.
- Integration test in `src/server/orchestrator/integration_tests/post-turn-webhook.test.ts` using a fake HTTP server: configure a webhook, run a fake turn through `FakeClaudeProcess`, assert the POST was received with the expected payload and the bearer token in the header.
- Negative tests: webhook disabled → no request; receiver returns 500 → turn still completes; receiver hangs → request aborts at 10s.

## The Hermes side

The receiver is the user's own external agent. The system has no opinion on how Hermes is built, but the prompt below is what you can paste into Hermes to bootstrap the integration. It defines the contract (URL, headers, payload schema) and leaves the "what to do with the event" part open so Hermes can be told later (voice, Slack, push, etc.).

```text
You're going to add a new capability: receive turn-end events from my ShipIt
instance and notify me about them.

## What ShipIt is

ShipIt is a browser-based AI editor I use to build software. Sessions run as
isolated agent containers; each session is roughly "one chat with an agent
working on one branch of one repo." A "turn" is one round of agent work, ending
when the agent stops producing output (either it's done, it asked a question,
it was interrupted, or it errored).

## What you need to expose

An HTTP endpoint that accepts POST requests with a JSON body. Pick any path —
suggested: `POST /shipit/turn-ended`. Reachable from my ShipIt host over my
Tailscale network. Respond with `2xx` on success; the body of the response is
ignored. Any non-2xx response is logged on the ShipIt side but does not retry.

## Authentication

I'll configure a bearer token in ShipIt. Every request will include:

    Authorization: Bearer <token>

Verify it on every request, constant-time compare, reject with 401 if it
doesn't match. Store the expected token in your own secret store; do not
hardcode it. If I haven't given you a token yet, ask me for one.

## Payload schema

The request body is JSON with `Content-Type: application/json`. Schema:

    {
      "event": "turn_ended",
      "schemaVersion": 1,
      "timestamp": "ISO-8601 string",
      "shipit": {
        "version": "ShipIt build version, string",
        "host": "the ShipIt instance hostname"
      },
      "session": {
        "id": "opaque session id, string",
        "name": "human-readable session title, string",
        "branch": "git branch name, string",
        "repoUrl": "git remote URL, string or null",
        "url": "deep link back to this session in ShipIt, string or null"
      },
      "turn": {
        "summary": "short, single-line description of what happened this turn",
        "wasInterrupted": "boolean — true if I stopped the agent mid-turn",
        "durationMs": "number or null — how long the turn ran",
        "costUsd": "number or null — model cost",
        "toolUseCount": "number — how many tool calls the agent made",
        "commitHash": "string or null — auto-commit hash if there were changes",
        "prUrl": "string or null — PR URL if one exists for this branch"
      }
    }

Future versions may add fields and new `event` types (e.g. `pr_merged`,
`deploy_failed`). Treat unknown fields as forward-compatible: ignore them
without erroring. If `schemaVersion` is higher than the highest version you
know about, log a warning but still process the known fields.

## What to do with the event

For now, the default behavior is: send me a notification with the session name
and the turn summary, including the session URL if present so I can click
through. Use whichever notification channel I've already set up with you
(voice message, push, Slack DM — your call based on time of day, my recent
activity, and whether `wasInterrupted` is true, which usually means I'm
already paying attention and don't need a ping).

Don't notify for turns where:
- `wasInterrupted` is true AND `summary` is empty (I aborted before anything
  meaningful happened)
- `turn.toolUseCount` is 0 AND `commitHash` is null (the agent didn't actually
  do anything — e.g. it just answered a question)

When in doubt, send the notification. False negatives are worse than false
positives here.

## What to deliver back to me

Confirm in chat:
1. The exact URL I should paste into ShipIt's "Post-turn webhook" setting
   (including scheme and path).
2. The bearer token I should paste (if you generated one) or a request for me
   to provide one.
3. A sample notification, so I know what to expect.

After that, I'll trigger a turn from ShipIt and we'll verify end-to-end.
```

## Open questions

- Should the test-from-UI button bypass the `enabled` flag? Probably yes — testing a disabled config is a normal debugging workflow.
- Do we want a "last delivery status" indicator in the UI (timestamp + status of the most recent POST)? Cheap to add and a big debugging win, but adds a small piece of ephemeral state to track. Lean yes for v1 if it fits in an afternoon, otherwise punt.
- The `shipit.host` and `session.url` fields require ShipIt to know its own public URL. We don't have a clean source of that today. For v1, leave them empty/null when unknown; add a server config option later if it becomes important.
