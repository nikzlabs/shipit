---
status: done
---

# 034 — Home Screen with Repo Selector

## Overview

Replace the `TemplateSelector` shown for new sessions with a proper home/launch screen centered on repo selection. Two flows branch from the home screen:

1. **New repo**: Create a GitHub repo with a template, commit to main, push. Repo is pre-selected on the home screen.
2. **Existing repo**: Select a repo, type a message, which creates a new session + git branch. Branch name and session title are generated from the user's message via a non-blocking Claude CLI call.

## Problem

Previously, new sessions started with a template picker that created an empty local project. There was no connection to GitHub repos from the start. Users had to manually create repos, import them, and set up branches — all separate steps.

## Design

### Home screen layout

```
┌────────────────────────────────────┐
│          (vertical center)         │
│                                    │
│      [ RepoSelector dropdown ]     │
│                                    │
│      [ MessageInput component ]    │
│                                    │
│  "Select a repository to start..." │
└────────────────────────────────────┘
```

- When no repo selected: MessageInput is disabled, hint text shown
- When repo selected: MessageInput is active, sends via `home_send_with_repo`
- Full width (no right panel) — same as the old template picker layout

### RepoSelector

Combobox dropdown with:
- Text input with search (placeholder: "Select a repository...")
- "+ New repository" option at the top
- Repo list from two sources:
  - **Local repos**: Deduplicated `remoteUrl` values from existing sessions
  - **GitHub search**: Debounced (300ms) server-side search via `github_search_repos`
- Selected state shown as repo label with clear button

### NewRepoDialog

Modal combining:
- Repo creation fields (name, description, public/private toggle)
- Template grid with category filter pills
- "Create & Setup" submit button (disabled until name + template selected)

### Branch naming

When a user sends a message with a selected repo:
1. Session created immediately with a temporary branch name (`{random-prefix}`)
2. A separate non-blocking Claude CLI call generates a session title + branch-friendly slug
3. On success: branch renamed to `{prefix}-{slug}`, session title updated
4. On failure: keeps the temporary branch name

## Key files

| File | Role |
|------|------|
| `src/server/git.ts` | `checkoutNewBranch`, `renameBranch`, `generateBranchPrefix` |
| `src/server/types.ts` | `WsHomeCreateRepoWithTemplate`, `WsHomeSendWithRepo`, `WsHomeRepoReady` |
| `src/server/index.ts` | Server handlers for both flows, `runClaudeWithMessage` helper |
| `src/server/session-namer.ts` | Spawns short-lived Claude CLI for title/slug generation |
| `src/client/App.tsx` | HomeScreen integration, state management |
| `src/client/components/HomeScreen.tsx` | Main home screen component |
| `src/client/components/RepoSelector.tsx` | Combobox with search |
| `src/client/components/NewRepoDialog.tsx` | Combined repo creation + template dialog |
| `src/client/utils/repo-label.ts` | Shared `parseRepoLabel()` utility |

## WebSocket messages

### Client → Server

- `home_create_repo_with_template` — Create GitHub repo, apply template, push to main
- `home_send_with_repo` — Clone repo, create branch, start Claude session

### Server → Client

- `home_repo_ready` — Repo creation complete (success/failure, repoUrl, sessionId)
- `session_started` — Standard session started event (reused)
- `session_renamed` — Session title updated after name generation (reused)

## Flows

### New repo flow

1. User clicks "+ New repository" in RepoSelector
2. NewRepoDialog opens: user enters name, picks template
3. Server: creates GitHub repo → creates session → applies template → commits → pushes to main
4. Server sends `session_started` + `home_repo_ready { success, repoUrl }`
5. Client pre-selects the repo URL on home screen
6. User types a message → continues with "existing repo" flow

### Existing repo flow

1. User selects a repo from RepoSelector (local or GitHub search)
2. User types a message and sends
3. Server: creates session (skipGitInit) → clones repo → creates temp branch → starts Claude
4. Non-blocking: generates session name via separate Claude CLI → renames branch + session title
5. Client navigates to session, shows Claude's response
