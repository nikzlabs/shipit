#!/usr/bin/env bash
# Usage: index.sh [active|keyword]

set -euo pipefail

DOCS_DIR="$(git rev-parse --show-toplevel)/docs"
FILTER="${1:-}"

for dir in "$DOCS_DIR"/*/; do
  plan="$dir/plan.md"
  [ -f "$plan" ] || continue

  name=$(basename "$dir")

  status=$(awk '/^---$/{c++; next} c==1 && /^status:/{print $2; exit}' "$plan")
  status="${status:-unknown}"

  title=$(awk '/^---$/{c++; next} c>=2 && /^#/{sub(/^#+ */, ""); print; exit}' "$plan")
  title="${title:-<no title>}"

  checklist=""
  [ -f "$dir/checklist.md" ] && checklist=" [has checklist]"

  line="$name ($status)$checklist — $title"

  if [ -n "$FILTER" ]; then
    if [ "$FILTER" = "active" ]; then
      case "$status" in
        planned|in-progress) ;;
        *) continue ;;
      esac
    else
      echo "$line" | grep -qi "$FILTER" || continue
    fi
  fi

  echo "$line"
done
