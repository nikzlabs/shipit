#!/bin/sh
# ShipIt Stop-hook: enforce PR creation after a meaningful turn.
#
# When the agent tries to stop a turn:
#   - if the branch has commits ahead of its base, a non-empty net diff vs
#     base, AND no PR exists in any state, block the stop and tell the agent
#     to call `gh pr create`.
#   - in any other state (no commits, empty net diff, a PR already exists in
#     ANY state — open/merged/closed, GitHub not connected, no remote, hook
#     already retried once, OR the working tree is mid-rebase/merge/etc so HEAD
#     isn't on a branch), exit 0 silently.
#
# Two guards keep this from re-prompting after a PR has already merged — the
# duplicate-PR bug where a long-running session opened a fresh PR every turn
# (#1302 → #1312 → #1314 → …):
#   1. Net-diff gate: a commits-ahead count > 0 with an *empty* net diff vs
#      base (a revert, or a branch that merged then rebased onto the updated
#      base so its content is already there) does NOT force a PR.
#   2. Any-state PR check: `gh pr view` now resolves a branch's PR by name
#      even after it merged/closed, so an already-PR'd branch is recognized
#      instead of looking PR-less.
#
# Exit codes (Claude Code Stop-hook semantics):
#   0  - allow stop
#   2  - block stop; stderr is fed back to the model so it continues the turn
#
# This is the enforcement layer for the "open a PR when files changed"
# instruction in agent-instructions.ts and CLAUDE.md. Wired up in
# /etc/shipit/managed-settings.json, which the orchestrator now *always*
# passes to the Claude CLI (so the PreToolUse branch-block hook is always
# active). PR enforcement itself stays opt-in: this hook self-gates on the
# SHIPIT_AUTO_CREATE_PR env var, which the orchestrator sets only when the
# autoCreatePr setting is on. With the setting off, this hook exits early.
#
# See docs/129-stop-hook-pr-enforcement/plan.md and
# docs/130-block-branch-ops/plan.md.

set -eu

# Consume stdin so the harness doesn't deadlock writing to us. Claude Code
# passes a JSON envelope on stdin with a `stop_hook_active` flag indicating
# whether the hook is being re-invoked after a previous block — we honor
# that to avoid infinite blocking loops.
PAYLOAD=$(cat || true)
case "$PAYLOAD" in
  *'"stop_hook_active"'*'true'*) exit 0 ;;
esac

# PR enforcement is opt-in. The managed-settings.json that registers this
# hook is always wired up (so the PreToolUse branch-block hook is always
# active), but the orchestrator only sets SHIPIT_AUTO_CREATE_PR=1 in the
# Claude CLI environment when the autoCreatePr setting is on. Without it,
# do nothing. See docs/130-block-branch-ops/plan.md.
[ "${SHIPIT_AUTO_CREATE_PR:-}" = "1" ] || exit 0

# Operate in whatever cwd Claude invoked us with — that's the session's
# workspace at agent-spawn time (see src/server/session/claude.ts where the
# CLI is launched with cwd: activeDir).
#
# Need a git repo to do anything useful.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Fail open while the working tree is in a transient state — a detached HEAD or
# an in-progress rebase/merge/cherry-pick/revert/bisect. In any of these states
# HEAD is not on a branch (or is about to move), so `gh pr create` cannot push:
#
#     error: The destination you provided is not a full refname
#     (i.e., starting with "refs/") ... 'HEAD'
#
# Blocking here would force the agent into an action that *cannot succeed* until
# the operation finishes. The real PR check belongs after the operation
# completes (HEAD back on a branch), so exit 0 now and re-check on a later stop.
if ! git symbolic-ref --quiet HEAD >/dev/null 2>&1; then
  exit 0  # detached HEAD (mid-rebase, or a bare SHA checkout)
fi
if [ -d "$(git rev-parse --git-path rebase-merge)" ] \
  || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
  exit 0  # rebase in progress
fi
for MARKER in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  if [ -e "$(git rev-parse --git-path "$MARKER")" ]; then
    exit 0  # merge / cherry-pick / revert / bisect in progress
  fi
done

# Resolve the base branch. Prefer origin/HEAD; fall back to origin/main, then
# origin/master. If none resolve, we can't tell whether anything changed —
# fail open.
BASE=""
for CANDIDATE in \
  "$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@')" \
  "origin/main" \
  "origin/master"
do
  if [ -n "$CANDIDATE" ] && git rev-parse --verify --quiet "$CANDIDATE" >/dev/null 2>&1; then
    BASE="$CANDIDATE"
    break
  fi
done
[ -n "$BASE" ] || exit 0

# Are we ahead of the base?
COMMITS_AHEAD=$(git rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
[ "$COMMITS_AHEAD" -gt 0 ] 2>/dev/null || exit 0

# Skip on the default branch itself (no PR concept). An empty HEAD_BRANCH means
# HEAD is detached — the transient-state guard above already exits 0 for that,
# but guard here too so an empty branch name can never fall through and block.
HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
BASE_LOCAL=${BASE#origin/}
[ -n "$HEAD_BRANCH" ] || exit 0
[ "$HEAD_BRANCH" != "$BASE_LOCAL" ] || exit 0

# Fail open when the branch introduces no net change vs base. Commits-ahead
# can be > 0 while the net diff is empty — a revert that cancels itself out, or
# a branch that was merged and then rebased onto the updated base so its
# content already lives there. Neither warrants forcing a PR. `git diff
# --quiet` exits 0 (no diff) / 1 (diff); the `if` suspends `set -e` so a diff
# doesn't abort the script. Three-dot (base...HEAD) compares against the
# merge-base, i.e. the net change the branch introduces.
if git diff --quiet "$BASE...HEAD" 2>/dev/null; then
  exit 0
fi

# Does a PR already exist?  gh pr view exits 0 on hit, non-zero on miss/error.
# It now resolves a branch's PR in ANY state (open/merged/closed), so a branch
# whose PR already merged is recognized as having one and we do NOT re-prompt.
# We capture stderr to distinguish "no PR" from "auth failure / not connected"
# so the hook fails open on configuration problems.
GH_STDERR=$(gh pr view --json url 2>&1 >/dev/null || true)
[ -z "$GH_STDERR" ] && exit 0  # PR exists
case "$GH_STDERR" in
  *"No pull request found"*) ;;   # legitimate miss → block below
  *) exit 0 ;;                    # auth/network/config error → fail open
esac

# Block the stop. stderr is fed back to the model as a system message,
# which forces it to continue the turn — so the next thing it does is
# call `gh pr create`. The `stop_hook_active` guard above prevents loops.
cat >&2 <<'EOF'
You changed files on this branch but no PR exists yet. Before stopping, open one:

  gh pr create -t "<short descriptive title>" -b "<markdown body>"

Body should have:
  ## Summary    — 1-2 sentences on why this change exists
  ## Changes    — bullet list of the key edits
  ## Test plan  — how to verify it works

Run `gh pr create` now, then finish the turn.
EOF
exit 2
