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
it removed the color codes that split `status=401` and the timestamp at the
start of each line. Each line is read alone. Only spaces and tabs can stand
before the timestamp that is removed: a rule that crossed lines read a run of
blank lines once per line, and on the refresher's path (the strip runs at the
CLI's end and again in the classifier) 128 000 newlines took about 20 s on the
orchestrator's main thread, now about 10 ms. Blank lines before a timestamp now
stay; neither the classifier nor the summary reads a blank line. Other
whitespace before a timestamp (`\v`, a no-break space) now keeps the timestamp
in the reason; the classifier reads no timestamp. In CR LF text
the old rule also removed the LF before each timestamp line, so the classifier
read a phrase and a code from two lines as one line. CLI 0.159.2 writes LF only.
Four codes are a rejected
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
  longer applies. If an outside writer puts the rejected file back while a
  refresh of the new credential runs, the tick does not read it as a rotation,
  and the memory stays.

### Failures that can pass, and what the log says

A 429 is read from the refresh's status only. `rate_limited` and
`unknown_failure` keep their sentences and now end with `reason="…"`: at most
three lines of the CLI's stderr, each capped, redacted by
`summarizeRefreshFailure` (docs/153, "Say what failed"), after an email
address in them was replaced with `[email]`. The summary replaces an address
too (since 2026-10-12); the refresher keeps its own replacement, because
`classifyCodexRefreshOutput` reads the same text and its answers must not
move (`status=429@example.com` is no 429). `reason` in the result is that same
text; it used to be the first 200 raw characters of the output. `[timeout]`,
`[no-reply]` (the CLI ended before it answered) and `[rpc-error]` (the CLI
refused `account/read`; only the error's number is kept, because its text comes
from the CLI and can name the account) name what the refresher itself saw, as
do `[spawn-failed]` and `[error]`. A CLI that did not start reads `[error]
spawn codex ENOENT`: the shared summary drops the CLI's lines that say `ENOENT`
and keeps the refresher's own notes (docs/153, "Outcomes and logs"). Node gives
that error for a missing binary and also for a missing account root, which is
the CLI's working directory.
`rotated_tier1` and `rotated_tier2` are gone: the outcomes are `rotated`,
`harvested_session`, `noop`, `rate_limited`, `revoked (<code>)`,
`unknown_failure` and `missing_credentials`.

### The revoked line, and the account's row (2026-10-13)

Two fixes of the Claude refresher (docs/153-orchestrator-owned-claude-oauth-refresh, "The
revoked line" and "A sign-in is not the harvest's to complete") were missing here. Both
gaps were present in this refresher.

**The line.** `revoked (<code>) — emitting auth_required` was the whole line. It keeps
that sentence, and the first line for a rejected grant continues with what ran:

```
… — emitting auth_required trigger=scheduled verdict=token_host_code refresh=0.2s,exit=0 expires_in=40m reason="…"
```

- `trigger`: `scheduled` (the expiry timer), `backoff_retry`, `turn_start`, `forced_heal` (a
  session reported an auth failure) or `nudge` (`refreshNow`: a completed sign-in, or an
  auth-required report). A caller that joins a tick in flight is reported under the
  trigger that started it.
- `verdict`: `token_host_code`, the token host's answer to this tick's refresh, as the
  CLI's line gave it.
- `refresh`: the run time of `codex app-server`, then `timeout` if the refresher killed it
  (no answer in 30 s, or no end within 5 s of the answer), then `exit=<code or signal>`,
  or `no_exit` when the CLI did not start or did not end within the grace after the kill.
- `expires_in`: what the source token had left, in minutes, negative when it is expired.
  It is the value that the refresher schedules by (`readCodexTokenFreshness`). For a
  file whose expiry cannot be read that is the time of the last refresh, so the number
  is negative.
- `reason`: the redacted summary that the other failure lines carry. The account's
  tokens are JWTs, and the summary removes a JWT whole since 2026-10-13: before, it
  removed each long run, so a short segment stayed (docs/153, "Say what failed"). The
  code is in the parentheses, and the reason can lose it: a line is cut at 96
  characters, and the summary reads `refresh_token_invalidated` (25 characters) as a
  long token.

Each later tick on the same grant logs the sentence with `trigger=… verdict=known_rejected`
and nothing more, so `grep 'revoked (' | grep -v known_rejected` gives the first line, as
for Claude.

**The row.** The refresher announced an account once and then stayed silent until a
success (`emittedUnauthenticated`).

- *It reports again when the row reads `ready`.* A completed sign-in sets the row
  `ready` (`wireEventHandlers`), and so does a cancelled one that finds a credential
  file (`ProviderAccountManager.cancelAccountAuth`), with no word to the refresher. Only
  a tick clears the announcement: a success, or a healthy source. In containerized mode
  such a tick follows a completed sign-in. In local mode it does not (`refreshNow` with
  no account does nothing there, while `ensureFresh` still runs ticks), so the
  announcement of an earlier rejection stayed set, and a later rejection of the new
  credential changed nothing: the row stayed `ready` over a dead credential. That is the
  one path found for this refresher. The path that the Claude fix was made for, a
  sign-in reported complete over the rejected credential, is not known here, because
  the Codex sign-in is complete only when its login CLI ends. The rule costs one read of
  the row, and it holds for every writer of the row.
- *A tick that finds the source missing while the row reads `authenticating` reports
  nothing* (`missing_credentials — waiting for auth_complete sign_in=in_progress`).
  `codex login --device-auth` removes `auth.json` at its start (measured offline on CLI
  0.159.2, 2026-10-13: the file is gone within 0.5 s, before the CLI's first request is
  answered), so the source is missing for the whole sign-in, as for Claude. A nudge
  ticks every account (each Codex `auth_required` report sends one). For an account
  that the refresher had not announced before, its `agent_auth_failed` event closed the
  sign-in that the user was in and set the row `auth_failed` while the login CLI still
  ran. The sign-in reports its own outcome.

### Turn start and forced heal

- A **turn start** (`ensureFresh`) returns at once for a token outside the
  margin. Inside the margin it runs (or joins) a tick, which is the one request
  the schedule would send. It never runs one while a backoff is in force: the
  schedule owns that retry, and the answer is then only whether the token is
  still valid. A grant that is known rejected gives `false` without a CLI.
- A **forced heal** (a session's 401) runs a tick whatever the expiry says, or
  joins the tick in flight. Its own tick is one on-demand refresh; a tick that
  it joins can be one that had nothing to do. The heal fails for a rejected
  grant (whatever its expiry says, and also when the source holds a
  known-rejected credential again at the end), for a source that is missing or
  cannot be read, for an expired token, and for a file that holds no token.
  Every other result heals: `recoverAuth` (`turn-executor.ts`) then pushes the
  source credential to the session and runs an ordinary turn again, once. An
  adopted turn gets the push and ends with no second run.
- **No verdict heals too** (decided 2026-10-12; before, it did not). A forced
  refresh that got no answer (a 429, a 5xx, a timeout, a CLI that did not start)
  ends `rate_limited` or `unknown_failure`, and the heal succeeds. For a token
  outside the 45-minute margin the log says `<outcome> on a forced refresh — no
  verdict on the token, expiry schedule kept reason="…"`, and no failure is
  counted. Inside the margin the failure is counted and backs off as one of the
  schedule's does, and its sentence gets `, forced refresh: no verdict on the
  token` in front of the reason. The reason for the rule: "not healed" told the
  user that a healthy account must sign in again (or lost the turn, with one
  account), also when the session only held a stale copy. "Healed" costs at
  most one more attempt, because `recoverAuth` allows one. The Claude refresher
  has the same rule (docs/153, Known limits).

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
  one after the other otherwise. A forced heal that joins a tick in flight
  sends no request of its own, and none at all if that tick had nothing to do.
- **A forced heal that joins a tick gets that tick's log line.** If the tick
  was not forced and fails, its sentence does not say "forced" or "no verdict",
  although the heal succeeds by the same rule.
- **A forced heal with no verdict can be wrong.** The refresher cannot tell a
  session's stale copy from a dead source when the token host does not answer.
  If the source is dead, the second run fails as the first did and the user
  sees the sign-in. That run is the turn's one recovery, so with more than one
  account this turn does not move to the next account. Under a 429 from the
  token host, the session's Codex CLI can send its own refresh requests again
  in the second run (measured offline: 52 to 74 requests in one `codex exec`
  run on a 429 or a 500).
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
- **That the login CLI removes `auth.json` at its start was measured on CLI 0.159.2
  only**, and the probe script does not check it. With a login CLI that kept the file,
  the source would be present during a sign-in, and a tick that found its grant
  rejected then would report the account and close the sign-in.

### Key files (2026-10)

- `src/server/orchestrator/agents/codex/oauth-refresher.ts` — `refreshOnDemand`,
  `classifyCodexRefreshOutput`, `harvestSessionRotations`, `rejectedIdentity`,
  `retryNotBefore`, `ensureFresh`; since 2026-10-13 `RefreshRun`, the detail in
  `handleRevoked`, and `accountStatus` in `emitUnauthenticated` and `executeTick`.
- `src/server/orchestrator/agents/codex/oauth-refresher.test.ts` — the fake
  speaks the app-server's side of the exchange; refusals use the CLI's real
  lines. The rig's account row follows the refresher's events, as the orchestrator
  wires it.
- `scripts/probe-codex-refresh.mjs`, and the `codex-refresh-probe` job in
  `.github/workflows/ci.yml`.
- `src/server/orchestrator/agents/claude/oauth-refresher.ts` —
  `summarizeRefreshFailure`, shared for the redacted reason; `describeCliRun` and
  `TickTrigger`, shared for the revoked line.
