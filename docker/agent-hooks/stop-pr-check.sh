#!/bin/sh
# Block a stop when new branch work can and must enter a PR.

set -eu

# Consume stdin and avoid repeated hook blocks.
PAYLOAD=$(cat || true)
case "$PAYLOAD" in
  *'"stop_hook_active"'*'true'*) exit 0 ;;
esac

[ "${SHIPIT_AUTO_CREATE_PR:-}" = "1" ] || exit 0

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Fail open during git operations because a PR cannot be created then.
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

# Resolve the base branch, or fail open.
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

COMMITS_AHEAD=$(git rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
[ "$COMMITS_AHEAD" -gt 0 ] 2>/dev/null || exit 0

# The default branch has no PR target.
HEAD_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
BASE_LOCAL=${BASE#origin/}
[ -n "$HEAD_BRANCH" ] || exit 0
[ "$HEAD_BRANCH" != "$BASE_LOCAL" ] || exit 0

# Commits can cancel out and leave no net change.
if git diff --quiet "$BASE...HEAD" 2>/dev/null; then
  exit 0
fi

# A closed PR needs a fresh, contained base before replacement is possible.
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

  # Release PRs can use a different base.
  PR_BASE=$(printf '%s' "$GH_OUT" | sed -n 's/.*"baseRefName":"\([^"]*\)".*/\1/p')
  case "$PR_BASE" in
    ""|*[!A-Za-z0-9._/-]*) PR_BASE="$BASE_LOCAL" ;;
  esac

  # A stale base ref can give a false positive. Time-box its refresh.
  FETCH_SPEC="+refs/heads/$PR_BASE:refs/remotes/origin/$PR_BASE"
  FETCHED=no
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 git fetch --quiet origin "$FETCH_SPEC" >/dev/null 2>&1 && FETCHED=yes || true
  else
    git fetch --quiet origin "$FETCH_SPEC" >/dev/null 2>&1 && FETCHED=yes || true
  fi
  [ "$FETCHED" = yes ] || exit 0  # can't freshen origin/<base> → fail open

  BASE_TIP=$(git rev-parse --verify --quiet "refs/remotes/origin/$PR_BASE" 2>/dev/null || echo "")
  [ -n "$BASE_TIP" ] || exit 0
  MERGE_BASE=$(git merge-base "$BASE_TIP" HEAD 2>/dev/null || echo "")
  [ "$MERGE_BASE" = "$BASE_TIP" ] || exit 0  # base-not-contained → fail open
  if git diff --quiet "$BASE_TIP..HEAD" 2>/dev/null; then
    exit 0  # no-new-work → fail open
  fi
fi

# Stderr becomes the system message for the resumed turn.
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
