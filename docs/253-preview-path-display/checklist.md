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
