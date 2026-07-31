# Self-merge wake — checklist

ShipIt performs no git work on this path; the rebase is the agent's own work inside
its turn. Anything that looks like a git coordinator, preparation lease, or reset
staging has been cut deliberately — see the plan's "Why ShipIt doing the git work was
the expensive idea".

The five dispatch defects the earlier drafts surfaced (SHI-254, 255, 258, 259, 260)
are all fixed and merged. They are no longer prerequisites; this design simply reuses
the delivery path they repaired.

## Watch state

- [ ] Distinct `SelfMergeWatch` type (anchor `{prNumber, headSha}`, `followUp`, `cardId`)
- [ ] `self_merge_watch` column + migration
- [ ] States: `armed → delivered`; terminal `expired`, `cancelled`, `superseded`, `delivery-failed`
- [ ] Shared exhaustive pending predicate driving the list query, retry supervisor, and polling gate
- [ ] `listPendingSelfMergeWatches` separate from the child list (no misrouting into the child handler)

## Arm surface

- [ ] `--self` + `--then-file` (stdin via `-`) on `notify-on-merge`; inline `--then` rejected
- [ ] Validate non-empty + bounded length in shim **and** orchestrator
- [ ] Exactly one of `<child-id>` or `--self`; `--then-file` required with `--self`
- [ ] Arm route refuses: archived session, existing non-terminal watch, no branch, unparseable GitHub remote
- [ ] Cancel route (carries `watchId`, so a stale card action can't hit a newer watch)
- [ ] Container-accessible route golden test

## Delivery

- [ ] Fire from `onMergeDetectedCb` **after** `markMergedAndPruneExcess` resolves
- [ ] Carry `{prNumber, headSha}` into the merge callback (signature change)
- [ ] Anchor check — a superseded PR moves the watch to `superseded`, never retargets
- [ ] Closed outcomes fan out from `onPrTerminalState` → expire, **no turn**
- [ ] `self` branch in `buildWakeTurnPrompt` (shared escape clause)
- [ ] Prompt states: branch is at the merged tip; reset to latest base; **force-push with lease**; don't re-apply shipped work
- [ ] Dispatch via `prepareDispatch`; advance only on `status === "completed"`
- [ ] Don't assume a settlement always arrives (setup throws can leave the handle pending)
- [ ] Reuse the SHI-258 retry supervisor; no second one
- [ ] Pending self-watches keep `PollingGlobalGate` open
- [ ] Woken turn's re-arm refused server-side

## Arm card

- [ ] Arm via `emitChatCard`; transitions via `persistCardTransition`
- [ ] `persistCardTransition` works with **no runner** (the `expired` path starts none)
- [ ] Terminal states as blocks on the same card (the `ChildMergedCard.deliveryFailure` precedent)
- [ ] `cardId` stored on the watch; card repairable from watch state
- [ ] Persisted field + column + migration + `toRow`/`fromRow`; rehydrate in `loadSessionHistory`
- [ ] `CARD_MESSAGE_FIELDS` + `EVERY_OPTIONAL_FIELD_MESSAGE`; WS type in `TRANSCRIPT_SCOPED_MESSAGES`
- [ ] Client card component + handler + cancel

## Tests

- [ ] Arm refusals: archived, existing watch, no branch, unparseable remote, inline `--then`, empty/oversized instruction
- [ ] Fires after merge bookkeeping, not before (remote-branch race)
- [ ] Closed-unmerged expires with no turn; card records it
- [ ] Superseded anchor does not retarget the instruction
- [ ] Delivery failure retries on the SHI-258 backoff → `delivery-failed`
- [ ] Wake-turn runs as a system turn behind a busy session and settles
- [ ] Re-arm from the woken turn refused
- [ ] Card round-trip, no duplicate on replay, `expired` with no runner
- [ ] Auto-merge path: merge observed with no viewer + reaped container still delivers

## Docs

- [ ] `src/server/shipit-docs/sessions.md` — `--self --then-file`, one-turn rule
- [ ] `docs/196-session-notify-on-merge/plan.md` — cross-reference the self variant

## Considered, not v1

- [ ] `shipit` subcommand wrapping the reset, so the agent invokes tested code rather
      than reconstructing base/lease/deleted-branch handling from the prompt
