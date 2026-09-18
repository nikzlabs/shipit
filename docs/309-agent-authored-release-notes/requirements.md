---
issue: planning#597
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
5. The text the user accepted is the **entire body of the published GitHub
   Release** — it replaces the auto-generated per-PR list rather than sitting
   above it. The published body still ends with a link to the full commit range,
   so the per-PR detail stays one click away.
6. A release cut without an accepted draft still publishes, falling back to
   today's auto-generated notes. Drafting notes is never a precondition for
   cutting a release.
7. The user reviews and accepts without leaving ShipIt. The draft is a **file**
   the user opens and edits in ShipIt's own editor; the agent proceeds on the
   user's say-so in chat.
8. Settings → Update shows the accepted notes for the version it is offering,
   in place of today's raw commit list. When a version has no accepted notes,
   the commit list stays.
9. ShipIt's own `release-branch` flow is the scope. Other repos and the
   `tag-triggered` mechanism keep today's generated notes.

## Open questions

- (none)

## Resolved questions

- 2026-09-18 — **Review surface?** A file the user opens in ShipIt's Monaco
  editor, not an editable chat card. Reason given: simplicity. → req 7.
- 2026-09-18 — **Replace GitHub's generated list, or sit above it?** Replace
  entirely, with the per-PR detail one click away. The option was put to the
  user saying GitHub would still append its own "Full Changelog" compare link;
  that is true of `--generate-notes` only — a supplied body is published
  verbatim. The link is therefore appended deliberately rather than inherited,
  which is what makes the answer hold. → req 5.
- 2026-09-18 — **Should Settings → Update show these notes?** Yes — switch it off
  the `git log --oneline` list it renders today. → req 8.
- 2026-09-18 — **How wide?** ShipIt's own release-branch flow first. → req 9.
