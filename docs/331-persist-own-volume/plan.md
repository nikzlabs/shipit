---
issue: planning#696
title: /persist in a Docker volume of its own — design
description: Each session's /persist moves from sessions/<id>/scratch in the workspace volume into a named volume of its own, on every host, so Docker confines a persist/<sub> mount to that session on Docker Desktop too.
---

# 331 — /persist in a Docker volume of its own: design

Implements [`requirements.md`](./requirements.md). Not implemented yet; the
work is in [`checklist.md`](./checklist.md).

## Summary

Today `/persist` is the directory `sessions/<id>/scratch` inside the shared
workspace volume. The agent container mounts it as a subpath of that volume, and
a Compose service's `persist/<sub>` mount needs a bind-backed volume whose device
is that directory. Docker Desktop looks that device up on the host, so ShipIt
refuses the mount there (`docs/317-compose-persist-mount/plan.md`, "Docker
Desktop").

After this change each session's `/persist` is a plain named volume,
`shipit-persist-<session-id>`, on every host (req 4). A service's
`persist/<sub>` mount is a subpath of that volume, and Docker confines a subpath
to the root of its volume, which is now this session's `/persist` and nothing
else (reqs 1, 2). An existing session's files are copied into its volume at its
next start (req 5). The orchestrator cannot read a Docker volume, so the few
places where ShipIt itself touches `/persist` go through one helper-container
function.

## The volume (req 4)

- **Name:** `shipit-persist-<session-id>`, with the full id.
- **Labels:** `shipit-managed=true`, `shipit-persist-of=<session-id>`, and
  `stackLabel(DOCKER_STACK)` (every resource ShipIt creates carries the stack
  label, `stack-label.ts`, planning#584).
- **Driver:** `local`, with no `driver_opts`. A plain named volume lives where
  the daemon keeps its volumes: in `/var/lib/docker/volumes` on native Linux and
  inside the VM on Docker Desktop. No host path is looked up, so the Docker
  Desktop problem of docs/317 does not apply.
- **Created by** the orchestrator through dockerode `createVolume`, when the
  session's layout is `volume` and a container or a Compose start needs it.
  `createVolume` with an existing name and driver returns that volume, so the
  call is idempotent.

The name and the labels are chosen so that no existing removal path matches
them (verified at the source):

| Removal path | Selects by | Matches the new volume? |
|---|---|---|
| `pruneSessionVolumes` (`startup-janitor.ts`), on archive, hot→light and discard | `volume prune --filter label=shipit-session=<id>` | No. This is why the label is `shipit-persist-of`, not `shipit-session`: on an engine older than 23, `volume prune` also removes named volumes. |
| `sweepOrphanSessionVolumes` (`startup-janitor.ts`), at boot | name `^shipit-([a-f0-9-]{12})_` | No (`shipit-persist-` is followed by the full id, not `_`). |
| `removeProjectVolumes` (`compose-cli.ts`), after `down --volumes` | `com.docker.compose.project` | No. ShipIt creates the volume, and Compose neither labels nor removes an `external: true` volume (Compose's documented behaviour, not tested here). |
| `cleanupSessionDockerResources` (`container-lifecycle.ts`), on every destroy | `shipit-parent-session=<id>` | No. That label also lets the agent delete the volume through the Docker proxy (`docker-proxy-auth.ts`), so it must never be set. |
| `reapOrphanPluginInstalls` (`plugin-install.ts`), at boot | `shipit-plugin-generation` | No. |
| `stop.sh --purge` (`deployment/*/stop.sh`) | the install's own Compose file | No. The volumes survive a purge, like project volumes do today. |

A unit test pins that the volume's labels contain none of `shipit-session`,
`shipit-parent-session`, `com.docker.compose.project` and
`shipit-plugin-generation`.

## Which layout a session has (req 5)

One small file in the session's own directory records the layout:
`sessions/<id>/persist-layout`, with the content `volume`. The session directory
is sealed to the session (`session-worker-uid.ts`) and is never mounted into a
container (docs/270), so the agent cannot write the record. Checkout reclaim
removes only `workspace/`, `overlay/` and `state/` (`REGENERABLE_SESSION_SUBDIRS`,
`disk-utils.ts`), so the record survives it.

`persistLayout(sessionDir)` is synchronous and decides:

| Record | `scratch/` | Layout | Note |
|---|---|---|---|
| `volume` | absent | volume | The normal case. |
| `volume` | present | volume | A copy finished and the removal of `scratch/` did not; the next copy step finishes it. |
| absent | absent | volume | A new session, or one that never started. The function writes the record. |
| absent | present | scratch | Not copied yet. |

**The scratch directory is authoritative until the record says `volume`, and
only the copy step writes `volume` over an existing `scratch/`.** That is what
keeps a stray `scratch/` from causing data loss: a directory that some code
creates after the copy changes nothing, because nothing wipes a volume whose
record says `volume`.

Every caller that today builds a path under `scratch/` asks `persistLayout`
first: container creation, `ServiceManager.prepareStart`, the Compose helper,
the replay writer, the retention sweep and Full reset.

## Copy at the next start (req 5)

`ensurePersistVolume(sessionId)` runs before the agent container is created
(`createContainer`, `container-lifecycle.ts`) and before every Compose start
(`ServiceManager.prepareStart`). Both can run at once on a cold start: the
runner creates the container in the background while `setupServiceManager`
starts Compose (`app-lifecycle.ts`, `service-manager-setup.ts`), and Compose can
start before the agent container exists. So the function is single-flight per
session, and the second caller waits for the first.

The copy runs only when the layout is `scratch` **and the session has no
container at all**: no container labelled `shipit-session-id=<id>` (the agent,
`container-lifecycle.ts`) or `shipit-parent-session=<id>` (Compose services and
containers the agent made through the Docker proxy), in any state. A container
that exists still has the old mount. This happens when:

- ShipIt restarted and re-adopted a running agent container
  (`container-discovery.ts`);
- idle reclaim removed the agent container and kept the preview
  (`idle-enforcer.ts`, `preserveComposeOnDispose`).

Such a session stays on the old layout until a start with no container, at the
latest after the 24-hour hot→light step, which destroys everything
(`tier-escalation.ts`).

The steps:

1. Create the volume.
2. In one helper container (see *The helper*), as root, with the scratch
   directory mounted read-only at `/old` (a subpath of the workspace volume, as
   the agent container mounts it today) and the volume at `/new`:
   `find /new -mindepth 1 -delete && cp -a /old/. /new/`. The wipe makes the step
   repeatable after a crash. `cp -a` keeps owners, modes, ACLs and symlinks as
   symlinks; it follows none.
3. Write the record `volume`: write a temporary file, fsync it, rename it.
4. Remove `scratch/` with `fs.rm` (it is in the workspace volume).

| Crash or failure | Next call sees | What happens |
|---|---|---|
| During 1 or 2 | no record, `scratch/` | Steps 1–4 run again. Step 2 wipes the partial copy first. |
| Between 3 and 4, or during 4 | `volume`, `scratch/` | Step 4 runs again. |
| Step 2 fails (for example no disk space) | — | ShipIt logs it, empties the volume (best effort), and this start continues on the old layout. The next start tries again. |

The start waits for the copy. For a large `/persist` the first start after the
update is slower, once; ShipIt logs the size and the time.

## The agent container (req 4; docs/317 req 5)

For the volume layout, `buildMounts` (`container-lifecycle.ts`) mounts
`{Type: "volume", Source: "shipit-persist-<id>", Target: "/persist"}`, and
`createContainer` no longer creates `scratch/`. The scratch layout keeps today's
subpath mount.

Ownership needs no new code in the agent container. The worker entrypoint runs
`chown -R` on `/persist` when the marker directory `.shipit-uid-<uid>-<gid>-v3`
is missing (`docker/session-worker/entrypoint.sh`). A new volume has no marker,
so its empty root goes to the session user. A copied volume has the marker from
the copy, so nothing is changed again. The image has no `/persist` directory, so
Docker copies nothing into an empty volume.

## Compose services (reqs 1, 2, 3)

For the volume layout, the snapshot rewrite (`rewritePersistMount`,
`compose-generator.ts`) gives every `persist` mount the same shape:

```yaml
services:
  api:
    volumes:
      - type: volume
        source: persist
        target: /data
        volume: { nocopy: true, subpath: plan }   # no subpath for all of /persist
volumes:
  persist:
    name: shipit-persist-<session-id>
    external: true
```

- **Confinement (req 2).** Docker resolves a subpath by following its symlinks
  and then checking that the result is inside the volume root (`evaluatePath` in
  moby's `internal/safepath`, verified against v27.3.1 for docs/317). The root
  is now this session's `/persist`, so `/persist/plan → ../../..` or `→ /etc`
  cannot leave it. The shared-volume and bind-backed forms of docs/317 are not
  used for this layout.
- **Docker Desktop (req 1).** `dockerDesktopRefusal` keeps its `./sub` branch
  (not in scope). Its `persist/<sub>` branch applies only to a session on the
  scratch layout.
- **Native Linux (req 3).** Every `persist` form keeps working with the new
  shape. `./sub`, `.` and plugin mounts do not change.
- **Preparation.** A subpath must exist before the daemon mounts it, and the
  volume root must belong to the session (docs/317 req 5). Today
  `preparePersistDir` and `mkdirAsSession` (`compose-persist.ts`) do this with
  direct file operations. For the volume layout, one helper run does the same
  steps before each `up` that mounts `persist`: as root, it gives the volume
  root to the session uid and gid, sets `g+rwxs` and the default ACL `g::rwx`.
  Then, as the session uid (`gosu`), it runs `mkdir -p`, `chmod g+rwxs` and
  `setfacl -d -m g::rwx` for each subdirectory, with the names passed as
  arguments, not interpolated into the script. A symlink the agent planted
  reaches only the helper's own read-only, throwaway filesystem.
- `persistVolume` no longer resolves a daemon path for this layout. That path
  (`workspaceVolumeDaemonPath`) stays for `./sub` mounts on native Linux.

## ShipIt's own access to /persist

### The helper

`persist-volume.ts` gets one function that runs a short-lived container, in the
same way as `runInstallContainer` (`plugin-install.ts`):

- **Image:** the session worker image, with `Entrypoint: ["/bin/sh", "-c"]`. That
  bypasses the worker entrypoint, and the image has GNU coreutils, `find`,
  `setfacl` and `gosu`.
- **Isolation:** `NetworkMode: none`, `CapDrop: ALL`, a read-only root
  filesystem with a tmpfs `/tmp`, `no-new-privileges`, memory and pid limits.
- **Mounts:** only the volume at `/persist` (read-only unless the script
  writes), and for the copy, the scratch subpath at `/old`.
- **Capabilities, per script:**

| Script | Runs as | Capabilities |
|---|---|---|
| prepare | root, then the session uid | `CHOWN`, `FOWNER`, `SETUID`, `SETGID` |
| copy | root | `CHOWN`, `DAC_OVERRIDE`, `FOWNER` |
| measure and list | root, read-only mount | `DAC_READ_SEARCH` |
| empty | root | `DAC_OVERRIDE`, `FOWNER` |

A warm worker-image container measured 0.7–1.4 s wall clock on a real deployment
(`docs/262-plugins/real-instance-e2e.md`). The prepare run adds about that much
to a Compose start that mounts `persist`, and nothing to one that does not.

Rejected: the worker HTTP API. It has no file-write endpoint (verified across
`session-worker.ts` and its controllers). Also, `/persist` must be reachable
with no agent container: for a Compose start after idle reclaim, for a fork
child, and for an archived session.

### The confined Compose helper

`compose-helper.ts` mounts the scratch directory at its orchestrator path, so a
reference such as `build.context: ../scratch/app` resolves the same inside the
helper (`projectMounts`; docs/318 plan). For the volume layout it mounts the
volume at that same path (`type=volume,src=shipit-persist-<id>,dst=<sessionDir>/scratch`)
instead of checking `fs.existsSync`, so those references keep working.
`readWorkspaceFile` already reads inside the helper, so it needs only the mount.

### Replay files

After a rewind, a fork or a retry, the orchestrator writes long tool inputs and
results as files for the next agent and names them in the replay
(`services/replay-detail.ts`). Today they go to `scratch/replay`, which the
agent sees as `/persist/replay`. The writer can run before the target container
exists (a fork child) and while it runs (a retry during a turn).

For the volume layout the writer uses `sessions/<id>/replay`, an
orchestrator-owned directory in the workspace volume. Container creation mounts
it read-only at `/shipit-replay`, and the replay names `/shipit-replay/<file>`.
The path is computed in one place, `replaySpillDirs`, and no agent doc names it.
The writer empties the directory instead of removing it, because the mount holds
the directory itself and a replaced directory would not be visible in a running
container. The scratch layout keeps writing to `scratch/replay`.

### Retention (docs/323)

`data-retention-sweep.ts` keeps its schedule, its decisions and its notices. For
a session on the volume layout:

- **Measure** with the measure-and-list helper: the same rule as `treeBytes`
  (files only, `max(1, blocks × 512 || size)`), from `find /persist -type f`.
  The sweep measures a session only when its stored size is missing or older
  than the start of its period, so a session costs one helper run per period,
  plus one more before deletion.
- **List** the top-level names in the same run.
- **Delete** with the empty helper (`find /persist -mindepth 1 -delete`). The
  volume stays, as `scratch/` stays today, so a restore needs nothing (docs/323
  req 8). Emptying is used instead of `docker volume rm` because a volume that a
  container still mounts cannot be removed.
- Also empty `sessions/<id>/replay`, because those files were in `/persist`
  before.
- A layout `volume` with no volume yet (a session that never started) measures
  0 and deletes nothing.

### Full reset

`fullReset` (`services/misc.ts`) deletes the session directories but never
touches Docker volumes, and it leaves agent containers running (runner disposal
does not destroy them). It now lists the volumes labelled `shipit-persist-of`
(with the stack filter), removes each one, and empties a volume that is still in
use with the empty helper. The orphan sweep removes the object later.

### Orphan volumes

A volume whose session has no row leaks: `discardSpawnedChild`, a warm session
deleted with its repository, and the leftovers of a Full reset. A sweep in
`steady-state-reclaim.ts`, next to `sweepOrphanSessionDirs` and on the same
passes, removes a volume labelled `shipit-persist-of=<id>` when:

- `<id>` has no row (`allIds()`),
- `<id>` is not one of ShipIt's own reserved sessions (`isShipItOwnSession`; the
  cleanup container gets a `/persist` like any session),
- the volume is older than the 24-hour grace that `sweepOrphanSessionDirs` uses.

A volume in use fails to remove, and the next pass tries again.

## Lifecycle (docs/317 reqs 2, 8)

| Event | `/persist` and `persist` mounts | Why (verified) |
|---|---|---|
| Container restart, Rescue session, Restart agent | Kept | The volume is not tied to a container. `cleanupSessionDockerResources` selects `shipit-parent-session`. |
| Idle reclaim | Kept | `destroyAgentOnly` removes no volume. |
| 24 hours idle (hot → light) | Kept | See the table in *The volume*. |
| Checkout reclaim, then re-clone | Kept | The volume is outside the session directory; the record is in the session root. |
| Archive | Kept for the docs/323 period, then emptied | As above, then *Retention*. |
| Restore | Kept, or empty after the period | — |
| Full reset | Deleted | *Full reset*. |

The agent docs say the same thing in other words, so `environment.md` and the
docs/317 lifecycle table change only where they say *where* the files live.

## Backups (req 6)

`src/server/shipit-docs/wiki/installing-and-updating.md` changes in these
places:

- "Two Docker named volumes hold everything" becomes the workspace and
  credentials volumes **plus one `shipit-persist-<session-id>` volume per
  session**.
- The table row for `/persist` names that volume.
- "A whole-volume copy catches all of it" names all three kinds.
- The paragraph on project Compose volumes, and the database row in *What
  survives*, stop saying that `persist` files are in the workspace volume.
- The backup and restore scripts add the volumes from
  `docker volume ls -q --filter label=shipit-persist-of`. The restore keeps its
  rule: read every archive through before it deletes anything.

A restored install is consistent only if the persist volumes come from the same
backup as the workspace volume, because each session's record says `volume`. The
page says so in the "travel together" paragraph.

## Sessions still on the old layout

Until a session starts with no container, it stays on the scratch layout, and
the code for it stays: the subpath mount in the agent container, the docs/317
rewrite and its Docker Desktop refusal, the direct preparation, the scratch
mount in the Compose helper, `scratch/replay`, and the direct retention steps.
None of it is new. A session that is never started again stays on that layout,
and only the retention sweep and Full reset ever touch it.

A later change can remove the container-facing half of that code (the mounts,
the rewrite and the preparation) once no session on the old layout still has a
container from before the update. ShipIt logs at boot how many such sessions it
finds. After that removal, a failed copy fails the start with its reason instead
of continuing on the old layout. That is a follow-up on planning#696, not part
of this change.

## Rejected alternatives

- **Docker Desktop only.** The user chose every host (requirements, resolved
  questions). One layout means one backup procedure and one retention path.
- **Copy every session at boot.** The user chose the next start (req 5). Also, a
  copy at boot races with re-adopted containers that still write to `scratch/`.
- **Decide the layout by whether the volume exists**, with no record. A crash
  during the copy leaves a volume with part of the files, and the only safe
  commit point would be the removal of `scratch/`, which is not atomic. A record
  written after the copy is.
- **Remove the volume at the end of the retention period.** It fails for a
  volume in use, and it needs a step at restore. Emptying matches what the sweep
  does to `scratch/` today.
- **The label `shipit-session=<id>`**, which other ShipIt volumes use:
  `pruneSessionVolumes` selects it.
- **A bind-backed or overlay volume over `scratch/`**: rejected in docs/317,
  "Docker Desktop".
- **Replay files written into the volume through the helper**: a helper run for
  every rewind, fork and retry, for files that are not the user's data.

## Key files

- New: `src/server/orchestrator/persist-volume.ts` — the name and labels,
  `persistLayout`, `ensurePersistVolume` (single-flight, the copy), and the
  helper scripts.
- `container-lifecycle.ts` — `buildMounts` (volume or subpath, the
  `/shipit-replay` mount), `createContainer` (no `scratch/` for the volume
  layout).
- `compose-generator.ts` — `rewritePersistMount`, the `external` `persist`
  declaration, `dockerDesktopRefusal` limited to the scratch layout.
- `service-manager.ts`, `compose-persist.ts` — preparation through the helper;
  `persistVolume`.
- `compose-helper.ts` — `projectMounts`.
- `services/replay-detail.ts` — `replaySpillDirs`, the emptying writer.
- `data-retention-sweep.ts` — measure, list and empty through the helper.
- `services/misc.ts` — `fullReset`.
- `steady-state-reclaim.ts` — the orphan volume sweep.

## Verification

- **Unit tests:**
  - `persistLayout` for each row of its table.
  - The copy for each crash point, with a fake Docker: no wipe when the record
    says `volume`; no copy while a container exists.
  - The single-flight between container creation and `prepareStart`.
  - The rewrite shapes for both layouts, and no Docker Desktop refusal for
    `persist/<sub>` on the volume layout.
  - The helper arguments: capabilities, mounts, names passed as arguments.
  - The label guard.
  - The retention sweep, Full reset and the orphan sweep for the volume layout.
  - The replay writer empties and does not replace its directory.
  - Each new test must fail without its change (a mutation pass).
- **On a Docker Desktop host after the deploy:**
  - An existing session with files in `/persist` starts, and the files are
    there with their owners.
  - `docker volume ls` shows `shipit-persist-<id>`, and `sessions/<id>/scratch`
    is gone.
  - A service with `persist/plan:/data` starts and sees `/persist/plan`, as the
    session user, and can write there.
  - Symlinks `/persist/esc → /` and `/persist/up → ../../..`, each mounted as
    `persist/<name>`, show the service nothing outside `/persist`. Docker
    either refuses the mount or resolves the link inside the volume.
- **On a native Linux host:** the same checks, and every `persist` form of
  docs/317 still starts.
- After a rewind, the replay names `/shipit-replay/…` files, and the agent can
  read them.
