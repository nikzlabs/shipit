# 032 — AI-Generated PR Description: Checklist

## Server

- [x] Add `WsGeneratePRDescription` and `WsGeneratedPRDescription` types to `src/server/types.ts`
- [x] Add `generate_pr_description` handler in `src/server/index.ts`
- [x] Add `diffSummary()` to `GitManager` (files changed with insertions/deletions)
- [x] Implement text generation backend (`generateText` dependency — spawns short-lived Claude process)

## Client

- [x] Add "Ask Claude to write description" button to `PullRequestModal.tsx`
- [x] Add loading state while generating ("Generating..." with disabled button)
- [x] Handle `generated_pr_description` message — populate description textarea
- [x] Replace confirmation when description already has content
- [x] Error state re-enables button with error message

## Tests

- [x] Integration tests: `src/server/integration_tests/pr-description.test.ts`
  - [x] Generate → receive description with markdown content
  - [x] No git history → graceful handling
  - [x] Generation error → error message
- [x] Component tests: extend `src/client/components/PullRequestModal.test.tsx`
  - [x] "Ask Claude" button calls handler
  - [x] Loading state shown while generating
  - [x] Generated text populates textarea
  - [x] Replace confirmation when description exists
  - [x] Error state re-enables button
