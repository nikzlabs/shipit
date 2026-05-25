---
status: done
priority: medium
description: Header badges showing subscription rate-limit usage (5-hour window, weekly cap, reset clock) for Claude and Codex, rendered inline without leaving ShipIt.
---

# 135 — Subscription limits badge

## Summary

Render header badges that show the user's **subscription rate-limit usage**
for every configured agent authenticated against a subscription (Claude
and/or Codex) — the same numbers the agent's own REPL exposes via
`/usage` / `/status`: percentage of the 5-hour session window consumed,
percentage of the weekly cap consumed, and the reset clock. One pill per
provider, rendered side-by-side immediately to the **left** of the
existing `UptimeBadge` in the top bar (`AppLayout.tsx:145`), refreshed
once a minute.

When a visible window is above 90% used, the pill includes the compact
time-until-reset text inline next to that window (for example,
`5h 96% resets in 2h` or `7d 94% resets in 3d`). Below that threshold,
reset times stay in the tooltip so the header remains compact.

This pulls upstream rate-limit data — which today lives **only** behind a
non-ShipIt surface (`claude /usage` in the Claude TUI, `codex /status` in
the Codex TUI, or the chatgpt.com/codex web dashboard) — into ShipIt and
renders it inline. Per §1/§2: if the user needs the data, ShipIt shows
the data; they don't open another tab or pop a separate REPL to find out
they're about to be cut off mid-turn.

A pill is **only** rendered for an agent authenticated against a
subscription. API-key paths (Anthropic Platform `ANTHROPIC_API_KEY`,
OpenAI Platform `OPENAI_API_KEY`) have no human-readable subscription
quota — they bill per token via metered headers — so no pill is rendered
for them. With zero subscription-authed agents, the badge group collapses
to nothing and the header looks exactly as it does today.

**Why account-wide and not focus-driven.** The rest of the header is
global — `UptimeBadge`, `DockerMemoryBadge`, the settings gear, theme
picker — none of it changes when the user switches sessions. The badges
follow the same shape: each pill reflects the *account's* subscription
state for that provider, not the focused session's. A user with both a
Claude Max and a ChatGPT Plus subscription always sees both pills,
regardless of which session is focused or which agent that session uses.
This avoids inventing the first focus-driven header element solely to
power a status pill.

## Motivation

- **Stop the cliff.** Today the user can be three messages from a weekly
  cap with no warning. The first signal is a hard rate-limit error mid-turn,
  often after a long agent run that consumed real tokens. A visible counter
  flips this from "surprise" to "I can see I have 12% left, I'll save the
  big refactor for tomorrow."
- **Doc 119 left this as a non-goal.** The codex subscription-auth doc
  explicitly punted: *"Surfacing remaining Codex credits / subscription
  usage in the UI (a follow-up; OpenAI exposes this on chatgpt.com/codex
  but not on a stable CLI surface yet)."* That follow-up is this doc.
- **The data exists; only the surface is missing.** Both upstream CLIs
  already know the numbers (Claude's `/usage` REPL screen, Codex's
  `/status` line). What's missing is a JSON-output flag on either CLI.
  We pull from the same underlying HTTP endpoints both CLIs already
  call — see [API research](#api-research) — using the OAuth tokens
  ShipIt already manages.
- **Maps cleanly onto an existing pattern.** `DockerMemoryBadge` already
  proves the shape: poll a server-side value, broadcast over SSE, render
  a small tooltipped pill in the header with color tiers. We follow that
  pattern beat-for-beat.

## Non-goals

- **No spend dashboard.** This is a header badge, not an analytics page.
  Historical usage, per-session cost breakdowns, and prediction curves
  belong in `UsageManager` / a future usage view (out of scope for this
  doc).
- **No "buy more credits" CTA in the badge.** The tooltip can deep-link
  to the upstream billing page (legitimate §3 exception — billing is one
  of the few link-out cases), but the badge itself is read-only.
- **No per-session attribution.** The numbers are account-wide because
  upstream rate limits are account-wide. We don't try to invent a
  per-session split.
- **No automation off this signal.** We don't pause sessions, queue
  prompts, or hide the composer when the user is near a cap — that
  would be ShipIt deciding for the user. We just surface the number.
- **No badge for API-key auth.** Pay-as-you-go (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`) has no quota to render; the badge is hidden and the
  slot collapses. *Note:* `ANTHROPIC_AUTH_TOKEN` (OAuth-style bearer,
  used by ShipIt-in-ShipIt dogfooding — see `auth.ts:151–158`) **does**
  have a subscription quota and is treated as an OAuth path, not an
  API-key path.
- **Other agents (future).** When a third agent backend is added, this
  same provider interface is the integration point — no UI changes
  needed.

## API research

This is the bulk of the design: both CLIs **do not** today have a
machine-readable `--json` flag for limits, but both **do** internally hit
JSON HTTP endpoints to populate their REPL screens. We reuse those same
endpoints.

### Claude (Anthropic)

| Surface | Status |
|---|---|
| `/usage` slash command in the Claude TUI | REPL-only, no JSON output. Hardcoded into the CLI process state — not reachable via `claude -p` / headless mode. |
| `claude auth status --json` | Returns subscription type + auth state, **no** usage numbers. |
| `~/.claude/stats-cache.json` | Client-side aggregated counters only. Does not contain server-side limits (Anthropic owns the cap, not the CLI). |
| `~/.claude/projects/*.jsonl` | Per-turn token counts. Can be aggregated locally but does not include the *server-side* cap (the cap depends on plan + Anthropic's burst smoothing, which the CLI doesn't recompute). |
| Per-request response headers | `anthropic-ratelimit-unified-*` returned on every API call. The CLI surfaces these to ShipIt via stream-json `rate_limit_event` messages — **this is the source we use** (see below). |
| **`rate_limit_event` messages under `claude --output-format=stream-json`** | **What we consume.** The CLI emits one `rate_limit_event` per window every time `anthropic-ratelimit-unified-*` headers change (typically every API call for active subscribers). Free, real-time, no extra HTTP call. Payload: `{ type: "rate_limit_event", rate_limit_info: { status, rateLimitType: "five_hour" \| "seven_day" \| ..., utilization, resetsAt } }`. |
| `GET https://api.anthropic.com/api/oauth/usage` | **Not used.** Undocumented OAuth-scoped endpoint. Aggressively server-side rate-limited (returns `HTTP 429` with `retry-after: 0` after a handful of calls, ~30 min lockout — see [#31637](https://github.com/anthropics/claude-code/issues/31637), [#30930](https://github.com/anthropics/claude-code/issues/30930)). Wall-clock polling at any cadence eventually trips this and leaves the badge stuck on 30-minute-old data. Doesn't carry any data the stream events don't. |
| Anthropic Admin API `GET /v1/organizations/usage_report/claude_code` | Org/Team/Enterprise only, requires admin API key (`sk-ant-admin-…`). Not viable for individual Pro/Max subscribers, which is most ShipIt users. |

**Implemented source (event-driven):** `rate_limit_event` messages on
the Claude CLI's stream-json output. The CLI itself derives them from
the `anthropic-ratelimit-unified-*` response headers on every API call
— no extra HTTP request from us, no chance of 429ing ourselves, and the
data refreshes on the very next turn after any usage change.

`ClaudeAdapter` (in `src/server/session/agents/claude-adapter.ts`)
parses each event, ignores the `seven_day_opus` / `seven_day_sonnet` /
`overage` sub-types (the badge only renders the headline 5h and 7d
windows), and accumulates the last-known `five_hour` + `seven_day`
windows. Whenever either changes, it emits a normalized
`AgentRateLimitsEvent` carrying both windows — the same shape Codex
already uses, so the orchestrator's `recordAgentRateLimits` handler is
the single contract for both providers.

The plan label is derived from the credentials file —
`claudeAiOauth.subscriptionType` + `rateLimitTier` (e.g. `"max"` +
`"default_claude_max_20x"` → `"Max 20x"`) — via
`AuthManager.getAccessToken()`, not from the event payload.

**Consequence:** the Claude pill is blank until the first turn of a
session delivers a `rate_limit_event` — identical UX to Codex.
Acceptable trade for a path that's free and never goes stale.

**Why not poll `/api/oauth/usage`?** Earlier iterations of this design
polled the undocumented OAuth-scoped endpoint Anthropic's CLI uses for
`/usage`. That endpoint is so aggressively server-side rate-limited
(`HTTP 429` with `retry-after: 0` after a handful of calls, ~30 min
lockout) that any cadence we picked — 60s, 5min, even 30min with
turn-driven 90s debounce — eventually tripped it, leaving the badge
stuck on 30-minute-old data. The CLI itself works around the same
limitation by exposing the data over the stream instead.

### Codex (OpenAI)

| Surface | Status |
|---|---|
| `/status` slash command in the Codex TUI | REPL-only. Renders `5h 96% · Weekly 94% · resets …` line. No `--json` flag. Feature request open (openai/codex#15281). |
| Internal Codex endpoint | The Codex CLI fetches rate-limit data via **`GET /api/codex/usage`** on the ChatGPT backend (`backend-api.openai.com` / `chatgpt.com`). This is what populates `/status`. |
| `~/.codex/config.toml` | User config only. No live rate-limit data. |
| `~/.codex/auth.json` | OAuth-bearer credentials. Same token the CLI uses to call the usage endpoint. Already mounted into the credentials volume by doc 119 (`CodexAuthManager`). |
| Response headers on `codex app-server` API calls | OpenAI's API returns the usual `x-ratelimit-*` headers, but for ChatGPT-subscription auth those numbers don't map onto the 5h / weekly windows the user actually cares about. Header path is **not** a viable fallback for Codex. |

**Implemented source (event-driven):** the `/api/codex/usage` HTTP path
turned out unusable — it answers 401/403 even with a valid bearer token
(it wants a `chatgpt-account-id` header and possibly more), so polling it
surfaced a permanent "auth expired" on the badge. Instead we read the
numbers the Codex App Server **pushes** during a turn: it streams an
`account/rateLimits/updated` JSON-RPC notification carrying the exact data
it draws its own `/status` line from:

```jsonc
{ "rateLimits": {
    "limitId": "codex", "limitName": null,
    "primary":   { "usedPercent": 5, "windowDurationMins": 300,   "resetsAt": <epoch s> },
    "secondary": { "usedPercent": 1, "windowDurationMins": 10080, "resetsAt": <epoch s> } } }
```

`primary` (300 min) → the 5h session window, `secondary` (10080 min) →
weekly. `CodexAdapter` captures the notification and emits an
`agent_rate_limits` AgentEvent; it flows through the normal agent event
stream (worker SSE → `ProxyAgentProcess` → `wireAgentListeners`), where
the orchestrator calls the unified `recordAgentRateLimits("codex", …)`
to push it into the **event-fed** `CodexLimitsProvider`. The provider
does no HTTP: `fetch()` returns the latest pushed windows enriched with
the plan tier (read from the `chatgpt_plan_type` JWT claim via
`CodexAuthManager.extractCodexPlan`, since the payload's `limitName` is
null). `LimitsRegistry.markAuthRefreshed("codex")` immediately
rebroadcasts so the pill updates within seconds.

The adapter also keeps the most recent pushed snapshot locally for error
classification. Codex app-server has been observed returning the generic
"org monthly usage limit" JSON-RPC error when the pushed `primary` window is
already at 100%; in that case ShipIt rewrites the chat-facing failure to
name Codex's 5h usage limit and show the `primary.resetsAt` timestamp. Other
JSON-RPC errors, and monthly-limit errors without an exhausted 5h snapshot,
still pass through unchanged.

**Consequence:** the Codex pill is blank until the first turn of a session
delivers a snapshot — there's no way to query usage out-of-band. That's an
acceptable trade for using the one source we've *verified* works (it shows
up in prod session logs) over an unverified endpoint that doesn't.

### Why not just spawn `claude` / `codex` and scrape the REPL?

We considered running `claude` and parsing `/usage` output, the way some
community tools do. Rejected:

1. **Both `/usage` and `/status` are REPL-only.** They mutate interactive
   process state. They don't flow through `claude -p` / `codex exec` —
   doc 132 covers this in detail under "built-ins are CLI process-state,
   not prompts." Spawning a PTY just to scrape one screen is fragile
   and adds 1–3 seconds of latency per refresh.
2. **The output is ANSI-formatted text.** Format can change between CLI
   versions without notice.
3. **The CLI is doing exactly the HTTP call we'd otherwise make.** Going
   one layer down — to the same endpoint, with the same token — is
   strictly less brittle.

## Architecture

### Provider interface

The shared *type* describing one snapshot lives in
`src/server/shared/types/usage-limits-types.ts` (so the client can
import it). The *interface* and implementations are
orchestrator-only — they do HTTP fetches against Anthropic / OpenAI
and must not be reachable from client code.

```ts
// src/server/shared/types/usage-limits-types.ts  (client-importable)
import type { AgentId } from "./agent-types.js";

export interface SubscriptionLimits {
  /** Which agent these numbers belong to. */
  agentId: AgentId;
  /** Subscription tier name to render in the tooltip (e.g. "Pro", "Max 20x", "Plus"). */
  plan: string | null;
  /** Rolling short-window quota (Claude: 5h, Codex: 5h). */
  session: { usedPct: number; resetAt: string /* ISO */ } | null;
  /** Weekly quota across all models. */
  weekly: { usedPct: number; resetAt: string /* ISO */ } | null;
  /** Epoch ms when this snapshot was last updated. */
  fetchedAt: number;
}

// src/server/orchestrator/limits/types.ts  (orchestrator-only)
export interface LimitsProvider {
  agentId: AgentId;
  /** True once the first event-fed snapshot has landed. */
  canFetch(): boolean;
  /** Returns the cached snapshot enriched with derived fields (plan tier). */
  fetch(): Promise<SubscriptionLimits | null>;
}
```

Each agent backend ships an event-fed provider — neither does HTTP
itself; both expose a `setRateLimits(session, weekly)` method that the
orchestrator calls from `recordAgentRateLimits` when an
`agent_rate_limits` AgentEvent arrives:

- `src/server/orchestrator/limits/claude-limits.ts` — fed by
  `ClaudeAdapter`'s parser for `rate_limit_event` stream messages.
- `src/server/orchestrator/limits/codex-limits.ts` — fed by
  `CodexAdapter`'s parser for `account/rateLimits/updated` JSON-RPC
  notifications.

Plan tier is derived from each manager's persisted credentials
(`AuthManager.getAccessToken().plan` for Claude,
`CodexAuthManager.getAccessToken().plan` for Codex) since the
event payloads don't carry it.

Providers are registered in the orchestrator's DI layer (`index.ts`)
in a `Map<AgentId, LimitsProvider>` and injected into the
`LimitsRegistry`. They do **not** live on `AgentRegistry` /
`agent-registry.ts` — that registry describes *static* agent metadata
(name, models, capabilities) and is imported by client code via
`AGENT_REGISTRY` exports; hanging a server-only stateful cache off it
would either leak server code into the client bundle or force a split
that doesn't pay for itself. The existing precedent in
`agent-registry.ts` is *constructor-injected callbacks*
(`checkClaudeAuth`, `checkCodexAuth`) — those are simple booleans;
this needs a richer interface and a separate home.

Agents whose provider returns `canFetch() === false` (or that have no
provider) simply don't surface a badge — UI-side this collapses to
nothing.

### AuthManager / CodexAuthManager surface to add

The current `AuthManager` (Claude OAuth) and `CodexAuthManager` only
expose **liveness** (`checkCredentials(): boolean`) and the login
flow — neither exposes the access token. The Claude path is more
involved than Codex because there are three possible sources:

1. `/root/.claude/.credentials.json` (or `credentials.json` /
   `auth.json` — the CLI varies across versions; `auth.ts:163` already
   probes all three).
2. `ANTHROPIC_AUTH_TOKEN` env var — OAuth-style bearer used in
   ShipIt-in-ShipIt dogfooding (see `auth.ts:151–158`).
3. `ANTHROPIC_API_KEY` env var — pay-as-you-go, **not** a
   subscription. `canFetch()` returns false here.

We add to each manager:

```ts
// AuthManager (Claude)
async getAccessToken(): Promise<
  | { token: string; source: "file" | "env"; expiresAt: number | null }
  | { token: null; reason: "api-key" | "not-authenticated" }
>;
```

The Claude credentials file is JSON: ShipIt has not parsed it before,
so we ship a small parser (read → JSON → extract `accessToken` /
`access_token`, `refreshToken`, `expiresAt`). On expiry, the file is
re-read on the next call — the Claude CLI refreshes the file in place
when it makes its own API calls, so we don't need to drive a refresh
ourselves *as long as* the CLI runs at least once between OAuth-token
expirations (default ~1 hour). If the file has been stale longer than
that and the user hasn't run the agent, the next `fetch()` will 401;
we treat that as `error: "auth expired"` and surface the existing
re-auth UI rather than driving our own refresh-token call. This is a
deliberate trade-off — refresh-token handling is non-trivial and
duplicates work the CLI already does.

`CodexAuthManager.getAccessToken()` mirrors this, reading
`/root/.codex/auth.json` (the file `codex login --device-auth` writes;
already symlinked into `/credentials/.codex/auth.json` in production
per `codex-auth.ts:64–67`).

Both `getAccessToken()` methods are added as *new* code — neither
currently exists. This is explicitly *not* a "reuse what's there"
plan.

### Registry on the orchestrator

`LimitsRegistry` (in `src/server/orchestrator/limits-registry.ts`) is
a passive cache + SSE broadcaster. It does **no polling, no HTTP, no
backoff state machinery** — both providers are event-fed.

- **Update path:** when an `agent_rate_limits` AgentEvent arrives from
  any backend's adapter, `wireAgentListeners` routes it into the
  single `recordAgentRateLimits(agentId, session, weekly)` callback on
  `AppCtx` (the unified contract across providers). The callback in
  `index.ts` dispatches to the right provider's `setRateLimits(…)`
  method and then calls `limitsRegistry.markAuthRefreshed(agentId)`,
  which re-pulls the provider's snapshot (now enriched with plan tier
  from the credentials file) and broadcasts an SSE
  `subscription_limits` event if it changed.
- **Caching:** snapshots are held in a `Map<AgentId, SubscriptionLimits>`.
  Every event-fed provider gets its own entry; providers that haven't
  received their first event yet are omitted entirely from the map
  (not stored as `null`). The client renders one pill per entry.
- **No active-agent tracking.** All providers share the same registry;
  the client renders one pill per map entry in stable registration
  order. This matches the rest of the header (everything global,
  nothing focus-driven).
- **Broadcast:** every change emits a new SSE event
  `subscription_limits` whose payload is the full
  `Record<AgentId, SubscriptionLimits>`. The full map is sent on every
  broadcast — partial deltas aren't worth the complexity for N≤3
  entries. The initial-connect snapshot is included in the existing
  burst sent at `/api/events` connect time.
- **Sign-in:** after a successful Claude or Codex login the auth
  managers emit `auth_complete` / `codex_auth_complete`. The registry
  listens for these and refreshes that provider's snapshot so the
  plan-tier change propagates to the pill immediately.
- **Sign-out:** the registry's `markSignedOut(agentId)` deletes the
  provider's entry and broadcasts the smaller map so the client drops
  the pill.
- **Error classification:** `wireAgentListeners()` can read the latest
  cache through `getSubscriptionLimitsSnapshot()`. When a Claude result
  error says the generic "org monthly usage limit" but the cached
  Claude 5h window is already at 100%, the listener rewrites the
  chat-facing `agent_result.error` to name the 5h usage limit and show
  the cached reset timestamp. Mirrors the Codex equivalent.

**Cold-start trade-off.** Because there's no polling, each provider's
pill stays blank until that backend has run at least one turn (which
is what triggers the first `rate_limit_event` / `account/rateLimits/updated`).
Same UX as Codex has had since day one — acceptable in exchange for
zero stale data and zero HTTP calls.

### Multi-provider display

The header renders **one pill per fetchable provider**. No concept of
an "active" provider is involved. This is deliberate — the rest of
the header is global (host-wide, account-wide, or app-wide), so the
limits badges follow that pattern rather than inventing a new
focus-driven element. A user with both a Claude Max subscription and
a ChatGPT Plus subscription always sees both pills, regardless of
which session is focused or which agent that session is configured
to use. Hitting the cap on one provider doesn't say anything about
the other; collapsing them into a single value would lose
information.

Stable rendering rules:

- **Order:** matches provider registration order in `app-di.ts`
  (Claude first, Codex second). This is stable across reloads and
  across users, so muscle memory works.
- **Zero fetchable providers** (first-run, all API-key, all logged
  out): nothing rendered; the header collapses to its prior shape.
- **One fetchable provider:** one pill.
- **Multiple fetchable:** N pills in registration order, sharing the
  same `gap-2 sm:gap-3` spacing the rest of the header uses.
- **Mobile** (`hidden sm:inline`): the entire badge group hides, same
  affordance as `DockerMemoryBadge`.

### Client

- **Store:** add `subscriptionLimits: Record<AgentId, SubscriptionLimits>`
  to `ui-store.ts`. The map only contains entries for providers that
  reported a snapshot (success or error this tick); missing keys mean
  "not fetchable" and the corresponding pill is not rendered. Each
  SSE broadcast replaces the map wholesale, so deletions propagate
  naturally on sign-out.
- **SSE handler:** `useServerEvents.ts` adds a listener for the
  `subscription_limits` SSE event, dispatching the full record to the
  store. Same shape as the existing `docker_memory` handler at
  `useServerEvents.ts:209`, except the payload is a record rather
  than a single stats object.
- **Component:** `src/client/components/SubscriptionLimitsBadge.tsx`
  renders **one pill per map entry**, iterating in stable
  agent-registration order. Visual chrome matches
  `DockerMemoryBadge.tsx` / `UptimeBadge.tsx`: each provider is a
  single `rounded-full bg-(--color-bg-hover)` pill with `tabular-nums`
  (not a bare label with nested meter chips — that inverted the visual
  hierarchy against the neighboring uptime/RAM pills). The pill carries
  a short provider label so the two are distinguishable when both are
  shown (see Open question 4 for the exact label form).
- **Placement:** `AppLayout.tsx:145`, immediately **before** the
  existing `<UptimeBadge>`. Hidden on mobile (`hidden sm:inline`) for
  symmetry with the memory badge. New header order, left-to-right
  within the right-hand cluster:
  `SubscriptionLimitsBadge → UptimeBadge → DockerMemoryBadge → Settings → ThemePicker`.
- **Rendering rules (per row):**

  ```
  When that agent has no map entry   →  row not rendered
  When entry.error is set            →  "Claude —" pill, neutral
                                        color, error string in
                                        tooltip
  Otherwise                          →  Inside the one provider pill:
                                        label "Claude" followed by up
                                        to two *meters*: "5h NN%" and
                                        "7d NN%". Each meter is
                                        tier-colored text with a thin
                                        2px underline gauge beneath it
                                        whose fill width is `pct%` of
                                        the meter. Both width and color
                                        signal urgency — without nesting
                                        pills inside the pill. Tooltip:
                                        full breakdown, reset times,
                                        plan name ("Pro" / "Max 20x" /
                                        "Plus"). No link out — the
                                        number on the badge is the
                                        surface. (§1)
  ```

- **Color tiers** apply per *meter*, independently — the 5h meter and
  the 7d meter color from their own percentages, so a 100%/22% state
  shows a red 5h meter next to a neutral 7d meter (an honest read of
  "session window full, weekly is fine"). The tier (`tierColor()`)
  returns a `var(--color-context-*)` string that drives **both** the
  meter text color and its underline-gauge fill:
  - ≥90% used → `--color-context-full`
  - ≥75% → `--color-context-high`
  - ≥60% → `--color-context-mid`
  - otherwise → `--color-text-secondary` (neutral, same as the label)

  The fill width is always proportional to the percentage (`pct%`),
  independent of tier. The `--color-context-*` tokens are shared with
  `ContextDial` and tuned per theme, so meter styling stays legible on
  both dark and light themes.

### File layout

New files:

```
src/server/shared/types/usage-limits-types.ts       — SubscriptionLimits (client-importable)
src/server/orchestrator/limits/types.ts             — LimitsProvider (orch-only)
src/server/orchestrator/limits/index.ts             — barrel
src/server/orchestrator/limits/claude-limits.ts     — Claude provider
src/server/orchestrator/limits/codex-limits.ts      — Codex provider
src/server/orchestrator/limits-poller.ts            — 60s loop, cache, broadcast
src/server/orchestrator/limits-poller.test.ts       — unit tests
src/client/components/SubscriptionLimitsBadge.tsx   — UI
src/client/components/SubscriptionLimitsBadge.test.tsx
```

Touches:

- `src/server/orchestrator/auth.ts` — add `getAccessToken()`.
- `src/server/orchestrator/codex-auth.ts` — add `getAccessToken()`.
- `src/server/orchestrator/index.ts` — register
  `Map<AgentId, LimitsProvider>`, construct `LimitsRegistry`, wire
  `recordAgentRateLimits` dispatch, include the snapshot in the
  `/api/events` initial-state burst, broadcast `subscription_limits`
  events.
- `src/server/session/agents/claude-adapter.ts` — parse
  `rate_limit_event` stream messages into `agent_rate_limits` events.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — route
  `agent_rate_limits` events into the unified
  `recordAgentRateLimits(agent.agentId, …)` callback.
- `src/server/shared/types/ws-server-messages.ts` — add the
  `subscription_limits` SSE event type.
- `src/client/hooks/useServerEvents.ts` — add the `subscription_limits`
  listener (same shape as the `docker_memory` handler at line 209).
- `src/client/stores/ui-store.ts` — add
  `subscriptionLimits: SubscriptionLimits | null` and its setter.
- `src/client/AppLayout.tsx` — insert the badge component **before**
  `<UptimeBadge>` at line 145. The component itself iterates the
  store map and emits 0..N pills.

## Blocking prereqs

These must be answered before each phase ships. Claude (1, 3, 4) is
done; Codex (2) is still outstanding.

1. **Capture the Claude data source.** ✅ **Done.** Originally we
   used `GET /api/oauth/usage` (HTTP fixture under
   `__fixtures__/claude-usage-max-20x.json`, parsed by a now-deleted
   `parseClaudeUsage`). Later replaced with the CLI's `rate_limit_event`
   stream messages after the HTTP endpoint proved too aggressively
   rate-limited to keep the badge fresh. Schema for the stream event
   was recovered from the embedded Zod schema in the Claude CLI binary
   (search for `rate_limit_event`).
2. **Capture the Codex endpoint.** Still outstanding. Same exercise
   against a ChatGPT-plan-authenticated `codex` CLI. Confirm the
   path (it has shifted across versions) and save the fixture. See
   `checklist.md`.
3. **Confirm OAuth scope for Claude.** ✅ **Done 2026-05-19.** The
   CLI's existing scopes (`user:file_upload, user:inference,
   user:mcp_servers, user:profile, user:sessions:claude_code`) are
   sufficient — the endpoint returns 200 OK with the current token,
   no extra scope needed.
4. **Confirm refresh behavior for Claude.** ✅ **Done 2026-05-19.**
   The CLI persists access token, refresh token, and expiresAt under
   `claudeAiOauth` in `.credentials.json` and rotates the file in
   place when the access token nears expiry. The orchestrator
   reads the same file on every `getAccessToken()` call, so the
   refreshed token propagates automatically. No orchestrator-side
   refresh-token handling is needed.

## Edge cases

- **First-run / no providers authenticated:** every provider's
  `canFetch()` → false → map empty → no pills rendered → header
  collapses to its current shape. Once the user signs in to any
  provider, the auth-complete event triggers an immediate refresh of
  that one (see "Authenticate-then-refresh" above) and its pill
  appears within seconds, not on the next 60s tick. Other providers'
  pills remain absent until they're also signed in.
- **One provider authenticated, the other not:** the unauthenticated
  one's `canFetch()` → false → omitted from the map → only the
  authenticated one's pill renders.
- **`ANTHROPIC_API_KEY` set (pay-as-you-go):** Claude's `canFetch()`
  → false → no Claude pill. Codex pill still renders if Codex is
  subscription-authed.
- **`OPENAI_API_KEY` set (pay-as-you-go):** symmetric — no Codex
  pill; Claude pill renders if applicable.
- **`ANTHROPIC_AUTH_TOKEN` set (OAuth-via-env, dogfooding path):**
  Claude's `canFetch()` → true. Provider reads the token from
  `process.env.ANTHROPIC_AUTH_TOKEN` rather than the credentials
  file. This is the inner-orchestrator path used by
  ShipIt-in-ShipIt — see `auth.ts:151–158`.
- **Sign-out from one provider:** that provider's auth manager
  clears credentials → its map entry deleted → next SSE broadcast
  omits the key → that one pill disappears. The other pill is
  unaffected.
- **OAuth token expired (file stale, CLI hasn't run recently):**
  endpoint returns 401 → that provider's entry becomes `error:
  "auth expired"` → its pill renders "Claude —" with the tooltip;
  polling for that provider halts until the next `auth_complete`
  event. Other providers' pills continue to update on the normal
  cadence.
- **Endpoint returns 200 with unexpected schema:** provider falls
  through schema validation, returns `error: "limits unavailable"`,
  logs the unexpected payload (no PII expected, but capped at
  ~1 KB). Same backoff as 5xx. Per-provider — only that pill
  flips to the error state.
- **One provider's endpoint is slow or down, the other is fine:**
  fetches are parallel; the healthy provider's pill updates on its
  normal cadence while the unhealthy one's pill stays in its last
  state (or flips to error after a failed attempt). Neither blocks
  the other.
- **Agent registered without a limits provider:** no provider in the
  DI map for that `AgentId` → no pill ever rendered for it. No UI
  changes needed when a new backend lands; adding a provider is
  sufficient.
- **Orchestrator container without `/credentials/.codex/auth.json`
  mounted:** Codex provider's `canFetch()` returns false (no
  credentials path → no token) → no Codex pill. Same path used by
  `CodexAuthManager.checkCredentials()` so the behavior matches the
  existing auth-status UI.

## Open questions

1. **Tooltip prose.** Exact wording for the breakdown, the
   "—" / unavailable state, and the failure modes. Cosmetic; pick
   during implementation.
2. **Test mode.** Integration tests should inject a
   `StubLimitsProvider` (mirrors `StubGitHubAuthManager`) that
   returns deterministic numbers — same pattern
   `pr-status-poller.test.ts` already uses. No design decision left
   here, just an implementation note.
3. **Snapshot persistence across orchestrator restarts.** Worth it
   to checkpoint the latest snapshots so the pills aren't blank for
   ~60s after every restart? Probably not — the upstream cost of a
   fresh fetch on boot is N HTTP calls (one per fetchable provider,
   so ≤2 today), and pills being blank for 60s right after a
   restart is acceptable. Default: do not persist.
4. **Per-pill provider label.** Each pill needs to indicate which
   provider it represents so two side-by-side pills are
   distinguishable. Candidates:
   - **Name prefix** (preferred default): `"Claude 5h 96% · 7d 22%"`
     / `"Codex 5h 30% · 7d 5%"`. Readable, no asset work, ~22 chars.
   - **Provider icon + numbers:** small Anthropic / OpenAI mark
     before the numbers. Saves characters but requires brand-icon
     assets and a per-agent mapping; phosphor-icons doesn't ship
     these.
   - **Plan name as prefix:** `"Pro 5h 96% · 7d 22%"` /
     `"Plus 5h 30% · 7d 5%"`. Carries more information but plan
     names overlap across providers ("Pro" exists for both
     Anthropic and OpenAI) and can shift over time.
   Default to the name prefix and revisit if brand-icon assets land
   later.

## Phasing

**Phase 0 — Spike.** ✅ **Complete.** Claude side (2026-05-19):
URL verified, scope verified, refresh behavior verified, body
fixture checked in. Codex side: the HTTP-endpoint capture was
abandoned — the candidate `/backend-api/codex/usage` path 401/403s
even with a valid token. The verified source turned out to be the
App Server's `account/rateLimits/updated` stream (observed in prod
session logs), so the Codex provider is event-fed, not polled.

**Phase 1 — Claude (HTTP, superseded).** Initially shipped polling
`GET /api/oauth/usage`. Worked but the endpoint is so aggressively
rate-limited that the badge spent most of its life on 30-minute-old
data, even after a turn-driven debounce (`refreshSubscriptionLimits`)
was added in PR #703. Replaced wholesale by Phase 4 below.

**Phase 2 — Codex.** ✅ **Complete (event-driven).** The
`/backend-api/codex/usage` HTTP path proved unusable (401/403 even
with a valid token), so the provider consumes the App Server's
`account/rateLimits/updated` notification instead: `CodexAdapter`
emits an `agent_rate_limits` event, the orchestrator pushes it into an
event-fed `CodexLimitsProvider`, and the plan tier is read from the
`chatgpt_plan_type` JWT claim. The pill is blank until a session's
first turn delivers a snapshot.

**Phase 3 (skipped) — Header-fallback for Claude.** Would have
captured `anthropic-ratelimit-unified-*` headers from completed turns
via an egress proxy. Phase 4 made it unnecessary — the CLI already
exposes the same data on its stream.

**Phase 4 — Claude (event-driven, current).** ✅ **Shipped.** Found
that the Claude CLI emits `rate_limit_event` messages on stream-json
output (free, derived from the same response headers Phase 3 would
have proxied for). `ClaudeAdapter` parses them into the same
`agent_rate_limits` AgentEvent Codex uses; the orchestrator routes
both providers through one `recordAgentRateLimits(agentId, …)`
callback into the matching `setRateLimits()` method.
`ClaudeLimitsProvider` no longer does HTTP. Cold-start UX matches
Codex: blank until the session's first turn.

## Key files (to read before implementing)

- `src/client/components/DockerMemoryBadge.tsx` — the visual pattern
  each pill copies.
- `src/client/AppLayout.tsx:144–153` — header right-hand cluster;
  insertion point is immediately before `<UptimeBadge>` on line 145.
- `src/server/orchestrator/limits-registry.ts` — the cache +
  broadcaster both providers feed into.
- `src/server/orchestrator/limits/claude-limits.ts` /
  `codex-limits.ts` — the two event-fed providers.
- `src/server/session/agents/claude-adapter.ts` — `rate_limit_event`
  parser for Claude.
- `src/server/session/agents/codex-adapter.ts` —
  `account/rateLimits/updated` parser for Codex.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — routes
  `agent_rate_limits` events into `recordAgentRateLimits`.
- `src/server/orchestrator/auth.ts` — Claude OAuth credentials path.
- `src/server/orchestrator/codex-auth.ts` — Codex auth path (per
  doc 119).
- `src/server/shared/agent-registry.ts` — read for the
  *constructor-injected-callbacks* pattern (`checkClaudeAuth`,
  `checkCodexAuth`) so the new DI registration follows house style.
  Note: providers do **not** live on this registry; see
  [Architecture](#architecture).
- `docs/119-codex-subscription-auth/plan.md` — explicitly lists this
  feature as a follow-up non-goal. Read its "Background" section for
  how Codex auth tokens are persisted.
- `docs/132-slash-commands/plan.md` — has already classified `/usage`
  and `/status` as Bucket 1 ("ShipIt already owns the surface"). This
  doc is the implementation of that classification.

## References

External research that informed the API choices above:

- Anthropic — [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- Anthropic — [Usage limit best practices](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)
- Anthropic — [API rate limits](https://platform.claude.com/docs/en/api/rate-limits) (the `anthropic-ratelimit-unified-*` headers)
- GitHub — [anthropics/claude-code#44328 — feature request: `claude usage` JSON command](https://github.com/anthropics/claude-code/issues/44328) (confirms the OAuth `/usage` endpoint is the only viable source today)
- GitHub — [anthropics/claude-code#28999 — expose `/usage` quota in statusLine JSON](https://github.com/anthropics/claude-code/issues/28999)
- GitHub — [anthropics/claude-code#13667 — display Max/Pro rate limits in status line](https://github.com/anthropics/claude-code/issues/13667)
- GitHub — [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) (community reference impl; uses local JSONL only, validates the limit of that path)
- GitHub — [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) (community tool; same local-JSONL constraint)
- OpenAI — [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- OpenAI — [Codex pricing](https://developers.openai.com/codex/pricing)
- GitHub — [openai/codex#15281 — expose full usage/limits data in CLI `/status`](https://github.com/openai/codex/issues/15281) (confirms `/status` is REPL-only and that the CLI internally calls a usage endpoint — community-reported path `GET /api/codex/usage`, to be verified per [Blocking prereqs](#blocking-prereqs))
- GitHub — [openai/codex-plugin-cc#102 — add `/codex:usage` command](https://github.com/openai/codex-plugin-cc/issues/102)
