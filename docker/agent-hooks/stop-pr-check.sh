#!/bin/sh
# ShipIt Stop-hook: enforce PR creation after a meaningful turn.
#
# When the agent tries to stop a turn:
#   - if the branch has commits ahead of its base AND no PR exists,
#     block the stop and tell the agent to call `gh pr create`.
#   - in any other state (no commits, PR exists, GitHub not connected,
#     no remote, hook already retried once), exit 0 silently.
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

# Skip on the default branch itself (no PR concept).
HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
BASE_LOCAL=${BASE#origin/}
[ "$HEAD_BRANCH" != "$BASE_LOCAL" ] || exit 0

# Does a PR already exist?  gh pr view exits 0 on hit, non-zero on miss/error.
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
