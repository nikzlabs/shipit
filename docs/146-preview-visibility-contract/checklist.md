# Checklist

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

## Scaffolding templates

- [ ] `templates-frontend.ts`: add module-top snippet to `react-vite-ts`,
      `react-tailwind-vite-ts`, `vue-vite-ts`, `svelte-vite-ts`,
      `vanilla-vite`, `static-html` entry files.
- [ ] `templates-fullstack.ts`:
  - [ ] `nextjs`: create `src/app/preview-visibility-listener.tsx` as a
        `"use client"` component, mount from `src/app/layout.tsx`.
  - [ ] `astro`: add inline `<script>` block to `src/pages/index.astro`.
- [ ] Extend `templates.test.ts` with `toContain` assertions per
      affected template confirming the entry file ships the listener
      registration and the `ready` emit. (The existing tests are
      content-assertion-shaped, not snapshot-shaped.)

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
