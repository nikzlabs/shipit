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

After each turn, ShipIt auto-commits your working-tree changes and (if GitHub
auth is configured) pushes to the remote with a 5-second debounce. If your turn
moves HEAD cleanly yourself, for example with a rebase, ShipIt still detects
the new branch tip and pushes it. You do not need to manage git yourself.

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
gh pr create -t "Short clear title" --label feature --body-file - <<'EOF'
## Summary
The user goal and why this change exists.

## Rationale
- Key implementation decisions and why they were chosen.
- Rejected simpler alternatives, if they matter.

## Changes
- What changed, grouped by behavior/module.
- For each meaningful behavior change, why it was needed.

## Test plan
- How to verify the change.
EOF
```

The `EOF` delimiter must be single-quoted. Do not put markdown containing
backticks in `-b "..."`: the shell evaluates backticks and `$(...)` inside
double quotes before the ShipIt `gh` shim receives the body.

### Labeling a PR

Set **one** primary `--label` that matches the change's intent so the repo's
release notes group it correctly — e.g. `feature`, `enhancement`, `bug`, `fix`,
`documentation`, `chore`, `refactor`, `ci`, `test`, or `dependencies`. `--label`
is repeatable and accepts comma-separated values (`--label a,b`), and works on
both `gh pr create` and `gh pr edit`.

Labeling is **best-effort**: the repo's label set varies, so if a label name
doesn't exist on the repo the PR is still created/updated — the shim prints the
PR URL, exits 0, and notes the skipped label on stderr. ShipIt also runs a
server-side path-based auto-labeler as a fallback, so your `--label` is a
semantic hint, not the only mechanism. Pick the single label that best describes
the change rather than guessing several.

Do not only describe what changed. Explain why the change was made, what user
request or bug it traces back to, and any tradeoff made. After creating a PR,
or when continuing work in a session that already has one, keep the PR body
current with `gh pr edit` whenever the turn materially changes behavior or
rationale. Maintain a stable rationale section instead of appending raw logs.

The shim:

- Pushes the branch first (you don't need a separate `git push`).
- Skips creation if a PR is already open for the branch — it just prints the
  existing PR's URL and exits 0.
- Always operates on the current session's repo. The `--repo` flag is rejected.
- Never sees the GitHub token; the orchestrator authenticates the request.

### Supported subcommands

| Subcommand | Notes |
|---|---|
| `gh pr create [-t TITLE] [-b BODY\|--body-file FILE] [-B BASE] [-d/--draft] [--fill] [-l/--label LABEL]` | Push current branch and open a PR. Use `--body-file -` with a quoted heredoc for markdown bodies. With `--fill`, an empty body is filled from recent commits. `--label` is repeatable / comma-separated and best-effort. |
| `gh pr edit [<n>] [-t TITLE] [-b BODY\|--body-file FILE] [-l/--label LABEL]` | Update title/body and/or add labels. `<n>` defaults to the current branch's PR. `--label` may be given alone (no title/body needed). |
| `gh pr view [<n>] [--json FIELDS]` | Read a PR. With `--json title,body,state,…` returns just those fields. |
| `gh pr list [--state open\|closed\|all] [--json …]` | List PRs in the session's repo. |
| `gh pr status` | Print the current branch's PR (or "No PR"). |
| `gh pr comment [<n>] (-b BODY\|--body-file FILE)` | Leave an issue-style comment on a PR. |
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
- `gh ssh-key …`, `gh gpg-key …`, `gh codespace …`, `gh extension …` — out of
  scope for v1.
- `gh issue …` — **not** the issue surface. To *read* issues, use the
  tracker-neutral `shipit issue view`/`list` (see [issues.md](issues.md)), which
  works for both GitHub and Linear. `gh issue` stays blocked so there is one
  consistent issue contract regardless of tracker.

If you try one, the shim exits non-zero with an error pointing back to this
file.

### Push semantics and credentials

`git push`/`git pull`/`git fetch` to `github.com` work from inside the session
container, but **the GitHub token is never on disk or in your environment**.
Git is configured with a *brokering* credential helper
(`/usr/local/bin/shipit-git-credential`): when git needs a credential it asks
the helper, which fetches the token from the ShipIt orchestrator over localhost
for that one operation. The token is never written into `.gitconfig`, never
exported as an env var, and is only ever returned for `github.com`.

Practically: you won't see the token if you `cat ~/.gitconfig` or run
`git config --get credential.helper` — you'll see the helper *path*, not a
secret. This is intentional (see the security model below).

For opening pull requests, still prefer `gh pr create` — it also flushes any
pending working-tree changes and registers the PR with ShipIt's lifecycle UI.

### Security model (why the token isn't reachable)

The agent (you) runs inside the same container your `Bash` tool runs in, so any
secret physically present in the container is reachable by injected/untrusted
instructions. ShipIt therefore keeps the GitHub token *out* of the container:
the `gh` shim brokers PR API calls, and the `shipit-git-credential` helper
brokers raw git transport. Both proxy to the orchestrator, which holds the
token. There is nothing in the sandbox to exfiltrate.

## CI status

ShipIt polls GitHub for CI check status on the session's branch. If checks
fail, the user sees the failure in the UI and can ask you to fix the issues.

## Importing repos

Users can import existing GitHub repositories when creating a new session.
ShipIt clones the repo into the session's workspace at `/workspace`.
