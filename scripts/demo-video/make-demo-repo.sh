#!/usr/bin/env bash
# Build the phase-1 demo repository as a local bare repo — docs/296 plan §8.
#
# Phase 1 (req 13) runs against the dogfood inner instance, which shares this
# checkout's /workspace with the agent container and nothing else, so the demo
# repo lives under the gitignored `.inner-shipit/` and is added to the inner
# instance by `file://` URL. Phase 2 replaces this with the `shipit-demo-app`
# GitHub repo (plan §1); the contents here are the same shape, minus Vite.
#
# The commit is deterministic: fixed author, fixed dates, no clock. Re-running
# this script yields the same SHA, which is what lets `storyboard.json` pin it.
#
# Usage:
#   make-demo-repo.sh <bare-dir> [proxy-url]
#
#   bare-dir    where the bare repo is written (recreated from scratch);
#               must be under /workspace to be visible from the `dev` container
#   proxy-url   when given, `.claude/settings.json` redirects the Claude CLI to
#               the record/replay proxy (plan §2). Omit it for a live take that
#               uses the inner instance's own credential — no proxy in the loop.
#
# Prints the commit SHA on stdout.
set -euo pipefail

BARE_DIR="${1:?usage: make-demo-repo.sh <bare-dir> [proxy-url]}"
PROXY_URL="${2:-}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo app</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Demo app</h1>
      <p>A blank page. Ask the agent to build something here.</p>
    </main>
    <script src="app.js"></script>
  </body>
</html>
HTML

cat > "$WORK/style.css" <<'CSS'
:root { font-family: system-ui, sans-serif; color: #1a1a1a; background: #fafafa; }
main { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
CSS

cat > "$WORK/app.js" <<'JS'
// Entry point. The agent adds behaviour here.
JS

cat > "$WORK/README.md" <<'MD'
# Demo app

A minimal static page with no build step: open `index.html` in a browser.
MD

if [ -n "$PROXY_URL" ]; then
  mkdir -p "$WORK/.claude"
  # Plan §2: the dummy key is part of the measured redirect — it keeps the real
  # credential out of the repo and the session; the proxy swaps it on the way out.
  cat > "$WORK/.claude/settings.json" <<JSON
{ "env": { "ANTHROPIC_BASE_URL": "${PROXY_URL}", "ANTHROPIC_API_KEY": "sk-ant-demo" } }
JSON
fi

export GIT_AUTHOR_NAME="ShipIt demo" GIT_AUTHOR_EMAIL="demo@shipit.invalid"
export GIT_COMMITTER_NAME="ShipIt demo" GIT_COMMITTER_EMAIL="demo@shipit.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

git -C "$WORK" init -q -b main
git -C "$WORK" add -A
git -C "$WORK" commit -q -m "Demo app scaffold"

rm -rf "$BARE_DIR"
mkdir -p "$(dirname "$BARE_DIR")"
git clone -q --bare "$WORK" "$BARE_DIR"
# A bare clone of a work tree has no HEAD symref problem, but make the default
# branch explicit so `git clone --bare <file-url>` on the inner side reads it.
git -C "$BARE_DIR" symbolic-ref HEAD refs/heads/main

git -C "$BARE_DIR" rev-parse HEAD
