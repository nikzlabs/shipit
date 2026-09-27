---
issue: planning#620
title: Compose — remaining ways a project file reaches paths outside its session
description: Run Compose as the session uid, and validate Compose's fully-resolved model before up, to close the symlink, interpolation, extends, and relative-source escapes.
---

# 318 — Compose remaining file escapes

Implements [requirements.md](requirements.md). Design; nothing here is built yet.
Follows planning#619, which closed the literal `./sub` symlink escape, the direct
shared-volume mount, and `~` sources.

Two mechanisms, one per class of escape:

- **Run the Compose CLI as the session's uid** — closes requirement 1
  (symlinked `env_file` / `build.context` / `secrets`/`configs` `file:` reads).
  The 0700 session seal (docs/270) then denies any read that resolves into
  another session or the orchestrator's own trees, at the kernel, at read time —
  no check-then-use window.
- **Validate Compose's fully-resolved model (`docker compose config`) before
  `up`** — closes requirements 2 (interpolation, `extends`) and 3 (non-`./`
  relative sources) by checking the source paths Compose will actually use, not
  the text in the file.

Requirement 4's bind-deployment case is out of scope (see requirements Q1);
tracked as a follow-up on planning#620.

## Mechanism 1 — run Compose as the session uid

### What runs, and where the read happens

`defaultComposeRunner` / `defaultComposeQuery` (`compose-cli.ts`) spawn
`docker …` with `composeSpawnEnv()` and no uid drop, as the orchestrator's user.
The reads to close all happen on the **client** side of these spawns:

- `env_file` values — read by the Compose CLI while it builds the container env.
- top-level `secrets:` / `configs:` `file:` — in the volume-backed deployment the
  daemon binds the *orchestrator's* path, which usually does not exist on the
  host, so this fails rather than escapes; but the CLI stats them. The bind
  deployment (out of scope) is where the daemon follows a host symlink.
- `build.context`, `build.dockerfile`, `build.additional_contexts` local paths —
  the CLI/buildx tars the context tree and sends it to the daemon; the read of
  the tree is client-side (`doBuildBake` → `--allow fs.read=<path>`).

So dropping the CLI to the session uid seals every one of these against a
symlink that leaves the workspace, because the seal denies the dropped uid
traversal into any other session's 0700 tree or the orchestrator's own dirs.

### Wiring the drop

- Thread the session identity into `ComposeCli`. `identityForSession(sessionId)`
  (`session-worker-uid.ts`) already returns `{uid,gid}` for a session, and
  `compose-persist.ts` already runs `execFileSync({uid,gid})` as that identity —
  same subsystem, established precedent.
- `defaultComposeRunner` / `defaultComposeQuery` add `uid`/`gid` to the `spawn`
  options when an identity is resolved and the orchestrator is root
  (`process.getuid?.() === 0`), matching the git-drop gate
  (`git-tree-uid.ts`). In dev (non-root) the drop is skipped, as git's is.
- **Socket access survives the drop.** docs/270 verified that Node's
  `spawn({uid,gid})` does not call `setgroups`, so the child keeps the parent
  root process's supplementary groups — including whatever group grants the
  bind-mounted Docker socket. No socket-group work is needed; a test asserts the
  spawn options rather than the runtime behaviour (no Docker in a session box).

### The files ShipIt hands to Compose must be readable by the session uid

This is the ripple the mechanism carries, and the part most likely to break a
running stack if missed. Every `-f` file and every file Compose is pointed at by
ShipIt is written `0600`, some deliberately **root-owned and outside the
workspace so the agent cannot read them**:

| File | Writer | Mode | Owner today |
|---|---|---|---|
| compose override (`writeComposeOverride`) | orchestrator | 0600 | root, in the session **state** dir (not mounted into the container) |
| per-service env files (`writeServiceEnvFilesToRoot`) | orchestrator | 0600 | root, under `SHIPIT_SERVICE_ENV_DIR/<sessionId>/` (outside workspace, not mounted) |
| docker-secret files (`writeIsolatedSecretFiles`) | orchestrator | 0600 | root, under the internal secrets dir (not mounted) |
| secrets entrypoint (`stageSecretsEntrypoint`) | orchestrator | 0755 | root — already world-readable, no change |

A Compose CLI dropped to the session uid cannot read the 0600 root-owned files,
so the three 0600 files must be **`lchown`ed to the session identity** after they
are written. **This changes nothing the agent can reach.** These files sit
outside the workspace and are not mounted into the container, so chowning them on
the *host* to the session uid — reachable there only by ShipIt's own Compose
subprocess — does not make them visible on any surface the agent has. It is worth
being precise about what "the agent can't read the service-env files" ever
meant: it is protection against the agent *accidentally* reaching for a
service-only key, **not** a boundary against a rogue agent. A rogue agent can
already exfiltrate any secret its own services legitimately receive — render it
into a page and snapshot it, log it, echo it over an allowed egress path. So the
chown neither strengthens nor weakens the real posture; it only keeps the
existing accidental-reach hygiene intact while letting the dropped CLI read the
file. The `assertServiceEnvRootOutsideWorkspace` guard stays; the chown is the
new step, gated on the same root check as the drop.

Per-session correctness: each of these paths is already per-session
(`<root>/<sessionId>/…`, the per-session state dir), so chowning each to *its*
session's uid is consistent with docs/270 and never cross-owns.

### Commands that are not workspace reads

`down`, `stop`, `ps`, `inspect`, `network rm`/`disconnect`, `rm -f` talk to the
socket and do not read workspace files. Dropping them to the session uid is
harmless (socket access retained) and keeps one code path, so the drop is
applied uniformly to the runner rather than to `up` alone.

## Mechanism 2 — validate the resolved model before `up`

`parseComposeFile` reads the **raw** YAML: it never interpolates, and `extends`
is resolved by Compose, not by ShipIt. So the source strings it validates are
not the paths Compose will mount. `docker compose … config` emits the
fully-interpolated, `extends`-merged, path-normalized model — exactly what `up`
will act on.

### The pass

Before generating the override / running `up`, run
`docker compose -f <userComposeFile> config` (no override; we validate the
user's intent), as the session uid, and validate the resolved model:

- **every service volume `source`** that is a bind (short or long form): its
  resolved, absolute path must be inside this session's workspace, or be a
  reserved ShipIt volume already handled by the rewrite. A resolved `/`,
  `/etc`, another session's path, or the shared-volume device is refused. This
  catches `${X:-/}:/host` (item 3) and `.cache:/x` / non-`./` sources (item 4),
  which `config` normalizes to an absolute path.
- **every `env_file`, `secrets`/`configs` `file:`, and `build` local path** in
  the resolved model: same in-workspace check (defence in depth behind the seal).
- Interpolation and `extends` need no special-casing — they are already resolved
  in the model. The existing contained-mode interpolation refusal and the
  Open-mode `extends`-allowed branch can be **retired in favour of this pass**,
  which covers both modes uniformly (requirement 2). Keep the cheap literal
  string checks in `parseComposeFile` as a first, fast gate.

### Cost and failure mode

`config` is a client-side parse (no daemon round-trip). It runs on the
before-`up` validation path (`parseProjectCompose` / `assertProjectComposeStillValid`).
A `config` that fails (bad interpolation, missing `extends` base) becomes a
`ComposeValidationError` surfaced to the user, not a silent pass — requirement 6.
An escaping resolved path is a refusal naming the path and the fix (requirement 5).

### Why not validate the merged (user+override) model

The override rewrites `./x` to a confined volume subpath and adds ShipIt's own
mounts (secrets entrypoint bind, overlay volumes) whose sources are ShipIt paths
that are *supposed* to be outside the workspace. Validating the user file alone
keeps the check aimed at the user's declared intent and avoids having to
allowlist ShipIt's own injected mounts. The `./x` rewrite already confines those
via Docker's volume-root check (planning#619).

## What each requirement maps to

| Req | Closed by |
|---|---|
| 1 (symlinked references) | Mechanism 1 (seal at read time) |
| 2 (interpolation / `extends`, all modes) | Mechanism 2 (resolved-model validation) |
| 2a (cross-session / shared-volume, all modes) | Mechanism 1 (seal) + existing reserved-name refusal + Mechanism 2 |
| 3 (non-`./` relative sources) | Mechanism 2 (resolved path is absolute; checked in-workspace) |
| 4 (bind deployment) | out of scope — follow-up on planning#620 |
| 5 (clear refusals) | both mechanisms throw `ComposeValidationError` with path + fix |
| 6 (fail closed) | a failed `config` or a failed identity resolve refuses the up |

## Key files (to touch)

- `compose-cli.ts` — thread `{uid,gid}`; add to `spawn` options in
  `defaultComposeRunner` / `defaultComposeQuery`, root-gated. New `config`
  query helper, or reuse `query`.
- `service-manager.ts` / `service-manager-setup.ts` — resolve the session
  identity; run the resolved-model validation in the before-`up` path; chown the
  override after `writeComposeOverride`.
- `secret-resolver.ts` — chown the service-env and docker-secret files to the
  session identity (root-gated), beside the existing 0600 writes.
- `compose-generator.ts` — retire the contained-only interpolation refusal and
  the Open-mode `extends` gate once Mechanism 2 covers them; keep the literal
  fast checks.
- Docs: `shipit-docs/compose.md` (what a symlinked reference and an interpolated
  source now do), `docs/172-agent-containment/plan.md` (audit update),
  `docs/086-shipit-yaml-and-compose/plan.md` if the rewrite rules move.

## What cannot be verified here

No Docker in a session container. Tests assert the spawn options (uid/gid
present, root-gated), the chown calls and their identity, the resolved-model
validation over crafted `config` output (interpolation → `/`, `extends` → host
mount, `.cache` → absolute), and the fail-closed paths. Behaviour against a real
daemon — that the dropped CLI reads the chowned files, that the seal denies a
symlinked `env_file`, and that `config` resolves as expected on the pinned
compose version — is a manual check on a deployment, listed in the PR test plan.

## Open questions

*(none — see requirements.md; all resolved 2026-09-27.)*
