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
a queue can only be drained by whoever owns it.

**And an in-flight request owns its chip, so the record of it is module-level
too.** This is the correction a second review forced, on a premise that read as
obvious and was false: unmounting a hook does **not** cancel its `fetch`. The
request runs to completion and goes on writing to the store. With the in-flight
set held per-hook, a replacement mounted mid-upload saw a chip with bytes and no
apparent owner and POSTed it again — two copies on the server, and whichever
landed first released the bytes, so the other's failure landed on a chip Retry
could no longer fix. Ownership belongs to the request, so `isUploadActive` lives
beside the bytes. The same check absorbs React StrictMode's double-invoked mount
effect (`main.tsx`), which would otherwise POST every deferred upload twice in
development.

**Remove is available in every state, and actually reachable (req 7).** It used to
be hidden while uploading — and with req 1 barring Send on an uploading
attachment, a chip with no way off the screen is a composer that cannot send
anything at all. Two things follow that the first pass got wrong. Removing
mid-flight does not stop the request, so when it lands the completion now finds
no chip, deletes the file it just stored and records no draft path; without that,
`hydrateUploads` restored the attachment the user had explicitly dismissed, onto a
later message. And an image's Remove was `opacity-0` until hover, which is not a
control at all on a touch device — `pointer-coarse` and `focus-visible` reveals
were added, because req 7 is about a way out existing rather than about the DOM
containing a button.

**A failed image looks failed (req 2).** `ImageThumbnail` received no `onRetry`
and rendered an error exactly like a success, so req 2's "retry or remove it"
pointed at a control that did not exist — on a chip the user could not identify as
the one holding the message.

**The upload batch is all-or-nothing (req 4) — and the rollback owns what it
deletes.** Files were saved one at a time and a failure part-way left the earlier
ones on disk while the response carried no paths for them. The client marks the
whole batch failed, so req 3's retry re-POSTed a file the server already had, and
`deduplicateFilename` stored it again under a new name — an orphan no chip refers
to. The route now undoes its own writes.

That fix needed a second one to be safe, and the second review is what caught it:
`deduplicateFilename` reports a name that was free *a moment ago*, so two
concurrent requests could both take `same.txt`. Overwriting was the old bug;
with a rollback in place, one request's failure would have **deleted the other's
successful upload**. `saveUploadedFile` now claims its name with an exclusive
create (`flag: "wx"`) and retries the next suffix on `EEXIST`, so "this request
wrote it" is true enough to undo. It also unlinks its own partial file when the
write itself fails, and the rollback logs rather than swallows a cleanup error —
"all-or-nothing" should not be a stronger claim than the code.

**`/review` carries the attachments (req 4).** It composes its own prompt and
dispatched it alone while `handleSubmit` cleared the chips regardless. It carries
**both** kinds — uploads and `@`-mentioned workspace files. The frame's
attachment fields are built outside `App.tsx`, because `App.tsx` has no test
harness. That bought a test of the payload shape and not of the wiring — a limit
this doc stated honestly three times before closing it; see *And then the wiring
itself moved* below.

> **Correction.** This paragraph named `buildReviewSendFrame` in
> `compose-review-body.ts`. That helper was superseded by `buildAttachmentPlan`
> (`utils/attachment-plan.ts`) in docs/294 and no longer exists, so the name is
> corrected here rather than left pointing at nothing.

> **Correction (docs/294).** This section originally also said `/review`
> *consumes* the `@`-mentioned files. It did not: the clearing call never made it
> into the shipped branch, so those chips stayed attached to a later message. A
> review of docs/294 caught the discrepancy between this doc and the code, and
> makes the claim true.

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
| `src/client/stores/file-store.ts` | The retained bytes and the in-flight set — both at the chips' lifetime, not a hook's. |
| `src/client/hooks/useFileUpload.ts` | `retryUpload`, the resume pass, and the removed-mid-flight cleanup. |
| `src/client/components/FileUploadChips.tsx` | Remove in every state; error face + Retry on images. |
| `src/client/utils/compose-review-body.ts` | `composeReviewMessage` — the `/review` prompt itself. |
| `src/client/utils/review-command.ts` | `resolveReviewRequest` — the three `/review` refusals, out of `App` so they can be tested. |
| `src/client/utils/send-handler.ts` | `runSend` — the whole send decision, out of `App` so its WIRING can be tested. |
| `src/server/orchestrator/api-routes-files.ts` | Batch rollback on failure, logged rather than swallowed. |
| `src/server/orchestrator/services/files.ts` | Exclusive filename claim, so the rollback owns what it deletes. |
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
  before the session resumes, an upload whose hook went away before its POST
  started resumes, an upload whose request is **still running** is NOT restarted,
  StrictMode does not double-POST, an upload removed mid-flight stays removed
  (its file deleted, no draft recorded), and the bytes go when the chips go.
- `FileUploadChips.test.tsx` — Retry on a failed image, no Retry on a healthy one,
  Remove on an in-flight file and an in-flight image.
- `compose-review-body.test.ts` — `/review` carries the uploads, the
  `@`-mentioned files, and both at once; each key is omitted when empty.
- `review-command.test.ts` — each of the three refusals with its message, the
  order they are checked in, and the target taken from the argument (with or
  without the `@`) in preference to the preview.
- `MessageInputSendGate.test.tsx` — a refused send keeps the text, the chips and
  the reset-to-base control; an accepted one still clears all three.
- `send-handler.test.ts` — the wiring: each refusal dispatching nothing and
  returning `false`, `plan.frame` reaching the wire on both the `/review` and the
  ordinary branch, the undeliverable `/review` leaving its preview target and its
  route alone so the retry can work, and the ordinary send still being accepted
  when the socket refuses it (because that dispatch stashes the frame).
- `file-upload.test.ts` (integration) — a batch that fails part-way leaves nothing
  on disk.
- `files-upload.test.ts` — eight concurrent uploads of one name get eight distinct
  files and nobody is overwritten; a write that creates the file and then fails
  leaves nothing behind.
- `headless-sessions.test.ts` — an empty prompt with an attachment is accepted and
  dispatched; an empty prompt with nothing attached is still refused.

Every clause was proved red on its own by mutating exactly what it guards. Four
mutations came back green and each one was a finding rather than a pass:

- `markUploadsSent`'s byte release — unreachable, because a `ready` upload already
  released its bytes. **Deleted**, along with its test.
- The in-flight guard — the test re-rendered, which does not re-run the effect.
  **Rewritten** to mount under StrictMode, the way React actually double-fires it.
- The "remounted mid-flight" test — it asserted *zero* POSTs before unmounting, so
  it could only ever exercise the deferred case. **Split** into that case and a
  real one with a gated request still open, which is what exposed the
  duplicate-POST bug.
- The partial-write cleanup — the mock rejected without creating a file, so there
  was nothing to clean up. **Rewritten** to create the file and then throw.

## Verified in a real browser

On the dogfood inner instance, not only in jsdom. A localhost upload of a few KB
lands too fast to observe, so the checks use pastes large enough to make each
state real:

| What was done | Send | Tooltip |
|---|---|---|
| Empty composer | disabled | none |
| 10 MB paste, upload landed, **no typed text** | **enabled** | none |
| 55 MB paste, in flight | disabled | *Waiting for attachments to finish uploading* |
| 55 MB paste, after the failure | disabled | *An attachment failed to upload — retry or remove it* |

While the 55 MB upload was in flight the chip carried a **Remove** control (req
7) — before this change it had none. After the failure it carried Retry as well,
and clicking it re-POSTed the 55 MB and settled back to error rather than
deleting the chip.

For the removed-mid-flight case: a 40 MB paste (under the cap, so it *would* have
succeeded) was dismissed at 0%. The chip went and did not come back when the
request landed, and the session's `uploads/` directory on disk contains no 40 MB
file — the completion deleted what the server had saved.

## Known limits, since closed

Recorded as non-requirements and tracked as **planning#519**: `hydrateUploads`
applies a stale listing (pruning a newer upload's draft path) and applies it with
no session check, and `/compact` drops attachments the way `/review` did. All
three predate this work and belong to other subsystems; the hydration pair needed
a decision about what an out-of-date answer should do, so it got its own doc —
[docs/294-upload-hydration-races](../294-upload-hydration-races/plan.md), where
all three are fixed.

One more, found by the review of that work and fixed here (see below): a
**refused** `/review` cleared the composer anyway.

## A refused send keeps what it would have sent

Req 4 says no attachment is dropped without the user being told. `/review` has
three ways to turn a send away — there is no session, a turn is already running,
or it has no target file — and each one returned early from `App.handleSend`
after a toast that explained the refusal. `MessageInput.handleSubmit` cleared the
text and the chips *after* calling `onSend`, unconditionally, because nothing
told it the send had not happened. So a refused `/review` cost the user their
message and their attachment, for a send that never went out.

**`onSend` now answers.** It returns a **required** `boolean`, and `false` means
refused: `handleSubmit` returns without clearing anything, and without the
docs/218 optimistic reset-eligible clear, which would otherwise hide a control
the user still needs (no turn ran, so nothing would recompute it).

Required, not optional, and that decision has a cost worth naming. A first pass
made the check `=== false` so that the composer's ~130 `vi.fn()` doubles — which
return `undefined`, and are `any`-typed, so TypeScript cannot see them — kept
meaning "accepted". CI's `no-unnecessary-boolean-literal-compare` refused it, and
was right: against a required `boolean` the comparison is redundant, and the
leniency was there to protect the *fixtures*, not the code. With the strict check
in, four tests went red — a saved draft cleared, the reset control hidden, the
dictation flag reset, the chips cleared — every one of them a test that only
means anything with an accepting parent. So the doubles were fixed rather than
the check: nine files' doubles now say `vi.fn().mockReturnValue(true)`. A double
that cannot express the contract is a fixture that quietly tests something else.
(`mockReturnValue`, not `vi.fn(() => true)` — the arrow narrows the mock's
argument tuple to `[]`, so every `onSend.mock.calls[0][0]` in those files stops
type-checking.)

The alternative was to decide the refusal inside `buildAttachmentPlan`, which
already decides `clearAttachments`. It does not work: that function is called in
`App`, while the chips are cleared in `MessageInput`, so the answer still has to
travel back across the prop. A return value is the whole mechanism.

**Four reachable paths, not three.** Looking for the rest of the shape found one
more: **a `/review` whose frame never left the browser.** `sendUserMessage`
returns `false` when the socket would not take the frame; it rolls its optimistic
bubble back and toasts *"your message wasn't sent … try again in a moment"* —
which the user cannot do from a composer that emptied itself behind the toast.
The ordinary send is safe here only because its dispatch **stashes** an
undeliverable frame for reconnect and reports success; `/review`'s dispatch calls
`send` directly, so this one is genuinely reachable.

**And a refused send has to be retryable, which is more than keeping the text.**
Found by review, on the fix itself: `/review` closed the preview and graduated
the URL *before* dispatching. `closePreview` clears `previewFile`, which is the
target a bare `/review` resolves from — so the retry the toast asks for failed
with *"needs a file"*. The `navigate` was worse: it changes the composer's draft
key, and draft restoration then replaced the text the refusal had just preserved
with the new key's empty draft. Both are effects of an accepted `/review`, so
both moved below the delivery check.

**The quick-capture overlay's refusal is honoured too, defensively.** It turns a
capture away when no repo is selected, and now returns `false` for it. This one is
not a demonstrated loss: that surface disables its whole composer while no repo is
ready (`disabled` at `QuickCaptureOverlay.tsx`), so `sendBlocked` bars the send
before the refusal is reached. It is the contract being answered honestly rather
than a bug being fixed — which is why `onSend` returns a **required** `boolean`.
A handler that must answer cannot forget to, and forgetting is exactly how the
original loss happened.

**Why the refusal moved out of `App` anyway.** `App` has no test harness, so the
three branches had no coverage and could not get any. `resolveReviewRequest`
(`src/client/utils/review-command.ts`) is the same shape as `buildAttachmentPlan`
— pure, every input passed in — so each refusal, the order they are checked in,
and the target resolution are testable without rendering `App`.

**And then the wiring itself moved, because extracting pure helpers was not
working.** Three PRs in a row pulled a pure function out of `App.handleSend` and
each one had to close by admitting the same hole: the helper is tested, App's
*call* to it is not. That hole is not incidental — it is exactly where this bug
class lives. `buildAttachmentPlan` cannot fail on App forgetting to spread
`plan.frame`; `resolveReviewRequest` cannot fail on App computing a refusal and
dispatching anyway. A fourth extraction would have bought a fourth admission.

So the **body** moved instead, into `runSend` (`src/client/utils/send-handler.ts`).
It is not pure — it reads stores and dispatches — but every React-shaped
dependency (`send`, `navigate`, `requestPermission`, `disableAutoFix`,
`isNewSessionRoute`) is a parameter, so a test seeds the real stores, calls it
with a fake `send`, and reads back what reached the wire and what the return
value told the composer. `App` keeps only the `useCallback` that binds the
dependencies. No behaviour changed: the body was moved verbatim.

That is what finally covers the two branches this section used to list as
untested — App returning `false` for a refusal, and the undeliverable-`/review`
path — and the ordering bug the review found now has a regression test of its
own, rather than only a comment explaining it.
