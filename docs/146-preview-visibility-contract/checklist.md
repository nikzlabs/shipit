# Checklist

> **docs/242 integration:** implement this contract through the shared
> `window.shipit` bootstrap described in
> `docs/242-agent-interface-sdk/plan.md`. Preserve the raw `ready`/`visibility`
> wire shapes for backward compatibility. The template tasks below are
> superseded by proxy/runtime injection plus agent-facing SDK documentation;
> existing raw listeners must continue to work.

## Docs

- [ ] Add "Pausing audio and animation when hidden" section to
      `src/server/shipit-docs/preview.md`, placed between **Hot Module
      Replacement (HMR)** and **Restart triggers**.
- [ ] Section covers: the principle, the protocol, snippets for Web
      Audio / `<audio>`+`<video>` / rAF, framework-specific wiring
      (vanilla, React, Svelte, Next.js, Astro), and the "don't" callout
      against deferred-`ready` patterns.

## Parent (PreviewFrame.tsx)

- [ ] Extend postMessage handler at
      `PreviewFrame.tsx:211` to recognize `type === "ready"` alongside
      `type === "loaded"`. Reply with current `visibility` for the
      originating slot.
- [ ] Add a ref-held ring buffer (cap 8, 2s eviction) for unmatched
      `ready` messages; drain from a `useEffect` keyed on `[slotOrder]`
      (the same trigger that mutates `iframeRefs.current`).
- [ ] Add a per-slot effect keyed on `[key, hidden]` that posts
      `{type:"visibility", visible:!hidden}` on every change.
- [ ] Keep `invisible` className at both lines 708 and 709 — no change.

## Tests (PreviewFrame.test.tsx)

- [ ] `ready` triggers a `visibility` reply targeting the originating
      `contentWindow`.
- [ ] `hidden` transitions emit `visibility` postMessages with correct
      values.
- [ ] Unmatched `ready` is buffered and resolved when the ref settles;
      entries older than 2s are dropped.
- [ ] Existing cached-slot regression test at line 851 continues to
      pass unchanged.
- [ ] `ready` is idempotent — two `ready`s yield two correct replies.
- [ ] LRU eviction + re-mount of the same slot key resets state cleanly.

## Shared page runtime (docs/242; supersedes template snippets)

- [ ] Inject one dependency-free `window.shipit` bootstrap from
      `preview-proxy.ts` rather than copying a raw listener into each template.
- [ ] Bootstrap posts the unchanged `shipit-preview` `ready` handshake,
      initializes visibility to unknown, and exposes
      `window.shipit.visibility.current/subscribe()`.
- [ ] Keep raw app-authored `ready`/`visibility` listeners working alongside
      the SDK wrapper; duplicate `ready` messages remain idempotent.
- [ ] Document SDK feature detection and visibility subscription in the shared
      agent-facing SDK reference, with framework-specific audio/animation
      examples in `preview.md` rather than generated template source.
- [ ] Test HTML-only, exactly-once proxy injection plus the bootstrap's
      handshake, authoritative initial state, transitions, and raw-listener
      coexistence.

## Verification

- [ ] Manual: scaffold a vanilla template, add a Web Audio sine wave,
      switch ports, confirm audio stops.
- [ ] Manual: cross-session switch with audio.
- [ ] Manual: re-emit-on-transition fallback — simulate a dropped
      initial reply (e.g. by deleting the ref before sending `ready`)
      and verify the next hide/show transition syncs the app.
- [ ] Dogfood: confirm inner-ShipIt preview iframes still work and
      aren't affected by stray `shipit-preview` messages (the inner
      orchestrator is the outer's preview iframe, not a normal
      app — its filtering should drop unrecognized types).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test:dev` passes.
