# Checklist — PR-card issue chips (docs/206)

- [x] Commit the multi-option mockup (`mockup.html`) for history.
- [x] Write `plan.md`.
- [x] Add `extractIssueRefsFromText()` to `src/server/shared/issue-ref.ts` (conservative free-text scan).
- [x] Unit-test the extractor in `issue-ref.test.ts` (URLs, `owner/repo#N`, `issue`-prefixed keys; reject `UTF-8`/`GPT-4` and bare keys with no lead-in).
- [x] Add `IssueChipRef` + `collectPrCardIssueRefs()` in `src/client/utils/pr-card-issue-refs.ts` (merge PR-body + origin, dedupe, precedence closes > refs > origin).
- [x] Unit-test the combiner in `pr-card-issue-refs.test.ts`.
- [x] Render `PrCardIssueChip` + leading-issue-chips-with-divider in `ChangedDocsStrip.tsx`.
- [x] Wire `PrLifecycleCard.tsx`: memoized `issueRefs`, gate toggle on issues-or-files, pass to strip.
- [x] Chip click opens inline issue detail via `issues-store.openIssue` (link-out only for unknown trackers).
- [x] Update `ChangedDocsStrip.test.tsx` / `PrLifecycleCard.test.tsx` for the issues-present + issues-only cases.
- [x] `npm run lint:dev` + `npm run typecheck` clean.
- [x] Create the Linear issue for this doc (SHI-151), write its URL into `plan.md` frontmatter.
- [x] Open PR (#1374, `Closes` SHI-151).
