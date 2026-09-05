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

## From the independent review

- [x] Reconciliation stands down for a merge in flight — it could otherwise
      delete the only record mid-REST-call and lose the merge entirely
- [x] The rollup must describe the merged commit, or a lagging `SUCCESS` merges
      a head CI never saw (req 1)
- [x] The session's remote must still resolve to the claim's repository, so a
      repointed `origin` cannot merge A under B's grant (req 2)
- [x] The grant is re-read in the instant before the merge call; the residual
      window is the REST call itself and is stated as such (req 4)
- [x] `handleAnswerQuestion` — a fourth turn-start path — consults the hold
- [x] A runner created mid-merge is seeded held, and the `finally` re-resolves
      the registry so that runner is released (req 6)
- [x] A throw from the merge call is `indeterminate`, with a notice — not a
      silent strand that later reconciliation deletes without a word
- [x] A bounded run of unreadable answers ends the request with a notice (req 1)
- [x] Cancellation notices are written in the same transaction as the delete,
      both for a moved branch and for revocation (req 3)

## Quality

- [x] Tests as listed in plan.md
- [x] Each new guard proved red on its own by deleting it singly
- [x] `npm run lint:dev` and `npm run typecheck` green
- [x] An independent review of the implementation — eight findings, all verified at source, all fixed (above)
