---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Run the Compose commands that read project files in confined throwaway containers, resolve the model once, validate and rewrite that snapshot, and start `up` from exactly it.
---

# 318 — Compose remaining file escapes

Implements [requirements.md](requirements.md). Design; nothing here is built yet.
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

Requirement 4's bind-deployment case is out of scope (requirements Q1); tracked
as a follow-up on planning#620.

## Design history

Seven review rounds on 2026-09-27/28 shaped this plan. Rounds 1–5 hardened an
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
| 8 | Plugin preflight, plugin issue collection, and `parseUserNamedVolumes` also read the project file on the orchestrator | Mechanism 2 — every reader uses the resolved model |
| 9 (run `c752d0d7-2b72-4994-95e7-743c74e93c72`) | `build` mounted all of `compose/`, and the override holds plugin credential values inline | Mechanism 1 — `build` mounts only its snapshot file |
| 9 | The orchestrator image holds ShipIt's own files (`/app`), which a build context could name | Mechanism 1 — a dedicated minimal helper image |
| 9 | `up` always passes `--build` today, so building only missing images would ignore an edited Dockerfile | Mechanism 1 — `build` runs every time, for the services `up` starts |
| 9 | The project secret copies need the same ownership handoff | Mechanism 1 — included in the handoff |
| 10 (run `8c2c20a0-bd6e-4375-978a-d387b620aa99`) | A project service can depend on a plugin service, which the project file alone does not declare | Mechanism 2 step 1 — `config` skips the consistency check; `up` checks with the override merged |
| 10 | Enabling every profile makes a dormant service's missing `env_file` block the stack | Mechanism 2 step 1 — only the profiles this start needs; the service map comes from the raw bytes, as today |
| 11 (run `f390d1c3-db8d-4a42-aaa6-08a6e147440e`) | A snapshot of only the named services leaves override entries with no image; with `--remove-orphans` it would also remove the other services' containers | Mechanism 2 step 1 — every service enabled for the start; step 6 — a per-start override |
| 11 | A plugin service can be started by name, and `build` without the override cannot resolve a `depends_on` on a plugin service | Mechanism 2 step 1 — plugin names add no profile; step 6 — a credential-free build view |
| 10 | Compose reads `PWD/.env`, and today's working directory is the workspace | Mechanism 1 — every confined run uses the workspace as its working directory |
| 10 | A confined read failure must still name the fix (req 5) | Mechanism 1 — ShipIt adds the fix to Compose's message |
| 10 | Private image pulls use the orchestrator's Docker client configuration | Mechanism 1 — mounted into `up` only |

## Mechanism 1 — confined Compose containers

### Which commands run confined, and what each sees

Each command that makes Compose read project files runs in its own throwaway
container, and each sees only what it needs. Today these commands are spawned
by `defaultComposeRunner` / `defaultComposeQuery` (`compose-cli.ts`) as
`docker compose …`; they become `docker run … <image> docker compose …`.

| Command | Workspace | Snapshot | Project secret/config copies | Override + service-env files | Docker client config | Docker socket |
|---|---|---|---|---|---|---|
| `config` (Mechanism 2 step 1) | read-only | — | — | — | — | no |
| reading the project file alone (reconcile; a reader with no run yet) | read-only | — | — | — | — | no |
| reading a project `secrets`/`configs` file (step 4) | read-only | — | — | — | — | no |
| `build` | read-write | its snapshot and build-view files only | read-only | — | — | yes |
| `up --no-build` | — | yes | — | yes | read-only | yes |

- **Registry credentials reach `up` only.** Today Compose inherits
  `DOCKER_CONFIG` / `HOME` (`COMPOSE_ENV_PASSTHROUGH`, `compose-cli.ts`), so it
  uses whatever registry login the orchestrator has when it pulls an image.
  That configuration is an orchestrator file, so only `up --no-build`, which
  reads no project path, mounts it; private service images keep pulling. `config`
  and `build` read project paths, so they do not get it. **One behaviour
  change** (the requirement 6 exception, requirements Q9): a build whose base
  image needs the orchestrator's registry login now fails, with a message that
  says why and to name a pullable image or publish the image instead (req 5). Giving those credentials to a container
  that reads project paths would let a project copy them into an image.

- **A build can read the project's own secret files.** `build.secrets` makes
  the build read a project secret file, and step 4 points the snapshot at
  ShipIt's copy of it. So `build` mounts those copies, read-only, at the
  Docker-host path the snapshot names. They are the project's own content, kept
  in a per-session directory of their own, apart from ShipIt's secret files for
  `x-shipit-secrets`, which no confined container mounts.

- **ShipIt's service-env files never share a container with project reads.**
  They hold values for this session's services. A build reads the context and
  Dockerfile the project names, so a build that could also see those files could
  put them into an image. The same holds for the override, which carries plugin
  credential values inline (`mergePluginCredentialEnv`, `compose-generator.ts`).
  So `build` runs first, in its own container, with its snapshot file and a
  build view of the override that holds no credential and no `env_file`
  (Mechanism 2 step 6), and `up` then runs with `--no-build`. Today `up` and `upService` always pass `--build`
  (`compose-cli.ts`), so `build` runs every time, for the services that `up`
  starts; an edited Dockerfile or context is picked up as it is today.
- **`up` does not see the workspace.** After step 4 the snapshot names no file
  `up` reads, so nothing needs it.
- The workspace comes from the shared workspace volume at this session's exact
  subpath — the same confined mount `.` uses (`workspaceVolumeMount`,
  planning#619). Every mount appears at the path the orchestrator uses, so the
  absolute paths in the snapshot mean the same thing inside and outside.
- The snapshot and the override live in a new `compose/` subdirectory of
  `<sessionDir>/state`, and only that subdirectory is mounted, read-only. The
  rest of the state directory holds orchestrator-only files such as
  `.env.agent`. The service-env files are mounted read-only from this session's
  directory under `SHIPIT_SERVICE_ENV_DIR`, from its Docker-host location.
- Nothing else is mounted: not another session, not the shared volume root
  (which holds `.shipit.db`), and no orchestrator file. The image is a minimal
  helper image, not the orchestrator's (see *How each container runs*).

The other Compose commands stay on the orchestrator: `ps` (the status poller
runs it every 5 seconds per session, `service-poller.ts`), `logs` (both log
paths in `service-manager.ts`), `stop`, `down`, `rm`, and `inspect`. A container
start for each would cost too much, and they do not need one: they run with
`-p <project>` and **no model file**, so Compose finds the stack's containers by
the project label and opens no project file and no snapshot. That the
installed Compose version supports this for each of these commands is a
deployment check. If it does not, the fallback is a stack-wide model, resolved
in the confined container like the snapshot but with every profile enabled and
env-file resolution off, stripped of file keys, and validated the same way.

### How each container runs

- **Image:** a dedicated minimal helper image that holds only a base system,
  the Docker CLI, and the Compose plugin. It is not the orchestrator's image,
  which holds ShipIt's own files (`/app`, `docker/Dockerfile.prod`) that a build
  context or a symlink could name. It is built with the orchestrator image, from
  the same Docker apt repository, so Compose is the same version ShipIt runs
  today, and its reference is resolved at startup, as `resolveWorkerImageId`
  resolves the worker image (`app-lifecycle.ts`). If it is missing, starts are
  refused with a message that says so.
- **Isolation:** `--rm`, `--network none` (the CLI reaches the daemon through
  the mounted socket), a read-only root filesystem with a tmpfs `/tmp`, and
  `no-new-privileges`.
- **User:** the session identity (`identityForSession`), with the socket's group
  added when the socket is mounted. Anything a build writes into the workspace
  is owned as the agent's files are, which is consistent with docs/270.
- **Environment:** `composeSpawnEnv()`'s allowlist only, as today; no
  credentials in it.
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
  reference, or the symlink it follows, must point inside it (req 5). The
  output stream to the service log is unchanged.

### ShipIt's inputs must be readable by the session identity

The override and the service-env files are written `0600 root` today, in
directories created `0700 root` (`writeComposeOverride`,
`writeServiceEnvFilesToRoot`); ShipIt's secret writer does the same
(`writeIsolatedSecretFiles`). ShipIt hands the `compose/` directory, the
per-session service-env directory, the per-session directory of project
secret/config copies, and their files to the session identity (root-gated, as
the git drop in `git-tree-uid.ts` is). The roots above them must allow
traversal.

**This changes nothing the agent can reach.** None of these paths is inside the
workspace or mounted into the agent container, and no confined container that
reads project paths sees the service-env files. That the agent "cannot read the
service-env files" was only ever protection against the agent *accidentally*
reading a service-only key, not a boundary against a rogue agent, which can
already expose any value its services receive (render it in a page and snapshot
it, log it). The change keeps that hygiene as it is.
`assertServiceEnvRootOutsideWorkspace` stays.

ShipIt's docker-secret files are not mounted: the override names them by their
Docker-host path (`composeSecretFilePath`), and the daemon mounts them, as
today.

### What this gives

Every file Compose reads by a path the project names — the project file itself,
`env_file`, `label_file`, `.env`, `extends` files, build contexts,
Dockerfiles and their ignore files, `build.ssh` keys, local build caches — is
looked up inside a container that holds only this session's workspace. A
symlink to anything else finds nothing, or the helper image's base system,
which holds nothing of ShipIt, the host, or another session. So none of
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

They parse the raw bytes of the project file that the latest confined run
returned, as they parse the file today; when there is none yet, ShipIt reads the
file through a confined container. So the service map, the service names, and
the volume declarations come from the raw file as today, and services behind a
profile are listed without being resolved. What runs comes only from the
snapshot.

### The before-`up` sequence

1. **Resolve.** In a confined container (workspace read-only, no socket), run
   `docker compose -p <project> -f <project file> --profile <p>… config
   --no-consistency`, with one `--profile` for each profile of the project
   services this start names (a plugin service name adds none), and no service
   names. So the snapshot holds every service Compose enables for this start —
   the services with no profile plus the named services' profiles, which is the
   set `up <names>` enables today. That matters because `up` passes
   `--remove-orphans` (`compose-cli.ts`): a snapshot that held only the named
   services would make Compose remove the containers of the others. A profiled
   service that this start does not name is not resolved, so its missing
   `env_file` cannot block the start. `--no-consistency` lets a project service
   depend on a plugin service that only the override declares; Compose checks
   consistency again at `up`, with the override merged. Compose reads the
   project file, `.env`, `env_file`s, `label_file`s, and `extends` files here,
   all inside the container. The same run also returns the project file's raw
   bytes, for step 2.
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
     and `{type: bind, source: data}` alike. The one exception is today's
     Docker socket allowance, unchanged: `/var/run/docker.sock` with
     `compose.docker-socket: true`, and in contained sessions only the trusted
     proxy's read-only mount (`validateServiceSecurity`; the ops template in
     `templates-ops.ts` depends on it).
   - **Named-volume sources.** Must name a volume declared in the resolved
     top-level `volumes:`, never a name reserved for ShipIt's own mounts; the
     declarations get the top-level rules (no reserved name, no `driver_opts`,
     no `external`, no other `name:`) (req 2a).
   - **`volumes_from`.** Only a service of this project, whose own mounts are
     checked here. The `container:<name>` form is refused (req 2a); today it is
     refused in contained sessions only.
   - **Top-level `secrets`/`configs` `file:`.** Must resolve inside the
     workspace (step 4 replaces it).
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
     container (workspace read-only, no socket), written into a per-session
     directory for project copies (beside, not inside, ShipIt's own secret
     files), and named by its Docker-host path, as ShipIt's own secret files
     are (`composeSecretFilePath`). The daemon then binds ShipIt's
     copy, never a workspace path it would resolve on the host. This runs only
     when the project declares such a file.
   - The `env_file` and `label_file` keys are removed, because their values are
     already inlined. A snapshot that still names a file `up` would read is
     refused.
5. **Write.** ShipIt writes the result as this start's snapshot in
   `<sessionDir>/state/compose/`: a new file per start, never changed after it
   is written, removed once a later snapshot replaces it and no start uses it.
   The agent container never mounts the state directory
   (`SESSION_STATE_SHARED_SUBDIR` is its only mounted part), so the agent cannot
   change the file. ShipIt writes `$` so that Compose's second parse gives back
   exactly the validated values.
6. **Start.** ShipIt writes this start's override for exactly the services in
   the snapshot plus the admitted plugin services. Today the override has an
   entry for every parsed project service (`generateComposeOverride`); an entry
   for a service the snapshot does not hold would have no image or build, and
   Compose would refuse it. It also writes a **build view** of that override:
   the plugin service definitions only, with no credential value and no
   `env_file`, so that a project service's `depends_on` on a plugin service
   resolves during the build. Then `build` runs with `-f <snapshot> -f <build
   view>`, and `up --no-build` with `-f <snapshot> -f <override>`, each in its
   confined container (Mechanism 1). The orchestrator-side commands use no
   model file (Mechanism 1).

**No project file** (`noProjectCompose`, a stack of plugin services only):
steps 1–5 are skipped, and `up --no-build` runs in its confined container with
the override alone, as the override-only path does today (`service-manager.ts`,
`start()`).

### Where this runs

`withUpInFlight` (`service-manager.ts`) validates synchronously before it takes
the in-flight count, so that a rejected parse never gets a polling exemption.
`config` is now a container run, so steps 1–5 become an awaited step that
completes **before** the count is taken, and `fn()` receives the snapshot path
it must start from. Reconcile starts nothing, so it only reads the project
file's raw bytes through a confined container and parses them as today.

### What moves out of the override

`rewriteVolumes` moves from `generateComposeOverride` to step 4 and runs on
absolute sources. The override keeps only what ShipIt adds (labels, networks,
user, secrets wiring, the entrypoint bind, overlay dep-dir mounts). Overlay
dep-dir matching (`overlayMountsForService`) reads the rewritten mounts. The
override moves into the `compose/` subdirectory.

### Failure

A `config` that fails (bad interpolation, a missing `extends` base, an undefined
volume, a file the project names that does not exist in the workspace) is a
`ComposeValidationError` with Compose's message, and nothing starts (req 6). A
refused value names the field, the resolved value, and what to use instead
(req 5).

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

## Key files (to touch)

- `compose-cli.ts` — run `config`, `build`, and `up --no-build` in confined
  containers with the per-command mounts, working directory, user, isolation,
  and cleanup by name; the session identity and the helper image on
  `ComposeCli`; `up` takes the snapshot path; `ps`, `logs`, `stop`, `down`,
  `rm` with `-p` and no model file; the fix added to path-read failures.
- `service-manager.ts` — resolve-validate-rewrite in `withUpInFlight` before the
  in-flight count; `build` before `up`; one snapshot per start; service map from
  the raw bytes of the confined run; override-only path kept; both log paths
  with `-p` and no model file.
- `service-poller.ts` — `ps` with `-p` and no model file.
- `compose-generator.ts` — the syntax checks run on the raw bytes the confined
  run returns (no orchestrator-side read); the security checks run on the
  resolved model; `provider` refusal; bind rule with today's
  socket allowance; named-volume, `volumes_from`, and secret-file rules;
  `rewriteVolumes` on absolute sources with ShipIt volume declarations beside
  the mounts; the override no longer rewrites volumes and moves into
  `compose/`.
- `secret-resolver.ts` — hand the per-session service-env directory and files
  to the session identity (root-gated); write project secret/config copies
  into their own per-session directory.
- `services/plugin-services.ts`, `api-routes-plugin-repos.ts` — read project
  service names from the confined run's raw bytes, not the file.
- `app-lifecycle.ts` / `startup-janitor.ts` — resolve the helper image; sweep
  leftover helper containers by label.
- `docker/` and `deploy.sh` — a minimal Compose helper image (base system,
  Docker CLI, Compose plugin), built with the orchestrator image.
- Docs: `shipit-docs/compose.md` (interpolated sources, symlinked references,
  relative sources, `volumes_from`, `provider`),
  `docs/172-agent-containment/plan.md` (audit),
  `docs/086-shipit-yaml-and-compose/plan.md` (rewrite rules move).

## What cannot be verified here

No Docker in a session container. Unit tests cover the `docker run` arguments
per command (mounts, no socket for `config`, `--network none`, user and group,
label, cleanup on cancel), the ownership changes, resolved-model validation over
recorded `config` output (a plain `./sub` stack passes and gets its volume
declaration; the ops socket mount passes; an interpolated outside bind, a
reserved named volume, `volumes_from: container:…`, and `provider` are refused),
the rewrite, the secret-file copy, the removal of file keys, the plugin-only
path, and every fail-closed path.

These need a check on a deployment, listed in the PR test plan:

- The orchestrator image installs `docker-compose-plugin` with **no version
  pin** (`docker/Dockerfile.prod`); the helper image must get the same version,
  so pinning it in both is recommended. On that version: `config` with the
  named services' profiles yields the same service set `up <names>` enables;
  `--no-consistency` accepts a dependency on a plugin service; `build` accepts
  the build view; `config`
  inlines `env_file` and `label_file` values; whether `config` escapes `$`;
  `up --no-build` loads a snapshot whose build contexts are not mounted.
- `ps`, `logs`, `stop`, `down`, and `rm` work with `-p <project>` and no model
  file (else the stack-wide-model fallback in Mechanism 1).
- The confined containers reach the daemon through the socket with
  `--network none`, as the session identity plus the socket group; `up` pulls
  a private service image with the mounted client configuration.
- A symlinked `env_file`, `extends` file, build context, and project file that
  point outside the workspace fail inside the container.
- The added start latency is acceptable, and a plain stack (workspace binds and
  `/persist` only) and a plugin-only stack start unchanged.
