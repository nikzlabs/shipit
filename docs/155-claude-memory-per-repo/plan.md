---
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

## Constraint: warm containers and per-agent isolation

A bind-mount design is tempting (mirror `dep-cache` / `repo-cache` from
`container-lifecycle.ts:72-145`) but doesn't actually work here:

1. **Warm containers aren't agent-pinned.** The warm pool exists precisely
   so a container can be reassigned to whatever agent the user picks. At
   `ensureSessionCredentialsScaffold` time we don't yet know whether this
   container will be Claude or Codex. Creating a mount at
   `/root/.claude/projects/-workspace/memory` would materialize a
   `.claude/projects/-workspace/` subtree on the host even for sessions
   that end up pinned to Codex — a direct regression of the docs/138
   guarantee that a Codex container "never has `.claude` on disk."
2. **Warm containers aren't repo-pinned either.** There's no `<repoHash>`
   at warm-create time, so there's nothing to key the mount by.
3. **Docker bind mounts can't be added to a running container.** Deferring
   the mount until first turn (when the agent and repo are both known)
   isn't possible with bind mounts as the primitive.

## Design

Reuse the **per-turn sync** machinery already in place for OAuth tokens
(docs/142 / `syncAgentTokenIn` + `syncAgentTokenBack` in
`session-credentials.ts`). The shape is structurally the same: an external
"source of truth" on the host is reconciled into and out of each session's
per-session credentials subtree at turn boundaries, with no live bind mount.

1. **Host path keyed by repo hash.** Use the same hash `RepoGit` already
   computes for `repo-cache/<hash>` and `dep-cache/<hash>`. Memory lives at
   `<credentialsRoot>/repo-memory/<repoHash>/` on the orchestrator host.
   Sessions without a remote URL get no shared dir and fall back to the
   per-session subtree (memory is ephemeral for them).
2. **Nothing happens at warm-container create time.** No directory is
   created, no mount is added — Codex sessions never see `.claude`. The
   docs/138 isolation guarantee is preserved.
3. **First-turn provisioning hook.** When the session is pinned to an
   agent (existing `provisionAgentCredentials` flow), and only if
   `agentId === "claude"` and the session has a remote URL, `mkdirSync`
   the shared dir and copy `<credentialsRoot>/repo-memory/<repoHash>/`
   into the session subtree's `.claude/projects/-workspace/memory/`.
4. **Sync-back at turn end.** After each Claude turn, walk the session's
   `memory/` dir and copy any new-or-modified files back to the shared
   `repo-memory/<repoHash>/`. Last-write-wins per file; this is fine
   because each memory is a separate file by slug.
5. **GC in `disk-janitor.ts`.** When no live session references a
   `<repoHash>`, sweep `repo-memory/<hash>` the same way orphan
   `repo-cache/<hash>` and `dep-cache/<hash>` are swept.

The cost relative to a bind mount is that two parallel Claude sessions on
the same repo don't see each other's mid-turn writes — they only see the
post-turn snapshot. For an accumulating memory store this is acceptable;
mid-turn writes aren't a useful signal for another session anyway.

## Concurrency: `MEMORY.md` write race

Two parallel sessions on the same repo will now write into one directory.
Per-memory files are independent (one file per memory, named by slug), so
those don't race meaningfully. But `MEMORY.md` is a single shared index;
concurrent edits can clobber each other.

Decision: **accept last-write-wins on `MEMORY.md`.** It's an index over the
files in the directory, regeneratable by listing the dir. A future
enhancement could add a small "rebuild MEMORY.md from frontmatter" step on
session start, but it's not required to ship.

## Rejected alternatives

- **Bind mount at warm-container create.** See "Constraint" above —
  violates docs/138 (materializes `.claude` in Codex containers) and the
  warm container doesn't even know the repo hash yet.
- **Bind mount added at first-turn provisioning.** Docker doesn't allow
  adding bind mounts to a running container, so this would force a
  container restart at agent-pin time — defeating the warm pool.
- **Symlink inside the per-session credentials subtree.** The credentials
  volume is sub-pathed per session in production, so a symlink pointing at
  `<credentialsRoot>/repo-memory/<hash>/...` would dangle inside the
  container — that host path isn't visible there.
- **Separate warm pools per agent.** Doubles warm-pool cost for a
  feature most sessions won't benefit from in the first turn.

## Key files

- `src/server/orchestrator/session-credentials.ts` — first-turn
  provisioning hook (`provisionAgentCredentials`) gets a memory copy-in
  step; new `syncMemoryBack` mirrors `syncAgentTokenBack`. Skipped for
  non-Claude agents and for sessions without a remote URL.
- `src/server/orchestrator/repo-git.ts` — source of the repo hash used to
  key the shared directory.
- `src/server/orchestrator/ws-handlers/post-turn.ts` (or wherever
  `syncAgentTokenBack` is invoked) — invoke `syncMemoryBack` on the same
  turn-end hook.
- `src/server/orchestrator/disk-janitor.ts` — orphan sweep for
  `repo-memory/<hash>`.

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
