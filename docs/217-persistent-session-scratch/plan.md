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

**The fix is to add a third sibling** — a persistent scratch dir — and route
presented artifacts onto it so they survive a restart. Two mechanisms (§2); the
recommended one has the worker snapshot each presented artifact there.

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

`mkdirSync(scratchDir, { recursive: true })` before mount.

### 1a. Ownership — `mkdirSync` alone is NOT sufficient (the `:rw` difference)

`/persist` being `:rw` is exactly why it can't just copy the `uploadsDir` recipe.
`/uploads` is `:ro`, so the worker only ever *reads* it — ownership is irrelevant.
`/persist` must be **writable by the non-root session worker (uid/gid 1000)**, and
a host-created `scratch/` dir lands `root:root` (the orchestrator runs as root in
the volume-backed deployment). Mounted as-is, uid 1000 cannot write to `/persist`
and the whole feature silently no-ops.

The fix is to hand ownership to the worker UID, the same way every other writable
mount already does. The container entrypoint
(`docker/session-worker/entrypoint.sh`) chowns writable mounts to the worker UID
via a hardcoded loop — currently `for d in /workspace /uploads /dep-cache
/credentials /home/shipit`. **`/persist` must be added to that loop** so it picks
up the same UID-stamped-sentinel chown (skipped on warm reuse, re-run on UID
rotation). Mirror the existing nuances:

- The loop is gated on `UID_GID` being set (legacy root runtime skips it) — `/persist`
  inherits that gate for free.
- It is `chown -R`, so it correctly handles the bind-deployment case too; and the
  dev/dogfood bind-mount-skip only special-cases `/workspace`, so `/persist` is
  unaffected.
- Optionally also `chownToSessionWorker(scratchDir)` (orchestrator-side, from
  `session-worker-uid.ts`) right after `mkdirSync`, gated on the same UID var the
  orchestrator already uses for its §7 chowns — belt-and-suspenders, matching how
  the workspace clone is handled.

**Test:** a non-root worker can create and read back `/persist/foo` (and a
`/persist`-backed present artifact re-renders after a simulated restart).

Writable under a read-only rootfs (it's a mount, like `/workspace` and `/tmp`),
so it composes with the docs/172 Gap 5 hardening with no special case.

### 2. Getting present artifacts onto `/persist` — two mechanisms

There are two ways to make presented artifacts land on the persistent mount, and
**they are coupled to the disk-safety decision in §3** — that coupling is the
crux of this design, so it's spelled out rather than hidden:

- **Variant 1 — guidance only (agent writes to `/persist`).** Tell the agent to
  write throwaway present files to `/persist` instead of `/tmp`. The orchestrator
  already persists `resolvedPath` and re-registers it with a freshly-started
  worker (`/present/register`), which re-reads the bytes from disk; if
  `resolvedPath` is under `/persist` the re-read just succeeds after a restart.
  **Zero byte-path code** — no changes to `present-store.ts`,
  `present-registry.ts`, `present-view.ts`, or `proxyPresentRaw`. But it makes
  `/persist` a **general, agent-written, unbounded** dir, so it is only safe paired
  with the §3 disk budget (option b).

- **Variant 2 — worker-managed snapshot (RECOMMENDED MVP).** Leave the agent's
  workflow unchanged (it keeps writing throwaways to `/tmp`). On `present` submit,
  the worker **copies** the submitted artifact into
  `/persist/<presentId>.<ext>` and records *that* as `resolvedPath`. Because every
  byte that reaches `/persist` came through `present`, the existing **~1 MB submit
  cap bounds it automatically** — no janitor change, no agent guidance change, and
  no dependence on the agent picking the right path. The cost is a small code
  change in the submit broker (the copy + path rewrite); it stays entirely on the
  session volume, with **no orchestrator byte-shipping** (the distinction from the
  rejected snapshot-to-orchestrator alternative below).

**Recommended: Variant 2.** It fixes the user's concrete complaint (presented
`/tmp` artifacts vanishing) with a bounded, self-contained change and no reliance
on agent path discipline. Under it the agent-facing model is *unchanged* — `/tmp`
throwaway vs `/workspace` tracked — except that `/tmp` throwaways **now survive a
restart** because the worker snapshotted them:

| Intent | Agent writes to | In git? | Survives restart? |
|---|---|---|---|
| Throwaway (default) | `/tmp` → worker snapshots to `/persist` | no | **yes** |
| Tracked deliverable | `/workspace` | yes | yes |

Variant 1 is the path to the broader "general non-git scratch" vision and is
revisited in §3 / Open questions.

### 3. Lifecycle

- **Idle eviction / restart** — `scratch/` is host-backed, so it persists exactly
  like `uploads/` and the git clone. The next container re-mounts it. ✅ the whole
  point.
- **Session delete / full reset** — the session dir is removed wholesale, taking
  `scratch/` with it. No separate cleanup path, no orphan-volume sweep needed
  (`disk-janitor.ts` is untouched).
- **Disk — bounded by construction under the recommended Variant 2.** The present
  submit cap (`~1 MB/artifact`, enforced in `mcp-tools/present.ts`) bounds only the
  bytes that arrive *through `present`*. Variant 2 routes **every** byte on
  `/persist` through that submit path (the worker is the only writer), so the cap
  is the enforced bound and **`disk-janitor.ts` stays untouched** — no new disk
  machinery, the unbounded state never exists.

  Variant 1 (and the broader "general non-git scratch" vision) is the opposite:
  the agent writes directly, so `/persist` is **unbounded and survives every
  restart**. It **must not ship without an enforced budget** — a per-session size
  cap (reject/evict past N MB) and/or an LRU sweep in `disk-janitor.ts` keyed on
  the `scratch/` dirs, plus tests. That is deliberately deferred so the unbounded
  state is never the default; the MVP ships the bounded Variant 2.

  The earlier "out of scope" hand-wave was wrong: a persistent writable mount must
  ship with its disk story. Here it's "Variant 2 is bounded by the present cap;
  general agent-write (Variant 1) is gated behind a budget."

### 4. Security / containment

- The mount is `:rw` because the worker writes presented artifacts there
  (Variant 2), per-session isolated. This grants no new capability — the worker
  already reads/writes the agent's files under `/tmp` and `/workspace`; `/persist`
  just makes a slice survive. It does **not** weaken the `uploads` `:ro` protection
  (docs/172 Gap 6), which exists to stop a prompt-injected agent tampering with the
  *user's* files — a different directory with a different threat model. (Under
  Variant 1 the agent writes `/persist` directly, the same capability it already
  has for `/tmp`/`/workspace`; still no new reach.)
- Nothing here is network-routable; present artifacts are still served only
  through the worker-local screenshot URL and the orchestrator's authenticated
  session API, unchanged.

## Relationship to `/uploads` — share the volume, keep the mounts separate

A natural question is whether `/uploads` should be folded under the new mount so
there's "one volume for everything not under git." The answer is **no at the
mount layer, but it's already yes at the storage layer**:

- **Storage layer — already one volume.** `uploads/` and the new `scratch/` are
  siblings in the same session host dir, and in the volume-backed deployment both
  are `Subpath`s of the *same* workspace named volume. The bytes already live in
  one place; there is nothing to consolidate.
- **Mount layer — must stay two mounts.** `/uploads` is `:ro` deliberately
  (docs/172 Gap 6 / SHI-45): the agent must not write or delete the *user's*
  uploaded files — a prompt-injection containment boundary. `/persist` is `:rw`
  (the agent's *own* scratch). A single mount can't be both read-only and
  writable. Folding them means either dropping uploads to `:rw` (a security
  regression) or nesting a `:ro` sub-mount under a `:rw` parent (still two mounts,
  plus over-mount ordering fragility).

The only available "fold" is cosmetic — a shared parent path like `/data/uploads`
(ro) + `/data/scratch` (rw). It doesn't reduce the mount count and costs a rename
of `/uploads`, which is established agent-facing surface (shipit-docs, the
untrusted-input envelope guidance, agent habit). Not worth the churn. Keep
`/uploads` where it is.

## Why not the alternatives

- **Ship present bytes to the orchestrator and snapshot them there** (the
  "complete docs/093" approach). Works, and decouples persistence from the
  container entirely — but it adds a byte-transfer + blob-store +
  serve-from-snapshot path on the orchestrator. Variant 2 also snapshots the
  artifact, but **onto the session's own `/persist` mount**, so the existing
  worker-local serve path (`readArtifactContent`) and re-register flow are reused
  unchanged and no bytes cross to the orchestrator. The mount mechanism (and the
  general non-git tier it opens up) reuses exactly what `uploads` already proves.
- **A dedicated Docker named volume per session for present.** Heavier: a separate
  volume lifecycle to create and clean up, and it still leaves bytes in
  container-attached storage rather than the session dir the rest of the
  session's durable state already lives in.

## Key files

- `src/server/orchestrator/container-lifecycle.ts` — `buildMounts` (add the
  `/persist` mount branch), `mkdirSync` the dir before mount, derive
  `scratchDir` default as a `sessionDir` sibling.
- `docker/session-worker/entrypoint.sh` — **add `/persist` to the writable-mount
  chown loop** (line ~34) so the uid-1000 worker can write to it. Without this the
  mount lands `root:root` and the feature no-ops (see §1a).
- `src/server/orchestrator/session-worker-uid.ts` — optional belt-and-suspenders
  `chownToSessionWorker(scratchDir)` after `mkdirSync`, gated on the same UID var.
- `src/server/orchestrator/session-container.ts` — `ContainerConfig.scratchDir`
  field + thread it through container creation (mirror `uploadsDir`).
- `src/server/session/present-view.ts` (and the `/agent-ops/present/submit`
  broker in `session-worker.ts`) — **Variant 2 only**: on submit, copy the
  artifact into `/persist/<presentId>.<ext>` and record that as `resolvedPath`.
  The existing serve path (`readArtifactContent`) and the orchestrator re-register
  (`/present/register`, `proxyPresentRaw`) then work unchanged, now reading from a
  surviving mount. `present-store.ts` / `present-registry.ts` are untouched.
- `src/server/orchestrator/disk-janitor.ts` — untouched under Variant 2 (bounded
  by the present cap); only touched if Variant 1 / general scratch is later adopted.
- `src/server/shipit-docs/environment.md` — add `/persist` to the filesystem
  layout table (writable, non-git, persistent) and update the persistence rule
  ("only `/workspace` persists" → "`/workspace` and `/persist` persist").
- `src/server/shipit-docs/present.md` — note that `/tmp` throwaways now survive a
  restart (the worker snapshots them); under Variant 2 the agent's `/tmp`-vs-
  `/workspace` guidance is otherwise unchanged.
- `src/server/session/mcp-tools/present.ts` — only if Variant 1 is chosen (point
  throwaways at `/persist`); no change under Variant 2.

## Open questions

- **Mount path name.** `/persist` is proposed (clear, parallel to `/workspace`,
  `/uploads`). Alternatives: `/session-data`, `~/.shipit/persist`. Decide before
  implementing — it becomes agent-facing surface.
- **Mechanism — Variant 1 (guidance) vs Variant 2 (worker snapshot), §2.**
  Recommended: **Variant 2** — bounded by the present cap, no agent-path
  dependence, small self-contained code change. Confirm before implementing; it
  decides whether there's a byte-path change and whether the agent docs change.
- **General non-git scratch — defer.** Promoting `/persist` to a tier the agent
  writes to directly (the user's original "everything not under git" framing) is
  Variant 1 + a disk budget (§3). Worth doing, but a separate decision so the
  unbounded state is never shipped as the default. Tracked, not in this MVP.
