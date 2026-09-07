# Checklist — an out-of-date upload listing never overwrites what is true

## Hydration

- [x] Capture a hydration generation and an uploads-change counter before the request
- [x] Drop a superseded listing without refetching (req 3)
- [x] Drop a listing for a session the user has left (req 2)
- [x] Refetch once when the listing predates a change this client made (req 1)
- [x] Bound the refetch chain so a churning session cannot spin the server
- [x] Verify the session guard is safe — `switchSession` sets the id synchronously
- [x] Note the change where uploads land and where they are deleted

## `/compact`

- [x] Move the `/compact` parser to `shared/` so client and server cannot drift
- [x] The command carries no attachment of either kind (req 6)
- [x] The chips stay in the composer for the next message (req 5)
- [x] No defensive server change — the client no longer produces the state

## Testability of the send paths

- [x] Extract the attachment decision into `buildAttachmentPlan`, pure and tested
- [x] Route both `App.handleSend` paths through it
- [x] Delete `buildReviewSendFrame` — subsumed, and it only covered one branch
- [x] Leave the effectful parts of `handleSend` in `App`

## Quality

- [x] Tests for all four hydration guards and every clause of the plan
- [x] Every clause proved red on its own against a targeted mutation
- [x] Rewrite the bound's test so it fails as an assertion rather than a crash
- [x] Fix the existing hydration fixtures the session guard correctly broke
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [ ] Full `npm test` after the App refactor
- [ ] Independent review of the branch against the requirements
- [ ] Verify in a real browser on the dogfood instance
