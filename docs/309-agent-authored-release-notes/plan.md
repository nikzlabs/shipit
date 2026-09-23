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

**The ignore rule is branch content, so it protects only while it is checked
out.** It covers the two moments that matter — the clean-tree check and the
post-turn auto-commit both happen on the session branch, whose tree comes from
`main`. It does *not* cover the window after `prepare` checks out the release
branch, whose `.gitignore` comes from `stable` and will not carry the rule until
a release ships it. That is why the draft is read into memory up front: the
mechanism does not depend on the file surviving a checkout, so the worst case in
that window is a stray untracked file, not lost text. The agent is also told to
verify the ignore rule exists before drafting at all, which is what keeps this
from reaching a repo that never adopted the flow.

The committed file is **version-stamped**, not a single rolling
`RELEASE_NOTES.md`. A rolling file would let CI publish the *previous* release's
notes; stamping makes that impossible — the lookup is for the tag being
published, so absence is unambiguous, and under req 6 absence fails the publish
rather than falling back.

## Flow

1. User: "cut a patch release."
2. Agent works out what the release ships, writes a compact summary to
   `RELEASE_NOTES.draft.md`, runs `shipit release plan patch` for the version
   arithmetic, and emits the propose marker — which is what raises the
   `proposed` card. The draft is written **before the card appears**, because
   **Confirm & publish** is the only action and it accepts the notes too (req 4);
   a card offered ahead of the draft would make that click uninformed (req 10).
3. User opens the draft from the card, edits it, says go.
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

## The card is raised by the proposal, and points at the draft

Two rules, and the first is what makes the second reachable.

**Only a proposal raises the card (req 10).** `shipit release plan` is version
arithmetic — it used to call `releaseStatusPoller.propose` on every invocation,
so a read-only command raised a confirmation card, necessarily before any draft
existed. That call is gone; the agent's `propose` marker is the one thing that
raises a `proposed` card, plus `prepare --prerelease`, which proposes an rc it
is about to tag (req 10a). `plan` instead **warns** when the draft is missing:
it is the only point in the flow where the orchestrator can answer the agent,
and without that a forgotten draft would be a marker that silently does nothing.

**A release that will publish notes and has none raises nothing** (req 10).
`reactToReleaseMarkers` resolves the draft before proposing and drops the
proposal when a required draft is absent — the card is the confirm button, so
showing one for a release `prepare` would refuse is the same defect in a later
phase. Exempt, and so carded with no link (req 10a): a prerelease, and a repo
whose `release.yml` does not read `.release-notes/`.

That workflow test reads the **session checkout**, not `prepare`'s payload ref.
At propose time no payload is chosen yet — `--pick`/`--from` are arguments to a
command that has not run — so the question the card can actually ask is "does
this repo publish authored notes", which is also the grep the agent is told to
run. **This is an approximation, and it is wrong in both directions.** Review
established that, against an earlier claim here that only one case diverged:

- *Checkout older than the payload.* A long-lived session whose branch predates
  the notes-aware workflow proposes a release for `--from main`. Its checkout
  looks exempt, so the card appears with no draft — defect 1 in miniature. It
  is bounded and self-correcting rather than silent: `prepare` refuses, naming
  `RELEASE_NOTES.draft.md`, before touching the branch, so the cost is one
  round-trip and no release goes out wrong.
- *Checkout newer than the payload.* A `--pick` hotfix onto a maintenance branch
  still carrying the old workflow: the card demands a draft `prepare` would not
  require, and then links it. The link says "read or edit" rather than "this is
  what publishes" precisely because it cannot promise publication here;
  `prepare`'s warning (req 6b) is what says the notes will be ignored.

The alternative is probing several candidate refs post-turn — the checkout, the
maintenance branch, the default branch — to guess a payload the user has not
chosen yet. That buys a corner case at the cost of git work on every proposal
and a rule nobody can predict, so the approximation stays and is stated here
rather than claimed away.

**Pending cards raised before this change are left alone.** A persisted
`proposed` card carrying the old `notes` field keeps its Confirm button and
gains no link; it is not revalidated. Publication is gated at `prepare` (req 6),
which refuses a release with no notes whatever the card says, and the poller's
in-memory state does not survive the upgrade that would create such a card — so
a migration would add mechanism to a card that is already inert.

**The card links to the draft; it carries no copy of it (req 11).** The
`proposed` card renders `notesDraftPath` as a link that opens the file in
ShipIt's editor — the same editor the user edits it in, so one affordance both
shows and changes the notes, and there is no second copy to fall out of date
when they do. This replaced an inlined-text design at the user's suggestion; it
is also what removes the staleness question an inlined copy would have raised.

Nothing agent-written reaches the card any more. The `notes` free-text field is
gone from every marker (`propose`, `pr-opened`, `tagged`) and `ReleaseStatusSummary.notes`
is gone with it: it was rendered **only** in the `proposed` phase, which is
exactly the phase where it was guaranteed not to be the published text, and the
published body already lives in `release.body`.

## Changes

**`src/server/orchestrator/release-notes-draft.ts`** (new) — the draft's name,
`readDraftNotes(dir)`, and `repoPublishesAuthoredNotes(dir)`. Shared by
`release-prepare` (the refusal), the plan route (the warning), and
`release-flow` (the card gate), so the three cannot drift on what "has notes"
means. The blank test is `trim()`, matching CI's `grep -q '[^[:space:]]'`.

**`src/server/orchestrator/services/release-prepare.ts`** — the draft is read
into memory **before any branch work**, the notes are **resolved and required**
before the branch is touched, written to `.release-notes/<tag>.md` after the
bump, added to the commit, and unlinked **only once the PR exists**.

The requirement is a refusal, not a fallback (req 6): with no draft and nothing
recoverable, `prepare` throws a 400 naming `RELEASE_NOTES.draft.md`, **before**
`createBranchFrom` so a fixable omission never costs the session a rewritten
tree.

**The gate is conditional on the workflow the release will actually run**
(`workflowPublishesAuthoredNotes`, probing `.github/workflows/release.yml` on
the payload ref). Unconditional was wrong twice over: a repo that never adopted
the flow could not release at all (req 9), and a `--pick` hotfix onto a
maintenance branch still carrying the old workflow would commit notes that
nothing publishes — the release-branch form of the cold-start problem. The
payload ref mirrors the branch selection: `--from <branch>` ships that branch's
workflow, `--pick` and a bare bump keep the maintenance branch's. Writing notes
a workflow will ignore produces a warning rather than a silent no-op (req 6b).

Three further failure cases drove the ordering, all raised by review:

- *Retry.* `prepare` is documented to "open **or update**" the PR, and an update
  resets `release/<version>` to the release branch and rebuilds it. With the
  draft already consumed by the first run, a second run would force-push a
  release carrying no notes at all. So when there is no draft, the notes are
  recovered from `origin/release/<version>` (`git.showFileAtRef`) before the
  commit — req 5 has to hold on the second run, not just the first.
- *Commit or push fails.* Deleting the draft at commit time lost the user's text
  whenever the push or the PR call failed afterwards. It is now the last act.
- *Checkout.* Reading before the branch work means no checkout can decide
  whether the text survives, which also contains the gap below.

**`.github/workflows/release.yml`** — a **separate gate runs before the tag is
created**, failing a final release whose commit carries no non-empty notes. It
has to precede the tag: `resolveLatestStableTag` offers any reachable final tag
without checking that its Release exists, so a tag pushed and then failed on is
a release the stable channel already advertises — and the notes can never be
added to that immutable commit afterwards. Failing first leaves nothing
published and the branch's next attempt clean. The content test is
`grep -q '[^[:space:]]'`, not `[ -s ]`: a whitespace-only file has bytes but no
notes, and `prepare` and the update panel both treat it as absent.

The publish step then uses `--notes-file` with the notes **at the tag**, and
keeps `--generate-notes` only for a prerelease (req 6a) — a final release can no
longer reach it. Reading from the tag rather than the checkout is what the
**repair path** needs: it republishes an older tag while the checkout is a later
`stable` commit that can carry different notes for the same version, and
`resolveReleaseNotes` reads the tag — so a checkout-sourced body would make reqs
5 and 8 disagree about the same release. CI appends the `**Full Changelog**` link
itself (req 5) because a supplied body is published verbatim; a first release,
having no previous final tag, links `commits/<tag>` instead of a compare range.
CI is also where the previous tag is reliably resolvable (`fetch-depth: 0` plus
the existing `git fetch origin --tags --force`); the orchestrator's session clone
carries no such guarantee.

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

`release.notes` in `shipit.yaml` has since been **removed** rather than wired up:
it was validated and read by nothing, and the value it advertised
(`github-generated`) named the behaviour this feature took away. The same pass
removed the other four unread release keys — `tag-pattern`,
`prerelease-pattern`, `gate`, `workflow` — leaving `version-source`,
`version-source-path`, `branch` and `mechanism` as the whole schema. An unknown
`release.*` key is a warning, not an error, so a config still carrying one keeps
parsing.

The `tag-triggered` mechanism and other repos keep generated notes (req 9) —
`prepare` still commits the notes file on the tag path, so extending this is
later a workflow change alone.

## Key files

- `src/server/orchestrator/release-notes-draft.ts` — what counts as having notes
- `src/server/orchestrator/services/release-prepare.ts` — commits the notes file
- `src/server/orchestrator/services/release-flow.ts` — raises the card, or doesn't
- `src/server/orchestrator/services/updates.ts` — reads it back for the panel
- `src/client/components/ReleaseLifecycleCard.tsx` — links to the draft
- `src/client/components/Settings/tabs/UpdatePanel.tsx` — renders it
- `.github/workflows/release.yml` — publishes it
