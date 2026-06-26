---
issue: https://linear.app/shipit-ai/issue/SHI-214
title: Shared browser event-listener hook
description: A correct-cleanup useEventListener/useEventListeners primitive that centralizes the addEventListener/removeEventListener-same-reference contract several client hooks hand-roll.
---

# Shared browser event-listener hook

A small React primitive — `useEventListener(target, type, handler, opts?)` and its
multi-event sibling `useEventListeners(specs)` — that owns the
`addEventListener` / `removeEventListener` pair the client currently hand-rolls
inside many `useEffect`s.

This is the deferred item from `docs/225-component-dedup-refactors` — the
"Explicitly not doing → Generic SSE/event-listener abstraction" catalog entry
(originating catalog **SHI-212**). It was deferred for a specific reason, recorded
verbatim there:

> The proposed sketches had broken cleanup (`removeEventListener` with a fresh
> closure removes nothing). A correct version is possible but is careful work,
> not a quick win — deferred until someone needs it.

This doc is that careful version. It tracks under **SHI-214**. The deliverable of
the first PR is the **hook + its tests only** — call-site migration is explicitly
a follow-up so the primitive can be reviewed in isolation.

## The cleanup-correctness problem (why the sketch was wrong)

`EventTarget.removeEventListener(type, listener, options)` removes a listener
**only if `listener` is the same object reference that was passed to
`addEventListener`** (matched together with the `capture` flag). It is identity-
keyed; there is no "remove by type" or structural match.

The deferred sketch did something like:

```ts
useEffect(() => {
  target.addEventListener(event, handler);
  return () => target.removeEventListener(event, () => {}); // ← BUG
}, [...]);
```

The cleanup passes a **brand-new arrow function** as the listener to remove. That
arrow has never been registered, so `removeEventListener` matches nothing and
removes nothing. The original `handler` stays attached forever. Symptoms:

- **Listener leak** — every mount/remount (or every effect re-run) stacks another
  live listener on a long-lived target (`window` / `document`), none ever
  detached.
- **Double / N-fire** — after one remount the event fires the handler twice, then
  three times, …
- **Stale captures** — leaked listeners keep old closures (and old store/state
  references) alive and reacting.

A subtler variant of the same class: binding the *caller's* `handler` directly but
listing it in the effect deps, so a fresh inline arrow each render tears down and
re-adds the subscription on every render — correct cleanup, but needless churn,
and a race window where no listener is attached.

### The fix: one shared reference + a latest-callback ref

Two rules, both enforced by the hook's structure:

1. **Add and remove close over the SAME `listener` const.** The effect creates
   `const listener = (e) => handlerRef.current(e)` exactly once per run; both
   `addEventListener(type, listener)` and the returned
   `removeEventListener(type, listener)` reference that one const. They cannot
   drift apart — there is no second closure to get wrong.

2. **The caller's handler lives in a ref, not in the deps.** `handlerRef.current
   = handler` runs on every render (cheap, no effect). The bound `listener` reads
   `handlerRef.current` at fire time, so the **latest** handler always runs, yet
   the effect's deps are only `[target, type, capture, once, passive]` — never
   `handler`. A non-memoized inline handler therefore does **not** rebind. The
   subscription rebinds only when its real identity (target / type / capture)
   changes, and on that rebind the cleanup removes the exact previous `listener`.

This is the standard "latest-callback ref" (a.k.a. `useEvent`) pattern, applied to
the add/remove pairing. The hook's test suite asserts all three properties
mechanically (add-on-mount, remove-with-the-same-ref + listener-stops-firing,
handler-swap-without-rebind).

## API

Two exports, in `src/client/hooks/useEventListener.ts`:

```ts
type EventTargetLike = Window | Document | HTMLElement | EventTarget | null | undefined;

function useEventListener(
  target: EventTargetLike,
  type: string,
  handler: (event: Event) => void,
  options?: boolean | AddEventListenerOptions,
): void;

interface EventListenerSpec {
  target: EventTargetLike;
  type: string;
  handler: (event: Event) => void;
  options?: boolean | AddEventListenerOptions;
}

function useEventListeners(specs: EventListenerSpec[]): void;
```

- **`target` accepts `null`/`undefined`** → clean no-op (nothing attached, nothing
  to clean up). This is for a **conditionally disabled** target — a value computed
  *during render*, e.g. `useEventListener(enabled ? window : null, …)` — so the
  effect re-runs when the value flips. It is **not** safe for a plain
  `useRef`-backed DOM node: `ref.current` going from `null` to an element does
  **not** trigger a render, so the effect never re-runs and the listener stays
  permanently unbound. A target that appears asynchronously must be promoted
  through `useState` or a **callback ref** so the component re-renders when it
  resolves. (None of the verified call sites below bind to an element ref — they
  all bind to `window`/`document`, which are stable from first render.)
- **`options`** accepts the `boolean | AddEventListenerOptions` union, and
  `capture`, `once`, `passive`, and `signal` are **all** honored on add (passed
  straight through to native `addEventListener`) — none are silently dropped. Only
  `capture` participates in add/remove matching. The rebind set tracks all four:
  the three booleans by value and `signal` by identity, all read **by field** (not
  object identity), so an inline literal rebinds only when a value actually
  changes. An aborted `signal` detaches the listener natively, independent of
  unmount. **Multi-form exception:** `useEventListeners` keys on the three booleans
  but **not** `signal` (a string key can't encode signal identity) — pass a stable
  signal to the multi form, or use the single-event form when the signal changes.

### Single vs. multi-event — why both

The call sites split cleanly into two shapes:

| Shape | Example sites | Fit |
|---|---|---|
| **One target, one event** | `useNotification` (visibilitychange), `useServerEvents` (visibilitychange) | `useEventListener` |
| **Several events, one shared lifetime/cleanup, possibly across targets** | `useConnectionSync` (visibilitychange on `document` + pageshow + focus on `window`), `use-voice-input` (blur on `window` + visibilitychange on `document`; keydown + keyup on `window`) | `useEventListeners` |

A single-event-only API would force the multi-event sites to call the hook N times
(N effects, N cleanups) — workable but noisier, and it can't express "these belong
together." A multi-event-only API would make the overwhelmingly common single case
verbose (`useEventListeners([{ target, type, handler }])`). Shipping both keeps
each call site at its natural altitude. They share the same cleanup mechanics; the
multi form snapshots the spec array at bind time and removes each listener with its
own captured reference.

**`useEventListeners` rebind key caveat.** The multi form derives its effect dep
from a string key over each spec's *target description* + type + the three boolean
options (`capture`/`once`/`passive`). Targets are described as `window` /
`document` / `el:TAG` / `target`. This is exact for the ambient singletons
(`window`/`document`) the real sites use, but two *different* element instances
with the same tag name would hash equal and not trigger a rebind, and `signal`
identity is not encoded (see options note above). The contract:
**`useEventListeners` is for ambient/singleton targets with stable signals**; a
listener on an element whose identity changes over time, or with a changing
`signal`, should use the single-event `useEventListener` (whose deps are the actual
target and signal references). Documented, not a silent footgun.

## Call sites

A `grep -rn "addEventListener" src/client` surfaces **~40** matches. They are not
all the same shape, so this section splits them into (a) the **priority migration
set** below — the hook-level, ambient-target subscriptions this primitive most
cleanly replaces — and (b) the **out-of-scope / later-batch classes** that follow.
**This list is not the complete migration backlog**; component-level sites
(`KeyboardShortcutsOverlay`, `FileAutoComplete`, `SkillAutoComplete`,
`QuickCaptureOverlay`, `MobileRecordingOverlay`, `ui/dialog.tsx`, `PreviewFrame`,
`ChatQuoteReply`, …) follow the identical `window`/`document` add+cleanup pattern
and are equally valid targets — they are deferred to later sweeps to keep each
migration PR reviewable, not because they don't qualify.

### Priority migration set (hooks)

Read from the current tree (file:line at time of writing). Each is a candidate for
a **follow-up** migration PR, not this one.

| # | Site | Target(s) | Event(s) | Handler stability | Migrates to |
|---|---|---|---|---|---|
| 1 | `src/client/hooks/useServerEvents.ts:453-463` | `document` | `visibilitychange` | stable (declared in effect) | `useEventListener` |
| 2 | `src/client/hooks/useConnectionSync.ts:39-47` | `document` + `window` | `visibilitychange`, `pageshow`, `focus` | stable closures over refs | `useEventListeners` |
| 3 | `src/client/hooks/useNotification.ts:69-82` | `document` | `visibilitychange` | stable (declared in effect) | `useEventListener` |
| 4 | `src/client/voice/use-voice-input.ts:298-317` | `window` | `keydown`, `keyup` | `useCallback` deps `[enabled, hotkey, …]` | `useEventListeners` (gated on `enabled && hotkey`) |
| 5 | `src/client/voice/use-voice-input.ts:322-345` | `window` + `document` | `blur`, `visibilitychange` | `useCallback` | `useEventListeners` (gated on `enabled`) |
| 6 | `src/client/hooks/useKeyboardShortcuts.ts:22-36` | `window` | `keydown` (toggle overlay) | `useEffect` deps `[setShortcutsOpen, toggleChord]` | `useEventListener` |
| 7 | `src/client/hooks/useKeyboardShortcuts.ts:41-50` | `window` | `keydown` (new session) | `useEffect` deps `[handleNewSession, newSessionChord]` | `useEventListener` |
| 8 | `src/client/hooks/useQuickCaptureHotkey.ts:23` | `window` | `keydown` | stable | `useEventListener` |
| 9 | `src/client/hooks/usePreviewErrors.ts:114` | `window` | `message` | stable | `useEventListener` |
| 10 | `src/client/hooks/useWebSocket.ts:169-172` | `document` + `window` | `visibilitychange`, `pageshow`, `focus`, `online` | stable | `useEventListeners` |

All ten currently carry a per-site
`// eslint-disable-next-line no-restricted-imports … useEffect …` justification
(the repo restricts raw `useEffect` — see `eslint.config.js`,
`RESTRICTED_USEEFFECT`). A secondary payoff of this hook: that disable lives in
**one** audited place (the hook module), and migrated sites drop their own.

### Out-of-scope classes (do NOT route through this hook)

| Class | Examples | Why excluded |
|---|---|---|
| **Per-connection event tables** torn down wholesale by `close()` | `useServerEvents` SSE table (see next section), `useWebSocket` `ws.*` handlers | Listeners die with the connection object; no per-listener `removeEventListener`, so there is no cleanup bug to fix. (Note `useWebSocket`'s *separate* `document`/`window` foreground listeners at :169-172 ARE in scope — site #10.) |
| **`MediaQueryList` subscriptions** | `useMediaQuery.ts:26` (`mql.addEventListener("change")`) | Already its own self-contained hook with correct cleanup; the target is a `MediaQueryList`, not an ambient DOM node — a different primitive (`matchMedia`) with its own `matches` read. Not worth folding in. |
| **Imperative, non-React DOM wiring** | `components/MonacoCommentWidgets.ts`, `voice/capture.ts` (MediaRecorder), `register-service-worker.ts` | Not inside React render/effects — built imperatively against editor/recorder DOM. The hook is a React-effect tool and doesn't apply. |
| **Drag-gesture listeners added inside an event handler** (not an effect) | `useResizablePanel.ts`, `useSidebarResize.ts` (mousemove/up added on mousedown) | Added/removed imperatively within a gesture, not on mount/unmount — a different lifecycle than this hook models. |

### Migration nuances to respect (not done in this PR)

- **Site 2 (`useConnectionSync`) has non-listener cleanup in the same effect.**
  Its current effect cleanup also clears `foregroundTimerRef` (`clearTimeout`,
  `useConnectionSync.ts:43`) before removing the listeners. `useEventListeners`
  only owns the add/remove pairs — it does **not** run that `clearTimeout`. The
  migration must keep the timer teardown alive: either leave a tiny dedicated
  cleanup effect for the timer, or hang the `clearTimeout` off an unmount effect
  beside the `useEventListeners` call. Dropping it would leak a pending timeout
  across unmount. (Same caution applies to any other site whose listener effect
  also tears down a timer/subscription — audit the *whole* cleanup, not just the
  `removeEventListener` lines, before deleting the effect.)
- **Sites 4/5 are gated** (`enabled`, `hotkey`). The `null`-target no-op covers
  this: pass `enabled ? window : null`. Behavior (no listener when disabled) is
  preserved without an `if` around the hook (which the rules of hooks forbid).
- **Sites 6/7 read a chord that can change** (`toggleChord`, `newSessionChord`
  from the keybindings registry). The handler closes over the latest chord via the
  ref, so no rebind is needed when the chord changes — but the matcher must read
  the chord at fire time. That's automatic with the latest-callback ref; just keep
  the chord lookup inside the handler body.
- **`use-voice-input` keydown/keyup `e.preventDefault()`** must keep working —
  unaffected; the wrapper passes the native `Event` straight through.

## SSE `addEventListener` in `useServerEvents` — NOT this hook's job

`useServerEvents.ts:42-431` registers ~25 named handlers on an **`EventSource`**
instance (`es.addEventListener("session_list", …)`, `"pr_status"`, etc.), each of
which JSON-parses `e.data` and dispatches into a Zustand store. This is a different
concern and is **deliberately out of scope**:

1. **Different lifecycle.** The `EventSource` is *created inside the effect* and
   torn down wholesale with `es.close()` in the same cleanup. Closing the source
   detaches every listener at once — there is no per-listener `removeEventListener`
   to get wrong, so the cleanup-correctness bug this hook solves does not even
   apply here.
2. **Different responsibility.** Those handlers are a typed wire-event dispatch
   table (`JSON.parse` + discriminated-union narrowing + store writes), not
   ambient DOM subscriptions. Folding them into `useEventListener` would drag
   EventSource construction, the SSE reconnect/`connectAttempt` machinery, and
   payload parsing into a hook whose single job is correct DOM add/remove pairing.
3. **The one in-scope listener in that file** is the separate
   `document.addEventListener("visibilitychange", …)` effect at lines 453-463 —
   that one *is* the bug-prone ambient shape and is site #1 above.

So: the **DOM visibilitychange listener** in `useServerEvents` migrates; the
**SSE event table** stays as-is. Decision recorded so a future sweep doesn't
"helpfully" route the SSE handlers through this hook.

## Prototype status (this PR)

Shipped and validated:

- `src/client/hooks/useEventListener.ts` — `useEventListener` + `useEventListeners`
  + `EventTargetLike` / `EventListenerSpec` types.
- `src/client/hooks/useEventListener.test.ts` — 10 tests, all green, proving:
  - attaches on mount and fires the handler;
  - on unmount the **removed reference === the added reference** (the exact bug the
    sketch had) **and** the listener verifiably stops firing afterward;
  - a handler swapped across renders runs the **latest** handler with **no rebind**
    (single add, zero removes);
  - target/type change triggers a correct rebind (remove-old-then-add-new, old
    reference matched);
  - `once` is honored (fires at most once) and an `AbortSignal` detaches the
    listener on abort — i.e. options are passed through, not dropped;
  - `null` target is a clean no-op;
  - the multi form binds across two targets, tears all down with matching refs,
    swaps handlers without rebinding, **and rebinds when a non-capture option
    (`once`) changes** (the key tracks all three booleans, not just capture).

Verified with `npx vitest run src/client/hooks/useEventListener.test.ts`,
`npm run typecheck`, and `eslint` on the two new files. (Full `npm test` is not run
in-container — it OOMs the box; CI runs it.)

## Follow-up (separate PRs)

1. Migrate sites #1, #3, #6, #7 (single-event) — smallest, lowest-risk batch.
2. Migrate sites #2, #4, #5 (multi-event / gated) — exercises `useEventListeners`
   and the `null`-target gating.
3. After migration, confirm each migrated file drops its per-site
   `no-restricted-imports`/`no-restricted-syntax` `useEffect` disable.

See `checklist.md` for the live work list.

## Key files

- `src/client/hooks/useEventListener.ts` — the primitive (this PR).
- `src/client/hooks/useEventListener.test.ts` — cleanup-correctness proof (this PR).
- `eslint.config.js` — `RESTRICTED_USEEFFECT` / `no-restricted-imports` rules the
  hook centralizes the disable for.
- Migration targets: `useServerEvents.ts`, `useConnectionSync.ts`,
  `useNotification.ts`, `voice/use-voice-input.ts`, `useKeyboardShortcuts.ts`.
