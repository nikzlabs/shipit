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
  unmount. The multi-form (`useEventListeners`) tracks the same four — `target` and
  `signal` by **object identity** (via a `WeakMap`-backed stable id in its rebind
  key), so a different element or a fresh signal rebinds correctly there too.

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

**`useEventListeners` rebind key.** The multi form can't list `specs` directly in
`useEffect` deps (a fresh array literal every render would rebind constantly), so it
derives a string key per spec. The key is **identity-aware**: `target` and `signal`
contribute a stable per-object id from a module `WeakMap` (assigned on first use,
fixed for the session), alongside `type` and the three boolean options. So two
*different* same-tag elements, a bare `EventTarget`, or a fresh `AbortSignal` each
produce a distinct key and rebind correctly — while `window`/`document` keep one
fixed id and never spuriously rebind. The handlers still ride `specsRef` (a handler
swap never rebinds). This was hardened after review caught that an earlier
*target-description* key (`el:TAG`) would collide for same-tag elements.

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

### Priority migration set (hooks) — **migrated in this PR**

All ten listener sites below now route through the hook. The "Migrated to" column
records the form used; sites with a `null`-target gate or non-listener (timer)
cleanup are noted.

| # | Site | Target(s) | Event(s) | Migrated to |
|---|---|---|---|---|
| 1 | `useServerEvents.ts` | `document` | `visibilitychange` | `useEventListener` |
| 2 | `useConnectionSync.ts` | `document` + `window` | `visibilitychange`, `pageshow`, `focus` | `useEventListeners` (+ timer-cleanup effect preserved) |
| 3 | `useNotification.ts` | `document` | `visibilitychange` | `useEventListener` |
| 4 | `voice/use-voice-input.ts` | `window` | `keydown`, `keyup` | two `useEventListener` calls, gated `enabled && hotkey ? window : null` (typed `KeyboardEvent`, keeps `e.preventDefault()`) |
| 5 | `voice/use-voice-input.ts` | `window` + `document` | `blur`, `visibilitychange` | `useEventListeners`, gated `enabled ? … : null` |
| 6 | `useKeyboardShortcuts.ts` | `window` | `keydown` (toggle overlay) | `useEventListener` |
| 7 | `useKeyboardShortcuts.ts` | `window` | `keydown` (new session) | `useEventListener` |
| 8 | `useQuickCaptureHotkey.ts` | `window` | `keydown` | `useEventListener`, gated `isValid ? window : null` |
| 9 | `usePreviewErrors.ts` | `window` | `message` | `useEventListener` (typed `MessageEvent`) |
| 10 | `useWebSocket.ts` | `document` + `window` | `visibilitychange`, `pageshow`, `focus`, `online` | `useEventListeners`, gated on `url` (+ retry-timer cleanup preserved on `[url]`) |

Each site dropped its per-site
`// eslint-disable-next-line no-restricted-imports … useEffect …` justification
(the repo restricts raw `useEffect` — see `eslint.config.js`,
`RESTRICTED_USEEFFECT`); the disable now lives in **one** audited place (the hook
module). Sites 2 and 10 keep a *separate* small `useEffect` purely for their
non-listener timer teardown, with a narrowly-scoped disable that says so — the
listener-management disables are gone.

**Single-event for keyboard pairs (sites 4, 8).** The doc originally sketched
`useEventListeners` for the PTT pair; the migration uses two `useEventListener`
calls instead. With the typed overloads (below) each call infers `KeyboardEvent`,
so `e.repeat` / `e.preventDefault()` / `eventMatchesPtt(e, …)` need no cast — the
multi-form's `(event: Event)` handler would. Same lifetime (both gated on the same
target expression), better types.

### Typed overloads (added with the migration)

`useEventListener` carries `Window` / `Document` / `HTMLElement` overloads that
infer the event type from the target, plus a `string`/`EventTargetLike` fallback
for custom event names. `useEventListener(window, "keydown", e => …)` gives
`e: KeyboardEvent` with no call-site cast; a `null` arm (`enabled ? window : null`)
keeps the inference from the live arm. This is type-only — the runtime impl and its
10 behavioral tests are unchanged. `useEventListeners` stays `(event: Event)` per
spec (heterogeneous events in one array can't share a single inferred type); its
handlers cast where they read event fields (none of the migrated multi-event
handlers needed to).

### Out-of-scope classes (do NOT route through this hook)

| Class | Examples | Why excluded |
|---|---|---|
| **Per-connection event tables** torn down wholesale by `close()` | `useServerEvents` SSE table (see next section), `useWebSocket` `ws.*` handlers | Listeners die with the connection object; no per-listener `removeEventListener`, so there is no cleanup bug to fix. (Note `useWebSocket`'s *separate* `document`/`window` foreground listeners at :169-172 ARE in scope — site #10.) |
| **`MediaQueryList` subscriptions** | `useMediaQuery.ts:26` (`mql.addEventListener("change")`) | Already its own self-contained hook with correct cleanup; the target is a `MediaQueryList`, not an ambient DOM node — a different primitive (`matchMedia`) with its own `matches` read. Not worth folding in. |
| **Imperative, non-React DOM wiring** | `components/MonacoCommentWidgets.ts`, `voice/capture.ts` (MediaRecorder), `register-service-worker.ts` | Not inside React render/effects — built imperatively against editor/recorder DOM. The hook is a React-effect tool and doesn't apply. |
| **Drag-gesture listeners added inside an event handler** (not an effect) | `useResizablePanel.ts`, `useSidebarResize.ts` (mousemove/up added on mousedown) | Added/removed imperatively within a gesture, not on mount/unmount — a different lifecycle than this hook models. |

### Migration nuances (how each was handled)

- **Sites 2 & 10 have non-listener cleanup.** The old effects also cleared a timer
  in their cleanup (`useConnectionSync` `foregroundTimerRef`; `useWebSocket`
  `clearForegroundRetryTimers()`). `useEventListeners` only owns add/remove pairs,
  so each migration keeps a **separate tiny `useEffect`** for the timer teardown —
  `useConnectionSync` on unmount (`[]`), `useWebSocket` on the original `[url]`
  cadence so a stale retry can't fire after a session switch. The lesson generalizes:
  audit the *whole* cleanup, not just the `removeEventListener` lines, before
  deleting a listener effect.
- **Gated sites (4/5/8/10)** use the `null`-target no-op instead of an `if` around
  the hook (which the rules of hooks forbid): `enabled && hotkey ? window : null`,
  `enabled ? document : null`, `isValid ? window : null`, `url ? window : null`.
  Listener attaches only when the gate is open; flipping it rebinds.
- **Sites 6/7 read a chord that can change** (`toggleChord`, `newSessionChord`).
  The handler reads the latest chord through the latest-callback ref at fire time,
  so no rebind is needed when the chord changes — the lookup just stays inside the
  handler body.
- **`use-voice-input` keydown/keyup `e.preventDefault()`** still works — the typed
  `KeyboardEvent` overload passes the native event straight through.

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

## Status (this PR)

Hook + tests + the full priority-set migration shipped together.

- `src/client/hooks/useEventListener.ts` — `useEventListener` (with typed
  Window/Document/HTMLElement overloads) + `useEventListeners` + `EventTargetLike`
  / `EventListenerSpec` types.
- `src/client/hooks/useEventListener.test.ts` — 13 tests, all green, proving:
  - attaches on mount and fires the handler;
  - on unmount the **removed reference === the added reference** (the exact bug the
    sketch had) **and** the listener verifiably stops firing afterward;
  - a handler swapped across renders runs the **latest** handler with **no rebind**
    (single add, zero removes);
  - target/type change triggers a correct rebind (remove-old-then-add-new, old
    reference matched);
  - `once` is honored (fires at most once) and an `AbortSignal` detaches the
    listener on abort — i.e. options are passed through, not dropped;
  - the typed overloads infer `KeyboardEvent` / `MessageEvent` (compile-time) and
    still fire (runtime);
  - `null` target is a clean no-op;
  - the multi form binds across two targets, tears all down with matching refs,
    swaps handlers without rebinding, **and rebinds when a non-capture option
    (`once`), the target identity (a different same-tag element), or the
    `signal` identity changes** — i.e. the rebind key is identity-aware.
- **Migrated** all 10 priority sites (table above), dropping their per-site
  listener `useEffect` disables. `usePreviewErrors.test.ts`'s cleanup test was
  upgraded to assert same-reference removal (the migration changed the
  `removeEventListener` arity by passing an options object).

Verified with `npm run typecheck`, `eslint` on every touched file, and the
co-located tests for all migrated modules (`useEventListener`, `useNotification`,
`useConnectionSync`, `usePreviewErrors`, `useQuickCaptureHotkey`, `useWebSocket`,
`use-voice-input` — 88 tests green). (Full `npm test` is not run in-container — it
OOMs the box; CI runs it.)

## Component-level sweep (done)

The hook-level priority set plus the **component-level** sweep are both migrated.
11 further sites moved onto the hook — same `window`/`document` add+cleanup pattern:

| Site | Form | Note |
|---|---|---|
| `FileAutoComplete`, `SkillAutoComplete` | `useEventListener(window, "keydown", handleKeyDown)` | existing `useCallback` handler |
| `KeyboardShortcutsOverlay` | `useEventListener(window, "keydown", …)` | reads latest chord via ref |
| `MarkdownSelectionComments/CommentInput` | `useEventListener(window, "keydown", …)` | Escape → cancel |
| `QuickCaptureOverlay` | `useEventListener(open ? window : null, …)` | gated |
| `MobileRecordingOverlay` | `useEventListener(recording \|\| error ? window : null, …)` | gated |
| `KeybindingCapture` | `useEventListener(recording ? window : null, "keydown", …, true)` | **capture phase**, gated |
| `PresentPane` | `useEventListener(isActiveTab ? window : null, …)` | gated |
| `ChatQuoteReply` | `useEventListener(document, "selectionchange", …)` | reads `containerRef` at fire time |
| `PreviewFrame` | `useEventListener(window, "message", …)` | typed `MessageEvent` |
| `MessageInput` | `useEventListener(document, "load", …, true)` | **capture phase** |

Each dropped its listener `useEffect` disable (and, where `useEffect` left the
import entirely, the now-stale `no-restricted-imports -- useEffect` directive).

### Deliberately NOT migrated (out of scope)

These match `addEventListener` textually but are a different lifecycle than this
hook models — folding them in would be wrong, not an omission:

- **`LogView`** / **`useMessageScroll`** — the target is an **element read from a
  ref inside the effect** (`containerRef.current?.parentElement`, a scroll
  container). The hook's `null`-target gate is for render-time values; a ref going
  non-null does not re-render, so an element-ref target belongs in a hand-written
  effect (or behind a callback ref). `useMessageScroll` also wires a
  `ResizeObserver` in the same effect.
- **`ui/dialog.tsx`** — a **module-level install-once-never-removed** global
  `popstate` listener guarded by a module flag, not a React effect.
- **`PreviewServicesDrawer`** — drag-gesture `mousemove`/`mouseup`/`touch*`
  listeners added **inside a pointer handler** and removed on gesture end (the
  drag lifecycle, not mount/unmount).
- **`stores/mcp-store.ts`** — a `message` listener inside a **Promise/OAuth-popup**
  flow with manual cleanup, not a React hook.
- **`MarkdownSelectionComments/useMarkdownSelection`** — the effect **couples** the
  `selectionchange` listener with a `setSnapshot(null)` derived-state reset on its
  gate branch; not a pure listener effect, so migrating it would mean splitting
  concerns (and risk) for little gain.
- **`useMediaQuery`** — a `MediaQueryList` subscription with its own correct hook.

## Key files

- `src/client/hooks/useEventListener.ts` — the primitive (`useEventListener` +
  typed overloads + `useEventListeners`).
- `src/client/hooks/useEventListener.test.ts` — cleanup-correctness + inference proof.
- `eslint.config.js` — `RESTRICTED_USEEFFECT` / `no-restricted-imports` rules the
  hook centralizes the disable for.
- Migrated hook sites: `useServerEvents.ts`, `useConnectionSync.ts`,
  `useNotification.ts`, `useKeyboardShortcuts.ts`, `useQuickCaptureHotkey.ts`,
  `usePreviewErrors.ts`, `useWebSocket.ts`, `voice/use-voice-input.ts`.
- Migrated component sites: `FileAutoComplete.tsx`, `SkillAutoComplete.tsx`,
  `KeyboardShortcutsOverlay.tsx`, `MarkdownSelectionComments/CommentInput.tsx`,
  `QuickCaptureOverlay.tsx`, `MobileRecordingOverlay.tsx`, `KeybindingCapture.tsx`,
  `PresentPane.tsx`, `ChatQuoteReply.tsx`, `PreviewFrame/PreviewFrame.tsx`,
  `MessageInput/MessageInput.tsx`.
