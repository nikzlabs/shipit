---
title: An out-of-date upload listing never overwrites what is true — design
description: Two counters guard hydration, and the composer's attachment decision moves into one pure function.
---

# An out-of-date upload listing never overwrites what is true

Implements [requirements.md](./requirements.md).

## Shape

```
hydrateUploads(sessionId)
  capture  seq = ++hydrateSeq,  changeAtStart = changeSeq[sessionId]
  fetch …
  ├── seq !== hydrateSeq                 → drop, do NOT refetch  (req 3)
  ├── store.sessionId !== sessionId      → drop                  (req 2)
  ├── changeSeq[sessionId] !== captured  → drop, refetch once    (req 1, bounded)
  └── otherwise                          → apply

writers that bump changeSeq[sessionId]
  upload POST succeeded · upload DELETE completed (composer chips AND the panel)

buildAttachmentPlan({ text, uploadRefs, uploads, pendingFiles })
  → { frame, bubble, clearAttachments }        (reqs 5-6, and docs/293 req 4)
```

## Key decisions

**Two counters, because there are two different questions.** (`uploadsChangeSeq`
is keyed **by session**; see below.) `hydrateSeq` answers
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

**A write invalidates only when the server's set actually changed, or when
nobody can tell.** A DELETE that is definitely *refused* changed nothing, so it
must not spend a listing's refetch budget — four refusals in a row would exhaust
the chain and leave the panel empty. A network error is ambiguous and does
invalidate. An upload POST invalidates on **every** outcome, because a rejected
batch may have written files and rolled them back
(`api-routes-files.ts`), and a listing that saw those temporary files is just as
stale as one that missed a new file.

**Rewind is a writer too.** A chat or both rewind deletes the rewound messages'
upload files server-side (`rollback-handlers.ts`). The client refreshed the file
tree and not the uploads panel, so it went on showing files that were gone.
Found by review, along with the panel-delete writer above; both are now covered.

**The change counter is keyed by session.** A session's uploads go on completing
after the user has switched away — the request is not cancelled — so a global
counter let those completions invalidate the *new* session's perfectly current
listing. Four interleaved completions would exhaust the retry chain and leave the
new session's panel empty: the regression in the opposite direction. Found by
review.

**A draft path is no longer pruned merely because a listing lacks it.** That rule
made a snapshot authoritative over something it could not have known about, and
the counters cannot see another tab: tab A's in-flight listing deleted from
shared localStorage a draft path tab B had just saved, and B lost the attachment
at its next reload. Removing the rule fixes it at the root rather than adding
cross-tab signalling, and costs only a dead string — a chip is built from
`data.files`, so a drafted path with no file on the server renders nothing. The
sent-path prune, which is what structurally prevents resurrection, stays.

Removing it did expose one thing that was hidden behind it: the Uploads panel
deleted a file without retiring its draft path, which the absence rule used to
sweep up. It now calls `removeDraftUploads` like the composer's Remove always
has — otherwise the path lingers and another tab's older listing can rebuild a
pending chip for a file that is gone.

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
the server to discard. **No defensive server change was added**, and the scope of
that decision is narrower than it first looks — review was right to press on it.
"The updated composer no longer produces it" is true; "the server can no longer
receive it" is not. An already-open older tab still sends the previous
attachment-bearing frame, and the HTTP dispatch route
(`api-routes-agent.ts`) accepts text plus attachments for any prompt, `/compact`
included. A WS-only guard would establish the invariant on neither, and would not
give an older client back the chips it had already cleared. Req 6 is a statement
about the composer, and that is where it is enforced.

**`/compact` is refused in quick capture.** That surface unmounts its composer on
send, so for a message that *goes*, reqs 5 and 6 cannot both hold: withhold the
attachment and it is destroyed with the composer; send it and req 6 is broken.
Two reviews landed on this from opposite sides — the first found that withholding
destroyed the file, the second that sending it instead was an exception the
requirements never granted. **Refusing the send is what makes both true**, and it
needs no carve-out: a brand-new session has no conversation to compact, so there
was nothing for the command to do. Send greys out with *"There is nothing to
compact in a new session"*, in the same shape as the docs/293 bars beside it.

**Leaving a session is not removing an attachment.** docs/293 made a missing chip
mean "the user dismissed this", which deletes the uploaded file. But
`switchSession` clears *every* chip, so an upload started in A and completing
after a switch to B was destroyed as though it had been dismissed — and its path
written into the **global** tombstone set, from where it could filter a
same-named file out of B. The rule now applies only while that session is still
on screen; otherwise the file is kept and recorded as an unsent draft, so
returning shows the chip again. This is a defect docs/293 introduced, found by
review here.

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

**The extraction is not behaviour-neutral, and saying so was wrong.** Review
compared it line by line against the pre-extraction code and found three
differences on the `/review` path. All three are kept as deliberate corrections,
recorded here rather than left to be discovered:

1. A `/review` bubble now shows image thumbnails and non-image file rows, where
   it previously carried only `uploadPaths` and mentioned-file rows. It now draws
   its attachments the way every other message does.
2. `/review` now clears the `@`-mentioned files. It did not before — and
   `docs/293`'s plan claimed it did, which was the doc being wrong about its own
   code. That doc now carries a correction.
3. Empty frame fields are absent properties rather than present-and-`undefined`.
   Identical once serialized; the test asserts on `Object.keys` rather than
   `toEqual({})`, which cannot tell the two apart.

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
| `src/client/App.tsx` (uploads panel) | Its delete goes through the brokered helper, so it invalidates a listing too. |

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
- **The store's counter tests could not fail on a missing production call.**
  Their fetch stub bumped the counter itself, so every `noteUploadsChanged()` in
  the app could have been deleted and they would have stayed green. There are now
  two tests in `useFileUpload.test.ts` that drive the real writers — a landing
  upload and a completed delete — against a held-open listing, and both go red
  when their production call is removed.
- **The foreign-session test's draft assertion did not discriminate.** Its
  listing contained the very path it asserted survived, so an unguarded prune
  would have preserved it too. The listing no longer contains it.
- **One plan fixture combined two rejection conditions** (not `ready` *and* no
  path), so removing either left the other rejecting it. Split in two.
- **The bound's first test could not fail.** Its fetch stub reported a change on
  every call, so removing the bound produced an endless request loop that killed
  the worker instead of a red assertion. The stub now stops after ten, and the
  mutation fails cleanly at `expected 11 to be 4`. A crash is a worse guard than
  a failing test.
