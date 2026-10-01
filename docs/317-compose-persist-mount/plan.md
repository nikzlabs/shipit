---
issue: planning#618
title: Compose services can mount the session's /persist
description: A reserved `persist` volume in docker-compose.yml mounts the session's own /persist (or a subdirectory) into a service, with Docker confining the subpath to that directory.
---

# Compose services can mount the session's /persist

Implements [`requirements.md`](./requirements.md).

## Problem

A Compose service had no durable, writable place of its own. `/persist` existed only in the agent container. The alternatives all lose data: a project's named volume can be deleted when the session is archived or idles for a day (`tier-escalation.ts` runs `compose down --volumes` on the hot → light step), and a gitignored workspace folder is lost when the checkout is reclaimed and re-cloned. A named volume at a new path is also root-owned, so a service running as the session UID cannot write it.

## Declaration: a reserved volume called `persist` (reqs 1, 3)

```yaml
services:
  api:
    volumes:
      - persist:/data                  # all of /persist
      - persist/verseshot:/renders     # /persist/verseshot
      - persist/cache:/cache:ro        # read-only
      - type: volume                   # long form, any subdirectory
        source: persist
        target: /media
        volume: { subpath: verseshot/media }
```

`persist` is an ordinary Compose named-volume reference, the same way `.:/app` is an ordinary relative bind that ShipIt rewrites. The short form and the long form with `volume.subpath` are valid Compose outside ShipIt when the file also declares `volumes: { persist: {} }`, so a developer can run the file locally against a plain volume. `persist/<sub>:` is shorthand that only ShipIt understands. It is accepted because the request proposed it and it costs one branch in the parser. An `x-shipit-*` key was rejected: it would duplicate what Compose's own volume syntax already says.

Rejected alternative: an absolute `/persist:/data` source. Every absolute source is refused today, and a special case there would make one host path look allowed.

## Mechanism

`parseComposeFile` records each service's `persistSubpaths` (`persistSubpathOf`). `generateComposeOverride` then:

1. rewrites each `persist` entry to the long form `{type: volume, source: persist, target, volume: {nocopy: true, subpath?}, read_only?}`, in both the volume-backed and the bind deployment;
2. declares the top-level volume `persist` as a **bind-backed local volume** whose device is the session's scratch directory — the directory the agent sees at `/persist`:

```yaml
volumes:
  persist:
    name: shipit-<session12>_shipit-persist
    driver: local
    driver_opts: { type: none, o: bind, device: <daemon path of sessions/<id>/scratch> }
    labels: { shipit-managed: "true", shipit-session: <id> }
```

The definition replaces a `persist` volume the project declares. The explicit `name` differs from `<project>_persist`, a plain volume an earlier version of the file may already have created; reusing that name would make Compose keep the plain volume. The `shipit-<session12>_` prefix lets the boot janitor sweep a stale volume object.

`ServiceManager` prepares the directory before every `up` (`preparePersistDirs`, from `withUpInFlight` and `writeOverrideFor`), because a volume subpath must exist when the daemon mounts it and the agent can delete one. It resolves the daemon path through `persistDevicePath`: in the volume-backed deployment that is the workspace volume's `Mountpoint` plus the scratch directory's path in it (`workspaceVolumeDaemonPath`); in the bind deployment the orchestrator's path already is the daemon's.

### Why a bind-backed volume and not a subpath of the workspace volume (reqs 4, 6)

The obvious implementation — `source: shipit-workspace` with `subpath: sessions/<id>/scratch/<sub>`, like `.:/app` — is not safe. Docker resolves a subpath by following its symlinks and then checking only that the result is inside the **volume root** (`evaluatePath` in moby's `internal/safepath`, verified against v27.3.1). The workspace volume's root holds every session, so a relative symlink planted at `/persist/<sub>` could point the mount at another session's directory.

With the bind-backed volume, the volume root **is** the session's scratch directory. Docker's same check then refuses any subpath that resolves outside `/persist` (`ErrEscapesBase`), and its final open uses `RESOLVE_NO_SYMLINKS`, so swapping a directory for a symlink after the check fails instead of escaping. The confinement is Docker's, not a ShipIt check with a race window. ShipIt's own string checks (`normalizePersistSubpath`: no `..`, no `$` interpolation) exist only to give a readable refusal.

The volume's device path is ShipIt's alone: the scratch directory's parent, the 0700 session directory, is never mounted into any container (docs/270), so nothing inside the session can replace the scratch directory itself.

### Ownership (req 5)

- The scratch root is handed to the session identity with setgid, group `rwx`, and a default ACL `g::rwx` (`preparePersistDir`), the same treatment the workspace gets (docs/271). Files created from then on are writable by the session UID and by the session group — so by the agent, by a service with no `user:` (which runs as the session UID), and by a service with its own `user:` (which gets the group through `group_add`).
- Each mounted subdirectory is created, and given the same setgid, group `rwx` and default ACL, **as the session's UID** (`mkdirAsSession`: `mkdir -p`, `chmod g+rwxs`, `setfacl -d -m g::rwx`, each with `uid`/`gid`), never as ShipIt's root. That also repairs a subdirectory the agent made earlier with a `0755` mode. A symlink planted inside `/persist` can then only reach what that UID could already write; another session's directory is behind its 0700 seal. A file that already existed before its directory got the ACL keeps its own mode.
- `nocopy: true` stops Docker from copying an image directory's files, owner and mode into an empty mount. Without it, mounting at a path the image already has (the `/var/tmp` case in the request) would change the owner of `/persist` or of the subdirectory.

## Plugins (req 7)

A plugin fragment cannot mount `persist`. No new rule was needed: `validateFragmentVolumes` already refuses every named volume and every source that is not the plugin's own files. The refusal message now names `persist`. Plugin state stays in `/plugin-state`, which is one directory per session per import alias (`<sessionDir>/plugin-data/<alias>/state`), shared by that alias's services and CLI runs in that session only.

## Lifecycle (req 2, req 8)

Verified against the code on 2026-09-27. `/persist` is `<sessionDir>/scratch`; a `persist` mount is a view of the same directory, so it has the same lifecycle. `compose down --volumes` can remove the Docker volume *object*, but the local driver unmounts before it deletes, so the data in the scratch directory stays; Compose recreates the object on the next `up`.

| Event | `/persist` and `persist` mounts | Project named volumes |
|---|---|---|
| Container restart, Rescue session, Restart agent | Kept | Kept |
| Idle reclaim, memory path (agent container, then preview stack) | Kept | Kept |
| 24 hours idle (hot → light disk tier) | Kept | Can be removed (`tier-escalation.ts`) |
| Checkout reclaim (light → evicted), then re-clone | Kept (only `workspace/`, `overlay/`, `state/` are removed) | Kept |
| Archive | Kept for the retention period of `docs/323-archived-session-data-retention`, then deleted | Can be removed (`archiveSession`, when the session is loaded) |
| Restore (unarchive) | Kept, if the period did not end | Recreated empty if they were removed |
| Delete — there is no separate session delete; removing a repository archives its sessions | As archive | As archive |
| Full reset (Settings) | **Deleted** | Deleted |

There is no per-session reset; the old sentence in `environment.md` ("Cleared only by a full session reset") described one.

## Key files

- `src/server/orchestrator/compose-generator.ts` — `PERSIST_VOLUME`, `persistSubpathOf`, `rewritePersistMount`, the top-level volume.
- `src/server/orchestrator/compose-persist.ts` — `preparePersistDir`, `workspaceVolumeDaemonPath`.
- `src/server/orchestrator/service-manager.ts` — `preparePersistDirs` / `preparePersist`, called before every override write and every `up`.
- `src/server/orchestrator/service-manager-setup.ts` — wires `persistDevicePath` in the volume-backed deployment.
- `src/server/orchestrator/session-state-dir.ts` — `SESSION_SCRATCH_SUBDIR`, `sessionScratchDirForWorkspace`.
- Agent docs: `src/server/shipit-docs/compose.md`, `environment.md`, `plugins.md`, `plugin-authoring.md`, and the wiki pages `how-shipit-works.md`, `installing-and-updating.md`, `sessions.md`.

## Known limits

- End-to-end behaviour against a real Docker daemon is not covered by the unit tests; they check the generated Compose model, the directory preparation, and the daemon-path translation.
- Workspace subdirectory mounts (`./sub:/app`) are still subpaths of the shared workspace volume and so are open to the symlink escape described above. That is a separate, pre-existing issue.
