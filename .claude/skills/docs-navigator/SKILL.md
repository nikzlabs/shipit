---
description: "Feature docs index and navigation. Load when you need to understand how a specific feature was implemented, find related feature docs for a task, or check what's planned/in-progress. Not needed for pure architecture questions (use the architecture skills instead)."
user-invocable: true
---

# Feature Docs Navigator

ShipIt has feature docs in `docs/NNN-feature-name/plan.md`. Each describes how a feature was designed and implemented. Most tasks don't need these — the architecture skills cover cross-cutting patterns. Load a feature doc only when you need implementation details for a specific feature.

## How to use

1. Run the index script to get the current list of docs with their status and title:
   ```bash
   bash .claude/skills/docs-navigator/index.sh
   ```
2. Find the relevant doc(s) from the output
3. Read its `plan.md` for design details
4. Check `checklist.md` if it exists — it tracks remaining work

## Status key

- **done** — implemented and shipped
- **in-progress** — actively being worked on
- **planned** — designed but not yet started
- **paused** — designed but not currently scheduled

## Filtering

The index script accepts an optional filter argument to narrow results:

```bash
# Show only planned/in-progress docs
bash .claude/skills/docs-navigator/index.sh active

# Show only docs matching a keyword
bash .claude/skills/docs-navigator/index.sh git
bash .claude/skills/docs-navigator/index.sh deploy
```
