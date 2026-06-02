# Design Docs

ShipIt has a built-in feature tracking system that reads markdown files from the `docs/` directory in your workspace. The UI displays these as a list of reference docs, and users can kick off sessions to work on them.

Design docs are **reference material** — what a feature is, why, and how. Priority and work-status no longer live in the doc; they live in the issue tracker (Linear / GitHub Issues). A doc carries an optional `issue:` pointer to the work item that tracks it, and ShipIt renders a jump-to-issue chip from that pointer.

## How it works

ShipIt scans the entire workspace recursively for `.md` files (skipping `node_modules` and `.git`). Every markdown file found is shown in the list. The docs list is grouped structurally:

- **Tracked** — feature-directory `plan.md`/`checklist.md` files, docs with an `issue:` pointer, and docs that have a `checklist.md` sibling.
- **Other** — incidental markdown (a stray `README.md`, `notes.md`, etc.).

Within Tracked, docs are grouped by **checklist state**: a doc whose sibling `checklist.md` is 100% complete folds into a collapsed **Done** group; everything else (incomplete checklist, or no checklist at all) stays in the **Active** list.

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

Frontmatter is optional. A doc with no frontmatter still appears in the list. The recognized fields are `issue`, `title`, and `description`.

```markdown
---
issue: https://linear.app/your-workspace/issue/SHI-28/decouple-priorities
description: One-line summary of the feature.
---

# Feature Name

Description of the feature...
```

> **There is no `status:` or `priority:` field.** Those were removed — work-state and priority live in the issue tracker now, not in the doc. A leftover `status:`/`priority:` line is simply ignored by the scanner, but you should drop it and add an `issue:` pointer instead.

### The `issue:` pointer

`issue:` points at the work item that tracks this doc. The tracker is inferred from the pointer's shape — there is no separate `tracker:` field.

| Tracker | Accepted form | Example |
|---------|---------------|---------|
| Linear | **Full URL only** | `https://linear.app/your-workspace/issue/SHI-28/slug` |
| GitHub | `owner/repo#N` or a full issue URL | `octocat/hello-world#42` |

A Linear pointer **must** be a full URL — a bare `SHI-28` is not accepted, so the pointer stays unambiguous if a deployment wires up more than one Linear workspace. A doc with **no** `issue:` is pure reference: it still shows up, just without a jump-to-issue chip.

### `title` and `description`

- `title` overrides the auto-generated title. If omitted, ShipIt derives one from the path. For files with generic names like `plan.md`, it uses the parent directory name (e.g. `042-user-auth/plan.md` becomes "User Auth"); otherwise it uses the filename (`my-feature.md` becomes "My Feature").
- `description` is a single-line summary rendered under the title in the docs list.

```yaml
---
issue: octocat/hello-world#42
title: Custom Feature Title
description: A short summary of what this feature is about.
---
```

## Recommended plan.md structure

```markdown
---
issue: https://linear.app/your-workspace/issue/SHI-28/slug
description: One-line summary.
---

# NNN — Feature Name

## Overview

Brief description of what this feature does and why.

## Design

How the feature works — architecture, data flow, key decisions.

## Key files

- `src/path/to/main-file.ts` — what it does
- `src/path/to/other-file.ts` — what it does
```

## Checklist

Track remaining work in a **separate `checklist.md` file** sitting next to
`plan.md`, not as a `## Checklist` section inside `plan.md` itself. The checklist
is the docs list's grouping signal: when every item is checked, the doc folds
into the collapsed **Done** group.

```
docs/
  NNN-feature-name/
    plan.md
    checklist.md
```

```markdown
# Checklist

- [ ] First task
- [ ] Second task
- [x] Completed task
```

When the work is finished, mark every item in `checklist.md` as complete (`[x]`).

## Common mistakes

- **Using `status:` or `priority:`**: These fields were removed. Track work-state and priority in the issue tracker and link to it with `issue:`. A stray `status:`/`priority:` line is ignored, not honored.
- **Bare Linear ID in `issue:`**: Linear pointers must be full URLs (`https://linear.app/.../issue/SHI-28/...`), not bare identifiers like `SHI-28`.
- **Missing frontmatter delimiters**: The `---` lines are required. Don't use a ` ```yaml ` fence.
- **Frontmatter not at file start**: The `---` block must be the very first thing in the file — no blank lines or content before it.
- **Not a `.md` file**: Only files ending in `.md` are scanned. Other formats (`.txt`, `.rst`) won't appear in the list.
- **Checklist embedded in `plan.md`**: Put remaining work in a sibling `checklist.md` file, not as a section inside `plan.md`.
