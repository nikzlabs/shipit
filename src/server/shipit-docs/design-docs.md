# Design Docs

ShipIt has a built-in feature tracking system that reads markdown files from the `docs/` directory in your workspace. The UI displays these as a list of reference docs, and users can kick off sessions to work on them.

Design docs are **reference material** — what a feature is, why, and how. Work tracking lives in the issue tracker (Linear / GitHub Issues): a doc carries an optional `issue:` pointer to the work item that tracks it, and ShipIt renders a jump-to-issue chip from that pointer.

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
    mockup.html      # Optional — committed UI prototype (or mockup.svg, or a mocks/ subdir)
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

## Committing UI prototypes

When a design doc describes UI whose layout is load-bearing — filters, tables, responsive breakpoints — prose plus ASCII sketches isn't enough; reviewers want to see it. Commit the prototype into the feature folder as a sibling of `plan.md`:

```
docs/
  NNN-feature-name/
    plan.md
    mockup.html      # single self-contained file
    # or mockup.svg, or a mocks/ subdir if there are several
```

- **Prefer self-contained, static artifacts** — one HTML file with inline CSS, or an SVG — so the mock opens with no build step and stays diffable in PRs. A `.png` screenshot is an acceptable supplement, but it isn't diffable, so keep the HTML/SVG as the source of truth.
- **Link the mock from `plan.md`** with a short "Visual reference" note so a reader of the design lands on the picture.
- **Keep the asset inside the `docs/NNN-*` folder** so it travels with the doc — it's reference material, same as `plan.md`.

The `present` tool renders a mock in an ephemeral Present tab, but that artifact never touches the repo, so the prototype vanishes and only the prose survives. A committed mock is reviewable in PRs, renders in the file tree, and survives across sessions.

## Common mistakes

- **Bare Linear ID in `issue:`**: Linear pointers must be full URLs (`https://linear.app/.../issue/SHI-28/...`), not bare identifiers like `SHI-28`.
- **Missing frontmatter delimiters**: The `---` lines are required. Don't use a ` ```yaml ` fence.
- **Frontmatter not at file start**: The `---` block must be the very first thing in the file — no blank lines or content before it.
- **Not a `.md` file**: Only files ending in `.md` are scanned. Other formats (`.txt`, `.rst`) won't appear in the list.
- **Checklist embedded in `plan.md`**: Put remaining work in a sibling `checklist.md` file, not as a section inside `plan.md`.
- **Leaving a UI prototype only in the Present tab**: That artifact is ephemeral and never reaches the repo. Commit a static `mockup.html`/`mockup.svg` into the feature folder and link it from `plan.md`.
