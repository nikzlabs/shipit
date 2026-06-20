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

**The fix is to add a third sibling** — a general, agent-**writable** persistent
scratch dir, mounted at `/persist`. The agent writes throwaway-but-keep files
there instead of `/tmp` (presented artifacts being the motivating case), and they
survive a restart for free, exactly like `uploads/` does.

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

### 2. `present` writes throwaway artifacts to `/persist`, not `/tmp`

The agent writes throwaway present files (and any other keep-but-don't-commit
scratch) to `/persist` instead of `/tmp`. That's the whole change to the present
flow — and it is **guidance only, with zero byte-path code**:

- The orchestrator already persists `resolvedPath` and re-registers it with a
  freshly-started worker (`/present/register`), which re-reads the bytes from
  disk. Once `resolvedPath` points into `/persist` (host-backed) instead of `/tmp`
  (ephemeral), **the re-read just succeeds** after a restart. No changes to
  `present-store.ts`, `present-registry.ts`, `present-view.ts`, or
  `proxyPresentRaw` — the existing serve + re-register path works unchanged the
  moment the file lives on a surviving mount.

This is the simplest possible design and gives everyone the same mental model:
`/persist` is "the place for files that should outlive the container but stay out
of git." The agent already understands `/tmp` (ephemeral) and `/workspace`
(committed); `/persist` slots in as the third, obvious option. The present model
becomes three clear tiers:

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
- **Per-session disk — deliberately unbounded, and that's fine.** No per-session
  size cap or eviction. The agent can *already* write arbitrarily large files to
  `/workspace` (which also persists — the host clone survives between containers,
  and committed bytes live in git forever), so a writable `/persist` adds no new
  failure mode the platform doesn't already tolerate. Bounding `/persist` while
  `/workspace` stays unbounded would be inconsistent for no real safety gain. We
  do **not** add a quota or LRU sweep.
- **Cross-session disk — what the real teardown paths remove (verified against the
  code).** The key fact: every automatic reclaim path `fs.rm`s the
  **`workspace/` subdir specifically**, never the session root — and `scratch/` is
  a *sibling* of `workspace/`, so it survives all of them for free. `/persist` is
  an **only-copy** (never committed or pushed; unlike the `workspace/` clone, which
  the janitor can safely wipe because `git clone` reconstructs it), so this
  spares-by-default behavior is exactly what we want:
  - **Active session** — `scratch/` persists. The whole point.
  - **Idle eviction** (`tier-escalation.ts`, `light → evicted` at 14d / 2d-merged)
    — `fs.rm(session.workspaceDir)`. **Spares `scratch/`.** (It also
    auto-commits+pushes the checkout before wiping — the git-backed safety net
    scratch doesn't need and can't have.)
  - **Archive** (`archiveSession`, the `DELETE` endpoint) — archive only **hides
    the session from the sidebar**; it is *not* a discard. It `fs.rm`s only
    `workspace/` (remote-backed sessions, recoverable from git). **Spares
    `scratch/`** — correctly, since the session isn't being thrown away.
  - **Full reset** — removes the whole sessions tree, `scratch/` included. The
    *only* path that drops scratch, and it's the deliberate nuke-everything action.

  So no new "spare scratch" janitor logic is needed — the existing paths already
  target `workspace/`. The only requirement is structural: keep `scratchDir` a
  sibling of `workspaceDir` and never `fs.rm(path.dirname(workspaceDir))` in a
  reclaim path. Scratch persists for the life of the session (archived or not) and
  is reclaimed only by a full reset — exactly right for only-copy data.

  In practice the disk cost of retention is small: `scratch/` holds throwaway
  artifacts (presented files and the like), not the node_modules-heavy trees the
  janitor targets.

### 4. Security / containment

- The mount is `:rw` because it's the **agent's own** scratch, per-session
  isolated. This grants no new capability — the agent can already write freely to
  `/tmp` and `/workspace`; `/persist` just makes a slice of that survive. It does
  **not** weaken the `uploads` `:ro` protection (docs/172 Gap 6), which exists to
  stop a prompt-injected agent tampering with the *user's* files — a different
  directory with a different threat model.
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
  container entirely — but it only solves `present`, adds a byte-transfer +
  blob-store + serve-from-snapshot path on the orchestrator, and introduces
  snapshot-vs-disk staleness questions. The scratch mount solves the *general*
  "non-git persistence" gap with no new byte plumbing — the agent writes the file
  and the existing serve path reads it — reusing exactly what `uploads` proves.
- **A worker-managed copy-on-submit into `/persist`** (snapshot each presented
  artifact server-side rather than having the agent write there). Considered and
  dropped as overengineering: it adds a copy + path-rewrite in the submit broker
  to buy a `present`-only size bound we decided we don't need (per-session disk is
  intentionally unbounded, §3). The guidance-only approach is simpler and gives
  the agent a general scratch tier for free.
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
- `src/server/orchestrator/tier-escalation.ts` (steady-state `hot → light →
  evicted` ladder, docs/161) and `src/server/orchestrator/startup-janitor.ts`
  (startup orphan sweeps) — the real reclaim paths behind the `disk-janitor.ts`
  facade. **No change needed to spare `scratch/`**: both target
  `session.workspaceDir`, and `scratch/` is a sibling. Add a test asserting
  eviction removes `workspace/` and leaves `scratch/` intact, and that no path
  `fs.rm`s `path.dirname(workspaceDir)`.
- `src/server/orchestrator/services/session.ts` — `archiveSession` (the `DELETE`
  endpoint) currently `fs.rm`s only `workspaceDir`, so it spares `scratch/`.
  Touch only if the open-question answer is "archive should also drop scratch".
- `src/server/shipit-docs/environment.md` — add `/persist` to the filesystem
  layout table (writable, non-git, persistent) and update the persistence rule
  ("only `/workspace` persists" → "`/workspace` and `/persist` persist").
- `src/server/shipit-docs/present.md` — document `/persist` as the persistent
  throwaway tier; update the two-tier model to three.
- `src/server/session/mcp-tools/present.ts` — update the tool description /
  instructions to point throwaway artifacts at `/persist` (the new default).
- No changes to `present-store.ts`, `present-registry.ts`, `present-view.ts`, or
  `container-session-runner.ts` (`proxyPresentRaw`): the existing re-read +
  re-register path works unchanged once `resolvedPath` lives on a surviving mount.

## Decisions (settled) and open questions

Settled:

- **Mount path name: `/persist`.** Approved — clear and parallel to `/workspace`,
  `/uploads`.
- **Mechanism: agent writes directly (guidance only).** No worker-managed
  copy-on-submit — that was dropped as overengineering (§2 / alternatives).
- **`/persist` is a general non-git scratch tier**, not present-only. The agent
  writes throwaway-but-keep files there; `present` is the motivating case. Simpler,
  consistent mental model.
- **No per-session disk budget** — parity with `/workspace` (§3).
- **Archive retains `scratch/`.** Archive only hides a session from the sidebar —
  it is not a discard — so its scratch is kept. `scratch/` is reclaimed only by a
  full reset (the deliberate nuke-everything action).

Open:

- **Any opt-in reclaim for long-archived `scratch/` under disk pressure?** Default
  is retain-until-full-reset (above). Do we also want an explicit, opt-in TTL sweep
  (archived > N days, with a heads-up) as a host-disk pressure valve — or is
  retain-until-full-reset enough? *Pending decision.*
- **Default `present` location.** Make `/persist` the default throwaway location in
  the `present` guidance (so the fix lands with no per-call action), with `/tmp` as
  the explicit "truly ephemeral" choice? *Pending decision.*
