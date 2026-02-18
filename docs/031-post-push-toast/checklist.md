# 031 — Post-Push Toast: Checklist

## Client

- [x] Add toast notification state to `App.tsx` (or use existing toast system if present)
- [x] Show toast on successful `github_push_result` when authenticated and no existing PR
- [x] "Create PR" action button opens `PullRequestModal`
- [x] Auto-dismiss after 8 seconds
- [x] Skip toast when PR already exists for current branch
- [x] Create `Toast.tsx` component if no toast system exists

## Tests

- [x] Component tests: `src/client/components/Toast.test.tsx`
  - [x] Toast appears on successful push
  - [x] Toast hidden on push failure
  - [x] Toast hidden when not authenticated
  - [x] Toast hidden when PR already exists
  - [x] "Create PR" button opens modal
  - [x] Auto-dismisses after timeout
