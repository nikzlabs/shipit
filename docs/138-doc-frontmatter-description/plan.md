---
status: done
description: Show a short doc description from frontmatter under the title in the docs panel.
---

# 138 — Doc frontmatter description

## Summary

Feature docs (`docs/NNN-feature/plan.md`) carry YAML frontmatter with `status`,
`priority`, and `title`. A title alone often isn't enough to tell what a doc is
about without opening it. This adds an optional single-line `description` field
to the frontmatter and renders it under the title in the Docs panel.

```yaml
---
status: in-progress
description: Show a short doc description from frontmatter under the title in the docs panel.
---
```

## What changed

- **Parser (`src/server/orchestrator/markdown.ts`)** — `parseFrontmatterFields`
  now reads a `description:` line the same way it reads `title:` (single-line,
  trimmed; empty values are ignored). It's plumbed through `readMarkdownEntry`
  onto `DocEntry`. The non-checklist sniff buffer was bumped from 512 → 1024
  bytes so the larger frontmatter block still fits in a single read.
- **Type (`src/server/shared/types/domain-types.ts`)** — added optional
  `description?: string` to `DocEntry`.
- **UI (`src/client/components/DocsViewer.tsx`)** — extracted a shared
  `DocRowText` helper (title → description → path context) used by the
  Modified / Tracked / Archived row groups. The description renders as a muted
  secondary line with `line-clamp-2`, sitting between the title and the
  path-context line. Rows without a description are unchanged.

## Design notes

- **Single-line only.** Like `title`, the value is parsed with a `^…$` line
  regex — no multi-line YAML block scalars. Keeps the parser regex-simple and
  the UI row predictable (max two wrapped lines).
- **Placement: above path context.** The description is the most informative
  per-row text, so it sits directly under the title; the parent-directory path
  context stays as the smallest, last line.
- **"Other Docs" rows are unchanged** — untracked docs render just their path,
  so there's no description line there.

## Key files

- `src/server/orchestrator/markdown.ts` — frontmatter parsing
- `src/server/orchestrator/markdown.test.ts` — `description frontmatter` tests
- `src/server/shared/types/domain-types.ts` — `DocEntry.description`
- `src/client/components/DocsViewer.tsx` — `DocRowText` rendering
- `src/client/components/DocsViewer.test.tsx` — description rendering tests
