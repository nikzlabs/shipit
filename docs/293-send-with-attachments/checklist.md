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
- [x] Resume an upload whose hook was remounted, derived from state (req 7)
- [x] Skip chips already in flight, so StrictMode's double effect does not double-POST
- [x] Remove available on every chip in every state, including mid-upload (req 7)
- [x] Error face + Retry on a failed image, not only a failed file (req 2)
- [x] Roll the upload batch back when one file is rejected (req 4)
- [x] `/review` carries the composer's uploads (req 4)
- [x] Accept an empty prompt server-side when files are attached (reqs 5, 8)

## Quality

- [x] Confirm no other server change is needed (`assemblePrompt` filters empty parts; `role === "user"` renders a bubble)
- [x] Tests for every bar, including the Enter path and the overlay surface
- [x] Hook tests for retry, resume, remount, StrictMode and byte lifetime
- [x] Integration test for the batch rollback; service test for the empty prompt
- [x] Every clause proved red on its own against a targeted mutation
- [x] Remove the byte release in `markUploadsSent` — its mutation stayed green, so it guarded nothing
- [x] Replace docs/292's timing-based bounded-scan test with a counted one
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [x] Full `npm test` run — shared surfaces (`retryUpload`, the send bar, the upload route)
- [x] Independent review of the branch against the requirements
- [x] Verified in a real browser on the dogfood instance
- [ ] Second review pass over the changes the first one prompted
