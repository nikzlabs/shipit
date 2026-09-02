#!/bin/sh
# ShipIt Stop-hook: enforce PR creation after a meaningful turn.
#
# When the agent tries to stop a turn:
#   - if the branch has commits ahead of its base, a non-empty net diff vs
#     base, and no PR that those commits could have shipped through, block the
#     stop and tell the agent to call `gh pr create`.
#   - in any other state (no commits, empty net diff, an OPEN PR already
#     exists, a merged/closed PR that `gh pr create` would refuse to replace,
#     GitHub not connected, no remote, hook already retried once, OR the
#     working tree is mid-rebase/merge/etc so HEAD isn't on a branch), exit 0
#     silently.
#
# Three guards keep this from re-prompting after a PR has already merged — the
# duplicate-PR bug where a long-running session opened a fresh PR every turn
# (#1302 → #1312 → #1314 → …):
#   1. Net-diff gate: a commits-ahead count > 0 with an *empty* net diff vs
#      base (a revert, or a branch that merged then rebased onto the updated
#      base so its content is already there) does NOT force a PR.
#   2. Any-state PR check: `gh pr view` resolves a branch's PR by name even
#      after it merged/closed, so an already-PR'd branch is recognized instead
#      of looking PR-less.
#   3. Progress gate: a merged/closed PR only silences the hook while
#      `gh pr create` would refuse to open a replacement. Once the branch sits
#      on the current base tip with new work on top — the state in which the
#      shim WILL open a fresh PR — the hook speaks again, because a merged PR
#      from an earlier turn is no proof that this turn's commits shipped.
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

# Does a PR already exist, and does it prove this work shipped?
#
# `gh pr view` resolves the branch's PR in ANY state, so a merged/closed PR
# answers here too — and the two answers mean very different things:
#
#   OPEN            → the work is shipped. Nothing to do.
#   MERGED / CLOSED → that PR cannot take new commits. Whether the hook should
#                     speak depends on whether `gh pr create` would in fact
#                     open a replacement, and that is decided by the same gate
#                     the orchestrator applies (`GitManager.mergedBaseProgress`,
#                     docs/202): the branch must CONTAIN the current base tip
#                     AND carry a non-empty diff on top. Only then do we block.
#                     A branch still sitting at the merged tip, or one whose
#                     base has moved on under it, is refused by the shim — so
#                     blocking there would demand an action that cannot
#                     succeed, which is the duplicate-PR nag guard 2 exists to
#                     prevent.
#
# `state` is GitHub's REST spelling, so a MERGED PR reads as "closed"; the
# `merged` boolean tells a merge from an abandon. Stdout and stderr are read
# together and told apart by content — the JSON we asked for always carries
# `"state":`, while a miss or an auth/config failure carries only prose — so
# the hook still fails open on configuration problems.
GH_OUT=$(gh pr view --json state,merged,baseRefName 2>&1 || true)

PR_STATE=""
case "$GH_OUT" in
  *'"state":"open"'*)        PR_STATE=open ;;
  *'"state":"closed"'*)      PR_STATE=closed ;;
  *"No pull request found"*) PR_STATE=none ;;   # legitimate miss → block below
  *) exit 0 ;;                                  # auth/network/unreadable → fail open
esac
[ "$PR_STATE" != "open" ] || exit 0  # an open PR is proof the turn shipped

DEAD_PR=""
PR_BASE=""
if [ "$PR_STATE" = "closed" ]; then
  case "$GH_OUT" in
    *'"merged":true'*) DEAD_PR=merged ;;
    *) DEAD_PR=closed ;;
  esac

  # Compare against the PR's OWN base, which need not be the base resolved
  # above (a release PR targets `stable`). A ref name outside the ordinary
  # alphabet is not something we hand to git — fall back to the local base.
  PR_BASE=$(printf '%s' "$GH_OUT" | sed -n 's/.*"baseRefName":"\([^"]*\)".*/\1/p')
  case "$PR_BASE" in
    ""|*[!A-Za-z0-9._/-]*) PR_BASE="$BASE_LOCAL" ;;
  esac

  # The containment check reads `origin/<base>`, and that ref only moves when
  # this clone fetches — the documented precondition of `mergedBaseProgress`.
  # Against a STALE ref the check is trivially satisfied (the merge-base of a
  # branch and its own fork point IS that fork point), so an un-rebased branch
  # reads as "progressed" and the hook nags about work that already shipped.
  #
  # So a fetch that fails or times out is NOT something to shrug off and decide
  # around: it leaves us with a ref we know we cannot trust, and every other
  # unknown in this hook exits 0. Time-boxed because a Stop hook must never
  # hang the turn — and a timeout is just another way of not knowing.
  FETCH_SPEC="+refs/heads/$PR_BASE:refs/remotes/origin/$PR_BASE"
  FETCHED=no
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 git fetch --quiet origin "$FETCH_SPEC" >/dev/null 2>&1 && FETCHED=yes || true
  else
    git fetch --quiet origin "$FETCH_SPEC" >/dev/null 2>&1 && FETCHED=yes || true
  fi
  [ "$FETCHED" = yes ] || exit 0  # can't freshen origin/<base> → fail open

  # A successful fetch of that refspec created the ref, so an empty read here is
  # a git-level surprise rather than a reachable state — treat it as one more
  # thing we don't know.
  BASE_TIP=$(git rev-parse --verify --quiet "refs/remotes/origin/$PR_BASE" 2>/dev/null || echo "")
  [ -n "$BASE_TIP" ] || exit 0
  MERGE_BASE=$(git merge-base "$BASE_TIP" HEAD 2>/dev/null || echo "")
  [ "$MERGE_BASE" = "$BASE_TIP" ] || exit 0  # base-not-contained → fail open
  # Two-dot: what HEAD's tree changes relative to the base tip it now contains.
  if git diff --quiet "$BASE_TIP..HEAD" 2>/dev/null; then
    exit 0  # no-new-work → fail open
  fi
fi

# Block the stop. stderr is fed back to the model as a system message,
# which forces it to continue the turn — so the next thing it does is
# call `gh pr create`. The `stop_hook_active` guard above prevents loops.
if [ -n "$DEAD_PR" ]; then
  cat >&2 <<EOF
The last PR on this branch is $DEAD_PR, and a $DEAD_PR PR cannot take new commits — so
the work now on this branch is NOT shipped. The branch does contain the current tip of
origin/$PR_BASE and carries new commits on top, so a fresh PR can be opened for it.
EOF
else
  echo "You changed files on this branch but no PR exists yet." >&2
fi
cat >&2 <<'EOF'
Before stopping, open one:

  gh pr create -t "<short descriptive title>" -b "<markdown body>"

Body should have:
  ## Summary    — 1-2 sentences on why this change exists
  ## Changes    — bullet list of the key edits
  ## Test plan  — how to verify it works

Run `gh pr create` now, then finish the turn.
EOF
exit 2
