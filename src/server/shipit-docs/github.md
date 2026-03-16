# GitHub Integration

When GitHub auth is configured, ShipIt integrates with the project's GitHub
repository for branches, PRs, and CI.

## Branch model

- Each session works on its own branch, created automatically.
- Branch names follow the pattern `shipit/{session-name}`.
- The branch is created from the repo's default branch (usually `main`).

## Auto-push

After each turn, ShipIt auto-commits your changes and (if GitHub auth is
configured) pushes to the remote with a 5-second debounce. You do not need to
manage git yourself.

## Pull requests

- The user can create a PR from the UI after changes are pushed.
- PR descriptions can be AI-generated from the diff.
- PR status (open, merged, CI checks) is polled and displayed in the UI.

## CI status

ShipIt polls GitHub for CI check status on the session's branch. If checks
fail, the user sees the failure in the UI and can ask you to fix the issues.

## Importing repos

Users can import existing GitHub repositories when creating a new session.
ShipIt clones the repo into the session's workspace at `/workspace`.
