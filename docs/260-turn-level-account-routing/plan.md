---
issue: planning#347
title: Turn-level account routing — design
description: Per-turn account selection, harness-authoritative quota, process-scoped account identity; deletes pinning and the bench reconciliation machinery.
---

# 260 — Turn-level account routing: design

Implements [`requirements.md`](./requirements.md) (13 numbered requirements, all
questions resolved 2026-08-10). Read that first; this document cites
requirements as `(req N)`.

The change is one sentence: **routing becomes a pure per-turn function of the
strategy and the quota picture; account identity becomes a fact about a live
process; and the only quota belief that can block an account is a refusal the
harness itself reported, remembered briefly.** Everything below is the
consequence of that sentence, and most of it is deletion.

## 1. Selection — one router call per turn (reqs 1, 2, 8)

`prepareSessionAgentEnvironment` stops reading `provider_route_kind/id` as a
preference. Every routed turn asks `ProviderAccountManager.selectAccountForTurn`
— the pinned/unpinned split disappears:

- **Deleted:** `failoverPinnedSession`, `sessionNeedsAccountFailover`,
  `classifyRouteForTurn`, the pinned-route short-circuit in
  `session-agent-env.ts` (`selectedRoute = pinnedRoute`), and the pre-capture
  failover check in `agent-execution.ts` (replaced below).
- `selectAccountForTurn` keeps its three-tier walk (eligible → over-cutoff →
  refused) and its strategy ordering, with two changes:
  - **Telemetry orders, never blocks (req 5).** The snapshot-window half of
    `exhaustedUntil()` moves from "skip this account" to "sort it last". An
    account whose snapshot claims 100% is still a candidate — it just runs
    after every account that looks healthy, which is exactly req 9's
    "try once to confirm".
  - **Refusal memory** (section 2) is the only skip — and even that yields
    under req 12 (section 3).
- **Resident-process tiebreak (req 8 receipt).** New option
  `residentAccountId?: string`: under `balanced`, an account that is eligible
  and under-cutoff and currently backs the session's resident CLI process wins
  ties instead of sorting last by `lastUsedAt` — otherwise least-recently-used
  ordering would ping-pong a two-account install every turn and restart the
  resident process each time. Under `strict` the option is ignored entirely:
  the strategy wins and the session moves back to the primary the turn it
  recovers (req 8), at the accepted cost of one process restart.
- The pre-capture check in `agent-execution.ts` becomes account-agnostic and
  trivial: run selection once before capturing the resident process; if the
  chosen account differs from the process's captured account (section 5),
  retire the process. No quota classification is involved — the router already
  answered.
- **Busy processes are never retired for a move (req 13).** Before retiring,
  the check consults the runner's background-work tracker (docs/235:
  `agentBusy` / `backgroundWorkDescriptions` — sub-agent consults, background
  tasks). While work is in progress, this turn runs on the resident process's
  own account regardless of what the strategy prefers — the documented
  exception to req 8 — and the move happens at the first turn that finds the
  process clean. The one case this cannot save: the process's own account
  refuses the turn mid-flight and the process dies of it; the provider killed
  it, not the router, and its background children die with it as they do for
  any process crash today.

Non-turn work (`selectRouteForTurn` callers: voice, naming, sub-agents) cannot
run an attempt loop, so for it the same rule applies with no special case:
refusal memory orders accounts to the back but never yields "no route" while
any account exists — the caller takes the router's first candidate. A cheap
call occasionally getting refused is strictly better than a hard failure
(req 5's spirit at low stakes), and it is one rule instead of two.

## 2. Refusal memory replaces benches (reqs 5, 9, 11)

The persisted columns stay; their meaning narrows. `exhausted_until` /
`exhausted_at` on `credential_routes` become **refusal memory**: written only
when the harness refuses a turn for quota (`markAccountExhausted` /
`markCredentialRouteExhausted`, same writers as today — and the string-
credential writer starts stamping `exhausted_at` too, which is the whole req 11
gap: same table, same columns, it just never wrote the clock).

**Read rule (the entire policy, one expression):** an account is
refusal-blocked while
`now < min(exhaustedUntil, exhaustedAt + REPROBE_MS)` with `REPROBE_MS ≈ 30
minutes. So a refusal is honoured until the provider-stated reset, but the
account is re-tried at least every ~30 minutes (req 9); if the probe is
refused again, the stamp refreshes and the next window starts. The cap is
enforced at **read time**, which makes it the migration too: every persisted
legacy bench, whatever its history, blocks for at most 30 minutes after this
deploys — no row rewrite, no precedence clocks.

**Early clear (req 9).** A quota reading for the route that is newer than
`exhaustedAt` and whose *known* windows are all below 100% clears the memory
immediately. Two sources, both "real account data" in Nik's words: a harness
`rate_limit_event`, and a usage-API fetch — which is what the UI refresh
button triggers, so "user upgrades plan, presses refresh" re-opens the account
on the next turn without waiting out the cap. Unlike the deleted
`isTrustedHealthySnapshot`, a `usedPct: null` window counts as healthy here:
null means below the warning threshold. The old machinery demanded numeric
proof because a wrong clear meant a wrongly-run turn was the *only* recovery;
now a wrong clear costs one refused attempt (req 5), so the trust bar drops to
match the price of being wrong.

**Deleted:** `reconcileHardExhaustion`, `isTrustedHealthySnapshot`, the
`exhaustedAt ?? updatedAt` legacy-clock fallback, and the "bench is
authoritative until trusted snapshot" contract in
`provider-account-manager.ts`. The three permanent stuck states the
2026-08-10 trace found all lived in that contract; none of them can be
expressed in the new read rule.

## 3. The attempt loop (reqs 6, 10, 12)

The req-14 one-hop retry in `turn-executor.ts` (`retryOnNextAccount`,
`willRetryOnQuotaError`) generalizes to a loop:

1. Run the turn on the selected account.
2. On a harness quota refusal: stamp refusal memory for the **captured**
   account (attribution unchanged from the failover-attribution fix), emit a
   persisted in-turn notice (req 10), add the account to the turn's exclusion
   set, re-select, respawn. Partial output is finalized before the retry, as
   today.
3. Stop on success, or when no candidate remains. The all-refused failure is
   produced **only here**, from this turn's actual refusals, carrying the
   provider-reported reset times (req 6). Env-prep's
   `ProviderRouteUnavailableError` keeps only the `auth_required` shape;
   `all_exhausted` can no longer be decided without trying.
4. The loop is bounded by the exclusion set: at most one attempt per account
   per turn.

**Req 12 lives in selection's contract with the loop:** when every candidate
is refusal-blocked, selection does not fail — it returns the candidates in
strategy order with their memory ignored, and the loop tries them. A resend
after an all-refused turn therefore always re-tries every account; no belief
state can refuse to try (req 12). Combined with the stamp-on-refusal in step
2, a genuinely-spent install converges after one pass: the resend tries each
account once, re-stamps each, and reports.

Req 7's boundaries are unchanged and inherited, not re-implemented: the
candidate walk never includes metered/env routes (no silent rollover), and
mid-turn refusal-with-side-effects keeps today's "retry regardless" answer.

**Notices (req 10).** Every actual attempt is visible: a refusal emits
"«label» is out of quota — trying «next label»." (or the terminal failure),
and a turn that starts on a different account than the previous turn emits
"Continuing on «label»." with the true reason (recovered primary, refusal,
account removed — the `failoverNotice` wording discipline survives even though
the function it lived in does not). "Previous turn's account" is read from the
turn attribution record (section 5). All notices go through the persisted
in-turn path (CLAUDE.md transcript-persistence invariant).

## 4. Provisioning follows the turn (req 4)

The `agentPinned` write-once guard stops gating credentials. Each routed turn,
after selection:

1. **Identity check:** compare the session subtree's token with the chosen
   account root's token (access-token compare; `readClaudeAccessToken` exists,
   Codex gets the analogue).
2. **Match** → the existing per-turn freshness sync runs unchanged; its expiry
   guard is now safe *because* it only ever compares the same account's
   tokens.
3. **Mismatch or absent** → full `provisionProviderAccountCredentials`
   (preserves the conversation-state allowlist, so resume survives — verified
   in docs/150), and the resident process is retired if its captured account
   differs. This is the incident-fix hardening folded into the redesign: a
   wrong-account token can never survive to spawn time, so the "session spends
   account A while telemetry benches account B" poisoning class is closed by
   construction.

The `agent_pinned` column keeps only whatever non-credential semantics still
read it; if nothing does after this change, it is dropped in the same PR.

## 5. Account identity is process-scoped (design-context constraint)

- The spawn path already captures the credential route after env-prep
  (`capturedCredentialRoute`). That capture becomes the **only** account
  identity: attribution, refusal stamping, token write-back, and the
  pre-capture retirement check all read it. It is recorded per turn
  (`usage_turns` already stores it) — that record doubles as "previous turn's
  account" for notices.
- `sessions.provider_route_kind/id` lose every read AND write path in the
  same PR — the turn attribution record (`usage_turns`) already holds
  "previous turn's account", so nothing needs the session columns. They stay
  in the schema as dead legacy (no destructive migration), nothing more.
- **Restart with surviving containers:** a reattached resident process
  recovers its account by comparing the session's token file against the
  account roots. No match → it is simply retired on the session's next turn by
  section 4's mismatch branch. No new persistence.
- **Re-auth re-push** (`repushTokenToPinnedSessions`) becomes
  content-addressed: after account X re-authenticates, its fresh token is
  force-pushed into sessions whose subtree currently holds X's *old* token (by
  compare) and into live processes captured on X — instead of "sessions pinned
  to X".

## 6. Disconnect and sign-out shrink (req 3)

`deleteProviderAccount` drops the pinned-session enumeration, the
"choose a replacement account" 409, `switchedSessionIds`/`strandedSessionIds`,
and the per-session switching. What remains:

1. Refuse while a process captured on this account has a **running turn or
   in-progress background work** (req 7's 2026-08-03 decision plus req 13,
   now process-scoped) — the only 409 left, still naming the sessions to wait
   for.
2. Kill resident processes captured on the account.
3. Revoke per-session token copies **by content** (subtree token matches the
   account's), preserving conversation state.
4. Delete the row and the account root.

`signOutProvider` simplifies identically. `switchSessionProviderAccount` — the
manual "move this session to account X" — is deleted: with no pin there is
nothing to move; the user steers accounts through priority order and the
strategy (req 2). Client: `ProviderAccountsCard` loses the replacement picker,
the moved/stranded toasts, and every "pinned" string; disconnect is one click
plus, at most, the running-turn wait message.

## 7. What is deliberately NOT built

- No new subsystem, store, or background job: refusal memory is two existing
  columns with a narrower writer and a bounded reader; the attempt loop is the
  existing retry generalized; identity checks are byte compares of files
  already on disk.
- No proactive quota polling. The refresh button and rate-limit events remain
  the only fetch triggers (docs/161's 429 constraint) — req 12 makes polling
  unnecessary for correctness.
- No per-session account preference of any kind, visible or hidden (req 2).

## Migration summary

| State | What happens on deploy |
|---|---|
| Persisted benches (any age, any provenance) | Reinterpreted as refusal memory; the 30-min read cap bounds them immediately. Self-healing, no rewrite. |
| `sessions.provider_route_*` | No routing reads remain; dangling values are inert. |
| `sessions.agent_pinned` | Stops gating provisioning; dropped if nothing else reads it. |
| Poisoned per-session token copies (pre-78cdc658 residue) | Detected and replaced by section 4's identity check on the session's next turn. |
| String-credential benches | Gain the `exhausted_at` stamp on next refusal; until then the read cap treats the missing clock as "expired", i.e. eligible. |

## Key files

| Area | Files |
|---|---|
| Router + refusal memory | `provider-account-manager.ts`, `credential-store.ts`, `service-routing.ts` |
| Attempt loop | `turn-executor.ts`, `ws-handlers/agent-listeners.ts`, `ws-handlers/agent-rate-limits.ts` |
| Env-prep / provisioning | `session-agent-env.ts`, `token-sync-manager.ts`, `session-credentials.ts` |
| Process identity / capture | `ws-handlers/agent-execution.ts`, `runner-registry-factory.ts`, `bootstrap-managers.ts` |
| Disconnect / sign-out | `services/settings.ts`, `services/provider-account-switch.ts` (mostly deleted) |
| Client | `components/Settings/ProviderAccountsCard.tsx`, related stores/toasts |
| Deleted outright | `failoverPinnedSession`, `sessionNeedsAccountFailover`, `classifyRouteForTurn`, `reconcileHardExhaustion`, `isTrustedHealthySnapshot`, `switchSessionProviderAccount` |

## Test plan (guards, co-located)

- **Attempt loop:** refusal → next account in strategy order; all refused →
  terminal message with this turn's provider reset times; exclusion set bounds
  attempts to one per account; metered routes never entered.
- **Req 12:** a turn after an all-refused turn tries every account again;
  no selection path can return `all_exhausted` without attempts this turn.
- **Refusal memory:** blocks ≤30 min per stamp; honours a nearer stated reset;
  legacy row with no `exhausted_at` is eligible; healthy reading newer than
  the stamp clears it (including `usedPct: null` windows); refresh-button
  fetch clears it.
- **Provisioning:** wrong-account session token replaced before spawn;
  same-account fresher local token kept; resident process retired on account
  change and only then.
- **Req 13:** a resident process with tracked background work is not retired
  for a strategy move (the turn runs on its account instead) and blocks
  disconnect with the naming 409; the deferred move happens at the first
  clean turn.
- **Restart:** reattached process's account recovered by content; mismatch
  retires it on next turn.
- **Disconnect:** no pinned 409; running-process 409 still names sessions;
  copies revoked by content; conversation state preserved.
- **Notices:** persisted (history round-trip), one per actual attempt/change,
  correct labels and reasons.
- The existing guards that must keep passing: `turn-crash-commit`,
  `turn-drain-commit-ordering`, `ws-disconnect-resilience`,
  `provider-route-pinning` integration test (rewritten to assert the new
  contract), `auth-401-auto-retry`.
