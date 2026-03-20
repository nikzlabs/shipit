# Design Docs

ShipIt has a built-in feature tracking system that reads markdown files from the `docs/` directory in your workspace. The UI displays these as a feature list with status badges, and users can kick off sessions to work on them.

## Creating a design doc

Design docs live in numbered directories under `docs/`:

```
docs/
  NNN-feature-name/
    plan.md          # Required — feature design and description
    checklist.md     # Optional — remaining work items
```

Pick the next available number for `NNN` (e.g., if the highest existing doc is `042-...`, use `043-...`).

## Required frontmatter

Every `plan.md` **must** start with YAML frontmatter containing a `status` field. Without this, the feature won't appear correctly in the ShipIt UI.

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

### Optional frontmatter fields

You can also include a `title` field to override the auto-generated title:

```yaml
---
status: in-progress
title: Custom Feature Title
---
```

If no `title` is provided, ShipIt derives one from the directory name (e.g., `042-user-auth` becomes "User Auth").

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
- **Wrong status value**: Must be exactly one of `planned`, `in-progress`, `done`, or `paused` (lowercase).
- **Frontmatter not at file start**: The `---` block must be the very first thing in the file — no blank lines or content before it.
- **Missing plan.md**: The feature directory must contain a file named `plan.md`. Other filenames won't be picked up by the feature system.
