---
description: Soft contract — ShipIt posts visibility transitions to preview iframes so cooperating apps can suspend Web Audio, RAF loops, and game ticks while hidden.
issue: https://linear.app/shipit-ai/issue/SHI-44/preview-visibility-contract
---

# Preview visibility contract

## Problem

When a preview iframe in ShipIt is hidden in the UI (user switches sessions,
switches ports, or collapses the preview panel) its audio keeps playing. The
current implementation toggles Tailwind's `invisible` (`visibility: hidden`)
on the iframe element at
[`PreviewFrame.tsx:708–709`](../../src/client/components/PreviewFrame.tsx#L708)
(both the device-frame branch on 708 and the fullscreen branch on 709 set
the class); that hides the pixels but leaves the document fully alive —
timers fire, network requests resolve, and **all audio output continues**.
`display: none`, `opacity: 0`, off-screen positioning, and the `hidden`
attribute behave the same way for audio in every evergreen browser.

The pool design at
[`useIframePool.ts`](../../src/client/hooks/useIframePool.ts) deliberately
keeps background iframes mounted (up to `MAX_IFRAME_SLOTS = 20`,
[useIframePool.ts:4](../../src/client/hooks/useIframePool.ts#L4)) so
re-attaching to a previous (session, port) slot is instant. Tearing the
iframe down on hide would stop the audio but defeats the entire point of
the pool — re-show would reload the page and discard scroll, SPA route,
form state, and any in-flight work.

A previous design pass considered solving this server-side by extending the
existing `preview-proxy.ts` HMR script-injection: walk
`document.querySelectorAll("audio, video")` on a "hide" message and mute
each element. That approach is **insufficient in practice**: most cases
where this bites are HTML5 games or audio toys built on the Web Audio API.
Web Audio plays through `AudioContext` graphs, not `<audio>` elements, so a
DOM walk can't reach the audio source. The script could monkey-patch
`AudioContext` on construction, but it would still miss contexts created
before the patch lands, and it can't unilaterally suspend a graph the page
is actively driving without breaking the page's own audio state machine.

## Design

A soft cooperative protocol: ShipIt tells the previewed app *when it's not
on screen*, and the app decides what to do about it.

### Wire protocol

Parent (ShipIt) → iframe, via `postMessage`:

```ts
{ source: "shipit-preview", type: "visibility", visible: boolean }
```

Iframe → parent, when the app's listener is registered:

```ts
{ source: "shipit-preview", type: "ready" }
```

The `source: "shipit-preview"` discriminator is the existing convention for
postMessage traffic between preview iframes and the parent — already used
by the HMR-patch `"loaded"` event
([`preview-proxy.ts:72`](../../src/server/orchestrator/preview-proxy.ts#L72)),
the error-capture handler
([`usePreviewErrors.ts:66`](../../src/client/hooks/usePreviewErrors.ts#L66),
documented in [docs/009](../009-preview-system/plan.md)), and the console
forwarder. We are adding two more message **types** under that same
envelope, not changing the envelope itself. Other parent-side listeners
(`usePreviewErrors`) already filter by `type` and fall through on unknown
values, so adding `ready` and `visibility` is a pure addition.

No protocol version field — `type` is the dispatch key, and new behaviors
get new `type` names. If we ever need a breaking change, we add a new
`type` (e.g. `visibility2`) and keep the old one. This is cheaper than
versioning every message.

### Why visibility, not "mute"

The semantic is **"you are not on screen, please pause yourself"**, modelled
on the existing web idiom of `document.visibilityState`. That covers:

- Suspending an `AudioContext` (the case that motivated this).
- Pausing a `requestAnimationFrame` loop (a WebGL canvas redrawing at 60fps
  in the background is a real cost on a laptop).
- Pausing a game tick / `setInterval` driving simulation state.
- Pausing `<audio>` / `<video>` if any.

A "mute" message would have forced apps with non-audio side effects to
invent their own conventions, and we'd be back here later adding `"pause"`,
`"throttle"`, etc. Visibility composes all of them under one idiom.

### Relationship to the existing `"loaded"` event

We **do not rename or deprecate** `"loaded"`. It stays exactly as it is.
The two events mean different things:

- `"loaded"` is emitted by the proxy-injected shim, fires on every HTML
  parse, and tells the parent "this iframe finished loading." Used by the
  auth-blocked detector at
  [`PreviewFrame.tsx:211–233`](../../src/client/components/PreviewFrame.tsx#L211).
  Fires whether or not the app implements the visibility contract.
- `"ready"` is emitted by the **app's own snippet** (or by the scaffolded
  template), fires once the app's `message` listener is registered, and
  tells the parent "this iframe will honor `visibility` messages."

An earlier draft proposed renaming `loaded` to `ready` to consolidate the
two. The reviewer pushed back: collapsing them would lose information the
parent might want later (today: nothing; tomorrow: e.g. fall back to the
DOM-walk script for non-cooperating apps that emit `loaded` but never
`ready`). And in a continuously-deployed system there's no clean way to
finish a deprecation. Two messages, two meanings.

### Why a handshake

The pool can mount an iframe while the slot is already hidden — a background
slot the user has never foregrounded, or a slot whose health-poll just
succeeded while the user is on a different port. If we only emit
`visibility` messages on the *transition*, that iframe starts up assuming
it's visible and runs full-bore for the hundreds of ms (or seconds) until
something toggles. Worse, that's exactly the case where the user least
wants audio: they aren't even looking at the preview.

The handshake fixes this: the app posts `ready` once its listener is
attached, and the parent replies with the current `visibility` for that
slot. The app uses the **first received `visibility` message** as
authoritative initial state — it does not assume "visible" by default. The
snippets we ship enforce this by gating audio-context / animation-loop
construction on the first `visibility` message.

### Closing the parent-side ref race

The reply targets a specific iframe by matching `event.source` against the
iframe pool's `contentWindow` refs (the same pattern as the existing
`loaded` handler at
[PreviewFrame.tsx:220–229](../../src/client/components/PreviewFrame.tsx#L220)).
React's iframe DOM node is inserted during commit, with the ref callback
firing immediately after — but in principle the iframe can start loading
and the page can post `ready` before the parent's React effect has settled
the ref into `iframeRefs.current`. If we naively dropped unmatched `ready`
events, that slot would never receive its initial `visibility` reply.

Two-part fix:

1. **Buffer unmatched `ready` events** in a small ring (cap: 8 entries,
   evicted FIFO) holding `{ source: Window, receivedAt: number }`. Every
   time `iframeRefs.current` is updated, drain the buffer and reply to
   any whose `source` now matches a known iframe. Entries older than 2
   seconds are dropped silently — at that age the iframe has either
   navigated away or the `event.source` `Window` has been GC'd.
2. **Re-emit `visibility` on every `hidden` transition unconditionally**,
   without waiting for `ready`. This means even if the initial reply is
   dropped (buffer eviction, slow ref settle), the next hide/show toggle
   fixes the state.

The app-side rule "wait for the first `visibility` message before starting
audio" still holds — a slot that has never been toggled and never received
its initial reply will simply stay paused, which is the safe default.

### Why this is opt-in, not enforced

The previewed app is user code. We can't suspend its `AudioContext` from
the outside without breaking that code's own state machine — every game
that wants to handle pause/resume already has logic for it, and ours would
race theirs. The right move is to give the app a clean signal and let it
decide.

The agent reads `/shipit-docs/preview.md` when scaffolding or modifying
preview apps. We add the contract there, plus minimal snippets, so apps
the agent writes implement it by default. External code (someone pasting
a CodePen, a non-agent-scaffolded project) won't honor the contract —
that's an accepted limitation. The blast radius is small in practice:
games and audio toys (the cases that motivate this) are almost
exclusively things the agent scaffolds, so templates + docs cover the
vast majority of cases that hit users.

## Implementation

Four edits, ordered so each lands as an independent commit.

### 1. Agent-facing docs (`src/server/shipit-docs/preview.md`)

New section titled **"Pausing audio and animation when hidden"** placed
after the existing **Hot Module Replacement (HMR)** section and before
**Restart triggers** (current line ordering in
[`preview.md`](../../src/server/shipit-docs/preview.md)). Content:

- **The principle**: previews in ShipIt should treat hidden as paused. The
  user expects switching sessions or ports to silence audio and stop
  background work — not just hide the pixels.
- **The protocol**: the two message shapes above, who sends what when,
  and the rule "treat the first `visibility` message as authoritative
  initial state."
- **Minimal copy-paste snippets**:
  - **Web Audio API**: **lazy-construct the `AudioContext`** and gate
    its creation behind the first `visibility: true` message; on
    subsequent transitions call `await ctx.suspend()` / `await
    ctx.resume()`. (Both return Promises; `await` to avoid the
    rapid-toggle race.) The lazy-init rule is load-bearing — bold it in
    the doc so the agent doesn't quietly regress to module-top
    construction when filling in audio code.
  - **HTML5 `<audio>` / `<video>`**: record paused state when going hidden
    so resume doesn't unilaterally play media the user had paused.
  - **`requestAnimationFrame` game loop**: gate the next `rAF` on a
    `running` flag; on `visibility:false` clear `running` so the loop
    exits at the next frame boundary; on `visibility:true` restart by
    setting `running` and calling `rAF` once.
- **Where to wire it**:
  - **Vanilla / Vite SPAs**: put the listener and the `ready` emit at the
    top of `src/main.{js,ts,tsx}` *before* any module-level code that
    might construct an `AudioContext` or start a loop. Hoisted module
    side effects run before component render.
  - **React**: do NOT put the listener inside a top-level `useEffect` —
    effects fire after first paint, which is too late to gate audio
    initialization. Either (a) put the bare `addEventListener` /
    `postMessage` call at module scope in `src/main.tsx` and stash the
    received visibility into a `useSyncExternalStore` source, or (b)
    register the listener synchronously in `useState`'s initializer
    function (which fires during the first render, before any effect).
    Show option (a) in the snippet — simpler.
  - **Svelte**: module-script in the root component (`<script
    context="module">`), same constraint as React.
  - **Next.js App Router**: server components can't call `window`. The
    snippet has to live in a small `"use client"` component that mounts
    at the root layout — e.g. `src/app/preview-visibility.tsx`. Show
    this explicitly; it's not a one-liner.
  - **Astro**: inside an `<script>` block on the root layout `.astro`
    file (top-level page scripts ship inline by default).
- **A "don't" callout**: don't post `ready` from a `DOMContentLoaded`
  handler or a delayed setup hook — by the time it fires, the parent may
  already have given up on the buffer. Post it from module-top.

This file is baked into the session container image at
`/shipit-docs/preview.md` (see
[`environment.md`](../../src/server/shipit-docs/environment.md)); the
agent reads it via its tools at scaffolding time.

### 2. Parent-side wiring (`src/client/components/PreviewFrame.tsx`)

Three changes inside the component.

**(a) Extend the existing postMessage handler** at
[line 211](../../src/client/components/PreviewFrame.tsx#L211) to recognize
`type === "ready"` alongside `type === "loaded"`. The slot-resolution
logic (matching `event.source` against each iframe's `contentWindow`) is
reused. On `ready`:

- If the iframe matches a known slot, post the current visibility for
  that slot back to it.
- If it doesn't match (the ref race described above), push
  `{ source: event.source as Window, receivedAt: Date.now() }` into a
  ref-held ring buffer. Drain the buffer from a `useEffect` keyed on
  `[slotOrder]` (the same trigger that mutates `iframeRefs.current`) —
  iterate `iframeRefs.current` and reply to any buffered entries whose
  `source` now matches.
- Entries older than 2000ms are discarded silently. The TTL assumes the
  ref either settles within a render commit or the iframe is gone; if
  field data shows that assumption is wrong, the cheap fix is to extend
  the TTL — code comment should call this out.

Other inbound listeners (`usePreviewErrors`'s handler at
[`usePreviewErrors.ts:114`](../../src/client/hooks/usePreviewErrors.ts#L114))
are unaffected — they filter by `type` and fall through on `"ready"` /
`"visibility"`.

**(b) Add a per-slot effect** that watches the slot's `hidden` value
(computed at
[line 685](../../src/client/components/PreviewFrame.tsx#L685)) and, on
every change, posts `{ source: "shipit-preview", type: "visibility",
visible: !hidden }` to that slot's `contentWindow`. This re-emits the
state unconditionally, closing the race even if the initial
ready-reply was dropped. Concretely: lift the `hidden` computation into
a stable per-slot value and run a `useEffect` keyed on `[key, hidden]`.

**(c) Update both Tailwind sites at
[lines 708 and 709](../../src/client/components/PreviewFrame.tsx#L708)**
to keep their `invisible` class. The hiding mechanism doesn't change —
this is just a reminder that both branches (device-frame and fullscreen)
need to stay in sync if the className composition is refactored.

### 3. Scaffolding templates

The reviewer flagged that template entry-file shapes vary. Concretely:

| Template | Entry file | Action |
|---|---|---|
| `react-vite-ts` | `src/main.tsx` | Add module-top listener + `ready` emit. |
| `react-tailwind-vite-ts` | `src/main.tsx` | Same. |
| `vue-vite-ts` | `src/main.ts` | Same. |
| `svelte-vite-ts` | `src/main.ts` | Same. |
| `vanilla-vite` | `src/main.js` | Same. |
| `static-html` | `main.js` | Same. |
| `nextjs` (fullstack) | **no client entry** | Add a `"use client"` component at `src/app/preview-visibility-listener.tsx`, mounted from `src/app/layout.tsx`. |
| `astro` (fullstack) | `src/pages/index.astro` | Add an inline `<script>` block. |

Each template's snippet sets up the listener and posts `ready`. The
audio/animation suspension hook itself is a TODO comment in the snippet,
not active code — the template is a starter and may not have any audio
to suspend yet; the agent fills it in when adding such code. This avoids
shipping dead code while still wiring the contract.

Extend `templates.test.ts` with content assertions — the existing tests
use structural checks like `expect(written).toContain("package.json")`,
not snapshots. Add `toContain` assertions confirming each affected entry
file includes the listener registration and the `ready` emit.

### 4. Tests

Add to `PreviewFrame.test.tsx`:

- **`ready` triggers a visibility reply**: render with a known slot,
  dispatch a postMessage with `type: "ready"` and `event.source` set to
  the slot's iframe `contentWindow`, assert the parent calls `postMessage`
  on that `contentWindow` with the current visibility.
- **Hidden transition emits `visibility`**: render with `hidden=false`,
  flip to `true`, assert the iframe received a `visibility:false`
  postMessage. Then flip back, assert `visibility:true`.
- **Unmatched `ready` is buffered and resolved**: dispatch `ready` with a
  `Window` not yet in `iframeRefs`, advance time, then add the ref;
  assert the reply fires when the ref settles. (Use fake timers; verify
  the 2-second eviction by advancing past it.)
- **Existing `loaded` regression test continues to pass**: the cached-slot
  test at
  [`PreviewFrame.test.tsx:851`](../../src/client/components/PreviewFrame.test.tsx#L851)
  must still pass unchanged — `loaded` keeps its existing semantics.
- **Idempotent `ready`**: dispatching `ready` twice for the same slot
  produces two visibility replies, both correct (no internal state that
  could go stale).
- **Pool LRU eviction interaction**: evict a slot via
  `MAX_IFRAME_SLOTS`-driven eviction, then re-mount the same key; the new
  iframe's `ready` is handled freshly (no stale state from the evicted
  slot bleeds in).

Manual verification:

- Scaffold a vanilla template, add a Web Audio sine wave on a button
  click, hit play, switch ports, confirm audio stops. Switch back,
  confirm audio resumes only if the app's snippet calls `resume()`
  (else stays paused — both are correct app behaviors).
- Cross-session switch with audio: open two sessions, one playing
  audio, switch, confirm audio follows the visible session.
- Dogfood case: when the dev service runs ShipIt-in-ShipIt, the inner
  preview is itself an iframe. The inner orchestrator's parent — the
  outer ShipIt UI — should never send `shipit-preview` messages to it
  (the outer's iframe is the *inner orchestrator*, not a preview slot).
  Belt-and-braces: inner iframes filter by `source`, so a stray message
  would be ignored.

## Edge cases and non-goals

- **Apps that don't cooperate stay broken.** External code that doesn't
  implement the contract (someone cloning a public game, a CodePen
  paste) will keep playing audio when hidden. Mitigated by scaffolding
  templates + agent reading the docs.
- **Nested iframes inside the preview.** A user app that itself embeds a
  third-party iframe (YouTube, Twitch) can't propagate the visibility
  signal cross-origin without the third party implementing the
  contract. Out of scope.
- **Initial-load audio race.** An app that synchronously constructs
  `new AudioContext()` and `resume()`s on module load — before any
  `visibility` message arrives — will produce a brief audible blip. The
  snippets default to lazy-init to avoid this; an app that diverges from
  the snippet is on its own.
- **Tab-level visibility.** When the browser tab is backgrounded,
  `document.visibilityState` already fires inside the iframe (it's a
  per-document API). Both signals say "pause"; no conflict.
- **`hideIframe` collapses two states** today: panel collapsed vs.
  inactive background slot. Apps probably want to treat them
  identically — that's why we pass a boolean, not a reason — but if a
  future feature wants to distinguish them, the wire can grow a
  `reason` field. Out of scope for v1.
- **Cross-origin posting** uses `"*"` as the target origin. For
  subdomain-routed previews the parent doesn't know the iframe's origin
  in advance, so this is the only option. Acceptable: the payload
  contains no secrets, and a misconfigured iframe would just see a
  `visibility` message it doesn't recognize and ignore.
- **App sends `visibility` *to* the parent.** Shouldn't happen, but the
  parent's handler ignores unrecognized inbound types. Verified by test
  case above.
- **No enforcement.** We don't dev-assert that audio actually stops
  when hidden. A future "preview lints" panel could surface apps that
  produce sound while `visible:false`; out of scope here.

## Trade-offs

- **Cooperation, not coercion.** Agent must wire up the listener.
  Templates handle new projects; existing projects rely on the agent
  reading the docs and remembering when audio is added. Worth the cost
  to avoid corrupting the app's audio state from outside.
- **Two events that fire at similar moments.** `loaded` and `ready`
  both fire near document load — but mean different things and have
  different emitters. Documented inline in both files; one comment per
  emit site keeps the next maintainer from collapsing them.
- **Ring buffer for the ref race** is small extra code, but the race is
  real enough that the v1 must address it (the worst failure is silent
  audio-playing — the exact bug we're solving).
- **Wire growth.** Two more `postMessage`s per visibility transition
  per visible slot. Negligible.
- **Doesn't help in production.** The contract serves the in-editor
  preview only. Apps deployed to production don't have ShipIt sending
  visibility messages — but they also don't have the iframe-pool
  problem, so no regression.

## Key files

- `src/server/shipit-docs/preview.md` — new section documenting the
  contract; baked into session containers at `/shipit-docs/preview.md`.
- `src/client/components/PreviewFrame.tsx` — parent-side: extend
  postMessage handler at line 211 to handle `ready` (with ring-buffer
  fallback); add per-slot effect that posts `visibility` on `hidden`
  transitions; keep `invisible` className at lines 708/709.
- `src/client/components/PreviewFrame.test.tsx` — new test cases listed
  above; preserve existing cached-slot regression test at line 851.
- `src/server/orchestrator/preview-proxy.ts` — **unchanged.** `loaded`
  keeps its existing semantics; `ready` is emitted by app code, not by
  the injected shim.
- `src/server/orchestrator/templates-frontend.ts`,
  `templates-fullstack.ts` — add snippet to each template's entry file,
  with the structural variations noted in §"Scaffolding templates."
- `src/server/orchestrator/templates.test.ts` — update snapshots for
  affected templates.

## Checklist

See [checklist.md](./checklist.md).
