---
issue: https://linear.app/shipit-ai/issue/SHI-180
title: Persistent session scratch (non-git, survives container restart)
description: A host-backed per-session scratch mount that persists across container teardown, so present artifacts (and other non-git files) survive a restart without being committed to git.
---

# Persistent session scratch

## Problem

The container filesystem has exactly two persistence tiers, and neither fits a
throwaway-but-keep-it artifact:

- **`/workspace`** — the git clone. Persists across container teardown (it's
  re-cloned), but everything in it is **committed to git**.
- **`/tmp`** (and the rest of the container rootfs) — **ephemeral**. Wiped when
  the idle container is stopped + removed; a fresh container starts clean.

The `present` tool inherits this split (see `src/server/shipit-docs/present.md`):
a throwaway artifact is written to `/tmp`, a tracked one into `/workspace`. After
docs/093 the orchestrator durably stores presentation **metadata** (title, mime,
carousel order, and the container-internal `resolvedPath`) in SQLite, but **never
the bytes** — they are always re-read from the source file on disk on demand
(`readArtifactContent` → `fsp.readFile(meta.resolvedPath)`).

So after a container restart:

- A **workspace** present file is still on disk (re-cloned) → it re-renders fully.
- A **`/tmp`** present file is gone → the read 404s → the Present tab shows a
  "source no longer available" placeholder.

That placeholder is the user-visible pain: *"I come back tomorrow to a session I
started yesterday and the presented files are gone."* The artifacts the user only
wanted to look at — not commit — are exactly the ones that vanish.

The deeper gap: there is **no persistent home for non-git files**. Anything the
agent produces that should outlive the container but shouldn't pollute the repo
has nowhere to live.

## Key insight — the persistent non-git tier already exists

The session's **host** directory already contains persistent, non-git siblings.
A session's on-host layout is:

```
<sessionDir>/                     # host path, e.g. /workspace/sessions/{uuid}
  workspace/   → mounted /workspace (rw)   the git clone
  uploads/     → mounted /uploads   (ro)   user-uploaded files, NOT in git
```

Both `workspace/` and `uploads/` **survive container teardown** because they're
host-backed — either a bind mount of the host dir, or (in the volume-backed
deployment) a `Subpath` of the workspace named volume (`buildMounts` in
`container-lifecycle.ts` handles both forms). `uploads/` proves the model: a
per-session, host-persisted, non-git directory that the next container re-mounts.

`uploadsDir` is derived as a sibling of the session dir:
`path.join(opts.sessionDir, "uploads")` (`container-lifecycle.ts`).

**The fix is to add a third sibling** — an agent-**writable** persistent scratch
dir — and have `present` write throwaway artifacts there instead of `/tmp`.

## Design

### 1. A new persistent scratch mount

Add `scratchDir = path.join(sessionDir, "scratch")` to the container config,
mounted **read-write** into the container at **`/persist`**, mirroring how
`uploadsDir` is wired but `:rw` (the agent *writes* its own scratch here; uploads
are `:ro` because they're the *user's* files and the agent only consumes them).

`buildMounts` gets a branch parallel to the uploads one:

- volume-backed deployment: `{ Type: "volume", Source: workspaceVolume, Target:
  "/persist", ReadOnly: false, VolumeOptions: { Subpath: scratchRelPath } }`
- bind deployment: `binds.push(`${scratchDir}:/persist:rw`)`

`mkdirSync(scratchDir, { recursive: true })` before mount, exactly like uploads.

Writable under a read-only rootfs (it's a mount, like `/workspace` and `/tmp`),
so it composes with the docs/172 Gap 5 hardening with no special case.

### 2. `present` writes throwaway artifacts to `/persist`, not `/tmp`

This is the **only** change the present pipeline needs — and it is a
**documentation / guidance** change, not a code change to the byte path:

- The orchestrator already persists `resolvedPath` and re-registers it with a
  freshly-started worker (`/present/register`), which re-reads the bytes from
  disk. If `resolvedPath` points into `/persist` (host-backed) instead of `/tmp`
  (ephemeral), **the re-read just succeeds** after a restart. Zero changes to
  `present-store.ts`, `present-registry.ts`, `present-view.ts`, or
  `proxyPresentRaw`.

The present model becomes three clear tiers instead of two:

| Intent | Write to | In git? | Survives restart? |
|---|---|---|---|
| Persistent throwaway (default) | `/persist` | no | **yes** |
| Tracked deliverable | `/workspace` | yes | yes |
| Truly ephemeral | `/tmp` | no | no |

`/persist` becomes the **recommended default** for `present` throwaways: the user
keeps seeing the artifact the next day without it ever entering the repo. `/tmp`
stays available for genuinely disposable scratch.

### 3. Lifecycle

- **Idle eviction / restart** — `scratch/` is host-backed, so it persists exactly
  like `uploads/` and the git clone. The next container re-mounts it. ✅ the whole
  point.
- **Session delete / full reset** — the session dir is removed wholesale, taking
  `scratch/` with it. No separate cleanup path, no orphan-volume sweep needed
  (`disk-janitor.ts` is untouched).
- **Disk** — bounded by the present ~1 MB/artifact cap and ordinary agent
  scratch; it shares the session's storage budget. If this grows into a concern,
  a future size cap or LRU sweep can live in `disk-janitor.ts`, but it is out of
  scope here.

### 4. Security / containment

- The mount is `:rw` because it is the **agent's own** scratch, per-session
  isolated. This grants no new capability — the agent can already write freely to
  `/tmp` and `/workspace`; `/persist` just makes a slice of that survive. It does
  **not** weaken the `uploads` `:ro` protection (docs/172 Gap 6), which exists to
  stop a prompt-injected agent tampering with the *user's* files — a different
  directory with a different threat model.
- Nothing here is network-routable; present artifacts are still served only
  through the worker-local screenshot URL and the orchestrator's authenticated
  session API, unchanged.

## Why not the alternatives

- **Ship present bytes to the orchestrator and snapshot them there** (the
  "complete docs/093" approach). Works, and decouples persistence from the
  container entirely — but it only solves `present`, adds a byte-transfer +
  blob-store + serve-from-snapshot path, and introduces snapshot-vs-disk staleness
  questions. The scratch mount solves the *general* "non-git persistence" gap with
  no new byte plumbing, reusing the exact mechanism `uploads` already proves.
- **A dedicated Docker named volume per session for present.** Heavier: a separate
  volume lifecycle to create and clean up, and it still leaves bytes in
  container-attached storage rather than the session dir the rest of the
  session's durable state already lives in.

## Key files

- `src/server/orchestrator/container-lifecycle.ts` — `buildMounts` (add the
  `/persist` mount branch), `mkdirSync` the dir before mount, derive
  `scratchDir` default as a `sessionDir` sibling.
- `src/server/orchestrator/session-container.ts` — `ContainerConfig.scratchDir`
  field + thread it through container creation (mirror `uploadsDir`).
- `src/server/shipit-docs/present.md` — document `/persist` as the persistent
  throwaway tier; update the two-tier model to three.
- `src/server/shipit-docs/environment.md` — add `/persist` to the filesystem
  layout table (writable, non-git, persistent) and the persistence rules
  ("only `/workspace` persists" → "`/workspace` and `/persist` persist").
- `src/server/session/mcp-tools/present.ts` — update the tool description /
  instructions to point throwaways at `/persist`.
- No changes to `present-store.ts`, `present-registry.ts`, `present-view.ts`, or
  `container-session-runner.ts` (`proxyPresentRaw`): the existing re-read +
  re-register path works unchanged once `resolvedPath` lives on a surviving mount.

## Open questions

- **Mount path name.** `/persist` is proposed (clear, parallel to `/workspace`,
  `/uploads`). Alternatives: `/session-data`, `~/.shipit/persist`. Decide before
  implementing — it becomes agent-facing surface.
- **Default vs opt-in for `present`.** Recommended: make `/persist` the default
  throwaway location so the user's complaint is fixed with no per-call action.
  The alternative (keep `/tmp` default, document `/persist`) is less effective
  because the agent would keep choosing `/tmp` out of habit.
</content>
</invoke>
