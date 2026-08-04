## Requirements discipline

At the start of each turn that touches feature work, check the active feature's folder for `requirements.md`. If present:

- Treat its numbered requirements as the human-owned source of truth; never silently fill a gap.
- Put gaps under `## Open questions` and ask the user with batched options and a recommendation.
- Do not write implementation code while any question is open. A human answer unblocks it only after you add a dated receipt under `## Resolved questions`, remove the question, and make any resulting requirement change in the same change.
- After implementation, have a fresh-context reviewer check the code against the requirements.

Only the active feature is gated. See `/shipit-docs/spec-discipline.md` for the workflow and document format.
