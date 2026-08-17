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
