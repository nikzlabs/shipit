---
description: Replace the session file watcher's fs.watch(recursive) with chokidar so ignored subtrees never consume host-wide inotify watches.
---

# Chokidar-backed session file watcher

The session container's workspace watcher (`src/server/session/file-watcher.ts`)
streams change events for the file tree to the orchestrator. Originally it used
`fs.watch(dir, { recursive: true })` plus a `shouldIgnore()` filter inside the
callback. That filter saved us from emitting noise events but did **nothing**
to keep the kernel from creating watches in the first place.

## Why

There is no native recursive inotify on Linux. When `fs.watch` is called with
`recursive: true`, Node walks the entire directory tree at start time and
registers one inotify watch on every subdirectory — `node_modules` (often
30k–80k dirs in a real project), `.git`, `dist`, `.next`, `.cache`, `.vite`,
and so on. **Watch registration is causal; event filtering is not.** The
callback's ignore check only suppressed downstream notifications; the kernel
watches were already in place.

The killer detail: inotify watch limits (`fs.inotify.max_user_watches`) are
**per host-UID**, not per container. Every session container runs as the same
UID on the host, so all sessions share one pool. With the default ~65k budget,
2–3 active sessions could exhaust it; the next session's watcher would silently
fail to register watches on parts of the tree and miss events.

We previously raised the sysctl in prod (PR #585) as a band-aid. This change is
the real fix.

## What changed

`FileWatcher` now uses [chokidar](https://github.com/paulmillr/chokidar) under
the hood. Chokidar walks the tree itself and consults the `ignored` matcher
**before** registering a watcher on each directory, so ignored subtrees never
consume an inotify watch at all.

- `chokidar.watch(dir, { ignored, ignoreInitial: true, persistent: true })`
- `ignored` is a function (not a glob) so it applies the same per-segment
  logic as the old `shouldIgnore()` — any segment in `WORKSPACE_SKIP_DIRS`
  (`node_modules`, `.git`, `.vibe-chat-history`, `dist`, `.next`, `.cache`,
  `.vite`, `sessions`, `.shipit`, `.inner-shipit`) or `IGNORE_FILES`
  (`.shipit-usage.json`, `.vibe-sessions.json`) causes the entry to be
  skipped, no matter how deeply it's nested (`packages/app/node_modules`,
  `vendor/foo/.git`, etc).
- Events `add`, `change`, `unlink`, `addDir`, `unlinkDir` all flow into the
  same debounced `Set → "changes" emit` pipeline as before. The public
  surface (`start(dir)`, `stop()`, `on("changes", paths)`) is unchanged, so
  `SessionWorker.wireFileWatcherEvents()` and the SSE-bridge in
  `ContainerSessionRunner` need no changes.
- Removed the macOS `dirBasename` spurious-event workaround — chokidar
  handles that internally.

## Constants

The ignore lists themselves live in `src/server/shared/fs-constants.ts`
(`WORKSPACE_SKIP_DIRS`) and `file-watcher.ts` (`IGNORE_FILES`). They are
unchanged — `file-tree.ts` and the markdown scanner still import them.

## Key files

- `src/server/session/file-watcher.ts` — the rewrite.
- `src/server/session/file-watcher.test.ts` — covers create / modify /
  delete, debounce + dedup, ignored top-level dirs (`node_modules`, `.git`,
  `.vibe-chat-history`), ignored files (`.shipit-usage.json`), nested
  ignored dirs (`packages/app/node_modules`), `stop()` cleanup, idempotent
  `start()`, and subdirectory path reporting.
- `src/server/session/session-worker.ts` — consumer, unchanged.
- `src/server/orchestrator/integration_tests/worker-file-watcher.test.ts` —
  uses `StubWatcher`, unaffected by the chokidar swap.
- `package.json` — adds `chokidar: ^5.0.0`.

## Why not just raise `max_user_watches` further?

The sysctl bump in PR #585 is still a useful safety margin (host-wide noise
from other processes, kernel overhead, etc.), but it doesn't fix the
architectural issue: registering tens of thousands of useless watches on
directories we explicitly didn't want to watch is wasted kernel state and a
DOS surface against ourselves. Chokidar's pre-registration filtering means a
session with a 60k-dir `node_modules` now costs roughly the same in
inotify watches as a session with an empty workspace.
