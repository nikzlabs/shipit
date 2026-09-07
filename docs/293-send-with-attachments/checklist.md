# Checklist — Send never loses an attachment

- [x] Collapse the five copies of the send bar into one derived `sendBlocked`
- [x] Bar Send while any attachment is uploading (req 1)
- [x] Bar Send while any attachment has failed (req 2)
- [x] Say why on the blocked button (`sendBlockedReason`)
- [x] `retryUpload` re-POSTs the kept bytes instead of deleting the chip (req 3)
- [x] Drop kept bytes on success, on removal, and on send
- [x] Return early from retry on a `ready` upload, so the fallback cannot delete it
- [x] Allow a send with attachments and no text (req 5), still refuse an empty one (req 6)
- [x] Confirm no server change is needed (`assemblePrompt` filters empty parts; `role === "user"` renders a bubble)
- [x] Component tests for every bar, including the Enter path
- [x] Hook tests for retry, including a second retry and a `ready` upload
- [x] Every clause proved red on its own against a targeted mutation
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [x] Full `npm test` run, since `retryUpload`'s semantics and the send bar are shared surfaces
- [ ] Independent review of the branch against the requirements
- [x] Verified in a real browser on the dogfood instance
