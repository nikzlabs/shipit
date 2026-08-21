---
issue: planning#420
title: Compose services must be able to write the workspace
description: Restores the "services share the agent's user" contract that per-session UIDs and the contained `user:` rule broke together.
---

# Compose workspace writability

Implements [requirements.md](./requirements.md) — one requirement: services and
agents must both work.

## 1. What was broken

Three rules, each correct alone, met and made the workspace unusable to every
Compose service in every repository.

**Per-session UIDs (docs/270).** Each session now runs as its own UID; the GID
stays shared. The workspace is chowned `sessionUid:sharedGid` — and its **mode
was never touched**. A root orchestrator materializes a checkout under umask 022,
so the tree stays `0644`/`0755`. Only the session UID could write it.

**A service can never hold that UID.** ShipIt fills in the session identity only
for a service that declares no `user:` (`compose-generator.ts`), and a project may
not declare a UID in the session range — req 4a refuses it. So a declared user is
always a non-owner.

**Containment made declaring mandatory (docs/263).** A contained service had to
declare a numeric non-root `user:`, and the refusal fails the *whole* file.
Containment is the default (`session-container.ts`, `isEgressContained` → `?? true`).

The result, per requirement 1, was two ways to have broken services:

| Project shape | Outcome |
|---|---|
| No `user:` (the documented advice) | whole compose file **refused** — no services at all |
| Declares `user:` to satisfy the refusal | services start and **cannot write** the workspace |

`compose.md` documented both halves of the trap in one page — "Services share the
agent's user … Avoid setting `user:`" beside "Each service must declare a numeric,
non-root `user:`" — while the UID it told services to share was the one it
forbade them to name. github#2374 is a user hitting exactly this: three Vite dev
servers died together on the config-bundle temp file they could not create.

## 2. The fix

Two halves. The first stops a wrong `user:` being demanded; the second keeps a
deliberate one working.

### A. Stop requiring a declaration that cannot be right

`validateServiceSecurity` (`compose-generator.ts`) accepts an absent `user:` in a
contained session **when ShipIt's fill-in will supply the identity** — i.e. when a
worker UID exists. What containment needs is a numeric, non-root, non-reserved
runtime UID; an allocated session identity is all three by construction, so the
fill-in satisfies the rule *better* than a declaration, which merely asserts it.

Nothing else relaxes. A declared root user, a declared 911/912, and a declared
UID inside the session range are all still refused, and a deployment with no
worker UID still requires the declaration — there the image default would apply,
and it is often root.

### B. Make the group channel actually carry writes

The group is the only channel a non-owner service has, and it was already shared —
every session runs with the same GID. What was missing was the write bit.

- **`chownWorktreeRecursive`** (`session-worker-uid.ts`) now adds `g+rwX`, plus
  setgid on directories, to every node it chowns. It runs from
  `handWorkspaceBackToWorker`, i.e. on clone, checkout, reset, rebase and
  fork-merge — every path that materializes worktree files as root.
- **`chown_workspace`** (`docker/session-worker/entrypoint.sh`) does the same at
  boot, in two extra passes with the same prunes, so the container-side handoff
  and the orchestrator-side one agree.
- **`group_add: [<sharedGid>]`** is added to the generated override for a service
  that declares its own `user:`. An image with a baked-in account (`1300:1301`)
  is otherwise outside the session's group entirely, and no amount of group-write
  on the tree would reach it. The declared UID is untouched — req 4 stands.

**This costs no isolation, and it is not a new judgement.** The session directory
is `0700` (`sealSessionDir`), which is the whole cross-session boundary: a
group-writable file inside a session is unreachable to every UID outside it. The
entrypoint's `umask 002` already rests on exactly that reasoning for files created
after boot. This applies the same rule to the ones root created before it.

Two things are deliberately **not** re-moded, for the same reason they are not
re-chowned: regular files under `.git/objects` and `.git/lfs/objects` (hardlinked
into the shared bare cache and every sibling clone — a mode belongs to the inode),
and `.pnpm-store` (shared per runtime, and group-shared by the orchestrator).
Object *directories* are moded, so the worker can still add an object.

## 3. Known residual

**What a foreign-UID service creates is still not agent-writable.** With
`group_add` the service can write the tree, but its own umask is 022, so what it
creates lands `0644`/`0755` owned by that UID. The setgid bit fixes group
*ownership*, not group *write*. So the agent can read a file the service wrote and
not modify it — **and can traverse a directory the service created but not add to
or delete from it**, which is the sharper half: `rm -rf build` or `./gradlew clean`
EACCESes as the agent.

This is pre-existing — true of any declared `user:` since docs/150 — and it does
not arise for a service that declares nothing, which after this change is every
service whose image tolerates it. It does still arise for the declared-user shape
this change sets out to keep working. Requirement 1 as written does not carve it
out; it is named here rather than rounded off.

*This paragraph ended "including the three services this repo itself ships that
way (see §4)" until 2026-08-19. Since docs/272 that is one, not three —
`emulator`, whose baked-in `1300:1301` writes no workspace, so the residual is
real but unreachable here. The residual itself is unchanged for any project that
does declare a workspace-writing `user:`; only this repo's exposure to it went
away.*

The durable fix is a group-writable umask inside the service, which means
wrapping a command ShipIt does not own, or default POSIX ACLs on the workspace,
which need `acl` support on every backing filesystem including the overlay. Both
are larger than this fix and neither is attempted here.

## 4. Deploy ordering

This repo's own `docker-compose.yml` **kept** its `user: "1000:1000"` lines
through this change. They worked again because of half B, and deleting them
before half A was deployed would have broken dogfooding on every session running
an older orchestrator — which still refused an undeclared contained service, and
refused the whole file with it. So the ordering constraint was real, and it was a
constraint on *when*, not on *whether*.

**That follow-up is done** —
[docs/272-services-run-as-session-uid](../272-services-run-as-session-uid/plan.md)
(`fec4444e`, 2026-08-17) dropped the lines from `dev`, `onboarding`, `sdk-test`
and `android`, after first confirming the deployed orchestrator accepts a
contained service with no `user:`. Those services now get the session identity
and own their own output, which also retires §3's residual *for this repo*:
nothing here declares a foreign uid any more. `emulator` keeps `1300:1301` on
purpose — a baked-in image account that writes no workspace, reaching the tree
through half B's `group_add`.

*This section read "**keeps** its `user: "1000:1000"` lines for now" until
2026-08-19. Corrected rather than deleted, because the deploy-ordering
constraint it records is the reasoning someone will need if this sequence ever
has to be re-run — and because a plan asserting a superseded state as current is
the same drift §4b is about.*

## 4b. The rule outlived its deletion in six places (2026-08-18)

Re-verifying github#2374 found the code fix intact and working — a live session's
workspace is `2775`/`664` at `sessionUid:1000` — but half A's *deleted* rule still
stated as current fact in six places, four of them load-bearing:

- **`shipit-docs/plugins.md`** — the sharpest one. It told the agent that a
  contained session refuses a service with no `user:` and to "add one". Adding one
  is what §1 describes as the second way to have broken services, so this page
  actively reproduced the bug for plugin fragments.
- **`shipit-docs/compose.md`**'s empty-list troubleshooting quoted the deleted
  refusal as the one a reader would "most often" hit — contradicting, three
  hundred lines later, the same file's "delete that line" advice.
- **`session-worker-uid.ts`**'s `RESERVED_EGRESS_UIDS` docstring concluded "the
  worker-uid fallback reaches only Open services, where there is no tier to
  escape" *from* the deleted rule. The conclusion is still true, but it now rests
  on `sessionWorkerUid()` throwing for 911/912 rather than on a validation rule
  that no longer exists — so the safety argument needed restating, not deleting.
- **`plugin-compose.ts`**'s `toComposeService` justified reading the declared user
  back with "which a contained session requires it to declare".
- `docs/262-plugins/plan.md` and `docs/150-non-root-session-worker/plan.md`
  repeated the premise.
- `docs/266-orchestrator-git-trust-boundary/requirements.md` carried it as a
  "verified at `compose-generator.ts`" claim under requirement 12 — found by the
  independent reviewer, not by the sweep that found the other five. Requirement 12
  itself is untouched (it is the requester's, and docs/271 only strengthened it);
  what was corrected is the agent-written justification below it.

This is the drift `CLAUDE.md` names: a comment asserting an inherited guarantee
is a claim, not a contract. Each was corrected in place, with the superseded text
quoted, because the reasoning that rested on it is worth keeping.

The seam that let it persist was a **missing test**: `plugin-compose.test.ts`
covered a declared-root refusal under containment and an undeclared fragment in an
*open* session, but never an undeclared fragment in a *contained* one — the exact
case half A changed. Both halves now exist: acceptance when a worker uid is
available (asserted as acceptance, since the failure mode is a refusal that takes
the whole compose file and every one of the project's own services with it), and
the surviving refusal when there is none.

Both set `SHIPIT_SESSION_WORKER_UID` explicitly, and that is the point rather than
housekeeping. The first version of the acceptance test only *read* the ambient
variable — which a session container sets and CI does not — so it passed locally,
failed in CI, and demonstrated nothing in either place. A test for behaviour that
is gated on an environment variable has to own that variable, or the environment
decides what the test means.

## 5. Key files

- `src/server/orchestrator/session-worker-uid.ts` — `addGroupWrite`, called from
  the worktree handoff and from the cross-session group share.
- `src/server/orchestrator/compose-generator.ts` — the relaxed contained-`user:`
  rule and the `group_add` injection.
- `docker/session-worker/entrypoint.sh` — `chown_workspace`'s mode passes.
- `src/server/shipit-docs/compose.md` — the agent-facing contract, no longer
  self-contradictory.
