---
issue: planning#687
description: Codex shares the same architectural OAuth-refresh vulnerability as Claude (per-session credentials, copied auth.json files, single shared NAT egress). The orchestrator owns the refresh: one on-demand call to the Codex CLI 45 minutes before expiry, a harvest of session rotations, and a "needs sign-in" verdict only for a rejected grant.
---

# 154 — Codex OAuth refresh readiness

## Why this doc exists

docs/153 ([orchestrator-owned-claude-oauth-refresh](../153-orchestrator-owned-claude-oauth-refresh/plan.md))
fixes a per-session-CLI refresh stampede that broke Claude sessions every ~8h on
prod. The root cause was structural: N session containers, one outbound NAT IP,
each session independently calling `console.anthropic.com/v1/oauth/token` →
Anthropic's rate limiter sees one noisy client and 429s them all → no refresh
ever succeeds → source token rots → every session 401s.

Codex sessions refresh less frequently than Claude sessions, but they share the
same copied-token architecture. Current Codex reports now show the important
part of the risk is real: copied `auth.json` files can end up with a stale
single-use refresh-token chain after another copy refreshes first. That maps
directly onto ShipIt's per-session credential copies.

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

## Why Codex was lower urgency than Claude

Best-effort enumeration, drawn from existing code, local CLI checks, and prior
diagnostic data:

1. **Codex refreshes much less often.** The diagnostic dump of a prod
   `auth.json` showed the access-token JWT `exp` around 10-14 days out, vs
   Anthropic's ~8 hours. Refresh frequency is much lower, so the failure is
   less noisy than Claude's every-8h production break.

2. **OpenAI's token endpoint may not be aggressively rate-limited.** Or the
   bucket is wide enough that N daily-ish refreshes don't trip it.

3. **Codex sync-back signal is more sensitive.** `readCodexTokenFreshness`
   (`session-credentials.ts`) reads `last_refresh` (ISO timestamp) as a fallback,
   which advances on *every* CLI refresh even when JWT `exp` doesn't change
   meaningfully between two refreshes a few seconds apart. Claude's freshness
   reader only knows `claudeAiOauth.expiresAt`. So Codex's existing sync-back
   catches more rotations than Claude's does.

These factors reduce frequency and blast radius. They do not remove the copied
refresh-token race.

## Verification

Checked on 2026-06-02 against ShipIt's pinned Codex CLI:

- `/opt/agent-cli/.../codex --version` reports `codex-cli 0.133.0`, matching
  `docker/agent-cli/package-lock.json`.
- `codex login --help` exposes `login status`; `codex exec --help` exposes
  `--skip-git-repo-check`, so the refresher's selected commands exist on the
  pinned CLI.
- Running `HOME=/credentials CODEX_HOME=/credentials/.codex codex login status`
  against a healthy token printed `Logged in using ChatGPT` and did not mutate
  `auth.json`. Tier 1 is therefore a cheap status probe, not proof of refresh.
- The live auth file had `last_refresh` from 2026-05-31 and an access-token
  JWT expiring on 2026-06-10, so an in-session forced refresh would require
  either waiting for expiry or deliberately exercising the refresh-token chain.
  I did not force that against the real credential.
- Current upstream `openai/codex` issue reports document the same copied-auth
  failure mode ShipIt creates: one copy refreshes, other copied `auth.json`
  files later fail because the refresh token has already been used. That is the
  direct justification for moving refresh ownership to the orchestrator.

## Trigger conditions (when to pick this up)

The original trigger conditions were:

- **Symptom**: Codex sessions start hitting `401`-shaped errors a fixed time
  after sign-in (similar to the Claude pattern in docs/142 / docs/153). Likely
  a stampede.
- **Diagnostic shape**: source `/credentials/.codex/auth.json` mtime stuck
  while per-session `auth.json` files churn but `last_refresh` doesn't advance.
- **Direct curl against OpenAI's token endpoint** (whatever it is) returns
  sticky 429 from inside the orchestrator container.
- **Upstream change**: OpenAI announces refresh-token rotation, shorter
  access-token TTLs, or rate-limit policy changes on the OAuth endpoint.

The copied-auth upstream reports satisfy the architectural trigger even though
ShipIt has not yet seen a Claude-like every-session outage from Codex. The
answer remains identical to docs/153: one orchestrator-owned refresh source,
then repush the rotated token into pinned sessions.

## What changes from docs/153

Same scheduler / single-flight / per-account isolation / file-state delta
detection / debug-log classification. The Codex-specific pieces follow. Items 3
and 5 are the first design; "On-demand refresh, real rejections, harvest"
below replaced them in 2026-10.

The terminal source-state semantics do not change: an existing account with a
missing or unparseable `auth.json` is marked `auth_failed` through the same
account-qualified persistence and SSE path as revocation. Repeated probes are
deduplicated, and a later account-scoped `auth_complete` restores the row,
re-pushes credentials, and rearms refresh even when the healthy token does not
rotate during the status probe. This is shared behavior because both providers
use copied account credential sources and the same subscription route selector.

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

### 3. CLI commands (first design, replaced in 2026-10)

The Claude refresher uses:

- **Tier 1**: `claude auth status --json` (designed for scripted use; may or
  may not trigger refresh-on-use; refresher discovers at runtime via file-state
  delta).
- **Tier 2**: `claude --print "ok" --model claude-haiku-4-5-20251001 --tools "" --no-session-persistence`
  (billable, structurally guaranteed to trigger refresh-on-use).

Codex's pinned `0.133.0` CLI exposes:

- **Tier 1**: `codex login status` (verified cheap status probe; did not mutate
  a healthy `auth.json` during local verification).
- **Tier 2**: `codex exec --skip-git-repo-check "ok"` (minimal real run; expected
  to exercise refresh-on-use when the access token is near expiry).

The two-tier shape (free preferred, billable fallback) carries over. The
runtime discovery (file-state delta as the success signal) carries over.

### 4. CLI binary path / env

The orchestrator's Dockerfile installs `codex` at the same level as `claude`
(see `docker/agent-cli/package.json` — `@openai/codex` is pinned). Spawn with
`HOME=<accountRoot>` so the CLI reads/writes the *account's*
`/credentials/provider-accounts/codex/<accountId>/.codex/auth.json` directly.

### 5. Failure classification (first design, replaced in 2026-10)

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

- **The per-account failover that consumes the unauthenticated SSE event.**
  Owned by docs/150 (multiple provider subscriptions). Both Claude and Codex
  hooks feed into the same failover layer.

## Pointer

- docs/153 plan: `../153-orchestrator-owned-claude-oauth-refresh/plan.md`
- Claude refresher implementation: `src/server/orchestrator/agents/claude/oauth-refresher.ts`
- Codex refresher implementation: `src/server/orchestrator/agents/codex/oauth-refresher.ts`
- Codex sync code (already in place):
  - `readCodexTokenFreshness` in `src/server/orchestrator/token-sync-manager.ts`
  - `syncProviderAccountTokenIn` / `syncProviderAccountTokenBack` /
    `repushProviderAccountToken` — already account-aware for Codex
- Codex CLI install: `docker/agent-cli/package.json`

## Implemented notes

The Codex refresher mirrors docs/153's scheduler/single-flight/backoff shape
and is wired in `src/server/orchestrator/bootstrap-managers.ts` beside the
Claude refresher. It runs only in containerized runtime, iterates Codex provider
accounts, refreshes with `HOME=<accountRoot>`, repushes rotated account tokens
to pinned Codex sessions, and emits:

- `codex_account_unauthenticated` / `codex_account_authenticated`
- unified `agent_auth_failed` with `{ loginId: "openai-chatgpt", accountId, reason }`

The first implementation used two commands, `codex login status` (Tier 1) and
`codex exec --skip-git-repo-check "ok"` (Tier 2), and matched `invalid_grant` in
their output. The next section says why that did not work and what replaced it.

## On-demand refresh, real rejections, harvest (2026-10 fix)

An audit against the docs/153 fixes measured Codex CLI 0.159.2 offline, with
synthetic tokens and a local stand-in for `auth.openai.com` and `chatgpt.com`.
Nothing reached OpenAI, and **no real grant was tested against the real OAuth
server**:

| The CLI was given | What it did |
|---|---|
| `codex login status`; any token, also an expired one | no request to the token host |
| `codex exec … ok`; 30, 20, 10 or 5.3 minutes left on the access token's JWT `exp` | a model call, no refresh |
| the same; 4.3 or 3 minutes left, or an expired token | `POST auth.openai.com/oauth/token`, an ordinary `refresh_token` grant, before the model call |
| the same; `last_refresh` 9 or 30 days old, `exp` far away | no refresh: the age of `last_refresh` has no effect |
| the model API answers 401 | the same refresh, then the call again |
| the token host answers 200 | rewrites `$CODEX_HOME/auth.json` in place, with a new `last_refresh` |
| the token host answers 401 `refresh_token_reused`, `refresh_token_invalidated` or `refresh_token_expired`, 400 `invalid_grant`, 429 or 500 | leaves `auth.json` unchanged. It does not blank the file, as the Claude CLI does |
| `codex exec`, and the token host answers 429 or 500 | 52 to 74 token requests in one run |
| `codex app-server`: `initialize`, then `account/read {"refreshToken": true}` | one refresh request at any time before expiry, no model call, about 0.25 s; the file is written before the answer |
| the same, and `auth.json` was replaced after the CLI read it | no request: the CLI reads the file again first, and keeps the newer credential |

The refresh tokens are single-use: `refresh_token_reused` is what the CLI is
told when another copy of the credential spent the grant first.

What followed from that for the first implementation:

- **No tick could rotate before the last 5 minutes.** The ticks came at about
  T-45, -44, -39, -24 and -9 minutes. Tier 1 never refreshes. Tier 2 was a full
  model call each time and did not refresh either. The next tick was after
  expiry, so the last 5 minutes belonged to the session CLIs, which race each
  other for a single-use grant. Inside the 45 minutes each turn start also ran
  both tiers.
- **A rejected grant was never reported.** The CLI prints "your refresh token
  was already used / was revoked / has expired" and none of the phrases the
  refresher matched, so the account stayed "ready" and the tick was repeated every
  15 minutes with no end. The `429` test was a substring test over all output, and
  a log timestamp such as `17:20:52.178429Z` satisfied it.
- **No harvest.** A session rotation that did not get to the source (the
  write-back watches are in memory, and an orchestrator restart drops them) left
  the source with a spent grant.
- **A forced heal could not succeed on a healthy source.** It needed a changed
  token, and the probes could not rotate a token with time left. After a
  session's 401 with a stale copy, the turn ended with an authentication error.

### What a tick does now

1. **Harvest before spend** (`harvestSessionRotations`), as in docs/153
   "Rotations between turns: harvest before spend": for each per-session subtree
   whose account marker names this account and whose `auth.json` physically
   resolves inside the subtree, a copy that is ahead of the source is published
   through `syncProviderAccountTokenBack` (`sessionOwnRoute: true`). A harvest is
   the rotation: the tick ends `harvested_session` on the normal success path,
   and the repush carries the token to the other pinned sessions.
2. **Missing source** → `missing_credentials`, unchanged.
3. **A grant that is known rejected** (see below) → `revoked`, and no CLI.
4. **Outside the 45-minute margin and not forced** → `noop`, and no CLI. The old
   Tier 1 "status probe" is gone; it proved nothing.
5. **One on-demand refresh** (`refreshOnDemand`): `codex app-server`, then
   `initialize`, `initialized` and `account/read {"refreshToken": true}`
   (`CODEX_REFRESH_MESSAGES`). The CLI's `HOME` and working directory are the
   account root, with an explicit `CODEX_HOME=<accountRoot>/.codex` and without
   `CODEX_API_KEY`: an inherited `CODEX_HOME` makes the CLI ignore `HOME`, and
   with `CODEX_API_KEY` the CLI's model calls use the key. When the answer
   arrives the refresher closes the CLI's input and waits for the CLI's pipes to
   close before it reads the file and the log: the line that names a refusal can
   arrive after the exit. It waits 30 s for the answer and 5 s for the end, and
   then kills the process tree. Only the ids of the answers are read: they carry
   the account's email, and none is kept.
6. **Success** is the file: the source holds tokens, and its freshness advanced
   or the tokens are new → `rotated`.

The account root, and not a private copy as for Claude: the Codex CLI leaves a
refused credential in place, so there is nothing to protect the source from, and
a copy would add the window in which a rotation exists only in the copy.

### A rejected grant

Only the token host's answer to the refresh counts
(`classifyCodexRefreshOutput`). The refresher reads the CLI's line
`Failed to refresh token status=<status> … error_code: Some("<code>")`, after
it removed the color codes that split `status=401`. Four codes are a rejected
grant: `refresh_token_reused`, `refresh_token_invalidated`,
`refresh_token_expired` and `invalid_grant`. Another 401 from the token host
(`invalid_client`, or no code), a 401 from the model API, a timeout, a 429 and a
500 are not. The messages that `codex exec` prints for the first three codes
are accepted too.

- `refresh_token_invalidated` and `refresh_token_expired`: the server judged the
  grant itself. The tick reports `revoked` at once.
- `refresh_token_reused` and `invalid_grant`: another copy can hold the
  successor. The tick waits 5 s (`LATE_ROTATION_WAIT_MS`), because the session
  CLI that won the grant writes its rotation only after the server answered it,
  and then harvests again. A session rotation found there ends the tick
  `harvested_session`.
- For every rejection: if the source holds another credential by then (a
  sign-in, or a rotation that the write-back watch published), the tick concludes
  nothing and a new tick runs at once.
- Otherwise the outcome is `revoked`, and the refresher remembers the rejected
  credential (`rejectedIdentity`, a hash of its two tokens, in memory). The CLI
  leaves that credential in the file with its expiry in the future, so without
  the memory the next tick would read it as healthy and report the account
  signed in again, and each forced heal would spend the dead grant again. A new
  sign-in or a session's rotation changes the source's tokens, and the memory no
  longer applies.

### Failures that can pass, and what the log says

A 429 is read from the refresh's status only. `rate_limited` and
`unknown_failure` keep their sentences and now end with `reason="…"`: at most
three lines of the CLI's stderr, each capped, redacted by
`summarizeRefreshFailure` (docs/153, "Say what failed"), after an email
address in them was replaced with `[email]`. `reason` in the result is that same
text; it used to be the first 200 raw characters of the output. `[timeout]`,
`[no-reply]` (the CLI ended before it answered) and `[rpc-error]` (the CLI
refused `account/read`; only the error's number is kept, because its text comes
from the CLI and can name the account) name what the refresher itself saw, as
do `[spawn-failed]` and `[error]`. A missing binary reads `[error] the codex
binary was not found`: the shared summary drops every line that says `ENOENT`.
`rotated_tier1` and `rotated_tier2` are gone: the outcomes are `rotated`,
`harvested_session`, `noop`, `rate_limited`, `revoked (<code>)`,
`unknown_failure` and `missing_credentials`.

### Turn start and forced heal

- A **turn start** (`ensureFresh`) returns at once for a token outside the
  margin. Inside the margin it runs (or joins) a tick, which is the one request
  the schedule would send. It never runs one while a backoff is in force: the
  schedule owns that retry, and the answer is then only whether the token is
  still valid. A grant that is known rejected gives `false` without a CLI.
- A **forced heal** (a session's 401) runs a tick whatever the expiry says, and
  that tick is one on-demand refresh. It asks for evidence, because time left on
  a token proves nothing after a 401: the heal succeeds when the tick ended
  `rotated` or `harvested_session` (also for a call that joined the tick after
  it wrote its rotation), or when the source holds another credential than
  before the call (a sign-in, or a rotation published during the wait), and
  that credential is not expired. The caller then repushes the source to the
  session and runs the turn again. A rejected grant is not healed, whatever its
  expiry says. A forced refresh that got no answer (a 429, a timeout) is not
  healed either, as before this fix. It leaves a token with time left on its
  expiry schedule, and counts no failure.

### Validation

`node --import tsx scripts/probe-codex-refresh.mjs` runs the installed binary
with synthetic tokens, an isolated home and working directory, and a local TLS
recorder that never forwards traffic. It runs the refresher's own tick
(`CodexOAuthRefresher`) against the binary, and checks what the refresher
depends on: the call rotates a token at the start of the margin and one that has
days left, with one grant and no model call; each of the three refusal codes
ends `revoked` and leaves the file as it was; a 429 and a 500 end `rate_limited`
and `unknown_failure` after one request; a credential published during the call
is kept; and a session's own CLI (`codex exec`) refreshes only inside its
5-minute window. 16 checks, about 17 s, exit 1 on a failure. CI runs it as the
job `codex-refresh-probe` (`.github/workflows/ci.yml`) on a pull request that
changes `docker/agent-cli/package.json`, its lockfile or `install-agent-clis.sh`,
the probe, the refresher or the workflow, and on every push to `main`. The job
installs the CLI with the images' own `install-agent-clis.sh`
(`SHIPIT_HARNESSES=codex`), gets no secret, and is not a required check.

### Known limits

- **Not tested against the real token host.** That the server answers a spent
  grant with 401 and `refresh_token_reused` comes from the CLI's own handling of
  that answer, not from a real request.
- **The refresh depends on CLI behaviors that the CLI does not document as a
  contract**: `account/read` with `refreshToken`, the status line's format, and
  that a refused credential stays in the file. A CLI that stops printing the
  status line makes a rejected grant read as `unknown_failure` again. The probe
  checks all three on every change to the pin; a red run blocks a merge only if
  the branch protection names the job.
- **The CLI runs in the account root.** A CLI version that destroyed the file on
  a refusal would destroy the account's only copy; the probe checks that it does
  not. `app-server` also writes its own state files into the account's `.codex`,
  and at its start it asks `chatgpt.com` for model and plugin lists with the
  account's token.
- **A forced heal spends one refresh request** unless a harvest or a known
  rejection ends its tick first, also when the source's token was rotated a
  moment ago. Forced heals of one account share a tick while it runs, and run
  one after the other otherwise.
- **A forced heal that gets no answer fails the turn** (or moves it to the next
  account), also when a repush of the unchanged source would have been enough.
  The refresher cannot tell that case from a dead source.
- **The harvest orders credentials by the access token's `exp`**, as the
  write-back does (`readCodexTokenFreshness`). A session rotation whose `exp` is
  not later than the source's is not seen as newer. The refresher's own rotation
  does not have this limit: new tokens in the source are a rotation.
- **The late harvest waits 5 s, not until a session's rotation is on disk**, as
  in docs/153 Known limits.
- **A CLI that survives the kill is not waited for.** After a timeout the
  process tree is killed, and 5 s later the tick goes on without the exit, as in
  the Claude refresher. Such a CLI can still write the file after the tick read
  it.
- **A session rotation that the write-back watch missed is found at the next
  tick**: at the start of the margin, at a forced heal, or at a sign-in nudge.
  Until then a session that copies the source gets a spent grant, and its 401
  is what brings the tick.
- **Whether a resident `codex app-server` refreshes with no turn in progress**
  was not measured. For Claude this was seen in production.

### Key files (2026-10)

- `src/server/orchestrator/agents/codex/oauth-refresher.ts` — `refreshOnDemand`,
  `classifyCodexRefreshOutput`, `harvestSessionRotations`, `rejectedIdentity`,
  `retryNotBefore`, `ensureFresh`.
- `src/server/orchestrator/agents/codex/oauth-refresher.test.ts` — the fake
  speaks the app-server's side of the exchange; refusals use the CLI's real
  lines.
- `scripts/probe-codex-refresh.mjs`, and the `codex-refresh-probe` job in
  `.github/workflows/ci.yml`.
- `src/server/orchestrator/agents/claude/oauth-refresher.ts` —
  `summarizeRefreshFailure`, shared for the redacted reason.
