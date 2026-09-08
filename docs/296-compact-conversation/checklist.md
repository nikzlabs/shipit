# Design deliverables

- [x] Record user requirements and proposed display rules.
- [x] Inspect existing transcript and settings code.
- [x] Create an interactive visual mockup.
- [x] Verify the mockup in the browser (desktop dark and mobile light; toggle, disclosure, cards, and overflow).
- [x] Obtain ShipIt review and resolve valid findings; record the browser search decision (now approved).

The user subsequently approved production implementation.

- [x] Record displayed-content browser search approval.
- [x] Replace generic card disclosures with source-based layouts in Claude Light.

## Implementation

- [x] Add a local preference, off by default, in Settings → Advanced.
- [x] Hide completed ordinary detail while retaining cards, errors, attachments, and user messages.
- [x] Preserve active turns, per-run disclosure, rewind access, and fixed row groups.
- [x] Preserve message search, focus/selection, and scroll position.
- [x] Run component, smoke, lint, typecheck, and browser checks.
- [x] Resolve the independent implementation review, including scroll guards and long-transcript selection cost.
