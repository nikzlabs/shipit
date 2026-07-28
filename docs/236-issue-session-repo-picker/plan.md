---
issue: https://linear.app/shipit-ai/issue/SHI-249
title: Choose the repository when starting a session from an issue
description: The Issues-tab Start-session button becomes a split control so an issue can be started in any repo, not just the one the current session is on.
---

# Choose the repository when starting a session from an issue

## The problem

The Issues tab's **Start session** action has no notion of a target repository —
it derives one implicitly, and always the same way (`App.tsx`):

```ts
sessions.find((s) => s.id === sessionId)?.remoteUrl ?? useRepoStore.getState().activeRepoUrl
```

That is: *the repo the session you're currently sitting in is checked out on*.

It's the right default and the wrong only-option. Linear issues are
**workspace-wide** — the tracker has no repo binding at all (see
`docs/156-issue-to-session`'s "Repo resolution" table) — so the list you're
scrolling routinely contains issues belonging to a project other than the one
you're working in. Starting one of those meant a five-step detour:

1. Switch repos in the sidebar `RepoSwitcher`.
2. Open a new session there.
3. Come back to the Issues tab.
4. Re-find the issue (the list has refetched, filters aside).
5. Click Start session.

...to accomplish something the user had already decided on at step 0. Worse, if
they forgot step 1, Start session silently seeded the prompt into the *wrong*
repo — the failure is quiet, and only shows up once the agent starts reading
files that don't exist.

## The design

`StartSessionButton` becomes a **split control** when more than one repo is
registered:

- The **main half** is unchanged — one click, seeds into the implicit target.
  The common case (issue belongs to the project you're in) costs nothing new.
- The **caret half** opens a menu of every registered repo, checkmarking the
  implicit target. Picking one starts the issue *there*.

Picking, not scoping. The repo is chosen per action rather than as a mode you
have to enter and leave, so nothing about the Issues tab's state changes when
you use it — the detour collapses from five steps to two clicks.

**Visual reference:** [`mockup.html`](./mockup.html) — the list-row `cta`
variant with the menu open, the detail-footer `primary` variant, and the
single-repo (no caret) case.

### Why a split button and not a picker in the panel header

A header-level "target repo" selector would be a *mode*: set it, and every
subsequent Start-session click inherits it until you remember to set it back.
That's a new piece of sticky state to keep in sync with the sidebar's
`activeRepoUrl` and the session's own remote — a third source of truth for
"which repo am I working in", and the two that already exist are documented as
drifting apart. The split button holds no state at all.

### What happens on a pick

`handleIssueStartSession(issue, pickedRepoUrl?)` in `App.tsx`:

```ts
const repoUrl = pickedRepoUrl ?? defaultRepoUrl;
const switchingRepo = Boolean(repoUrl) && repoUrl !== defaultRepoUrl;
if (repoUrl && (switchingRepo || messages.length > 0)) {
  if (switchingRepo) useRepoStore.getState().setActiveRepoUrl(repoUrl);
  await handleNewSessionForRepo(repoUrl);
}
```

Two things worth naming:

- **A repo switch always forces a fresh session**, even from an empty draft.
  The pre-existing `messages.length > 0` test only asks "would this prompt
  append to an unrelated thread?" — but a session checked out on the wrong
  project is wrong no matter how empty it is.
- **The pick updates `activeRepoUrl`.** `claimSession` doesn't, so without this
  the sidebar's notion of the current repo would lag behind the session the
  user just opened.

Everything downstream is untouched: `handleNewSessionForRepo` navigates to
`/{owner}/{repo}/new` and claims a warm session, and the issue prompt is
**prefilled into the composer, not auto-sent** — the deliberate choice from
`docs/170-inline-tracker-issues`, preserved here. Cross-repo start is still a
thing the user reviews before dispatching.

### Repos offered

`IssuesPanel` filters the store's repo list:

- **Hidden repos are dropped**, for the same reason the sidebar drops them —
  the user has said they don't want to see that project.
- **...except the current target**, which stays so the checkmark has a home.
- **Cloning repos render but are disabled**: a claim against a repo still
  cloning 400s server-side (`claim-session.ts`), so showing it greyed is more
  honest than hiding it (the repo *does* exist; it's just not ready).
- **The caret only appears with ≥2 repos.** With one there is nothing to
  choose, and the button stays exactly as it was.

## Key files

| File | Role |
|---|---|
| `src/client/components/StartSessionButton.tsx` | The split control + repo menu. Renders as a plain button unless `onStartInRepo` is wired *and* there are ≥2 repos, so it's backwards-compatible by construction. |
| `src/client/components/IssuesPanel.tsx` | Selects `repos` from the repo store, computes `pickerRepos` (hidden-filter) and the implicit `targetRepoUrl`, forwards the pick. |
| `src/client/components/IssuesViewer.tsx` | Threads `repos`/`targetRepoUrl` to each row's button. |
| `src/client/components/IssueDetail.tsx` | Same, for the detail footer's `primary`-variant button. |
| `src/client/App.tsx` | `handleIssueStartSession(issue, pickedRepoUrl?)` — resolves the target, forces a fresh session on a repo switch, follows the pick in `activeRepoUrl`. |

## Long menus on small screens

A picker whose item count scales with "how many repos does this user have"
outgrows a phone. Measured in a real browser (Radix positions the menu at
runtime, so jsdom can't answer this), the **pre-fix** behavior was:

| Case | Menu top edge | Result |
|---|---|---|
| 12 repos, portrait 390×667 | +198 | fits |
| 18 repos, portrait | +6 | just fits |
| 25 repos, portrait | **−218** | ~6 repos unreachable |
| 12 repos, landscape 844×390 | **−79** | top clipped |
| 12 repos, keyboard open 390×420 | **−49** | top clipped |

Radix anchors the menu to its trigger and grows it **upward**, and
`DropdownMenuContent` had `max-height: none` with `overflow: hidden`. So the
overflow ran off the *top* of the screen with no scrollbar — the rows lost were
the ones at the top of the list, which for this picker includes its own
checkmarked current repo, and nothing on screen indicated they existed. Note
this bites well before an exotic repo count: **12 repos in landscape, or with
the keyboard up, already clips.**

Fixed in the shared `ui/dropdown-menu.tsx` rather than in this picker, because
the defect belongs to the menu primitive — `RepoSwitcher` renders the same repo
list through the same component and had the identical flaw. `DropdownMenuContent`
now caps at `--radix-dropdown-menu-content-available-height` (the space Radix
measured on the side it chose) with `overflow-y-auto`, plus a small
`collisionPadding` so it doesn't butt against the viewport edge. Menus that
already fit are unaffected — a max-height never shrinks them — and every case
above now lands inside the viewport with the full list reachable.

`ui/dropdown-menu.test.tsx` guards the class contract; the geometry itself was
verified in-browser and can't be re-asserted under jsdom.

## Styling note

The two halves are separate `<Button>`s so the primary action keeps its
single-click cost. `-ml-px` collapses the `cta` variant's adjacent borders into
one shared edge; an inset `currentColor` shadow draws the divider for variants
that have no border of their own (the detail footer's solid `primary`). Layout
classes from the call site move to the wrapper, so the row's `w-full @md:w-auto`
still governs the control as a whole.

## Not in scope

- **The docs-tab `handleDocStartSession`** has the same implicit-repo shape, but
  a doc is read out of a specific session's workspace — its repo genuinely *is*
  the current one, so there's nothing to pick.
- **Binding a Linear issue to a repo** (a per-team default, as sketched in
  `docs/156`) would remove the choice rather than surface it. Complementary, not
  a substitute: a default still needs an override, and this is the override.
- **`POST /api/sessions/headless`'s `issueRef`** stays unused by this path; the
  prefill flow from docs/170 is deliberate and unchanged.
