---
title: Agent-authored release notes
description: The agent drafts compact release notes from the commits; the user edits and accepts them; the accepted text is the published Release body.
---

# Agent-authored release notes

Today the published GitHub Release body is whatever `gh release create
--generate-notes` produces — one line per merged pull request since the previous
tag, grouped into label sections by `.github/release.yml`. The agent can draft a
notes preview (`shipit release prepare --notes`), but that text reaches only the
version-bump PR's body and is discarded the moment CI publishes
(`release-status-poller.ts:253` overwrites the card's notes with the GitHub
body). `release.notes` in `shipit.yaml` is validated and read by nothing.

1. When a release is cut, the agent drafts the release notes from the commits
   that release contains.
2. The draft is a **compact summary** — prose and grouped highlights, not one
   line per commit or per pull request.
3. The user can **edit** the draft before anything is published.
4. Nothing publishes until the user **accepts** the draft. Accepting is an
   explicit act, distinct from confirming the release itself.
5. The text the user accepted is the **body of the published GitHub Release**.
6. A release cut without an accepted draft still publishes, falling back to
   today's auto-generated notes. Drafting notes is never a precondition for
   cutting a release.
7. The user reviews and accepts without leaving ShipIt.

## Open questions

- **Review surface.** An editable card in the chat transcript (the
  `BugReportCard` pattern: textarea, Cancel / Accept) or a file the agent writes
  that the user opens in ShipIt's Monaco file editor?
- **Replace or augment.** Do the accepted notes become the entire Release body,
  or sit above GitHub's generated section as a summary header?
- **Settings → Update changelog.** That panel today renders `git log --oneline`
  capped at 10 lines (`updates.ts:227-233`, `UpdatePanel.tsx:258-264`) — a raw
  commit list, not the Release body. Does it switch to showing the accepted
  notes, or is that out of scope here?
- **Scope of repos.** Must this work for any repo ShipIt cuts a release for, or
  is ShipIt's own `release-branch` flow enough for a first version?

## Resolved questions

- (none yet)
