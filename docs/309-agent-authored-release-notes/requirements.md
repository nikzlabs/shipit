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
6. *[stated]* **GitHub's auto-generated per-PR list is never published.** The
   body is always the agent-authored notes. Confirming the release accepts them
   as they stand — the user does not have to have edited them for them to count
   as accepted. Drafting notes is therefore a **precondition** for cutting a
   release, not an optional extra.
   - 6a. *[stated]* **Prereleases are the one named gap.** A prerelease tags an
     existing commit and so cannot carry a notes file; it keeps the generated
     list. This is recorded, not hidden — a prerelease reaches no install
     automatically, so it is never the notes anyone reads to decide whether to
     update. Every **final** release is covered with no exception, including a
     hand-pushed final tag. The user's answer named release candidates, which is
     the prerelease form this repo cuts (`vX.Y.Z-rc.N`); the gap is stated as
     *prerelease* because that is the
     classification the workflow actually branches on — any `vX.Y.Z-<suffix>`
     tag — and a narrower wording would describe something the code does not do.
   - 6b. *[agent]* A repo whose release workflow does **not** publish authored
     notes is not blocked from releasing (req 9): the precondition is enforced
     only where the workflow the release ships reads `.release-notes/<tag>.md`.
     Authoring notes that such a workflow would ignore produces a warning rather
     than a silent no-op.
7. *[stated]* The draft is a **file** the user opens and edits in ShipIt's own
   editor — chosen over an editable chat card, for simplicity.
8. *[stated]* Settings → Update shows the notes for the version it is offering
   as an update, in place of today's raw commit list. Releases cut *before* this
   feature carry no notes and keep the commit list; under req 6 no new release
   can.
   - 8a. A **downgrade** is not a version offered as an update and so is outside
     req 8: `update-notice.ts:86` already computes `available && !isDowngrade`,
     so ShipIt does not classify one as an available update anywhere else
     either. The panel keeps showing which commits the downgrade would drop,
     which is the only question that arises there. **This is intent, not
     observed behaviour** — `isDowngrade` is currently unreachable for an
     edge → stable switch (planning#598), so in practice the notes *are* shown.
     The guard is written for the detection once that is fixed.
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
- 2026-09-18 — **Should a release without a draft fall back to the generated
  notes?** No: *"the today's notes (list of commits) should never be used.
  Always agent-generated. If the user publishes the release, the agent-generated
  notes are considered accepted even if the user didn't edit them."* This struck
  req 6, which was an *[agent]* requirement asserting the opposite — the first
  invented requirement the provenance markers caught. It inverts the design:
  notes go from optional-with-fallback to a precondition enforced at
  `prepare` and again in CI. → req 6, req 8.
- 2026-09-18 — **Under req 6, what happens to release candidates, which cannot
  carry a notes file?** They keep the generated list, as a named gap. Evidence
  the user asked for and decided on: an rc reaches no install automatically —
  the stable channel resolves the latest **final** tag (`pickLatestFinalTag`
  skips prereleases) and edge tracks `main`, not tags (`RELEASING.md:188`), so
  testers pin the tag by hand — and **no rc has ever been cut here**
  (`git tag --list 'v*-*'` is empty across v0.1.0…v0.4.1). → req 6a.
- 2026-09-18 — **"How exactly does it check that stable is behind? stable
  commits are squashed, 1 per release."** The user was right and the answer
  above was wrong about the mechanism. `isDowngrade = behindBy === 0`
  (`updates.ts:250`) assumes the target is an ancestor of HEAD; squash-merged
  stable commits are never reachable from `main`, so `HEAD..<stable tag>` counts
  stable's *own* release commits (10 at v0.4.1) and can never be 0. The check is
  unreachable for edge → stable, and an edge install is offered a release 1327
  commits behind it as "10 commits behind" with no warning. Filed as
  planning#598; out of scope here, and req 8a is restated as intent rather than
  observed behaviour.
