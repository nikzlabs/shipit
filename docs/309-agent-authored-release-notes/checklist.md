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
- [x] Independent review via `shipit agent run --role reviewer` (Codex)
- [x] Review fix — retry recovers notes from the pushed release branch
- [x] Review fix — draft deleted only once the PR exists
- [x] Review fix — CI reads the notes from the tag, not the checkout (repair path)
- [x] Review fix — first release links `commits/<tag>` when no previous final tag exists
- [x] Review fix — drafting scoped to repos whose workflow and `.gitignore` support it
- [x] Review fix — strengthen the two tests that could not fail
- [ ] **Open with the user:** req 4's distinct acceptance act, and req 8's downgrade case
- [ ] Known gap: `checkForUpdates()`'s `releaseNotes` wiring is uncovered — it reads the
      fixed `HOST_REPO_DIR` (`/opt/shipit`), which no test can supply. `resolveReleaseNotes`
      is tested directly instead.
