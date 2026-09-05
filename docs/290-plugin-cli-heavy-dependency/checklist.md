# Checklist

Nothing here may start while a bullet remains under `## Open questions` in
[requirements.md](requirements.md) — the second question (may a heavy
dependency require system packages?) decides whether anything past M1 is built
at all.

## Requirements

- [x] `requirements.md` written from the user's own words, with provenance
- [x] `plan.md` weighing the four mechanisms against measured evidence
- [ ] Open questions answered by a human, with dated receipts under
      `## Resolved questions`
- [ ] Independent review of the design against the numbered requirements

## M1 — make the dependency store's applicability observable (req 4)

- [ ] `planPluginDepStore` returns a typed reason instead of a bare `null`
- [ ] The reason is logged, and carried onto the repository's Plugins card
      beside the existing withheld-surface reasons
- [ ] Advisory only: a missing store never fails an install
- [ ] Co-located tests for each of the four `null` conditions
- [ ] `src/server/shipit-docs/plugin-authoring.md` documents the conditions

## M3 — plugin-supplied Dockerfile (only if the `apt` class is in scope)

- [ ] Build-time egress containment designed — the prerequisite, own doc
- [ ] Build context resolved to the pristine checkout, with `install:` and a
      Dockerfile mutually exclusive
- [ ] Image tag keyed to the plugin commit
- [ ] Image pruning tied to generation pruning
- [ ] `build:` subtree validation narrowed to `context` and `dockerfile`

## Not started

- [ ] M2 — a plugin-named published CLI image (needs a human to accept a
      documented exception to req 3)
- [ ] M4 — running a call inside the plugin's service container
