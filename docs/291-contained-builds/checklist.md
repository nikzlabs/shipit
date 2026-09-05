# Contained builds checklist

Design only. Implementation is not in scope for this doc's pull request and is
blocked on the open questions in [requirements.md](requirements.md).

- [x] State the requirements as observable outcomes, with everything invented
      under `## Open questions`.
- [x] Establish what a build step reaches today, from upstream source rather
      than from the existing one-line note in `compose.md`.
- [x] Answer whether a BuildKit worker can be placed in a prepared network
      namespace, with the settings that do it and what they cost.
- [x] Record the two properties of the tier program — OUTPUT-only, uid-keyed —
      that decide which shapes can work.
- [x] Lay out the candidate shapes with what each survives, and recommend one.
- [x] Engage with `docs/264-docker-sandboxes-evaluation`'s deferral rather than
      reopening it.
- [x] List the experiments that must precede implementation, and mark the one
      fail-open reading that must be tested rather than inferred.
- [x] Create the tracker issue and cross-link it from the doc's frontmatter.
- [x] Independent review.
