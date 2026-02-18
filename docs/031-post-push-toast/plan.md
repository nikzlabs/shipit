---
status: in-progress
---
# 031 — Post-Push Toast with PR Action

## Summary

After a successful git push, show a toast notification with a shortcut to create a pull request. Connects the push and PR creation into a seamless flow.

## Motivation

Currently after a push completes (`github_push_result`), there's no prompt guiding the user to the next step. They have to remember to click the PR button in the header. A contextual toast bridges this gap:

```
✓ Pushed to origin/feature-branch.  [Create PR]
```

This is a common UX pattern — GitHub's own CLI (`gh`) prints a PR creation URL after push. It's especially valuable for vibe coding where the push → PR flow should feel automatic.

## How It Works

### Client-Side Only

No server changes needed. The `github_push_result` handler in `App.tsx` already processes push results — this adds a toast notification with an action button.

#### Toast Component

Use the existing toast/notification pattern in ShipIt (or add a minimal one if none exists):

```
┌───────────────────────────────────────────────┐
│ ✓ Pushed to origin/feature-branch  [Create PR]│
└───────────────────────────────────────────────┘
```

**Behavior:**
- Shown on successful push only (not on failure)
- Auto-dismisses after 8 seconds (longer than typical toasts since it has an action)
- "Create PR" button opens the `PullRequestModal`
- Only shown when GitHub is authenticated and a remote is configured (same conditions as the header PR button)
- Not shown if a PR already exists for the current branch (check `prStatus` state)

#### Integration in App.tsx

```typescript
// In the github_push_result handler:
if (data.type === "github_push_result" && data.success) {
  // Show toast with PR action
  if (githubStatus.authenticated && !prStatus?.pr) {
    showToast({
      message: `Pushed to origin/${currentBranch}`,
      action: {
        label: "Create PR",
        onClick: () => {
          setShowPRModal(true);
          handleRequestBranches();
        },
      },
      duration: 8000,
    });
  }
}
```

### Toast Infrastructure

If ShipIt doesn't already have a toast system, add a minimal one:

```typescript
// State in App.tsx
const [toast, setToast] = useState<{
  message: string;
  action?: { label: string; onClick: () => void };
} | null>(null);

// Auto-dismiss
useEffect(() => {
  if (toast) {
    const timer = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(timer);
  }
}, [toast]);
```

The toast renders as a fixed-position bar at the bottom of the screen, styled with Tailwind.

## Testing

### Component Tests
1. Toast appears on successful push when authenticated and no existing PR
2. Toast does not appear on push failure
3. Toast does not appear when not authenticated
4. Toast does not appear when PR already exists for branch
5. "Create PR" button opens PullRequestModal
6. Toast auto-dismisses after timeout
7. Manual dismiss works

## Key Files

| File | Change |
|---|---|
| `src/client/App.tsx` | Add toast state, show on push success, wire PR modal open |
| `src/client/components/Toast.tsx` | New component (if no toast system exists) |
| `src/client/components/Toast.test.tsx` | Component tests |

## Complexity

Low. Pure client-side UI — a positioned div with a timeout and a button that opens an existing modal. Estimate: ~100-150 lines of new code.
