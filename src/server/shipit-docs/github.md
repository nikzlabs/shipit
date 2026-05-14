# GitHub Integration

When GitHub auth is configured, ShipIt integrates with the project's GitHub
repository for branches, PRs, and CI.

## Branch model

- Each session works on its own branch, created automatically.
- Branch names follow the pattern `shipit/{session-name}`.
- The branch is created from the repo's default branch (usually `main`).
- **Do not create or switch branches yourself** (`git checkout -b`, `git switch
  -c`, `git branch`). You are already on the session branch, and auto-commit,
  auto-push, and `gh pr create` all target it. Creating your own branch strands
  your work off the branch ShipIt is tracking. ShipIt enforces this — branch
  create/switch commands are blocked before they run, so just stay on the
  current branch and run your `git` / `gh` commands there.

## Auto-push

After each turn, ShipIt auto-commits your changes and (if GitHub auth is
configured) pushes to the remote with a 5-second debounce. You do not need to
manage git yourself.

## Pull requests

You can open and manage PRs directly from your bash tool using `gh`. ShipIt's
`gh` is a **purpose-built shim**, not the real GitHub CLI — it brokers a
narrow allowlist of pull-request operations through the orchestrator using
the user's GitHub auth, so you never see or handle the token.

When you finish a turn that changed any file in the repo and there isn't
already an open PR for the current branch, run the following — do **not**
create or switch branches first, you are already on the session branch and
`gh pr create` pushes it for you:

```sh
gh pr create -t "Short clear title" -b "$(cat <<'EOF'
## Summary
Why this change exists, in 1–3 bullets.

## Changes
- Bullet list of what changed.

## Test plan
- How to verify the change.
EOF
)"
```

The shim:

- Pushes the branch first (you don't need a separate `git push`).
- Skips creation if a PR is already open for the branch — it just prints the
  existing PR's URL and exits 0.
- Always operates on the current session's repo. The `--repo` flag is rejected.
- Never sees the GitHub token; the orchestrator authenticates the request.

### Supported subcommands

| Subcommand | Notes |
|---|---|
| `gh pr create [-t TITLE] [-b BODY] [-B BASE] [-d/--draft] [--fill]` | Push current branch and open a PR. With `--fill`, an empty body is filled from recent commits. |
| `gh pr edit [<n>] [-t TITLE] [-b BODY]` | Update title/body. `<n>` defaults to the current branch's PR. |
| `gh pr view [<n>] [--json FIELDS]` | Read a PR. With `--json title,body,state,…` returns just those fields. |
| `gh pr list [--state open\|closed\|all] [--json …]` | List PRs in the session's repo. |
| `gh pr status` | Print the current branch's PR (or "No PR"). |
| `gh pr comment [<n>] -b BODY` | Leave an issue-style comment on a PR. |
| `gh pr ready [<n>]` | Mark a draft PR as ready for review. |
| `gh pr close [<n>]` | Close a PR. |
| `gh pr reopen <n>` | Reopen a closed PR. (PR number is required.) |

### Subcommands that are intentionally unavailable

These are blocked because they widen the surface beyond pull-request review,
or because the corresponding action belongs to the user, not the agent:

- `gh api` — arbitrary GitHub API access is out of scope.
- `gh repo create|delete|edit|fork|sync|view|list` — repo lifecycle is owned
  by the orchestrator and the user.
- `gh release …` — releases are deliberate human acts.
- `gh workflow …`, `gh run …` — CI manipulation is out of scope.
- `gh auth …` — auth is owned by the ShipIt UI.
- `gh secret …`, `gh variable …` — use `shipit.yaml` and the secrets surface.
- `gh ssh-key …`, `gh gpg-key …`, `gh codespace …`, `gh extension …`,
  `gh issue …` — out of scope for v1.

If you try one, the shim exits non-zero with an error pointing back to this
file.

### Push semantics and credentials

Inside the session container `git push` is **not** authenticated — there is
no credential helper in the workspace. Use `gh pr create`; it pushes the
branch through the orchestrator (which has the token) before opening the PR.
If you only need to push without opening a PR, ask the user to push from the
ShipIt UI, or add work to a follow-up commit and push it via `gh pr edit`-
adjacent flows.

## CI status

ShipIt polls GitHub for CI check status on the session's branch. If checks
fail, the user sees the failure in the UI and can ask you to fix the issues.

## Importing repos

Users can import existing GitHub repositories when creating a new session.
ShipIt clones the repo into the session's workspace at `/workspace`.
