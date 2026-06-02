---
description: Animate session rows as they reorder or disappear in the sidebar — archive and PR-merge transitions glide instead of popping.
---

# Animated session transitions

## Problem

The session list in the left sidebar reorders and removes rows in response
to state changes the user can't see happen:

- **PR merged / closed.** `applyPrStatusUpdates`
  ([`pr-store.ts:189`](../../src/client/stores/pr-store.ts#L189)) updates
  the session's `mergedAt`, which causes the stable sort in
  [`SessionSidebar.tsx:515–551`](../../src/client/components/SessionSidebar.tsx#L515)
  to sink the row to the bottom of its repo group.
- **Archive.** `archiveSession`
  ([`session-store.ts:300`](../../src/client/stores/session-store.ts#L300))
  removes the row from the sidebar entirely; it survives only inside the
  All Sessions dialog.

Both transitions today are *instantaneous*: the row vanishes from its
old slot and re-materializes in its new one in the same React render.
For the user that's a "did something just change?" moment — the visual
continuity that would explain *why* the list is now different is
missing. The bug is most visible during the PR-merged transition, where
the row jumps from somewhere mid-list to the bottom of the group with
no animation tying the two positions together; archive is a softer case
(the row leaves and isn't expected back) but suffers the same lack of
acknowledgment.

This isn't unique to the sidebar — any list that mutates in place under
the user's eye has the same problem — but the sidebar is the first
surface where it's bad enough to be worth fixing, and the patterns we
pick here should generalize.

## Design

Use [`@formkit/auto-animate`](https://github.com/formkit/auto-animate)
to add FLIP-based reorder/exit animations to the session list. One
`useAutoAnimate()` hook per repo group's session-list container; the
library snapshots layout before the React commit, lets the DOM mutate,
then animates each child from its old position to its new one with a
CSS transform — no per-row instrumentation, no key juggling.

### Why auto-animate (and not framer-motion, view-transitions, hand-rolled)

This was discussed in the research turn that preceded this doc; the
short version:

- **`@formkit/auto-animate`** — ~2 KB gz, zero config, one ref per
  container. Handles add / remove / reorder out of the box. Respects
  `prefers-reduced-motion` by default. No new API surface for the rest
  of the codebase to learn. Limitation: one duration/easing per parent;
  no per-item choreography.
- **`framer-motion` (`motion` v12)** — full control (`<motion.div
  layout>`, `<AnimatePresence>`, per-item exit choreography, spring
  curves) but ~35–50 KB gz and a whole new mental model. Worth it only
  once we want per-row touches (a flash on the row as it lands, a
  morph between repo groups, etc.).
- **CSS View Transitions API** — zero dep, but Safari support landed
  late and cross-element matching by `view-transition-name` is finicky
  for lists with stable identity. Not worth fighting the API for v1.
- **Hand-rolled FLIP** — ~50 lines, but we'd own the resize / scroll /
  interrupted-animation edge cases. Skip until we have a reason to
  reject the dependency.

`auto-animate` is the minimum thing that fixes the visible bug. If
later asks emerge — choreographed per-row enter/exit, animating a row
*between* repo groups when its repo URL changes, animating the All
Sessions dialog list — we upgrade to `framer-motion`. The switch is
mechanical: replace the ref with `<motion.div layout>` wrappers.

### Where to attach the hook

The session-rendering loop lives inside `RepoGroup`
([`SessionSidebar.tsx:417–471`](../../src/client/components/SessionSidebar.tsx#L417))
— that IIFE returns a flat array of `<SessionItem>` elements
(top-level rows interleaved with indented child rows from docs/117
Phase 2). The auto-animate ref attaches to the `<div className="flex
flex-col gap-0.5 pb-2">` wrapper at
[line 399](../../src/client/components/SessionSidebar.tsx#L399), which
already wraps the entire session list (including the "New session"
button row and the empty-state placeholder).

One container per `RepoGroup`, not one for the whole sidebar. The
reasons:

1. **Animations are scoped to a single repo group.** A session can't
   move *between* repo groups today (its `remoteUrl` is fixed at
   creation), so cross-group choreography is not needed. Keeping the
   ref at the group level means a row sinking to the bottom of repo
   A's group doesn't interact with repo B's layout.
2. **Repo group expand/collapse is unrelated to row motion.** The
   group's collapsed body is unmounted entirely
   ([`SessionSidebar.tsx:398`](../../src/client/components/SessionSidebar.tsx#L398));
   we don't want auto-animate trying to interpolate that.
3. **Drag-and-drop reorder of repo *headers* is a separate gesture**
   that lives at the sidebar level. The repo containers themselves
   shouldn't animate during a drag — the existing drop indicators do
   that job. Keeping the ref inside `RepoGroup` makes the boundary
   obvious.

### Interaction with the parent/child rendering

`RepoGroup` interleaves top-level sessions with their agent-spawned
children directly under their parent (docs/117 Phase 2 — code at
[lines 427–470](../../src/client/components/SessionSidebar.tsx#L427)).
The flat array of `<SessionItem>` elements is keyed by `session.id`,
which is what auto-animate uses (via DOM node identity preserved
across React renders) to match before/after positions. A child row
moving to follow its parent will animate the same way a parent row
moving to a new position does.

One subtlety: a child whose parent disappears (parent archived) is
re-rendered at top level as a fallback (the `orphanedChildren` branch
at
[line 433](../../src/client/components/SessionSidebar.tsx#L433)). For
the animation that means the child stays mounted at the same React
key, just at a different indent level. auto-animate will animate the
position change; the indent change is a className flip and will
transition naturally because `SessionItem` already has
`transition-colors` and friends. No extra work.

### Motion parameters

Use the library defaults (`duration: 250ms`, `easing: ease-in-out`)
for v1. They are close enough to our existing motion tokens
(`--duration-normal: 200ms`, `--ease-default: ease`) that nothing will
look out of place, and we deliberately don't want bespoke timing here
— the sidebar shouldn't draw attention to itself.

`prefers-reduced-motion: reduce` short-circuits the library to instant
DOM updates automatically. We don't need to wire that up.

### What we explicitly *don't* animate in v1

- **Cross-repo movement.** A session's `remoteUrl` doesn't change today,
  so this can't happen.
- **The All Sessions dialog list.** Same problem class, same future
  fix; out of scope for this doc.
- **The PR lifecycle card phase transitions.** Those animate text and
  badges, not list order; separate concern.
- **The repo-header drag-and-drop reorder.** Already has its own drop
  indicator UX; auto-animate sits inside the group, not around the
  groups.

## Implementation

Three edits.

### 1. Dependency

Add `@formkit/auto-animate@0.9.0` to `dependencies` in `package.json`
as an exact pin (per the CLAUDE.md dependency policy). Version 0.9.0
was published 2025-09-05 — well past the 7-day age window. After the
edit run `npm install` to refresh `package-lock.json` and `npm run
check-deps` to confirm the policy gates pass.

### 2. Wire `useAutoAnimate` into `RepoGroup`

In
[`src/client/components/SessionSidebar.tsx`](../../src/client/components/SessionSidebar.tsx):

```ts
import { useAutoAnimate } from "@formkit/auto-animate/react";
```

Inside `RepoGroup` (the function starting around
[line 200](../../src/client/components/SessionSidebar.tsx#L200)):

```ts
const [listRef] = useAutoAnimate<HTMLDivElement>();
```

Attach the ref to the session-list wrapper at
[line 399](../../src/client/components/SessionSidebar.tsx#L399):

```tsx
<div ref={listRef} className="flex flex-col gap-0.5 pb-2">
```

That's the entire integration. The IIFE inside that wrapper
([lines 427–470](../../src/client/components/SessionSidebar.tsx#L427))
keeps its existing shape; auto-animate observes DOM children by
identity, so the flat-array-of-`<SessionItem>` pattern works as-is.

### 3. Verify in the browser

Manual smoke checks (no automated test — auto-animate's behavior is
visual, and `jsdom` has no layout engine, so we can't meaningfully
unit-test the animation):

- **PR merged transition.** Open a session with an open PR, mark the
  PR as merged via the GitHub mock or by waiting on a real merge.
  Confirm the row glides from its current slot to the bottom of the
  group rather than jumping.
- **Archive.** Click the archive control on a non-current session.
  Confirm the row collapses/fades out in place rather than instantly
  vanishing.
- **Unarchive (from All Sessions dialog).** Confirm the restored row
  animates into its sorted position when the sidebar re-renders.
- **New session created.** Confirm new rows animate in at the top of
  their group rather than popping in.
- **Reduced-motion.** Toggle `prefers-reduced-motion: reduce` in
  DevTools rendering pane; confirm the list updates instantly with
  no animation.
- **Drag-and-drop reorder of repo headers.** Confirm repo reorder
  still works and the sidebar-level drop indicator still renders
  cleanly — the `useAutoAnimate` ref is inside `RepoGroup`, so this
  should be unaffected, but worth eyeballing.

No new test files. The existing component tests for `SessionSidebar`
continue to pass unmodified because `useAutoAnimate` in `jsdom` is a
no-op (no `getBoundingClientRect` layout → nothing to interpolate →
fall through to instant updates).

## Edge cases and non-goals

- **First mount.** `useAutoAnimate` doesn't animate the initial
  render — it only animates subsequent layout changes. So when the
  sidebar first loads, sessions appear in place as they do today. No
  regression vs. the current behavior.
- **Repo group expand/collapse.** The body is unmounted on collapse
  ([`SessionSidebar.tsx:398`](../../src/client/components/SessionSidebar.tsx#L398)),
  so on re-expand the ref re-attaches to a fresh DOM node with no
  prior layout snapshot. The first render after expand is instant;
  subsequent reorders animate. This is the correct behavior — we
  don't want a row that was already at the bottom to animate "from
  somewhere" when the group reopens.
- **Many sessions, simultaneous reorders.** If multiple sessions in
  the same group change `mergedAt` in the same SSE batch,
  auto-animate animates them all in parallel; this is the intended
  behavior and matches what the user expects.
- **Indented child rows.** A child row whose parent gets archived
  shifts from indented to top-level. The indent is a className
  difference inside `SessionItem`; auto-animate animates the
  position change, the className transition handles the indent. No
  jank expected.
- **The "New session" button row** is part of the same flex
  container and is keyed implicitly by DOM position. It never moves
  (always first), so auto-animate has nothing to do with it.
- **Empty state.** When a repo group has no sessions, the wrapper
  renders the "No sessions" `<p>` instead of an array of items
  ([line 418](../../src/client/components/SessionSidebar.tsx#L418)).
  Going from "no sessions" to "one session" or vice-versa animates
  one DOM node appearing/disappearing — auto-animate handles this
  case cleanly.
- **Cross-session WS message arrivals.** Stale-message guards
  elsewhere in the stack already prevent updates from previous
  sessions from reaching the sidebar; nothing to add here.
- **PR-status-poller batch updates** (`pr-status-poller.ts`) can
  flip several sessions' `mergedAt` in a single store update. The
  sort is recomputed once per render, so all affected rows animate
  together — desirable.

## Trade-offs

- **A new dependency, even if tiny.** ~2 KB gz, no runtime
  configuration, single export. Worth the visual-quality improvement;
  the alternative is hand-rolled FLIP (more code, more bugs, less
  predictable).
- **One duration/easing for the whole list.** auto-animate doesn't
  let us, e.g., animate exits slower than reorders. Acceptable: the
  fix we want is "movement is visible," not "movement is precisely
  choreographed."
- **No unit tests for the animation itself.** As above, `jsdom`
  can't exercise the animation path. Manual verification is the
  contract. If we ever regress to instant pops, it'll be visible
  immediately in dogfooding.
- **Future migration to `framer-motion`** is mechanical but not
  free: every `RepoGroup` would gain `<motion.div layout>` wrappers
  around each row, and we'd want to revisit the animation contract
  per-row. Tolerable cost when we have a concrete reason to upgrade.
- **Possible interaction with drag-and-drop in the future.** If we
  ever extend drag-and-drop from repos to sessions, auto-animate's
  layout interpolation could fight the drag library's transforms.
  Out of scope for v1 (sessions don't drag today), but worth a note
  in this doc so the next person knows to check.

## Key files

- `package.json` — add `@formkit/auto-animate` at version `0.9.0` to
  `dependencies` as an exact pin. Run `npm install` to refresh the
  lockfile.
- `src/client/components/SessionSidebar.tsx` — import
  `useAutoAnimate` from `@formkit/auto-animate/react`; call the hook
  inside `RepoGroup`; attach the returned ref to the session-list
  wrapper at line 399.

## Checklist

See [checklist.md](./checklist.md).
