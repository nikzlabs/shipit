# Checklist — the composer works before the session is warmed up

- [x] `settingsLocked` in `MessageInput` — the four selectors read "can this pick be
      delivered", not "is Send open" (reqs 1, 2)
- [x] `leavePendingRole` clears the saved role seed when no session is bound, so the
      connect URL cannot reapply a role over the parameter the user just changed (req 4)
- [x] `discardHeldFirstMessage` from `resumeSessionInternal` — a stashed message does not
      follow the user into the session they switch to (pre-existing misdelivery hole)
- [x] Tests: selectors live/dead in both directions and mid-turn, the role seed in both
      the bound and unbound cases, the switch and the resume-itself cases
- [x] `npm run typecheck`, `npm run lint:dev`, full client suite green
- [x] Independent review against the numbered requirements (Codex, via `--role reviewer`)
- [x] Open question answered (2026-09-07): Send goes on waiting for the workspace; reqs 3
      and 5 withdrawn — see the receipt in `requirements.md`
