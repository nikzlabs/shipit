# Checklist — Send never loses an attachment

## The send gate

- [x] Collapse the five copies of the send bar into one derived `sendBlocked`
- [x] Bar Send while any attachment is uploading (req 1)
- [x] Bar Send while any attachment has failed (req 2)
- [x] Say why on the blocked button (`sendBlockedReason`)
- [x] Allow a send with attachments and no text (req 5), still refuse an empty one (req 6)

## Never lose the attachment

- [x] `retryUpload` re-POSTs the kept bytes instead of deleting the chip (req 3)
- [x] Hold the bytes at the chips' lifetime, beside the store, not in the hook (reqs 3, 7)
- [x] Hold the in-flight set there too — an unmounted hook's `fetch` keeps running
- [x] Resume an upload whose hook went away before its POST started (req 7)
- [x] Never restart an upload whose request is still open
- [x] Roll the upload batch back when one file is rejected (req 4)
- [x] Claim each filename with an exclusive create, so the rollback owns what it deletes
- [x] Clean up a partial write; log rollback failures rather than swallowing them
- [x] `/review` carries uploads **and** `@`-mentioned files, and consumes them (req 4)
- [x] Accept an empty prompt server-side when files are attached (reqs 5, 8)

## Always a way out

- [x] Remove available on every chip in every state, including mid-upload (req 7)
- [x] Reveal it without hover, for touch and keyboard (req 7)
- [x] Error face + Retry on a failed image, not only a failed file (req 2)
- [x] An upload removed mid-flight stays removed — file deleted, no draft recorded

## Quality

- [x] Confirm no other server change is needed (`assemblePrompt` filters empty parts; `role === "user"` renders a bubble)
- [x] Tests for every bar, including the Enter path and the overlay surface
- [x] Hook tests for retry, resume, remount-mid-flight, StrictMode and byte lifetime
- [x] Service test for concurrent same-name uploads and partial writes
- [x] Integration test for the batch rollback; service test for the empty prompt
- [x] Every clause proved red on its own against a targeted mutation
- [x] Four mutations came back green — each fixed as a finding, not accepted as a pass
- [x] Replace docs/292's timing-based bounded-scan test with a counted one
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [x] Two independent reviews; every finding verified before acting on it
- [x] Out-of-scope defects recorded and filed as planning#519
- [x] Full `npm test` after the second round of fixes
- [x] Re-verify in a real browser on the dogfood instance
