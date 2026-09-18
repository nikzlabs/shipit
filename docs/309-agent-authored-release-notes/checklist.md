# Agent-authored release notes — checklist

- [x] `.gitignore` — `RELEASE_NOTES.draft.md`
- [x] `release-prepare.ts` — commit the draft as `.release-notes/<tag>.md`, delete the draft
- [x] `release-prepare` tests — draft present / absent / empty / commit failed
- [x] `release.yml` — publish with `--notes-file` when the file exists, append the compare link
- [x] `updates.ts` — `releaseNotes` read from `git show <tag>:.release-notes/<tag>.md`
- [x] `updates.ts` tests — notes present / absent / non-stable channel / commit label
- [x] `UpdatePanel.tsx` — render the notes, fall back to the commit list
- [x] `UpdatePanel` test — both branches
- [x] `shipit-docs/release.md` — drafting step + the named exception to "write nothing"
- [x] `prompts/releases.md` — the agent drafts and waits
- [x] `RELEASING.md` — the notes step
- [x] `wiki/installing-and-updating.md` — what the update panel now shows
- [x] `lint:dev` + `typecheck` clean
- [ ] Independent review via `shipit agent run --role reviewer`
