#!/usr/bin/env bash
# Reset the demo repo before a take — docs/296 plan §6: close every open PR,
# delete every non-default branch, force-reset the default branch to the pin.
#
# Usage:
#   reset-demo-repo.sh --scenario <dir> [--instance <url>] [--dry-run]
#   reset-demo-repo.sh --repo OWNER/NAME --pin <sha> [--instance <url>] [--dry-run]
#
# `--scenario` reads `repo.url` and `repo.commit` from its storyboard.json.
#
# What runs where. PRs are closed THROUGH THE DEMO INSTANCE when `--instance`
# is given: any session with a checkout on the instance can target the repo
# over `GET /api/sessions/:id/pr/list?repo=OWNER/NAME` and
# `POST /api/sessions/:id/pr/:n/close` (body `{ repo }`), so the instance's own
# GitHub credential does the work and no token leaves it. The instance has no
# route that deletes a branch or moves `main` (archiving a session deletes
# nothing remote; only a merge detected by the PR poller deletes that session's
# branch), so those two steps — and PR closing when there is no instance or no
# session on the repo — go to the GitHub REST API with `GITHUB_TOKEN` from the
# environment. Reads are unauthenticated when the token is unset (the demo repo
# is public), so the script can always say what it would change.
#
# `--dry-run` performs the reads and prints every write instead of sending it.
# `GITHUB_API_URL` overrides https://api.github.com (the tests point it at a
# fake). Needs curl and node.
set -euo pipefail

SCENARIO=""
REPO=""
PIN=""
INSTANCE=""
DRY_RUN=0
GITHUB_API="${GITHUB_API_URL:-https://api.github.com}"

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --pin) PIN="$2"; shift 2 ;;
    --instance) INSTANCE="${2%/}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "reset-demo-repo: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { echo "[reset-demo-repo] $*" >&2; }
die() { log "$*"; exit 1; }

# `json 'expr'` — evaluate a node expression over stdin's JSON as `d`, printing its result.
json() {
  node -e 'const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "null"); const r = (() => { return eval(process.argv[1]); })(); if (r !== undefined) process.stdout.write(String(r) + "\n");' "$1"
}

if [ -n "$SCENARIO" ]; then
  [ -f "$SCENARIO/storyboard.json" ] || die "no storyboard.json in $SCENARIO"
  REPO="$(json 'd.repo.url' < "$SCENARIO/storyboard.json")"
  PIN="$(json 'd.repo.commit' < "$SCENARIO/storyboard.json")"
fi
[ -n "$REPO" ] && [ -n "$PIN" ] || die "need --scenario <dir>, or --repo OWNER/NAME and --pin <sha>"
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "pin must be a full 40-hex SHA, got $PIN"

# OWNER/NAME from any of the forms the instance's `repo` override accepts.
if [[ "$REPO" =~ ^(https?://)?(github\.com/)?([^/[:space:]]+)/([^/[:space:]]+)/?$ ]]; then
  OWNER="${BASH_REMATCH[3]}"
  NAME="${BASH_REMATCH[4]%.git}"
else
  die "repo must be OWNER/NAME or a github.com URL, got $REPO"
fi
SLUG="$OWNER/$NAME"
export RESET_SLUG="$SLUG"

# ── HTTP ─────────────────────────────────────────────────────────────────────

# gh_read PATH — unauthenticated is fine on a public repo; the token is sent when set.
gh_read() {
  local -a auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsS -H "Accept: application/vnd.github+json" "${auth[@]}" "$GITHUB_API$1"
}

# gh_write METHOD PATH [BODY] — printed under --dry-run, otherwise sent with the token.
gh_write() {
  local method="$1" path="$2" body="${3:-}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would: $method $GITHUB_API$path${body:+ $body}"
    return 0
  fi
  [ -n "${GITHUB_TOKEN:-}" ] || die "$method $path needs GITHUB_TOKEN in the environment"
  local -a data=()
  [ -n "$body" ] && data=(-d "$body")
  curl -fsS -X "$method" -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Content-Type: application/json" "${data[@]}" "$GITHUB_API$path" > /dev/null
}

inst_read() { curl -fsS "$INSTANCE$1"; }

inst_write() {
  local method="$1" path="$2" body="${3:-}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would: $method $INSTANCE$path${body:+ $body}"
    return 0
  fi
  local -a data=()
  [ -n "$body" ] && data=(-d "$body")
  curl -fsS -X "$method" -H "Content-Type: application/json" "${data[@]}" "$INSTANCE$path" > /dev/null
}

# ── The instance's session on the repo (for the PR step) ─────────────────────

SESSION=""
if [ -n "$INSTANCE" ]; then
  if ! inst_read /api/bootstrap > /dev/null 2>&1; then
    die "instance $INSTANCE is not answering GET /api/bootstrap"
  fi
  SESSION="$(inst_read /api/repos | json '
    const norm = (u) => String(u ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
    const want = norm("https://github.com/" + process.env.RESET_SLUG);
    const r = (d.repos ?? []).find((x) => norm(x.url) === want);
    r?.warmSessionId ?? ""' 2>/dev/null || true)"
  if [ -z "$SESSION" ]; then
    SESSION="$(inst_read /api/sessions/all | json '
      const norm = (u) => String(u ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
      const want = norm("https://github.com/" + process.env.RESET_SLUG);
      const s = (d.sessions ?? []).find((x) => norm(x.remoteUrl) === want && x.workspaceDir);
      s?.id ?? ""' 2>/dev/null || true)"
  fi
  if [ -n "$SESSION" ]; then
    log "closing PRs through the instance (session $SESSION on $SLUG)"
  else
    log "instance has no session with a checkout on $SLUG — PRs will be closed with GITHUB_TOKEN instead"
  fi
fi

# ── Inventory ────────────────────────────────────────────────────────────────

DEFAULT_BRANCH="$(gh_read "/repos/$SLUG" | json 'd.default_branch')"
[ -n "$DEFAULT_BRANCH" ] || die "could not read the default branch of $SLUG"
export RESET_DEFAULT="$DEFAULT_BRANCH"

gh_read "/repos/$SLUG/git/commits/$PIN" > /dev/null || die "pin $PIN is not a commit in $SLUG"
HEAD_SHA="$(gh_read "/repos/$SLUG/git/ref/heads/$DEFAULT_BRANCH" | json 'd.object.sha')"

if [ -n "$SESSION" ]; then
  OPEN_PRS="$(inst_read "/api/sessions/$SESSION/pr/list?state=open&limit=100&repo=$SLUG" | json '(d.prs ?? []).map((p) => p.number).join("\n")')"
else
  OPEN_PRS="$(gh_read "/repos/$SLUG/pulls?state=open&per_page=100" | json 'd.map((p) => p.number).join("\n")')"
fi
BRANCHES="$(gh_read "/repos/$SLUG/branches?per_page=100" | json 'd.map((b) => b.name).filter((n) => n !== process.env.RESET_DEFAULT).join("\n")')"

log "$SLUG: default $DEFAULT_BRANCH at ${HEAD_SHA:-?}, pin $PIN; open PRs: ${OPEN_PRS:-none}; other branches: ${BRANCHES:-none}"

# ── Writes, in order: PRs first so a branch delete never closes one as a side effect ──

for n in $OPEN_PRS; do
  if [ -n "$SESSION" ]; then
    inst_write POST "/api/sessions/$SESSION/pr/$n/close" "{\"repo\":\"$SLUG\"}"
  else
    gh_write PATCH "/repos/$SLUG/pulls/$n" '{"state":"closed"}'
  fi
  log "closed PR #$n"
done

for b in $BRANCHES; do
  gh_write DELETE "/repos/$SLUG/git/refs/heads/$b"
  log "deleted branch $b"
done

if [ "$HEAD_SHA" = "$PIN" ]; then
  log "$DEFAULT_BRANCH already at the pin"
else
  gh_write PATCH "/repos/$SLUG/git/refs/heads/$DEFAULT_BRANCH" "{\"sha\":\"$PIN\",\"force\":true}"
  log "reset $DEFAULT_BRANCH ${HEAD_SHA:-?} → $PIN"
fi

log "done${DRY_RUN:+ (dry run)}"
