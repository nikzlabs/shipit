---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Run the Compose commands that read project files in confined throwaway containers, resolve the model once, validate and rewrite that snapshot, and start `up` from exactly it.
---

# 318 — Compose remaining file escapes

Implements [requirements.md](requirements.md). Built on the planning#620 branch; the
deployment checks at the end of this document are still open.
Follows planning#619, which closed the literal `./sub` symlink escape, the direct
shared-volume mount, and `~` sources.

Two mechanisms, one per kind of reach:

- **Files Compose reads** (req 1). Every Compose command that reads project
  files runs in a **confined throwaway container** that sees only what that
  command needs. The kernel then confines every read, whatever path or symlink
  the project names. No check-then-use window exists. ShipIt itself no longer
  reads any project file on the orchestrator.
- **Mounts the daemon creates** (req 2, 2a, 3). The daemon, not the Compose
  CLI, resolves mount sources on the host, so confinement does not cover them.
  ShipIt **resolves the model once** with `docker compose config`, validates
  that snapshot, rewrites its mounts, and starts `up` from exactly that file.
- **Settings that reach the host** (req 7, 8). The same validation also limits
  added capabilities, security options, and build settings in every mode, and
  gives the Docker socket only when the user has turned it on for the
  repository.

Requirement 4's bind-deployment case is out of scope (requirements Q1); tracked
as a follow-up on planning#620.

## Design history

Independent review rounds on 2026-09-27/28 shaped this plan. Rounds 1–5 hardened an
earlier design: the Compose CLI on the orchestrator, dropped to the session uid
(Q3), plus ShipIt-made copies of every file reference and special handling for
`extends`, `label_file`, `.env`, and Dockerfiles. Round 6 (run
`95167b07-e363-4746-8ab3-5629a99b8153`) showed that the window this design
accepted (Q5) could reach ShipIt's database, and that its special handling broke
stacks that work today. The requester then chose the confined container (Q8).
Round 7 (run `49d7bf9e-22e5-49f4-8e43-3638aa7e1b93`) reviewed that redesign.
The findings that still shape this design:

| Round | Finding | Handled in |
|---|---|---|
| 1 | Validating `source: data` does not rewrite it | Mechanism 2 step 4 — every in-workspace bind is rewritten, whatever its spelling |
| 1 | An interpolated reserved named-volume source passes a bind-only check | Mechanism 2 step 3 — named-volume rules |
| 1 | `config` and `up` must not be separate reads of agent-writable input | Mechanism 2 steps 5–6 — `up` starts from the snapshot |
| 1 | Non-path security checks must not be dropped | Mechanism 2 step 3 — the security checks run on the resolved model |
| 2 | Moving the rewrite leaves the per-session volume undeclared | Mechanism 2 step 4 — declarations sit beside the mounts |
| 2 | A content-derived file name is not needed | Mechanism 2 step 5 — one snapshot per start |
| 3 | `volumes_from` with `container:` is refused only in contained sessions | Mechanism 2 step 3 — service-only, every mode |
| 3 | Refusing every outside bind breaks the ops template's socket mount | Mechanism 2 step 3 — today's socket allowance |
| 5 | `config` without profiles drops profiled services | Mechanism 2 step 1 — the named services' profiles are enabled (refined in rounds 10 and 11) |
| 7 | A service's `provider` makes the Compose client run a program, also on the orchestrator's `stop`/`down` | Mechanism 2 step 3 — refused in every mode |
| 7 | The daemon binds a project `secrets`/`configs` `file:` on the host, following symlinks | Mechanism 2 step 4 — ShipIt's own copy, read through the confined container |
| 7 | ShipIt's service-env files in the same container as a build could be read through the build | Mechanism 1 — `build` and `up` run separately, and only `up` sees them |
| 7 | The raw gate read the project file on the orchestrator | Mechanism 2 steps 1–2 — the confined run returns the raw bytes; the raw gate stays (Q4) |
| 7 | A stack with only plugin services has no project file to resolve | Mechanism 2 — override-only path |
| 8 (run `f44fd239-5da5-40b6-95cd-e90eb1fcfd24`) | `build.secrets` reads a project secret file, which `build` could not see after the copy | Mechanism 1 — `build` also mounts the project's secret copies, kept apart from ShipIt's own |
| 8 | Plugin preflight, plugin issue collection, and `parseUserNamedVolumes` also read the project file on the orchestrator | Mechanism 2 — every reader parses the raw bytes of the confined run (refined in round 10) |
| 9 (run `c752d0d7-2b72-4994-95e7-743c74e93c72`) | `build` mounted all of `compose/`, and the override holds plugin credential values inline | Mechanism 1 — `build` mounts only its snapshot file |
| 9 | The orchestrator image holds ShipIt's own files (`/app`), which a build context could name | Mechanism 1 — a dedicated minimal helper image |
| 9 | `up` always passes `--build` today, so building only missing images would ignore an edited Dockerfile | Mechanism 1 — `build` runs every time, for the services `up` starts |
| 9 | The project secret copies need the same ownership handoff | Mechanism 1 — included in the handoff |
| 10 (run `8c2c20a0-bd6e-4375-978a-d387b620aa99`) | A project service can depend on a plugin service, which the project file alone does not declare | Mechanism 2 step 1 — `config` skips the consistency check; `up` checks with the override merged |
| 10 | Enabling every profile makes a dormant service's missing `env_file` block the stack | Mechanism 2 step 1 — only the profiles this start needs; the service map comes from the raw bytes, as today |
| 10 | Compose reads `PWD/.env`, and today's working directory is the workspace | Mechanism 1 — every confined run uses the workspace as its working directory |
| 10 | A confined read failure must still name the fix (req 5) | Mechanism 1 — ShipIt adds the fix to Compose's message |
| 10 | Private image pulls use the orchestrator's Docker client configuration | Mechanism 1 — mounted into `up` only |
| 11 (run `f390d1c3-db8d-4a42-aaa6-08a6e147440e`) | A snapshot of only the named services leaves override entries with no image; with `--remove-orphans` it would also remove the other services' containers | Mechanism 2 step 6 — a per-start override; `--remove-orphans` replaced in round 12 |
| 11 | A plugin service can be started by name, and `build` without the override cannot resolve a `depends_on` on a plugin service | Mechanism 2 step 1 — plugin names are not passed; the plugin stubs file (rounds 12 and 15) |
| 12 (run `ed43e07e-1c4a-4e5f-9fcb-cf5a530022ed`) | Without `-f`, Compose looks for a Compose file in the working directory, which is the workspace | Mechanism 1 — orchestrator-side commands run in an empty ShipIt directory |
| 12 | Enabling a named service's profiles also enables its profile peers; profiles from `extends` are not in the raw list | Mechanism 2 step 1 — `config` names the services (round 10's form); step 6 — ShipIt removes orphans itself, so `--remove-orphans` (round 11's concern) is no longer passed |
| 12 | The build view's plugin mounts had no volume declarations | Mechanism 2 step 6 — the build view holds only name-and-image stubs |
| 13 (run `bf6a78b7-62e3-4a0f-b918-f5b0d1d27af3`) | `config` runs before ShipIt's rewrite, so ShipIt's `persist/<sub>` short form must survive it | Mechanism 2 step 3 — recognised as a named-volume source in the resolved model and rewritten in step 4; exempt from the declaration rule |
| 14 (run `a4054d22-f8b7-43f8-9878-deee5d1a167e`) | A read-only helper gives the build tooling no writable state place | Mechanism 1 — `HOME` and `BUILDX_CONFIG` on the container's tmpfs; the orchestrator's Docker packages |
| 14 | A model-free `stop` or `down` skips an Open session's `pre_stop` hook | Mechanism 1 — `stop` loads the start's own snapshot and override; `down` stops first |
| 14 | The shipped image-build scripts build fixed image lists | Key files — every deployment builds the helper image |
| 15 (run `977abb12-868f-4948-83e7-6eb8fdfc093e`) | Selecting a service follows its `depends_on` even with `--no-consistency`, so a plugin dependency fails in `config` | Mechanism 2 step 1 — the plugin stubs file is given to `config` too |
| 15 | With `HOME` on `/tmp` and a session-identity user, `up` would not find or read the registry login | Mechanism 1 — `DOCKER_CONFIG` names the mounted login; `up` runs as root, so the override and service-env files stay root-only |
| 16 (run `27ade2a2-1583-447f-9371-69c26cd280c0`) | On Compose 2.34.0, `config <name>` keeps a profiled service's `env_file` without inlining it, and Compose is unpinned | Mechanism 1 — one pinned, checked Compose version in both images; Mechanism 2 step 4 — refuse, never drop, an un-inlined `env_file` |
| 17 (run `d670dd26-5e2f-4c19-a7d6-22d51a76b085`) | Overlay dep-dir matching reads only `./` sources, which the rewrite replaces; the checklist said the service map comes from the resolved model; the registry-login exception had no diagnostic | *What moves out of the override* — the matcher uses the recorded workspace path; checklist fixed; *Failure* — a registry-auth build failure names the exception |
| 18 (run `57ae112d-1207-4851-b2d9-79f54fb27dda`) | Helper bind sources under `/workspace` are not Docker-host paths; a Stop during the awaited resolve is missed; `Dockerfile.dev` is unpinned too | Mechanism 1 — host-path translation for every ShipIt file; *Where this runs* — the start registers in `upSettled` before the resolve and re-checks Stop; both orchestrator Dockerfiles pinned |
| 19 (run `fc18dd8f-a318-4061-a820-d255316bb4f1`) | `deployment/local/lib.sh` builds a fourth image list; changing `HOME` changes `${HOME}` interpolation; the service-env files have no Docker-host translation today | Key files — the fourth list; Mechanism 1 — `config` keeps today's environment; host path via the workspace volume (the default), or supplied |
| 20 (run `5a762732-8294-4623-97a1-a1935b446994`) | Readers that reuse earlier raw bytes see a stale file; `stop` can come before any snapshot exists | Mechanism 2 — a fresh confined read per operation; Mechanism 1 — `stop` finds its pair by a container label, and handles no container and no pair |
| 21 (run `650db04e-e8a6-41d5-ab58-9fc1b35d5890`) | A model-free `down --volumes` leaves declared volumes; `dockerSecretsConfig.hostDir` is not set in shipped deployments | Mechanism 1 — ShipIt removes the project's labelled volumes by name; secret copies in the session state dir, via the workspace-volume translation |
| 22 (run `3423fa94-5659-49e8-8a8a-35e1cab27a5f`) | `rm` and `inspect` are plain Docker commands on container IDs, not Compose commands; a symlink can still reach the helper image's own files | Mechanism 1 — plain Docker commands unchanged; the helper-image files → requirements Q10 |
| 23 (run `6c66d249-c288-4c31-8705-cf6107c5d6ab`) | After `build`, `up --no-build` with `pull_policy: always` would pull over the local build; label-based volume removal misses anonymous volumes | Mechanism 2 step 6 — `pull_policy: never` on built services in the per-start override; Mechanism 1 — the final `down` keeps `--volumes` for anonymous volumes |
| 24 (run `5b8e7c49-e04b-424b-9632-ab940de2612f`) | `pid: host` / `pid: container:` is not checked; the socket exception is a prefix match | Mechanism 2 step 3 — a `pid` rule in every mode; the socket source must match exactly |
| 25 (run `b14655ea-4487-42b8-98ba-aecef07994ab`) | `ipc: container:` shares another container's `/dev/shm` files | Mechanism 2 step 3 — one shared-namespace rule for `pid`, `ipc`, `network_mode`, `uts`, `cgroup`, `userns_mode` |
| 26 (run `8563719a-febe-497c-ae73-8ed1f91804c9`) | The orchestrator's Docker login is not at a Docker-host path; reconcile starts services | Mechanism 1 — a root-only copy of the login in the workspace volume; *Where this runs* — reconcile's start uses the full sequence |
| 27 (run `c22e92cb-fcd8-40ca-91dd-babf6f04a434`) | External secrets/configs are not refused; `DOCKER_CONFIG` must name a directory; a symlink could reach the ShipIt files mounted into `config` and `build` | Mechanism 2 step 3 — `external`/`name` refused; Mechanism 1 — a login directory; ShipIt input to `config` and `build` on stdin, so no ShipIt file is mounted there and none needs a new owner |
| 28 (run `08e8c576-c1ad-44ca-8006-e7704f35b681`) | A per-start container label changes the configuration hash and recreates unchanged services; `../scratch` build contexts work today; the checklist still mounted ShipIt files into `build` | Mechanism 1 — a root-only start record instead of a label; scratch mounted with the workspace; checklist fixed |

Round 29 (run `2843532c-aab8-4be3-9562-4424ffd6456d`) found no important findings, and no part of the design that could be removed without losing a needed behaviour.

After round 29 the requester stated the threat model (requirements Q11): reach
into another session or the host must be fully prevented, also on purpose. A
check of the code against it found host reach in Open sessions outside
requirements 1–3, and the answers to Q12–Q14 added the capability,
security-option, and build rules and the socket grant (Mechanism 2 step 3, *The
socket grant setting*). Review round 30 (run
`69ea591c-7e4f-4f07-b4ed-f682e475978c`) on that part found: an Open ops session
lets any service mount the raw socket (fixed: ops sessions get only the trusted
proxy's mount without the grant); the setting needs its reader, operation, apply,
and client parts (added); and the grant depends on the container guard's peer
address check (filed as planning#621, since it applies to every user-only route).
Round 31 (run `ec0d3819-2662-458f-a4d8-93f6ca98941a`) found that `volumes_from`
could inherit the proxy's socket mount (fixed: a socket-bearing service cannot
be named) and that a sandbox has no repository to hold the grant (it gets no
socket; its own Docker access switch is the user's path). It also said the
agent-facing reader and `::set` operation could go. They stay: the reader keeps
`shipit settings get` complete, and the operation lets the agent ask for the
grant on a proposal card that only the user can accept, the same as
`allowAgentMerge`. Round 32 (run `b58a7081-db1d-4cce-b726-b9af4bfe3482`) found
that `pid: service:<proxy>` reaches the proxy's socket through `/proc` (fixed:
one rule refuses every join — `volumes_from` or a `service:` namespace — to a
socket-bearing service). Round 33 found that the proxy was known by its tag
alone (fixed: a pinned digest), and round 34 found one more unchecked field
(fixed: refused). Because each round found one more field, the requester chose
a list of classified fields over more rounds (requirements Q15). The independent review of
the implementation (run `82f95ad9-eb35-4197-a94e-8a452da139ef`) reported that
the snapshot was written before the project secret copies were named in it;
the code copies first and writes after (`service-manager.ts`, covered by
`service-manager-confined.test.ts`), so nothing changed. It found no part of
the change that could be removed.

## Mechanism 1 — confined Compose containers

### Which commands run confined, and what each sees

Each command that makes Compose read project files runs in its own throwaway
container, and each sees only what it needs. Today these commands are spawned
by `defaultComposeRunner` / `defaultComposeQuery` (`compose-cli.ts`) as
`docker compose …`; they become `docker run … <image> docker compose …`.

**No container that reads project paths mounts a ShipIt file.** Whatever ShipIt
must give such a container — the plugin stubs, the build model — arrives on
standard input (`-f -`), so no symlink in the project can name it
(requirement 1 as reworded in Q10).

| Command | Workspace and scratch | ShipIt input | Override + service-env files | Docker client config | Docker socket |
|---|---|---|---|---|---|
| `config` (Mechanism 2 step 1) | read-only | the plugin stubs, on stdin | — | — | no |
| reading the project file alone (a reader's fresh read) | read-only | — | — | — | no |
| reading a project `secrets`/`configs` file (step 4) | read-only | — | — | — | no |
| `build` | read-write | the build model, on stdin | — | — | yes |
| `up --no-build` | — | the snapshot and `compose/`, mounted | yes | read-only | yes |

"Scratch" is this session's scratch directory, `<sessionDir>/scratch`, which
the agent sees as `/persist` (`session-state-dir.ts`). It sits beside the
workspace, and a reference such as `build.context: ../scratch/app` reaches it
today, so the containers that read project paths mount it too, at its
orchestrator path. It is this session's own, which requirement 1 permits.

- **The build model** is the snapshot with the plugin stubs added, and with
  each project secret or config that `build.secrets` uses named by its path in
  the workspace, not by ShipIt's copy (step 4). The build reads those files
  itself, inside its own container, where only this session's workspace is.
  So `build` needs no ShipIt file, and a build can still read the project's
  own secret files.
- **ShipIt's service-env files never share a container with project reads.**
  They hold values for this session's services. A build reads the context and
  Dockerfile the project names, so a build that could also see those files
  could put them into an image. The same holds for the override, which carries
  plugin credential values inline (`mergePluginCredentialEnv`,
  `compose-generator.ts`). So `build` runs first, in its own container, and
  `up` then runs with `--no-build`. Today `up` and `upService` always pass
  `--build` (`compose-cli.ts`), so `build` runs every time, for the services
  that `up` starts; an edited Dockerfile or context is picked up as it is
  today.
- **`up` does not see the workspace.** After step 4 the snapshot names no file
  `up` reads, so nothing needs it. `up` reads no project path, so it may mount
  ShipIt's files: the snapshot and the override (in a new `compose/`
  subdirectory of `<sessionDir>/state`; the rest of the state directory, which
  holds orchestrator-only files such as `.env.agent`, is not mounted), and this
  session's service-env files.
- **Registry credentials reach `up` only.** Today Compose inherits
  `DOCKER_CONFIG` / `HOME` (`COMPOSE_ENV_PASSTHROUGH`, `compose-cli.ts`), so it
  uses whatever registry login the orchestrator has when it pulls an image.
  The Docker host cannot see that configuration where it is (for example
  `/root/.docker` inside the orchestrator container,
  `deployment/vps/docker-compose.yml`). So before each `up`, ShipIt copies the
  client configuration file, if there is one, as `config.json` into one
  root-only directory in the workspace volume, outside every session
  directory, and mounts that directory read-only, with `DOCKER_CONFIG` set to
  it (Docker reads `config.json` from the directory `DOCKER_CONFIG` names). A
  credential helper named in that file works only if the helper image has it;
  the orchestrator image has none today, so only a login stored in the file
  works, as today. Private service images keep pulling. `config` and `build`
  read project paths, so they do not get it. **One behaviour change** (the
  requirement 6 exception, requirements Q9): a build whose base image needs
  the orchestrator's registry login now fails, with a message that says why
  and to name a pullable image or publish the image instead (req 5).
- The workspace comes from the shared workspace volume at this session's exact
  subpath — the same confined mount `.` uses (`workspaceVolumeMount`,
  planning#619) — and the scratch directory the same way. Each appears at the
  path the orchestrator uses, so the absolute paths in the models mean the same
  thing inside and outside.
- **Mount sources are Docker-host paths.** The daemon resolves a bind source on
  its own host, where the orchestrator's `/workspace/...` path is not the file
  (the shipped deployments mount `/workspace` as a named volume). So every
  ShipIt file mounted into `up` — `compose/`, the service-env files, the
  registry-login directory — is bind-mounted from its Docker-host path, and so
  is each project secret copy the daemon binds into a service. Paths in the
  workspace volume are translated as `workspaceVolumeDaemonPath`
  (`compose-persist.ts`) already does. That covers the service-env directory
  by default, which is `<stateDir>/service-env` inside that volume
  (`bootstrap-managers.ts`); no translation exists for it today. The project
  secret copies live in the session's state directory, inside that volume too
  (`dockerSecretsConfig`, with its own host path, exists only when
  `SHIPIT_SECRETS_INTERNAL_DIR` is set). A `SHIPIT_SERVICE_ENV_DIR` set outside
  the workspace volume needs its Docker-host path supplied; without it, a
  start that needs service-env files is refused with a message that names the
  setting (req 6). The agent can write none of these paths, so the daemon's
  resolution of them on the host cannot be steered.
- Nothing else is mounted: not another session, not the shared volume root
  (which holds `.shipit.db`), and no orchestrator file. The image is a minimal
  helper image, not the orchestrator's (see *How each container runs*).

The other Compose commands stay on the orchestrator: `ps` (the status poller
runs it every 5 seconds per session, `service-poller.ts`), `logs` (both log
paths in `service-manager.ts`), `stop`, and `down`. A container start for each
would cost too much, and they do not need one. The plain Docker commands
ShipIt runs on container IDs (`docker ps --filter`, `docker inspect`,
`docker rm -f`, `docker network rm`, in `compose-cli.ts` and
`service-poller.ts`) read no Compose file and stay as they are; the orphan
removal (Mechanism 2 step 6) uses them too.

- `stop` and `down` need the model, because Compose runs a service's
  `pre_stop` hook (permitted in Open sessions, `validateServiceSecurity`) from
  its definition. So ShipIt keeps each start's snapshot and override while a
  service started from them runs, and records, in a root-only file in
  `compose/`, which start last started each service. `stop <name>` looks the
  service up there and loads that pair. A container label would be simpler to
  find, but Compose hashes a service's labels into its configuration, so a new
  label on every start would make `up` recreate services that did not change. It names no project file and no program
  to run (Mechanism 2 steps 3–4), so loading it on the orchestrator reads
  nothing the project controls. If the service has no container yet (a Stop
  before or during its first start), `stop` records the Stop and has nothing
  to stop; the racing start then sees it (*Where this runs*). If the pair is
  gone, `stop` runs model-free, as below, and logs that no `pre_stop` hook ran.
  `down` first stops each running service that way, then runs as below to
  remove the rest. When ShipIt removes volumes (today `ServiceManager.stop`
  passes `--volumes`), the final `down` keeps `--volumes`, so Compose removes
  each container together with its anonymous volumes (including volumes an
  image declares), which needs no model. A model-free `down` no longer knows
  the declared named volumes, so ShipIt then removes the volumes that carry
  this project's Compose label, by name. That the installed version removes
  anonymous volumes this way is a deployment check; if it does not, ShipIt
  removes the project's containers with `docker rm -fv` before the `down`.
- `ps`, `logs`, and the final `down` run with `-p <project>`
  and **no model file**, so Compose finds the stack's containers by the
  project label and opens no project file and no snapshot. Without `-f`,
Compose looks for a Compose file in its working directory and the directories
above it, and today that is the workspace (`compose-cli.ts`,
`service-poller.ts`). So these commands run in an empty directory ShipIt owns
in `<sessionDir>/state/compose/`, and no file ShipIt writes there, or in a
directory above it, has a name Compose looks for (`compose.yaml`,
`docker-compose.yml`, and their variants). That the installed Compose version
supports this for each of these commands is a deployment check. If it does not, the fallback is a stack-wide model, resolved
in the confined container like the snapshot but with every profile enabled and
env-file resolution off, stripped of file keys, and validated the same way.

### How each container runs

- **Image:** a dedicated minimal helper image that holds only a base system and
  the same Docker packages the orchestrator image installs today
  (`docker-ce-cli`, `docker-compose-plugin`, `docker/Dockerfile.prod`), so
  Compose builds the way it does today. It is not the orchestrator's image,
  which holds ShipIt's own files (`/app`) that a build context or a symlink
  could name. It is built with the orchestrator image, from the same Docker apt
  repository, and its reference is resolved at startup, as
  `resolveWorkerImageId` resolves the worker image (`app-lifecycle.ts`). If it
  is missing, starts are refused with a message that says so.
- **A pinned Compose version.** This design depends on how `config` behaves:
  which services it selects, and whether it inlines `env_file` values. That has
  changed between releases (on 2.34.0, `config` keeps the `env_file` of a
  service selected by name under a profile, docker/compose#12706). Today
  `docker-compose-plugin` is unpinned (`docker/Dockerfile.prod`). So the helper
  image and the orchestrator images (`docker/Dockerfile.prod`, and
  `docker/Dockerfile.dev` for the local dev deployment) all install one pinned
  version, the one the deployment checks below were run on, and a bump repeats
  those checks. The pin is `docker-compose-plugin=5.5.1-1~debian.12~bookworm`
  (`orchestrator-compose.test.ts` fails if the three files disagree).
- **Isolation:** `--rm`, `--network none` (the CLI reaches the daemon through
  the mounted socket), a read-only root filesystem with a tmpfs `/tmp`,
  `no-new-privileges`, `--cap-drop ALL`, and `--pull never`.
- **User:** `config`, the file reads, and `build` run as the session identity
  (`identityForSession`), with the socket's group added for `build`. Anything a
  build writes into the workspace is owned as the agent's files are, which is
  consistent with docs/270. `up --no-build` runs as root: it reads no project
  path, and it must read ShipIt's root-only files (the override, the
  service-env files, the Docker client configuration). With the socket it can
  command the daemon either way.
- **Environment:** `composeSpawnEnv()`'s allowlist only, as today; no
  credentials in it. `config` gets exactly today's values, `HOME` included,
  because interpolation happens there and a project may use `${HOME}` (req 6).
  `build` and `up` load the snapshot, whose `$` ShipIt escaped (Mechanism 2
  step 5), so their environment changes no value in the model. For `build`,
  `HOME`, `DOCKER_CONFIG`, and `BUILDX_CONFIG` point into the tmpfs `/tmp`, so
  the build tooling has a private writable place for its state, gone with the
  container. For `up`, `DOCKER_CONFIG` names the mounted registry login.
- **Working directory:** the workspace, as today (`defaultComposeRunner` runs
  with `cwd: workspaceDir`), because Compose reads `PWD/.env` and resolves
  relative `-f` paths from it. `up`, which has no workspace, uses `compose/`.
- **Cleanup:** each container has a unique name and a
  `shipit-compose-helper=<sessionId>` label. On cancel or timeout ShipIt removes
  it by name, because killing the `docker run` client does not stop the
  container. The startup janitor removes leftovers by label.
- **Failure:** if a container cannot start (image missing, daemon error),
  ShipIt refuses the start with a message that says so (req 5, req 6). When
  Compose fails on a path it cannot find or read, ShipIt adds the fix to
  Compose's message: Compose sees only this session's workspace, so a file
  reference, or the symlink it follows, must point inside it (req 5). When a
  `build` fails on registry authentication, ShipIt adds that builds do not get
  the orchestrator's registry login, and to use a pullable base image or
  publish the image and name it instead (req 5, the requirement 6 exception).
  The output stream to the service log is unchanged.

### ShipIt's own files keep their owner

No container that runs as the session identity reads a ShipIt file: `config`
and `build` get their ShipIt input on standard input. So no ShipIt file needs a
new owner or mode. The override, the service-env files
(`writeServiceEnvFilesToRoot`), the snapshots, the project secret copies, and
the registry-login copy stay root-only, and only `up`, which runs as root, the
daemon, and the orchestrator read them. The service-env hygiene is unchanged:
the agent does not *accidentally* read a service-only key. (That was never a
boundary against a rogue agent, which can already expose any value its
services receive — render it in a page and snapshot it, log it.)
`assertServiceEnvRootOutsideWorkspace` stays.

ShipIt's docker-secret files are not mounted: the override names them by their
Docker-host path (`composeSecretFilePath`), and the daemon mounts them, as
today.

### What this gives

Every file Compose reads by a path the project names — the project file itself,
`env_file`, `label_file`, `.env`, `extends` files, build contexts,
Dockerfiles and their ignore files, `build.ssh` keys, local build caches — is
looked up inside a container that holds only this session's workspace. A
symlink to anything else finds nothing, or the helper container's own files —
the helper image's base system and the `/etc/hosts`, `/etc/resolv.conf`, and
`/etc/hostname` Docker adds to every container — none of which belongs to
another session, the shared volume root, ShipIt, or the Docker host
(requirement 1 as reworded in requirements Q10). The helper image is kept as
small as practical for that reason. So none of
these needs a rule of its own, and stacks that use them keep working (req 1,
req 6). This holds in the bind deployment too, for these reads.

## Mechanism 2 — resolve once, validate, rewrite, start from that file

ShipIt no longer reads the project file on the orchestrator. Today
`parseComposeFile` reads it there (`fs.readFileSync`), which follows a symlink;
and the raw text is not what `up` runs anyway, because Compose, not ShipIt,
interpolates and resolves `extends`. Every place that reads the project file
today uses the confined resolve below instead:

- in `service-manager.ts`: `parseProjectCompose`,
  `assertProjectComposeStillValid`, reconcile, and `parseUserNamedVolumes`
  (called from `preparePersistDirs` and `buildOverrideOptions`);
- `readProjectServices` (`services/plugin-services.ts`), the plugin preflight's
  list of project service names;
- `collectPluginFragmentIssues` (`api-routes-plugin-repos.ts`).

Each of them gets the project file's raw bytes from a confined read made for
the operation that uses them (a start uses the bytes its own `config` run
returned), and parses them as it parses the file today. None reuses bytes from
an earlier read: the agent can edit the file at any time, and plugin admission,
for example, must see the project's current service names, as it does today. So the service map, the service names, and
the volume declarations come from the raw file as today, and services behind a
profile are listed without being resolved. What runs comes only from the
snapshot.

### The before-`up` sequence

1. **Resolve.** ShipIt first makes the **plugin stubs**: for each admitted
   plugin service, its name and image and nothing else — no mount, no
   environment, no credential. Then, in a confined container (workspace
   read-only, no socket), it runs `docker compose -p <project> -f <project
   file> -f - config --no-consistency <the project services this start
   names>`, with the stubs on standard input, so no ShipIt file is mounted. Naming a service enables that service, wherever its profile
   comes from (also through `extends`), and not the other services in its
   profile, as `up <names>` does; Compose includes the named services'
   dependencies. So a service this start does not need is not resolved, and
   its missing `env_file` cannot block the start. A dependency on a plugin
   service is found in the stubs, because selecting a service follows its
   `depends_on` whatever the consistency setting; ShipIt drops the stub services
   from the resolved model before step 3, and at `up` the override supplies the
   real ones. `--no-consistency` is there for ShipIt's `persist` short form
   (step 3). A plugin service name is not passed, and a start that names no
   project service skips steps 1–5, as the plugin-only path does. Compose reads
   the project file, `.env`, `env_file`s, `label_file`s, and `extends` files
   here, all inside the container. The same run also returns the project
   file's raw bytes, for step 2.
2. **Raw gate (kept, requirements Q4).** The syntax checks of
   `parseComposeFile` — the contained-session interpolation and `extends`
   refusals, the `include:` refusal, and the path-string checks — run on those
   raw bytes, as they run on the file today. They give early, clear refusals and
   keep today's contained-session rules. They are not the boundary — step 3 is
   — so a file changed between the two reads of one run gains nothing.
3. **Validate the resolved model.** The security checks run here, in every mode
   where they run today: the non-path checks of `validateServiceSecurity` and
   `validateBuildSecurity` (`privileged`, `network_mode`, `cap_add`, `devices`,
   `user`, labels, and so on) and the top-level volume, network, secret, and
   config declaration rules. So an interpolated or `extends`-inherited value is
   refused (req 2). They accept only the normalization Compose itself adds (the
   project-default `name:` on a volume or network, the implicit `default`
   network). Also, in every mode:
   - **`provider`** on a service is refused: it makes the Compose client run a
     program, and `stop`/`down` run on the orchestrator.
   - **Bind sources.** Inside this session's workspace → rewritten (step 4).
     Outside → refused (req 2, req 3). This covers `./data`, `data`, `.cache`,
     and `{type: bind, source: data}` alike. The one exception is the Docker
     socket, `/var/run/docker.sock`, under the socket grant below; in contained
     sessions only the trusted proxy's read-only mount, as today
     (`validateServiceSecurity`; the ops template in `templates-ops.ts`
     depends on it). The source must be exactly that path.
     Today's absolute-path check skips every source that merely *starts with*
     it (`startsWith("/var/run/docker.sock")`), so `/var/run/docker.sock.bak`
     passes; the resolved rule does not copy that.
   - **Named-volume sources.** Must name a volume declared in the resolved
     top-level `volumes:`, never a name reserved for ShipIt's own mounts; the
     declarations get the top-level rules (no reserved name, no `driver_opts`,
     no `external`, no other `name:`) (req 2a). The exception is ShipIt's
     `persist` volume (docs/317): a `persist` source, and ShipIt's
     `persist/<sub>` short form, need no declaration, because step 4 rewrites
     them. Compose reads `persist/<sub>:/data` as a named-volume source
     `persist/<sub>` (the source does not start with `.`, `/`, or `~`), and
     `--no-consistency` leaves the undeclared name as it is, so ShipIt still
     finds its short form in the resolved model (`persistSubpathOf`).
   - **Shared namespaces.** A service may share a namespace only with a service
     of this project, in every mode. For every field that joins one — `pid`,
     `ipc`, `network_mode`, `uts`, `cgroup`, `userns_mode` — the `host` and
     `container:<name>` forms are refused (req 2a); `service:<name>` and a
     field's own private values stay permitted. Joining another PID namespace
     shows its processes, and through `/proc` their files, to a service that
     Open sessions let run as root with added capabilities; joining another IPC
     namespace shares its `/dev/shm` files. Today `pid` and `ipc` are not
     checked at all, and `network_mode` refuses only `host`.
   - **`volumes_from`.** Only a service of this project, whose own mounts are
     checked here. The `container:<name>` form is refused (req 2a); today it is
     refused in contained sessions only.
   - **The trusted proxy's identity.** ShipIt identifies the trusted proxy by
     an image digest that ShipIt pins, not by its tag alone. No other service
     of the project may build or name that image (review round 33, run
     `8bf23ca3-712f-4965-a34d-1fcc199952e3`). The proxy is trusted only with
     the ops template's own keys. An ops file written before the pin names
     the tag alone; it stays trusted, because the override always sets the
     pinned reference as the proxy's `image`.
   - **Socket-bearing services cannot be joined.** A service that mounts the
     Docker socket, directly or through its own `volumes_from`, may not be
     named by `volumes_from` or by the `service:<name>` form of any
     shared-namespace field. `volumes_from` inherits every mount, and a shared
     PID namespace exposes the other service's files through `/proc`; either
     way a service in an ops session could reach the trusted proxy's socket
     without the grant (req 8, review rounds 31 and 32). A service that has the
     grant mounts the socket itself.
   - **Top-level `secrets`/`configs`.** A `file:` must resolve inside the
     workspace (step 4 replaces it). `external` and `name` are refused in every
     mode, as they are for volumes and networks today, because they attach an
     object this session did not create (req 2a); today only `file:` is
     checked (`validateTopLevelFileRefs`).
   - **Added capabilities (req 7, requirements Q13).** Contained sessions keep
     refusing every `cap_add`, as today. In Open sessions, each entry, after
     ShipIt strips a `CAP_` prefix and uppercases it, must be on
     `SAFE_ADDED_CAPABILITIES`: the capabilities whose effect stays inside the
     container's own namespaces. The starting list is `NET_ADMIN`,
     `SYS_PTRACE`, `IPC_LOCK`, and `SYS_NICE`, plus the names in Docker's
     default set except `NET_RAW`, which ShipIt drops from every service.
     `ALL` and every other name are refused.
   - **Security options (req 7, Q13).** In every mode, `security_opt` may hold
     only `no-new-privileges` (also written `no-new-privileges:true` or
     `=true`). Every other value is refused. Today `security_opt` is not checked
     in any mode; ShipIt's own `no-new-privileges` in the override is not a
     project value and stays.
   - **Device rules (req 7).** `device_cgroup_rules` is refused in every mode;
     `validateDevices` checks only `devices`, so today this field is not
     checked in any mode (review round 34, run
     `8071329c-00b5-4a91-8a13-2547249f9b42`).
   - **Build settings (req 7, Q13).** `validateBuildSecurity` runs in every
     mode, not only in contained sessions: no `build.privileged`, no
     `build.entitlements`, and `build.network` only the default or `none`. Its
     messages stop saying "for contained services".
   - **The socket grant (req 8, requirements Q14).** A service may mount the
     Docker socket, or set `use_api_socket`, only when `shipit.yaml` sets
     `compose.docker-socket: true` **and** the repository's `allowDockerSocket`
     setting is on. An ops session without the grant gets only the trusted
     proxy's read-only mount (`isTrustedOpsProxyService`), in every mode;
     today that limit applies only in contained sessions, so in an Open ops
     session any service can mount the raw socket (review round 30). A session
     with no repository (a sandbox) has no grant, so its services get no
     socket; the refusal points to the sandbox's own **Docker access** switch,
     the user's session-scoped Docker path. Today such a session gets the socket
     from the key alone (`service-manager.ts`, round 31). Requirement 6's
     working-stack promise covers stacks that mount only the workspace and
     `/persist`, so it does not cover a socket mount. When the key is set and the setting is off, the start is
     refused with a message that names the setting and where the user turns it
     on (req 5). ShipIt reads the setting from `RepoStore` at each start, so a
     change applies at the next start. This replaces
     `dockerSocket: composeConfig.dockerSocket || opsSession`
     (`service-manager.ts`).
   - **Classified fields only (req 7, requirements Q15).** Each service key
     must be on `CLASSIFIED_SERVICE_FIELDS`, or start with `x-`. A key on the
     list either has no effect outside the container or has its own check in
     this step. Any other key is refused with a message that names it, so a
     field a later Compose release adds is refused until ShipIt classifies it.
     Some fields stay on the list only with a check of their own: `logging`
     (the `json-file` or `local` driver), `deploy` (no device reservations),
     `post_start`/`pre_stop` (no `privileged`), and `label_file` (inside the
     workspace).
   - **Anything left unresolved** — a `$` in a path field, a source Compose did
     not make absolute, a mount field ShipIt does not recognise — is refused
     (req 6).
4. **Rewrite.**
   - Every in-workspace bind becomes a subpath of the per-session workspace
     volume; `.` becomes the shared volume at the exact session subpath
     (`workspaceVolumeMount`, planning#619); `/persist` sources are rewritten as
     today. The file that holds a mount of a ShipIt volume also declares that
     volume (today `generateComposeOverride` declares the per-session volume only
     for its *own* mounts).
   - Each project `secrets`/`configs` `file:` is read through a confined
     container (workspace read-only, no socket), written into
     `<sessionDir>/state/compose/secrets/`, and named by its Docker-host path
     (`workspaceVolumeDaemonPath`). The daemon then binds ShipIt's
     copy, never a workspace path it would resolve on the host. This runs only
     when the project declares such a file.
   - The `env_file` and `label_file` keys are removed, because on the pinned
     Compose version their values are already inlined. ShipIt never drops a
     key whose values Compose did not inline: if the resolved model still
     holds one (another Compose version), the start is refused with a message
     that names the service and the pinned version, rather than started with
     its environment missing (req 6).
5. **Write.** ShipIt writes the result as this start's snapshot in
   `<sessionDir>/state/compose/`: a new file per start, never changed after it
   is written, kept with that start's override while the start runs or a
   service started from it is running (`stop` uses the pair, Mechanism 1), and
   removed after that.
   The agent container never mounts the state directory
   (`SESSION_STATE_SHARED_SUBDIR` is its only mounted part), so the agent cannot
   change the file. ShipIt writes `$` so that Compose's second parse gives back
   exactly the validated values.
6. **Start.** ShipIt writes this start's override for exactly the services in
   the snapshot plus the admitted plugin services. Today the override has an
   entry for every parsed project service (`generateComposeOverride`); an entry
   for a service the snapshot does not hold would have no image or build, and
   Compose would refuse it. The override also sets `pull_policy: never` on each
   service this start builds. Today `up --build` pulls and then builds, so the
   local build wins even under `pull_policy: always`; a separate `up` after
   `build` would otherwise pull the registry image over it. Image-only
   services keep their pull policy. Then `build` runs with `-f -` and the
   build model on standard input (Mechanism 1: the snapshot plus the plugin
   stubs, so that a `depends_on` on a plugin service resolves, with
   `build.secrets` files named by their workspace paths), and `up --no-build`
   with `-f <snapshot> -f <override>`, each in its confined container (Mechanism 1). On the
   orchestrator, `stop` loads this pair and the other commands use no model
   file (Mechanism 1).

   `up` no longer passes `--remove-orphans`: the snapshot holds only the
   services this start needs, so Compose would take every other running
   service for an orphan and remove it. ShipIt removes orphans itself, before
   `up`: each container with the project label whose service is neither in the
   raw service list (every service of the project file, in every profile) nor
   an admitted plugin service is removed by name. That needs no model file.

**No project file** (`noProjectCompose`, a stack of plugin services only):
steps 1–5 are skipped, and `up --no-build` runs in its confined container with
the override alone, as the override-only path does today (`service-manager.ts`,
`start()`).

### Where this runs

`withUpInFlight` (`service-manager.ts`) validates synchronously before it takes
the in-flight count, so that a rejected parse never gets a polling exemption.
`config` is now a container run, so steps 1–5 become an awaited step that
completes **before** the count is taken, and `fn()` receives the snapshot path
it must start from. Reconcile rebuilds the service map from a fresh confined
read of the raw bytes, and then calls `start()` (`service-manager.ts`), which
starts the automatic services through this same sequence, like every other
start.

A Stop must still win over a start that is resolving. `stopService` stops the
service and then stops it again after every start it finds in `upSettled`
(`stopAfterPendingUps`); a start that is still in the awaited resolve would not
be there yet. So the start adds its promise to `upSettled` **before** the
resolve — `upSettled` carries no polling exemption, unlike the in-flight
count — and, after the resolve, skips `build` and `up` if `stoppedByUser` now
holds the service.

### What moves out of the override

`rewriteVolumes` moves from `generateComposeOverride` to step 4 and runs on
absolute sources. The override keeps only what ShipIt adds (labels, networks,
user, secrets wiring, the entrypoint bind, overlay dep-dir mounts). Overlay
dep-dir matching (`overlayMountsForService`) recognises only `.` and `./…`
sources today, and a rewritten mount's source is a volume name. So step 4
records, for each bind it rewrites, the workspace-relative path it came from,
and the matcher uses that path. The override moves into the `compose/`
subdirectory.

### Failure

A `config` that fails (bad interpolation, a missing `extends` base, an undefined
volume, a file the project names that does not exist in the workspace) is a
`ComposeValidationError` with Compose's message, and nothing starts (req 6). A
refused value names the field, the resolved value, and what to use instead
(req 5).

## The socket grant setting

`allowDockerSocket` is a per-repository setting beside `allowAgentMerge`, and it
uses the same parts:

- **Store:** a `repos.allow_docker_socket` column, default off
  (`repo-store.ts` with a setter, `RepoInfo` in the shared domain types, a
  migration in `shared/database.ts`). It is keyed like repository trust
  (`canonicalRepoKey`), so a repository on any host can hold it.
- **Read:** `dockerSocketGrantFor` (`service-manager-setup.ts`) at each start.
  A sandbox gets no grant by its session kind, whatever repository address
  its workspace names (planning#623).
- **Write:** the `PATCH /api/repos/:url` route (`api-routes-session-repos.ts`)
  takes `allowDockerSocket` and passes it to `applyRepoSettings`
  (`settings-apply.ts`), which writes it and names `project.allowDockerSocket`
  in the keys it changed. The route has no `containerAccessible` flag, so the
  container guard refuses it to the agent container and to the session's other
  containers, its services included (verified at `api-container-guard.ts`,
  `registerContainerOriginGuard`). The guard knows a caller by its socket peer
  address, the same as for `allowAgentMerge` and the secret store; whether a
  service can reach the API through a host-side forwarder is a question for the
  guard, not for this setting (planning#621).
- **Settings plumbing:** a reader in `settings-store-readers.ts` beside
  `project.allowAgentMerge`, and a `project.allowDockerSocket::set` operation in
  `settings-operations.ts` (`repoOperation` takes the new field), so an accepted
  proposal writes it.
- **Client:** the repository store (`client/stores/repo-store.ts`) sends
  `allowDockerSocket`, and a toggle component beside `AgentPermissions.tsx`
  renders the row.
- **Catalogue and UI:** `project.allowDockerSocket` in
  `settings-catalogue/project-settings.ts`, declared like
  `project.allowAgentMerge` (same tab and "Agent permissions" section,
  `propose: { kind: "yes" }`), with a description that says it gives the
  project's services control of the Docker host. The agent can read it with
  `shipit settings get` and can propose it; only the user's accept on the
  proposal card, or the toggle, turns it on.

## Where the build differs from the design above

- **Code layout.** `parseComposeContent` runs the raw syntax checks and
  `validateResolvedModel` the security checks (`compose-generator.ts`);
  `rewriteResolvedModel` writes the snapshot; `ConfinedCompose`
  (`compose-helper.ts`) runs the confined commands; `compose-start-record.ts`
  holds the stop record. `parseComposeFile` and `parseUserNamedVolumes` are
  gone. The plugin readers take a `ProjectComposeAccess` (a confined read, the
  socket grant, and the ops flag).
- **When a refusal shows.** A security refusal appears when a start resolves
  that service. A manual service is not checked until it is started, and the
  plugin preflight and the secrets-status refresh see only the raw syntax
  checks.
- **Compose's own normalization accepted:** `name: <project>_<key>` on
  declarations, and the implicit `networks: {default: null}` on the trusted
  proxy.
- **Snapshot.** On 5.5.1, `config` inlines `env_file` and drops the key, and
  inlines `label_file` but keeps the key. So a non-empty `env_file` is refused
  as not inlined, and `label_file` is removed. `ports` is dropped from the
  snapshot, because the override resets it anyway.
- **`$` in values.** `config` prints every `$` as `$$`. ShipIt removes that
  escaping once when it reads the output (`unescapeComposeDollars`), checks the
  true values, and `serializeComposeModel` escapes them once again.
- **Networks.** `config` writes `networks: {default: null}` for a service that
  names no network. The snapshot drops that entry, and the unused `default`
  network, so the service joins only `shipit-session`, as before.
- **Project secret copies** are mode 0644 inside a 0700 root-owned directory,
  so a service that runs as a non-root user can read its own secret. They are
  this session's own secrets (requirement 7's accidental-reach class).
- **A Stop during the resolve** of a multi-service start does not narrow
  `build`: every service with `build:` in the snapshot is built.
- **A plugin-only start** in a project that has a compose file skips orphan
  removal, because it read no service list.
- **Settings.** The registry login is copied to `<stateDir>/compose-registry-login`;
  `SHIPIT_SERVICE_ENV_HOST_DIR` supplies the service-env directory's
  Docker-host path when it is outside the workspace volume.
- **Containers started before this change** have no stop record; `stop` stops
  them model-free.

## What each requirement maps to

| Req | Closed by |
|---|---|
| 1 (symlinked references) | Mechanism 1 — every read Compose makes is confined, no exception; ShipIt reads no project file on the orchestrator |
| 2 (interpolation / `extends`, all modes) | Mechanism 2 steps 1–6 |
| 2a (cross-session / shared-volume root, all modes) | Mechanism 1 (reads) + Mechanism 2 bind, named-volume, `volumes_from`, and secret-file rules (mounts) |
| 3 (non-`./` relative sources) | Mechanism 2 steps 3–4 (rewritten or refused) |
| 4 (bind deployment) | out of scope for mounts — follow-up on planning#620; Mechanism 1 confines reads there too |
| 5 (clear refusals) | `ComposeValidationError` naming field, resolved value, and fix; a container that cannot start says so |
| 6 (fail closed; plain stacks keep working) | failed `config`, container, or unrecognised mount refuses the start; in-workspace binds and `/persist` are rewritten, not refused; file references need no special rule; plugin-only stacks keep the override-only path |
| 7 (no reach on purpose, every mode) | Mechanisms 1 and 2 for reads and mounts; Mechanism 2 step 3 capability, security-option, and build rules in every mode |
| 8 (only the user grants the socket) | Mechanism 2 step 3 socket grant; *The socket grant setting* |

## Key files (to touch)

- `compose-cli.ts` — run `config`, `build`, and `up --no-build` in confined
  containers with the per-command mounts, working directory, user, isolation,
  and cleanup by name; the session identity and the helper image on
  `ComposeCli`; `up` takes the snapshot path and drops `--remove-orphans`;
  `stop` with the start's snapshot and override; `ps`, `logs`, and the final
  `down` with `-p`, no model file, and an empty ShipIt working directory
  (the plain `docker rm`/`inspect` calls unchanged);
  the fix added to path-read failures.
- `service-manager.ts` — resolve-validate-rewrite in `withUpInFlight` before the
  in-flight count; plugin stubs and build model on stdin; per-start override; orphan removal by
  name before `up`; `build` before `up`; one snapshot per start; service map
  from the raw bytes of the confined run; override-only path kept; both log
  paths with `-p` and no model file.
- `service-poller.ts` — `ps` with `-p`, no model file, and the empty working
  directory.
- `compose-generator.ts` — the syntax checks run on the raw bytes the confined
  run returns (no orchestrator-side read); the security checks run on the
  resolved model; `provider` refusal; bind rule with today's
  socket allowance; named-volume, `volumes_from`, and secret-file rules;
  `rewriteVolumes` on absolute sources with ShipIt volume declarations beside
  the mounts; the override no longer rewrites volumes and moves into
  `compose/`.
- `secret-resolver.ts` / `service-manager.ts` — write project secret/config
  copies into `<sessionDir>/state/compose/secrets/`, root-only; the
  service-env files are unchanged; the registry-login copy for `up`. On volume
  teardown, remove the volumes labelled with this project, by name.
- `services/plugin-services.ts`, `api-routes-plugin-repos.ts` — read project
  service names from the confined run's raw bytes, not the file.
- `app-lifecycle.ts` / `startup-janitor.ts` — resolve the helper image; sweep
  leftover helper containers by label.
- The helper image, in every shipped deployment: a new Dockerfile target in
  `docker/`; a helper-image service in each deployment's Compose definition;
  and the image lists that `docker/local/dev.sh`, `docker/local/prod.sh`,
  `deployment/local/lib.sh` (the local install and update path), and
  `deployment/vps/deploy.sh` build, so no shipped deployment lacks it (req 4).
- `compose-generator.ts` (again) — `SAFE_ADDED_CAPABILITIES` and the Open-session
  `cap_add` rule; the `security_opt` rule; `validateBuildSecurity` in every
  mode. `service-manager.ts` / `service-manager-setup.ts` — the socket grant
  read from `RepoStore` at each start.
- The socket grant setting: `repo-store.ts`, `shared/database.ts`, the shared
  `RepoInfo` type, `api-routes-session-repos.ts`, `settings-apply.ts`,
  `settings-store-readers.ts`, `settings-operations.ts`,
  `settings-catalogue/project-settings.ts`, `client/stores/repo-store.ts`, and a
  toggle beside `AgentPermissions.tsx` (see *The socket grant setting*).
- Docs: `shipit-docs/compose.md` (interpolated sources, symlinked references,
  relative sources, `volumes_from`, `provider`, the capability, security-option,
  and build rules, the socket grant), `shipit-docs/wiki/repos-and-sandboxes.md`
  (the new per-repository toggle),
  `docs/172-agent-containment/plan.md` (audit),
  `docs/086-shipit-yaml-and-compose/plan.md` (rewrite rules move).

## What cannot be verified here

No Docker in a session container. Unit tests cover the `docker run` arguments
per command (mounts, no socket for `config`, `--network none`, user and group,
label, cleanup on cancel), the ownership changes, resolved-model validation over
recorded `config` output (a plain `./sub` stack passes and gets its volume
declaration; the ops socket mount passes; an interpolated outside bind, a
reserved named volume, `volumes_from: container:…`, and `provider` are refused;
an Open-session `cap_add` on the safe list passes and one off it is refused; a
`security_opt` other than `no-new-privileges` and an Open-session
`build.privileged` are refused; the socket mount passes only with the key and
the grant, and is refused with the setting's name when the grant is off; in an
Open ops session the trusted proxy passes and a raw socket mount in another
service is refused; `volumes_from` or `pid: service:` naming the proxy is
refused; a sandbox's
socket mount is refused),
the grant route's refusal of a session's containers, the rewrite, the secret-file copy, the removal of file keys, the plugin-only
path, and every fail-closed path.

### Deployment checks run on 2026-09-29

On a host with Docker Engine 29.7.2, with the helper image built from this
branch and ShipIt's own flags and functions (not a ShipIt instance), these
passed:

- The helper image builds; Docker's apt repository has
  `docker-compose-plugin=5.5.1-1~debian.12~bookworm`. A helper container starts
  in about 0.18 s.
- The pinned proxy digest is Docker Hub's for
  `tecnativa/docker-socket-proxy:0.3.0`, and the pinned reference pulls.
- `config --no-consistency <names>` with the stubs on `-f -`: the named
  services, a profile from `extends`, the dependencies, and a plugin dependency
  resolve; a profile peer is left out; `env_file` is inlined; the raw-bytes
  framing returns the file exactly. ShipIt's validator accepts the real output.
- A symlinked `env_file`, project file, and build context that point outside
  the workspace are not found inside the helper.
- `build` as the session user plus the socket group, with `--network none`,
  builds; `up --no-build` as root from the snapshot and override starts the
  services with the right user, values, labels, mounts, and secret (readable
  by a non-root service).
- `ps` and `logs` with only `-p` in an empty directory; `stop` with the start's
  pair runs `pre_stop`; a model-free `down --volumes` removes the containers,
  networks, and every declared volume.

They found three defects, fixed in this branch: a kept `label_file` key was
refused, `$` was escaped twice, and every service joined a second network (see
*Where the build differs*). A dependency behind a profile that is not enabled
is refused by `config`, as today's `up` refuses it.

Still open, because they need a ShipIt instance that runs this branch: a
private image pull with the copied login, `SHIPIT_SERVICE_ENV_HOST_DIR`, the
helper-missing refusal on a start and on the plugin card, orphan removal, an
existing ops session's proxy, a plugin-only stack, and the start latency of a
whole ShipIt start.

These need a check on a deployment, listed in the PR test plan:

- Choose the pinned `docker-compose-plugin` version (not 2.34.0) and confirm
  on it: `config <names>`
  enables each named service (also with a profile from `extends`) and includes
  its dependencies; `--no-consistency` accepts a dependency on a plugin
  service through the plugin stubs; `-f -` works beside a file `-f`; `config` inlines `env_file` and
  `label_file` values; whether `config` escapes `$`; `up --no-build` loads a
  snapshot whose build contexts are not mounted, and leaves running services
  that are not in the snapshot alone; `config --no-consistency` keeps a
  `persist/<sub>:/data` source as the named-volume source `persist/<sub>`. If
  that version refuses the name, the fallback is to give `config` a copy of the
  project file with the short form written in the long form, mounted over the
  original path inside the confined container, so relative paths still resolve
  as before.
- `ps`, `logs`, and `down` work with `-p <project>` and no model file
  (else the stack-wide-model fallback in Mechanism 1); `stop` with a start's
  snapshot and override runs the service's `pre_stop` hook.
- The confined containers reach the daemon through the socket with
  `--network none`, as the session identity plus the socket group; `up` pulls
  a private service image with the mounted client configuration.
- A symlinked `env_file`, `extends` file, build context, and project file that
  point outside the workspace fail inside the container.
- The added start latency is acceptable, and a plain stack (workspace binds and
  `/persist` only) and a plugin-only stack start unchanged.
- On the pinned version, `config` output adds `networks: {default: null}` and
  `name: <project>_<key>` in exactly those forms, adds no service field outside
  `CLASSIFIED_SERVICE_FIELDS`, and drops `env_file`/`label_file` once inlined.
- `stop` from a start's snapshot and override works on the orchestrator,
  where the override's Docker-host paths do not exist.
- `up` loads a project secret copy by its Docker-host path, and a non-root
  service can read it.
- Orphan removal removes only containers of services no longer in the file or
  the plugin list, and keeps one-off `run` containers.
- A model-free `down --volumes` also removes the `persist` and
  session-workspace volumes ShipIt declared, found by project label.
- `SHIPIT_SERVICE_ENV_HOST_DIR` works for a service-env directory outside the
  workspace volume, and its absence refuses the start with a message naming it.
- The helper-missing refusal appears on a plain stack start and on the plugin
  card; the helper runs with `--cap-drop ALL` and `--pull never`.
- The trusted proxy's pinned digest matches Docker Hub's for
  `tecnativa/docker-socket-proxy:0.3.0` (read from ghcr.io).
