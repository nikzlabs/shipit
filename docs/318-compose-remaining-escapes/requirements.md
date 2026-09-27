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

2. A compose file MUST NOT mount or read another session's files, the shared
   workspace volume's root, the orchestrator's own files, or an arbitrary host
   path, when the escaping source is produced by `${VAR}` interpolation or by
   `extends`, not only when it is written literally. The literal forms are
   already refused in both session modes; interpolation is refused in contained
   sessions only, and `extends` is allowed in Open sessions.

   2a. Cross-session reach and reach into the shared workspace volume root MUST
   be prevented in **every** session mode, Open included. This is not new to this
   work: it is docs/270 requirement 1 (one session's operation must not read or
   write another session's workspace), and the shared-volume root holds every
   session. *(The posture toward arbitrary **host** paths in an Open session is
   an open question — see below.)*

3. A volume source written as a relative path that does not start with `./`
   (for example `.cache:/x`, or long-form `{type: bind, source: data}`) MUST
   resolve to a location inside this session's own workspace, or be refused with
   a clear message. It MUST NOT reach the orchestrator's path for that string,
   create a stray root-owned directory on the Docker host, or mount an unrelated
   host path.

4. Requirements 1–3 MUST hold in every deployment ShipIt ships, including a
   deployment that sets no `WORKSPACE_VOLUME` (the bind deployment), where ShipIt
   does not rewrite `./sub` and the daemon follows host symlinks anywhere. No
   shipped compose file uses that mode today; the requirement is that the
   guarantee not depend on the volume-backed mode being in use.

5. When ShipIt refuses a reference under 1–4, the message MUST name what was
   refused and what to use instead, in the style of the existing compose
   refusals.

6. Where ShipIt cannot resolve a reference safely, it MUST fail closed — refuse
   to start the stack, or the affected service — rather than start it with the
   escaping read or mount, and MUST say why. A stack that mounts only its own
   workspace and `/persist`, with no escaping reference, MUST keep working
   unchanged.

## Open questions

- **Scope / priority.** Item 2 (bind deployment) is reachable by no shipped
  deployment, and item 4 (non-`./` relative sources) is a correctness problem
  more than an escape in the volume-backed deployment. Are all four in scope for
  this work, or should it close the live escapes (1 and 3) and record 2 and 4 as
  tracked follow-ups? *Recommendation:* close 1, 3, and 4; carry 2 as a follow-up
  (it is a one-device change on the planning#619 volume, but it protects a mode
  nothing ships).

- **Open-session posture toward arbitrary host paths (requirement 2).** In an
  Open (uncontained) session, a source such as `${X:-/}:/host` reaches any
  absolute host path today, and `extends` can pull an unvalidated definition.
  Cross-session and shared-volume reach are closed regardless (2a). Should ShipIt
  also stop an Open session's compose file from mounting arbitrary *host* paths —
  or is host-path access an accepted property of an Open session, as `extends` is
  today (docs/172)? *Recommendation:* to be decided by the requester; the two
  shapes that close it are (a) refuse interpolation and `extends` in security-
  sensitive fields in Open sessions too, and (b) validate Compose's fully
  resolved model (`docker compose config`) before `up`, which closes
  interpolation, `extends`, and relative-path indirection together.

- **Mechanism for requirement 1** *(design-level; recorded here because it
  carries a real tradeoff).* Run the Compose CLI as the session's uid, so the
  0700 session seal (docs/270) denies the escaping read at the kernel — TOCTOU-
  free, and socket access survives the drop because `spawn({uid,gid})` keeps the
  parent's supplementary groups (docs/270). Or resolve each referenced file with
  `O_NOFOLLOW`/`openat2` confinement before Compose reads it — surgical, but a
  check-then-use has a TOCTOU window a workspace writer can hit. *Recommendation:*
  run as the session uid; it is what the seal was built for and it has no race,
  and the same subsystem already runs `execFileSync({uid,gid})` for `/persist`
  directory creation (`compose-persist.ts`).

## Resolved questions

*(none yet)*

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
