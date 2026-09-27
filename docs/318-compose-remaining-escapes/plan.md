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

## Mechanism 1 — run Compose as the session uid

### One spawn path

Compose is spawned from three places today: `defaultComposeRunner` and
`defaultComposeQuery` (`compose-cli.ts`), and the log follower in
`ServiceManager.streamLogs` (`service-manager.ts`), which calls `spawn("docker",
…)` itself. All three move to one helper in `compose-cli.ts` that adds
`uid`/`gid` to the spawn options. So no Compose command reads a file as the
orchestrator's user.

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
| copies of project file references (new, Mechanism 3) | orchestrator | — | written into the state dir, readable by the session identity |
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

1. **Raw gate (unchanged).** `parseComposeFile` runs on the project file as
   today, including the contained-session interpolation refusal, the contained
   `extends` refusal, the `include:` refusal, and every literal check. These
   stay as the first gate with the clearest messages (finding 5).
2. **Resolve.** Run `docker compose -p <project> -f <project file> config` as
   the session uid (Mechanism 1), with Compose's env-file resolution turned off,
   so Compose does not read `env_file` contents here (Mechanism 3 reads them).
   The project's `.env` is passed as a Mechanism 3 copy through `--env-file`
   (an empty copy when there is none), so the interpolation input is also a
   checked file.
3. **Validate the resolved model.** Every check in `parseComposeFile`
   (`validateServiceSecurity`, `validateBuildSecurity`, top-level volumes,
   networks, secrets, configs) runs again on the resolved model, so an
   interpolated or `extends`-inherited `privileged`, `network_mode`, `cap_add`,
   and so on is refused in every mode (req 2, finding 5). The checks accept only
   the normalization Compose itself adds (the project-default `name:` on a
   volume or network, the implicit `default` network), and nothing else. Then
   the path rules:
   - **Bind sources.** The resolved source is absolute. Inside this session's
     workspace → rewritten (step 4). Outside it → refused (req 2, req 3). This
     covers `./data`, `data`, `.cache`, and `{type: bind, source: data}` alike,
     because Compose has already made them absolute (finding 1).
   - **Named-volume sources.** A service's volume source must name a volume
     declared in the resolved top-level `volumes:`, and must not be a name
     reserved for ShipIt's own mounts. The top-level checks (no reserved name,
     no `driver_opts`, no `external`, no other `name:`) apply to the resolved
     declarations (req 2a, finding 2).
   - **File references** (`env_file`, top-level `secrets`/`configs` `file:`):
     Mechanism 3.
   - **Build paths** (`build.context`, `build.dockerfile`,
     `build.additional_contexts` local paths): physical path inside the
     workspace, else refused (req 1). See *Residual*.
   - **Anything left unresolved** — a `$` in a path field, a source Compose did
     not make absolute, a field ShipIt does not recognise in a mount — is
     refused (req 6).
4. **Rewrite.** In the resolved model, every in-workspace bind becomes a subpath
   of the per-session workspace volume, `.` becomes the shared volume at the
   exact session subpath (`workspaceVolumeMount`, planning#619), and `/persist`
   sources are rewritten as today. File references point at their Mechanism 3
   copies.
5. **Write.** ShipIt writes the result to a new file in `<sessionDir>/state`,
   named by its content, readable by the session identity. The container never
   mounts this directory (`SESSION_STATE_SHARED_SUBDIR` is the only mounted
   part), so the agent cannot change the file. ShipIt writes `$` so that
   Compose's second parse gives back exactly the validated values.
6. **Start.** The `up` that ran this validation passes `-f <that file> -f
   <override>`. Later commands for the stack (`down`, `logs`, `ps`) use the
   latest resolved file. No agent-writable file is read between step 3 and `up`
   except the build paths in *Residual* (finding 4).

The service map ShipIt builds (`parseProjectCompose`) comes from the resolved
model too, so what ShipIt shows and what runs cannot differ.

### Where this runs

`withUpInFlight` (`service-manager.ts`) validates synchronously before it takes
the in-flight count, so that a rejected parse never gets a polling exemption.
`config` is a subprocess, so the sequence above becomes an awaited step that
completes **before** the count is taken, and `fn()` receives the resolved-file
path it must start from. The reconcile path uses the same sequence.

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

For each `env_file`, each top-level `secrets`/`configs` `file:`, and the
project's `.env`, ShipIt itself:

1. opens the path the resolved model names, without blocking, and refuses
   anything that is not a regular file;
2. reads the opened file's real location from `/proc/self/fd/<fd>` and refuses
   unless it is inside the session workspace's real path (this also refuses
   every sealed tree);
3. reads the bytes **from that same descriptor** and writes a copy into the state
   dir.

The check and the read are on one open file, so no check-then-use window
exists. Compose then reads only the copy.

## Residual

Compose reads two kinds of project input by path itself, which ShipIt cannot
hand over as a copy: a **build context directory** (the CLI packs the tree and
sends it to the daemon) and an **`extends` `file:`** target (read while `config`
builds the model). ShipIt checks their physical paths first, but a directory
changed between that check and Compose's read can still point Compose at a
world-readable path outside the session. The seal (Mechanism 1) blocks every
sealed tree, so this is limited to world-readable files. Whether that is
acceptable is an open question in [requirements.md](requirements.md).

## What each requirement maps to

| Req | Closed by |
|---|---|
| 1 (symlinked references) | Mechanism 1 (sealed trees) + Mechanism 3 (every other path, no window); build context: *Residual* |
| 2 (interpolation / `extends`, all modes) | Mechanism 2 steps 3–6; raw gate kept |
| 2a (cross-session / shared-volume root, all modes) | Mechanism 1 + Mechanism 2 bind and named-volume rules |
| 3 (non-`./` relative sources) | Mechanism 2 steps 3–4 (rewritten or refused) |
| 4 (bind deployment) | out of scope — follow-up on planning#620 |
| 5 (clear refusals) | `ComposeValidationError` naming field, value, and fix, including a denied read |
| 6 (fail closed; plain stacks keep working) | failed `config`, unresolved identity, or unrecognised mount refuses the start; in-workspace binds and `/persist` are rewritten, not refused |

## Key files (to touch)

- `compose-cli.ts` — one spawn helper with the root-gated uid/gid drop; identity
  on `ComposeCli`; a `config` query; `up` takes the resolved-file path.
- `service-manager.ts` — `streamLogs` uses the helper; resolve-validate-rewrite
  in `withUpInFlight` before the in-flight count and in reconcile; service map
  from the resolved model.
- `compose-generator.ts` — security checks callable on the resolved model;
  bind / named-volume / build-path rules; `rewriteVolumes` on absolute sources;
  override no longer rewrites volumes. Raw guards unchanged.
- `secret-resolver.ts` — hand the per-session env and secret directories and
  files to the session identity (root-gated).
- New: the Mechanism 3 reader (open, confirm through `/proc/self/fd`, copy).
- Docs: `shipit-docs/compose.md` (interpolated sources, symlinked references,
  relative sources), `docs/172-agent-containment/plan.md` (audit),
  `docs/086-shipit-yaml-and-compose/plan.md` (rewrite rules move).

## What cannot be verified here

No Docker in a session container. Unit tests cover the spawn options (uid/gid,
root-gated, the log follower included), the ownership changes, resolved-model
validation over recorded `config` output, the rewrite, the Mechanism 3 reader
(symlink inside and outside the workspace), and every fail-closed path.

These need a check on a deployment, listed in the PR test plan:

- The orchestrator image installs `docker-compose-plugin` from Docker's apt
  repository with **no version pin** (`docker/Dockerfile.prod`). The `config`
  flags used (env-file resolution off, `--env-file`) and the output shape
  (whether `config` escapes `$`, whether `x-shipit-*` extensions survive) must
  be confirmed on the installed version, or the version pinned.
- The dropped CLI reaches the socket and reads the handed-over files.
- A plain stack (workspace binds and `/persist` only) starts unchanged.
