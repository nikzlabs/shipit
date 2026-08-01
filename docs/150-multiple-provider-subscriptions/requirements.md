# Requirements — Multiple provider subscriptions and quota failover

## Source

Two human inputs, kept verbatim so the boundary between stated intent and design
inference stays checkable.

**SHI-56** (user-authored issue):

> Multiple provider subscriptions and quota failover
>
> Allow multiple subscription accounts for the same agent provider and
> automatically fail over when the active subscription is exhausted.

**Follow-up user requirement**, recorded 2026-08-01 in `plan.md` →
"Requirement provenance": accounts form a user-controlled prioritized list per
provider; both the short subscription window and the weekly window have
user-configurable usage cutoffs; both default to 90% and reaching either cutoff
advances to the next eligible account; and this applies to existing sessions,
with the ShipIt transcript and workspace context preserved across the switch.

## User-sourced requirements

1. A user can connect more than one subscription account for the same agent
   provider — for example two Anthropic accounts, or two ChatGPT accounts.
2. The connected accounts for a provider form a prioritized list whose order the
   user controls.
3. When the account in use is exhausted, ShipIt continues the user's work on
   another connected account for the same provider automatically. The user does
   not sign out, switch browser profiles, restart containers, or move
   credentials by hand.
4. Each provider has a user-configurable short-window usage cutoff and a
   user-configurable weekly usage cutoff.
5. Both cutoffs default to 90%.
6. Reaching either cutoff moves work to the next eligible account in the user's
   priority order. Failover is proactive at the cutoff, not only on hard
   exhaustion.
7. Hard exhaustion reported by the provider fails over immediately, regardless
   of where the configured cutoffs are set.
8. Failover applies to turns in existing sessions, not only to newly created
   sessions.
9. When an existing session moves to another account, its ShipIt transcript and
   workspace context are preserved. Quota pressure never forces the user to
   abandon a conversation and start a new session.

12. Failover only ever moves a turn between connected subscription accounts for
    the same provider. ShipIt never switches a turn onto pay-as-you-go API
    billing (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) because a subscription ran
    out. Those remain a manually chosen auth path.
13. When no connected account for the provider can run the turn, ShipIt fails
    the turn immediately and tells the user when the earliest window resets. It
    does not hold the prompt for later.
14. When hard exhaustion happens partway through a turn, ShipIt retries on the
    next eligible account regardless of what that turn has already done.
15. Automatic failover is on by default for every provider. Connecting a second
    account is enough to enable it; no separate opt-in.

## Requirements from standing product principles

Sourced from `CLAUDE.md` §1–§2 (human-authored, repo-wide), not from a specific
request for this feature.

10. Each connected account's quota state is visible inside ShipIt. Checking how
    much quota an account has left does not require opening a provider
    dashboard.
11. When ShipIt changes which account a session runs on, it says so where the
    user is already looking — in the session, not in an external tool.

## Open questions

- **Next account cannot run the requested model.** If the next account in
  priority order lacks the selected model (different plan or tier), should
  ShipIt skip it and report that no account can serve the turn, or run the turn
  on a model that account does support?
- **Child sessions.** Should an agent-spawned child session inherit its parent's
  provider account, or pick its own account through the normal priority order?

## Resolved questions

- 2026-08-01 — When every connected account is out of quota, should ShipIt hold
  the prompt until reset or fail fast? **Fail fast, showing the reset times.**
  The user resends. Became requirement 13; removes the persisted delayed-turn
  record, the orchestrator wake-up timer, the attachment-staging step, and the
  queue-hold rules the design had assumed.
- 2026-08-01 — May failover fall back to pay-as-you-go API billing when a
  subscription is exhausted? **No — subscriptions only.** Became requirement 12;
  confirms the design's existing treatment of `codex-api-key` / `claude-api-key`
  as non-failover routes.
- 2026-08-01 — If quota runs out mid-turn after the agent has already edited
  files or run commands, retry anyway or stop and ask? **Always retry on the
  next account.** Became requirement 14; removes the side-effect gate, the
  per-turn side-effect tracking, and the read-only tool allowlist from the
  design.
- 2026-08-01 — Is automatic failover on by default or opt-in per provider?
  **On by default.** Became requirement 15.

## Provenance boundary

Requirements 1–9 are the user's words, restated as observable behavior.
12–15 come from the user's answers recorded under "Resolved questions".
10–11 come from the standing product principles in `CLAUDE.md`. Everything else
in this feature — the account registry and credential layout, route pinning,
capability snapshots, migration, quota-polling shape, and phasing — is design
inferred by the agent and lives in `plan.md`. None of it is a requirement until
it appears above.
