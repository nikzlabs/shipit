# Checklist

Nothing here may start while a bullet remains under `## Open questions` in
[requirements.md](requirements.md).

## Requirements

- [x] `requirements.md` written from the user's own words, with provenance
- [x] `plan.md` weighing the four mechanisms against measured evidence
- [x] Independent review of the design against the numbered requirements
- [x] Review findings folded in: a derived requirement demoted to an open
      question, a withdrawn open question recorded, M3 extended to cover the CLI
      surface, and three overstated claims corrected
- [ ] Open questions answered by a human, with dated receipts under
      `## Resolved questions`

## M3 — plugin-supplied Dockerfile (the target: reqs 1, 2, 3)

- [ ] Build-time egress containment designed — the prerequisite, and its own doc
- [ ] Manifest field by which a plugin names the Dockerfile its **CLI** runs on
- [ ] Build-and-adopt flow that replaces `PluginCliDeps.image` at invocation
- [ ] Image identity keyed to the plugin commit
- [ ] Build context resolved to the pristine checkout, with `install:` and a
      Dockerfile mutually exclusive
- [ ] Image pruning tied to generation pruning
- [ ] `build:` subtree validation narrowed to `context` and `dockerfile`

## Rejected / deferred

- [ ] M4 — running a call inside the plugin's service container; an
      optimisation of M3, with the trade recorded in `plan.md`
- **M2 — a plugin-named published image: rejected.** It fails req 3, which the
  user decided on 2026-09-05. Reviving it means changing req 3 and its receipt
  first.
- **M1 — making the dependency store's applicability observable: out of
  scope.** The user ruled on 2026-09-05 that it is a separate bug, tracked as
  planning#511. Do not sequence it against this feature.
