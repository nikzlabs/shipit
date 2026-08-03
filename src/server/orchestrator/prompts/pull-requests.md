## Pull requests

This falls under action-oriented: do, don't ask.

When you finish a turn in which you edited any file in the repo and there isn't already an open PR for this branch, open one. Do not ask first. Run `gh pr create -t "<title>" --body-file - <<'EOF'` with the markdown body in a single-quoted heredoc as the next action after the work is done. Do NOT create or switch branches first — you are already on the session branch, and `gh pr create` pushes it for you.

Base the decision on your own Edit/Write/MultiEdit calls during the turn — NOT on `git status`, `git diff`, or `git log`. ShipIt auto-commits after the turn, so during the turn nothing you edited is committed yet; a clean log, "no commits ahead", or a dirty working tree is the normal in-turn state, not a signal that there is nothing to PR. When you run `gh pr create` mid-turn, the orchestrator flushes your pending edits into a commit, pushes the branch, and opens the PR for you — so the just-made changes always land on the PR.

Asking "want me to open a PR?" is wrong — by the time you're considering it, the answer is yes. The only times you skip are (a) a PR already exists for the branch, or (b) the user explicitly said not to. There is no "this change is too small" exception — typo fixes, config tweaks, one-line bug fixes, comment-only edits all get a PR. If you wrote any change at all, open the PR.

Write a clear, descriptive title and a markdown body with the following sections:

- `## Summary` — 1-2 sentences explaining the user goal and why this change exists.
- `## Rationale` — the key implementation decisions and why they were chosen; include rejected simpler alternatives if they matter.
- `## Changes` — bullet list of the key changes, grouped by behavior/module. For each meaningful behavior change, include the reason it was needed and the user request, bug, or tradeoff it traces back to.
- `## Test plan` — how to verify the change works.

If this PR is the work for a tracked issue, link it in the body so the issue's status follows the PR automatically (docs/194):

- The PR **fully finishes** the issue → add a `Closes <pointer>` line (synonyms `Fixes`/`Resolves`). On merge ShipIt flips the issue to **completed** and posts a resolved-by comment.
- The PR is **part** of the work, more PRs to come → add a non-closing `Refs <pointer>` line instead. On merge ShipIt posts a progress comment and leaves the issue open. **Omitting** `Closes` is how you say "not done yet."
- The `<pointer>` is the same tracker-neutral form `shipit issue` takes (`SHI-43`, `owner/repo#42`, or a full issue URL). A PR that names no pointer gets no automatic issue activity.

Set one primary `--label` on `gh pr create` that matches the change's intent (e.g. `feature`, `enhancement`, `bug`, `fix`, `documentation`, `chore`, `refactor`, `ci`, `test`, `dependencies`) so release notes group it correctly: `gh pr create -t "<title>" --label feature --body-file - <<'EOF' … EOF`. Pick the single best-fitting label, not several. Labeling is best-effort — the repo's label set varies, so an unknown label name is skipped without blocking the PR, and a server-side path labeler still runs as a fallback. To correct a label after the PR exists, run `gh pr edit --add-label <new> --remove-label <old>` (both repeatable / comma-separated, best-effort).

Do not only describe what changed. Explain why the change was made. After creating a PR, or when continuing work in a session that already has one, keep the PR body current with `gh pr edit` whenever the turn materially changes behavior or rationale. Maintain a stable rationale section instead of appending raw logs.

Always pass PR markdown through `--body-file - <<'EOF'` rather than `-b "..." `. Shells evaluate backticks and `$(...)` inside double-quoted arguments before the ShipIt `gh` shim sees them, which corrupts markdown that mentions code, commands, or file names.

`gh` here is a ShipIt-provided shim that brokers a curated subset of pull-request operations through the orchestrator. It is not the real GitHub CLI: `gh api`, `gh repo`, `gh release`, `gh workflow`, `gh auth`, and `gh secret` are intentionally unavailable. See /shipit-docs/github.md for the full list of supported subcommands.

Use `gh pr create` once per session — repeated calls short-circuit while a PR is **open** for the branch. If that PR has since **merged** and the user wants you to keep going, you *can* open a follow-up PR: rebase onto the freshly-fetched base first — `git fetch origin && git rebase origin/<base>` (e.g. `origin/main`), **not** a stale local `main` — then make your new commits and run `gh pr create` again. The new-PR detection is local-git-only and compares against `origin/<base>`, so without that fetch+rebase it sees no new work and just reprints the merged PR's URL.