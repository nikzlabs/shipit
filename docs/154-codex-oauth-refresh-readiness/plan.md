---
status: done
priority: low
description: Codex shares the same architectural OAuth-refresh vulnerability as Claude (per-session credentials, single shared NAT egress). It's not currently manifest, but if OpenAI changes its policies the symptom would mirror docs/153. Track the readiness work so we can flip the switch quickly when needed.
---

# 154 — Codex OAuth refresh readiness

## Why this doc exists

docs/153 ([orchestrator-owned-claude-oauth-refresh](../153-orchestrator-owned-claude-oauth-refresh/plan.md))
fixes a per-session-CLI refresh stampede that broke Claude sessions every ~8h on
prod. The root cause was structural: N session containers, one outbound NAT IP,
each session independently calling `console.anthropic.com/v1/oauth/token` →
Anthropic's rate limiter sees one noisy client and 429s them all → no refresh
ever succeeds → source token rots → every session 401s.

**Codex sessions on the same host are not currently affected.** docs/153 is
shipped Claude-only. This doc captures *why* Codex is fine today, *what would
change that*, and *what we'd build* if/when it does. No new investigation
required to pick this up later — just the trigger conditions to watch for and
the design steps that follow from docs/153.

## The shared architecture

Per-session credential isolation (docs/138) applies identically to both
providers. The same flow exists for both:

- `provisionAgentCredentials` copies a snapshot of source creds into the
  per-session subtree on first turn.
- `syncAgentTokenIn` pulls the freshest source token before each turn
  (`session-credentials.ts`).
- `syncAgentTokenBack` writes a CLI-rotated token back to source after each
  turn ends (`session-credentials.ts`, wired in `agent-execution.ts` and
  `dispatched-turn.ts`).
- Multiple sessions all pull from the same source and could all rotate it.

So the structural conditions for the stampede are present for both providers.
The difference is whether OpenAI's OAuth policies trigger it.

## Why Codex doesn't manifest the bug today

Best-effort enumeration (no new investigation, drawn from existing code and
prior diagnostic data):

1. **OpenAI may not rotate refresh tokens.** Anthropic's are single-use — each
   refresh invalidates the prior. If OpenAI's refresh tokens are non-rotating,
   N sessions can all use the same refresh token in parallel without invalidating
   each other. No race.

2. **Codex access-token lifetime is longer.** The diagnostic dump of a prod
   `auth.json` showed the access-token JWT `exp` ~13.7 days out, vs Anthropic's
   ~8 hours. Refresh frequency is ~40× lower. Even if rate limits exist, the
   pressure is much lower.

3. **OpenAI's token endpoint may not be aggressively rate-limited.** Or the
   bucket is wide enough that N daily-ish refreshes don't trip it.

4. **Codex sync-back signal is more sensitive.** `readCodexTokenFreshness`
   (`session-credentials.ts`) reads `last_refresh` (ISO timestamp) as a fallback,
   which advances on *every* CLI refresh even when JWT `exp` doesn't change
   meaningfully between two refreshes a few seconds apart. Claude's freshness
   reader only knows `claudeAiOauth.expiresAt`. So Codex's existing sync-back
   catches more rotations than Claude's does.

Each of these is a property of *current* OpenAI behavior, not an invariant.

## Trigger conditions (when to pick this up)

Build a Codex equivalent of docs/153's refresher when any of:

- **Symptom**: Codex sessions start hitting `401`-shaped errors a fixed time
  after sign-in (similar to the Claude pattern in docs/142 / docs/153). Likely
  a stampede.
- **Diagnostic shape**: source `/credentials/.codex/auth.json` mtime stuck
  while per-session `auth.json` files churn but `last_refresh` doesn't advance.
- **Direct curl against OpenAI's token endpoint** (whatever it is) returns
  sticky 429 from inside the orchestrator container.
- **Upstream change**: OpenAI announces refresh-token rotation, shorter
  access-token TTLs, or rate-limit policy changes on the OAuth endpoint.

If you observe any of those, copy docs/153's design directly — the
architectural answer is identical, only the per-provider details change.

## What changes from docs/153

Same scheduler / single-flight / per-account isolation / file-state delta
detection / debug-log classification. The Codex-specific pieces:

### 1. Source file location

Codex source lives at `/credentials/.codex/auth.json` (account-aware path:
`/credentials/provider-accounts/codex/<accountId>/.codex/auth.json`). The
legacy-to-account migration via `provider-account-manager.ts` already covers
Codex; the symlinks resolve the same way they do for Claude.

### 2. Freshness reader

Reuse the existing `readCodexTokenFreshness` (`session-credentials.ts`). It
already understands the three Codex freshness signals (explicit `expires_at`,
JWT `exp` from `tokens.access_token` / `tokens.id_token`, `last_refresh` ISO
timestamp). The Claude refresher reads `claudeAiOauth.expiresAt` directly;
the Codex refresher would call `readCodexTokenFreshness(file)` instead.

### 3. CLI commands

Not investigated. The Claude refresher uses:

- **Tier 1**: `claude auth status --json` (designed for scripted use; may or
  may not trigger refresh-on-use; refresher discovers at runtime via file-state
  delta).
- **Tier 2**: `claude --print "ok" --model claude-haiku-4-5-20251001 --tools "" --no-session-persistence`
  (billable, structurally guaranteed to trigger refresh-on-use).

For Codex we'd need to inventory `codex auth ...` / `codex --help`. Likely
candidates:

- `codex auth status` (if it exists and triggers refresh — the cheap path).
- `codex exec "ok"` or equivalent minimal prompt with a cheap model
  (billable fallback).

The two-tier shape (free preferred, billable fallback) carries over. The
runtime discovery (file-state delta as the success signal) carries over.

### 4. CLI binary path / env

The orchestrator's Dockerfile installs `codex` at the same level as `claude`
(see `docker/agent-cli/package.json` — `@openai/codex` is pinned). Spawn with
`HOME=<accountRoot>` so the CLI reads/writes the *account's*
`/credentials/provider-accounts/codex/<accountId>/.codex/auth.json` directly.

### 5. Failure classification

Codex's CLI debug output is unknown. Whatever 429-shaped and
`invalid_grant`-shaped signals it emits, the classifier needs to recognize.
Initially keep the patterns liberal (any `429` / `rate_limit`, any
`invalid_grant`); refine empirically.

### 6. SSE event name

Pair with the new `claude_account_unauthenticated` event from docs/153:

- `codex_account_unauthenticated` { accountId } — same shape, different
  provider. docs/150 multi-account failover can consume both uniformly.

### 7. Test plan

Mirror docs/153's test file. Reuse the fake-spawn pattern. Add Codex-specific
fixtures (sample `auth.json` with JWT-encoded `exp`, `last_refresh` advances,
etc.).

## What to share with docs/153

The scheduler shape, single-flight Promise mutex, per-account state, debug-log
capture, and CLI spawn helper are all provider-agnostic. When picking this up,
consider extracting the shared core into a base class (`OAuthRefresherBase`)
and making `ClaudeOAuthRefresher` / `CodexOAuthRefresher` thin per-provider
specializations. Not worth doing pre-emptively — the right factoring isn't
clear until both implementations exist.

## What's out of scope here

- **A CLI inventory for Codex.** When you pick this up, run the same
  inventory prompt that produced docs/153's Tier 1 / Tier 2 decisions, against
  the prod-deployed `@openai/codex` version at that time.
- **The per-account failover that consumes the unauthenticated SSE event.**
  Owned by docs/150 (multiple provider subscriptions). Both Claude and Codex
  hooks feed into the same failover layer.

## Pointer

- docs/153 plan: `../153-orchestrator-owned-claude-oauth-refresh/plan.md`
- Claude refresher implementation: `src/server/orchestrator/agents/claude/oauth-refresher.ts`
- Codex refresher implementation: `src/server/orchestrator/agents/codex/oauth-refresher.ts`
- Codex sync code (already in place):
  - `readCodexTokenFreshness` in `src/server/orchestrator/session-credentials.ts`
  - `syncProviderAccountTokenIn` / `syncProviderAccountTokenBack` /
    `repushProviderAccountToken` — already account-aware for Codex
- Codex CLI install: `docker/agent-cli/package.json`

## Implemented notes

The Codex refresher now mirrors docs/153's scheduler/single-flight/backoff
shape and is wired in `src/server/orchestrator/index.ts` beside the Claude
refresher. It runs only in containerized runtime, iterates Codex provider
accounts, refreshes with `HOME=<accountRoot>`, repushes rotated account tokens
to pinned Codex sessions, and emits:

- `codex_account_unauthenticated` / `codex_account_authenticated`
- unified `agent_auth_failed` with `{ agentId: "codex", reason: "revoked" }`

The dev container used for implementation did not have `codex` on `PATH`, so
live CLI inventory was not possible in-session. The chosen commands use shapes
already documented or used elsewhere in ShipIt:

- Tier 1: `codex login status`
- Tier 2: `codex exec --skip-git-repo-check "ok"`

Unlike Claude, the Codex refresher does not append Claude-specific
`--debug api --debug-file ...` flags. Failure classification is based on
captured stdout/stderr plus the authoritative auth-file freshness delta.
