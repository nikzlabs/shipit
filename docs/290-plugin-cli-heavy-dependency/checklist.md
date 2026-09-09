# Checklist

**Re-blocked.** One open question in [requirements.md](requirements.md) decides
which mechanism is built at all: whether req 3 permits naming an *existing*
third-party image. A permissive answer makes M2b the target and retires the M3
work below for this feature.

## Requirements

- [x] `requirements.md` written from the user's own words, with provenance
- [x] `plan.md` weighing the four mechanisms against measured evidence
- [x] Independent review of the design against the numbered requirements
- [x] Review findings folded in: a derived requirement demoted to an open
      question, a withdrawn open question recorded, M3 extended to cover the CLI
      surface, and three overstated claims corrected
- [ ] Open question answered: does req 3 permit naming an existing third-party
      image? It decides M2b vs M3, and the answer retires one of them

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
- **M2a — an image the plugin author publishes: rejected.** It fails req 3,
  which the user decided on 2026-09-05. Reviving it means changing req 3 and its
  receipt first.
- **M2b — naming an existing public image: candidate, pending the open
  question.** If permitted it satisfies all four requirements with no build, so
  its work is a pull path, not applying the worker-image env repairs to a
  foreign image, and the manifest surface — and the M3 section above is retired
  for this feature.
- **M1 — making the dependency store's applicability observable: out of scope,
  and now shipped anyway.** The user ruled on 2026-09-05 that it is a separate
  bug; it was tracked as planning#511 and merged on its own. Nothing here
  depended on it.
