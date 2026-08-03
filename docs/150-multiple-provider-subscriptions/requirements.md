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

**Follow-up user requirement**, 2026-08-02:

> all legacy behavior and code related to agent accounts need to be cleaned up
> after all work is done.

**Requirement 17 reversed by the user**, 2026-08-02:

> So this is a corner case that I'm not sure is important. Let's, instead of it
> being a requirement, mark it as a non-go. So essentially, if the user adds two
> accounts with different model capabilities, it's kind of their own issue and
> should not automatically work around it. But the error should be clear when we
> try to use a model that's not supported, without automatic recovery.

## User-sourced requirements

(Numbers are stable IDs, not an ordering. 10 and 11 live in the next section;
12–18 were added later than 10–11 and keep their original IDs.)

1. A user can connect more than one subscription account for the same agent
   provider — for example two Anthropic accounts, or two ChatGPT accounts.
2. The connected accounts for a provider form an ordered list whose order the
   user controls. What that order *means* is set by the provider's account
   selection mode (req 21): under strict priority it is the order accounts are
   tried in; under peer balancing it is the display and tie-break order, not a
   statement about which account should run the work.
3. When the account in use is exhausted, ShipIt continues the user's work on
   another connected account for the same provider automatically. The user does
   not sign out, switch browser profiles, restart containers, or move
   credentials by hand.
4. Each provider has a user-configurable short-window usage cutoff and a
   user-configurable weekly usage cutoff.
5. Both cutoffs default to 90%.
6. Reaching either cutoff moves work to the next eligible account, chosen by the
   provider's account selection mode (req 21). Failover is proactive at the
   cutoff, not only on hard exhaustion.
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
17. ShipIt does not route around an account that cannot run the requested
    model. Connecting accounts with different model access is the user's own
    choice to manage. When a turn runs on an account that cannot serve the
    requested model, the failure is reported clearly, and is not automatically
    retried, substituted, or worked around.
18. An agent-spawned child session picks its own account through the normal
    priority order. It does not inherit the parent session's account.
19. When the feature is finished, the legacy single-account behaviour and the
    code supporting it are gone. The compatibility shims kept while migrating
    are a migration step, not a permanent second way for provider accounts to
    work.
20. Provider-account selection and quota failover apply to every
    provider-authenticated agent run, including regular session turns and
    brokered one-shot runs used for cross-agent reviews (`shipit agent run`). A
    review does not fail on an exhausted account while another eligible
    subscription account for the same provider is configured.
21. Each provider has a user-selectable account selection mode, with two
    settings:
    - **Strict priority** — work starts on the highest-ranked eligible account,
      and a lower-ranked account is used only while the ones above it are not
      eligible.
    - **Peer balancing** — work is spread across all eligible accounts so their
      quota is consumed at a comparable rate, rather than one account being
      drawn down to its cutoff while another sits unused.

    Strict priority is the default, so an install that never touches the setting
    behaves as it does today. The mode governs which account work *starts* on;
    it does not govern *whether* failover happens, which is always on (req 15).
22. ShipIt distinguishes connected accounts by the provider's own account
    identity, not only by a name the user typed.
    - A newly connected account is labelled with the identity the provider
      reports — the account's email where the provider gives one — rather than a
      generic "account 2". The user can still rename it afterwards.
    - Connecting an account that is already connected does not silently produce
      a second row for it. Two rows that are secretly the same provider account
      share one quota pool, which makes failover between them a no-op that burns
      a retry and reports a confusing error.

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

- **When a completed connect resolves to an account that already has a row, what
  should happen to it (req 22)?** Adopting the new credentials onto the existing
  row looks strictly better than the alternatives — it avoids discarding a
  sign-in the user has already completed, and it doubles as the repair path for a
  row whose token went stale — but refusing the connect outright and warning
  while creating the duplicate anyway are both defensible, and the choice is the
  user's rather than an inference to make here. Requirement 22 states only that a
  duplicate row is not created *silently*.
  *Scope: this gates implementing req 22 only. Requirements 1–21 are unaffected
  and their implementation is unblocked.*

## Resolved questions

- 2026-08-03 — Does ShipIt read a Claude account's real identity, and what for?
  **Read it, and use it for both labelling and duplicate detection.** Codex
  identity was already available (`chatgpt_account_id`, decoded from the
  `id_token` claim), but Claude had no confirmed equivalent, which is what left
  the Phase 0 item open. Verified in code rather than assumed:
  `.credentials.json`'s `claudeAiOauth` carries only `subscriptionType` and
  `rateLimitTier` — plan data, so two different accounts on the same plan are
  indistinguishable by it — while the CLI's separate `.claude.json` carries
  `oauthAccount` with `emailAddress` and `accountUuid`. ShipIt already preserves
  that file across reprovisioning (`session-credentials.ts`) without ever reading
  it for identity. Became requirement 22. Which field is the stable key
  (`accountUuid`, since an email can change) and which is shown to the user is
  design detail and lives in `plan.md`.
- 2026-08-03 — Should concurrent turns spread across accounts or stay on the
  highest-priority one? **Neither as a fixed rule — the user chooses, per
  provider.** An ordered list already expresses intent when accounts are unequal
  (Max 20x before Pro, work before personal), but it cannot express "these two
  are peers", and under strict order alone an equal-accounts user watches one
  account reach its cutoff while the other sits unused. Became requirement 21,
  and amended requirements 2 and 6, which had both stated priority order as the
  universal model rather than as one of two. Two code findings narrowed the
  scope: turns are serialized per session (`turn-executor.ts` — `runner.running`
  plus a queue) and each session pins its route and reuses it
  (`session-agent-env.ts:349`), so "concurrent turns" always means turns in
  *different* sessions, and the mode only decides what a session pins at pin
  time. A separate in-flight-turn counter, considered alongside this to stop
  concurrent turns overshooting a cutoff, was dropped: the existing per-turn
  re-check of a pinned account already bounds the overshoot, and the counter was
  the one piece needing correct decrement on every terminal path including
  crashes.

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
- 2026-08-02 — **Requirement 17 reversed.** Skip-and-report is now a non-goal:
  "if the user adds two accounts with different model capabilities, it's kind of
  their own issue and should not automatically work around it. But the error
  should be clear when we try to use a model that's not supported, without
  automatic recovery." Prompted by the finding that nothing can populate
  per-account model capability without lying about it — `agent_init` reports
  only the model that *ran*, and writing that into the capability whitelist
  would make one observation refuse every other model. Rather than build a
  second-guessing mechanism for a corner case, ShipIt does nothing and surfaces
  the provider's error. Requirement 17 rewritten above; the previous
  skip-and-report wording, the `no_model_eligible_account` selection failure,
  and the `capabilities.models` check are removed rather than left dormant.
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
- 2026-08-02 — The parent review found that brokered one-shot reviews bypassed
  normal turn routing and stopped on the first exhausted subscription. The
  human requirement is that provider-account selection and quota failover cover
  every provider-authenticated run, expressly including `shipit agent run`.
  Became requirement 20.

## Provenance boundary

Requirements 1–9 are the user's words, restated as observable behavior.
12–18 come from the user's answers and review feedback, each with a dated
receipt under "Resolved questions" (16 came directly as a requirement, so it has
no question to resolve). 19 came directly as a requirement on 2026-08-02 and
likewise has no question to resolve. Requirement 20 came directly from the
2026-08-02 parent review and is recorded above; *what* counts as legacy is design detail
and lives in `plan.md`, not here. 21 and 22 come from the user's answers to the
two Phase 0 questions on 2026-08-03, each with a receipt below; 21 is the user's
own proposal (a setting rather than either fixed behavior) and is the reason 2
and 6 were amended. 11 comes from the standing product principles in
`CLAUDE.md`; 10 started there and the user then specified its shape in review.
Everything else
in this feature — the account registry and credential layout, route pinning,
capability snapshots, migration, quota-polling shape, and phasing — is design
inferred by the agent and lives in `plan.md`. None of it is a requirement until
it appears above.
