# Preview path display — checklist

- [x] Requirements captured from the request, with dated receipts for both answered questions
- [x] Mockup of placement, truncation, and the root/unknown states
- [x] Injected script reports `pathname + search + hash` on load
- [x] Injected script re-reports on `pushState`, `replaceState`, `popstate`, `hashchange`
- [x] `PreviewFrame` validates the reported path and holds it per iframe-pool slot
- [x] `PreviewPath` chip: route/query split, query truncates first, root dimmed, no chip when unknown
- [x] Click-to-copy yields the full absolute URL, host included
- [x] Injected script executed in a sandbox by tests, not pattern-matched
- [x] Client tests for the plumbing, the hostile-path rejection, and the chip
- [x] `npm run typecheck`, `npm run lint:dev`, affected suites green

## Narrow-panel behaviour (reqs 6–9)

- [x] Requirements and dated receipts captured for the four answers given on 2026-08-16
- [x] Mockup of the five overflow options, with a live width slider
- [x] `usePreviewToolbarCollapse` — measured ladder, address outranks labels
- [x] Starvation is truncation *and* under-minimum, so a short URL does not collapse the bar
- [x] Copy control given a region floor so it cannot be clipped with the text
- [x] Every label wired into the ladder, including the non-selector service name and the error word
- [x] Auto-fix checkbox given an explicit `aria-label` — its visible name disappears at stage 2
- [x] Guard test: no label may sit outside the ladder (verified to fail on the real defect)
- [x] Real markup + real built stylesheet measured in a browser, 780px → 260px
