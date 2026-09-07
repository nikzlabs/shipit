---
title: Send never loses an attachment — design
description: One derived `sendBlocked` value in the composer, bytes held at the chips' lifetime, and an upload batch that rolls back.
---

# Send never loses an attachment, and can carry attachments alone

Implements [requirements.md](./requirements.md).

## Shape

```
composer                                    upload bytes (beside the store)
  sendBlocked                                 retained per chip that has not landed
    disabled / inert / networkSaving          released on success, on removal, on session switch
    no text AND no attachment  (req 5/6)
    any attachment uploading   (req 1)      useFileUpload
    any attachment failed      (req 2)        retryUpload  → re-POSTs the bytes        (req 3)
                                              resume pass  → finishes an upload nobody owns
chips
  Remove on every chip, every status (req 7)
  Retry + an error face on images too (req 2)
server
  POST /files/uploads rolls the batch back on failure                                  (req 4)
  headless session accepts an empty prompt when files are attached                     (req 5)
```

## Key decisions

**One `sendBlocked`, derived once.** The bar existed in five places: four
identical copies on the send buttons (wide/narrow × live-steering or not) and a
fifth, differently-worded copy inside `handleSubmit`. Enter reaches only the
fifth, so a bar added to the buttons alone is walked straight past by the keyboard
— which is the shape of bug this doc exists to fix. Collapsing them makes each
requirement one edit instead of five.

**Blocking, not waiting (req 1).** The user chose the barrier over a
wait-then-send. It is also the cheaper design and it has a precedent three lines
away: `docs/285`'s `networkSaving` bars Send for the same reason. A wait-then-send
would need a committed-but-unsent state, a cancel path for a message the user can
no longer see, and a timeout for an upload that never lands.

**A blocked Send says why.** `sendBlockedReason` rides as a native `title` on the
button — native tooltips still show on a `disabled` button, where the Radix
`WithTooltip` wrapper used elsewhere in this row does not.

**The retained bytes live beside the store, not in the hook (reqs 3, 7).** This is
the correction the review forced, and the reasoning is the whole fix: the chips
are store state, and the hook is *remounted* whenever the layout crosses the
mobile breakpoint (`AppLayout` swaps component trees). Bytes held in a `useRef`
therefore outlived nothing and were outlived by everything on screen — Retry on a
surviving failed chip found no bytes and deleted the attachment, and a chip
attached before the session was claimed sat at "uploading" forever because the
hook holding its queue was gone. Keying them off the upload-item id and releasing
them from exactly the store actions that drop the chips makes the two lifetimes
the same one.

**Resume is derived from state, not queued (req 7).** One effect POSTs every chip
that still reads "uploading" and still has bytes. Deriving the work rather than
holding a queue is what lets a *replacement* hook finish a job it never started —
a queue can only be drained by whoever owns it. Chips this hook already has in
flight are skipped, which matters concretely rather than defensively: React
StrictMode (on in `main.tsx`) double-invokes mount effects, so without the guard
every deferred upload is POSTed twice in development.

**Remove is available in every state (req 7).** It used to be hidden while
uploading. With req 1 barring Send on an uploading attachment, a chip with no way
off the screen is a composer that cannot send anything at all. Removing mid-flight
can orphan a file in `/uploads`; a stranded composer is the worse failure.

**A failed image looks failed (req 2).** `ImageThumbnail` received no `onRetry`
and rendered an error exactly like a success, so req 2's "retry or remove it"
pointed at a control that did not exist — on a chip the user could not identify as
the one holding the message.

**The upload batch is all-or-nothing (req 4).** Files were saved one at a time and
a failure part-way left the earlier ones on disk while the response carried no
paths for them. The client marks the whole batch failed, so req 3's retry re-POSTed
a file the server already had, and `deduplicateFilename` stored it again under a
new name — an orphan no chip refers to. The route now undoes its own writes.

**`/review` carries the attachments (req 4).** It composes its own prompt and
dispatched it alone while `handleSubmit` cleared the chips regardless. The frame is
now built by `buildReviewSendFrame` in `compose-review-body.ts` rather than inline
in `App.tsx` — `App.tsx` has no test harness, and a silent-loss fix with no test is
the thing this doc is about.

**`markUploadsSent` is deliberately left alone.** Clearing every pending chip
regardless of status is what made the original loss silent. Reqs 1 and 2 make it
correct rather than dangerous: a send can only happen when every pending upload is
`ready`, so "clear them all" and "clear the sent ones" are the same set. A first
draft also released bytes there; the mutation test for it stayed green, because a
`ready` upload released its bytes when it landed. It was removed rather than kept
as a guard for a state the gate prevents.

**No server change was needed for the prompt itself** — verified, not assumed.
`assemblePrompt` drops empty parts with `.filter(Boolean)`, and
`buildVisualElements` emits a bubble for any `role === "user"` message. Only the
*headless* path needed the empty-prompt allowance, because it validates before
`assemblePrompt` ever runs.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/MessageInput.tsx` | `sendBlocked`, `sendBlockedReason`, the four button sites and `handleSubmit`. |
| `src/client/stores/file-store.ts` | The retained bytes and their release points — the chips' lifetime. |
| `src/client/hooks/useFileUpload.ts` | `retryUpload`, the resume pass, the in-flight set. |
| `src/client/components/FileUploadChips.tsx` | Remove in every state; error face + Retry on images. |
| `src/client/utils/compose-review-body.ts` | `buildReviewSendFrame` — `/review` carries the uploads. |
| `src/server/orchestrator/api-routes-files.ts` | Batch rollback on failure. |
| `src/server/orchestrator/services/headless-sessions.ts` | Empty prompt allowed when files are attached. |
| `src/server/orchestrator/prompt-assembly.ts` | Unchanged — `.filter(Boolean)` is why an empty `text` needs no work. |
| `src/client/components/visual-elements.ts` | Unchanged — `role === "user"` already renders an empty-text bubble. |

## Tests

- `MessageInputSendGate.test.tsx` — both refusals with their reasons, refusal via
  **Enter** as well as the button, a ready attachment sending, attachment-only
  sends for an upload and an `@`-mentioned file, the two cases that stay refused,
  and the same on the **overlay** surface.
- `useFileUpload.test.ts` — retry re-POSTs the same *bytes* (content, not just the
  name), the error clears, a second retry works, a `ready` upload is neither
  re-POSTed nor deleted, retry still works **after a remount**, an upload attached
  before the session resumes, an upload whose hook was remounted resumes, StrictMode
  does not double-POST, and the bytes go when the chips go.
- `FileUploadChips.test.tsx` — Retry on a failed image, no Retry on a healthy one,
  Remove on an in-flight file and an in-flight image.
- `compose-review-body.test.ts` — `/review` carries the uploads, and omits the key
  when there are none.
- `file-upload.test.ts` (integration) — a batch that fails part-way leaves nothing
  on disk.
- `headless-sessions.test.ts` — an empty prompt with an attachment is accepted and
  dispatched; an empty prompt with nothing attached is still refused.

Every clause was proved red on its own by mutating exactly what it guards. Two
mutations changed the design rather than the tests: `markUploadsSent`'s byte
release stayed green (removed as dead), and the in-flight guard stayed green until
the test was rewritten to fire the effect the way React actually does — under
StrictMode — at which point it went red. A test that cannot fail is a finding
about the test or the code, not a pass.
