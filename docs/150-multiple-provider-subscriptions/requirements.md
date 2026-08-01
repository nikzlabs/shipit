# Requirements — Multiple provider subscriptions and quota failover

## Source

Human inputs, kept verbatim so the boundary between stated intent and design
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

**Review feedback on this file**, 2026-08-01:

> let's add a requirement that connecting an account UI should be the same for
> the first and for subsequent accounts. Now they diverge.

> [quota visible inside ShipIt] yes, as a pill like it already works now. The
> pill should have the name of the account.

> [next account cannot run the requested model] skip it and report

> [child sessions] normal order.

> [transcript and workspace preserved] I believe claude does this automatically,
> using the same session id. Please check, also for codex.

## User-sourced requirements

(Numbers are stable IDs, not an ordering. 10 and 11 live in the next section;
12–18 were added later than 10–11 and keep their original IDs.)

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
16. Connecting an account uses the same UI for the first account and for every
    subsequent account. The two flows must not diverge as they do today.
17. If the next account in priority order cannot run the requested model, ShipIt
    skips it and reports that no account can serve the turn. It does not
    silently substitute a model that account does support.
18. An agent-spawned child session picks its own account through the normal
    priority order. It does not inherit the parent session's account.

## Requirements from standing product principles

Sourced from `CLAUDE.md` §1–§2 (human-authored, repo-wide), not from a specific
request for this feature.

10. Each connected account's quota state is visible inside ShipIt as a
    subscription-limits pill, the same pill that works today, labelled with the
    account's name. Checking how much quota an account has left does not require
    opening a provider dashboard. (Confirmed by the user in review; the pill
    shape and per-account naming are their words, not an inference.)
11. When ShipIt changes which account a session runs on, it says so where the
    user is already looking — in the session, not in an external tool.

## Open questions

None. Implementation is unblocked.

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
- 2026-08-01 — If the next account cannot run the requested model, skip it and
  report, or substitute a model it does support? **Skip it and report.** Became
  requirement 17.
- 2026-08-01 — Do child sessions inherit the parent's account or route
  independently? **Normal priority order.** Became requirement 18; closes the
  Phase 0 checklist item that had this undecided.
- 2026-08-01 — Does preserving the conversation across an account switch need
  ShipIt to rebuild context, or does the agent resume on its own from the same
  session id? **The user was right — resume is local, and no requirement
  changed.** Verified in code: Claude's `--resume <id>`
  (`agents/claude/process.ts:197`) reads
  `.claude/projects/<encoded-cwd>/<id>.jsonl`, and Codex's `thread/resume`
  (`agents/codex/codex-event-handler.ts:682`) reads
  `.codex/sessions/.../rollout-*.jsonl` — both files live in the session's own
  credential subtree, which is mounted per session and carries no account
  identity. Neither provider validates the conversation against the
  authenticated account. So an account switch does not by itself break resume;
  what would break it is the design's own rm-then-copy reprovisioning step
  deleting those files. `plan.md` now preserves the conversation-state subpaths
  (the same allowlist `token-sync-manager.ts` already uses for the docs/153
  repair) instead of clearing `agentSessionId` and rebuilding a replay package.

## Provenance boundary

Requirements 1–9 are the user's words, restated as observable behavior.
12–18 come from the user's answers and review feedback, each with a dated
receipt under "Resolved questions" (16 came directly as a requirement, so it has
no question to resolve). 11 comes from the standing product principles in
`CLAUDE.md`; 10 started there and the user then specified its shape in review.
Everything else
in this feature — the account registry and credential layout, route pinning,
capability snapshots, migration, quota-polling shape, and phasing — is design
inferred by the agent and lives in `plan.md`. None of it is a requirement until
it appears above.
