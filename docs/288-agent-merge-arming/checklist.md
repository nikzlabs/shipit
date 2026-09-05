# Checklist — Merge it when the checks pass

Implements [plan.md](./plan.md) against [requirements.md](./requirements.md).
Built on `docs/287-agent-merge-per-repo`, shipped.

## The request

- [x] `agent_merge_claims` gains `origin`, `method` and the `pending` state
- [x] `--auto` records a request instead of refusing on pending checks (req 1)
- [x] `--auto` never merges inline, even when the checks are already green
- [x] A request is refused over an attempt (`merging`/`settling`), replaced over
      another request, and superseded by a direct `gh pr merge`
- [x] Requests are invisible to reconciliation, which would delete them as
      "not merged"
- [x] Terminal handling for a request: merged at `expected_sha` → settle with the
      narrow attribution; head moved → cancel (req 3); draft, review, failing
      checks, closed → end with a notice naming the reason

## Execution

- [x] Its own loop in the orchestrator, ticking only while a request exists
- [x] Started after `reattachInFlightTurns()`, so the registry is populated
- [x] Carried out from the database alone after a restart, with no viewer and no
      runner (req 5)
- [x] The predicate is `expected_sha`, never a local HEAD (req 2)
- [x] A request that leaves `pending` never returns to it — one request, one
      attempt
- [x] Notices go through `persistNoticeUnattached()`

## Merge and turn are mutually exclusive (req 6)

- [x] The merge is taken only when the session is idle and its queue empty
- [x] `runner.mergeHold` consulted by `dispatchOnRunner`, the interactive send,
      and `releaseQueuedTurn`
- [x] The hold is released in a `finally`, including when the merge throws
- [x] Every exit calls `releaseQueuedTurn()` after the durable state change
- [x] Full lifecycle test: a turn queues, waits, is released, and starts

## Revocation (req 4)

- [x] Deletes **pending** rows by `repoId`, and leaves another repository's alone
- [x] The grant is re-checked at `pending → merging`
- [x] A row past `pending` is left alone — it can no longer merge anything
- [x] A user's card-armed auto-merge is untouched (GitHub-native, not this path)

## Docs

- [x] The `--auto` section in `shipit-docs/github.md`
- [x] `docs/287`'s "not part of this feature" refusal updated

## Quality

- [x] Tests as listed in plan.md
- [x] Each new guard proved red on its own by deleting it singly
- [x] `npm run lint:dev` and `npm run typecheck` green
- [ ] An independent review of the implementation
