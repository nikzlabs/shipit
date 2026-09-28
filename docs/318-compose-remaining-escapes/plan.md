---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Run Compose as the session uid, resolve the compose model once into ShipIt's state dir, validate and rewrite that file, and start `up` from exactly it.
---

# 318 — Compose remaining file escapes

Implements [requirements.md](requirements.md). Design; nothing here is built yet.
Follows planning#619, which closed the literal `./sub` symlink escape, the direct
shared-volume mount, and `~` sources.

Three parts:

- **Run every Compose command as the session's uid** (Mechanism 1). The 0700
  session seal (docs/270) then denies, at the kernel and at read time, any read
  that resolves into another session or an orchestrator-private tree (req 1,
  req 2a).
- **Resolve the model once, and start `up` from exactly that file**
  (Mechanism 2). ShipIt runs `docker compose config`, validates the resolved
  model with every existing security check plus the path rules below, rewrites
  its mounts, writes it to the session's state dir, and hands that file to `up`
  (req 2, req 3, req 6).
- **Check the physical path of every file reference, and hand Compose a copy**
  (Mechanism 3). The seal does not cover world-readable files outside the
  session, so ShipIt reads each referenced file itself, confirms where the
  opened file really is, and gives Compose a copy in the state dir (req 1).

Requirement 4's bind-deployment case is out of scope (requirements Q1); tracked
as a follow-up on planning#620.

## Review record

ShipIt's reviewer checked the first version of this plan on 2026-09-27 (run
`daf13b1a-d20e-4d6e-a110-a1ed949eef98`). The requester accepted all six
findings. Where each is handled:

| Finding | Handled in |
|---|---|
| 1. Validating `source: data` does not rewrite it | Mechanism 2 — every in-workspace bind is rewritten, whatever its spelling |
| 2. An interpolated reserved *named-volume* source passes a bind-only check | Mechanism 2 — named-volume sources and top-level declarations are checked in the resolved model |
| 3. A uid drop is not a workspace boundary for world-readable files | Mechanism 3 — physical-path check on the opened file, then a copy |
| 4. `config` and `up` were separate reads of agent-writable input | Mechanism 2 — `up` reads only the file ShipIt validated |
| 5. Retiring the raw guards would drop non-path checks | Kept. The raw guards stay; all security checks also run on the resolved model |
| 6. UID wiring gaps (0700 dirs, the log follower, error text) | Mechanism 1 |

A second review on 2026-09-28 (run `5fe6117c-73f9-4edf-bd30-ff1082bc0dc2`)
checked this revision. The requester accepted all its findings (requirements
Q6):

| Finding | Handled in |
|---|---|
| 1. `config` read an `extends` `file:` before ShipIt checked its path | Mechanism 2 step 1 — the `extends` chain is checked before `config` |
| 2. Moving the rewrite left the per-session volume undeclared for a plain `./sub` stack | Mechanism 2 step 4 — the file that holds a ShipIt-volume mount declares that volume |
| 3. The existing path-string checks refuse Compose's absolute paths | Mechanism 2 steps 1 and 3 — raw syntax checks and resolved-model security checks are separate sets |
| 4. Secret and config copies need the Docker host's path | Mechanism 3 |
| 5. `snapshotLogs` is a fourth Compose spawn site | Mechanism 1 |
| 6. A content-derived file name is not needed | Mechanism 2 step 5 — one snapshot per start, never changed after it is written |

A third, fresh review on 2026-09-28 (run
`f8b36dec-ae66-4428-bdcb-7a133e6bbbcf`) checked this revision. The requester
accepted all its findings (requirements Q7):

| Finding | Handled in |
|---|---|
| 1. `volumes_from` (`container:` form) is refused only in contained sessions | Mechanism 2 step 3 — service-only `volumes_from` in every mode |
| 2. `build.ssh` and `local` `cache_from`/`cache_to` read or write host paths | Mechanism 2 step 3 — refused in every mode |
| 3. Refusing every outside bind breaks the ops template's Docker socket mount | Mechanism 2 step 3 — today's socket allowance carries over unchanged |
| 4. Running the security set on the raw file too adds no protection | Mechanism 2 steps 1 and 3 — the security set runs once, on the resolved model |

Later rounds (2026-09-28) are applied under the requester's standing
instruction to apply every reasonable finding (requirements Q7), and repeat
until a review has no important findings.

| Round, run | Finding | Handled in |
|---|---|---|
| 4, `272e35bf-8469-469a-a123-52ee2bf214ab` | `config` opens a service's `label_file` while it loads the model, before any check | Mechanism 2 step 1 — handled before `config` (refined in round 5) |
| 4 | Opening every `env_file` would refuse an absent `required: false` file that works today | Mechanism 3 — an absent optional file is left out, as Compose does |
| 5, `cf41ad91-f0b0-4f30-9d2f-e23d3aaebcdd` | The Dockerfile is read by path after its check, outside the requirement 1 exception | Mechanism 2 step 3 — the checked Dockerfile is given as `dockerfile_inline` |
| 5 | `config` without profiles leaves profiled services out of the snapshot | Mechanism 2 step 2 — every profile enabled |
| 5 | Refusing every `label_file` breaks a stack whose label file is in the workspace | Mechanism 2 step 1 — a checked copy in the project file; refused only in `extends` files |
| 5 (found while applying the above) | `config` read the project file from the workspace again after ShipIt's checks | Mechanism 2 step 1 — `config` reads ShipIt's copy |
| 6, `95167b07-e363-4746-8ab3-5629a99b8153` | The Q5 window can reach ShipIt's database; the `extends` / `label_file` refusals and the Dockerfile inlining break working stacks | Not applied — open question Q8 in requirements.md, because it goes against Q5 and requirement 6 |

## Mechanism 1 — run Compose as the session uid

### One spawn path

Compose is spawned from four places today: `defaultComposeRunner` and
`defaultComposeQuery` (`compose-cli.ts`), and `ServiceManager.streamLogs` and
`ServiceManager.snapshotLogs` (`service-manager.ts`), which each call
`spawn("docker", …)` themselves. All four move to one helper in
`compose-cli.ts` that adds `uid`/`gid` to the spawn options. So no Compose
command reads a file as the orchestrator's user.

- The identity comes from `identityForSession(sessionId)`
  (`session-worker-uid.ts`), threaded into `ComposeCli` at construction.
  `compose-persist.ts` already runs `execFileSync({uid,gid})` as that identity.
- The drop applies only when the orchestrator is root (`process.getuid?.() ===
  0`), the same gate as the git drop (`git-tree-uid.ts`). In dev (non-root) it is
  skipped, as git's is.
- If ShipIt is root and cannot resolve the identity, the command is refused
  rather than run as root (req 6).
- **Socket access survives the drop.** docs/270 verified that Node's
  `spawn({uid,gid})` does not call `setgroups`, so the child keeps the root
  parent's supplementary groups, including the one that grants the Docker socket.
  Tests assert the spawn options; the socket behaviour is a deployment check.
- `down`, `stop`, `ps`, `logs`, `inspect` read no workspace files. They take the
  same path anyway, so there is one spawn path to reason about.

### Files and directories the dropped CLI must reach

The dropped process needs to traverse every directory on the path and read the
file. Today:

| Path | Writer | Today | Change |
|---|---|---|---|
| resolved model (new, Mechanism 2) and compose override | orchestrator, `writeComposeOverride` | override 0600 root, in `<sessionDir>/state` | readable by the session identity. `<sessionDir>` is already owned by it (`sealSessionDir`). |
| per-service env files | `writeServiceEnvFilesToRoot` (`secret-resolver.ts`) | dir `<SHIPIT_SERVICE_ENV_DIR>/<sessionId>` 0700 root; files 0600 root | hand the per-session **directory** and its files to the session identity; the root above it must allow traversal |
| docker-secret files | `writeIsolatedSecretFiles` (`secret-resolver.ts`) | per-session dir 0700 root; files 0600 root | same as the env files |
| copies of project file references (new, Mechanism 3) | orchestrator | — | `env_file` and `.env` copies in the state dir; `secrets`/`configs` copies in the per-session secrets dir; readable by the session identity |
| secrets entrypoint | `stageSecretsEntrypoint` | 0755 root | none |

Each path is already per session, so each is handed to *its* session's identity
and never to another's. The state-dir files that must stay private to ShipIt
(for example `.env.agent`) keep their 0600 root mode; traversal alone does not
expose them.

**This changes nothing the agent can reach.** None of these paths is inside the
workspace or mounted into the agent container, so on the host they are reachable
only by ShipIt's own Compose subprocess. That the agent "cannot read the
service-env files" was only ever protection against the agent *accidentally*
reading a service-only key, not a boundary against a rogue agent, which can
already expose any value its services receive (render it in a page and snapshot
it, log it). The change keeps that hygiene as it is.
`assertServiceEnvRootOutsideWorkspace` stays.

### When the dropped CLI is denied a read

ShipIt's own checks (Mechanisms 2 and 3) run before Compose reads anything the
project names, so a permission-denied read from Compose means a check missed a
case. ShipIt still maps it to a `ComposeValidationError` that names the path and
says to reference a file inside the workspace (req 5), and refuses the start
(req 6), not the runner's generic "command failed".

## Mechanism 2 — resolve once, validate, rewrite, start from that file

`parseComposeFile` reads the raw YAML. It never interpolates, and Compose, not
ShipIt, resolves `extends`, so the strings it checks are not what `up` would
run. Mechanism 2 makes the file `up` reads the file ShipIt checked.

### The before-`up` sequence

1. **Raw gate.** ShipIt reads the project file once, as in Mechanism 3, and
   every step below works on those bytes. `config` does not read the workspace
   file again: it reads ShipIt's copy in the state dir (step 2). Otherwise the
   file could change between ShipIt's checks and Compose's read (round 5).

   `parseComposeFile`'s checks split into two sets. The
   **syntax set** runs on the raw project file only, as today: the
   contained-session interpolation refusal, the contained `extends` refusal,
   the `include:` refusal, and the path-string checks (no `${`, no leading `/`,
   no `..`, no `~`). These keep the clearest messages (first review, finding 5).
   The **security set** runs once, on the resolved model (step 3). Running it on
   the raw file as well would protect nothing more: `config` starts nothing, and
   the resolved model is what `up` runs (third review, finding 4).

   Then, before `config` reads anything else, ShipIt checks the **`extends`
   chain** (Open sessions; contained sessions refuse `extends`). Each
   `extends.file` must be a literal path — one that comes from a variable is
   refused — and its physical path, checked as in Mechanism 3, must be inside
   the workspace. ShipIt parses each such file and checks its own
   `extends.file` entries the same way. This puts the check *before* Compose's
   read, which is what the requirement 1 exception assumes (second review,
   finding 1).

   `config` opens a service's `label_file` while it loads the model, so no
   later check could stop that read (round 4). In the project file, ShipIt
   reads each label file as in Mechanism 3 and, in its copy, points the entry
   at that checked copy, so a label file inside the workspace keeps working
   (req 6; round 5). A `label_file` must be a literal path. In a file of the
   `extends` chain, which Compose reads from the workspace, `label_file` is
   refused with a message to move it into the project file or use `labels:`,
   because that read would not be covered by the requirement 1 exception.
2. **Resolve.** Run `docker compose -p <project> -f <ShipIt's copy>
   --project-directory <directory of the project file> config` as the session
   uid (Mechanism 1). The project directory keeps every relative path resolving
   as it does today. Every profile is enabled, so services behind a profile are
   in the snapshot and can still be started by name; each service keeps its
   `profiles:` for `up` (round 5). Compose's env-file resolution is turned off,
   so Compose does not read `env_file` contents here (Mechanism 3 reads them).
   The project's `.env` is passed as a Mechanism 3 copy through `--env-file`
   (an empty copy when there is none), so the interpolation input is also a
   checked file.
3. **Validate the resolved model.** The security set runs on the resolved
   model: the non-path parts of `validateServiceSecurity` and
   `validateBuildSecurity` (`privileged`, `network_mode`, `cap_add`, `devices`,
   `user`, labels, and so on) and the top-level volume, network, secret, and
   config declaration rules. So an interpolated or `extends`-inherited value is
   refused in every mode (req 2). The syntax set does not run here, because
   Compose has made every path absolute and those checks would refuse all of
   them; the path rules below replace it (second review, finding 3). The
   security set accepts only the normalization Compose itself adds (the
   project-default `name:` on a volume or network, the implicit `default`
   network), and nothing else. The path rules:
   - **Bind sources.** The resolved source is absolute. Inside this session's
     workspace → rewritten (step 4). Outside it → refused (req 2, req 3). This
     covers `./data`, `data`, `.cache`, and `{type: bind, source: data}` alike,
     because Compose has already made them absolute (first review, finding 1).
     One exception carries over unchanged from today's check
     (`validateServiceSecurity`): the Docker socket bind
     `/var/run/docker.sock`, under exactly today's conditions
     (`compose.docker-socket: true`; in contained sessions only the trusted
     proxy's read-only mount). The rewrite leaves it as it is. The shipped ops
     template (`templates-ops.ts`) depends on it (third review, finding 3).
   - **`volumes_from`.** In every mode, an entry must name a service of this
     project, whose own mounts are checked here. The `container:<name>` form is
     refused, because it takes the mounts of a container outside this project
     (req 2a). Today this is refused in contained sessions only (third review,
     finding 1).
   - **Named-volume sources.** A service's volume source must name a volume
     declared in the resolved top-level `volumes:`, and must not be a name
     reserved for ShipIt's own mounts. The top-level checks (no reserved name,
     no `driver_opts`, no `external`, no other `name:`) apply to the resolved
     declarations (req 2a, first review, finding 2).
   - **File references** (`env_file`, top-level `secrets`/`configs` `file:`):
     Mechanism 3.
   - **Build paths** (`build.context`, `build.additional_contexts` local
     paths): physical path inside the workspace, else refused (req 1). See
     *Residual*.
   - **Dockerfile.** ShipIt reads the Dockerfile (`build.dockerfile`, or the
     context's `Dockerfile` when none is named) as in Mechanism 3, and the
     snapshot gives its content to Compose as `build.dockerfile_inline`. So the
     build never reads the Dockerfile by path, and a Dockerfile changed after
     the check has no effect (req 1; round 5). A project's own
     `dockerfile_inline` stays as it is. A remote context (a Git URL) is left
     as it is. One change: a Dockerfile-specific ignore file
     (`<name>.dockerignore`) no longer applies; the context's `.dockerignore`
     still does, and the build still works.
   - **Other build inputs.** In every mode,
     `build.ssh` and `cache_from`/`cache_to` entries of the `local` type are
     refused: each makes the build read or write a path on the host, and the
     requirement 1 exception does not cover them (req 1, req 2; third review,
     finding 2). A registry cache stays permitted.
   - **Anything left unresolved** — a `$` in a path field, a source Compose did
     not make absolute, a field ShipIt does not recognise in a mount — is
     refused (req 6).
4. **Rewrite.** In the resolved model, every in-workspace bind becomes a subpath
   of the per-session workspace volume, `.` becomes the shared volume at the
   exact session subpath (`workspaceVolumeMount`, planning#619), and `/persist`
   sources are rewritten as today. File references point at their Mechanism 3
   copies. The file that holds a mount of a ShipIt volume also declares that
   volume. Today `generateComposeOverride` declares the per-session workspace
   volume only when one of its *own* entries mounts it, so with the rewrite
   moved here, the resolved file declares it; the override still declares it
   for the mounts it adds itself (second review, finding 2).
5. **Write.** ShipIt writes the result as this start's snapshot in
   `<sessionDir>/state`: a new file for each start, never changed after it is
   written, readable by the session identity, and removed once a later
   snapshot replaces it and no start uses it (second review, finding 6). The
   container never mounts this directory (`SESSION_STATE_SHARED_SUBDIR` is the
   only mounted part), so the agent cannot change the file. ShipIt writes `$`
   so that Compose's second parse gives back exactly the validated values.
6. **Start.** The `up` that ran this validation passes `-f <its snapshot> -f
   <override>`. Later commands for the stack (`down`, `logs`, `ps`) use the
   latest snapshot. No agent-writable file is read between step 3 and `up`
   except the build paths in *Residual* (first review, finding 4).

The service map ShipIt builds (`parseProjectCompose`) comes from the resolved
model too, so what ShipIt shows and what runs cannot differ.

### Where this runs

`withUpInFlight` (`service-manager.ts`) validates synchronously before it takes
the in-flight count, so that a rejected parse never gets a polling exemption.
`config` is a subprocess, so the sequence above becomes an awaited step that
completes **before** the count is taken, and `fn()` receives the snapshot path
it must start from. The reconcile path uses the same sequence.

### What moves out of the override

`rewriteVolumes` moves from `generateComposeOverride` to step 4, and runs on
absolute sources. The override keeps only what ShipIt adds (labels, networks,
user, secrets wiring, the entrypoint bind, overlay dep-dir mounts). Overlay
dep-dir matching (`overlayMountsForService`) reads the rewritten mounts, not the
raw relative sources.

### Failure

A `config` that fails (bad interpolation, a missing `extends` base, an undefined
volume) is a `ComposeValidationError` with Compose's message and nothing starts
(req 6). A refused path names the field, the resolved value, and what to use
instead (req 5).

## Mechanism 3 — physical path, then a copy

For the project file itself, each `env_file`, each top-level
`secrets`/`configs` `file:`, each `label_file` in the project file, each
Dockerfile, and the project's `.env`, ShipIt itself:

1. opens the path the resolved model names, without blocking, and refuses
   anything that is not a regular file;
2. reads the opened file's real location from `/proc/self/fd/<fd>` and refuses
   unless it is inside the session workspace's real path (this also refuses
   every sealed tree);
3. reads the bytes **from that same descriptor** and writes a copy.

The check and the read are on one open file, so no check-then-use window
exists. Compose then reads only the copy.

An `env_file` entry with `required: false` whose file does not exist is left
out of the snapshot, as Compose itself skips it; the current validator permits
this form, so stacks that use it keep working (req 6; round 4). If the file
exists, it gets the same check and copy as any other.

Where the copy goes depends on who reads it. The Compose CLI reads `env_file`
and `.env`, so those copies go in the state dir under the orchestrator's path.
The Docker daemon mounts `secrets`/`configs` files, and in the shipped
volume-backed deployment it sees a different path than the orchestrator. So
those copies go in the per-session secrets directory, and the model names them
by the Docker host's path, as `composeSecretFilePath` (`secret-resolver.ts`)
already does for ShipIt's own secret files (second review, finding 4).

## Residual

Compose reads two kinds of project input by path itself, which ShipIt cannot
hand over as a copy: a **build context directory** (the CLI packs the tree and
sends it to the daemon) and an **`extends` `file:`** target (read while `config`
builds the model). ShipIt checks their physical paths first (the `extends`
chain in Mechanism 2 step 1, before `config`; build paths in step 3, before
`up`), but a directory
changed between that check and Compose's read can still point Compose at a
world-readable path outside the session. The seal (Mechanism 1) blocks every
sealed tree, so this is limited to world-readable files. This window is the
accepted exception in requirement 1 (requirements Q5). Closing it — running
Compose's `config` and build steps in a throwaway container that mounts only
this session's workspace volume and the Docker socket — is a follow-up on
planning#620.

## What each requirement maps to

| Req | Closed by |
|---|---|
| 1 (symlinked references) | Mechanism 1 (sealed trees) + Mechanism 3 (every other path, no window); build context and `extends` `file:`: the accepted exception, *Residual* |
| 2 (interpolation / `extends`, all modes) | Mechanism 2 steps 3–6; raw gate kept |
| 2a (cross-session / shared-volume root, all modes) | Mechanism 1 + Mechanism 2 bind, named-volume, and `volumes_from` rules |
| 3 (non-`./` relative sources) | Mechanism 2 steps 3–4 (rewritten or refused) |
| 4 (bind deployment) | out of scope — follow-up on planning#620 |
| 5 (clear refusals) | `ComposeValidationError` naming field, value, and fix, including a denied read |
| 6 (fail closed; plain stacks keep working) | failed `config`, unresolved identity, or unrecognised mount refuses the start; in-workspace binds and `/persist` are rewritten, not refused |

## Key files (to touch)

- `compose-cli.ts` — one spawn helper with the root-gated uid/gid drop; identity
  on `ComposeCli`; a `config` query; `up` takes the snapshot path.
- `service-manager.ts` — `streamLogs` and `snapshotLogs` use the helper;
  `extends`-chain check, then resolve-validate-rewrite, in `withUpInFlight`
  before the in-flight count and in reconcile; one snapshot per start; service
  map from the resolved model.
- `compose-generator.ts` — split the checks into a syntax set (raw file only)
  and a security set (resolved model only); bind rule with today's socket
  allowance, named-volume, `volumes_from`, and build rules (incl. `build.ssh`
  and `local` cache refusals); Dockerfile as `dockerfile_inline`;
  `label_file` handling before `config`;
  `rewriteVolumes` on absolute sources, with the ShipIt
  volume declarations beside the mounts that use them; override no longer
  rewrites volumes.
- `secret-resolver.ts` — hand the per-session env and secret directories and
  files to the session identity (root-gated); secret/config copies use the
  Docker host's path.
- New: the Mechanism 3 reader (open, confirm through `/proc/self/fd`, copy).
- Docs: `shipit-docs/compose.md` (interpolated sources, symlinked references,
  relative sources), `docs/172-agent-containment/plan.md` (audit),
  `docs/086-shipit-yaml-and-compose/plan.md` (rewrite rules move).

## What cannot be verified here

No Docker in a session container. Unit tests cover the spawn options (uid/gid,
root-gated, both log paths included), the ownership changes, the `extends`
chain check, resolved-model validation over recorded `config` output (a plain
`./sub` stack passes and gets its volume declaration; the ops template's socket
mount passes; `volumes_from: container:…`, `build.ssh`, and `local` cache
entries are refused in Open sessions), the rewrite, the
Mechanism 3 reader (symlink inside and outside the workspace) and its copy
paths, and every fail-closed path.

These need a check on a deployment, listed in the PR test plan:

- The orchestrator image installs `docker-compose-plugin` from Docker's apt
  repository with **no version pin** (`docker/Dockerfile.prod`). The `config`
  flags used (env-file resolution off, `--env-file`, `--project-directory`,
  every profile enabled), `build.dockerfile_inline`, and the output shape
  (whether `config` escapes `$`, whether `x-shipit-*` extensions and
  `profiles:` survive) must be confirmed on the installed version, or the
  version pinned.
- The dropped CLI reaches the socket and reads the handed-over files.
- A plain stack (workspace binds and `/persist` only) starts unchanged.
