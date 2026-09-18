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

**Provenance.** Each requirement is marked *[stated]* — the user asked for it, in
their words or as a direct answer to a question — or *[agent]* — the agent
supplied it and the user has not endorsed it. The distinction exists because the
first version of this doc did not make it, and the user had to point out that
requirements they never confirmed were being cited as the contract. An *[agent]*
requirement is a candidate: it can be struck without argument.

1. *[stated]* When a release is cut, the agent drafts the release notes from the
   commits that release contains.
2. *[stated]* The draft is a **compact summary** — prose and grouped highlights,
   not one line per commit or per pull request.
3. *[stated]* The user can **edit** the draft before anything is published.
4. *[stated]* There is **one action: "confirm release."** Confirming the release
   is what accepts the notes — no separate acceptance step. The agent must
   therefore have written the draft and said where it is *before* the
   confirmation is offered, so confirming is always an informed act.
5. *[stated]* The text the user accepted is the **entire body of the published
   GitHub Release** — it replaces the auto-generated per-PR list rather than
   sitting above it.
   - 5a. *[agent]* The published body ends with a link to the full commit range,
     so the per-PR detail stays one click away. Introduced by the agent while
     putting req 5 to the user; not separately asked for.
6. *[agent]* A release cut without a draft still publishes, falling back to
   today's auto-generated notes. Drafting notes is never a precondition for
   cutting a release.
7. *[stated]* The draft is a **file** the user opens and edits in ShipIt's own
   editor — chosen over an editable chat card, for simplicity.
8. *[stated]* Settings → Update shows the notes for the version it is offering
   as an update, in place of today's raw commit list. When a version has no
   notes, the commit list stays.
   - 8a. A **downgrade** is not a version offered as an update and so is outside
     req 8: `update-notice.ts:86` already computes `available && !isDowngrade`,
     so ShipIt does not classify one as an available update anywhere else
     either. The panel keeps showing which commits the downgrade would drop,
     which is the only question that arises there.
9. *[stated]* ShipIt's own `release-branch` flow is the scope. Other repos and
   the `tag-triggered` mechanism keep today's generated notes.

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
- 2026-09-18 — **Is accepting the notes an act distinct from confirming the
  release?** No: *"there should be a single action 'confirm release'."* The user
  also noted that this requirement, and others, were the agent's invention and
  had never been confirmed — hence the provenance markers above. → req 4.
- 2026-09-18 — **On a downgrade, show the target's notes or the commits you'd
  lose?** The user asked what a downgrade even is and whether ShipIt supports
  it. Answer from the code: it is not a button — it is what happens when the
  release channel is switched **edge → stable** while stable's latest final tag
  is behind the running code (`updates.ts:250`, `isDowngrade = behindBy === 0`;
  designed in `docs/162-release-channels/plan.md:270`, which also puts a real
  "safe downgrade" guarantee out of scope). The panel warns and **Update Now**
  still applies it. No new decision was needed: ShipIt already excludes a
  downgrade from "an available update" at `update-notice.ts:86`, so req 8 as
  written does not reach it. → req 8a.
