# Checklist — the composer works before the session is warmed up

- [x] `settingsLocked` in `MessageInput` — the four selectors read "can this pick be
      delivered", not "is Send open" (reqs 1, 2)
- [x] Drop the claim clause from the composer's `disabled` on `/{repo}/new` (req 3)
- [x] `holdFirstUserMessage` — stash a first message with no session id (req 3)
- [x] Graduate the URL to `/session/{id}` when the id arrives with a message held (req 3)
- [x] `discardHeldFirstMessage` on claim failure, on a repo switch, and on a switch to an
      existing session — the last one closes a misdelivery hole `resumeSessionInternal`
      already had (req 5)
- [x] `carryHeldMessage` — the held bubble survives the history install (req 3)
- [x] Tests: selectors live/dead in both directions, the stash's shape, discard on
      failure / repo switch but not on success, the transcript install
- [x] `npm run typecheck`, `npm run lint:dev`, full client suite green
- [x] Independent review against the numbered requirements
