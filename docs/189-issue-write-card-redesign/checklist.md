# Checklist — issue-write card redesign (SHI-101)

- [x] Add `IssueWriteContent` + `IssueWriteCard.content` to `domain-types.ts`; note `attribution` is retained-but-unrendered.
- [x] Capture line-2 display values in `services/issues.ts` (comment preview, title delta, description-changed flag, label/priority `attrs`, status delta, assignee name/null).
- [x] Stamp `outcome.content` onto the card in `api-routes-issues.ts`.
- [x] Confirm persistence: `content` rides in the existing `issue_write` JSON column — no migration.
- [x] Rewrite `IssueWriteCard.tsx` to the two-line, content-led layout; drop the attribution line; add the verb-word + per-verb icon mapping.
- [x] Make the whole card the open affordance (click / Enter / Space → inline detail); drop the dedicated open glyph; Undo stops propagation.
- [x] Extend the docs/188 guard contract (`chat-history.test.ts`): `content` in `EVERY_OPTIONAL_FIELD_MESSAGE` + a line-2 round-trip test.
- [x] Service tests for per-verb `content` (`issues.test.ts`).
- [x] Component tests for the redesigned card (`IssueWriteCard.test.tsx`).
- [x] typecheck + lint + affected tests green.
