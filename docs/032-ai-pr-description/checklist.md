# 032 — AI-Generated PR Description: Checklist

## Server

- [ ] Add `WsGeneratePRDescription` and `WsGeneratedPRDescription` types to `src/server/types.ts`
- [ ] Add `generate_pr_description` handler in `src/server/index.ts`
- [ ] Add `diffSummary()` to `GitManager` if not present (files changed with insertions/deletions)
- [ ] Implement text generation backend (standalone Claude API call or git log summary)

## Client

- [ ] Add "Ask Claude to write description" button to `PullRequestModal.tsx`
- [ ] Add loading state while generating ("Generating..." with spinner)
- [ ] Handle `generated_pr_description` message — populate description textarea
- [ ] Replace confirmation when description already has content
- [ ] Error state re-enables button with error message

## Tests

- [ ] Integration tests: `src/server/integration_tests/pr-description.test.ts`
  - [ ] Generate → receive description with markdown content
  - [ ] No git history → graceful handling
  - [ ] Generation error → error message
- [ ] Component tests: extend `src/client/components/PullRequestModal.test.tsx`
  - [ ] "Ask Claude" button calls handler
  - [ ] Loading state shown while generating
  - [ ] Generated text populates textarea
  - [ ] Replace confirmation when description exists
  - [ ] Error state re-enables button
