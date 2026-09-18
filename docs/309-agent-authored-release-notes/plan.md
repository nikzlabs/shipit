---
title: Agent-authored release notes — design
description: A gitignored draft file the user edits, committed by release prepare as .release-notes/<tag>.md, published by CI with --notes-file.
---

# Agent-authored release notes — design

Implements [requirements.md](./requirements.md).

## Shape

Two files, one gitignored and one committed:

| Path | Lifetime | Who writes it |
|---|---|---|
| `RELEASE_NOTES.draft.md` | One release, deleted on `prepare` | The agent drafts it; **the user edits it** |
| `.release-notes/<tag>.md` | Committed, permanent | `shipit release prepare` |

The draft is **gitignored on purpose**, and that one decision carries the whole
flow (req 3, 4, 7):

- `prepare` refuses a dirty working tree (`release-prepare.ts:280`), and the
  user's edit lands *exactly* between propose and prepare. A tracked draft would
  make the expected flow fail on its own safety check.
- The post-turn auto-commit would otherwise put the draft on the session branch.
- It must survive `git checkout -B release/<version> origin/stable`
  (`createBranchFrom`), which drops files tracked only on the session branch but
  leaves untracked ones alone.

It stays visible and editable because **neither the file tree nor the editor
consults `.gitignore`** — `file-tree.ts:19` skips only `WORKSPACE_SKIP_DIRS`
(`fs-constants.ts:15-26`), and `FileEditModal.tsx` opens any workspace path with
Monaco, `.md` included.

The committed file is **version-stamped**, not a single rolling
`RELEASE_NOTES.md`. A rolling file lets CI publish the *previous* release's notes
whenever a release is cut without drafting any; stamping makes that impossible —
the lookup is for the tag being published, so absence is unambiguous and falls
back to today's generated notes (req 6).

## Flow

1. User: "cut a patch release."
2. Agent reads `git log origin/stable..origin/main`, writes a compact summary to
   `RELEASE_NOTES.draft.md`, runs `shipit release plan patch`, and stops at the
   `proposed` card — pointing the user at the file.
3. User opens the draft in ShipIt's editor, edits it, says go.
4. Agent runs `shipit release prepare patch --from main`. `prepare` reads the
   draft, commits it as `.release-notes/v<version>.md` next to the version bump,
   deletes the draft, and opens the PR.
5. User merges. `release.yml` finds `.release-notes/<tag>.md` on the merged
   commit and publishes with `--notes-file` instead of `--generate-notes`.

The draft is **the one file an agent may write in a release session.** The
standing "write nothing" rule (`shipit-docs/release.md`) exists because a written
file is auto-committed onto the open release PR — a gitignored draft cannot be,
so the rule's reason does not reach it. The exception is named explicitly in the
doc rather than left for the agent to infer.

## Changes

**`src/server/orchestrator/services/release-prepare.ts`** — after the version
bump and before `commitPaths`: if `RELEASE_NOTES.draft.md` exists and is
non-empty, write it to `.release-notes/<tag>.md`, add that path to the commit,
and unlink the draft. No draft ⇒ nothing committed, no behaviour change.

**`.github/workflows/release.yml`** (publish step) — if
`.release-notes/<TAG>.md` exists at the checked-out commit, publish with
`--notes-file`; otherwise keep `--generate-notes`. CI appends the
`**Full Changelog**: …/compare/<prev>...<tag>` line itself (req 5) because a
supplied body is published verbatim — GitHub appends that link only for
`--generate-notes`. CI is also where the previous tag is reliably resolvable
(`fetch-depth: 0` plus the existing `git fetch origin --tags --force`); the
orchestrator's session clone carries no such guarantee.

**`src/server/orchestrator/services/updates.ts`** — new optional
`releaseNotes?: string` on `UpdateStatus`, read with
`git show <tag>:.release-notes/<tag>.md` under the same guard `releaseUrl`
already uses (`channel === "stable"` and a `v\d+\.\d+\.\d+` version). Reading the
committed file rather than fetching the published Release body keeps the
update-status path offline and unauthenticated; the two differ only by the
compare link CI appends, and `releaseUrl` remains for the published body.

**`src/client/components/Settings/tabs/UpdatePanel.tsx`** — render
`releaseNotes` when present, in place of the `commitMessages.slice(0, 10)` list
(req 8); keep the commit list as the fallback. Same treatment as the release
card's `Notes` (`ReleaseLifecycleCard.tsx:88-95`): pre-wrapped, scroll-capped.

**`.gitignore`** — `RELEASE_NOTES.draft.md`.

**Docs** — `src/server/shipit-docs/release.md` (the drafting step and the named
exception to "write nothing"), `prompts/releases.md`, `RELEASING.md`.

## Not in scope

`release.notes` in `shipit.yaml` stays validated-but-unread
(`shipit-config.ts:549-554`); wiring it is a separate question from this one.
The `tag-triggered` mechanism and other repos keep generated notes (req 9) —
`prepare` still commits the notes file on the tag path, so extending this is
later a workflow change alone.

## Key files

- `src/server/orchestrator/services/release-prepare.ts` — commits the notes file
- `src/server/orchestrator/services/updates.ts` — reads it back for the panel
- `src/client/components/Settings/tabs/UpdatePanel.tsx` — renders it
- `.github/workflows/release.yml` — publishes it
