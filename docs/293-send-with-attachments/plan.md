---
title: Send never loses an attachment — design
description: One derived `sendBlocked` value in the composer, plus a retry that keeps the bytes it needs to re-POST.
---

# Send never loses an attachment, and can carry attachments alone

Implements [requirements.md](./requirements.md).

## Shape

Two small changes, on either side of the same seam.

```
composer                                   upload hook
  sendBlocked ──────────────────────────►    uploads[].status
    disabled / inert / networkSaving              uploading  → req 1 bars Send
    no text AND no attachment  (req 5/6)          error      → req 2 bars Send
    any attachment uploading   (req 1)            ready      → Send allowed
    any attachment failed      (req 2)
                                             retryUpload → re-POSTs kept bytes (req 3)
```

Nothing changed on the server. An attachment-only message sends `text: ""`, and
`assemblePrompt` (`orchestrator/prompt-assembly.ts`) already drops empty parts
with `.filter(Boolean)`, so the agent receives the attachment context alone.
`buildVisualElements` already emits a bubble for any `role === "user"` message,
so the empty-text bubble renders — verified at
`client/components/visual-elements.ts`, not assumed.

## Key decisions

**One `sendBlocked`, derived once.** The bar existed in five places: four
identical copies on the send buttons (wide/narrow × live-steering or not) and a
fifth, differently-worded copy inside `handleSubmit`. Enter reaches only the
fifth, so a bar added to the buttons alone is walked straight past by the keyboard
— which is exactly the shape of bug this doc exists to fix. Collapsing them is
what makes reqs 1, 2 and 5 one edit each instead of five.

**Blocking, not waiting (req 1).** The user chose the barrier over a
wait-then-send. That is also the cheaper design and it already has a precedent
three lines away: `docs/285`'s `networkSaving` bars Send for the same reason. A
wait-then-send would need a committed-but-unsent state, a cancel path for a
message the user can no longer see, and a timeout for an upload that never lands.

**A blocked Send says why.** `sendBlockedReason` rides as a native `title` on the
button — native tooltips still show on a `disabled` button, where the Radix
`WithTooltip` wrapper used elsewhere in this row does not. The chip beside it
already carries the detail (a spinner and a percentage, or the error text).

**The retry keeps the bytes, and drops them the moment it must not use them.**
`filesByItemId` maps an upload item to the `File` behind it. An entry is deleted
on success (re-POSTing landed bytes would duplicate the file, not replace it),
on chip removal, and on send. A chip cannot outlive the hook holding its bytes —
`hydrateUploads` rebuilds chips from the server and a failed upload is not there
— so the map cannot go stale. Where the bytes are missing anyway, retry falls
back to removing the chip: with req 2 in force, an unretryable chip that also
bars Send would strand the composer.

**`ready` returns early from retry.** Found by the test for it, not by reading:
without that line the "bytes are gone" fallback fires for a *successful* upload
(its bytes were deliberately dropped) and deletes a landed attachment.

**`markUploadsSent` is left alone.** It clears every pending chip regardless of
status, which is what made the original loss silent. Reqs 1 and 2 make that
correct rather than dangerous: a send can now only happen when every pending
upload is `ready`, so "clear them all" and "clear the sent ones" are the same
set. Adding a second filter there would be a guard against a state the gate
already prevents.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/MessageInput.tsx` | `sendBlocked`, `sendBlockedReason`, the four button sites and `handleSubmit`. |
| `src/client/hooks/useFileUpload.ts` | `filesByItemId`, the rewritten `retryUpload`, cleanup on success/remove/send. |
| `src/client/components/FileUploadChips.tsx` | Unchanged — already renders the status, the error, Retry and Remove. |
| `src/server/orchestrator/prompt-assembly.ts` | Unchanged — `.filter(Boolean)` is why an empty `text` needs no server work. |
| `src/client/components/visual-elements.ts` | Unchanged — `role === "user"` already renders an empty-text bubble. |

## Tests

- `MessageInputSendGate.test.tsx` — refusal while uploading and while failed
  (with the reason on the button), refusal via **Enter** as well as the button,
  a ready attachment sending, attachment-only sends for both an upload and an
  `@`-mentioned file, and the two cases that must stay refused.
- `useFileUpload.test.ts` — a retry re-POSTs the same bytes and the chip
  survives, the error clears, a second retry works, and a `ready` upload is
  neither re-POSTed nor deleted.

Every clause was proved red on its own by mutating exactly what it guards: the
in-flight bar, the failed bar, attachments-count-as-content, the
nothing-at-all bound, `handleSubmit` reading the shared value, the `ready`
early return, and `retryUpload`'s re-POST. The Enter case is the one that
catches a guard applied to the buttons but not to `handleSubmit`.

The full suite was run rather than the affected subset, because `retryUpload`'s
semantics and the send bar are surfaces every composer shares: 989 files, 17,322
tests, no regressions.

Verified end-to-end in the dogfood inner instance, not only in jsdom. A localhost
upload lands too fast to observe the in-flight bar, so the check forces a real
one with a 55 MB paste — over the per-file limit, so the POST is slow *and* ends
in a 413:

| Moment | Send | Tooltip |
|---|---|---|
| In flight | disabled | *Waiting for attachments to finish uploading* |
| After the 413 | disabled | *An attachment failed to upload — retry or remove it* |
| Failed chip removed, one ready chip, no typed text | **enabled** | none |
| Empty composer | disabled | none |

Clicking **Retry** on the failed chip kept it (two chips before and after),
returned it to `0%`, re-POSTed the 55 MB and settled back to error — a real
re-upload. Before this change the chip count would have dropped to one.
