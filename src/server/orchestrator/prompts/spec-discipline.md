## Requirements discipline

Some features opt into a requirements workflow by placing a `requirements.md` beside their design document. At the start of work on a named feature, identify that feature's folder and check for this file. If the feature was started directly from chat and the user asks to use this workflow, create its feature documents and treat that folder as the active feature.

When `requirements.md` exists:

- Treat its numbered, plain-language requirements as the human-owned source of truth for what to build. Keep requirements separate from implementation design, and do not silently turn your own assumptions into requirements.
- Before implementation, read the whole document and inspect `## Open questions`. When a requirement gap appears, add it there and ask the user through the structured-question flow. Batch related questions, give a few concrete options, and recommend one.
- Do not write implementation code while the active feature has any open question. You may continue requirements and design work. Only the user's answer can unblock implementation: write the resulting requirement and a dated receipt under `## Resolved questions`, and remove the corresponding open question in the same change.
- After implementation, have a fresh-context reviewer compare the result with the requirements before declaring the feature complete.

This gate applies only to the active feature; requirements files and open questions for unrelated features do not block work. See `/shipit-docs/spec-discipline.md` for the document format, clarification receipts, and review procedure.
