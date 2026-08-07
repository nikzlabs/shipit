---
name: docs-navigator
description: "Feature docs index, navigation, and authoring: find how a feature was implemented, check what's planned/in-progress, and get the docs/NNN-* folder layout, frontmatter schema (issue/title/description), issue-pointer syntax, and committed-prototype conventions. Load when reading or writing any docs/ feature doc. Not needed for pure architecture questions (use the architecture skills instead)."
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

## Writing docs: folder layout

```
docs/
  NNN-feature-name/
    requirements.md — What the feature must do, in the human's terms (required for new features)
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work items or tracking notes
    mockup.html    — Optional UI prototype committed as reference (or mockup.svg / mocks/)
```

Features are numbered by creation order. Create `docs/NNN-new-feature/` for a new one.

**`docs/NNN-feature/` is this repo's convention, not the docs list's filter.** The scan (`markdown.ts` → `findMarkdownFiles`) walks the whole workspace and surfaces **every** `.md` file — `README.md`, `RELEASING.md`, `src/server/shipit-docs/*.md`, anything nested. The `NNN-` prefix and the presence of `plan.md` / `checklist.md` / an `issue:` pointer only decide Tracked-vs-Other grouping and newest-first ordering. So treat any markdown you write as user-visible; don't leave scratch notes in `.md`.

A 100%-complete `checklist.md` folds its doc into the collapsed **Done** group; otherwise it shows under **Active**.

## Frontmatter

All three fields are optional; a doc with no frontmatter still appears in the list.

```yaml
---
issue: planning#306
title: Optional display title
description: One sentence, rendered under the title. No multi-line YAML scalars.
---
```

`issue:` resolves against the trackers declared in `shipit.yaml`. **Write the name form** (`roadmap#SHI-304`, `planning#42`) — it survives a declaration being re-pointed at another repo or team, and it's the form ShipIt itself emits. A backend address also resolves as long as it identifies a declared tracker: a full Linear URL **without** the title slug (a bare `TRACKER-28` is rejected), `owner/repo#123`, or a GitHub issue URL.

A doc carries **exactly one** `issue:` self-pointer. Committed docs may name sibling issue IDs inline as stable identifiers ("blocked on planning#81") but must not record their priority or status — that drifts, and lives in the tracker.

## Committed prototypes

When a doc describes UI whose layout is load-bearing (filters, tables, breakpoints), commit the prototype beside `plan.md` — `mockup.html`, `mockup.svg`, or a `mocks/` subdir — as a self-contained static artifact: inline CSS/SVG, no build step, diffable. A `.png` is a supplement, not the source of truth. Link it from `plan.md`. The `present` tool's tab is ephemeral; committed mocks are reviewable in PRs.
