---
issue: planning#696
title: /persist in a Docker volume of its own — design
description: Each session's /persist moves from sessions/<id>/scratch in the workspace volume into a named volume of its own, on every host, so Docker confines a persist/<sub> mount to that session on Docker Desktop too.
---

# 331 — /persist in a Docker volume of its own: design

Implements [`requirements.md`](./requirements.md). Built as designed; the
[`checklist.md`](./checklist.md) records the build, and *Implementation notes*
records where the build adds to this design.

## Summary

Today `/persist` is the directory `sessions/<id>/scratch` inside the shared
workspace volume. The agent container mounts it as a subpath of that volume, and
a Compose service's `persist/<sub>` mount needs a bind-backed volume whose device
is that directory. Docker Desktop looks that device up on the host, so ShipIt
refuses the mount there (`docs/317-compose-persist-mount/plan.md`, "Docker
Desktop").

After this change each session's `/persist` is a plain named volume of its own,
on every host (req 4). A service's `persist/<sub>` mount is a subpath of that
volume, and Docker confines a subpath to the root of its volume, which is now
this session's `/persist` and nothing else (reqs 1, 2). An existing session's
files are copied into its volume at its next start (req 5). The orchestrator
cannot read a Docker volume, so the few places where ShipIt itself touches
`/persist` go through one helper-container function, and one per-session gate
orders every user of `/persist`.

## The volume (req 4)

- **Name:** `shipit-persist.<workspace volume>.<session-id>`, for example
  `shipit-persist.shipit_workspace.<uuid>`.
  - The middle part is the install's own workspace volume (`WORKSPACE_VOLUME`,
    `deployment/vps/docker-compose.yml`), so two installs on one daemon never
    share a name. Two installs cannot share a workspace volume either, so this
    isolation is as strong as today's, where `/persist` is inside that volume.
  - The name starts with `shipit-p`. The boot sweep's pattern
    `^shipit-([a-f0-9-]{12})_` needs a hexadecimal digit or `-` there, so it can
    never match, whatever the workspace volume is called. A prefix of the
    workspace volume name would not have that property: a custom
    `WORKSPACE_VOLUME=shipit-abcdef123456_ws` would match the pattern.
- **Found by name.** Full reset, the orphan sweep and the backup list persist
  volumes by the prefix `shipit-persist.<workspace volume>.` and read the
  session id from the rest of the name. No code selects them by label, so a
  volume that Docker created implicitly (a mount of a missing named volume
  creates it, with no labels) is still found.
- **Labels:** `shipit-managed=true` and `stackLabel(DOCKER_STACK)`, by
  convention (`stack-label.ts`, planning#584). They select nothing.
- **Driver:** `local`, with no `driver_opts`. A plain named volume lives where
  the daemon keeps its volumes: in `/var/lib/docker/volumes` on native Linux and
  inside the VM on Docker Desktop. No host path is looked up, so the Docker
  Desktop problem of docs/317 does not apply.
- **Created by** `ensureVolume` (dockerode `createVolume`, idempotent for
  an existing name). Every mount site gets the name only from that function, so
  the volume exists before anything mounts it.

No existing removal path matches the volume (verified at the source):

| Removal path | Selects by | Matches the new volume? |
|---|---|---|
| `pruneSessionVolumes` (`startup-janitor.ts`), on archive, hot→light and discard | `volume prune --filter label=shipit-session=<id>` | No. The volume does not carry `shipit-session`: on an engine older than 23, `volume prune` also removes named volumes. |
| `sweepOrphanSessionVolumes` (`startup-janitor.ts`), at boot | name `^shipit-([a-f0-9-]{12})_` | No. The character after `shipit-` is `p`. A test pins this for the two standard workspace volume names and for a custom one that starts with `shipit-<12 hex digits>_`. |
| `removeProjectVolumes` (`compose-cli.ts`), after `down --volumes` | `com.docker.compose.project` | No. ShipIt creates the volume, and Compose neither labels nor removes an `external: true` volume (Compose's documented behaviour). |
| `cleanupSessionDockerResources` (`container-lifecycle.ts`), on every destroy | `shipit-parent-session=<id>` | No. That label would also let the agent delete the volume through the Docker proxy (`docker-proxy-auth.ts`), so it must never be set. |
| `reapOrphanPluginInstalls` (`plugin-install.ts`), at boot | `shipit-plugin-generation` | No. |
| `stop.sh --purge` (`deployment/*/stop.sh`) | the install's own Compose file | No. The volumes survive a purge, as project volumes do today. |

A unit test pins that the labels contain none of `shipit-session`,
`shipit-parent-session`, `com.docker.compose.project` and
`shipit-plugin-generation`.

## Which layout a session has (req 5)

One small file in the session's own directory records the layout:
`sessions/<id>/persist-layout`, with the content `volume`. The session directory
is sealed to the session (`session-worker-uid.ts`) and no container mounts it,
only its children (`container-lifecycle.ts`, docs/270), so the agent cannot
write the record. Checkout reclaim removes only `workspace/`, `overlay/` and
`state/` (`REGENERABLE_SESSION_SUBDIRS`, `disk-utils.ts`), so the record
survives it.

`persistLayout(sessionDir)` is synchronous and decides:

| Record | `scratch/` | Layout | Note |
|---|---|---|---|
| `volume` | absent | volume | The normal case. |
| `volume` | present | volume | A copy finished and the removal of `scratch/` did not; the next copy step finishes it. |
| absent | absent | volume | A new session, or one that never started. The function writes the record. |
| absent | present | scratch | Not copied yet. |

**The scratch directory is authoritative until the record says `volume`, and
only the copy writes `volume` over an existing `scratch/`.** So a stray
`scratch/` that some code creates later changes nothing: nothing wipes a volume
whose record says `volume`.

## One gate for every user of /persist

`/persist` has users inside the orchestrator process and containers that can
outlive it. Each kind is ordered differently.

**Inside the process**, a per-session read-write gate in `persist-volume.ts`:

- **Shared:** creating the agent container; a Compose start, from the moment it
  reads the layout to the end of its `up`; and every other run of the confined
  Compose helper (a read, `config`, `build`).
- **Exclusive:** the copy, a retention deletion, and Full reset of that session.

Compose can start before the agent container exists on a cold start
(`app-lifecycle.ts` creates the container in the background while
`service-manager-setup.ts` starts Compose), and `ServiceManager.start` reads the
project file through the helper before `prepareStart` (`service-manager.ts`). So
the gate wraps the helper runs themselves, not only `prepareStart`.

A Compose start holds one lease across the whole sequence because its snapshot
names the layout's mounts. With a lease per helper run, a copy could take the
gate between `prepareStart` and a queued `up` (`buildAndUp`, `service-manager.ts`),
and that `up` would mount a `scratch/` that no longer exists. The cost is that a
copy waits for a running `up`, including its build.

Three rules keep the gate free of deadlocks:

1. **The copy runs before the shared lease is taken.** Agent container
   creation first calls `forAgent`, which may take and release the
   exclusive side, and only then takes the shared side for the creation itself.
2. **A holder of the exclusive side runs its helpers under that lease.** The
   measure and empty runs of a retention deletion borrow it; they do not ask
   for the shared side.
3. **Nothing waits for the session's stack queue (`serializeStackOp`,
   `stack-op-queue.ts`) while it holds the exclusive side.** A Compose start
   holds that queue and then waits for the shared side, so the exclusive side
   must never wait for the queue. The copy stops a stack directly through Docker
   (below), not through the queue.

**Containers that can outlive their lease.** Every persist helper container
carries `shipit-persist-helper=<session-id>`. Helpers of this process run under
the shared side, or borrow the exclusive one, so when an exclusive section
begins no helper of the session runs legitimately. The section first
force-removes every persist helper of the session that still exists, then checks
that the session has no container at all, in any state:

- `shipit-session-id=<id>`: the agent container (`container-lifecycle.ts`);
- `shipit-parent-session=<id>`: Compose services, and containers the agent made
  through the Docker proxy (`compose-generator.ts`, `docker-proxy.ts`);
- `shipit-compose-helper=<id>`: confined Compose helpers (`compose-helper.ts`);
- `shipit-persist-helper=<id>`: a helper that could not be removed.

A persist helper that still exists can still be writing: a copy that was running
when ShipIt crashed, or one whose removal failed after a timeout. Removing it
before the new section begins is what makes a repeated wipe and copy safe. The
removal takes only this install's containers (the stack label); the check sees
every install's, because it removes nothing.

## Copy at the next start (req 5)

"The next start" is the next time ShipIt creates the session's agent container
(`createContainer`, `container-lifecycle.ts`). Only that path copies;
`ServiceManager.prepareStart` waits at the gate and uses whatever layout the
session then has.

Under the exclusive gate, when the layout is `scratch`:

1. If the session's Compose stack runs, note which services run, then remove
   their containers with `downComposeStackByProject`
   (`compose-stack-reaper.ts`), which calls Docker directly and keeps volumes.
   The stack runs after idle reclaim, which keeps the preview
   (`idle-enforcer.ts`, `preserveComposeOnDispose`), and after a cold start in
   which Compose came first.
   - `ServiceManager.stop` is not used, because it disposes the manager
     (`_disposed`), and an adopted manager is not started again
     (`setupServiceManager` returns it unchanged, `service-manager-setup.ts`).
   - After the gate is released, container creation calls
     `restartService(name)` on the session's `ServiceManager` for each noted
     service, so the preview restarts once, with the new mounts.
   - Container creation reaches the manager through the app's `serviceManagers`
     map. The map is created after the runner factory (`bootstrap-managers.ts`),
     so the factory gets a late-bound accessor.
2. Remove leftover persist helpers and check for containers, as above. If a
   container remains, for example an agent container that ShipIt re-adopted
   after a restart, the session stays on the scratch layout for this start.
3. Create the volume.
4. In one helper container, with the scratch directory mounted read-only at
   `/old` (a subpath of the workspace volume, as the agent container mounts it
   today) and the volume at `/new`, run:
   `find /new -mindepth 1 -delete && cp -a /old/. /new/ && sync -f /new`.
   - The wipe makes the step repeatable.
   - `cp -a` keeps owners, modes, ACLs and symlinks, and it follows no symlink.
   - `sync -f` flushes the copy before anything depends on it.
5. Write the record: write a temporary file, fsync it, rename it, fsync the
   session directory.
6. Remove `scratch/` with `fs.rm`.

| Crash or failure | Next start sees | What happens |
|---|---|---|
| During 1–4, a ShipIt crash | no record, `scratch/` | Steps 1–6 run again. Step 2 removes a copy helper that is still running; step 4 wipes the partial copy. |
| During 1–4, a host or VM crash | no record, `scratch/` | The same. |
| Between 5 and 6, or during 6 | `volume`, `scratch/` | Step 6 runs again. |
| Step 4 fails (for example no disk space) | — | ShipIt logs it, empties the volume (best effort), and this start continues on the scratch layout. The next start tries again. |

The start waits for the copy, so for a large `/persist` the first start after
the update is slower, once. ShipIt logs the size and the time.

A session whose agent container is never created again stays on the scratch
layout. That is the user's choice of "copy at next start" (requirements,
resolved questions).

## The agent container (req 4; docs/317 req 5)

For the volume layout, `buildMounts` (`container-lifecycle.ts`) mounts
`{Type: "volume", Source: <persist volume>, Target: "/persist"}`, and
`createContainer` no longer creates `scratch/`. The scratch layout keeps
today's subpath mount.

Ownership needs no new code in the agent container. The worker entrypoint runs
as root without `DAC_OVERRIDE`. It runs `chown -R` on `/persist` when root can
still write it and the marker directory `.shipit-uid-<uid>-<gid>-v3` is missing
or has the wrong owner (`docker/session-worker/entrypoint.sh`). A new volume's
root belongs to root and has no marker, so it goes to the session user. A copied
volume's root already belongs to the session user, so root cannot write it and
nothing is changed. The image has no `/persist` directory, so Docker copies
nothing into an empty volume.

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
    name: shipit-persist.<workspace volume>.<session-id>
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
  steps before each `up` that mounts `persist`:
  - As root, it gives the volume root to the session uid and gid, sets
    `g+rwxs`, and sets the default ACL `g::rwx`.
  - Then, as the session uid (`gosu`), it runs `mkdir -p`, `chmod g+rwxs` and
    `setfacl -d -m g::rwx` for each subdirectory. The names are passed as
    arguments, never put into the script text.
  - A symlink the agent planted reaches only the helper's own read-only,
    throwaway filesystem.
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
  filesystem with a tmpfs `/tmp`, `no-new-privileges` (which does not stop
  `gosu`, a root process dropping its own privileges), memory and pid limits.
- **Mounts:** only the volume at `/persist` (read-only unless the script
  writes), and for the copy, the scratch subpath at `/old`.
- **Labels:** `shipit-persist-helper=<session-id>` and the stack label.
- **Capabilities, per script:**

| Script | Runs as | Capabilities |
|---|---|---|
| prepare | root, then the session uid | `CHOWN`, `FOWNER`, `FSETID`, `SETUID`, `SETGID` |
| copy | root | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID` |
| measure | root, read-only mount | `DAC_READ_SEARCH` |
| empty | root | `DAC_OVERRIDE`, `FOWNER` |

`FSETID` is needed because Linux clears the setgid bit when root, without that
capability, sets it on a file whose group is not root's (`chmod(2)`). Today the
orchestrator has it, because it runs as a full root process.

A warm worker-image container measured 0.7–1.4 s wall clock on a real deployment
(`docs/262-plugins/real-instance-e2e.md`). The prepare run adds about that much
to a Compose start that mounts `persist`, and nothing to one that does not.

Rejected: the worker HTTP API. It has no file-write endpoint (verified across
`session-worker.ts` and its controllers). Also, `/persist` must be reachable
with no agent container: for a Compose start after idle reclaim and for an
archived session.

### The confined Compose helper

`compose-helper.ts` mounts the scratch directory at its orchestrator path, so a
reference such as `build.context: ../scratch/app` resolves the same inside the
helper (`projectMounts`; docs/318 plan). For the volume layout it mounts the
volume at that same path (`type=volume,src=<persist volume>,dst=<sessionDir>/scratch`)
instead of checking `fs.existsSync`, so those references keep working.
`readWorkspaceFile` already reads inside the helper, so it needs only the mount.
Each run holds the shared side of the gate (see above).

### Replay files

After a rewind, a fork or a retry, the orchestrator writes long tool inputs and
results as files for the next agent and names them in the replay
(`services/replay-detail.ts`). Today they go to `scratch/replay`, which the
agent sees as `/persist/replay`. The writer runs synchronously, before the
target container exists (a fork child) or while it runs (a retry during a turn).

They move to `sessions/<id>/uploads/.shipit-replay`, for both layouts, and the
replay names `/uploads/.shipit-replay/<file>`:

- Every agent container already mounts `uploads/` read-only at `/uploads`
  (`container-lifecycle.ts`), including containers from before the update, and
  the orchestrator already writes there (`prompt-assembly.ts`).
- The upload list shows files only and skips directories (`listUploads`,
  `services/files.ts`). An upload cannot be called `.shipit-replay`, because the
  upload name loses its leading dots.
- The upload delete route (`api-routes-files.ts`, `deleteUpload`) accepts any
  path below the uploads directory today, so
  `.shipit-replay%2F001-Bash.txt` would delete a replay file. It is limited to
  one name with no `/` and no leading dot.
- A fork copies only the uploads its messages name (`copyUploadsForFork`), so it
  does not carry the parent's replay files.
- The writer keeps replacing its own directory, which is inside the mount, so a
  running container sees the new files.
- The path is computed in one place, `replaySpillDirs`, and no agent doc names
  it.
- So the replay writer never touches `/persist` and needs neither the gate nor
  the layout.

The retention sweep measures and deletes these files as part of the uploads, as
it measured and deleted them as part of `/persist` before. A notice for a
session with no other uploads then says "uploads" for them.

### Retention (docs/323)

`data-retention-sweep.ts` keeps its schedule, its decisions and its notices. For
a session on the volume layout:

- **Measure** with the measure helper, by the same rule as `treeBytes`: every
  entry that is not a directory, symlinks included, by `lstat`,
  `max(1, blocks × 512 || size)`. The helper runs
  `find /persist -mindepth 1 ! -type d -printf '%b %s\n'`, and the orchestrator
  sums the result. The sweep measures a session only when its stored size is
  missing or older than the start of its period, so this is one helper run per
  period, plus one before deletion.
- **Delete** under the exclusive gate:
  1. Check again that the session is still due, inside the gate.
  2. Require that the session has no container (see the gate). Otherwise, skip
     it for this pass. The sweep already stops the Compose stack first.
  3. Measure, then run the empty helper (`find /persist -mindepth 1 -delete`).
  The gate keeps a restore and a start from creating a container until the
  deletion ends, so the helper can delete nothing that was written after the
  check. Because nothing else writes during the deletion, the sweep empties the
  volume and does not need the top-level names that it lists for the scratch
  layout.
- The volume stays, as `scratch/` stays today, so a restore needs no step
  (docs/323 req 8). Emptying is used instead of `docker volume rm`, which fails
  for a volume in use.
- A layout `volume` with no volume yet (a session that never started) measures
  0 and deletes nothing.

Not changed, and not part of this design: a manual reset or a rebase replaces a
pending agent notice (`sessions.ts`), including a retention notice. That is a
known gap of docs/323 req 9.

### Full reset

`fullReset` (`services/misc.ts`) removes project volumes only through Compose
(`removeVolumesOnDispose`). Its gaps for `/persist`:

- Runner disposal does not destroy the agent containers
  (`container-session-runner.ts`).
- A Compose stack kept after idle reclaim has no runner to dispose.
- `destroyContainer` returns at once when ShipIt has no record of the session's
  agent container (`container-lifecycle.ts`), and idle reclaim removes that
  record, so `destroy` cannot be relied on.

So after `disposeAll` and before the session directories are deleted, Full
reset does this:

1. Stop every `ServiceManager` in the `serviceManagers` map, with volumes, not
   only the managers of live runners.
2. For each persist volume of this install (found by name):
   - take that session's exclusive gate;
   - remove, by label, every container of the session (the three labels listed
     under the gate, and `shipit-persist-helper`);
   - check that none is left, and remove the volume.

A removal that still fails is logged, and the orphan sweep tries again.

### Orphan volumes

A volume whose session has no row leaks: `discardSpawnedChild`, a warm session
deleted with its repository, and a failed Full reset removal. A sweep in
`steady-state-reclaim.ts`, next to `sweepOrphanSessionDirs` and on the same
passes, removes a persist volume of this install when:

- its session id has no row (`allIds()`);
- the id is not one of ShipIt's own reserved sessions (`isShipItOwnSession`; the
  cleanup container gets a `/persist` like any session);
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
  credentials volumes **plus one `shipit-persist.<workspace volume>.<session-id>`
  volume per session**.
- The table row for `/persist` names that volume. "A whole-volume copy catches
  all of it" names all three kinds.
- The paragraph on project Compose volumes, and the database row in *What
  survives*, stop saying that `persist` files are in the workspace volume.
- The "travel together" rule covers the persist volumes too. Each session's
  record says `volume`, so a workspace volume restored without its persist
  volumes gives those sessions an empty `/persist`.
- The backup script writes one archive per volume, named after the volume, and
  it adds every volume whose name starts with
  `shipit-persist.<workspace volume>.`.
- The restore script works from the archives, not from the destination daemon,
  which has none of these volumes yet:
  - It restores every `shipit-persist.*.tar` in the backup directory.
  - It reads every archive through before it deletes anything, as it does today.
  - When the destination's workspace volume has a different name (a local
    backup restored on a VPS), it replaces the middle part of each name, as it
    already substitutes the two main names.
  - Labels are not restored, and nothing needs them.

## Sessions still on the scratch layout

Until its agent container is created again, a session stays on the scratch
layout, and the code for it stays:

- the subpath mount in the agent container;
- the docs/317 rewrite and its Docker Desktop refusal;
- the direct preparation;
- the scratch mount in the Compose helper;
- the direct retention steps.

None of it is new. A later change can remove the container-facing part (the
mounts, the rewrite and the preparation) once no such session has a container.
From then on, a failed copy fails the start instead of continuing on the scratch
layout. That is a follow-up on planning#696, not part of this change.

## Implementation notes

What the build adds to the design above, each verified by a test:

- **The gate is its own module**, `persist-gate.ts`, with no imports, so the
  Compose helper and the service manager use it without importing the volume
  code. The lease follows the async context (`AsyncLocalStorage`): a request
  inside an exclusive lease borrows it (rule 2), a shared request inside a
  shared lease is counted at once, so a waiting exclusive request cannot
  deadlock a Compose start whose own helper run asks again, and an exclusive
  request inside a shared lease is refused. Work started inside a lease that
  runs after the lease ends asks again.
- **The exclusive side has a wait limit.** A hung `up` must not hold an agent
  start for ever. The copy waits 2 minutes and then leaves the session on the
  scratch layout for this start; a retention deletion waits 1 minute and then
  waits for the next pass; Full reset waits 2 minutes per session and then logs
  the volume for the orphan sweep.
- **The measure helper sums in the container** with `awk`, by the same rule, so
  its output is one number and no log limit of the daemon can cut it. A test
  runs the script on this host and compares it with `treeBytes`.
- **The copy also sets the volume root's owner and mode** from `scratch/`
  (`chown --reference`, `chmod --reference`), so the worker entrypoint finds the
  root handed over and does not run `chown -R`. It prints the size (`du -sk`)
  for the log line.
- **The agent container mounts the volume with `NoCopy`**, as every service
  mount does.
- **The container check before an exclusive section uses no stack filter**: a
  container of another install with the same session id defers the copy rather
  than risk a writer. **Every removal does use it** — the stack, the helpers,
  Full reset — so one install never removes another's containers.
- **Stale helpers.** Every persist helper that exists at the start of an
  exclusive section is stale, so the section removes all of them, whatever their
  boot id. Outside an exclusive section helpers of this process can run, so a
  mount (agent creation, the Compose start and every confined Compose helper
  run) removes only the stale ones: those with another boot id, checked once
  per session and process, and those this process could not remove at the end
  of their run, until none is left. The check runs one at a time per session.
  When a stale helper cannot be removed, the mount is refused: a retention
  `empty` that was running when ShipIt stopped could otherwise delete what the
  restored session writes. Agent creation resolves its mount under its shared
  lease for this reason, after `forAgent`.
- **A volume ShipIt did not make is refused.** Docker keeps the labels of an
  existing volume, so `ensureVolume`, `measure` and `empty` inspect it, and refuse one that has
  another driver, driver options, or a label that a removal path or the Docker
  proxy selects by (`unsafePersistVolume`). During the copy that leaves the
  session on `scratch/`; on the volume layout the start fails. The Docker proxy
  also refuses to create a volume whose name starts with `shipit-persist.`, so a
  session cannot make another session's volume in advance and own it.
- **The record is final once renamed into place.** A failed flush of the
  directory after the rename is logged, not thrown, so the agent cannot start on
  `scratch/` while the record says `volume`. Agent creation asks the layout
  again under its shared lease, so it uses the volume if another start copied in
  between.
- **The copy keeps its restart list** whatever fails after the stack was removed.
- **A measure with no output is a failure**, not a size of 0.
- **Retention decides again after each part it deleted**, because a restore
  does not take the `/persist` lease: a session restored while its volume was
  emptied keeps its uploads and its checkout. On the volume layout it also
  counts and removes a `scratch/` that a finished copy left (the volume holds
  the same files), so a failed removal is tried again.
- **The orphan sweep removes the session's persist helpers first**, which a
  crash can leave holding the volume.
- **The Docker Desktop refusal for the scratch layout says what changes it**:
  the next start of the session's container moves `/persist` into its volume.
- `demultiplex` moved from `plugin-install.ts` to `plugin-container.ts`, which
  the helper runner shares; the boot sweep's pattern is exported from
  `startup-janitor.ts` (`SESSION_VOLUME_RE`) for the name test.
- The wiki page `sessions.md` needed no change: what it says about `/persist`
  and its retention is still true.

## Known limits

- Full reset takes one list of volumes. An activation that runs during the reset
  can create a volume or a container after it; that volume then has no session
  row, so the orphan sweep removes it a day later, when nothing uses it.
- The tier escalation stops a session's Compose stack by project name with no
  stack filter, as it did before this change (`startup-monitors.ts`). Two
  installs on one daemon share a project name only for a session id that both
  have, which happens when one is restored from the other's backup. The
  retention sweep's teardown now passes the filter; the tier escalation is left
  for a separate change.

## Rejected alternatives

- **Docker Desktop only.** The user chose every host (requirements, resolved
  questions). One layout means one backup procedure and one retention path.
- **Copy every session at boot.** The user chose the next start (req 5).
- **Fail the start when the copy fails**, instead of continuing on the scratch
  layout. It removes a little code, but a defect in the copy would then stop
  every session from starting after the update.
- **Decide the layout by whether the volume exists**, with no record. A crash
  during the copy leaves a volume with part of the files, and the only safe
  commit point would be the removal of `scratch/`, which is not atomic. A record
  written after a flushed copy is.
- **Name the volume after the session only.** Two installs on one daemon, one
  of them restored from the other's backup, would share every volume.
- **Start the name with the workspace volume name.** A custom workspace volume
  name can then match the boot sweep's pattern, which would delete the volume.
- **Select the volumes by label.** A volume that Docker creates implicitly has
  no labels, and a restore loses them.
- **Remove the volume at the end of the retention period.** It fails for a
  volume in use, and it needs a step at restore. Emptying matches what the sweep
  does to `scratch/` today.
- **A bind-backed or overlay volume over `scratch/`**: rejected in docs/317,
  "Docker Desktop".
- **A separate read-only mount for replay files**: one more mount, a
  layout-dependent path, and containers from before the update would not have
  it. `/uploads` already exists in every container.

## Key files

- New: `src/server/orchestrator/persist-volume.ts`:
  - the volume name;
  - `persistLayout`;
  - `PersistVolumes`: `ensureVolume`, `forAgent` with the copy, `forSession`
    for Compose, `measure`, `empty`, `blockingContainer`, `removeAllForReset`,
    `sweepOrphans`;
  - the helper runner and its four scripts;
  - `restartKeptServices`.
- New: `src/server/orchestrator/persist-gate.ts` — the per-session gate.
- `session-container.ts` — creates `PersistVolumes` when a workspace volume is
  configured, and holds the late-bound restarter.
- `container-lifecycle.ts` — `buildMounts`; `createContainer` copies under the
  gate, restarts a kept preview after it, and no longer creates `scratch/` for
  the volume layout.
- `bootstrap-managers.ts` — sets the late-bound restarter, which reads the
  `serviceManagers` map, on the container manager.
- `compose-generator.ts` — `rewritePersistMount`, the `external` `persist`
  declaration, `dockerDesktopRefusal` limited to the scratch layout.
- `service-manager.ts`, `compose-persist.ts` — preparation through the helper;
  `persistVolume`.
- `compose-helper.ts` — `projectMounts`, and the shared gate around each run.
- `services/replay-detail.ts` — `replaySpillDirs`.
- `services/files.ts` — `deleteUpload` takes one name only.
- `data-retention-sweep.ts` — measure and empty through the helper, under the
  gate.
- `services/misc.ts` — `fullReset`; `api-routes-bootstrap.ts` passes it the
  map and the volumes.
- `steady-state-reclaim.ts` — the orphan volume sweep; `startup-monitors.ts`
  passes the volumes to it and to the retention sweep.

## Verification

- **Unit tests:**
  - `persistLayout` for each row of its table.
  - The copy with a fake Docker:
    - each crash point;
    - no wipe when the record says `volume`;
    - no copy while any listed container exists;
    - a leftover helper is removed first, and one that cannot be removed
      defers the copy;
    - a running Compose stack is stopped first;
    - the record is written only after the flush.
  - The gate: a Compose helper run, a Compose start from layout to `up`, the
    copy and a retention deletion exclude each other in the right way, and the
    three rules hold (no deadlock when a start holds the stack queue).
  - A kept preview runs again, with the new mounts, after the copy.
  - Full reset removes a kept stack that has no agent record, and then the
    volume.
  - The upload delete route refuses `.shipit-replay/…`.
  - The rewrite shapes for both layouts, and no Docker Desktop refusal for
    `persist/<sub>` on the volume layout.
  - The helper arguments: capabilities, mounts, labels, names passed as
    arguments.
  - The volume name against the boot sweep's pattern, and the label guard.
  - The retention measure rule (symlinks counted), the deletion under the gate,
    Full reset, and the orphan sweep.
  - Replay files land in `uploads/.shipit-replay`, and the upload list does not
    show them.
  - Each new test must fail without its change (a mutation pass).
- **On a Docker Desktop host after the deploy:**
  - An existing session with files in `/persist` starts, and the files are
    there with their owners, modes and setgid bits.
  - `docker volume ls` shows the persist volume, and `sessions/<id>/scratch` is
    gone.
  - A service with `persist/plan:/data` starts, sees `/persist/plan` as the
    session user, and can write there.
  - Symlinks `/persist/esc → /` and `/persist/up → ../../..`, each mounted as
    `persist/<name>`, show the service nothing outside `/persist`. Docker
    either refuses the mount or resolves the link inside the volume.
  - A rewind names `/uploads/.shipit-replay/…` files, and the agent can read
    them.
- **On a native Linux host:** the same checks, and every `persist` form of
  docs/317 still starts.
- **Backup and restore**, on a test install: back up, restore on a second
  daemon, and check that a session's `/persist` files are there.
