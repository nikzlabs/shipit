---
title: Large paste becomes a file attachment — design
description: How the composer converts a paste of 2,000+ characters into an uploaded .txt attachment.
---

# Large paste becomes a file attachment

Implements [requirements.md](./requirements.md).

## Shape

The whole feature is one branch in the composer's existing paste handler. The
composer already turns a pasted **image** into an upload chip; a large text paste
takes the same road, so nothing new is needed on the server, in the file store,
or at send time.

```
paste event
  ├── clipboard carries an image?      → existing image branch (unchanged)
  ├── text/plain ≥ 2,000 chars?        → preventDefault + addFiles([pasted-text.txt])   ← new
  └── otherwise                        → browser inserts it into the textarea (unchanged)
```

`addFiles` is the same entry point the `+` button, drag-and-drop and image paste
already use, so the pasted text inherits the whole upload lifecycle for free:
the chip with its remove button (req 4), the POST to
`/api/sessions/:id/files/uploads`, the draft persistence across a reload, and the
`UploadRef` handed to `send_message`. The agent then reads it at
`/uploads/pasted-text.txt`.

## Key decisions

**The rule lives in a pure module, not in the handler.** `large-paste.ts` holds
the threshold, the filename and two functions; the handler calls them. That is
what makes the boundary (req 1: "2,000 characters **or more**") testable without
rendering a composer, and it keeps the constant somewhere a reader can find it.

**Image wins over text.** Copying from a web page puts an image *and* its text on
the clipboard. The image branch is checked first and returns, so such a paste
produces one image chip, not an image chip plus a `pasted-text.txt`.

**The filename is a fixed base, not a timestamp.** `saveUploadedFile`
deduplicates on write (`deduplicateFilename` in
`orchestrator/services/files.ts`), so a second paste becomes `pasted-text-1.txt`
— confirmed live in the dogfood instance. A predictable name reads better in
chat and in the agent's prompt than a timestamp does. Note the deduplication is
check-then-write with no serialization across requests, so two *simultaneous*
uploads of the same name can still pick the same free name and overwrite each
other. That race predates this feature and applies to any same-named upload; a
fixed base name makes it easier to reach, not newly possible.

**The paste is measured in characters, the file in bytes.** Characters, not
`String.length`: that counts UTF-16 code units, so 1,000 emoji would convert at
half the characters req 1 names. `isLargePaste` short-circuits on `length` first
(code points can never outnumber code units) and stops counting at the
threshold, so a multi-megabyte paste costs a bounded scan. The resulting `File`
sizes itself in UTF-8 bytes, which is the unit the 50 MB per-file limit and the
session quota use.

**Nothing is added for req 5.** "No way back to inline text" is the absence of an
undo path, so the design is smaller for it, not larger.

## Key files

| File | Role |
|---|---|
| `src/client/components/MessageInput/large-paste.ts` | The threshold, the filename, `isLargePaste`, `buildPastedTextFile`. |
| `src/client/components/MessageInput/MessageInput.tsx` | `handlePaste` — the new branch, after the image branch. |
| `src/client/components/MessageInput/hooks/useUploadBackend.ts` | `handleAddFiles`, unchanged — chat mode POSTs, overlay mode buffers. |
| `src/client/hooks/useFileUpload.ts` | Unchanged — chips, POST, draft persistence, `UploadRef`s. |
| `src/server/orchestrator/services/files.ts` | Unchanged — `deduplicateFilename` is what makes a fixed base name safe. |

## Tests

- `MessageInput/large-paste.test.ts` — the boundary at exactly 2,000, one below,
  empty, and the `File`'s name/type/content/byte size.
- `MessageInputLargePaste.test.tsx` — the composer-level behaviour: the chip and
  its name, `preventDefault`, a sub-threshold paste left alone, a dead composer
  refusing the paste, and image-beats-text.

Each guard was confirmed to fail on its own against a mutation of the thing it
guards (feature removed, threshold widened, branch order swapped, `inert` guard
dropped, character count replaced by `String.length`). Two things worth knowing
about what these tests can and cannot fail on:

- "The text did not land in the input" is asserted through `defaultPrevented`,
  not by reading the textarea. jsdom never inserts pasted text, so an
  empty-textarea assertion would pass with the feature deleted.
- Every other case is written against `LARGE_PASTE_THRESHOLD_CHARS`, so it would
  stay green if the threshold were changed. One case pins the literal `2000` and
  `"pasted-text.txt"` — the approved values, as opposed to the boundary
  behaviour.

Verified end-to-end in the dogfood inner instance rather than only in jsdom: a
3,420-character paste into a live session composer left the textarea empty and
produced a `pasted-text.txt` 3.3 KB chip; a second paste produced
`pasted-text-1.txt`; both appear under **Uploads** in the file tree.

## Known limits, not fixed here

An independent review surfaced three defects in the **inherited** upload path
that a converted paste is now exposed to. None is introduced by this change and
each affects pasted images and drag-dropped files identically, but a pasted text
block is the case where the clipboard is the user's only other copy:

- **Sending while the upload is in flight drops it silently.** `getUploadRefs`
  ships only `ready` uploads, while `markUploadsSent` clears *all* pending chips
  — so a send in that window produces a message with no attachment and no chip.
  Tracked as its own work item; the fix is a Send gate, which needs its own UX
  decision about what a blocked Send says.
- **"Retry" on a failed upload deletes it without retrying** — `retryUpload`
  removes the item and keeps no copy of the bytes to re-POST.
- **The overlay closes before its multipart send resolves**, so a failure there
  restores neither the draft nor the files.
