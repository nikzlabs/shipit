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

**The filename is a fixed base, not a timestamp.** `saveUploadedFile` already
deduplicates on write (`deduplicateFilename` in
`orchestrator/services/files.ts`), so a second paste becomes `pasted-text-1.txt`.
A predictable name reads better in chat and in the agent's prompt than a
timestamp does.

**The paste is measured in characters, the file in bytes.** The threshold is a
readability limit, so characters are the right unit; the resulting `File` sizes
itself in UTF-8 bytes, which is the unit the 50 MB per-file limit and the session
quota use.

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

Each of the five composer-level cases was confirmed to fail on its own against a
mutation of the thing it guards (feature removed, threshold widened, branch order
swapped, `inert` guard dropped). Note that "the text did not land in the input"
is asserted through `defaultPrevented`, not by reading the textarea: jsdom never
inserts pasted text, so an empty-textarea assertion would pass with the feature
deleted.
