# Checklist — Merge it when the checks pass

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).
Depends on `docs/287-agent-merge-per-repo` being shipped first.

## The request

- [ ] `agent_merge_claims` gains `origin`, `revoked`, the `pending` state, repo index
- [ ] `--auto` records a request instead of refusing on pending checks (req 1)
- [ ] `--auto` never merges inline, even when the checks are already green
- [ ] A second `--auto` is refused while a row is `merging` or `settling`
- [ ] `merging` / `settling` stay monotonic; every lifecycle clear acts on
      `pending` rows only
- [ ] Terminal handling for a `pending` row: merged at `expected_sha` → settle
      with the narrow attribution; terminal at another head → cancel as
      moved-head (req 3); closed unmerged → delete with a notice

## Execution

- [ ] Executor runs in the poller's existing tick
- [ ] Requests feed the polling supervisor and the global gate: loaded at
      startup, `ensure()`d on arm, ticked with no viewer and no tracked session (req 5)
- [ ] Activated only after `reattachInFlightTurns()` completes
- [ ] Predicate is `expected_sha`, not local HEAD (there may be no worktree) (req 2)
- [ ] Notices go through `persistNoticeUnattached()`

## Merge and turn are mutually exclusive (req 6, docs/266 req 2)

- [ ] Background claims are taken only when the session is idle and its queue empty
- [ ] One authoritative admission gate consulted by every turn start: interactive
      send, dispatched turns, and the queue drain
- [ ] Adoption after a restart is **not** gated — it resumes an existing turn
- [ ] Every background-claim exit calls `releaseQueuedTurn()` after the durable
      state change
- [ ] Full lifecycle test: a turn queues, waits, is released, and starts

## Revocation (req 4)

- [ ] Deletes **pending** rows by `canonicalRepoKey`, in the same transaction as
      the flag
- [ ] The grant is re-checked atomically at `pending → merging`
- [ ] In-flight rows are marked `revoked` durably, never deleted; a revoked row
      never returns to `pending`
- [ ] Reports the permission withdrawn once no row can merge again, not once
      every network call has returned
- [ ] A user's card-armed auto-merge is untouched

## Docs

- [ ] The `--auto` section in `shipit-docs/github.md`
- [ ] `docs/287`'s "not part of this feature" refusal is removed

## Quality

- [ ] Tests as listed in plan.md
- [ ] Each new guard proved red on its own before the fix
- [ ] `npm run lint:dev` and `npm run typecheck` green
- [ ] An independent review of the implementation
