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
- **Balanced spreads sessions, strict is absolute (req 8, resolved
  2026-08-10).** Under `strict` the session moves back to the primary the
  turn it recovers, one process restart accepted. Under `balanced` the mode
  spreads **sessions** over accounts, not individual turns: selection takes a
  `residentRoute` option, and when the resident process's account is eligible
  and under its cutoff, that account is chosen; otherwise the normal
  least-recently-used walk runs. This is req 8's own definition of "better"
  for balanced — not a design-level tiebreak — so a session without a
  resident process still lands on the least-recently-used account, which is
  what spreads new work.
- The pre-capture check in `agent-execution.ts` becomes account-agnostic and
  trivial: run selection once before capturing the resident process; if the
  chosen account differs from the process's captured account (section 5),
  retire the process. No quota classification is involved — the router already
  answered.
- **Busy processes are never retired for a move (req 13, as built).** The
  guard reads `runner.backgroundWorkDescriptions` — the docs/235 tracker plus
  the live brokered-consult handles — at every place a process could be
  killed: the pre-capture release (`residentRouteNeedsRelease` answers false
  while busy), system-turn admission (`dispatchOnRunner` defers, with a
  drain nudge when the work clears), account disconnect/sign-out, string
  credential deletion, and the credential-change release. While busy, the
  turn runs on the resident process's own account regardless of what the
  strategy prefers (`requireResidentRoute`) — the documented exception to
  req 8 — and the move happens at the first clean turn. **Known limitation
  (follow-up):** the tracker half is a bounded hint — it expires ~10 minutes
  after the last refresh and the Codex CLI reports no background tasks — so
  a very long untracked background process can still lose its protection;
  the durable worker-side busy fact the review proposed remains open. The
  one case no guard can save: the process's own account refuses the turn
  mid-flight and the process dies of it; the provider killed it, not the
  router.

Non-turn work (`selectRouteForTurn` callers: voice, naming) honours refusal
memory exactly like a turn's first selection: blocked accounts are skipped,
and when everything is blocked the optional work simply does not run. Req 12
names the user's resend as the force-retry boundary, and background naming or
voice work is not that resend — an earlier draft let non-turn work bypass the
memory, which the cross-backend review correctly flagged as violating req 9's
"left alone" rule. Sub-agents keep their existing bounded multi-account retry
loop (`services/sub-agent.ts`) — already this design's attempt loop in
miniature — and gain only the refusal-memory read rule.

## 1b. The turn route object — the handoff pinning used to provide (reqs 1, 4, 11)

Today the session row IS the handoff between selection and everything
downstream: env-prep persists the choice into `sessions.provider_route_*`,
and the captured route (`turn-executor.ts`), run-parameter shaping
(`session-agent-run-params.ts`), local-mode `HOME` selection
(`local-agent-home.ts`), and the token write-back fallback all re-read that
row. Deleting the columns without a replacement deletes the only path from
selection to spawn — verified at those sites by the cross-backend review;
the plan's first draft missed it.

The replacement is a value, not a row: selection produces a **turn route**
`{ kind, id, serviceId, billingMode, label }`. `prepareSessionAgentEnvironment`
returns it, and the executor threads it — as a parameter, never via session
state — into provisioning, run-params, local `HOME`, listener wiring
(attribution and refusal stamping), and finalization/write-back. Each attempt
of the loop (section 3) re-runs selection and threads a fresh turn route.
This is the capture-at-turn-start discipline CLAUDE.md already mandates for
`sessionId`/`sessionDir`, applied to the route.

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
3. Stop on success, or when no candidate remains. The loop keeps a per-turn
   **attempt ledger** — route id, account label, the provider's original
   refusal message, and the parsed reset time for every attempt, preserved
   across the recursive respawns — and the terminal all-refused message is
   built only from that ledger: req 6 asks for what the provider actually
   said, not a derived timestamp. Env-prep's `ProviderRouteUnavailableError`
   keeps only the `auth_required` shape; `all_exhausted` can no longer be
   decided without trying.
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
"Continuing on «label»." — the change and the user's own labels, nothing
more. Req 10 asks for no reason, and deriving one (recovered primary vs
removal vs strategy) would need provenance machinery nobody would miss —
cut on the review's over-engineering finding. "Previous turn's account" is
read from the turn attribution record, which gains the route id for exactly
this (section 5). All notices go through the persisted in-turn path
(CLAUDE.md transcript-persistence invariant).

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
   in docs/150 for container mode), and the resident process is retired if its
   captured account differs. This is the incident-fix hardening folded into
   the redesign: a wrong-account token can never survive to spawn time, so
   the "session spends account A while telemetry benches account B" poisoning
   class is closed by construction.

   **Local-mode exception, stated rather than inherited:** `RUNTIME_MODE=local`
   (the dogfood inner instance) uses the account root as `HOME` directly, and
   `local-agent-home.ts` documents that an account switch starts a fresh
   provider-side thread there. That is pre-existing behavior, unchanged by
   this feature and acceptable for the dogfood-only mode — ShipIt's own
   transcript survives either way. Req 7's continuity guarantee is therefore
   scoped to container mode (review finding, accepted).

The `agent_pinned` column keeps only whatever non-credential semantics still
read it; if nothing does after this change, it is dropped in the same PR.

## 5. Account identity is process-scoped (design-context constraint)

- The turn route object (section 1b) is the in-turn identity. For a
  **resident** process it is promoted to typed runner state at spawn
  (`runner.residentRoute`, cleared on retirement) — today's
  `capturedCredentialRoute` is a closure local in `turn-executor.ts` that
  nothing outside the turn can query, and `appliedSpawnIdentity` is an opaque
  string derived from the session row (verified by the cross-backend review),
  so the promotion is the fix, not an optimization. The pre-capture check,
  req 13's guard, disconnect's process enumeration, and re-push all read
  `runner.residentRoute`.
- **`usage_turns` gains a `credential_route_id` column** (schema migration,
  `TurnAttribution` field, write in `usage.ts`). The review verified the
  current schema stores service, billing mode, and rates but NOT the account
  — this plan's first draft claimed otherwise and was wrong. The column is
  the durable "previous turn's account" for req 10's change notice.
- `sessions.provider_route_kind/id` lose every read AND write path in the
  same PR; the columns stay in the schema as dead legacy (no destructive
  migration), nothing more.
- **Restart with surviving containers (as built):** the plan proposed a worker
  status echo; the implementation recovers identity from the session's
  credential-subtree **account marker** instead (`turn-adoption.ts` →
  `recoverResidentRoute`). Equivalent and simpler: the marker is written by
  the only provisioning writer and any account change retires the process
  before reprovisioning, so a surviving CLI's account IS the marker — and the
  marker, unlike a status field, needed no worker wire change. The adopted
  turn seeds its route capture from the recovered stamp, so its refusals,
  rate-limit events, and write-back attribute correctly.
- **Re-auth re-push** narrows to live processes only: after account X
  re-authenticates, its fresh token is force-pushed into sessions whose
  `runner.residentRoute` names X. Idle sessions are deliberately excluded —
  their copies are inert residue that converges at the next turn's identity
  check, and enumerating them would rebuild, by content, the pinned-session
  walk this feature deletes (review's over-engineering finding, accepted).
- **Implementation-review triage (Codex run 9e2b302a, as built).** The
  cross-backend implementation review found nine issues; eight are fixed on
  this branch, one accepted:
  - An account-scoped re-push (re-auth and refresher) skips UNMARKED
    subtrees — an unmarked copy's identity is unknown, and force-pushing the
    re-authed account's token there was the poisoning class reopened
    (`app-lifecycle.ts`; guard in `claude-auth.test.ts`).
  - Failure policy (quota retry, auth-heal vs set-aside) branches on the
    turn's CAPTURED route via the `routeProfile` dep and
    `credentialFailurePolicyForRoute`; `credentialFailurePolicyFor` no longer
    reads the dead `provider_route_*` columns, so a pre-260 row cannot pin
    the decision (req 2).
  - The account-identity step (`ensureSessionAccountCredentials`) fails
    CLOSED: a provisioning error fails the turn visibly instead of spawning
    on whatever tree is on disk (req 4). Token sync-in stays best-effort by
    design — after the identity step it can only deliver a stale token of the
    RIGHT account, which the auth heal covers.
  - The attempt ledger's "resets at" quotes only a provider-STATED reset;
    the synthesized short lockout stays internal (req 6).
  - A turn that ends without usage telemetry (Codex compact) still records
    its `credential_route_id`, so the next turn's "Continuing on X" notice
    compares against the true previous route (req 10).
  - Exhaustion stamps are latest-wins: a re-probe's shorter stated reset
    supersedes an older longer estimate instead of `Math.max` (req 9).
  - `balanced` session-spreading covers string-delivered subscriptions: the
    `residentRouteId` option (renamed from `residentAccountId`) is honoured
    by the string walk too (req 8).
  - A per-session **resident-route record** (`.shipit-resident-route.json`,
    written at every routed pre-spawn stamp) recovers post-restart identity
    for string/env-delivered credentials, which leave no subtree marker;
    adoption prefers it and falls back to the account marker (reqs 11/13).
  - ACCEPTED: the background-work hint's 10-minute TTL and Codex's empty
    task list (req 13 limitation above), and local mode's fresh provider
    thread after an account switch — both documented design bounds.

## 5b. Every turn entry point, not just the WS path (reqs 1, 11, 13)

The first draft described only `agent-execution.ts`; the review named the
rest:

- **Dispatched/system turns** (`dispatched-turn.ts`) carry their own
  resident-capture and failover logic; both route through the same selection,
  turn-route threading, and busy guard. Today a system turn unconditionally
  kills an idle resident process, and dispatch admission checks only
  `runner.running` — under req 13 both must consult the composite busy fact,
  or a CI-fix turn destroys exactly the review req 13 protects.
- **Warm-up env-prep calls** (CI fix, session wake, headless create, child
  spawn) run before a turn exists. Env prep splits in two: an
  **account-neutral refresh** (token heal, scaffolding — safe pre-turn) and
  **turn-bound routing + provisioning**, which only a real turn performs. A
  warm-up selects nothing, so it cannot double-select against the turn that
  follows, and a warm container stays account-neutral as today.
- **String-credential lifecycle (req 11).** `stringSelectionFor`
  (`service-routing.ts`) gets the same contract as the account walk: the
  refusal-memory read rule, the per-turn exclusion set, and req 12's
  ignore-on-all-refused. Its Settings surface gets the same req 13 guard:
  credential deletion (`services/credential-routes.ts`, unguarded today) and
  the change-triggered resident release (`api-routes-bootstrap.ts` /
  `resident-spawn-guard.ts`, which checks only `runner.running`) must not
  kill a busy process. The UI lives in `ServicesPanel.tsx`, not
  `ProviderAccountsCard.tsx`; it never had pinning strings and gains only
  the wait message.

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
| Process identity / capture | `ws-handlers/agent-execution.ts`, `runner-registry-factory.ts`, `bootstrap-managers.ts`, `session/agent-controller.ts` + `shared/types/agent-types.ts` (worker status route echo), `usage.ts` + `shared/database.ts` (attribution column) |
| Dispatched / warm-up entry points | `dispatched-turn.ts`, `resident-spawn-guard.ts`, `services/github-ci-fix.ts`, `wake-session.ts`, `services/headless-sessions.ts`, `services/child-sessions.ts`, `services/sub-agent.ts` |
| String-credential surface | `service-routing.ts` (`stringSelectionFor`), `services/credential-routes.ts`, `api-routes-bootstrap.ts`, `components/Settings/ServicesPanel.tsx` |
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
- **Turn route threading:** no routing read of `sessions.provider_route_*`
  anywhere on the turn path; run-params, local `HOME`, write-back, and
  attribution all receive the turn route as a parameter.
- **Attribution column:** `usage_turns.credential_route_id` round-trips; the
  change notice reads the previous turn's account from it.
- **Worker echo:** an adopted post-restart turn attributes a refusal to the
  route the worker reported, not to a session row.
- **Entry points:** a system/dispatched turn respects the busy guard; a
  warm-up env-prep call selects and provisions nothing; string-credential
  deletion and change-release refuse while a process is busy; the
  string-credential walk honours exclusion set and req 12.
- **Attempt ledger:** the all-refused message contains each attempt's label,
  provider message, and reset time.
- The existing guards that must keep passing: `turn-crash-commit`,
  `turn-drain-commit-ordering`, `ws-disconnect-resilience`,
  `provider-route-pinning` integration test (rewritten to assert the new
  contract), `auth-401-auto-retry`.
