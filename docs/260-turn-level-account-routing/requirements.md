---
issue: planning#347
title: Turn-level account routing — requirements
description: Remove session→account pinning; choose the subscription account per turn and let the harness be the authority on quota.
---

# 260 — Turn-level account routing: requirements

No design exists yet. The design document (`plan.md`) must not be written while
`## Open questions` below is non-empty, and it will implement these requirements
when it exists.

These requirements are in Nik's words, from the 2026-08-10 conversation that
diagnosed the stuck "Every connected Claude account is out of quota" sessions.
They replace the session-pinning model of docs/150 for routing; what docs/150
built for credential storage, account rows, and quota telemetry stays unless a
requirement below contradicts it.

## Requirements

1. Every turn chooses the provider account it runs on, at the start of that
   turn, from the selection strategy and the quota left. Nothing else fixes a
   session to an account across turns.

2. There is no concept of a session being pinned to an account — not in
   routing behavior, not in Settings, not in any message the user reads.

3. Disconnecting or deleting an account never tells the user about sessions
   pinned to it, and never asks where those sessions should move. The account
   goes away; each session's next turn routes normally among the accounts that
   remain.

4. A turn always authenticates as the account that was chosen for it. Whatever
   token the session's container held before the turn does not influence the
   choice, and holding a stale or wrong-account token must never make the turn
   run as a different account than the chosen one. The correct credentials are
   put in place at the start of the turn.

5. The harness's own refusal is the authoritative "out of quota" signal.
   ShipIt's quota data (the usage API, rate-limit events, remembered failures)
   may order the accounts, but it must never block a turn on an account that
   was not actually tried.

6. When ShipIt's own knowledge says no account has quota, the turn still tries
   the accounts with the user's payload. The turn fails only when every
   account has actually refused it, and the failure message reports what the
   provider said, including reset times the provider reported.

7. Prior decisions that stay in force (from docs/150, previously approved):
   a spent subscription never silently rolls onto metered API-key billing;
   the conversation survives an account change (resume state is
   account-agnostic, verified in docs/150); credentials are never rewritten
   under a turn that is running right now (decision of 2026-08-03).

8. The strategy always wins. When a better account (per the selection
   strategy) becomes eligible again, the next turn moves onto it — even when
   the session's resident CLI process runs on another account. The restart
   cost of that process is accepted; the conversation is preserved.

9. A quota refusal reported by the harness is remembered: the account is left
   alone until the provider-stated reset time, but re-tried after at most
   ~30 minutes. When ShipIt's quota data says an account is out of quota, the
   account is still tried once to confirm — and after that refusal it is left
   alone on the same terms. The memory clears early on newer real account
   data showing the account healthy again — reported by the harness or
   fetched from the provider's usage API. Example: the user upgrades their
   plan and presses the quota refresh button in the UI; the account must be
   tried again on the next turn, even though its refusal was remembered.
   An account is never blocked without having been tried.

10. The transcript shows every actual attempt: a refused attempt is shown
    when it happens, and a turn that runs on a different account than the
    previous turn says so, in the user's own account labels. Requirements 9
    and 12 keep this from repeating on its own: identical notices recur only
    when the user resends while every account is spent, and then they are the
    answer to a question the user just asked.

11. This applies to every subscription-shaped credential: Claude accounts,
    Codex/ChatGPT accounts, and subscriptions that are signed in with a
    pasted API key instead of a login flow (ShipIt calls these
    string-delivered; the GLM coding plan is the current example). The key
    shape bills like a subscription and runs out like one, but today it has
    no recovery path at all once marked spent, so it needs this feature most.

12. A turn that ends with every account refused must not poison the next
    one: the next turn tries all the accounts again, in strategy order,
    regardless of any remembered refusals. Resending the message is the
    user's forceful retry — there must be no state in which ShipIt believes
    every account is out of quota and refuses to try any of them.

13. A resident agent process with background work in progress — a sub-agent
    review, or any background process the agent started — is not killed for
    an account move. Killing it would lose the tokens already spent on that
    work, which costs more than one turn on a less-preferred account. The
    move waits until the process is clean; this refines requirement 8, and
    it applies to disconnect as well: the account cannot be taken away from
    under such a process, so the user is asked to wait, exactly as for a
    running turn.

## Design context — constraints, not requirements

The agent supplied these during the diagnosis; they bound the design but are
not user-observable requirements.

- **Account identity is process-scoped.** "This container holds account X's
  token" is a fact about a live turn or a resident CLI process, not about the
  session. Attribution, benching, and token write-back use the account
  captured for the running process (as the failover-attribution fix already
  does). A reattached resident process after an orchestrator restart must
  recover its account identity from the process/turn record or by comparing
  the session's token file against the account roots — not from a session row.
- **Idle residue is inert.** Between turns, with no resident process, the
  on-disk token copy is residue. Req 4 makes it harmless for turns; disconnect
  removes copies by content (compare tokens), not by reading a pin.
- **Provisioning nuance under req 4.** Replacing a *wrong-account* token is
  unconditional. A freshness guard may still keep the *same account's* newer
  locally-refreshed token — the account-blind expiry guard in
  `token-sync-manager.ts` is exactly the bug shape req 4 forbids.
- **Resident-process churn.** Switching accounts kills a resident CLI process
  (seconds of latency, conversation preserved). Req 8 accepts this: the
  strategy wins; stickiness is at most a tiebreak among equally-ranked
  accounts.
- **Repeated-refusal cost.** Bounded by req 9: a refusal is remembered until
  the stated reset with a ~30-minute re-probe cap, and cleared early by newer
  healthy account data. The remembered refusal is still harness-reported, so
  it does not violate req 5, and the cap plus req 12's all-refused retry
  prevent the unbounded memory that recreated the stale-bench deadlock this
  feature removes. Accepted cost: while every account is genuinely spent,
  each resend tries each account once (a few seconds per attempt) — that is
  the user's own forceful retry, not background churn.
- **Machinery this deletes** (the 2026-08-10 trace found all three permanent
  stuck states inside it): the bench-vs-snapshot reconciliation
  (`reconcileHardExhaustion`, `isTrustedHealthySnapshot`, the `exhaustedAt`/
  `updatedAt` precedence clocks in `provider-account-manager.ts`), the
  pinned/unpinned routing split (`failoverPinnedSession` in
  `services/provider-account-switch.ts`, `classifyRouteForTurn` vs
  `selectAccountForTurn`), the `agentPinned` write-once provisioning guard and
  pinned-route short-circuit in `session-agent-env.ts`, and the
  pinned-session enumeration in the disconnect/sign-out services and UI.
- **Why now** — the failure this prevents: a benched account structurally
  cannot produce the fresh quota snapshot that would clear its own bench
  (turns are the main snapshot source and the bench blocks the turn); legacy
  benches became permanently uncleardable via the `updatedAt` clock; every
  orchestrator restart made all persisted benches authoritative again.
  Details in the conversation record and planning tracker issue.

## Open questions

- **Balanced mode vs resident processes.** Under `balanced`
  (least-recently-used ordering) a literal per-turn reading moves a
  two-account install to the other account on every turn — killing the
  resident CLI process each time, because the account a session just used
  always sorts last. Requirement 8 was answered for strict priority and did
  not decide this case, and the cross-backend design review flagged that a
  "resident-process tiebreak" would quietly change what `balanced` means.
  Options: (a) `balanced` spreads **sessions** — a session's resident process
  keeps its account while that account stays eligible and under its cutoff
  (recommended: it matches the mode's stated purpose of avoiding pile-up and
  avoids a process restart on every turn); (b) `balanced` spreads **turns** —
  literal least-recently-used, accepting the churn.

## Resolved questions

- 2026-08-10 — Moving back when a better account recovers (strict priority,
  resident process on the secondary)? Nik: follow the strategy — the next
  turn moves back. Recorded as requirement 8.
- 2026-08-10 — How long is a harness refusal remembered? Nik: until the
  provider-stated reset, with a ~30-minute re-probe cap. Recorded as
  requirement 9.
- 2026-08-10 — Transcript notices for account attempts? Nik: show every
  actual attempt — and rejected the "noisy" concern as wrong: a refused
  account is left alone until it recovers (requirement 9), so an account is
  tried once when our data says it is out of quota, not on every turn.
  Recorded as requirement 10.
- 2026-08-10 (doc review) — What clears a remembered refusal? Nik: real
  account data, reported through the harness or the usage API — e.g. the
  user upgrades their plan and refreshes the quota in the UI; ShipIt must
  then try that account again even though it was already tried. Added to
  requirement 9.
- 2026-08-10 (doc review) — What if no account could pick up a turn? Nik:
  the next turn still tries all the accounts using the strategy, so a
  wrong "out of quota" belief can never deadlock routing; resending is the
  user's forceful retry. Recorded as requirement 12.
- 2026-08-10 (during design) — Nik: a resident process with an in-progress
  sub-agent review or agent-started background processes must not be killed
  for an account move — the cost would be the tokens already spent on that
  work. Recorded as requirement 13.
- 2026-08-10 — Scope across credential shapes? Nik: all subscription-shaped
  credentials — Claude accounts, Codex accounts, string-delivered
  subscriptions. Recorded as requirement 11.

- 2026-08-10 — Should the standalone incident fix (per-session token identity
  check) ship before this rework? Nik: no — sessions recovered on their own,
  the poisoning source was already fixed, and req 4 subsumes the repair. The
  unconditional-provisioning statement in req 4 exists so review checks that
  the account-blind expiry guard does not survive the refactor.
- 2026-08-10 — Is a persisted "currently provisioned account" record needed
  between turns? Nik: only within a turn. The correct token is provisioned at
  the start of the next turn; idle sessions carry no meaningful account
  identity. Captured above as the process-scoped identity constraint.
- 2026-08-10 — Should ShipIt proactively refresh quota when routing is
  blocked? Superseded by reqs 5–6: telemetry never blocks, so there is
  nothing to refresh out of.
