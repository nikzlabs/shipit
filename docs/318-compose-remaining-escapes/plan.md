---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Run the Compose commands that read project files in a confined throwaway container, resolve the model once, validate and rewrite that snapshot, and start `up` from exactly it.
---

# 318 — Compose remaining file escapes

Implements [requirements.md](requirements.md). Design; nothing here is built yet.
Follows planning#619, which closed the literal `./sub` symlink escape, the direct
shared-volume mount, and `~` sources.

Two mechanisms, one per kind of reach:

- **Files Compose reads** (req 1). Every Compose command that reads project
  files runs in a **confined throwaway container** that sees only this
  session's workspace, ShipIt's own inputs for this stack, and the Docker
  socket. The kernel then confines every read, whatever path or symlink the
  project names. No check-then-use window exists.
- **Mounts the daemon creates** (req 2, 2a, 3). The daemon, not the Compose
  CLI, resolves mount sources on the host, so confinement does not cover them.
  ShipIt **resolves the model once** with `docker compose config`, validates
  that snapshot, rewrites its mounts, and starts `up` from exactly that file.

Requirement 4's bind-deployment case is out of scope (requirements Q1); tracked
as a follow-up on planning#620.

## Design history

Six review rounds on 2026-09-27/28 shaped this plan. Rounds 1–5 hardened an
earlier design: the Compose CLI on the orchestrator, dropped to the session uid
(Q3), plus ShipIt-made copies of every file reference and special handling for
`extends`, `label_file`, `.env`, and Dockerfiles. Round 6 (run
`95167b07-e363-4746-8ab3-5629a99b8153`) showed that the window this design
accepted (Q5) could reach ShipIt's database, and that its special handling broke
stacks that work today. The requester then chose the confined container (Q8),
which removes that handling. The findings that still shape this design:

| Round | Finding | Handled in |
|---|---|---|
| 1 | Validating `source: data` does not rewrite it | Mechanism 2 step 4 — every in-workspace bind is rewritten, whatever its spelling |
| 1 | An interpolated reserved named-volume source passes a bind-only check | Mechanism 2 step 3 — named-volume rules |
| 1 | `config` and `up` must not be separate reads of agent-writable input | Mechanism 2 steps 5–6 — `up` starts from the snapshot |
| 1 | Non-path security checks must not be dropped | Mechanism 2 step 3 — the security set runs on the resolved model |
| 2 | Moving the rewrite leaves the per-session volume undeclared | Mechanism 2 step 4 — declarations sit beside the mounts |
| 2 | Path-string checks refuse Compose's absolute paths | Mechanism 2 steps 1 and 3 — syntax set on the raw file, security set on the resolved model |
| 2 | A content-derived file name is not needed | Mechanism 2 step 5 — one snapshot per start |
| 3 | `volumes_from` with `container:` is refused only in contained sessions | Mechanism 2 step 3 — service-only, every mode |
| 3 | Refusing every outside bind breaks the ops template's socket mount | Mechanism 2 step 3 — today's socket allowance |
| 3 | The security set need not also run on the raw file | Mechanism 2 step 3 — it runs once |
| 5 | `config` without profiles drops profiled services | Mechanism 2 step 2 — every profile enabled |

## Mechanism 1 — the confined Compose container

### Which commands run confined

The commands that make Compose read project files: `config`, `up` (including a
single-service `up`), and `build`. Today they are spawned by
`defaultComposeRunner` / `defaultComposeQuery` (`compose-cli.ts`) as
`docker compose …`; they become `docker run … <image> docker compose …`.

The other Compose commands stay on the orchestrator: `ps` (the status poller
runs it every 5 seconds per session, `service-poller.ts`), `logs` (both log
paths in `service-manager.ts`), `stop`, `down`, `rm`, and `inspect`. A container
start for each would cost too much, and they do not need one: they load only
the snapshot and ShipIt's override. In the snapshot, Compose has already inlined
`env_file` and `label_file` values and resolved `extends`, and ShipIt has
removed the file keys (Mechanism 2 step 4). The project directory is ShipIt's
`compose/` directory, so no project `.env` is read. So these commands open no
file the project names. That this holds on the installed Compose version is a
deployment check.

### What the container sees

| Mount | Source | Where inside | Access |
|---|---|---|---|
| This session's workspace | the shared workspace volume at this session's exact subpath — the same confined mount `.` uses (`workspaceVolumeMount`, planning#619) | the path the orchestrator uses for the workspace | read-write |
| ShipIt's stack inputs: the override and the snapshots | a new `compose/` subdirectory of `<sessionDir>/state` | its orchestrator path | read-only |
| This session's service-env files | the per-session directory under `SHIPIT_SERVICE_ENV_DIR`, from its Docker-host location | its orchestrator path | read-only |
| The Docker socket | the host socket | its usual path | `up` and `build` only; `config` gets none |

Nothing else: not the rest of the state directory (which holds orchestrator-only
files such as `.env.agent`), not another session, not the shared volume root
(which holds `.shipit.db`), and no orchestrator file except the image's own.
Each file is mounted at the same path the orchestrator uses, so the absolute
paths in the snapshot mean the same thing inside and outside the container.

### How it runs

- **Image:** the orchestrator's own image, so Compose is the same version ShipIt
  runs today. It is resolved at startup, as `resolveWorkerImageId` resolves the
  worker image (`app-lifecycle.ts`).
- **Isolation:** `--rm`, `--network none` (the CLI reaches the daemon through
  the mounted socket), a read-only root filesystem with a tmpfs `/tmp`, and
  `no-new-privileges`.
- **User:** the session identity (`identityForSession`), with the socket's group
  added. Anything Compose writes into the workspace is owned as the agent's files
  are, which is consistent with docs/270.
- **Environment:** `composeSpawnEnv()`'s allowlist only, as today; no
  credentials.
- **Cleanup:** each container has a unique name and a
  `shipit-compose-helper=<sessionId>` label. On cancel or timeout ShipIt removes
  it by name, because killing the `docker run` client does not stop the
  container. The startup janitor removes leftovers by label.
- **Failure:** if the container cannot start (image missing, daemon error),
  ShipIt refuses the start with a message that says so (req 5, req 6). The
  output stream to the service log is unchanged.

### ShipIt's inputs must be readable by the session identity

The override and the service-env files are written `0600 root` today, in
directories created `0700 root` (`writeComposeOverride`,
`writeServiceEnvFilesToRoot`). ShipIt hands the `compose/` directory, the
per-session service-env directory, and their files to the session identity
(root-gated, as the git drop in `git-tree-uid.ts` is). The roots above them must
allow traversal.

**This changes nothing the agent can reach.** None of these paths is inside the
workspace or mounted into the agent container, so they are reachable only by
ShipIt's own confined Compose container. That the agent "cannot read the
service-env files" was only ever protection against the agent *accidentally*
reading a service-only key, not a boundary against a rogue agent, which can
already expose any value its services receive (render it in a page and snapshot
it, log it). The change keeps that hygiene as it is.
`assertServiceEnvRootOutsideWorkspace` stays.

ShipIt's docker-secret files are not mounted: the override names them by their
Docker-host path (`composeSecretFilePath`), and the daemon mounts them, as
today.

### What this gives

Every file Compose reads by a path the project names — `env_file`,
`label_file`, `.env`, `extends` files, build contexts, Dockerfiles and their
ignore files, `build.ssh` keys, local build caches — is looked up inside the
container, where only this session's workspace and this stack's inputs exist. A
symlink to anything else finds nothing, or the image's own files. So none of
these needs a rule of its own, and stacks that use them keep working (req 1,
req 6). This holds in the bind deployment too, for these reads.

## Mechanism 2 — resolve once, validate, rewrite, start from that file

`parseComposeFile` reads the raw YAML. It never interpolates, and Compose, not
ShipIt, resolves `extends`, so the strings it checks are not what `up` would
run.

### The before-`up` sequence

1. **Raw gate.** The **syntax set** of `parseComposeFile`'s checks runs on the
   raw project file, as today: the contained-session interpolation refusal, the
   contained `extends` refusal, the `include:` refusal, and the path-string
   checks (no `${`, no leading `/`, no `..`, no `~`). It gives early, clear
   refusals. It is not the boundary — step 3 is — so a file changed after this
   gate gains nothing.
2. **Resolve.** In the confined container, without the socket, run
   `docker compose -p <project> -f <project file> --profile '*' config`. Every
   profile is enabled, so services behind a profile are in the snapshot and can
   still be started by name; each keeps its `profiles:` for `up`. Compose reads
   the `.env`, the `env_file`s, the `label_file`s, and the `extends` files here,
   all inside the container.
3. **Validate the resolved model.** The **security set** runs here, once: the
   non-path checks of `validateServiceSecurity` and `validateBuildSecurity`
   (`privileged`, `network_mode`, `cap_add`, `devices`, `user`, labels, and so
   on) and the top-level volume, network, secret, and config declaration rules.
   So an interpolated or `extends`-inherited value is refused in every mode
   (req 2). It accepts only the normalization Compose itself adds (the
   project-default `name:` on a volume or network, the implicit `default`
   network). Then the mount rules, because the daemon resolves these on the
   host:
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
   - **`volumes_from`.** In every mode, only a service of this project, whose
     own mounts are checked here. The `container:<name>` form is refused
     (req 2a); today it is refused in contained sessions only.
   - **Top-level `secrets`/`configs` `file:`.** Must resolve inside the
     workspace, as the raw check requires today; the daemon binds this path.
   - **Anything left unresolved** — a `$` in a path field, a source Compose did
     not make absolute, a mount field ShipIt does not recognise — is refused
     (req 6).
4. **Rewrite.** Every in-workspace bind becomes a subpath of the per-session
   workspace volume; `.` becomes the shared volume at the exact session subpath
   (`workspaceVolumeMount`, planning#619); `/persist` sources are rewritten as
   today. The file that holds a mount of a ShipIt volume also declares that
   volume (today `generateComposeOverride` declares the per-session volume only
   for its *own* mounts). The `env_file` and `label_file` keys are removed,
   because their values are already inlined; a snapshot that still names a file
   the orchestrator-side commands would read is refused.
5. **Write.** ShipIt writes the result as this start's snapshot in
   `<sessionDir>/state/compose/`: a new file per start, never changed after it
   is written, removed once a later snapshot replaces it and no start uses it.
   The agent container never mounts the state directory
   (`SESSION_STATE_SHARED_SUBDIR` is its only mounted part), so the agent cannot
   change the file. ShipIt writes `$` so that Compose's second parse gives back
   exactly the validated values.
6. **Start.** The `up` that ran this validation runs in the confined container
   with `-f <its snapshot> -f <override>`. Later commands use the latest
   snapshot.

The service map ShipIt builds (`parseProjectCompose`) comes from the resolved
model, so what ShipIt shows and what runs cannot differ.

### Where this runs

`withUpInFlight` (`service-manager.ts`) validates synchronously before it takes
the in-flight count, so that a rejected parse never gets a polling exemption.
`config` is now a container run, so steps 1–5 become an awaited step that
completes **before** the count is taken, and `fn()` receives the snapshot path
it must start from. The reconcile path uses the same sequence.

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
refused mount names the field, the resolved value, and what to use instead
(req 5).

## What each requirement maps to

| Req | Closed by |
|---|---|
| 1 (symlinked references) | Mechanism 1 — every read Compose makes is confined, no exception |
| 2 (interpolation / `extends`, all modes) | Mechanism 2 steps 2–6; raw gate kept for early messages |
| 2a (cross-session / shared-volume root, all modes) | Mechanism 1 (reads) + Mechanism 2 bind, named-volume, and `volumes_from` rules (mounts) |
| 3 (non-`./` relative sources) | Mechanism 2 steps 3–4 (rewritten or refused) |
| 4 (bind deployment) | out of scope for mounts — follow-up on planning#620; Mechanism 1 confines reads there too |
| 5 (clear refusals) | `ComposeValidationError` naming field, value, and fix; a container that cannot start says so |
| 6 (fail closed; plain stacks keep working) | failed `config`, container, or unrecognised mount refuses the start; in-workspace binds and `/persist` are rewritten, not refused; file references need no special rule |

## Key files (to touch)

- `compose-cli.ts` — run `config`, `up`, and `build` through the confined
  container (mounts, user, isolation, cleanup by name); the session identity
  and the helper image on `ComposeCli`; `up` takes the snapshot path.
- `service-manager.ts` — resolve-validate-rewrite in `withUpInFlight` before
  the in-flight count and in reconcile; one snapshot per start; service map
  from the resolved model. The log paths and the poller are unchanged.
- `compose-generator.ts` — split the checks into a syntax set (raw file) and a
  security set (resolved model); bind rule with today's socket allowance,
  named-volume and `volumes_from` rules; `rewriteVolumes` on absolute sources,
  with ShipIt volume declarations beside the mounts; override no longer
  rewrites volumes and moves into `compose/`.
- `secret-resolver.ts` — hand the per-session service-env directory and files
  to the session identity (root-gated).
- `app-lifecycle.ts` / `startup-janitor.ts` — resolve the helper image; sweep
  leftover helper containers by label.
- Docs: `shipit-docs/compose.md` (interpolated sources, symlinked references,
  relative sources, `volumes_from`), `docs/172-agent-containment/plan.md`
  (audit), `docs/086-shipit-yaml-and-compose/plan.md` (rewrite rules move).

## What cannot be verified here

No Docker in a session container. Unit tests cover the `docker run` arguments
(mounts, no socket for `config`, `--network none`, user and group, label,
cleanup on cancel), the ownership changes, resolved-model validation over
recorded `config` output (a plain `./sub` stack passes and gets its volume
declaration; the ops socket mount passes; an interpolated outside bind, a
reserved named volume, and `volumes_from: container:…` are refused), the
rewrite, the removal of file keys, and every fail-closed path.

These need a check on a deployment, listed in the PR test plan:

- The orchestrator image installs `docker-compose-plugin` with **no version
  pin** (`docker/Dockerfile.prod`). On the installed version: `--profile '*'`
  enables every profile; `config` inlines `env_file` and `label_file` values;
  whether `config` escapes `$`; `x-shipit-*` extensions and `profiles:` survive.
- The confined container reaches the daemon through the socket with
  `--network none`, as the session identity plus the socket group.
- `ps`, `logs`, `stop`, and `down` open no build context or secret file when
  they load the snapshot.
- A symlinked `env_file`, `extends` file, and build context that point outside
  the workspace fail inside the container.
- The added start latency is acceptable, and a plain stack (workspace binds and
  `/persist` only) starts unchanged.
