---
status: done
---

# 029 — Feature System

## Overview

A feature tracking system that lets users document features as markdown files in the `docs/` directory (using the existing `NNN-feature-name/plan.md` convention), view them with status in the UI, and kick off new sessions to work on them.

## How it works

### Feature discovery

Features are directories under `docs/` matching the pattern `NNN-feature-name/` that contain a `plan.md` file. The `FeatureManager` class scans the workspace `docs/` directory and parses YAML frontmatter from each `plan.md` to extract metadata.

### Status tracking

Status is stored as YAML frontmatter in `plan.md`:

```markdown
---
status: planned
---

# Feature Name

Description...
```

Valid statuses: `planned`, `in-progress`, `done`. Defaults to `planned` if no frontmatter is present.

### Starting a session from a feature

When the user clicks "Start Session" on a feature, a new chat session is created with an initial message referencing the feature's docs. The message includes paths to `plan.md` and `checklist.md` (if it exists) so Claude can read them as context.

### UI

A new "Features" tab in the right panel (alongside Preview, Docs, Files, Terminal) shows all features sorted by number, with status badges and a "Start Session" button for each.

## Key files

- `src/server/features.ts` — `FeatureManager` class: scans docs/, parses frontmatter
- `src/server/types.ts` — `FeatureInfo`, `WsListFeatures`, `WsFeatureList`, `WsStartFeatureSession` types
- `src/server/index.ts` — WebSocket handlers for `list_features` and `start_feature_session`
- `src/client/components/FeaturesPanel.tsx` — Feature list UI with status badges
- `src/client/App.tsx` — New "Features" right-panel tab

## WebSocket messages

| Direction | Type | Payload |
|-----------|------|---------|
| Client → Server | `list_features` | (none) |
| Server → Client | `feature_list` | `{ features: FeatureInfo[] }` |

Starting a session from a feature is handled client-side: the `handleFeatureStartSession` callback in `App.tsx` constructs a context message referencing the feature's `plan.md` (and `checklist.md` if present) and sends it via the existing `send_message` flow. This avoids adding a separate server message type and reuses the existing session creation infrastructure.

## Patterns

- Follows the same pattern as `list_docs` / `doc_list` for scanning
- Session creation mirrors `send_message` with auto-session creation
- Feature status comes from YAML frontmatter (parsed with simple regex, no heavy YAML library)
- Features are identified by their directory name (e.g., `001-websocket-protocol`)
