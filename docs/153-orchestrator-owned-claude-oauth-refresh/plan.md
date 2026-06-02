---
description: Move Claude OAuth refresh out of session CLIs into a single orchestrator-owned process to eliminate the multi-session refresh stampede that breaks every Claude session ~8h after auth.
---

# 153 — Orchestrator-owned Claude OAuth refresh

## Context

After a fresh Claude sign-in, every Claude session works for ~8 hours, then all sessions
— new and existing — start returning `Failed to authenticate. API Error: 401 Invalid
authentication credentials`. Codex sessions on the same host are unaffected.

PR #666 ([Fix every-session 401: sync OAuth token back on agent_result, not just
agent_done](https://github.com/nicolasalt/shipit/pull/666)) closed one structural hole —
a lost-signal hazard where a rotated token could be stranded in a session if `agent_done`
never fired. It was necessary but not sufficient; this design covers what remains.

## Root cause (confirmed on prod 2026-05-26)

Three independent observations converge on one explanation:

1. **Source `.credentials.json` mtime hasn't moved since the original auth write.** The
   user authenticated on May 25 09:26 UTC; the encoded `expiresAt` is May 25 17:26 UTC
   (8-hour access-token lifetime). By the time of diagnosis on May 26 ~11:00 UTC, the
   access token has been expired for ~17.5 hours, and the on-disk source file is
   byte-identical to what `claude /login` wrote ~26 hours earlier. **Nothing has
   refreshed the source.**

2. **Every sampled per-session credentials file has a byte-identical `claudeAiOauth`
   payload to source.** The CLI is alive in each session (the `mcpOAuth` top-level key
   churns in the per-session file), but `claudeAiOauth.accessToken`,
   `claudeAiOauth.refreshToken`, and `claudeAiOauth.expiresAt` are unchanged. No session
   has successfully rotated.

3. **A direct curl against `https://console.anthropic.com/v1/oauth/token` from the
   orchestrator returns sticky HTTP 429 `{"error":{"type":"rate_limit_error","message":
   "Rate limited. Please try again later."}}`**. Three attempts spanning 5.5 minutes
   returned identical responses. The lockout window is at least minutes-long and
   plausibly hours-long. No `Retry-After` header (curl wasn't verbose; subsequent
   diagnostics cancelled to avoid extending the lockout).

The mechanism this evidence supports:

```
Source access_token expires
              │
              ▼
Every active Claude session, every turn:
  sync_in → expired token → CLI tries to refresh
  (same outbound NAT IP, same refresh_token across N sessions)
              │
              ▼
Anthropic's OAuth rate limiter sees one noisy IP → 429s the lot
              │
              ▼
No refresh succeeds → source never updates → next turn repeats
```

The asymmetry with Codex makes structural sense: Codex's auth is JWT-based with a
different identity provider, and either has a longer-lived access token or doesn't
rate-limit refreshes the same way. Codex sessions don't manifest the stampede.

The 17.5-hour stuck window also tells us that "self-healing on next turn" — which would
work for an isolated transient race — doesn't apply here. The contention is continuous:
every active session keeps refilling the rate-limit ledger, so no individual session
ever wins. The system is locked out as long as concurrent refresh attempts continue.

## Design

### Move refresh ownership

The orchestrator becomes the **single** entity that refreshes the Claude OAuth token.
Session CLIs revert to pure consumers — they read the synced-in access token and never
call `console.anthropic.com/v1/oauth/token`. With one outbound caller instead of N, the
rate-limit ledger is no longer in contention, and the system can recover from a stale
state in a single in-flight refresh.

### Delegate to the Claude CLI

The orchestrator does **not** speak Anthropic's OAuth wire directly. We spawn `claude`
as a child process and let the CLI handle the OAuth dance against the source credentials
file. Rationale:

- Anthropic owns the OAuth contract — endpoint URL, client_id, request shape, error
  handling, token rotation specifics. They keep the CLI working when they change those.
- The CLI is lockfile-pinned in `docker/agent-cli/package-lock.json` (currently
  `@anthropic-ai/claude-code@2.1.140`), bumped by Renovate with a cooldown gate. We
  inherit deterministic, version-controlled OAuth behavior for free.
- Less attack surface in our own code — no hand-rolled HTTP client, no client_id
  baked into ShipIt source, no schema assumptions to maintain.

### Two-tier command, defensive

The CLI exposes `claude auth status --json` (Tier 1 — designed for scripted use, no
prompt arg, no model, structurally cannot make a billable conversation API call). Open
empirical question: whether `auth status` triggers an OAuth refresh when the access
token is expired, or only reads stored state. We don't pre-commit to an answer — the
refresher discovers it at runtime.

If `auth status` doesn't rotate the token, the refresher falls back to the cheapest
billable form:

```
claude --print "ok" --model claude-haiku-4-5-20251001 --tools "" --no-session-persistence
```

This forces Haiku (cheapest model), disables tool loop, suppresses session persistence,
and uses a minimum-token prompt. Cost: <$0.001 per invocation, called roughly once per
refresh cycle (~7h post-deploy) — single-digit cents/month.

### Refresh-tick state machine

```
on scheduled tick (single-flight via in-process mutex):
  before  := readSourceTokenState()
  spawn `claude auth status --json` with HOME=<source-dir>, timeout 30s
  after   := readSourceTokenState()

  if after.expiresAt > before.expiresAt:
    # Tier 1 rotated. Propagate and reschedule.
    repushTokenToPinnedSessions("claude", accountId)
    schedule next at after.expiresAt - safetyMargin
    return SUCCESS_TIER1

  if before.expiresAt > now + safetyMargin:
    # Token's fine; status was just read-only. No-op tick.
    schedule next at before.expiresAt - safetyMargin
    return NOOP

  # Tier 1 didn't rotate, token is expired or expiring. Fall through.
  spawn `claude --print "ok" --model claude-haiku-4-5-20251001 ...` with HOME=<source-dir>, timeout 60s
  after2 := readSourceTokenState()

  if after2.expiresAt > before.expiresAt:
    repushTokenToPinnedSessions("claude", accountId)
    schedule next at after2.expiresAt - safetyMargin
    return SUCCESS_TIER2

  # Neither tier rotated. Either rate-limited or refresh token revoked.
  if recentExit had 429-shaped signal:
    schedule next with exponential backoff (60s → 2m → 5m → 10m → 30m, cap 30m)
    return RATE_LIMITED
  if recentExit had invalid_grant signal:
    emit "auth_required"
    stop scheduling until next auth_complete
    return REVOKED
  # Unknown failure mode; treat as transient.
  schedule next with short backoff, log loudly
  return UNKNOWN_FAILURE
```

`safetyMargin` = **30 minutes** (fixed, not env-tunable in v1). Refreshing well before
the CLI's own "near expiry" heuristic ensures the source stays fresh, sessions sync in
valid access tokens, and session-side refreshes are never triggered. The margin only
governs *when during a healthy access-token lifetime* the tick fires — recovery from
extended orchestrator downtime is independent (when start() runs against an already-
expired source, a refresh tick is scheduled immediately).

### Single-flight

In-process `Promise<RefreshResult>` mutex. Any caller — scheduled tick, on-demand
`refreshNow()`, or the on-`auth_required` synchronous repair — awaits the in-flight
promise if one exists, never starts a parallel attempt. Because there is only one
orchestrator process per host, this fully serializes refresh.

### Detecting refresh outcomes

The CLI is a native binary; we can't introspect it statically. We rely on two
observable signals:

1. **File state delta** — source mtime + parsed `claudeAiOauth.expiresAt` before vs.
   after. A strict advance proves rotation succeeded.
2. **Debug log** — `--debug api --debug-file <tmp>` flag captures every HTTP request
   and response the CLI made during the run. We parse it for status codes (429,
   4xx with `invalid_grant`) to classify failures.

If the CLI changes its debug format in a future version, the file-state delta keeps
working — the debug parsing is purely supplementary classification. The mtime
mechanism is the safety net.

### Provider-account routing

The refresher iterates `providerAccountManager.list("claude")` and schedules one
tick state per account. For the current production state (post-d89a051 migration)
there is exactly one account: `claude-default`. The design generalizes cleanly to
the docs/150 multi-account work — each account has independent token lifecycle,
independent rate-limit budget (they share an IP but have different refresh tokens),
and independent scheduling.

The source path for account `claude-default` resolves via:
- Legacy compat: `/credentials/.claude/.credentials.json` (symlink to the migrated
  location). Existing code paths that don't know about provider routing — including
  `repushAgentToken` — continue working through the symlink.
- Account-aware: `/credentials/provider-accounts/claude/claude-default/.claude/.credentials.json`
  (real file). Used by `syncProviderAccountTokenIn` / `syncProviderAccountTokenBack`
  / `repushProviderAccountToken`.

The refresher writes the new token to the account-aware path. The symlink ensures
legacy readers still see the rotated content.

## Wiring

### New module

`src/server/orchestrator/claude-oauth-refresher.ts`:

```typescript
export interface ClaudeOAuthRefresherDeps {
  credentialsDir: string;
  providerAccountManager: ProviderAccountManager;
  repushTokenToPinnedSessions: (agentId: AgentId, accountId?: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  /** Injected for tests; defaults to real `child_process.spawn`. */
  spawn?: typeof spawn;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export class ClaudeOAuthRefresher {
  start(): void;
  stop(): void;
  /** Trigger an immediate refresh for an account (or all, if accountId is omitted). */
  refreshNow(accountId?: string): Promise<RefreshResult>;
}
```

### Wiring in `app-lifecycle.ts`

The new refresher is constructed once per app and started after the existing
`wireEventHandlers` block. It listens to the existing `auth_complete` event to
re-schedule on a fresh token, and to the sign-out path to cancel timers.

```typescript
const refresher = new ClaudeOAuthRefresher({
  credentialsDir,
  providerAccountManager,
  repushTokenToPinnedSessions,
  sseBroadcast,
});
refresher.start();

authManager.on("auth_complete", () => {
  // Existing handler still fires. The refresher rearms itself on the
  // file-write event via its watcher, but we explicitly nudge it here
  // so the schedule updates immediately on fresh sign-in.
  void refresher.refreshNow().catch(() => {});
});
```

On `auth_required` from a session (already routed through `sseBroadcast`), the
session-facing handler calls `refresher.refreshNow(accountId)` synchronously before
falling through to the UI re-auth prompt. The accountId is the route the session is
pinned to. Three outcomes:

- **Refresh succeeded** — token rotated, propagated via `repushTokenToPinnedSessions`.
  The session's next sync-in will pull the fresh token. Suppress the `auth_required`
  SSE so the UI stays quiet; the user retries the turn and it works.
- **Refresh failed with retryable error (429, transient)** — emit `auth_required` as
  today. The user may try again soon; the next scheduled tick may succeed.
- **Refresh failed with `invalid_grant`** — the refresh token for this account is
  revoked. Emit `auth_required` (existing flow → sign-in card). Also emit a new
  per-account event `claude_account_unauthenticated` with `{ accountId }` for the
  docs/150 failover layer to consume later (a future PR may route new sessions to a
  healthy account and decorate the broken account's card with a "needs sign-in"
  badge). v1 leaves the existing card-flip-to-Sign-in UX intact.

v1 is **single-account aware** but does not implement failover. The refresher manages
each account in `providerAccountManager.list("claude")` independently; in production
today that's just `claude-default`, so the behavior is effectively single-account.
The per-account SSE event is the contract docs/150 Phase 2+ will wire failover
through.

### Sign-out

Existing `AuthManager.signOut()` clears source files; the refresher stops scheduling
when its file watcher reports the source file disappeared. No additional wiring beyond
that.

## Test plan

### Unit (`claude-oauth-refresher.test.ts`)

- **Single-flight**: two concurrent `refreshNow()` calls spawn the CLI exactly once.
- **Tier 1 success**: when the fake CLI rotates the source file (test fixture writes a
  later expiresAt), `repushTokenToPinnedSessions` is called and the next tick is
  scheduled at `new expiresAt - safetyMargin`.
- **Tier 1 read-only, Tier 2 success**: when Tier 1 doesn't advance the file but Tier 2
  does, both run and Tier 2 wins.
- **Both tiers no-op + 429 in debug log**: emits backoff schedule, no auth_required.
- **Both tiers no-op + invalid_grant in debug log**: emits `auth_required`, stops
  scheduling.
- **`auth_complete` rearms**: simulate a fresh source write; refresher schedules.
- **`stop()` cancels pending timers**: no further spawns after stop.
- **Per-account isolation**: two accounts schedule independently; one account's
  failure doesn't affect the other.

### Integration

- Existing `repushTokenToPinnedSessions` test (in `app-lifecycle.test.ts` if present;
  or add) is extended to confirm: refresher's `repushTokenToPinnedSessions` call
  reaches all sessions with `agent_id = "claude"`, `agent_pinned = 1`, including the
  ~91% of sessions that have `provider_route_*` columns NULL (`repushAgentToken`
  covers those via the legacy symlink path).

### Manual on prod

After deploy:
1. Re-auth Claude in Settings (one-time, to bypass the existing dead source state).
2. Wait until `expiresAt` minus `safetyMargin` arrives.
3. Confirm: source `.credentials.json` mtime advances; per-session files get
   propagated; no 401s in logs; no curl-shaped 429 entries in orchestrator stdout.
4. Wait through a full ~8h refresh cycle. Confirm the cycle continues indefinitely.

## Operational notes

**Deploy does not auto-recover from the current stuck state.** The refresher will start
trying to refresh on first tick. If the existing rate-limit window is still active
(plausibly hours-long), all early attempts will 429-backoff. The user has two options:

1. **Wait it out.** Anthropic's rate limit will clear at some point. Once it does, the
   refresher's next tick succeeds; everything self-recovers.
2. **Re-auth.** Sign out + sign back in. Writes a fresh source token. The existing
   `auth_complete` handler calls `repushTokenToPinnedSessions` and force-pushes to all
   pinned sessions. Refresher rearms on the fresh token and prevents recurrence.

(2) is the recommended one-time op.

### Logging

Refresher activity (`[claude-oauth-refresh] tick scheduled at ...`, `... rotated via
auth status`, `... rotated via haiku fallback`, `... 429 backoff Ns`, `...
invalid_grant → auth_required`) goes to `console.log` only. Visible in `docker logs
shipit-shipit-1`, matches the existing `[disk-janitor]`, `[mcp-oauth]`, `[auth]`,
`[warm]` log-prefix convention. No per-session `broadcastLog` (the refresher is
session-agnostic) and no SSE telemetry beyond the `claude_account_unauthenticated`
event already specified above.

### Re-auth surfacing

When the refresher exhausts retries for an account, the existing `auth_required` SSE
fires — the auth card flips to "Sign in" as today. No new UI affordance in v1 (no
toast, no system message in chat). The new `claude_account_unauthenticated` SSE
event carries the accountId for docs/150 to consume.

## Risks and open questions

| Risk | Mitigation |
|---|---|
| `claude auth status --json` behavior changes in a future CLI version. | Two-tier design: Tier 2 (`--print` against Haiku) is structurally guaranteed to make an authenticated API call → refresh-on-use. Tier 1 failing gracefully into Tier 2 is the expected steady state if Anthropic redesigns `auth status`. |
| The CLI's debug log format changes. | File-state delta is the authoritative success signal; debug parsing is only used for failure classification. A debug-format change degrades the "what's wrong?" classification to "unknown failure", which still backs off and retries. |
| Session-side CLIs still attempt refresh occasionally despite the safety margin. | The 30-min margin is conservative. If we observe session-side refresh traffic post-deploy (look for `console.anthropic.com` connections from agent-* containers), tighten the margin or add an egress policy that blocks session containers from reaching the OAuth endpoint — future hardening, not blocker for this fix. |
| Refresher tick fires during an actual `claude /login` flow. | `AuthManager` and the refresher operate on the same source file. The refresher's file-state delta is read-only until the spawn exits; the OAuth flow's atomic-write writes a fresh token. Worst case: refresher re-arms on the new expiresAt. Benign. |
| Two refreshers somehow exist (e.g., racing orchestrator restarts during a deploy). | Refresher state lives in-process; multiple processes don't share mutex. But there's only ever one orchestrator container running at a time (Compose `unless-stopped` doesn't double-run). The CLI's own atomic write protects against concurrent writes even if it did happen — the loser's write just gets clobbered by the winner. |
| `auth status` rotates the token (Tier 1) but our parse misses it. | The mtime check is the trigger, not the JSON parse — so as long as the CLI updates the file with a later `expiresAt`, we detect it. |

## Out of scope

- **Disabling session-side refresh entirely.** Could be done via per-network egress
  policy or by patching the CLI invocation. Reserved for a follow-up if observation
  post-deploy shows session-side refresh contributing to rate-limit pressure even
  after the orchestrator-owned path is keeping source fresh.
- **Generalizing the refresh model to MCP OAuth.** MCP tokens already have a
  per-tick refresh path (`refreshExpiredMcpOAuthTokens`); they're not affected by
  this issue. Future work could share infrastructure if both refreshers grow more
  complex.
- **Codex.** Codex's auth flow is unaffected — different identity provider, different
  refresh model. No Codex changes in this PR.

## Key files (planned)

- `src/server/orchestrator/claude-oauth-refresher.ts` — new module
- `src/server/orchestrator/claude-oauth-refresher.test.ts` — unit tests
- `src/server/orchestrator/app-lifecycle.ts` — wire `start()` + `auth_complete`/sign-out
- `src/server/orchestrator/app-di.ts` — pass `providerAccountManager` into the refresher
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — optional: route
  `auth_required` through `refresher.refreshNow()` before propagating to the client
