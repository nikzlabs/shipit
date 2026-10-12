---
issue: planning#225
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
as a child process and let the CLI handle the OAuth dance. Since 2026-10 the CLI runs
against a **private copy** of the source credentials file, and the refresher installs the
result into the source — see [Probe a private copy](#probe-a-private-copy-with-a-short-claimed-life-2026-10-fix).
Rationale:

- Anthropic owns the OAuth contract — endpoint URL, client_id, request shape, error
  handling, token rotation specifics. They keep the CLI working when they change those.
- The CLI is lockfile-pinned in `docker/agent-cli/package-lock.json` (currently
  `@anthropic-ai/claude-code@2.1.140`), bumped by Renovate with a cooldown gate. We
  inherit deterministic, version-controlled OAuth behavior for free.
- Less attack surface in our own code — no hand-rolled HTTP client, no client_id
  baked into ShipIt source, no schema assumptions to maintain.

### Two-tier command, defensive

The CLI exposes `claude auth status --json` (Tier 1 — designed for scripted use, no
prompt arg, no model, structurally cannot make a billable conversation API call). The
original open question — does `auth status` trigger an OAuth refresh, or only read
stored state — is answered (measured on CLI 2.1.284, 2026-10-11): it refreshes, but
**only when the credentials file says 5 minutes or less are left**. The same rule
governs Tier 2. So Tier 1 was taken for the path that normally rotates, at no cost.
Measured again on 2026-10-12, it is not: Tier 1 sends the refresh grant and exits
before the token host can answer. Since then Tier 1 runs only on a copy that the CLI
will not refresh (a forced probe of a healthy token), and Tier 2 is the only tier that
sends the grant — see [Tier 1 does not present the grant](#tier-1-does-not-present-the-grant-2026-10-12-fix).

The rotation is done by the cheapest billable form:

```
claude --print "ok" --model claude-haiku-4-5-20251001 --tools "" --no-session-persistence
```

This forces Haiku (cheapest model), disables tool loop, suppresses session persistence,
and uses a minimum-token prompt. Cost: <$0.001 per invocation, once per rotation
(about every 7 h 15 min per account), which is what production paid already.

### Refresh-tick state machine

```
on tick (single-flight via in-process mutex; `force` = a session reported a 401):
  harvest: a pinned session holds a newer token → adopt it, repush, return HARVESTED_SESSION
           (never into a source that is missing, and never the credential known rejected)
  a rotation from an earlier tick is not in the source yet → install it; while it waits,
                                                     no tick probes
  before := source expiresAt                       (none → MISSING_CREDENTIALS)
  the source's grant is already known rejected     → REVOKED, no CLI spawn

  if before > now + safetyMargin and not force:
    schedule next at before - safetyMargin
    return NOOP                                    (no CLI spawn)

  copy := private HOME holding a copy of the source credentials file
          near expiry: the copy claims min(before, now + 60s), inside the CLI's window
          forced on a healthy token: the copy keeps the real expiry

  only if the copy claims more than 5.5 minutes (a forced probe of a healthy token):
    spawn `claude --debug api --debug-file <f> auth status --json` with HOME=<copy>, timeout 30s
    the copy holds a new token → install it into the source, repush, return SUCCESS_TIER1
    the copy is blanked        → the OAuth server answered invalid_grant; skip tier 2

  spawn `claude --debug api --debug-file <f> --print "ok" --model claude-haiku-4-5-20251001 ...`
        with HOME=<copy>, timeout 60s
  the copy holds a new token → install it into the source, repush, return SUCCESS_TIER2

  the new token cannot be written to the source, or the source cannot be read
                                                   → keep the copy, short backoff
  the source holds another token than the copy was made from → conclude nothing, tick again
  invalid_grant (blanked copy, or named in the output):
    harvest again; a session that spent the grant first → HARVESTED_SESSION
    else remember the grant as rejected, emit "auth_required", schedule nothing → REVOKED
  forced on a healthy token, no grant rejection found → NOOP
  429-shaped signal → backoff (2m → 5m → 10m → 30m, cap 30m)          → RATE_LIMITED
  source token still valid → short backoff, log the time left          → NOT_ROTATED
  source token expired     → short backoff, log loudly                 → UNKNOWN_FAILURE

  a backoff that would step over the last chance is cut short to it: 7 minutes before
  expiry (the CLI's 5-minute window, plus 2 minutes for both tier timeouts and their kill
  grace), the last moment to rotate ahead of the sessions
  the copy is deleted when the tick ends, unless it holds a rotation that is not installed
```

`safetyMargin` = **45 minutes** (fixed, not env-tunable). The margin is when the tick
fires; it is the copy's short claimed life, not the margin, that makes the CLI refresh
— the CLI's own "near expiry" rule is 5 minutes and no lead time changes it. Recovery
from extended orchestrator downtime is independent (when start() runs against an
already-expired source, a refresh tick is scheduled immediately).

A **turn start** (`ensureFresh`) runs a tick only inside those last 7 minutes, when the
token is expired, or when its grant is known rejected (that tick spawns nothing) — and
never while a backoff is in force: the first turn start gets its attempt, and the ones
after it leave the retry to the schedule. Under a 429 each further attempt is one more
request to the endpoint that is already limiting. Earlier in the margin the schedule
owns the retries: a turn start cannot do better than the schedule, and when each turn
start ran its own tick it paid for a billable Tier 2 call and about 5.5 s per turn, and
re-armed the backoff from "now", which moved the scheduled retry later.

### Single-flight

In-process `Promise<RefreshResult>` mutex. Any caller — scheduled tick, on-demand
`refreshNow()`, or the on-`auth_required` synchronous repair — awaits the in-flight
promise if one exists, never starts a parallel attempt. Because there is only one
orchestrator process per host, this fully serializes refresh.

### Failure classification: only `invalid_grant` means revoked (2026-07 fix)

The original implementation classified generic 401 phrases (`unauthorized`,
`authentication_error`, `invalid authentication credentials`) as **revoked** — flip the
account to "needs sign-in", broadcast `agent_auth_failed reason:revoked`, stop
scheduling. That was wrong, and it was the cause of the "Claude logs out every day"
symptom that persisted after this design shipped:

- Once the access token is past expiry (a routine, recurring state — the tier-1-noop →
  generic-backoff cadence regularly overshoots expiry by a few minutes), **every**
  tier-2 run's first API attempt 401s, and `--debug api` captures that
  `authentication_error` response verbatim *before* refresh-on-use fires.
- If the refresh then fails *transiently* (OAuth endpoint 429, the 60s tier-2 timeout,
  a network blip), the tick ends with no rotation and a combined output full of 401
  phrases → misclassified as revoked → user signed out, schedule stopped.
- The Codex refresher only ever matched `invalid_grant` / `invalid_refresh_token`,
  which is why Codex never exhibited the daily logout.

`TERMINAL_AUTH_FAILURE_PATTERNS` is now narrowed to the `invalid_grant` family — the
only signal where the OAuth server actually evaluated and rejected the refresh token.
Everything else (including expired-token 401s) falls through to `rate_limited`,
`not_rotated` or `unknown_failure`, which back off and retry until the transient
clears. Regression tests: `oauth-refresher.test.ts` ("401 … unknown_failure (NOT
revoked)", "expired-token 401 + refresh 429 as rate_limited").

**Where the `invalid_grant` signal comes from changed in 2026-10.** This section
assumed that a genuine revocation names itself in the debug capture. CLI 2.1.284 does
not: its capture says only `OAuth refresh failed (expected): Request failed with status
code 400`. What the CLI does do on `invalid_grant`, and on nothing else, is blank the
credentials file it runs against. The refresher therefore reads a **blanked probe
copy** as `invalid_grant` (and still accepts the phrase in the output, for a CLI that
prints it). Before the private copy, the same blanking hit the account's real file, and
the revocation surfaced one tick later as `missing_credentials source=blanked`.

### Missing source credentials are terminal account state (2026-08 fix)

An existing account whose `.credentials.json` is absent or unparseable cannot
run a turn and cannot be repaired by another refresh tick. The refresher marks
that exact account unauthenticated through the same persisted-account and SSE
path as a revoked refresh token, with `reason: "missing_credentials"`. The
per-account latch makes repeated ticks and forced probes idempotent. Routing
then excludes the `auth_failed` account and the next turn selects another ready
Anthropic subscription account; it never changes the billing mode to an API
key. The already-failed turn is not replayed by this background transition.

After account-scoped sign-in writes a healthy source, the `auth_complete` nudge
rearms the schedule. A healthy tier-1 probe clears the latch even when the CLI
does not rotate the new token, restores the row to `ready`, re-pushes the source
to pinned sessions, and clears stale Settings and model-selector state.

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

### Publication latency: a rotation must reach the source mid-turn (2026-08 fix)

Moving refresh ownership to the orchestrator removed the *stampede*. It did not
remove the case where a session CLI rotates anyway — and when that happens, the
write-back path was too slow.

`syncAgentTokenBack` ran from exactly two places: `finalizeSessionAgentEnvironment`
(turn end) and sub-agent teardown. So a rotation performed by a session's CLI at
minute 1 of a twelve-minute turn stayed private to that session for eleven
minutes, while the rotating refresh token it replaced was already invalid
upstream. Every other session that started a turn in that window ran
`syncAgentTokenIn`, pulled the dead source token, and 401'd with
"Not logged in · Please run /login". With ~12 concurrent agent containers on one
provider account, a single mid-turn rotation could poison every session that
started during the rest of that turn. This was the widest stale window left in
the credential design (production incident, 2026-08-02).

The fix is publication timing only, in `session-token-publisher.ts`:

- While a turn is running, the session's token file(s) are watched with
  `fs.watchFile` (stat polling, 3 s). Stat polling rather than `fs.watch`
  because the file is written by a *different container* into a shared Docker
  volume and replaced by atomic rename — path-based polling sees both the
  in-place rewrite and the rename-over with no inode-identity failure mode and
  no dependency on inotify events crossing the mount.
- On a detected change, a 750 ms debounce, then the **existing**
  `syncAgentTokenBack` / `syncProviderAccountTokenBack` — unchanged, expiry
  guard included. A session that FAILED to refresh still cannot clobber a
  fresher source.
- `sessionTokenIsAheadOfSource` (a read-only twin of that same guard, exported
  from `token-sync-manager.ts`) pre-checks before every publish. The CLI
  rewrites `.credentials.json` for reasons other than rotation — the `mcpOAuth`
  key churns during a turn — and without the pre-check each of those would
  drive a sync-back whose *copy* is guarded away but whose trailing recursive
  `chownSessionCredentialsTree` is not. Debounce + pre-check is what keeps this
  from becoming a write storm.
- The watch also publishes once at arm time. `fs.watchFile` takes its baseline
  stat asynchronously, so a write landing in that window would otherwise be
  invisible forever; the same pass recovers a rotation stranded by a previous
  turn whose finalize never ran.

Lifecycle — armed in `prepareSessionAgentEnvironment` gated on
`enforceAccountRouting`, which is precisely the flag marking the turn's own
pre-spawn step (the service-level warm-ups run before any turn exists and are
followed moments later by the executor's own call). Torn down by
`finalizeSessionAgentEnvironment` **when no agent process survives the turn**,
so the turn-end sync-back is then the authoritative final publication, and by
the runner's `disposed` event otherwise. (Originally torn down unconditionally
at turn end; see [Rotations between
turns](#rotations-between-turns-harvest-before-spend-2026-08-21-fix) for why
that was wrong.) Route branching mirrors the sync-in exactly: account routes
publish to that account's credential root, and the reserved `claude-env-oauth`
route is skipped.

Nothing here is awaited by turn execution and every failure is logged and
swallowed — credential syncing must never block or fail a turn.

Scope note: this addresses publication **latency**. The separate gap that the
`TOKEN_FRESHNESS` guards key off `expiresAt`, which tracks ordering but cannot
detect *revocation*, is not addressed here.

### Rotations between turns: harvest before spend (2026-08-21 fix)

Tracked as planning#462.

The design above rests on an assumption stated most plainly in the
`SAFETY_MARGIN_MS` docstring: the orchestrator's 45-minute lead means "sessions
never trigger their own refresh". That was true of a session **under a turn**.
It stopped being true of anything once agent processes became **resident** — a
streaming `claude --print --input-format stream-json` process outlives its turn
by hours (that is what live steering is) and refreshes on its own clock, with no
turn in view. No lead time the orchestrator picks can preempt a process that is
not racing it.

Because Anthropic's refresh tokens are **single-use**, one such rotation leaves
the account root holding a grant the OAuth server has already spent. Every later
tick is then doomed, and the tier-2 spend is not merely wasted: the CLI responds
to it by **blanking** the account's credentials file — same path, every token
replaced with `""` and `expiresAt: 0` — which the next tick reads as
`missing_credentials`, flipping the account to "needs sign-in". Roughly daily,
per account. (Since 2026-10 the CLI runs against a private copy, so what it
blanks is the copy; the harvest stays, because it is what finds the live grant.)

Production, 2026-08-21, account `acct_1a27edec…` (all times UTC):

| | |
|---|---|
| 16:54 | `rotated_tier2`, propagated to 33 pinned sessions |
| 00:09–00:30 | four scheduled tier-2 ticks, each `unknown_failure` (each a billable Haiku call, each logged with a count and nothing else) |
| 00:45 | `rate_limited` → 30 min backoff; token expires 00:54 with the source still holding refresh token R1 |
| **01:09:04** | session `83fb0c58…` rewrites its own `.credentials.json` with a NEW refresh token R2 — **no turn running**, no log line for that session since 14:14 the previous day, its CLI process alive 17h46m. R1 is now dead upstream. |
| 01:15:35 | the tick spends R1; the CLI blanks the account root file. Logged only as `unknown_failure failure_count=6`. |
| 01:30 | `expiresAt: 0` → `missing_credentials` → reconnect |

Corroborating that it was this path and not the refused-write-back one PR
"planning#445" fixed: zero `write-back=` and zero `[token-publish]` lines for
claude in 48h; every other pinned session still held the 16:54 token; only
`83fb0c58` held a newer one, and its `.shipit-provider-accounts.json` marker
named this account.

Three changes, no new subsystem:

1. **Harvest before spend** (`ClaudeOAuthRefresher.harvestSessionRotations`).
   Every tick begins by reconciling the source with the sessions that share it:
   for each per-session subtree whose docs/260 account **marker** names this
   account, if its copy is ahead of the source, publish it through the ordinary
   `syncProviderAccountTokenBack` — guards, marker check and borrow refusal
   intact, `sessionOwnRoute: true` on the same authority
   `finalizeSessionAgentEnvironment` uses when it falls back to the marker. A
   harvest **is** the rotation: it short-circuits both tiers and runs the normal
   success path, so the adopted token reaches every other pinned session via the
   docs/142 A3 repush. That repush is unconditional, which is safe here only
   because the harvest ran *first* — the source now holds the harvested token,
   so pushing it back onto the session it came from is byte-identical.

   Two conditions select a candidate, answering different questions. The
   **marker**, because token bytes cannot say whose they are, so an unmarked
   subtree or one lent to a sub-agent's account is never read. And
   **containment** — the token file must physically resolve inside its own
   subtree — because a leaked subtree-root symlink (`<sessionDir>/.claude` →
   `/credentials/provider-accounts/…`, the artifact `containerVisibleCredentialPath`
   exists for) makes the session path a second name for some OTHER account's
   root, so reading through one would compare account B's own source against A's
   and copy it in, with no race required. The turn-end write-back has the same
   exposure and is bounded by the leak repair its own turn runs; a tick scans
   every subtree on the disk, including sessions that will never take another
   turn.
2. **The watch's lifetime is the CLI process's, not the turn's.**
   `finalizeSessionAgentEnvironment` stops the write-back watch only when
   `runner.getAgent()` reports no resident process. The process can then end in
   three more ways, and each releases it: `ContainerSessionRunner.setAgent(null)`
   under the existing `!isStreamingActive` guard (a NON-streaming turn's process
   exits at `done`, *after* finalize ran at `agent_result` and saw it installed
   — without this every such turn leaked a poller), `isStreamingActive = false`
   (the resident streaming CLI's genuine exit; every caller has just killed or
   released it), and the runner's `disposed` event. A watch can also outlive the
   container it was armed against, so `startTokenWriteBackWatch` re-arms on a
   **runner** change as well as a route change. Cost while a CLI is resident:
   one `stat` per token file per 3 s — an idle session's file does not change,
   so the poller never schedules a publish.
3. **Say what failed.** `unknown_failure` / `rate_limited` now append
   `reason="…"` to the sentence they have always printed (unchanged, because
   incidents are diagnosed by grepping it). The excerpt prefers lines carrying a
   failure signal and is **redacted** in two layers — credential-bearing headers
   dropped by name (`Basic dXNlcjpwdw==` is short, padded and matches no token
   pattern), then token shapes elsewhere. Its source is the `--debug api`
   capture, so this is the only thing between a bearer token and the log; it is
   a filter and not a parser, which is why the excerpt is also capped and never
   logged in full. `missing_credentials` additionally names
   `source=missing|blanked|unreadable`, because "the user signed out" and "we
   just destroyed a live account's credentials" were previously the same line.
   An email address is replaced with `[email]`: the CLI knows the account's,
   and the excerpt goes to the log. That rule runs after the token shapes,
   because they can take a part of an address, and `[redacted]@example.com`
   must not keep its host; the other order would leave the start of a long
   token that stands in front of a host. Its local part is limited to 64
   pieces: an open one takes quadratic time (128 000 characters with no
   address: 51 ms, against about 37 s). A text of the form `name@1.2.3` or
   `git@github.com:org/repo.git` also reads as an address. The Codex refresher
   replaces an address before this summary as well, for its classifier
   (docs/154).
   What the refresher itself saw is a note in the same text, on a line of its
   own that starts with a lower-case tag: `[error]` and `[spawn-failed]` (the
   CLI did not start), `[timeout]`, `[probe-home-failed]`, `[private-run-open]`
   and `[install-failed]`.

**A blanked source is diagnosed, not repaired.** It parses as a credential, so
the write-back's `unorderable` guard (planning#449) refuses to overwrite it, and
the account needs one reconnect. Deleting it to let a harvest through was built
and then removed: a file this reader believes is empty may be a partial write or
a shape it has not been taught, `expiresAt: 0` is a claim in the file rather
than proof about the account, and there is no compare-and-swap — a repair that
loses a race with a completing sign-in destroys a live credential, to avoid a
reconnect the user is already doing. Harvest-before-spend left the blanking one
trigger: a session that spends the grant between the harvest and the probe. The
2026-10 private copy closes it — the refresher's CLI no longer writes the source
at all — so the trade is a destructive path against a state that should not recur.

**A session's own copy is judged differently — and only a session's copy**
(planning#495). The CLI blanks a session's `.claude/.credentials.json` too: it
is what it writes when its refresh is rejected because a sibling spent the
shared single-use grant first. The same `unorderable` reading then refused the
per-turn **sync-in**, so the session was pinned to an empty credential that the
account's live token was forbidden to replace — permanently, since every
ordinary path back runs through the sync-in that had just refused. Only the
unconditional `repushAgentToken` escape hatch (a manual re-auth, or the docs/179
runtime-401 recovery) could still reach it. Observed in production 2026-09-02 as
a `refused-copy` and a `stranded-rotation` two seconds apart on one session
whose CLI had 401'd two minutes earlier.

So `classifyTokenFreshness` carries a `TokenFileRole`: a `replica` (a session
copy, or a sub-agent spawn home) that `isBlankedClaudeCredential` recognises is
`absent` and gets overwritten; a `source` is classified exactly as before. The
asymmetry is the risk, not the shape — a replica is rebuildable from the source
at any time, while the source is the only copy there is and the one a completing
sign-in writes. The predicate itself is shared with `describeUnusableSource`, so
a probe and a reader cannot come to disagree about one file.

Emptiness is judged on the TOKENS, never on `expiresAt` alone, and across both
levels and both aliases (via `probeNestedString`, the same helper
`extractAccessToken` uses). A credential holding a live bearer anywhere with an
expiry the reader cannot parse is the planning#449 state, stays `unorderable`,
and stays protected — which also matters on the cleanup paths, where an `absent`
reading skips the quarantine and the caller deletes the only copy. Guarded by
`token-freshness-guard.test.ts`.

### Probe a private copy with a short claimed life (2026-10 fix)

Production, build `92a1fc92`, one shared account, 2026-10-10 and 2026-10-11: every
token lifetime logged `unknown_failure failure_count=N — short backoff` five to ten
times, and in 14.5 hours the refresher logged no `rotated_tier1`, `rotated_tier2` or
`harvested_session`. Each token was rotated instead by a session's own CLI, 4.9 and
about 1.3 minutes before expiry, after which other sessions on the account had their
agents killed for auth recovery.

This design assumed that an authenticated CLI call triggers refresh-on-use. Measured
on CLI 2.1.284 — offline, with fabricated credentials and a local stand-in for the
token host, so nothing reached Anthropic and **no real grant was tested against the
real OAuth server**:

| The CLI was given | What it did |
|---|---|
| `auth status --json`; the file says 45, 10 or 5.5 minutes are left | no request to the token host |
| the same; the file says 4.5, 4 or 1 minute is left, or the token is expired | `POST /v1/oauth/token`, an ordinary `refresh_token` grant |
| `--print ok …`; 10 minutes left | no refresh |
| `--print ok …`; 4 or 1 minute left | the same refresh, before the API call |
| `auth status --json --debug api --debug-file f` — the flags after the subcommand, as the refresher sent them | `error: unknown option '--debug'`, exit 1 |
| `--debug api --debug-file f auth status --json` | runs, and writes the debug file |
| the token host answers `invalid_grant` | blanks the credentials file it ran against; the debug capture says only `status code 400` |
| the token host answers 200 | writes the new tokens and expiry to that file, other top-level keys (`mcpOAuth`) kept |

So no probe could rotate before the last 5 minutes, Tier 1 never ran at all, and the
generic backoff (ticks at about T-45, T-44, T-39, T-24 and T-9 minutes, the next one
past expiry) left those 5 minutes to whichever resident session CLI called the API
first. And because the CLI ran in the account root, a probe that lost that race blanked
the account's real credentials.

**The fix keeps the CLI as the only thing that speaks OAuth, and changes what it runs
against.** `createProbeHome` builds a private `HOME` in the temp directory that holds a
copy of the source credentials file and nothing else. Inside the 45-minute margin the
copy claims `min(real expiry, now + 60 s)`, which is inside the CLI's own window, so
the CLI does its ordinary refresh at once — 40 minutes before any session CLI would.
It is the same code path a session's CLI runs when it rotates; only the trigger
differs. A forced probe of a healthy token (a session's 401, more than 45 minutes
left) keeps the copy's real expiry: it tests whether the token works, and rotates only
if the CLI's own 401 handling does.

`adoptProbeRotation` then reads the copy:

- **New tokens** → the copy's `claudeAiOauth` replaces the source's, written by atomic
  rename with the source's other keys kept, then the usual success path. New tokens are
  a rotation whatever the copy says about their expiry; without a readable expiry they
  are still installed, and the source then reads as `missing_credentials` with the live
  tokens in it. A copy that cannot be read after a probe counts as a possible rotation,
  because the CLI writes that file only to rotate or to blank it. A credential is identified by a
  hash of its two tokens, never by the file: other orchestrator-side CLIs run in the
  account root and rewrite its other keys, and that must not strand a spent grant.
  What happens next depends on what the source holds by then (`readSourceFor`):
  - *the credential the copy was made from* → install;
  - *a blanked credential* → install. Another CLI in the account root lost the grant
    to this probe and blanked the file; the copy holds that grant's live successor;
  - *another credential, or no file* (a sign-in, a session's published rotation, a
    sign-out) → the rotation is given up, so that the newer credential wins (one gap:
    Known limits);
  - *anything else* (a file that cannot be read or parsed, a failed write, a failed
    cleanup) → nothing is proved, so the copy is **kept** (`pendingRotation`) and not
    deleted with the tick. It is the only place the live grant exists. The next tick
    installs it right after the harvest, and no tick probes while it waits: the
    source's grant is spent, and a probe would only be rejected. A kept copy that can
    no longer be read is still released by a sign-in or a sign-out.
- **A blanked copy** → `invalid_grant`, and Tier 2 is skipped. The harvest runs once
  more, because a session can spend the grant between the first harvest and the probe;
  if it finds that session, the tick is `harvested_session`. It runs 5 s after the probe
  ends (`LATE_ROTATION_WAIT_MS`), because the session's CLI writes its rotation only after
  the server has answered it, and that can be after this probe's rejection. The tick
  holds its single flight through the wait and spends no grant in it. Otherwise the outcome is
  `revoked`, and the refresher remembers the rejected grant (`rejectedIdentity`, in
  memory, compared against the source's current credential). That memory replaces what the
  blanked source used to provide: no later tick or forced heal spends the dead grant
  again, and a tick on the unchanged source cannot read it as healthy and flip the
  account back to "ready". A new sign-in or a session's rotation changes the source's
  token, and the memory no longer applies.

Every verdict is about the token the copy was made from. If the source holds another
token when the probes end (after the wait, on a rejection), and its expiry did not advance (which is the ordinary
success test), the tick concludes nothing and a new tick runs at once — otherwise a
rejected old grant would report a completed sign-in as revoked.

After a timeout the CLI is killed, and the copy is read when the CLI has exited, so
that a write under way lands before the copy is judged or deleted. An error from the
kill is not an exit. If no exit comes within 5 s, the tick goes on without it.

**Outcomes and logs.** `not_rotated` is new: no rotation, no `invalid_grant`, no 429,
and the source token is **still valid**; its line carries `expires_in=<N>m`.
`unknown_failure … — short backoff` keeps its sentence and now means the token is
expired, or that its expiry cannot be read. With the short claimed life in place, `not_rotated` is the sign that the CLI
stopped refreshing a near-expiry copy — the first thing to check after a CLI bump. In
`reason="…"`, lines that contain `ENOENT` are dropped (the CLI logs each optional file
it does not find), lines above debug level are preferred, and each of the three lines is capped
separately, so that a long line cannot hide the last one. A refresher's own note is
kept also when it says `ENOENT`: `reason="[error] spawn claude ENOENT"` is a CLI that
did not start, and it used to read `reason="no CLI output"`. Node reports that error
for a binary that is not on the `PATH`, for a missing interpreter and for a missing
working directory (measured on Node 24). `[probe-home-failed] ENOENT` is a private
copy that could not be made, for example because the temporary directory is missing.
A note is known by its form only: a lower-case tag and a space at the start of a line.
The CLI's level tags are upper case (`[DEBUG]`, `[ERROR]`; measured on 2.1.284, where
no line of the debug log starts with a lower-case tag). The Codex refresher uses the
same summary (docs/154). A forced probe of a token with more than 45 minutes left
that finds no rotation and no rejection ends `noop`. It writes a line only when
tier 2 did not complete (the CLI did not start, or it did not end before its
timeout): `forced probe did not complete — no verdict on the token reason="…"`.
Tier 1 sends no request for such a token, so only tier 2 can test it. `spawnCli`
reports how the run ended, and the text is not searched for it. The line does not
say that the token was not used: a CLI that hangs after its answer also times out.
Tier 1's stdout names the
account's email and organization and is kept out of it. Debug timestamps are stripped
before classification: one ending `.429Z` used to read as an HTTP 429 and select the
rate-limit backoff.

**The revoked line (2026-10-12).** `revoked (<reason>) — emitting auth_required` keeps its
sentence, and the first line for a rejected grant now continues with what ran:

```
… — emitting auth_required trigger=scheduled verdict=blanked_copy rejected_by=tier2 tier1=0.3s,exit=0 tier2=2.4s,exit=1 expires_in=45m reason="…"
```

- `trigger`: `scheduled` (the expiry timer), `backoff_retry`, `turn_start`, `forced_heal` (a
  session reported an auth failure), `nudge` (`refreshNow`: a completed sign-in, or an
  auth-required report), and `private_run` for a naming run's rejection. A caller that
  joins a tick in flight is reported under the trigger that started it.
- `verdict`: `blanked_copy`, or `output_phrase` when the output names the rejection and no
  copy was blanked. `rejected_by`: `tier1`, `tier2`, `tier1+tier2` (a phrase in both
  outputs), or `kept_copy` (a kept rotation that read as blanked on a later tick).
- `tier1`, `tier2`: the run time, then `timeout` if the tier was killed, then
  `exit=<code or signal>`, or `no_exit` when the CLI did not start or did not exit within
  the kill grace. `not_run` for a tier that was skipped.
- `expires_in`: what the source token had left, negative when it is expired.
- `reason`: the redacted excerpt that the other failure lines carry. Tier 1's stdout is
  not in it.

Each later tick on the same grant logs the sentence with `trigger=… verdict=known_rejected`
and nothing more, so `grep 'revoked (' | grep -v known_rejected` gives the first line.
`rotated_tier2` ends with `tier1=…`: `not_run` on a near-expiry tick, and how tier 1
ended on a forced probe. `rotated_tier1` is now, in practice, a kept rotation that a
later tick installed.
A naming run and a kept copy have no tier output, so their lines stop at `expires_in`.

With `tier1=not_run` and a tier 2 that ran for less than 30 s, the refresher sent the
grant once in that tick. The grant was then dead before that request, or a session's CLI
spent it at the same moment (the late harvest looks for that). A tier 2 of 30 s or more
can have sent it twice by itself (Known limits). Before the tier 1 fix, no line could
tell any of these from a grant that tier 1 had sent without waiting for the answer.

**Validation.** `node --import tsx scripts/probe-claude-refresh.mjs` runs the installed
binary with synthetic tokens, an isolated home and working directory, and a local TLS
recorder that never forwards traffic. It uses the refresher's own command lines and
constants (`REFRESH_PROBE_COMMANDS`, `CLI_REFRESH_WINDOW_MS`, `PROBE_REMAINING_MS`), and
checks what the refresher depends on: both tiers accept their command line, neither
refreshes outside the window, Tier 1 sends no grant on a healthy copy also when the API
answers 401, Tier 2 refreshes a copy that claims one minute and writes the result to
it, **Tier 2 waits for a token host that answers after 1.5 s** and sends the grant once,
`invalid_grant` blanks the file, and a 429 or a 500 does not. An `info` line says what
Tier 1 does with a slow answer; it is not a check, because the refresher gives Tier 1
no copy that it refreshes. Until 2026-10-12 the recorder answered every request at
once, which no real host does, so the check that Tier 1 writes a rotation could not
fail. It does not check every row of the table (the rejected flag order is history, not
a dependency). 13 checks, about 9 s, exit 1 on a failure. CI runs it as the job
`claude-refresh-probe` (`.github/workflows/ci.yml`) on a pull request that changes
`docker/agent-cli/package.json`, its lockfile or `install-agent-clis.sh`, the probe, this
refresher (whose command lines the probe uses) or the workflow, and on every push to
`main`. The job installs the pinned CLI with the images' own `install-agent-clis.sh`
(`SHIPIT_HARNESSES=claude`): `npm ci --ignore-scripts` alone does not give a binary that
runs ("claude native binary not installed"), so the `npm rebuild` of that one package is
needed. It gets no secret, and its checkout keeps no token.

**Options weighed and not taken:**

- *Refresh the grant from the orchestrator directly* — see "Delegate to the Claude
  CLI"; that rationale still holds.
- *`claude auth login` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`.* The CLI supports it,
  but that path asks the token host for `expires_in: 31536000` (one year). It is not an
  ordinary rotation, and what the server does with it for a subscription grant is
  unknown.
- *Schedule ticks inside the CLI's 5-minute window.* The orchestrator would enter the
  race it exists to prevent, once per lifetime, against every resident CLI.

### Session naming in a private copy (2026-10)

Session naming (`claude -p …`, `session-namer.ts`) was the last model call in the
containerized orchestrator that ran with `HOME` at an account's credential root. Such
a CLI refreshes the source itself inside the 5-minute window and blanks it on
`invalid_grant`, so a naming run that lost the grant to a session's CLI blanked the
account's only copy.

On a Claude account route in the containerized orchestrator, naming now runs through
`ClaudeOAuthRefresher.runInPrivateCopy`, reached through
`ProviderAccountManager.claudeCredentialCopyRunner()` (attached at boot, so no route
passes a new dependency). It makes the same private copy as a probe, but with the
**real** expiry: naming should not rotate a token that the refresher would not, and it
does not run unless the copy can be made — an unreadable source fails naming with
`The Claude account's credentials could not be copied (<code>).`, never the file's
text. `CLAUDE_CONFIG_DIR` is removed from that CLI's environment, because with it set
the CLI ignores `HOME` and so the copy.

When the run ends, the copy is judged by the probe's rules (`adoptProbeRotation`):

- **New tokens** → installed in the source, then the ordinary success path (repush,
  `refreshed`), logged as `rotated_private_run`. A failed install keeps the copy as
  `pendingRotation`, and a tick is scheduled in 1 s to install it without a probe. If
  a rotation is kept already, the new copy takes its place only where a tick would
  give the kept one up: the source is gone or holds another credential. The kept copy
  is then deleted. Otherwise the kept one stays, and the new copy is left on disk with
  its path logged. Different seeds alone prove nothing: a run that started before a
  sign-in can end after a newer run's rotation was kept.
- **A blanked copy** → a rejected grant, as after a probe (`rejectedIdentity`,
  `revoked`), if the source still holds the rejected credential. While another naming
  run of the account is open, it can hold the grant's successor, so the rejection is
  kept (`unjudgedRejection`) and judged when the last open run ends: again only if the
  source still holds that credential, and only if no rotation kept from that same
  credential (which holds its successor) waits. A rotation kept from an older
  credential does not stop the verdict; the next tick gives it up. Where both
  checks pass, the run that judges waits 5 s, as after a probe, checks again and only
  then does the late harvest; it returns to its caller that much later. "Open" counts a
  run until its CLI has ended (`openRuns`), not through this wait: a run that is only
  waiting cannot hold a successor, and counting it would leave a rejection that ends
  during the wait unjudged. A tick waits for both, so it does not probe in the wait.
- **Anything else** → no verdict. The copy is deleted.

A naming run and a probe would spend the same grant, so they do not overlap: a naming
run waits for a tick in flight before it copies the source, and a tick waits for the
open naming runs before it harvests or probes. Naming's CLI times out after 15 s; a
tick waits at most 30 s. If a run is still open then, the tick harvests as usual but
does not probe: the run can hold the grant's successor, and a probe would misjudge
the grant as revoked. The tick ends `not_rotated` (`[private-run-open]`) and retries
on the generic backoff. Naming runs do not wait for each other.

Local mode attaches no runner, so naming there still runs in the account root with
its environment unchanged: the refresher does not run in local mode, and the turn
CLIs share that root anyway.

### Tier 1 does not present the grant (2026-10-12 fix)

Production, build `930f5eea` (UTC): `acct_1219…` logged `rotated_tier2` at 14:24:57, and
35 s later `acct_1a27…`, signed in 7 h 15 min before, logged `revoked (invalid_grant)`.
Its scheduled tick fired at 14:25:20 and the probes took about 2.9 s. Turns on that
account got good answers until less than 40 s before the tick; the first session auth
failure came 14 s after the verdict. Nothing else on the host is known to have touched
the grant.

Measured on CLI 2.1.284, offline as in "Validation" (synthetic tokens, a local recorder;
nothing reached the real token host). The probe script and the end-to-end run gave the
same results on 2.1.293, the version that `main` pinned that day:

| A copy that claims 60 s, and the token host… | Tier 1 (`auth status --json`) | Tier 2 (`--print ok …`) |
|---|---|---|
| answers at once | writes the rotation | writes the rotation |
| answers 25 ms or more after the request | exits about 0.2 s after its start, exit code 0, copy `unchanged`, no line about a refresh in the debug capture | waits (8 s tested), writes the rotation, one request |
| is reached only after 40 ms of connection set-up | exits before the request is sent | waits, writes the rotation |
| does not answer | the same exit, the same `unchanged` | gives up after 30 s, **sends the same refresh token again**, ends at about 60 s |

So on a copy inside the CLI's window, Tier 1 sends the grant and does not wait. When
its request reaches the host and the answer comes after the exit, the grant is spent
and its successor is lost; the refresher then read `unchanged` and Tier 2 sent the same
refresh token about 0.3 s later. Run through `ClaudeOAuthRefresher` against a recorder
that spends a refresh token on first use, that sequence logged `revoked` for a grant
with 40 minutes left; with a slow connection it logged `rotated_tier2`. Both of the
production lines, from one mechanism, with no timeout or kill.

**The fix:** Tier 1 does not run on a copy that claims 5.5 minutes or less (the CLI's
window, plus the 30 s that Tier 1 may run). That is every near-expiry tick, because its
copy claims 60 s. Tier 2 is the only tier that sends the grant there, and it waits for
the answer. Tier 1 still runs first on a forced probe of a healthy token, where it sends
no grant, also when the API answers 401 to it.

**Not known**, and not tested, because that needs the real token host: whether it
completes a rotation whose client has gone, and whether it revokes the whole grant
(access token included) on a replayed refresh token. So the incident is consistent with
this mechanism and not proven to be it.

### A sign-in is not the harvest's to complete (2026-10-12 fix)

Production, build `930f5eea`, account `acct_1a27…` (UTC). The account's grant had been
rejected at 14:25:28 (what invalidated it is not known). The operator started a new sign-in:

| | |
|---|---|
| 14:46:54 | the sign-in starts and removes the account's `.credentials.json`; the row is `authenticating` |
| 14:47:00 | a new session's first turn is routed to that account, which has no token, and fails over |
| 14:47:04 | a tick's harvest finds a session subtree that still holds the pushed copy of the rejected credential, reads the missing source as "behind", and copies it in: `harvested … was=none`, then `harvested_session`. It is pushed to 38 sessions, the account reads `ready`, and the memory of the rejected grant is cleared |
| 14:47:16 | the reinstalled grant is probed again: `revoked` |
| 14:47:24 | the operator's code reaches the login CLI. The first poll, 300 ms later, finds a credential file newer than the baseline (the harvest's write), reports the sign-in complete and kills the login CLI before it has exchanged the code |
| 14:47:25 | `revoked` again, but the account was announced once already, so the row stays `ready` |

The account read `ready` with a dead credential, and the operator's code was never used.
Four rules, each where the fault was:

1. **A missing account source is not refilled from a replica**
   (`token-sync-manager.ts`). A source is missing while a sign-in runs and after a
   sign-out, and a replica then holds exactly the credential that was removed.
   `sessionTokenIsAheadOfSource` no longer reads a replica as ahead of a missing account
   source, and `syncProviderAccountTokenBack` and `syncSubAgentSpawnHomeTokenBack` refuse
   the copy (`write-back=refused … reason=source-absent`). So the harvest, the mid-turn
   publication, the turn-end write-back and a sub-agent's write-back all stop there, for
   every harness. It is the rule a probe's rotation already had ("the source is gone →
   the rotation is given up"). The flat (pre-account) root keeps the old behavior.
2. **The harvest does not adopt the credential that is known rejected**
   (`harvestSessionRotations`). A session's copy with those tokens is a pushed copy, not a
   rotation, whatever its expiry says against the source.
3. **A sign-in's result is a credential that the login CLI wrote** (`auth-manager.ts`).
   "Fresh" was "a file with a newer mtime than at the start". It is now a credential with
   an access token whose tokens differ from the baseline, and the baseline is taken again
   when the first code is submitted: the login CLI cannot write before it has a code, so
   what is on disk at that moment is another writer's. Tokens, not mtime, because other
   CLIs rewrite the file's other keys.
4. **An `authenticating` account is routed to only while it holds a credential**
   (`ProviderAccountManager.selectAccountForTurn`, asked through the login's
   `isConfigured`). Claude's sign-in removes the credential at its start; a sign-in that
   keeps the old one (Codex's device flow) stays routable.

And the announcement: `emitUnauthenticated` was latched after the first report. It now
reports again when the account's row reads `ready`, because a sign-in's completion sets
the row `ready` without a word to the refresher. In the other direction, a tick that
finds the source missing while the row reads `authenticating` reports nothing
(`missing_credentials … sign_in=in_progress`): the `agent_auth_failed` event would close
the sign-in that the user is in, and with rule 1 no harvest hides that state any more.

### Known limits (not addressed here)

- **The marker records what provisioning intended, not whose bytes are on
  disk** (docs/260 §4b says so, and it lives in a subtree the session worker can
  write). So a subtree already poisoned with a foreign bearer under a matching
  marker is published on the marker's word. This is the pre-existing trust of
  the turn-end write-back, unchanged; the harvest widens *when* that write can
  fire (a timer, not a turn), not what it trusts.
- **The borrow guard is not re-entrant.** `beginSubtreeBorrow` returns early if
  a borrow is already recorded and `endSubtreeBorrow` deletes the single entry,
  so overlapping same-session borrows leave `subtreeBorrowInFlight` false while
  one is still live. Pre-existing (planning#445) and equally under the turn-end
  write-back; tracked as planning#463.
- **`syncAgentTokenBackToRoot` reads source freshness and copies over that
  pathname with no re-check**, so an external writer landing between the two is
  overwritten. Pre-existing, in a function this change does not touch, and it
  affects every caller.
- The **Codex** refresher (`agents/codex/oauth-refresher.ts`) was audited against
  these fixes in 2026-10. What it had of these gaps, and what it does now, is in
  docs/154-codex-oauth-refresh-readiness, "On-demand refresh, real rejections,
  harvest". It imports `summarizeRefreshFailure` from this refresher.
- **The private copy depends on three CLI behaviors** that the CLI does not
  document: it refreshes when the file says 5 minutes or less are left, it writes
  the result to the file it read, and it blanks that file on `invalid_grant` only.
  A CLI bump can change any of them. `scripts/probe-claude-refresh.mjs` checks them
  against the pinned binary, and CI runs it on every change to the pin. A red run
  blocks a merge only if the branch protection names the job as a required check.
- **A rotation is in the copy before it is in the source.** If the orchestrator
  dies between the CLI's write and the install, the grant is spent and the new
  token is left in the temp directory, where nothing looks for it; the account
  needs a sign-in. The window is the CLI's remaining run time: well under a
  second for Tier 1, a few seconds for Tier 2, and up to 15 s for a naming run,
  which refreshes before its model call. It lasts as long as a
  `pendingRotation` waits, which is held in memory only: that covers a failed
  install, not a dead process.
- **The sign-in PTY still runs in the account root**, because it is meant to
  write there. In local mode the turn CLIs and session naming run there too.
  Such a CLI refreshes the source itself when it finds it inside the 5-minute
  window, and blanks it on `invalid_grant`. When the probe wins the grant it
  installs over the blank. (The usage-limits provider and the account identity
  reader only read the file. Bug-report redaction runs in the flat `/root` home.)
- **A naming run that never ends stops the account's probes.** Its ticks still
  harvest the sessions' rotations, so the account falls back to the session CLIs
  refreshing near expiry, as before the private probe copy. The CLI's own 15 s
  timeout makes this a fault: a process that ignores the kill, or that leaves
  a child holding its output open.
- **Only one rotation is kept.** A second copy that cannot be installed while the
  source does not prove the kept one superseded is left on disk, with its path in
  the log, and nothing installs it. It takes two failed installs; and since a
  single-use grant gives at most one live successor, it loses a grant only when the
  kept copy holds none (an unreadable probe copy) or the source cannot be read.
- **The late harvest waits 5 s, not until a session's rotation is on disk.** When a
  session's CLI and a probe (or a naming run) spend the same grant, the loser's
  `invalid_grant` is judged no earlier than 5 s after it ends (for a naming run, 5 s
  after the last naming run that was open when it ended; a run that starts later
  copies the spent grant and cannot hold its successor). A session CLI that writes its new
  tokens later than that still has the account reported revoked until a later tick
  harvests the rotation. Measured offline on CLI 2.1.284 (the probe script's recorder,
  10 runs on an idle container), the CLI writes the new tokens 10–18 ms after the token
  host answers; the rest of the 5 s is for a loaded session container and for an
  answer that reaches the session later than the rejection reaches the loser. A real
  revocation is reported 5 s later than before.
- **The install's token check and its rename are two steps.** A writer that
  replaces the source's token between them is overwritten. The CLI used to take
  its own lock in the account root for this; the refresher does not. It is the
  same class of gap as the `syncAgentTokenBackToRoot` item above.
- **A forced probe that did not complete still heals.** With more than
  45 minutes left, a forced tick that finds no rotation and no rejection ends
  `noop`, and the heal succeeds. `recoverAuth` in `turn-executor.ts` then
  pushes the account's source credential to the session and runs an ordinary
  turn again, once; an adopted turn ends with no second run. That is also the
  result when tier 2 did not start or did not end before its timeout, so the
  refresher has no verdict on the token. The log says so (see "Outcomes and
  logs"); the result is not changed. A tier 2 that ran and failed for another
  reason (an error from the API, a signal from outside) still reads as a live
  token and writes no line. The Codex refresher has the same rule since
  2026-10-12: no verdict heals (docs/154, "Turn start and forced heal", with
  the costs under its Known limits).
- **Tier 2 presents the grant a second time after its own timeout.** With a token host
  that does not answer, the CLI gives up after 30 s and the same process sends the same
  refresh token again; it ends at about 60 s, where the refresher's tier 2 timeout is.
  That replay is inside the CLI. A shorter tier 2 timeout would stop the second request,
  but it would also kill a rotation whose answer is on its way, so it is left as it is.
- **A request that the token host completes and whose answer is lost still costs the
  grant.** No tier can know it. A tick that follows sends the same refresh token and is
  rejected, and the account needs a sign-in. The tier 1 fix removes the case that the
  refresher made itself; it does not remove a lost answer.
- **A kept rotation is logged as `rotated_tier1`** when a later tick installs it,
  whichever tier or naming run made it.
- **The harvest tells a session's rotation from a pushed copy by expiry alone**, apart
  from the credential that is known rejected. A source that is replaced by a credential
  with an earlier expiry than a copy pushed before it is overwritten by that copy.
- **"Holds a credential" is the login's `isConfigured`**, which for Claude, Codex and
  Grok is a file that exists, not a token that works. An `authenticating` account with a
  blanked or empty credential file is still routed to. A sign-in's start removes the
  file, which is the case that rule 4 is for.
- **Model eligibility still lists an `authenticating` account** (`listConfiguredCredentials`
  reads the stored row, not the credential root). A turn started on it while its sign-in
  has no credential yet gets `auth_required` from the router, or another account.
- **A login CLI that ends by itself before any code is submitted** is still judged
  against the baseline of the sign-in's start, so a credential that another writer put
  there in that time counts as its result. No writer is known for an empty account source.

## Wiring

### New module

`src/server/orchestrator/claude-oauth-refresher.ts`:

```typescript
export interface ClaudeOAuthRefresherDeps {
  credentialsDir: string;
  providerAccountManager: ProviderAccountManager;
  repushTokenToPinnedSessions: (agentId: AgentId, accountId?: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  spawn?: typeof spawn;
  now?: () => number;
}

export class ClaudeOAuthRefresher {
  start(): void;
  stop(): void;
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
| `claude auth status --json` behavior changes in a future CLI version. | Tier 2 (`--print` against Haiku) makes an authenticated API call, and the CLI checks the token before one. Neither tier refreshes a token with more than 5 minutes left — an authenticated call does **not** guarantee refresh-on-use, as this row once said — which is why the rotation runs against a copy that claims a short life. Since 2026-10-12 the rotation does not depend on `auth status` at all: Tier 1 gets no copy that it would refresh. |
| The CLI's debug log format changes. | File-state delta is the authoritative success signal; debug parsing is only used for failure classification. A debug-format change degrades the "what's wrong?" classification to "unknown failure", which still backs off and retries. |
| Session-side CLIs still attempt refresh occasionally despite the safety margin. | A session CLI refreshes only when its own copy says 5 minutes or less are left, so the lead time matters only if the orchestrator has rotated and repushed before then. If we observe session-side refresh traffic (`[token-publish] published mid-turn claude token rotation`, or token-host connections from agent-* containers), check for `not_rotated` lines first. An egress policy that blocks session containers from the OAuth endpoint remains future hardening. |
| Refresher tick fires during an actual `claude /login` flow. | The refresher's CLI writes only its private copy, and the install is skipped when the source holds another token than the copy was made from, so the sign-in's token stays. |
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

## Addendum — a second, unrelated cause of "Not logged in · Please run /login"

Confirmed on a dogfooding session container 2026-08-02. This is **not** the OAuth
refresh stampede above; it is a separate mechanism that produces a similar
symptom, and it destroys the session permanently rather than for one turn.

**Mechanism.** `initializeManagers` (`app-di.ts`) defaulted `credentialsDir` to
the literal `/credentials`, then constructed a `ProviderAccountManager` and
called `migrateDefaultAccounts()` (`app-di.ts:369`). That runs
`migrateProviderDefault`, a one-shot legacy migration ending in `fs.renameSync`
— a **move**. Its only guard is `if (this.list(provider).length > 0) return`,
which never fires in production (accounts exist) but **always** fires against a
fresh test database.

99 test files call `buildApp()`; 86 of them pass `workspaceDir: tmpDir` but no
`credentialsDir`, so they inherited `/credentials`. Inside a session container
that path is *not* the orchestrator's credentials volume — `container-lifecycle
.ts:265` mounts `<root>/sessions/<sessionId>` there, so it is that session's own
live agent home. Running the test suite in-container therefore moved the running
CLI's `.claude/` (credential **and** conversation jsonl) and `.claude.json` into
`provider-accounts/claude/claude-default/`. Nothing moves them back, so every
subsequent turn 401s forever.

This tracked *running the suite*, not subject matter: `connection.test.ts` and
`http-bootstrap.test.ts` are smoke tests, so `npm run test:dev` triggered it
regardless of what the session was working on. It also explains the artifacts —
the orphan is named `claude-default` because that is the migration's literal
target; it holds the real credential and a multi-megabyte conversation because
it *is* the moved home; and "no resumable jsonl on disk (DB pointed at `<id>`)"
happened because the jsonl moved with it. The DB pointer was always correct.

**Fix — three independent layers**, since any one alone still leaves a live home
reachable:

1. `resolveCredentialsDir` (`app-di.ts`) — under test mode an omitted
   `credentialsDir` gets a fresh `mkdtemp` dir, never the live volume, and an
   *explicit* live path is a hard error. Enforced in one place rather than at 86
   call sites, so a future test author cannot reintroduce it by omission. (Temp
   roots are created under `os.tmpdir()` rather than under `workspaceDir`,
   because a test that passes neither would otherwise write into the real
   `/workspace` git tree.)
2. `isSessionContainerCredentialRoot` (`provider-account-manager.ts`) — the
   migration refuses to run when `SHIPIT_SESSION_ID` is set. That env var is on
   every session container and nothing else, which is the only reliable signal:
   a session home and a pre-account orchestrator volume have identical *shape*
   (`.claude/`, `.claude.json`), which is exactly why the migration confused
   them.
3. Copy-then-verify instead of `renameSync` — the source is removed only after
   the copy is confirmed at the destination, so an interrupted or misdirected
   migration costs disk rather than the only copy of a live credential.

The orphan-discovery and rescue work in `token-sync-manager.ts` is what recovers
sessions already broken by this, including reuniting them with the conversation
history that was moved into the orphan.

## Key files (planned)

- `src/server/orchestrator/claude-oauth-refresher.ts` — new module
- `src/server/orchestrator/claude-oauth-refresher.test.ts` — unit tests
- `src/server/orchestrator/app-lifecycle.ts` — wire `start()` + `auth_complete`/sign-out
- `src/server/orchestrator/app-di.ts` — pass `providerAccountManager` into the refresher
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — optional: route
  `auth_required` through `refresher.refreshNow()` before propagating to the client

### Key files (addendum — live-home destruction)

- `src/server/orchestrator/app-di.ts` — `resolveCredentialsDir`, `LIVE_CREDENTIALS_DIR`
- `src/server/orchestrator/app-di-credentials.test.ts` — the default/refusal rules
- `src/server/orchestrator/provider-account-manager.ts` —
  `isSessionContainerCredentialRoot`, copy-then-verify migration
- `src/server/orchestrator/provider-account-manager.test.ts` — `live-home safety`
- `src/server/orchestrator/token-sync-manager.ts` — orphan discovery + rescue
- `src/server/orchestrator/session-credentials-scaffold.ts` — never write through a
  symlink at a credential destination

### Key files (mid-turn publication)

- `src/server/orchestrator/session-token-publisher.ts` — the watch: arm/disarm,
  debounce, publish via the existing sync-back
- `src/server/orchestrator/session-token-publisher.test.ts` — publication,
  expiry-guard preservation, no-op-on-churn, account routing, teardown
- `src/server/orchestrator/token-sync-manager.ts` — adds the read-only
  `agentTokenFilePaths` / `sessionTokenIsAheadOfSource`; the sync-back functions
  themselves are unchanged
- `src/server/orchestrator/session-agent-env.ts` — arms the watch in
  `prepareSessionAgentEnvironment` (Step 2b), disarms it in
  `finalizeSessionAgentEnvironment` only when no agent process survives the turn
- `src/server/orchestrator/shutdown-manager.ts` — drops every remaining watch
  on `onClose`

### Key files (private probe copy, 2026-10)

- `src/server/orchestrator/agents/claude/oauth-refresher.ts` — `createProbeHome`,
  `adoptProbeRotation`, `readSourceFor`, `claudeCredentialIdentity`,
  `pendingRotation`, `sourceGrantIsKnownRejected`, `clampToLastChance`,
  `retryNotBefore`, `waitForLateRotation`
- `src/server/orchestrator/agents/claude/oauth-refresher.test.ts` — "private probe
  copy", "retry schedule"
- `scripts/probe-claude-refresh.mjs` — the same checks against the real binary
- `.github/workflows/ci.yml` — the `claude-refresh-probe` job that runs it

### Key files (sign-in and harvest, 2026-10-12)

- `src/server/orchestrator/token-sync-manager.ts` — `refuseAbsentAccountSource`, and the
  missing-source rule in `sessionTokenIsAheadOfSource`, `syncAgentTokenBackToRoot`,
  `syncSubAgentSpawnHomeTokenBack`
- `src/server/orchestrator/agents/claude/auth-manager.ts` — `credentialFingerprint`,
  `credentialBaseline`, `hasFreshCredentials`
- `src/server/orchestrator/provider-account-manager.ts` — `holdsCredential` in
  `selectAccountForTurn`
- `src/server/orchestrator/agents/claude/oauth-refresher.ts` — the rejected-credential
  guard in `harvestSessionRotations`, `emitUnauthenticated`, `runTier1` in `executeTick`,
  and the revoked line: `TickTrigger`, `TierRun`, `describeTierRun`, `handleRevoked`
- `scripts/probe-claude-refresh.mjs` — the delayed answer (`SLOW_ANSWER_MS`) and the
  API's 401
- Tests: "a missing account source is not refilled from a replica" in
  `token-freshness-guard.test.ts`; "fresh-credential completion gate" in
  `auth-manager.test.ts`; "account-scoped auth flows" in
  `provider-account-manager.test.ts`; "harvest before spend" and "failure logging" in
  `oauth-refresher.test.ts`

### Key files (session naming in a private copy, 2026-10)

- `src/server/orchestrator/agents/claude/oauth-refresher.ts` — `runInPrivateCopy`,
  `settlePrivateRun`, `waitForPrivateRuns`, `privateRuns`, `openRuns`,
  `unjudgedRejection`, `rejectionStillApplies`
- `src/server/orchestrator/provider-account-manager.ts` —
  `attachClaudeCredentialCopy`, `claudeCredentialCopyRunner`
- `src/server/orchestrator/bootstrap-managers.ts` — attaches the runner in
  containerized mode only
- `src/server/orchestrator/services/graduate-session.ts` — passes
  `inCredentialCopy` on a Claude account route
- `src/server/orchestrator/session-namer.ts` — the Claude case runs `callCli` in
  the copy, and only there removes `CLAUDE_CONFIG_DIR`
- Tests: "private run (session naming)" in `oauth-refresher.test.ts`, and the
  credential-copy cases in `session-namer.test.ts` and `graduate-session.test.ts`

### Key files (harvest before spend, planning#462)

- `src/server/orchestrator/agents/claude/oauth-refresher.ts` —
  `harvestSessionRotations` + `tokenFileIsOwnedBySubtree` (adopt a session's
  rotation before spending), `summarizeRefreshFailure` + `redactSecrets` (the
  logged reason), `describeUnusableSource` (missing vs blanked vs unreadable)
- `src/server/orchestrator/agents/claude/oauth-refresher.test.ts` — harvest
  adoption / newest-wins / behind-source / foreign-marker / unmarked-subtree /
  escaped-subtree, and the log-shape + redaction tests
- `src/server/orchestrator/session-token-publisher.ts` — watch lifetime tied to
  the resident process; re-arm on a runner change
- `src/server/orchestrator/container-session-runner.ts` — releases the watch at
  the two process exits finalize cannot see (`setAgent(null)`,
  `isStreamingActive = false`)
- `src/server/orchestrator/session-agent-env.test.ts` — "keeps the watch alive
  past turn end while a CLI process is still resident";
  `container-session-runner.test.ts` — the two releases
