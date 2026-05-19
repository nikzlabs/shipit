---
status: planned
priority: medium
---

# 135 — Subscription limits badge

## Summary

Render a header badge that shows the user's **subscription rate-limit usage**
for the currently active agent (Claude or Codex) — the same numbers the
agent's own REPL exposes via `/usage` / `/status`: percentage of the 5-hour
session window consumed, percentage of the weekly cap consumed, and the
reset clock. The badge sits to the right of the existing `DockerMemoryBadge`
in the top bar (`AppLayout.tsx:141`) and refreshes once a minute.

This pulls upstream rate-limit data — which today lives **only** behind a
non-ShipIt surface (`claude /usage` in the Claude TUI, `codex /status` in
the Codex TUI, or the chatgpt.com/codex web dashboard) — into ShipIt and
renders it inline. Per §1/§2: if the user needs the data, ShipIt shows
the data; they don't open another tab or pop a separate REPL to find out
they're about to be cut off mid-turn.

The badge is **only** shown when the agent is authenticated against a
subscription. API-key paths (Anthropic Platform `ANTHROPIC_API_KEY`,
OpenAI Platform `OPENAI_API_KEY`) have no human-readable subscription
quota — they bill per token via metered headers — so the badge is hidden
there.

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
- **No badge for API-key auth.** Pay-as-you-go has no quota to render;
  the badge is hidden and the slot collapses.
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

**Chosen primary source:** `GET /api/oauth/usage` on `api.anthropic.com`,
authenticated with the OAuth access token the existing `AuthManager`
already manages. This is the same call the Claude CLI makes when the user
types `/usage` — same response shape, same auth.

**Fallback when the endpoint fails or returns unexpected shape:** parse
the `anthropic-ratelimit-unified-status` / `…-reset` headers we already
see on the last-completed-turn API responses. The Claude CLI does this
internally already; we'd need to add header capture to the worker's HTTP
proxy of the agent's API calls. *Optional Phase 2* — Phase 1 ships
endpoint-only and shows a neutral "—" if the endpoint is down.

**Risk: the endpoint is undocumented.** Anthropic could change or remove
it without notice. Mitigation: the provider interface (see
[Architecture](#architecture)) isolates the call to one function. If the
endpoint changes, that's the only file that moves. Also: the same risk
applies to `/usage` in the CLI itself — both surfaces depend on this
endpoint, so if Anthropic breaks it, the CLI breaks too, and the user
already knows. We are not adding a new dependency.

### Codex (OpenAI)

| Surface | Status |
|---|---|
| `/status` slash command in the Codex TUI | REPL-only. Renders `5h 96% · Weekly 94% · resets …` line. No `--json` flag. Feature request open (openai/codex#15281). |
| Internal Codex endpoint | The Codex CLI fetches rate-limit data via **`GET /api/codex/usage`** on the ChatGPT backend (`backend-api.openai.com` / `chatgpt.com`). This is what populates `/status`. |
| `~/.codex/config.toml` | User config only. No live rate-limit data. |
| `~/.codex/auth.json` | OAuth-bearer credentials. Same token the CLI uses to call the usage endpoint. Already mounted into the credentials volume by doc 119 (`CodexAuthManager`). |
| Response headers on `codex app-server` API calls | OpenAI's API returns the usual `x-ratelimit-*` headers, but for ChatGPT-subscription auth those numbers don't map onto the 5h / weekly windows the user actually cares about. Header path is **not** a viable fallback for Codex. |

**Chosen primary source:** `GET /api/codex/usage` (or whichever final URL
the Codex CLI v0.21+ uses — confirm at implementation time by snooping
the CLI's own network traffic in dev). Authenticated with the access
token from `~/.codex/auth.json`.

**Fallback:** none for Phase 1 — if the endpoint fails, the badge shows
"—" with a tooltip pointing at the upstream billing page. We can't
synthesize the numbers from local data because, unlike Claude, the
Codex CLI does not write per-turn rate-limit headers anywhere useful.

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

A small agent-agnostic interface lives in `src/server/shared/`:

```ts
// src/server/shared/types/usage-limits-types.ts
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

// src/server/shared/types/usage-limits.ts
export interface LimitsProvider {
  agentId: AgentId;
  /** True if there's enough info (auth, plan) to even try a fetch. */
  canFetch(): boolean;
  /** Returns a fresh snapshot, or { error } on failure. Never throws. */
  fetch(): Promise<SubscriptionLimits>;
}
```

Each agent backend ships a provider:

- `src/server/orchestrator/limits/claude-limits.ts` — calls
  `GET https://api.anthropic.com/api/oauth/usage` with the bearer token
  from `AuthManager.getAccessToken()`. Refreshes the OAuth token first
  if it's within 60s of expiry, reusing whatever refresh path
  `AuthManager` exposes today.
- `src/server/orchestrator/limits/codex-limits.ts` — reads
  `~/.codex/auth.json`, calls `GET /api/codex/usage` on the ChatGPT
  backend, parses the response.

The registry in `src/server/shared/agent-registry.ts` gets a new
optional capability: `limitsProvider?: LimitsProvider`. Agents without
a provider (or with `canFetch() === false`) simply don't surface a
badge — UI-side this collapses to nothing.

### Polling on the orchestrator

A new `LimitsPoller` lives next to `pr-status-poller.ts`:

- **Cadence:** 60 seconds, matching the user-visible "refresh every
  minute" requirement.
- **Trigger:** runs only when there is at least one connected SSE
  client AND there is an active runner whose `agentId` has a
  `LimitsProvider` with `canFetch() === true`. Idle orchestrators
  don't burn quota-check requests.
- **Caching:** the latest snapshot per `agentId` is held in a
  `Map<AgentId, SubscriptionLimits>`. Reads are O(1).
- **Broadcast:** on every successful fetch (or on transition to
  `error`), emit a new SSE event `subscription_limits` with the
  snapshot. Initial-connect snapshot is included in the existing
  burst sent at `/api/events` connect time, alongside `docker_memory`.
- **Failure handling:** errors are cached too (with `error` populated)
  so the UI shows the failure state instead of flashing the previous
  good value. Exponential backoff on consecutive failures (60s → 5m
  cap) to avoid hammering the upstream when it's down.

This mirrors the existing `docker_memory` flow in `index.ts:406–423`
almost exactly — the cadence is different but the shape is identical.

### Wiring into the active agent

The badge always reflects the **current session's agent**. Most users
run one agent backend, so this is a no-op, but a session can override
the default via `agent` in `shipit.yaml`. The orchestrator sends the
limits map keyed by `agentId`; the client picks the entry matching the
*current session's* `agentId`, which it already tracks in
`session-store.ts`.

Multi-agent UX edge cases:

- **No active session yet (home screen):** show the default agent's
  limits. Same agent the next-new-session will use.
- **User switches sessions across agents:** the badge re-renders
  immediately from the cached map; the next 60s poll refreshes both
  providers if they're both `canFetch()`-able.

### Client

- **Store:** add `subscriptionLimits: SubscriptionLimits | null` to
  `ui-store.ts` (per-agent map, selected by current `agentId`).
- **SSE handler:** `useServerEvents.ts` adds a listener for the
  `subscription_limits` SSE event, dispatching to the store. Same
  shape as the existing `docker_memory` handler at
  `useServerEvents.ts:209`.
- **Component:** `src/client/components/SubscriptionLimitsBadge.tsx`
  — same skeleton as `DockerMemoryBadge.tsx`: a small `<span>` pill
  with `tabular-nums` and color tiers (green → yellow → orange → red).
- **Placement:** `AppLayout.tsx:141`, immediately after
  `<DockerMemoryBadge>` and before the settings gear. Hidden on
  mobile (`hidden sm:inline`) for symmetry with the memory badge.
- **Rendering rules:**

  ```
  When canFetch === false  →  badge hidden entirely
  When error is set        →  "—" pill, neutral color, error in tooltip
  Otherwise                →  Dominant number is whichever of
                              session% / weekly% is higher.
                              Label: "5h 96% · 7d 22%"  (max 14 chars).
                              Tooltip: full breakdown + reset times +
                              "Pro" / "Max 20x" plan name + link to
                              upstream billing (overflow-menu style).
  ```

- **Color tiers** mirror the memory badge:
  - ≥90% used → `text-red-400`
  - ≥75% → `text-orange-400`
  - ≥60% → `text-yellow-400`
  - otherwise → `text-(--color-text-secondary)`

### File layout

```
src/server/shared/types/usage-limits-types.ts       — types
src/server/orchestrator/limits/index.ts             — barrel
src/server/orchestrator/limits/types.ts             — LimitsProvider interface
src/server/orchestrator/limits/claude-limits.ts     — Claude provider
src/server/orchestrator/limits/codex-limits.ts      — Codex provider
src/server/orchestrator/limits-poller.ts            — 60s loop, cache, broadcast
src/server/orchestrator/limits-poller.test.ts       — unit tests
src/client/components/SubscriptionLimitsBadge.tsx   — UI
src/client/components/SubscriptionLimitsBadge.test.tsx
```

Touches: `AppLayout.tsx` (placement), `useServerEvents.ts` (SSE
handler), `ui-store.ts` (state), `index.ts` (poller wire-up, SSE
initial-state burst), `ws-server-messages.ts` (SSE event type).

## Open questions

1. **Exact Claude endpoint response shape.** We have community
   reverse-engineered evidence that `/api/oauth/usage` exists and
   returns the `/usage` data, but no public schema. We'll need a
   one-time capture (e.g. `mitmproxy` against the Claude CLI in a dev
   container) to lock down the field names. The provider abstraction
   means this is one file's worth of work.

2. **Codex endpoint stability.** OpenAI shipped two `codex` rate-limit
   fixes in v0.21 (Aug 2026) — the endpoint may shift again. Plan to
   re-verify at implementation time and pin to a snapshot.

3. **What about the OAuth `usage` endpoint scope?** The Claude OAuth
   token ShipIt holds was minted for the CLI's scope. Need to confirm
   that scope includes the `/usage` read. Empirically the CLI uses the
   same token, so the answer is almost certainly yes, but we should
   verify before shipping.

4. **Should the tooltip's link to the billing page count as a
   link-out exception?** Per §3, billing is one of the legitimate
   tabs. The badge tooltip would say `View on claude.ai →` /
   `View on chatgpt.com →` as an overflow-style escape hatch, not
   the primary affordance. Primary surface = the inline number.

5. **Test mode.** The poller hits live HTTP. Integration tests should
   inject a `StubLimitsProvider` (mirrors `StubGitHubAuthManager`)
   that returns deterministic numbers — same pattern that
   `pr-status-poller.test.ts` already uses.

## Phasing

**Phase 1 — Claude only.** Provider + poller + SSE + badge. Codex
provider stubbed to `canFetch() = false` until phase 2.

**Phase 2 — Codex.** Add the Codex provider once doc 119
(`CodexAuthManager`) is fully shipped — the badge needs the OAuth token
that flow persists. (119 is `in-progress`, so this phasing is real.)

**Phase 3 (optional) — Header-fallback for Claude.** Capture
`anthropic-ratelimit-unified-*` headers from completed turns and fold
them in as a secondary signal so the badge stays warm even if the OAuth
usage endpoint goes down.

## Key files (to read before implementing)

- `src/client/components/DockerMemoryBadge.tsx` — the visual pattern
  this badge copies.
- `src/client/AppLayout.tsx:139–148` — header insertion point.
- `src/server/orchestrator/docker-memory.ts` — the polling + caching
  pattern this poller copies.
- `src/server/orchestrator/index.ts:406–423` — the 10s memory-stats
  interval the 60s limits-poller mirrors.
- `src/server/orchestrator/auth.ts` — Claude OAuth credentials path.
- `src/server/orchestrator/codex-auth.ts` — Codex auth path (per
  doc 119).
- `src/server/orchestrator/pr-status-poller.ts` — closest existing
  precedent for a polled-external-API service in the orchestrator.
- `src/server/shared/agent-registry.ts` — where to hang the new
  optional `limitsProvider` capability.
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
- GitHub — [openai/codex#15281 — expose full usage/limits data in CLI `/status`](https://github.com/openai/codex/issues/15281) (confirms `/status` is REPL-only and that the CLI internally calls `GET /api/codex/usage`)
- GitHub — [openai/codex-plugin-cc#102 — add `/codex:usage` command](https://github.com/openai/codex-plugin-cc/issues/102)
