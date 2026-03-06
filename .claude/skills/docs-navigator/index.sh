#!/usr/bin/env bash
# Lists all feature docs with status and title.
# Usage:
#   bash .claude/skills/docs-navigator/index.sh          # all docs
#   bash .claude/skills/docs-navigator/index.sh active    # planned + in-progress only
#   bash .claude/skills/docs-navigator/index.sh <keyword> # filter by keyword in name or title

set -euo pipefail

DOCS_DIR="$(git rev-parse --show-toplevel)/docs"
FILTER="${1:-}"

for dir in "$DOCS_DIR"/*/; do
  plan="$dir/plan.md"
  [ -f "$plan" ] || continue

  name=$(basename "$dir")

  # Extract status from YAML frontmatter
  status=$(awk '/^---$/{c++; next} c==1 && /^status:/{print $2; exit}' "$plan")
  status="${status:-unknown}"

  # Extract first markdown heading after frontmatter
  title=$(awk '/^---$/{c++; next} c>=2 && /^#/{sub(/^#+ */, ""); print; exit}' "$plan")
  title="${title:-<no title>}"

  # Check for checklist
  checklist=""
  [ -f "$dir/checklist.md" ] && checklist=" [has checklist]"

  line="$name ($status)$checklist — $title"

  # Apply filter
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
