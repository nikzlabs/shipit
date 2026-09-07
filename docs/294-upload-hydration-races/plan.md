---
title: An out-of-date upload listing never overwrites what is true — design
description: Two counters guard hydration, and the composer's attachment decision moves into one pure function.
---

# An out-of-date upload listing never overwrites what is true

Implements [requirements.md](./requirements.md).

## Shape

```
hydrateUploads(sessionId)
  capture  seq = ++hydrateSeq,  changeAtStart = uploadsChangeSeq
  fetch …
  ├── seq !== hydrateSeq                → drop, do NOT refetch  (req 3)
  ├── store.sessionId !== sessionId     → drop                  (req 2)
  ├── uploadsChangeSeq !== changeAtStart→ drop, refetch once    (req 1, bounded)
  └── otherwise                         → apply

buildAttachmentPlan({ text, uploadRefs, uploads, pendingFiles })
  → { frame, bubble, clearAttachments }        (reqs 5-6, and docs/293 req 4)
```

## Key decisions

**Two counters, because there are two different questions.** `hydrateSeq` answers
*is a newer hydration already running?* — if so this answer is not just stale, it
is redundant, so it is dropped without a refetch (req 3). `uploadsChangeSeq`
answers *did the world change under this request?* — that one nobody else is
chasing, so it earns the refetch (req 1). Collapsing them into one counter would
force a single behaviour on two cases that want opposite ones.

**Captured before the request, compared after it.** `hydrateUploads` treats its
response as authority: it prunes the persisted draft set and rebuilds every
non-pending chip. That is why a stale answer is destructive rather than merely
useless — it pruned a just-uploaded file's draft path, and `pendingInMemory` kept
the chip on screen so nothing looked wrong until the next reload.

**The refetch is bounded.** Three chained attempts, then it stops. Unbounded is
not a theoretical concern: with the bound removed, the guard test spins the
request loop until the test worker dies. The give-up case is already covered by
the existing triggers (connect, session switch, Refresh).

**The session guard reads the store, and that is safe.** `switchSession` sets
`useSessionStore.sessionId` **synchronously**, before history loads and before
`onSessionConnect` runs, so the comparison is meaningful at both ends of the
request. Verified at `stores/actions/session-actions.ts` rather than assumed —
the opposite ordering would have made this guard drop every legitimate
hydration. Note `useConnectionSync` already has a generation guard on the
*call* (`hydrateGenerationRef`); what was missing is a guard on the *answer*,
and the Refresh button's call had neither.

**`/compact` is a command, so it carries nothing (reqs 5-6).** The mid-turn
interception calls `agent.compact()` and returns, discarding whatever the frame
carried, while the composer had already cleared its chips — a silent loss. The
fix is client-side: the command carries no attachment, so there is nothing for
the server to discard. **No defensive server change was added**: guarding a state
the client no longer produces is the same dead code that was deleted from
`markUploadsSent` in docs/293.

**The `/compact` parser moved to `shared/`.** The client needs the same answer as
the server, and the failure mode of two regexes drifting is exactly the silent
attachment loss being fixed here. `/compactfoo` is not `/compact`, and
`/compact <instructions>` is — a prefix check on the client would get both wrong.

**One attachment decision, in one pure function.** `buildAttachmentPlan` replaces
logic that lived inline in `App.handleSend`, answered separately by each branch.
Three silent losses came out of that arrangement in two days: `/review`
dispatched its composed prompt without the uploads, then without the
`@`-mentioned files, and `/compact` discarded both. `App.tsx` has no test
harness, so none of it could be caught by a test — and the previous attempt at
that (`buildReviewSendFrame`) was correctly called out in review as an object
literal extracted only to test it, covering one branch of three.
`buildReviewSendFrame` is **deleted**: the new function answers the same question
for every path, so keeping both would leave two places to forget.

**What was NOT extracted.** `handleSend`'s effects — the `/review` guards and
toasts, URL graduation, `requestPermission`, `sendUserMessage` — stay in `App`.
They are the parts that need the component, and moving them would be a refactor
of a critical path with no test to catch a mistake. The extraction is scoped to
the decision that has actually been getting things wrong.

## Key files

| File | Role |
|---|---|
| `src/client/stores/file-store.ts` | `hydrateUploads`'s three guards; `uploadsChangeSeq` / `hydrateSeq`. |
| `src/client/hooks/useFileUpload.ts` | `noteUploadsChanged()` where this client changes the server's set. |
| `src/client/utils/attachment-plan.ts` | `buildAttachmentPlan` — frame, bubble, and whether to clear. |
| `src/client/App.tsx` | Both send paths carry the plan out; no longer decide it. |
| `src/client/components/MessageInput/MessageInput.tsx` | `/compact` withholds the uploads and keeps the chips. |
| `src/server/shared/compact-command.ts` | The one `/compact` parser, read by client and server. |
| `src/client/utils/compose-review-body.ts` | `buildReviewSendFrame` removed — subsumed. |

## Tests

- `file-store.test.ts` — a listing for a session the user has left, a superseded
  listing (older answer arriving last, and no refetch of its own), a listing that
  predates an upload (refetched, and the draft path survives), and the bound.
- `attachment-plan.test.ts` — an ordinary message carries and clears both kinds;
  each key is omitted when empty; an image is a thumbnail and not also a file
  row; the stable data URL beats the revocable blob URL; a non-ready upload is
  ignored; `/compact` and `/compact <args>` carry nothing and clear nothing;
  `/compactfoo` is an ordinary message.
- `MessageInputSendGate.test.tsx` — the composer keeps its chips for `/compact`
  and both forms of it, and does not for a message that merely starts with it.

Every clause was proved red on its own by mutating exactly what it guards. Two
notes on how the tests were arrived at, since both were wrong first:

- **The existing `hydrateUploads` tests all went red** when the session guard
  landed — they hydrated with no session in view. That is the guard working; the
  fixture now states what those tests always meant (`sessionId: SESSION_ID`).
- **The bound's first test could not fail.** Its fetch stub reported a change on
  every call, so removing the bound produced an endless request loop that killed
  the worker instead of a red assertion. The stub now stops after ten, and the
  mutation fails cleanly at `expected 11 to be 4`. A crash is a worse guard than
  a failing test.
