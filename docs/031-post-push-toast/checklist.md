# 031 — Post-Push Toast: Checklist

## Client

- [ ] Add toast notification state to `App.tsx` (or use existing toast system if present)
- [ ] Show toast on successful `github_push_result` when authenticated and no existing PR
- [ ] "Create PR" action button opens `PullRequestModal`
- [ ] Auto-dismiss after 8 seconds
- [ ] Skip toast when PR already exists for current branch
- [ ] Create `Toast.tsx` component if no toast system exists

## Tests

- [ ] Component tests: `src/client/components/Toast.test.tsx`
  - [ ] Toast appears on successful push
  - [ ] Toast hidden on push failure
  - [ ] Toast hidden when not authenticated
  - [ ] Toast hidden when PR already exists
  - [ ] "Create PR" button opens modal
  - [ ] Auto-dismisses after timeout
