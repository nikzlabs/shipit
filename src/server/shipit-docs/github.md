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
is repeatable and accepts comma-separated values (`--label a,b`).

To **re-label after a PR exists**, use `gh pr edit` with `--add-label` and/or
`--remove-label` (the same flags as the real `gh` CLI). Both are repeatable and
comma-separated, and you can add and remove in one call. For example, to switch
a PR from `documentation` to `enhancement`:

```sh
gh pr edit --add-label enhancement --remove-label documentation
```

With no PR number, `gh pr edit` operates on the current branch's PR. `--label`
still works on `gh pr edit` as an additive alias for `--add-label`.

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
- Skips creation if a PR is already **open** for the branch — it just prints the
  existing PR's URL and exits 0.
- A **merged/closed** PR only blocks creation while the branch hasn't moved past
  it. If you rebase the branch onto the current base and add new commits, `gh pr
  create` opens a **new** PR for that work (a merged PR can't be reopened). If the
  branch has no new work beyond what merged, it still prints the old PR's URL.
  - To continue a session after its PR merged, rebase against the **freshly
    fetched** remote base — `git fetch origin && git rebase origin/<base>` (e.g.
    `origin/main`), **not** a local `main` that may be stale. The "has the branch
    progressed?" check is local-git-only and compares against `origin/<base>`, so
    rebasing onto a stale ref leaves it looking un-rebased: `gh pr create` won't
    open the new PR and the session won't return to the active (gray) state.
- Targets the repo of the **current working directory's clone**. In a normal
  repo-bound session that is always the session repo at `/workspace`, so you
  don't need to think about it. In a **Sandbox session** (no bound repo — you
  clone repos yourself into `/workspace/<name>` subdirs), run `gh` from inside
  the clone you want to act on, or pass `--repo OWNER/NAME` to target one
  explicitly. The orchestrator resolves the repo from that clone's `origin`.
- Never sees the GitHub token; the orchestrator authenticates the request.

### Supported subcommands

| Subcommand | Notes |
|---|---|
| `gh pr create [-t TITLE] [-b BODY\|--body-file FILE] [-B BASE] [-d/--draft] [--fill] [-l/--label LABEL]` | Push current branch and open a PR. Use `--body-file -` with a quoted heredoc for markdown bodies. With `--fill`, an empty body is filled from recent commits. `--label` is repeatable / comma-separated and best-effort. |
| `gh pr edit [<n>] [-t TITLE] [-b BODY\|--body-file FILE] [--add-label LABEL] [--remove-label LABEL]` | Update title/body and/or add/remove labels. `<n>` defaults to the current branch's PR. `--add-label`/`--remove-label` are repeatable / comma-separated, may be given alone (no title/body needed), and are best-effort. `--label`/`-l` is an additive alias for `--add-label`. |
| `gh pr view [<n>] [--json FIELDS]` | Read a PR. With `--json title,body,state,…` returns just those fields. |
| `gh pr list [--state open\|closed\|all] [--json …]` | List PRs in the session's repo. |
| `gh pr status` | Print the current branch's PR (or "No PR"). |
| `gh pr comment [<n>] (-b BODY\|--body-file FILE)` | Leave an issue-style comment on a PR. |
| `gh pr ready [<n>]` | Mark a draft PR as ready for review. |
| `gh pr close [<n>]` | Close a PR. |
| `gh pr reopen <n>` | Reopen a closed PR. (PR number is required.) |
| `gh pr merge [<n>] [--merge\|--squash\|--rebase] [--auto]` | **Sandbox sessions only, and only when the user granted "Allow merging PRs".** Merge a PR. Refused unless required checks are green (or pass `--auto` to enable merge-when-green). Branch protection / required reviews are enforced by GitHub — a rejection is reported, never forced. `--admin` (force-merge) is not available. See "Merging PRs" below. |

Every PR subcommand also accepts `--repo OWNER/NAME` (alias `-R`) to target a
specific repo — useful in a Sandbox session where you've cloned more than one.
Without it, the op targets the repo of the directory you ran `gh` in.

### Merging PRs (`gh pr merge`)

Merging is an outward-facing, effectively-irreversible action and the verb most
exposed to prompt-injection (untrusted PR content talking you into shipping
code), so it is **gated**, not part of the open allowlist:

- It works **only in a Sandbox session** (the "you own git / bring your own
  repos" mode). In a normal **repo-bound** session ShipIt owns the PR lifecycle —
  merge from the PR card in the ShipIt UI, not the shim; `gh pr merge` returns a
  403 there.
- Even in a Sandbox it is **off by default**. The user must turn on **"Allow
  merging PRs"** under GitHub access when creating the sandbox. Without that
  grant the shim returns a 403 explaining it isn't enabled.

When enabled, the guardrails are enforced server-side:

- **Required checks must be green.** A failing or still-running check refuses the
  merge with a clear message. Pass `--auto` to enable GitHub auto-merge
  (merge-when-green) instead of waiting.
- **Branch protection / required reviews are respected.** If GitHub rejects the
  merge (e.g. a required review is missing), the rejection reason is surfaced —
  the shim never forces past it. `--admin` is rejected.
- A draft PR is refused (run `gh pr ready` first).

### Workflow runs (read-only)

`gh run` and `gh workflow` are supported **read-only** — list and view workflow
runs (including manually-dispatched `workflow_dispatch` runs) and workflow
definitions, so you can fetch the result of a manual workflow inline. The
*manipulation* verbs (`gh workflow run`, `gh run rerun`, `gh run cancel`,
`gh run delete`) stay blocked: dispatching or cancelling CI is a deliberate
human/CI action, not an agent action.

| Subcommand | Notes |
|---|---|
| `gh run list [-w WORKFLOW] [-b BRANCH] [-s STATUS] [-L LIMIT] [--json FIELDS]` | List workflow runs, most-recent first. `-w` filters by workflow name/filename/id; `-s` by status (e.g. `completed`, `success`, `failure`, `in_progress`). Plain output is tab-separated: status, conclusion, title, workflow, branch, event, id. |
| `gh run view [<run-id>] [--log] [--log-failed] [--json FIELDS]` | View one run with its jobs. With no `<run-id>`, resolves the **latest run for the current branch** (falling back to the latest run overall). `--log` appends the run's job logs (tail-capped); `--log-failed` only failed jobs' logs. |
| `gh workflow list [--json FIELDS]` | List the repo's workflow definitions (name, state, id). |
| `gh workflow view <workflow> [--json FIELDS]` | View one workflow (by name, filename, or id) and its recent runs. Use `cat .github/workflows/<file>` to read the YAML — `--yaml` is not supported. |

These also accept `--repo OWNER/NAME` (alias `-R`). The `--json FIELDS` filter
uses the same field names as the real `gh` (e.g. `databaseId`, `status`,
`conclusion`, `displayTitle`, `workflowName`, `headBranch`, `event`, `url`; `gh
run view --json jobs` includes the jobs array).

### Subcommands that are intentionally unavailable

These are blocked because they widen the surface beyond pull-request review,
or because the corresponding action belongs to the user, not the agent:

- `gh api` — arbitrary GitHub API access is out of scope.
- `gh repo create|delete|edit|fork|sync|view|list` — repo lifecycle is owned
  by the orchestrator and the user.
- `gh release …` — releases are deliberate human acts.
- `gh workflow run`, `gh run rerun|cancel|delete` — **CI manipulation** is out
  of scope (the *read-only* `gh run list|view` and `gh workflow list|view` are
  supported — see "Workflow runs" above).
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
