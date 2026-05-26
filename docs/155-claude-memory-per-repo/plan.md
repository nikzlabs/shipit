---
status: planned
priority: medium
description: Share Claude's auto-memory directory across sessions of the same repo via a per-repo bind mount, while keeping per-agent credential isolation intact.
---

# Per-repo Claude memory sharing

Claude's auto-memory system (see `auto memory` in `CLAUDE.md`) accumulates
`user`/`feedback`/`project`/`reference` notes into
`/root/.claude/projects/-workspace/memory/` inside the session container.
Today every ShipIt session gets its own copy of `/root/.claude` (per-session
subpath of `/credentials`, see `docs/138`), so memories written in one session
are invisible to the next — defeating the point of memory as a long-lived
persistence layer.

We want: **all sessions opened against the same repo see the same memory
directory**. Different repos remain isolated; sessions without a remote
(templates, scratch) stay per-session.

## Why not just share `/root/.claude` across sessions

Two reasons:

1. **Collision on the project key.** Claude derives the on-disk project slug
   from cwd. Every session container has cwd `/workspace`, so every repo
   writes to the same slug `projects/-workspace/`. Sharing the whole
   `.claude` dir would cross-contaminate repo A's memories into repo B.
   Sharding must happen on the host side, keyed by repo identity.

2. **Per-agent credential isolation.** `docs/138` deliberately gives each
   session its own credentials subtree so Claude sessions never see Codex
   tokens (and vice versa). Reverting that to share `.claude` wholesale
   would regress credential isolation. We only want to share the memory
   subtree, not the tokens.

## Design

Mirror the existing `dep-cache` / `repo-cache` pattern in
`container-lifecycle.ts:72-145`:

1. **Host path keyed by repo hash.** Use the same hash `RepoGit` already
   computes for `repo-cache/<hash>` and `dep-cache/<hash>`. Memory lives at
   `<credentialsRoot>/repo-memory/<repoHash>/` on the orchestrator host.
   Sessions without a remote URL get no shared mount and fall back to the
   per-session credentials subtree (i.e. memory is ephemeral for them).
2. **Bind mount the memory dir only.** Mount
   `<credentialsRoot>/repo-memory/<repoHash>/` into the container at
   `/root/.claude/projects/-workspace/memory`. Docker resolves the mount
   through the existing `/root/.claude → /credentials/.claude` symlink, so
   the mount nests cleanly inside the per-session credentials subtree.
   Tokens (`.credentials.json`, `auth.json`, `.claude.json`) stay
   per-session — only the `memory/` subdir is shared.
3. **Scaffold at session-create time.** `mkdirSync` the host dir alongside
   the rest of the session credentials scaffolding (near
   `ensureSessionCredentialsScaffold` in `session-credentials.ts`). Cheap,
   idempotent.
4. **GC in `disk-janitor.ts`.** When no live session references a
   `<repoHash>`, sweep `repo-memory/<hash>` the same way orphan
   `repo-cache/<hash>` and `dep-cache/<hash>` are swept. Memory is a
   convenience, not user data the user expects to outlive their last
   session on a repo — but the sweep should follow the same retention
   semantics as the other repo-keyed caches, not be more aggressive.

## Concurrency: `MEMORY.md` write race

Two parallel sessions on the same repo will now write into one directory.
Per-memory files are independent (one file per memory, named by slug), so
those don't race meaningfully. But `MEMORY.md` is a single shared index;
concurrent edits can clobber each other.

Decision: **accept last-write-wins on `MEMORY.md`.** It's an index over the
files in the directory, regeneratable by listing the dir. A future
enhancement could add a small "rebuild MEMORY.md from frontmatter" step on
session start, but it's not required to ship.

## Why not a symlink inside the per-session credentials subtree

Symlinks were considered and rejected: the credentials volume is sub-pathed
per session in production, so a symlink pointing at
`<credentialsRoot>/repo-memory/<hash>/...` would dangle inside the container
— that host path isn't visible there. A first-class bind mount is the right
primitive.

## Key files

- `src/server/orchestrator/session-credentials.ts` — per-session credentials
  layout; scaffold hook would learn about the new dir.
- `src/server/orchestrator/container-lifecycle.ts` — where the new bind
  mount is appended (see `depCacheDir` for the existing precedent at
  lines 72-145).
- `src/server/orchestrator/repo-git.ts` — source of the repo hash used to
  key the directory.
- `src/server/orchestrator/disk-janitor.ts` — orphan sweep.

## Out of scope

- Sharing memory **across repos** (e.g. global user-level memory). The
  current Claude memory schema is project-scoped; cross-repo sharing is a
  separate design.
- Sharing memory **across users** on the same repo. ShipIt sessions are
  user-scoped today; cross-user memory would need a sanitization story
  first.
- Migrating existing per-session memory into the new shared dir. Memories
  written before this lands stay in their per-session subtrees and will be
  GC'd with the rest of those subtrees over time.
