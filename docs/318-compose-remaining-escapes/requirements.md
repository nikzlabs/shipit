---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Close the file-read and mount escapes planning#619 assessed but did not fix — symlinked references, interpolation, non-`./` relative sources, and the bind deployment.
---

# Compose — remaining ways a project file reaches paths outside its session

Follow-up to planning#619 (which closed the `./sub` symlink escape, direct
mounts of the shared `shipit-workspace` volume, and `~` bind sources). The cases
below were assessed by reading the code, not fixed, and none was verified
against a live daemon. Each was re-verified against the current code on
2026-09-27 and still holds — see *What is already true*.

A project's compose file, and the workspace it names, are both agent-writable.
"Outside its session" means: another session's workspace or scratch, the shared
`shipit-workspace` volume root (which holds every session and `.shipit.db`), the
orchestrator's own files (for example `service-env/`), and arbitrary Docker-host
paths.

## Requirements

1. A compose file's file *references* — `env_file`, top-level `secrets:`/`configs:`
   `file:`, and `build.context` — MUST NOT read files outside this session's own
   workspace, even when the named path is a symlink whose target resolves outside
   it. Today these are checked as strings only (`validateReadablePath`,
   `validateBuildSecurity`), and the Compose CLI reads them as the orchestrator's
   user, following workspace symlinks.

   This holds with no exception. *(The short-window exception accepted in Q5
   was withdrawn the same day — see Resolved questions Q8.)*

2. A compose file MUST NOT mount or read another session's files, the shared
   workspace volume's root, the orchestrator's own files, or an arbitrary host
   path, when the escaping source is produced by `${VAR}` interpolation or by
   `extends`, not only when it is written literally. This holds in **every**
   session mode, Open included: an Open session's compose file must not mount an
   arbitrary Docker-host path through interpolation or `extends` any more than a
   contained one may. Today the literal forms are refused in both modes;
   interpolation is refused in contained sessions only, and `extends` is allowed
   in Open sessions. *(Resolved 2026-09-27 — see Resolved questions Q2.)*

   2a. Cross-session reach and reach into the shared workspace volume root MUST
   be prevented in **every** session mode, Open included. This is not new to this
   work: it is docs/270 requirement 1 (one session's operation must not read or
   write another session's workspace), and the shared-volume root holds every
   session.

3. A volume source written as a relative path that does not start with `./`
   (for example `.cache:/x`, or long-form `{type: bind, source: data}`) MUST
   resolve to a location inside this session's own workspace, or be refused with
   a clear message. It MUST NOT reach the orchestrator's path for that string,
   create a stray root-owned directory on the Docker host, or mount an unrelated
   host path.

4. Requirements 1–3 MUST hold in every deployment ShipIt ships. The bind
   deployment (no `WORKSPACE_VOLUME`), where ShipIt does not rewrite `./sub` and
   the daemon follows host symlinks anywhere, is reachable by no shipped compose
   file and is carried as a tracked follow-up rather than closed here.
   *(Resolved 2026-09-27 — see Resolved questions Q1.)*

5. When ShipIt refuses a reference under 1–4, the message MUST name what was
   refused and what to use instead, in the style of the existing compose
   refusals.

6. Where ShipIt cannot resolve a reference safely, it MUST fail closed — refuse
   to start the stack, or the affected service — rather than start it with the
   escaping read or mount, and MUST say why. A stack that mounts only its own
   workspace and `/persist`, with no escaping reference, MUST keep working
   unchanged.

   One exception: a build no longer gets the Docker registry login of the
   orchestrator, so a build whose base image needs that login fails, with a
   message that says why (requirement 5). Service images that `up` pulls keep
   that login. *(Resolved 2026-09-28 — see Resolved questions Q9.)*

## Open questions

*(none — Q1–Q9 answered. Implementation is unblocked once the design review
is clean.)*

## Resolved questions

**2026-09-27 — Q1: which of the four escapes does this work close? → close 1, 3,
and 4; carry 2 as a tracked follow-up.** Item 2 (bind deployment, no
`WORKSPACE_VOLUME`) is reachable by no shipped deployment; it is a one-device
change on the planning#619 volume but protects a mode nothing ships. Recorded in
requirement 4. The alternatives were closing all four now, and closing only the
live escapes 1 and 3 (leaving the item-4 correctness bug open too).

**2026-09-27 — Q2: in an Open session, is arbitrary Docker-host-path access an
accepted property, or must it be blocked? → block it, by validating Compose's
fully resolved model (`docker compose config`) before `up`.** This closes
`${VAR}` interpolation, `extends`, and relative-path indirection together, in
both modes, by validating what Compose will actually run rather than the source
text. Recorded in requirement 2. The alternatives were (b) refusing
interpolation and `extends` in security-sensitive fields in Open sessions (does
not cover every indirection, and breaks legitimate `${VAR}` sources), and (c)
accepting host-path access as an Open-session property, as `extends` is today.

**2026-09-27 — Q3: mechanism for requirement 1 (symlinked file reads)? → run the
Compose CLI as the session's own uid.** The 0700 session seal (docs/270) then
denies the escaping read at the kernel, with no check-then-use window. Socket
access survives the drop because `spawn({uid,gid})` keeps the parent process's
supplementary groups (docs/270), and the same subsystem already runs
`execFileSync({uid,gid})` for `/persist` directory creation (`compose-persist.ts`).
The alternative was resolving each referenced file with `O_NOFOLLOW`/`openat2`
before Compose reads it, rejected for its TOCTOU window. This is a design-level
choice recorded here because it carries a real tradeoff (a new identity for the
Compose subprocess); the observable behaviour is the same either way.

**2026-09-27 — Q4: after the independent review of the plan, which findings
apply, and does the design change shape? → all six findings apply; resolve the
model once.** ShipIt writes Compose's resolved model into its state directory,
validates that file (all existing security checks, bind and named-volume
sources, the physical path of every file reference), rewrites its mounts, and
starts `up` from exactly that file. The existing raw-text guards stay. No
numbered requirement changed; this is a design choice recorded because the
requester made it.

**2026-09-28 — Q5: may a short window remain for the two inputs Compose reads
by path itself (a build context directory, an `extends` `file:` target)? → yes,
accept it now; track full confinement as a follow-up on planning#620.** ShipIt
checks their physical paths first, and the session-uid seal keeps other
sessions and ShipIt's private files out of reach, so the window reaches only
files every user on the host can read. Recorded as the exception in
requirement 1. The alternative was closing it in this work by running
Compose's `config` and build steps in a throwaway container that mounts only
this session's workspace volume and the Docker socket — a new mechanism and a
larger change.

**2026-09-28 — Q6: after the second independent review of the plan, which
findings apply? → all of them.** Check the `extends` chain before `config`
reads it; declare ShipIt's volumes beside the rewritten mounts; keep raw syntax
checks and resolved-model security checks as separate sets; give secret and
config copies the Docker host's path; route the fourth Compose spawn
(`snapshotLogs`) through the uid helper; write one snapshot per start rather
than a content-named file. No numbered requirement changed; this is a design
choice recorded because the requester made it.

**2026-09-28 — Q7: after the third, fresh review, which findings apply? → all
of them.** Refuse the `container:` form of `volumes_from` in every mode (only
services of this project); refuse `build.ssh` and `local` `cache_from`/
`cache_to` in every mode; keep today's Docker socket allowance, unchanged, in
the resolved-model bind rule; run the security checks once, on the resolved
model only. No numbered requirement changed. The requester also asked that
future reviews' reasonable findings be applied without asking.

**2026-09-28 — Q8: review round 6 (run
`95167b07-e363-4746-8ab3-5629a99b8153`) showed that the Q5 window was not
bounded as assumed, and that earlier fixes broke working stacks. How do we go
on? → run Compose in a confined container.** The Q5 window could reach ShipIt's
database (`/workspace/.shipit.db`, on the shared volume root, opened with no
file-mode restriction), and refusing an interpolated `extends.file`, a
`label_file` in an extended file, or a Dockerfile-specific `.dockerignore`
broke stacks that work today (requirement 6). ShipIt now runs every Compose
command that reads project files (`config`, `up`, `build`) in a throwaway
container that sees only this session's workspace, ShipIt's own files for this
stack, and the Docker socket, so the kernel confines every file Compose reads.
This **replaces** the Q3 mechanism (session uid on the orchestrator) and
**withdraws** the Q5 exception from requirement 1. The file copies, the
Dockerfile inlining, and the special `extends` / `label_file` / `.env` handling
of Q4–Q7 are dropped; the resolved-model validation of mounts and security
settings stays. The alternatives were (b) keeping the design, making ShipIt's
private files unreadable to session users, and recording the stack breaks as
exceptions to requirement 6, and (c) adding more special handling.

**2026-09-28 — Q9: may a build lose the orchestrator's registry login? → yes;
builds do not get it.** Review round 11 (run
`f390d1c3-db8d-4a42-aaa6-08a6e147440e`) found that a confined `build` reads
project paths, so giving it the orchestrator's Docker client configuration
would let a project copy those registry credentials into an image
(requirement 1). ShipIt does not manage registry logins, and the shipped VPS
deployment mounts no Docker client configuration into the orchestrator, so
this affects only an operator who logged in inside the orchestrator container
by hand. Recorded as the exception in requirement 6; `up`, which reads no
project path, keeps the login for service images. The alternatives were
(b) giving builds the login, as an exception to requirement 1, and (c)
pulling base images before the build in a container that reads no project
path. A real private-registry feature (for example a per-repository registry
credential) is separate work.

## What is already true (verified in this repository, 2026-09-27)

- `validateReadablePath` (`compose-generator.ts`) checks the declared string for
  `${`, a leading `/`, and `..` only; its own comment states a workspace symlink
  escapes it. `env_file` (`validateServiceEnvFile`) and top-level `secrets`/
  `configs` `file:` (`validateTopLevelFileRefs`) both go through it.
- `validateBuildSecurity` restricts `build.network`, `build.privileged`, and
  `build.entitlements` only; it does not check `build.context`. Its docstring
  says it does not restrict filesystem access through contexts.
- `defaultComposeRunner` (`compose-cli.ts`) spawns `docker compose` with no uid
  drop, so file references are read as the orchestrator's user.
- The interpolation refusal in `validateServiceSecurity` is gated on
  `containEgress`, so it does not run in Open sessions; `extends` is refused in
  contained sessions only. The absolute-path, reserved-name, and `~` refusals are
  not gated and run in both modes — but they see the literal string, so an
  interpolated `${X:-/}` passes them.
- `rewriteVolumes` returns the entry unchanged when `!opts.workspaceVolume` (the
  bind deployment) and when the source is a relative path not matched by
  `isRelativeWorkspacePath` (only `.` and `./…`).
- Cross-session isolation is an established hard invariant: docs/270 requirement
  1, realized by per-session uids and the 0700 session seal.
- Compose `include:` is refused in every mode (`parseComposeFile`), so an
  included file is not a read path.
- ShipIt's database is `/workspace/.shipit.db` on the shared volume root,
  opened with no file-mode restriction (`DatabaseManager`,
  `shared/database.ts`). Verified 2026-09-28.
- ShipIt polls each session's stack with `docker compose ps` every 5 seconds
  (`ServicePoller`, `service-poller.ts`). Verified 2026-09-28.
