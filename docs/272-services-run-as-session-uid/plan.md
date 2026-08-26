---
issue: planning#427
title: Compose services run as the session identity
description: Drops the declared `user:` from this repo's services and closes the dependency-directory gap docs/271 left behind.
---

# Services run as the session identity

Implements [requirements.md](./requirements.md). Follows
[docs/271](../271-compose-workspace-writability/plan.md), which made the workspace
group-writable so a foreign-uid service could write it, and deferred the rest.

## 1. What docs/271 could not fix

Group-write answers "may this process write here". It does not answer "does this
process own this", and two things ask the second question.

**git asks it.** `safe.directory` compares the repository's owner UID with the
process UID and refuses on a mismatch, *regardless of mode* — the check exists
precisely for a repo you can write and do not own. So the dogfood inner
orchestrator, running as the declared `user: "1000:1000"` against a state dir
owned by 2000006 mode 2775, failed on every repository it manages. A
`safe.directory` exception would have silenced a real mismatch rather than fixed
it.

**The dependency directories were never reached.** docs/271 group-writes the
worktree through `chownWorktreeRecursive`, and that walk deliberately **excludes**
the declared dep dirs (`chownWorktreeToSessionWorker`'s `excludeRelDirs`) to stay
bounded by the source tree instead of the dependency count. So `node_modules` —
the one directory every dev server writes its cache into — kept whatever mode its
writer left. A service that is not its owner then fails exactly where it was
reported: `mkdir '…/node_modules/.vite/deps_temp_…'`.

## 2. The fix

**A. Stop declaring a `user:` where nothing needs one.** docs/271 kept
`user: "1000:1000"` on this repo's `dev`, `onboarding`, `sdk-test` and `android`
services for one reason: an orchestrator predating that fix refused a contained
service with no `user:`, and refused the whole file with it. That fix is now
deployed — verified by removing the lines and watching `shipit service list`
accept the file where it previously named the rule. With no declaration ShipIt
fills in the session identity, the service owns what it writes, and git is
satisfied. `emulator` keeps its `user: "1300:1301"`: that image has a baked-in
account and writes nothing to the workspace.

**B. Group-write the dependency directories, in the pass that already exists for
them.** `reconcileDepDirCacheOwnership` runs at container create/resume
(`selfHealWorkspaceOwnership`) and repairs cache trees inside a dep dir that some
other uid left behind. It chowned them and did not touch the mode. Now:

- the dep dir **root** gets `addGroupWrite` — one `lstat` and at most one `chmod`,
  on a directory the function is about to `readdir` anyway. This is what lets a
  service create `node_modules/.vite` at all;
- a **leaked child tree** it takes ownership of is group-written recursively, so
  the next writer — which may be a service on a different uid — is not blocked by
  the mode after the ownership was repaired. Bounded by the leak, not by the
  dependency count.

`groupWriteRecursive` is deliberately **not** folded into `chownRecursive`: that
helper also walks the per-session credential subtree, which is `0600`/`0700` on
purpose. A mode change belongs to the callers that want one.

## 2a. Where the pin came from: the agent-facing docs said 1000

The client agent that hit this in another repository found the cause, and it was
not a mechanism at all. `/shipit-docs/environment.md` told every agent, as fact:

> You run as the unprivileged user `shipit` (UID/GID **1000**) … `id -u` reports
> `1000`.

That was true before docs/270 made the uid per-session, and false after. An agent
reading it and writing `user: "1000:1000"` into a compose service was doing
exactly what its documentation said. `plugin-authoring.md` went further and
shipped the pin in two copyable examples, one annotated "a contained session
requires this" — a requirement docs/271 had already removed.

So the docs were manufacturing the bug faster than any warning could have caught
it, and this is the fix that reaches every repository rather than one:

- `environment.md` now says the uid is **per-session, in 2000000–2999999, never to
  be hardcoded**, gives `id` output rather than a number to copy, states that the
  **gid** is the shared 1000, and names the consequence of pinning it (git
  ownership, dependency caches) with a pointer to `compose.md`.
- `plugin-authoring.md` drops `user:` from both examples and corrects "owned by
  the session-worker uid (1000)". A fragment *cannot* name the right uid — no
  fragment can know it — so declaring none is the only correct advice.
- `session-worker-uid.ts`'s own header carried the same stale parenthetical.

**A diagnostic was considered and rejected.** The obvious alternative was to
detect a declared `user:` on a workspace-mounting service and warn through the
agent-facing service list (`shipit service list` already carries the refusal text
this way). It would have been several layers of new plumbing to report a problem
the documentation was creating on purpose. Fix the source first; if pinned `user:`
lines keep appearing in projects whose docs now say otherwise, the warning becomes
worth building.

## 3. What it costs: the stack now needs the non-root runtime

Declaring nothing means relying on the fill-in, and the fill-in exists only where
`SHIPIT_SESSION_WORKER_UID` does. So on a deployment with **containment on and no
worker uid**, this repo's compose file is refused outright rather than merely
degraded — and the refusal takes the whole file, every service with it.

That is the correct behaviour, not a regression to route around: with no worker uid
there is no fill-in, so an undeclared service would run as its image default,
which for these images is root, under containment. Nor is the combination
impossible — containment is gated on `SESSION_EGRESS_ENFORCE` and the sidecar
image (`egress-firewall-install.ts`), not on the worker uid.

It is also not a live loss. In all-root mode the workspace is root-owned `0755`,
so the previous `user: "1000:1000"` could not write it either; the stack was
already broken there, in a quieter way. Every deployment that runs the dogfood has
the non-root runtime on. The guard test in `compose-generator.test.ts` asserts
**both** directions so the dependency is visible rather than implied.

## 4. What this does not change

A service that genuinely needs its own user — an image with a baked-in account —
still cannot own what it writes, so git remains unavailable to it and files it
creates stay unwritable to the agent. That is inherent to running as a different
uid, and `compose.md` now says so instead of implying group-write made it fine.

## 5. Key files

- `docker-compose.yml` — the four services that no longer declare a user.
- `src/server/orchestrator/session-worker-uid.ts` —
  `reconcileDepDirCacheOwnership` root + leak mode passes, `groupWriteRecursive`.
- `src/server/shipit-docs/compose.md` — tells an agent to delete a `user:` kept
  only for the old rule, and names both failure modes.

## 6. Follow-on: the ownership handoff is claimed ONCE, and the claim could not
   express what the walk does (2026-08-18)

Reported from production against `a841e147`: a session's `npm ci` failed
repeatedly with `EACCES` on `/dep-cache/npm/_cacache/tmp/…`, on a cache three
live sessions of the same repository shared, each at a different per-session uid
with the shared gid. npm's own advice ("your cache folder contains root-owned
files") pointed at an owner the cache did not have. With the cache unwritable no
install could run, the declared dependency directories stayed empty, and the
project's own `npm ci … || [ -x node_modules/.bin/vite ]` workaround then handed
ShipIt an exit status of 0 — so the install marker was stamped and the service
gate opened over a dependency tree that had never been built.

Two mechanisms, both in this seam, both fixed here.

**The sentinel names the identity, not the handoff.**
`docker/session-worker/entrypoint.sh` claims each tree with a marker directory
(`.shipit-gid-<gid>` for the shared `/dep-cache`, `.shipit-uid-<uid>-<gid>` for a
per-session mount) and every later boot skips on it. That is right while what the
walk DOES is fixed, and silently wrong the moment it learns to do more: a tree an
earlier image already claimed keeps the old treatment for good, on the
longest-running deployments — the ones with the most to repair. Two passes had
already landed that way (docs/271's workspace group-write and this doc's
shared-cache mode pass) and neither could reach an already-claimed tree.

The sentinel now carries a `HANDOFF_SCHEME` version alongside the identity, and
bumping it is the supported way to make a handoff change reach existing trees.
The superseded sentinel is pruned once the walk that supersedes it succeeds, so a
tree does not accumulate one marker per deployment.

**The writability probe locked root out of the repair, self-latchingly.** This is
the root cause, and it was found by inspecting a live production session rather
than by reading the code — the code reads as correct.

`[ -w "$d" ] || continue` guards the loop. Its comment says `test -w` is the right
probe "even though we are still root here", because access(2) reports EROFS
regardless of privilege. That is true and it is not the whole rule: **root passes
W_OK on a directory it does not own only via CAP_DAC_OVERRIDE, and the session
container drops it.** Measured on the production host, `/proc/1/status` gives a
bounding set of CHOWN, FOWNER, KILL, SETGID, SETUID and nothing else. So root's
access is decided by the `other` class like anyone else's.

`/dep-cache` is `0755` owned by the uid that first claimed it — 1000, from before
docs/270 made the uid per-session — so `other` is `r-x`, root fails the probe, and
the branch that would repair the cache is never reached. **The state that locks
root out was created by the handoff's own first run**, so the fault is
self-latching: docs/270's group + setgid pass and docs/271's group write have
never executed on any deployment that ever claimed a cache under the old scheme.

Observed exactly so, on 2026-08-18, from inside a live session: `/dep-cache`
`0755 1000:1000` throughout, carrying the pre-docs/270 `.shipit-uid-1000` marker
dated Jun 26 and **no `.shipit-gid-*` marker at all** — the docs/270 branch had
never so much as staked its claim. A `touch` into it from the session's own uid
(2000088, gid 1000) is denied, which is the reported `EACCES`.

The absent marker is also what refutes the first explanation written here, that a
`chmod -R` failing under `set -e` had latched a half-finished walk: that story
requires a marker on disk, and there is none. It is recorded rather than deleted
because it is the explanation the code alone supports, and the next reader will
reach for it too.

So the shared-cache branch now runs **before** the probe. It needs no write
permission to decide anything: `stat` reads (root has `r-x`), and the walk needs
CAP_CHOWN and CAP_FOWNER rather than write permission — both retained. The
sentinel is written **as the worker** through `gosu`, after the walk, for the same
reason the `/credentials` prep already is: root cannot create it, and the uid the
walk has just made group-writable can. Writing it after rather than claiming
before gives up the concurrent-boot claim (two sessions may both walk, idempotent,
once) and buys a sentinel that can only exist if the thing it records actually
happened — which removes the release-the-claim path entirely.

The mode passes are additionally best-effort now, matching `chown_workspace`'s
own, so a path another session unlinks mid-walk cannot kill a boot.

**And an install's outcome is no longer its exit status.** `classifyEmptyDepDirs`
(then named `emptyDepDirsContradictingMarker`)
was applied only when deciding whether to TRUST a marker. It is now applied when
deciding whether to WRITE one: a declared dep dir that is present-and-EMPTY when
the install commands finish fails the install, so the gate stays shut and the
`install_error` names the directory instead of leaving `install finished` as the
only account of what happened. Absent stays fine on both sides — a project that
manages no dependency directory is not a failed install.

**Correction (planning#480): "absent stays fine" was unreachable under the overlay
dep store.** docs/183 mounts an overlay at every declared dep dir, and a mount
point is a directory — so inside a container a declared dep dir is never absent,
only present, and when the install does not fill it, always empty. An npm
**workspaces** monorepo (root install hoists everything; `server/node_modules` is
never created) therefore landed in the fatal branch on every session, retrying
every 30 seconds forever while the app ran correctly, with no state the repo
could reach that cleared it short of editing `agent.dep-dirs`.

The fix reads npm's own record rather than loosening the predicate. An empty dep
dir is excused only when **all three** of these hold for an ancestor package:

1. the ancestor's **hidden** lockfile (`node_modules/.package-lock.json`, npm's
   record of what it reified) **links** the dir's package —
   `{ "resolved": "server", "link": true }`;
2. that hidden lockfile records **no entry at all** under the package's own
   `node_modules/`;
3. the ancestor's **manifest** lockfile (`package-lock.json`) records none either.

**Each condition closes a hole found in review; the first cut had only 1.**
Verified against npm 10 and 11: a root on `lodash@4` with a workspace `server` on
`lodash@3` writes BOTH the link and `server/node_modules/lodash@3.10.1` into the
root hidden lockfile, and creates `server/node_modules` on disk — so a link alone
proves nothing about the workspace's own dep dir.

Condition 2 is **unfiltered**, and an intermediate cut got that wrong too by
reusing the staleness check's `isRequired`. That predicate excludes optional,
peer and platform-restricted entries because it reads the MANIFEST side, where a
package npm never installed still appears. The hidden lockfile lists only what is
on disk — verified: an optional dependency skipped for a platform mismatch is
absent from it entirely — so those exclusions could only make ShipIt ignore a
package that IS there. This repository's own hidden lockfile has 21 such entries.
`isRequired` is now private again, with a docstring saying which side it is for.

Condition 3 is what stops a **stale** record from laundering an install. The
ancestor tree need not itself be a declared dep dir, so nothing else proves its
record describes the install that just ran: for a repo declaring only
`server/node_modules`, an older commit's root install recorded the link with
everything hoisted, and a laundered install over a newer commit leaves that record
in place. The manifest lockfile cannot drift that way — it is committed, current
with the checkout by construction — so it is the statement the record is checked
against. A missing manifest lockfile is therefore also a refusal.

The looser alternative (fail only when EVERY declared dep dir is empty) was
rejected: it keeps this incident's shape but opens a new one, where a monorepo's
successful root install masks a laundered sub-install. The exemption cannot
weaken what this section or docs/183 protects, because every exemption requires a
hidden lockfile that only a real install writes: a laundered exit and both
docs/183 flag-transition modes leave the ROOT dep dir empty, which is never
eligible, and where only a nested dep dir is declared the surviving ancestor
record is precisely what decides whether the empty mount point should hold
anything. It is applied inside the single shared predicate, so the trust side and
the write side still cannot diverge. Full argument, including why the path walk
is deliberately lexical: `npm-workspace-hoist.ts`'s module doc.

### Key files (follow-on)

- `docker/session-worker/entrypoint.sh` — the shared-cache branch moved ahead of
  the `[ -w ]` probe, `HANDOFF_SCHEME`, `share_cache_with_all_sessions`,
  `prune_stale_sentinels`.
- `src/server/session/install-controller.ts` — the post-install dep-dir check and
  `finishInstallFailed`.
- `src/server/session/install-failure.ts` — `formatEmptyDepDirsFailureMessage`,
  `formatHoistedDepDirsWarning`.
- `src/server/session/overlay-dep-check.ts` — `classifyEmptyDepDirs`, the one
  predicate both the trust side and the write side apply.
- `src/server/session/npm-workspace-hoist.ts` — the planning#480 hoist exemption
  and why it cannot weaken either side.
- `src/server/shared/shipit-config-test-guard.ts` — the write hook that stops a
  malformed `shipit.yaml` fixture from silently disabling any of these checks.
  Installed suite-wide by `server-test-setup.ts`; `expectInvalidShipitConfig` is
  the opt-out for a test whose point IS the invalid config.

**A note on how the checks above are tested.** Every reader of the config here
catches `ShipitConfigError` and falls back to a conservative empty result — right
in production, and the reason a malformed *fixture* is invisible: the check
evaluates nothing and the test still passes. Three of the tests in
`install-controller-dep-dir-outcome.test.ts` were green that way, because YAML
parses a bare `true` as a boolean and `agent.install: [- true]` is therefore
rejected. Auditing for more of them by reading test sources cannot work, since
fixtures are built by interpolation; validating every fixture at the moment it is
written can, and does both jobs at once. Running the full suite behind that hook
found no further vacuous fixtures and eleven tests that write a malformed config
deliberately, now marked as such — twelve `expectInvalidShipitConfig` call sites
across eleven files, counting the one in `shipit-config.test.ts` that predates the
audit. The hook replaces the function on the `node:fs` default export, so a test
reaching a write through a named or namespace import would not be intercepted;
every fixture in the suite today uses the default form, which makes this a strong
default rather than an airtight invariant.
- `src/server/orchestrator/session-worker-uid.ts` — `shareTreeOnce` carries the
  same one-shot hazard and is not wrong today; the docstring says when it becomes
  wrong and what it would cost to rotate.

### What the follow-on does NOT close

**Copy-up preserves the lower file's OWNER, and group-write does not buy
`chmod`.** `shareTreeWithAllSessions` hands a published overlay base generation
over by GROUP — it must, since a base is shared by every session in its scope
and chowning it to one session's uid would EACCES every other. Under per-session
uids that means no session owns any base file. Group-write covers `write`,
`unlink` and `rename` (the last two are governed by the directory), so the
ordinary install path is fine: `npm ci` removes and re-extracts each package, and
a file created in the upper is owned by the session that created it.

What it does not cover is any operation that requires OWNERSHIP rather than
permission — `chmod` and `utimes` with explicit times — on a file that copied up
from the base. A postinstall step or a patcher that edits an inherited dependency
and then marks it executable will EPERM for every session that is not the
publishing one.

This was reported alongside the incident above as the cause, and it is not: the
failing route was `npm ci`, which never chmods a lower file. It is left open
deliberately rather than fixed on speculation, and it has no cheap fix — the
options are per-uid bases (which defeats sharing) or idmapped mounts.

**The orchestrator-side twin of the sentinel is NOT scheme-versioned.**
`shareTreeOnce` (`session-worker-uid.ts`), which shares the pnpm store and each
overlay base generation, claims its tree with a gid-stamped marker and has the
same one-shot shape. It is not wrong today — it and the group+mode walk it
performs shipped together, so no tree is claimed under a version of the walk that
did less — so it is deliberately left alone rather than bumped, because rotating
it costs a synchronous multi-gigabyte re-walk at container create. Read §6 as
fixing the entrypoint's sentinels only; the asymmetry is intended, and the
condition under which it stops being safe is recorded on that function.
