# Checklist

> **Status: design-only.** An initial implementation was built and then
> **reverted** (the chip set was still being finalized — see `suggestions.html`).
> The code below is **not** currently in the tree; only the design artifacts
> (`plan.md`, `mockup.html`, `suggestions.html`) remain. Re-implement once the
> final chip set is locked.

## Design

- [x] Direction settled: discoverability launchpad, not a banner
- [x] Mockup committed beside plan.md (`mockup.html`)
- [x] Candidate chip suggestions, grounded in the README (`suggestions.html`)
- [x] Scope decided: regular repo sessions only (no sandbox); top placement
- [x] Cross-agent chip gated on ≥2 authed agents (`installed && authConfigured`)
- [ ] Final chip set locked (3 always-on + conditional cross-agent; +/- "Explain this project")
- [ ] Final seeded-prompt wording approved

## Implementation (reverted — to redo)

- [ ] `StarterPrompts` component
- [ ] Click seeds the composer via `setPrefillText` (edit-then-send, no auto-send)
- [ ] Render in App.tsx empty-state container, gated on `showRocket` + non-sandbox
- [ ] Conditional cross-agent chip; prompt names the non-active authed agent
- [ ] Co-located unit test
- [ ] Typecheck + lint clean
- [ ] Visual verification in the live app
