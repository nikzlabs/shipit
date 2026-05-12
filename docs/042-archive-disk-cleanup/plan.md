---
status: done
---
# 042 — Disk Cleanup

ShipIt's host can fill up from several independent sources: BuildKit cache that grows with every image build, dangling tagged images, orphan compose volumes left behind when sessions get archived, archived workspaces that hold `node_modules`/`.next`/build output forever, and unreferenced `repo-cache`/`dep-cache` bare clones. This doc records the implemented cleanup design — three orthogonal surfaces, split so each prune runs where the leak actually happens.

## What was leaking on prod (2026-05)

The Hetzner box reached 79% full (~114 GB / 150 GB):

| Source | Size | Cause |
|--------|------|-------|
| `/var/lib/containerd` BuildKit cache | ~79 GB | `docker compose build --no-cache --pull` on every deploy + nothing pruning the builder |
| `/var/lib/docker/volumes` orphan volumes | ~28 GB | `docker compose down` without `--volumes`; per-session named volumes leaked on archive |
| `shipit_workspace/sessions/` | ~4.8 GB | Archived standalone workspaces never reclaimed |
| `shipit_workspace/dep-cache/` | ~2.4 GB | Shared npm cache never pruned |
| `shipit_workspace/repo-cache/` | ~120 MB | Bare clones never pruned |

The biggest hitters (BuildKit + orphan volumes) were both caused by *our* code paths, not by user activity.

## Design — three surfaces

Each prune is owned by the layer closest to where the leak originates.

### 1. Build-time prune — `deployment/hetzner/deploy.sh`

BuildKit cache and dangling images only grow as a side effect of `docker compose build`. The deploy script that triggers the build also owns the prune that follows it:

```bash
docker image prune -af --filter "until=168h" || true
docker builder prune -f --filter "until=72h" || true
```

Also changed in `deploy.sh`:

- **`--no-cache` is no longer the default.** It used to be passed unconditionally, which is what caused the 80 GB BuildKit snowball — every deploy created a fresh duplicate set of intermediate layers. Now cache is reused; `FORCE_REBUILD=1 deploy.sh` opts back in to a clean rebuild.
- **`NPM_GLOBALS_REBUILD=$(date +%s)` is passed every deploy.** Both prod Dockerfiles declare `ARG NPM_GLOBALS_REBUILD` and reference it inside the `npm install -g @anthropic-ai/claude-code @openai/codex` RUN line. The ARG value changes every deploy, so just that one layer is invalidated and reruns — picking up the latest published Claude/Codex CLI versions while everything around it stays cache-warm. The existing `--mount=type=cache,target=/root/.npm` keeps the npm download itself fast.

### 2. Per-session teardown — drop named volumes when a session is going away for good

`ServiceManager.stop({ removeVolumes: true })` appends `--volumes` to `docker compose down`. The flag is signaled by a `removeVolumesOnDispose` boolean on `ContainerSessionRunner`, set by code paths that genuinely mean "this session is gone":

- `archiveSession` (services/session.ts)
- `fullReset` (services/misc.ts)

Code paths that mean "tear down but the user can resume" — idle eviction, `restartAgent` recovery, config reconciles — do **not** set the flag, so `docker compose down` runs without `--volumes` and the user keeps their build state.

For the volume-prune-by-label safety net in surface 3 to work, every user-declared top-level named volume in the compose override is now stamped with two labels:

```yaml
volumes:
  node_modules:
    labels:
      shipit-managed: "true"
      shipit-session: "<sessionId>"
```

`shipit-managed=true` scopes the janitor's `docker volume prune` to volumes ShipIt created; it never touches volumes that belong to the user's other Docker workloads.

### 3. Startup janitor — `src/server/orchestrator/disk-janitor.ts`

The janitor runs **once at orchestrator startup** (fire-and-forget; never blocks the event loop). No periodic timer — every item it sweeps is recovering from a failure earlier in the lifecycle (archive teardown crashed, fs.rm failed, repo removal didn't cascade), and none accumulate steadily, so running on a 6-hour timer would mostly burn cycles doing nothing. Startup is the natural "we just came back from possibly-unclean shutdown — clean up after the previous run" moment. ShipIt's prod box auto-deploys on push (so startup is frequent in practice); long-uptime self-hosted boxes get the sweep on their next restart.

It covers the leaks the two layers above can't see:

- **Orphan `shipit-managed` compose volumes.** Sessions can be archived in the gap between deploys; `docker compose down --volumes` should have dropped the volume but if it failed (compose-stack already torn down, daemon restart mid-operation) the label-scoped prune sweeps it next tick. `docker volume prune -f --filter "label=shipit-managed=true"`.
- **Orphan `repo-cache/<hash>` and `dep-cache/<hash>` directories.** Each tick reads `repoStore.list()`, builds the set of live hashes (where `last_used_at` is within `DISK_JANITOR_CACHE_DAYS`, default 30), and `fs.rm`s any cache subdir whose hash isn't in that set.
- **Archived workspaces** (safety net, opt-in). `archiveSession` already drops `workspaceDir` at archive time for every session — all sessions in the current product have a `remoteUrl` and can re-clone from the bare cache on unarchive. The janitor's workspace sweep exists as a backstop: archives that failed mid-flight (worker crash, fs error), legacy sessions from before the cleanup code shipped, or any future edge case where the workspace outlives the archive. Enabled via `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS=<n>` (sessions older than `<n>` days). **Conversation data is always preserved** — chat history rows, usage rows, session metadata, PR snapshot. Only the on-disk git checkout + `node_modules` go. Sessions without a `remoteUrl` are skipped defensively (no remote to re-clone from). Default `0` (sweep disabled). Prod opts in via `docker-compose.yml`: `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS=30`.

Build-time prunes (BuildKit cache, dangling images) deliberately **do not** live in the janitor — they're owned by `deploy.sh`. They only grow as a side effect of builds, so pruning at deploy time is causal.

### 4. git gc on bare caches

`RepoGit.fetchCache()` runs `git gc --auto` after each successful fetch. `--auto` is a no-op unless git's thresholds for loose-object accumulation are met, so the cost is essentially zero in steady state and amortizes the repack when it matters.

## Production configuration

`deployment/hetzner/docker-compose.yml` sets the janitor knobs explicitly for visibility:

```yaml
- DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS=30
- DISK_JANITOR_CACHE_DAYS=30
```

Self-hosted deployments using their own compose file get the safe defaults (no archive sweep, 30-day cache cutoff) unless they opt in.

## Key files

| File | Role |
|------|------|
| `deployment/hetzner/deploy.sh` | Build-cache-reuse default, `FORCE_REBUILD` opt-in, `NPM_GLOBALS_REBUILD` per-deploy, post-build `image prune` + `builder prune` |
| `deployment/hetzner/docker-compose.yml` | Sets `DISK_JANITOR_*` env vars for prod |
| `docker/Dockerfile.prod`, `docker/Dockerfile.session-worker.prod` | `ARG NPM_GLOBALS_REBUILD` declarations |
| `src/server/orchestrator/service-manager.ts` | `stop({ removeVolumes })` plumbs `--volumes` into `composeDown` |
| `src/server/orchestrator/container-session-runner.ts` | `removeVolumesOnDispose` flag |
| `src/server/orchestrator/app-lifecycle.ts` | Disposed-handler reads the flag and passes `{ removeVolumes }` to `trackComposeStop` |
| `src/server/orchestrator/services/session.ts` | `archiveSession` sets `removeVolumesOnDispose = true` before disposing |
| `src/server/orchestrator/services/misc.ts` | `fullReset` sets the flag on every active runner before `disposeAll()` |
| `src/server/orchestrator/compose-generator.ts` | Stamps `shipit-managed` / `shipit-session` labels on user-declared volumes; `parseUserNamedVolumes()` |
| `src/server/orchestrator/disk-janitor.ts` | Periodic timer: volume prune, archived workspace sweep, cache sweep |
| `src/server/orchestrator/index.ts` | Wires `startDiskJanitor` next to the idle enforcer; cleans up in `onClose` |
| `src/server/orchestrator/repo-git.ts` | `git gc --auto` after `fetchCache` |
| `src/server/orchestrator/disk-janitor.test.ts` | Janitor unit tests (stubbed `runDocker`) |
| `src/server/orchestrator/service-manager.test.ts` | `stop({ removeVolumes })` plumbing test |

## Things deliberately not implemented

- **SQLite `messages` retention / VACUUM.** Archived sessions keep their full `tool_use` payloads. Doable but needs its own design call on what "retention" means for tool-result blobs vs. text content. Separate doc when it becomes a problem.
- **Per-session "Reclaim disk" button.** A manual purge action for individual archived sessions was considered and dropped: all sessions have a `remoteUrl`, `archiveSession` already drops the workspace at archive time, and the time-based janitor sweep covers the remaining edge cases. Nothing left for a user to manually reclaim.
- **Heavy-artifact cleanup at archive time** (delete `node_modules`/`.next`/`dist` inline during archive). The earlier draft of this doc proposed this; superseded by the janitor's scheduled workspace sweep, which is opt-in and respects the "keep conversations indefinitely" principle.
