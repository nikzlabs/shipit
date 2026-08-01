## Requirements discipline

At the start of work on a feature, check its folder for `requirements.md`. If present:

- Treat its numbered requirements as the human-owned source of truth; never silently fill a gap.
- Put gaps under `## Open questions` and ask the user with batched options and a recommendation.
- Do not write implementation code while any question is open. A human answer unblocks it only after you update the requirement, add a dated receipt under `## Resolved questions`, and remove the question in the same change.
- After implementation, have a fresh-context reviewer check the code against the requirements.

Only the active feature is gated. See `/shipit-docs/spec-discipline.md` for the workflow and document format.
