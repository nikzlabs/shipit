# Checklist

All open questions in [requirements.md](requirements.md) are answered, so the
M3 work below is unblocked. Its first item is the prerequisite, not the
plugin-facing surface.

## Requirements

- [x] `requirements.md` written from the user's own words, with provenance
- [x] `plan.md` weighing the four mechanisms against measured evidence
- [x] Independent review of the design against the numbered requirements
- [x] Review findings folded in: a derived requirement demoted to an open
      question, a withdrawn open question recorded, M3 extended to cover the CLI
      surface, and three overstated claims corrected
- [x] Open questions answered by a human, with dated receipts under
      `## Resolved questions` — none open; implementation is unblocked

## M3 — plugin-supplied Dockerfile (the target: reqs 1–4)

- [ ] Build-time egress containment **decided** — designed in
      `docs/291-contained-builds` (planning#512), whose own open questions
      gate this; three of them change what gets built
- [ ] Manifest field by which a plugin names the Dockerfile its **CLI** runs on
- [ ] Build-and-adopt flow that replaces `PluginCliDeps.image` at invocation
- [ ] Image identity keyed to the CONTENT of the Dockerfile and its declared
      inputs — never to the plugin commit, which req 4 forbids
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
