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
   `file:`, and `build.context` — MUST NOT read any file of another session, the
   shared workspace volume's root, ShipIt or the orchestrator, or the Docker
   host, even when the named path is a symlink whose target resolves outside
   this session's workspace. *(Reworded 2026-09-28 from "files outside this
   session's own workspace" — see Resolved questions Q10.)* Today these are
   checked as strings only (`validateReadablePath`,
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
   the daemon follows host symlinks anywhere, is refused (requirement 9).
   *(Resolved 2026-09-27 — see Resolved questions Q1, which carried the bind
   deployment as a follow-up; 2026-09-29 — Q16 refuses it.)*

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

   Second exception: in Open sessions, a service that adds a capability outside
   ShipIt's short safe list or sets a security option other than
   `no-new-privileges`, and a build that asks for extra privileges or a network
   other than the default or none, is refused with a message (requirement 5).
   *(Resolved 2026-09-28 — see Resolved questions Q13.)*

   Third exception: a repository that sets `compose.docker-socket: true` no
   longer gets the Docker socket until the user turns it on (requirement 8);
   until then the start is refused with a message that names the setting.
   *(Resolved 2026-09-28 — see Resolved questions Q14.)*

   Fourth exception: a service that uses a Compose field ShipIt has not
   classified is refused with a message that names the field (requirement 5).
   *(Resolved 2026-09-29 — see Resolved questions Q15.)*

7. A session MUST NOT reach another session or the Docker host through its
   Compose setup (the compose file and the `compose` block of `shipit.yaml`),
   even when the agent tries to on purpose. This holds in every session mode,
   Open included, and it is the standard for requirements 1–3. Only this
   session's own secrets (the values its own services receive) are protected
   against accidental reach alone, because the agent can always make one of
   its services show such a value. *(Stated 2026-09-28 — see Resolved
   questions Q11.)*

8. Only the user can give a project's services the Docker socket. A file in the
   repository can ask for it, but cannot turn it on. Ops sessions, which only
   the user creates, keep their read-only Docker access. *(Resolved 2026-09-28
   — see Resolved questions Q14.)*

9. ShipIt MUST NOT run session containers without `WORKSPACE_VOLUME` (the bind
   deployment). In that mode Docker receives host paths inside a session's
   workspace, which the session can redirect, so requirement 7 cannot hold.
   Started that way, ShipIt refuses to start, with a message that names the
   setting. ShipIt's documentation MUST NOT describe such a setup. *(Resolved
   2026-09-29 — see Resolved questions Q16.)*

## Open questions

*(none — Q1–Q16 answered.)*

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

**2026-09-28 — Q10: may a file reference reach the helper container's own
files? → yes; reword requirement 1 to the definition this document already
uses.** Review round 22 (run `3423fa94-5659-49e8-8a8a-35e1cab27a5f`) found that
a workspace symlink resolves inside the throwaway helper container, so it can
reach that container's own files: the helper image's base files, and the
`/etc/hosts`, `/etc/resolv.conf`, and `/etc/hostname` that Docker puts into
every container. None belongs to another session, the shared volume root,
ShipIt, or the Docker host, and no container design can hide Docker's own
`/etc` files. Requirement 1 now names those four instead of "outside this
session's own workspace"; the helper image stays as small as practical. The
alternative was keeping the literal words and adding ShipIt-side checks of
every reference on top of the confinement (the mechanism Q8 removed).

**2026-09-28 — Q11: what does this protection guard against? → cross-session
and host access must be fully prevented; only the session's own secrets are
protected against accidental reach alone.** The requester, correcting a chat
summary that called the whole design protection from accidental reach: "well
for secrets on the repo inside the session. Cross-session/host access should
be fully prevented". Recorded as requirement 7. The plan already used this
split for the service-env files (*ShipIt's own files keep their owner*), and
requirements 1, 2, and 2a have no accidental-only wording. The check of the
code against requirement 7 raised Q12–Q14.

**2026-09-28 — Q12: where do the Open-session fixes for requirement 7 go? →
this work.** The check found host reach in Open sessions that requirements 1–3
do not name: `cap_add` is refused only in contained sessions, `security_opt` is
not checked in any mode, the build checks (`validateBuildSecurity`) run only in
contained sessions, and the Docker socket opt-in is in a file the agent can
write. They are in the Compose setup, so they belong here. The alternative was
a separate issue, with planning#620 kept to file references and mounts.

**2026-09-28 — Q13: what do Open sessions get for added capabilities and
security options? → a short safe list.** A service may add only capabilities
whose effect stays inside its own container, and may set no security option
other than `no-new-privileges`; builds get the contained-session rules (no extra
privileges or entitlements, the default network or none). Stacks that use more
fail with a clear message — recorded as the second exception to requirement 6.
The alternatives were refusing every added capability and option (simplest,
breaks more stacks), and refusing a named list of dangerous values (lets an
unlisted value through).

**2026-09-28 — Q14: `compose.docker-socket: true` gives a service full control
of the host, and `shipit.yaml` is read from the workspace, so the agent can
set it. What do we do? → only the user turns it on.** The key in `shipit.yaml`
still asks for the socket, but ShipIt gives it only when the user has turned on
a per-repository setting that the agent cannot change. Recorded as requirement
8 and the third exception to requirement 6. This replaces the "keep today's
socket allowance, unchanged" part of Q7 for Open sessions; the path must still
match exactly (plan round 24). The alternatives were keeping the opt-in as an
accepted exception to requirement 7, and removing the raw socket (breaks stacks
that use it).

**2026-09-29 — Q15: review rounds 30–34 each found one more service field
that no check covered. How do we stop? → accept only the fields ShipIt has
classified, and stop the review loop.** ShipIt refuses every service field that
is not on its list of classified fields, so a field nobody listed is refused by
default. A stack that uses a safe field not yet on the list stops with a
message that names it, until ShipIt adds the field — recorded as the fourth
exception to requirement 6. The final review runs on the implementation. The
requester, choosing the recommended option: "Ok go ahead and implement, then
review". The alternative was more review rounds without the list.

**2026-09-29 — Q16: in the bind deployment (no `WORKSPACE_VOLUME`), does ShipIt
close the gap or refuse? → refuse the mode, and remove its documentation.** No
shipped deployment runs that way; the one documented setup that did was the
orchestrator run outside Docker, in `CONTRIBUTING.md`. The requester: "let's
remove this documentation, and refuse such a mode". Recorded as requirement 9.
The alternatives were closing the gap with the planning#619 per-session volume
(the workspace path as its device), and refusing only Compose starts in that
mode.

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
- Without `WORKSPACE_VOLUME`, `rewriteResolvedMount` (`compose-generator.ts`)
  keeps a bind of a workspace subdirectory as a host path, and
  `rewriteFragmentVolume` (`plugin-compose.ts`) binds a `repo: self` fragment's
  paths as host paths. The workspace root, `/persist`, the helper containers'
  mounts, and ShipIt's own files are not paths the agent can redirect. Every
  shipped deployment sets `WORKSPACE_VOLUME` (`deployment/vps`,
  `docker/local/prod`, `docker/local/dev`); `RUNTIME_MODE=local` runs no session
  containers and resolves no Compose helper image. Verified 2026-09-29.
