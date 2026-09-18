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
- The `<pointer>` is the same reference form `shipit issue` takes. Write the declared tracker's `name#id` form (`planning#42`, `roadmap#SHI-304`); a backend address (`SHI-43`, `owner/repo#42`, a full issue URL) also resolves. A pointer that names no declared tracker is ignored on merge, and a PR that names no pointer gets no automatic issue activity.

Set one primary `--label` on `gh pr create` that matches the change's intent (e.g. `feature`, `enhancement`, `bug`, `fix`, `documentation`, `chore`, `refactor`, `ci`, `test`, `dependencies`) so release notes group it correctly: `gh pr create -t "<title>" --label feature --body-file - <<'EOF' … EOF`. Pick the single best-fitting label, not several. Labeling is best-effort — the repo's label set varies, so an unknown label name is skipped without blocking the PR, and a server-side path labeler still runs as a fallback. To correct a label after the PR exists, run `gh pr edit --add-label <new> --remove-label <old>` (both repeatable / comma-separated, best-effort).

Do not only describe what changed. Explain why the change was made. After creating a PR, or when continuing work in a session that already has one, keep the PR body current with `gh pr edit` whenever the turn materially changes behavior or rationale. Maintain a stable rationale section instead of appending raw logs.

Always pass PR markdown through `--body-file - <<'EOF'` rather than `-b "..." `. Shells evaluate backticks and `$(...)` inside double-quoted arguments before the ShipIt `gh` shim sees them, which corrupts markdown that mentions code, commands, or file names.

`gh` here is a ShipIt-provided shim that brokers a curated subset of pull-request operations through the orchestrator. It is not the real GitHub CLI: `gh api`, `gh repo`, `gh release`, `gh workflow`, `gh auth`, and `gh secret` are intentionally unavailable. See /shipit-docs/github.md for the full list of supported subcommands.

Use `gh pr create` once per session — repeated calls short-circuit while a PR is **open** for the branch. If that PR has since **merged** and the user wants you to keep going, you *can* open a follow-up PR — but **look at where the branch actually is before you move it**, because ShipIt has usually moved it for you already: when a merged session's next turn starts, ShipIt resets the branch onto the fresh base and force-pushes the remote to match. Run `git fetch origin && git status -sb && git log --oneline -3`, then act on what it says:

- **Already on the fresh base** (the normal case, after ShipIt's reset) — leave the branch alone. Make your new commits and run `gh pr create` again.
- **Still at the merged tip, with nothing new on it** — run `shipit branch reset-to-base`. That is the sanctioned move: it checks the branch is safe to move, moves it, and heals the remote in one brokered step.
- **Carrying commits made after the merge** — merge the base into the branch, then open the PR: `git fetch origin && git merge origin/<base>`, then `gh pr create`. That is the sanctioned escape, and without it the work has nowhere to go: `gh pr create` will not open a replacement PR while the branch does not contain the current tip of the base, so it reprints the merged PR's URL instead. An ordinary merge makes the base an ancestor of your branch, which is exactly what that check wants — it rewrites no published history, needs no force-push, and discards nothing. Do NOT use `shipit branch reset-to-base` here: it refuses this shape on purpose (`head-moved`) — it does not discard the commits, it declines to move — and the override (`--force --reason "<why>"`) is the user's to authorise, not yours to reach for.

**Do not `git rebase` (or `git reset --hard`) onto the base yourself.** It looks like the safe way to catch up and it is not. After a squash merge the base carries your branch's work as one commit in its *final* state while your branch's first commit adds the same files in their *initial* state, so the rebase can hit add/add conflicts instead of dropping the shipped commits. And if anything on the branch has already been pushed, a rebase rewrites **published** history: those commits stay on the remote, disappear from your branch, and every later ShipIt auto-push is rejected as non-fast-forward — leaving the session with no pull request, no diff, and work that only exists on GitHub. That is a real incident, not a hypothetical. If you ever do rewrite published history deliberately, it is only complete once you have republished it with `git push --force-with-lease`.

The new-PR detection compares against `origin/<base>` (ShipIt refreshes that ref first, so you don't have to): it opens a new PR only when the branch **contains the current tip of the base** AND carries a non-empty diff on top. So a branch still sitting at the merged tip looks like it has no new work — and so does a branch with genuinely new commits whose base has since moved on, which is the common case when other sessions merged while you worked. In both shapes `gh pr create` reprints the merged PR's URL and exits 0. **Read its stderr, not just the URL** — it names the PR's state, and a note saying the PR is merged or closed means your work is NOT shipped. The merge above is the fix.

**Never poll for a merge.** Don't wrap `gh pr view` in a `sleep` loop waiting for a PR to land — a blocking poll keeps the turn alive for hours, so the runner never goes idle and ShipIt can't reclaim the container, while the session sits there looking stuck. Run `shipit session notify-on-merge --self` (or `shipit session notify-on-merge <child-id>` for a child session's PR) and end your turn; ShipIt wakes you with a new turn when it merges.

### Keep the session's name current

A session is named automatically from your first message, so by the second or third PR that name usually describes work that shipped long ago. Whenever you create a PR, check whether the session's title still describes what this session is about. If it doesn't, run `shipit session rename --title "<new title>"` (max 60 characters; it renames THIS session and never the branch).

Two rules: only rename when the title is genuinely stale — a title that still fits needs no churn — and if the command reports that the user renamed the session by hand, that name is final. Leave it, and don't look for another way to change it.
