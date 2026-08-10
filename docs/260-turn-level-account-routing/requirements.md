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
  (seconds of latency, conversation preserved). How much the router should
  prefer the currently-running process's account is Open question 1.
- **Repeated-refusal cost.** With every subscription genuinely spent, req 6
  naively spawns and fails once per account on every message. How long a
  provider refusal may be remembered is Open question 2 — a remembered refusal
  is still harness-reported, so it does not violate req 5, but an unbounded
  memory recreates the stale-bench deadlock this feature exists to remove.
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

- **Q1 — moving back when a better account recovers.** Strict-priority mode:
  a session's resident process runs on the secondary account and the primary
  becomes eligible again. Should the next turn move back to the primary
  (restart the resident process, a few seconds), or stay on the secondary
  while it remains eligible? Recommendation: follow the strategy — move back;
  stickiness is only a tiebreak, mainly relevant under `balanced`.
- **Q2 — how long a harness refusal is remembered.** Options: (a) until the
  provider-stated reset time; (b) until the stated reset but never longer
  than a fixed cap (e.g. 30–60 min) without re-probing; (c) not at all —
  always try. Recommendation: (b); the cap is the insurance against
  wrong-attribution bugs making a remembered refusal stale.
- **Q3 — transcript notices for account changes.** When a turn runs on a
  different account than the previous turn, or hops accounts mid-turn after a
  refusal: one notice per actual change, a notice for every attempted hop, or
  silence? Recommendation: one notice per actual change, in the user's own
  account labels, as today.
- **Q4 — scope across credential shapes.** Apply the same turn-level model to
  Codex/ChatGPT accounts and to string-delivered subscriptions (e.g. GLM
  coding plan), or Claude accounts only first? Recommendation: one policy for
  every subscription-shaped credential; the string shape currently has no
  bench-recovery path at all, so it needs this most.

## Resolved questions

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
