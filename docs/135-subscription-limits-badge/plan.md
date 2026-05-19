---
status: planned
priority: medium
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
| Per-request response headers | `anthropic-ratelimit-unified-status` and `anthropic-ratelimit-unified-reset` are returned on every API call and *are* what the CLI parses to populate `/usage`. They tell us "what percentage of the unified rate-limit window is currently used" and "when does it reset." Available only after a turn has run. |
| **`GET https://api.anthropic.com/api/oauth/usage`** | **Undocumented** OAuth-scoped endpoint Claude Code calls to populate `/usage`. Returns session %, weekly %, weekly-Opus-only %, reset times. Auth: the OAuth bearer token already stored in `/root/.claude/.credentials.json`. This is the canonical source. |
| Anthropic Admin API `GET /v1/organizations/usage_report/claude_code` | Org/Team/Enterprise only, requires admin API key (`sk-ant-admin-…`). Not viable for individual Pro/Max subscribers, which is most ShipIt users. |

**Candidate primary source:** `GET /api/oauth/usage` on `api.anthropic.com`
(community-reported path), authenticated with the OAuth access token
the existing `AuthManager` persists. This appears to be the same call
the Claude CLI makes when the user types `/usage`.

**Important: this URL is not verified.** It comes from community
reverse-engineering of the CLI, not from Anthropic documentation. The
exact path, request shape, and response schema must be captured
empirically before any code is written — see
[Blocking prereqs](#blocking-prereqs).

**Fallback when the endpoint fails or returns unexpected shape:**
shipping nothing in Phase 1. The badge shows "—" with a tooltip "limits
unavailable." We do **not** plan to MITM the agent's outbound HTTPS to
sniff `anthropic-ratelimit-unified-*` response headers — that's
significantly more invasive than this doc presented in earlier drafts
(the Claude CLI talks directly to `api.anthropic.com` from inside the
session container; capturing headers requires either a proxy injected
between the CLI and the network, or a CLI change to write them
somewhere accessible). See [Phase 3](#phasing) for why we treat this
as a separate, optional follow-up rather than a Phase-1 fallback.

**Risk: the endpoint is undocumented.** Anthropic could change or
remove it without notice. Mitigation: the provider interface (see
[Architecture](#architecture)) isolates the call to one function — if
the endpoint changes, that's the only file that moves. And: the same
risk applies to `/usage` in the CLI itself — both surfaces depend on
this endpoint, so if Anthropic breaks it, the CLI breaks too and the
user already knows.

**Risk: OAuth scope.** The Claude OAuth token ShipIt holds was minted
for the CLI's scope. If that scope does **not** include the read needed
for `/api/oauth/usage`, the entire Claude provider is unbuildable
without forcing the user through a re-auth flow asking for additional
scope — and we are not asking the user to re-authenticate just for a
badge. Empirically the CLI uses the same token to call `/usage`, so the
answer is almost certainly "scope is included," but this is a go/no-go
question, not an open one. See [Blocking prereqs](#blocking-prereqs).

### Codex (OpenAI)

| Surface | Status |
|---|---|
| `/status` slash command in the Codex TUI | REPL-only. Renders `5h 96% · Weekly 94% · resets …` line. No `--json` flag. Feature request open (openai/codex#15281). |
| Internal Codex endpoint | The Codex CLI fetches rate-limit data via **`GET /api/codex/usage`** on the ChatGPT backend (`backend-api.openai.com` / `chatgpt.com`). This is what populates `/status`. |
| `~/.codex/config.toml` | User config only. No live rate-limit data. |
| `~/.codex/auth.json` | OAuth-bearer credentials. Same token the CLI uses to call the usage endpoint. Already mounted into the credentials volume by doc 119 (`CodexAuthManager`). |
| Response headers on `codex app-server` API calls | OpenAI's API returns the usual `x-ratelimit-*` headers, but for ChatGPT-subscription auth those numbers don't map onto the 5h / weekly windows the user actually cares about. Header path is **not** a viable fallback for Codex. |

**Candidate primary source:** `GET /api/codex/usage` (community-reported
path the Codex CLI uses internally to populate `/status`).
Authenticated with the access token persisted under
`/credentials/.codex/auth.json` (symlinked to `/root/.codex/auth.json`
inside the orchestrator container) — same file `CodexAuthManager`
writes.

**Same caveat as Claude:** the URL is not verified, and OpenAI shipped
two rate-limit fixes in the Codex CLI ~v0.21 (per Embirico's
announcement; exact date unverified) that may have shifted the path.
Capture the real URL + response schema before implementation begins —
see [Blocking prereqs](#blocking-prereqs).

**Fallback:** none. If the endpoint fails, the badge shows "—" with a
tooltip "limits unavailable." Unlike Claude there is no useful
secondary source — Codex CLI doesn't write per-turn rate-limit data
anywhere accessible, and OpenAI's response headers don't map onto the
5h / weekly windows the user cares about.

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
  /** Optional: weekly Opus-only sub-quota (Claude Max only). null otherwise. */
  weeklyOpus?: { usedPct: number; resetAt: string } | null;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
  /** Set when the fetch failed; rendered as a neutral "—" with this tooltip. */
  error?: string;
}

// src/server/orchestrator/limits/types.ts  (orchestrator-only)
export interface LimitsProvider {
  agentId: AgentId;
  /** True if there's enough info (auth, plan) to even try a fetch. */
  canFetch(): boolean;
  /** Returns a fresh snapshot, or { error } on failure. Never throws. */
  fetch(): Promise<SubscriptionLimits>;
}
```

Each agent backend ships a provider:

- `src/server/orchestrator/limits/claude-limits.ts` — calls the
  candidate Anthropic endpoint with the bearer token read out of
  `AuthManager`'s persisted credentials (see "AuthManager surface to
  add" below).
- `src/server/orchestrator/limits/codex-limits.ts` — calls the
  candidate Codex endpoint with the access token read out of
  `CodexAuthManager`'s persisted `auth.json` (see "CodexAuthManager
  surface to add" below).

Providers are registered in the orchestrator's DI layer (`app-di.ts`)
in a `Map<AgentId, LimitsProvider>` and injected into the
`LimitsPoller`. They do **not** live on `AgentRegistry` /
`agent-registry.ts` — that registry describes *static* agent metadata
(name, models, capabilities) and is imported by client code via
`AGENT_REGISTRY` exports; hanging a server-only HTTP fetcher off it
would either leak HTTP code into the client bundle or force a split
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

### Polling on the orchestrator

A new `LimitsPoller` lives next to `pr-status-poller.ts`:

- **Cadence:** 60 seconds per provider, matching the user-visible
  "refresh every minute" requirement.
- **Trigger:** runs whenever there is at least one connected SSE
  client AND at least one registered provider returns
  `canFetch() === true`. Notably: an *active runner* is **not**
  required — gating on an active runner would leave the badges blank
  on the home screen and for the first ~60s after a session opens.
  Cost: one HTTP call per minute *per fetchable provider* while the
  user has the tab open. With both Claude and Codex subscriptions
  authenticated, that's 2 calls/min, issued in parallel.
- **Caching:** snapshots are held in a `Map<AgentId, SubscriptionLimits>`.
  Every fetchable provider gets its own entry; providers with
  `canFetch() === false` are omitted entirely from the map (not
  stored as `null`). This is the part that changes from
  `docker_memory`'s single-value cache — there are now N pills, so
  there are N cache entries.
- **No active-agent tracking.** The poller has no notion of "which
  session is focused." All fetchable providers are polled in parallel
  on the same 60s cadence; the client renders one pill per map entry
  in stable order. This is intentional and matches the rest of the
  header (everything global, nothing focus-driven).
- **Broadcast:** on every successful fetch (or on transition into an
  `error` state for any provider), emit a new SSE event
  `subscription_limits` whose payload is the full
  `Record<AgentId, SubscriptionLimits>`. The full map is sent on every
  broadcast — partial deltas are not worth the complexity for an
  N≤3 collection updated once a minute. The initial-connect snapshot
  is included in the existing burst sent at `/api/events` connect
  time, alongside `docker_memory`.
- **Authenticate-then-refresh:** after a successful Claude or Codex
  login the auth managers already emit `auth_complete` /
  `codex_auth_complete`. The poller listens for these and triggers an
  immediate refresh of *just that provider* so its pill doesn't sit
  blank for up to 60s after first sign-in. After sign-out (or a
  forced credential clear), the provider's entry is *deleted* from
  the map — not retained — so the user doesn't see stale numbers
  attributed to an account they're no longer signed into. The next
  broadcast omits that key and the client drops the corresponding
  pill.
- **Failure handling (per provider, independent):** errors are cached
  too (with `error` populated) so the UI shows the failure state
  instead of flashing the previous good value. Each provider has its
  own backoff counter — Claude failing doesn't slow Codex down. Three
  distinct cases per provider:
  - **401 / 403 (auth):** mark `error: "auth expired"`, stop polling
    *that provider* until its auth manager re-emits `auth_complete`.
    Other providers keep polling normally. Don't back off; re-auth
    is the only fix.
  - **429 (rate-limited by the usage endpoint itself):** respect
    `Retry-After` if present; otherwise back off to 15 minutes *for
    that provider*. Do not increment the generic consecutive-failure
    counter — a 429 isn't an outage, it's a signal to slow down.
  - **5xx / network / unexpected schema:** consecutive-failure
    exponential backoff (60s → 5m cap), generic `error: "limits
    unavailable"`. Per-provider counter.

This mirrors the existing `docker_memory` flow in `index.ts:406–423` in
shape (cache + SSE broadcast + initial-connect snapshot) but with a
map-valued cache and a 60s cadence rather than the unconditional 10s
timer — the upstream cost matters here, the cost of `docker stats`
locally does not.

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
  `DockerMemoryBadge.tsx`: small `<span>` pill with `tabular-nums`
  and color tiers (green → yellow → orange → red). Each pill carries
  a short provider label so the two are distinguishable when both are
  shown (see Open question 4 for the exact label form).
- **Placement:** `AppLayout.tsx:145`, immediately **before** the
  existing `<UptimeBadge>`. Hidden on mobile (`hidden sm:inline`) for
  symmetry with the memory badge. New header order, left-to-right
  within the right-hand cluster:
  `SubscriptionLimitsBadge → UptimeBadge → DockerMemoryBadge → Settings → ThemePicker`.
- **Rendering rules (per pill):**

  ```
  When that agent has no map entry   →  pill not rendered
  When entry.error is set            →  "Claude —" pill, neutral
                                        color, error string in
                                        tooltip
  Otherwise                          →  Label: "Claude 5h 96% · 7d 22%"
                                        (≤22 chars). Both numbers
                                        shown always; color is driven
                                        by the weekly value when it's
                                        non-trivial (≥10%), else by
                                        the session value. Rationale:
                                        a 100%/20% state is not a red
                                        situation — the 5h window
                                        resets in minutes, the weekly
                                        is what actually matters for
                                        "can I keep working today?"
                                        Tooltip: full breakdown,
                                        reset times, plan name ("Pro"
                                        / "Max 20x" / "Plus"). No
                                        link out — the number on the
                                        badge is the surface. (§1)
  ```

- **Color tiers** apply per pill, to the *color-driving* value
  selected by the rule above. One pill being red does not affect the
  other pill's color.
  - ≥90% used → `text-red-400`
  - ≥75% → `text-orange-400`
  - ≥60% → `text-yellow-400`
  - otherwise → `text-(--color-text-secondary)`

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
- `src/server/orchestrator/app-di.ts` — register
  `Map<AgentId, LimitsProvider>`, wire `LimitsPoller`.
- `src/server/orchestrator/index.ts` — start the poller, include the
  snapshot in the `/api/events` initial-state burst, broadcast
  `subscription_limits` events.
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

These must be answered **before** Phase 1 implementation starts. Each
is a small, one-time investigation; bundle them as a single
spike-style task.

1. **Capture the Claude endpoint.** Run the Claude CLI against a real
   Pro/Max account behind `mitmproxy` (or similar). Verify the
   request URL, required headers, OAuth-scope behavior, and the
   response JSON shape that backs `/usage`. Save the captured
   response as a fixture for tests.
2. **Capture the Codex endpoint.** Same exercise against a ChatGPT-
   plan-authenticated `codex` CLI. Confirm the path (it has shifted
   across versions) and save the fixture.
3. **Confirm OAuth scope for Claude.** If the captured `/usage` call
   uses a scope the stored ShipIt token doesn't have, this feature
   is **not buildable** in Phase 1 without forcing the user through
   re-auth (a non-starter). Empirically the Claude CLI uses the same
   OAuth token, so the expected answer is "scope is fine," but treat
   this as go/no-go.
4. **Confirm refresh behavior.** Verify that running the Claude CLI
   refreshes `.credentials.json` in place so the orchestrator can
   read it back without driving its own refresh-token call.

If 1–3 land cleanly, Phase 1 proceeds. If 3 fails, this doc gets
re-scoped or shelved — we are not asking the user to re-authenticate
just to power a header pill.

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

**Phase 0 — Spike.** Complete the four [blocking
prereqs](#blocking-prereqs). Output: two captured fixtures (one
Claude, one Codex), one go/no-go on Claude's OAuth scope.

**Phase 1 — Claude only.** Provider + `AuthManager.getAccessToken()`
+ poller + SSE + badge. Codex provider stubbed to
`canFetch() === false`. Ships independently of doc 119.

**Phase 2 — Codex.** Add the Codex provider once doc 119
(`CodexAuthManager`) is fully shipped — the badge needs the OAuth
token that flow persists. (119 is `in-progress`, so this phasing is
real.)

**Phase 3 (optional, separate doc) — Header-fallback for Claude.**
Capture `anthropic-ratelimit-unified-*` headers from completed turns.
This is *significantly* more invasive than it sounds: the Claude CLI
talks directly to `api.anthropic.com` from inside the session
container, so capturing those headers requires either (a) injecting an
egress proxy between the CLI and the network, or (b) waiting for a
CLI change that writes them to disk. Both are larger than this whole
doc. If Phase 1 ships and proves reliable, Phase 3 is probably not
worth doing — call it out for completeness rather than as a planned
follow-up.

## Key files (to read before implementing)

- `src/client/components/DockerMemoryBadge.tsx` — the visual pattern
  each pill copies.
- `src/client/AppLayout.tsx:144–153` — header right-hand cluster;
  insertion point is immediately before `<UptimeBadge>` on line 145.
- `src/server/orchestrator/docker-memory.ts` — the polling + caching
  pattern this poller copies.
- `src/server/orchestrator/index.ts:406–423` — the 10s memory-stats
  interval the 60s limits-poller mirrors.
- `src/server/orchestrator/auth.ts` — Claude OAuth credentials path.
- `src/server/orchestrator/codex-auth.ts` — Codex auth path (per
  doc 119).
- `src/server/orchestrator/pr-status-poller.ts` — closest existing
  precedent for a polled-external-API service in the orchestrator.
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
