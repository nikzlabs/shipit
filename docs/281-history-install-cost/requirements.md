---
issue: planning#467
title: What a validated 304 on /history may and may not do
description: Establish whether a cached history payload can truncate the live transcript or strand a card, and remove the redundant work its re-install does.
---

# What a validated 304 on `/history` may and may not do

1. Establish whether the cached payload a `304` re-installs can truncate the
   live transcript — and, if it cannot, whether the ordering that prevents it is
   guaranteed or merely incidental. An incidental ordering is a live
   transcript-truncation window on every foreground reconnect during a running
   turn.
2. Establish what the four authoritative card re-seeds actually protect against,
   and what the correct interaction is between a re-seed and the attach-time
   turn-event-buffer replay.
3. A fix for (1) must not be "skip the re-seeds". Skipping them reintroduces the
   failure the seeds exist to prevent — a filed bug report rendering as an
   editable draft, a resolved permission re-offering Approve/Deny. If the
   transcript install and the card seed need different conditions, they get
   different conditions.
4. A `304` must not repeat work it does not need to repeat. Removing that work
   must be weighed against what removing it costs, and must not be done if the
   cost is higher.
5. Findings 1 and 2 must survive later edits: a change that reintroduces either
   failure has to be visible when it is made, not the next time a user hits it.

## Open questions

_None._

## Resolved questions

- 2026-08-22 — Should the redundant transcript re-install on a `304` be skipped
  (as PR #2550 does with a `historyBaseline` marker), or left alone (as PR #2552
  argues, because the install *is* the switch-back baseline restore)? Nik asked
  for a judgement rather than a decision: *"My reading, which you should test
  rather than adopt … I have not weighed that against the cost of a new
  permanent piece of store state, and you should."* Resolved as **neither**: the
  install stays unconditional and its cost is removed instead (req 4, see
  [`plan.md`](./plan.md) "Why not skip the install").
- 2026-08-22 — Does the ghost card-store entry left by a load whose payload no
  longer contains a previously seeded card (the rewind case) belong in this
  change? Nik delegated the call: *"Decide whether it belongs in this change or
  in its own issue, and act on that decision."* Resolved as **its own issue**
  (planning#471): it is pre-existing, identical on a `200`, and not user-visible
  — a card renders only from its transcript row (`MessageCards.tsx:252`), so an
  entry whose row is gone renders nothing. The fix — making `seedCards` a
  wholesale replace — would risk clobbering a card created live after the
  payload was built, which is a larger change than this issue's scope.
