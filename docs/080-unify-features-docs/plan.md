---
status: done
---

# Unify Features and Docs

## Problem

Features and docs are two separate systems that operate on the same files. A feature is just a markdown file in `docs/NNN-*/plan.md` with YAML frontmatter — it's a doc with metadata, not a distinct entity. The current split creates:

1. **Redundant discovery** — `FeatureManager` and `findMarkdownFiles()` both scan `docs/`, finding the same files
2. **Redundant UI** — two right-panel tabs ("Docs" and "Features") showing overlapping content
3. **Redundant API** — `GET /api/sessions/:id/features` and `GET /api/sessions/:id/docs` are separate endpoints
4. **Artificial distinction** — the only difference is a `NNN-` prefix and `status:` frontmatter

## Design

Merge both systems into a single "Docs" system. Any markdown file with `status:` frontmatter becomes a "tracked doc" and gets status badges/grouping — no special naming convention required.

### Unified type

Replace `FeatureInfo` with metadata on doc entries:

```typescript
export type DocStatus = "planned" | "in-progress" | "done" | "paused";

export interface DocEntry {
  /** Relative path from workspace root, e.g. "docs/001-websocket-protocol/plan.md" */
  path: string;
  /** Status from YAML frontmatter, if present. Undefined for plain docs. */
  status?: DocStatus;
  /** Human-readable title. Derived from frontmatter `title:` field, or from filename. */
  title: string;
}
```

This replaces `FeatureInfo` (id, number, name, status, planPath, checklistPath). The `number` and `checklistPath` fields are dropped — numbering is implicit in the path, and checklist discovery can happen when viewing the doc.

### Unified API

**Keep**: `GET /api/sessions/:id/docs` — returns `{ docs: DocEntry[] }`

Each entry includes its path and optional status. The response replaces both the old docs list (plain string paths) and the features list.

**Keep**: `GET /api/sessions/:id/docs/*path` — returns `{ path, content }` (unchanged)

**Remove**: `GET /api/sessions/:id/features` — no longer needed.

### Unified server

**Remove** `FeatureManager` class (`features.ts`). Move `parseStatusFromFrontmatter()` to `markdown.ts` as a utility.

**Update** `findMarkdownFiles()` in `markdown.ts` to return `DocEntry[]` instead of `string[]`. For each `.md` file found, read the first ~200 bytes to check for YAML frontmatter with a `status:` field. If present, include it in the entry. Derive `title` from frontmatter `title:` field if present, otherwise from filename (kebab-to-title conversion).

**Update** `listDocs()` in `services/files.ts` to return `DocEntry[]`.

**Remove** `listFeatures()` from `services/misc.ts`.

**Update** route in `api-routes-files.ts` to return `{ docs: DocEntry[] }`.

**Remove** features route from `api-routes-session.ts`.

**Remove** `featureManager` from DI (`app-di.ts`).

### Unified UI

**One tab**: "Docs" replaces both "Docs" and "Features" tabs.

**Merged component**: Replace `DocsViewer` and `FeaturesPanel` with a single `DocsPanel` component that:

- Shows all markdown files in a flat list (like DocsViewer today)
- For entries with `status`, shows a status badge inline (like FeaturesPanel today)
- Optionally groups tracked docs at the top, or provides a filter toggle ("All" / "Tracked")
- Keeps the "Start Session" button in DocModal for tracked docs

**Store changes**:
- Move `features` state from `ui-store` to `file-store` (where `docFiles` already lives), or just enhance `docFiles` to be `DocEntry[]`
- Remove `fetchFeatures()` from `ui-store`
- Update `fetchDocs()` in `file-store` to return `DocEntry[]`

### Migration path

The `NNN-` naming convention is preserved as a project convention (CLAUDE.md documents it), but the system no longer requires it. Any `.md` file with `status:` frontmatter gets tracked. Existing feature docs work unchanged — their frontmatter is still parsed.

## Key files

### Server (modify)
| File | Change |
|------|--------|
| `src/server/orchestrator/markdown.ts` | Return `DocEntry[]`, absorb `parseStatusFromFrontmatter()` |
| `src/server/orchestrator/services/files.ts` | `listDocs()` returns `DocEntry[]` |
| `src/server/orchestrator/api-routes-files.ts` | Return `{ docs: DocEntry[] }` |
| `src/server/shared/types/domain-types.ts` | Add `DocEntry`, `DocStatus`; deprecate/remove `FeatureInfo`, `FeatureStatus` |

### Server (remove)
| File | Change |
|------|--------|
| `src/server/orchestrator/features.ts` | Delete (move `parseStatusFromFrontmatter` to `markdown.ts`) |
| `src/server/orchestrator/services/misc.ts` | Remove `listFeatures()` |
| `src/server/orchestrator/api-routes-session.ts` | Remove `/features` route |
| `src/server/orchestrator/app-di.ts` | Remove `featureManager` |

### Client (modify)
| File | Change |
|------|--------|
| `src/client/components/DocsViewer.tsx` | Evolve into `DocsPanel` — accept `DocEntry[]`, show status badges |
| `src/client/components/DocModal.tsx` | Use `DocEntry` instead of `FeatureInfo` for `isFeature` logic |
| `src/client/stores/file-store.ts` | `docFiles` becomes `DocEntry[]`, update `fetchDocs()` |
| `src/client/App.tsx` | Remove "Features" tab, update Docs tab wiring |

### Client (remove)
| File | Change |
|------|--------|
| `src/client/components/FeaturesPanel.tsx` | Delete (functionality merged into DocsPanel) |
| `src/client/stores/ui-store.ts` | Remove `features` state, `fetchFeatures()` |

### Tests (update)
| File | Change |
|------|--------|
| `src/server/orchestrator/features.test.ts` | Move to `markdown.test.ts`, test `parseStatusFromFrontmatter` there |
| `src/server/orchestrator/integration_tests/features.test.ts` | Merge into `docs.test.ts` |
| `src/client/components/FeaturesPanel.test.tsx` | Rewrite as `DocsPanel.test.tsx` |
| `src/server/orchestrator/integration_tests/http-reads.test.ts` | Update features assertions |

## Non-goals

- **Changing the `docs/NNN-*/` convention** — the naming convention stays as a project practice; it's just no longer enforced by code.
- **Adding new frontmatter fields** — keep it to `status` (and optionally `title`) for now. Richer metadata (tags, assignees, dependencies) is a separate concern.
- **Doc editing in the UI** — read-only rendering stays as-is.

## Risks

- **Performance**: Reading frontmatter from every `.md` file adds I/O. Mitigation: only read the first 500 bytes of each file (frontmatter is always at the top). For workspaces with hundreds of docs this is still fast — it's sequential `readFile` with small buffers.
- **Breaking API consumers**: The `/docs` response shape changes from `{ files: string[] }` to `{ docs: DocEntry[] }`. The client is the only consumer, so this is a coordinated change.
- **CLAUDE.md references**: The docs structure section in CLAUDE.md references features. Update it to describe the unified system.
