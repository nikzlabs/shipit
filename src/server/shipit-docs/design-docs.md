# Design Docs

ShipIt has a built-in feature tracking system that reads markdown files from the `docs/` directory in your workspace. The UI displays these as a feature list with status badges, and users can kick off sessions to work on them.

## How it works

ShipIt scans the entire workspace recursively for `.md` files (skipping `node_modules` and `.git`). Every markdown file found is shown in the feature list. If a file has YAML frontmatter with a `status` field, ShipIt displays a status badge next to it.

## Creating a design doc

Any `.md` file in the workspace will be picked up. The conventional structure is numbered directories under `docs/`:

```
docs/
  NNN-feature-name/
    plan.md          # Feature design and description
    checklist.md     # Optional — remaining work items
```

But simpler layouts work too — `docs/my-feature.md` is equally valid.

## Frontmatter

Every design doc **should** start with YAML frontmatter containing a `status` field. Without this, the feature still appears in the UI but has no status badge.

```markdown
---
status: planned
---

# Feature Name

Description of the feature...
```

### Valid status values

| Status | Meaning |
|--------|---------|
| `planned` | Documented but work hasn't started |
| `in-progress` | Currently being worked on |
| `done` | Feature is complete |
| `paused` | Has a design but not actively planned |

#### Custom statuses

Any other value (e.g. `status: experimental`, `status: blocked`) is preserved
verbatim and rendered as a neutral badge. The doc is still considered
**tracked** — it shows up in the Tracked tab and suppresses untracked siblings
the same way a known status does. Custom-status docs sort between `paused`
and `done`. The four values in the table above are the only ones with typed
semantics in the UI; everything else is rendered as-is.

### Optional frontmatter fields

You can also include a `title` field to override the auto-generated title:

```yaml
---
status: in-progress
title: Custom Feature Title
---
```

If no `title` is provided, ShipIt derives one from the path. For files with generic names like `plan.md`, it uses the parent directory name (e.g., `042-user-auth/plan.md` becomes "User Auth"). Otherwise it uses the filename (e.g., `my-feature.md` becomes "My Feature").

**Priority hint for planned features:** add a `priority` field — `high`, `medium`, or `low` — to indicate which planned doc should be picked up next. It's only honored when `status: planned` and is ignored on any other status. The docs viewer groups planned items by priority bucket (high first, then medium, low, then unset), and within each bucket the most recently added doc (highest `NNN-` prefix) sorts first.

```yaml
---
status: planned
priority: high
---
```

## Updating status

Update the `status` field as work progresses:

1. Set `planned` when first creating the doc
2. Change to `in-progress` when work begins
3. Set `done` when the feature is complete

When a feature is done, also mark all checklist items in `checklist.md` as complete (`[x]`).

## Recommended plan.md structure

```markdown
---
status: planned
---

# NNN — Feature Name

## Overview

Brief description of what this feature does and why.

## Design

How the feature works — architecture, data flow, key decisions.

## Key files

- `src/path/to/main-file.ts` — what it does
- `src/path/to/other-file.ts` — what it does

## Checklist

- [ ] First task
- [ ] Second task
```

## Common mistakes

- **Missing frontmatter delimiters**: The `---` lines are required. Don't use ````yaml` fences.
- **Wrong status value**: Stick to `planned`, `in-progress`, `done`, or `paused` (lowercase) to get the typed UI bucketing — priority sorting, the Done collapse, and the success-coloured badge are all keyed on these four. A custom value works (the doc stays tracked, and the raw string renders as a neutral badge), but you forfeit those affordances.
- **Frontmatter not at file start**: The `---` block must be the very first thing in the file — no blank lines or content before it.
- **Not a `.md` file**: Only files ending in `.md` are scanned. Other formats (`.txt`, `.rst`) won't appear in the feature list.
