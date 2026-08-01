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

## Requirements from standing product principles

Sourced from `CLAUDE.md` §1–§2 (human-authored, repo-wide), not from a specific
request for this feature.

10. Each connected account's quota state is visible inside ShipIt. Checking how
    much quota an account has left does not require opening a provider
    dashboard.
11. When ShipIt changes which account a session runs on, it says so where the
    user is already looking — in the session, not in an external tool.

## Open questions

- **All accounts exhausted.** When no connected account for the provider is
  usable, should ShipIt hold the user's prompt and start it automatically when
  the earliest window resets, or fail the turn immediately with the reset times
  and let the user resend?
- **Paid API billing as a last resort.** If a subscription is exhausted and an
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is configured on the host, may ShipIt
  fail over onto pay-as-you-go API billing, or must failover stay strictly
  between subscription accounts?
- **Mid-turn exhaustion after the agent already changed things.** If the account
  runs out after the turn has edited files, run commands, or pushed, should
  ShipIt retry on the next account anyway, or stop and ask the user before
  continuing?
- **Default posture.** Is automatic failover on by default for every provider,
  or opt-in per provider?
- **Next account cannot run the requested model.** If the next account in
  priority order lacks the selected model (different plan or tier), should
  ShipIt skip it and report that no account can serve the turn, or run the turn
  on a model that account does support?
- **Child sessions.** Should an agent-spawned child session inherit its parent's
  provider account, or pick its own account through the normal priority order?

## Provenance boundary

Requirements 1–9 are the user's words, restated as observable behavior.
10–11 come from the standing product principles in `CLAUDE.md`. Everything else
in this feature — the account registry and credential layout, route pinning,
retry-safety classification, delayed-turn persistence, capability snapshots,
migration, quota-polling shape, and phasing — is design inferred by the agent
and lives in `plan.md`. None of it is a requirement until it appears above.
