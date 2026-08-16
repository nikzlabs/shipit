---
issue: planning#410
title: Arming SHIPIT_GIT_STRICT_OWNERSHIP — call-site audit and operator runbook
description: Every orchestrator-side git call site with a verdict, and the ordered procedure for arming git's ownership check in production and rolling it back.
---

# Arming `SHIPIT_GIT_STRICT_OWNERSHIP`

Tracked by planning#410. Design context is [plan.md](./plan.md) §E2; the
requirement this serves is [requirements.md](./requirements.md) req 7 — *a missed
or newly-added orchestrator-side git call site MUST fail closed*.

## The two steps, and which one this document is for

planning#410's end state is deleting **both halves** — the
`SHIPIT_GIT_STRICT_OWNERSHIP` switch and the `safe.directory=*` write — so
fail-closed is simply how ShipIt works. That takes two steps, in order:

1. **Arm the switch in production** and let it soak. A human operator action
   against a running deployment. This document is the procedure.
2. **Then delete both halves**, in one change.

Step 1 is a go/no-go a person takes; nothing in this document takes it. Part 1
below is the precondition for taking it at all — arming converts *every*
orchestrator git call site that fails to drop uid into a hard failure at once,
and the failure lands on the post-turn commit path, where uncommitted agent work
has no reflog entry and no recovery (`CLAUDE.md` invariant 2). So the question
"does such a call site still exist" has to be answered before the switch is
touched, not after.

**A breakage is never evidence that the `*` should stay.** The `*` is what makes
a missed call site silent, which is the entire defect (req 7). If arming breaks
something, the finding is a missed call site to fix.

---

# Part 1 — the audit

Every place the orchestrator runs `git`, what tree it runs it against, and
whether it drops uid. Current as of 2026-08-16.

## What "drops" means, and the two ways a site can be wrong

E1 made orchestrator-side git run as the uid that **owns the tree**. Arming
removes the `safe.directory=*` that today suppresses git's own CVE-2022-24765
check, so from then on git enforces the same predicate ShipIt is trying to
honour. A site is wrong if the two disagree, and they can disagree in *two*
directions — the second is easy to miss, and is where this audit found its gap:

| Shape | What arming does |
|---|---|
| **A — no drop, non-root tree.** Root git on a worker-owned session tree. | `fatal: detected dubious ownership in repository at '<path>'` |
| **B — drop, root-owned tree.** Dropped git on a tree ShipIt itself left `root:root`. | The same refusal, one step earlier than the `EACCES` the write would hit anyway |

Shape B matters because it is invisible in every place it gets exercised: the
drop is inert unless the process is root (`resolveGitTreeUid` returns `null`
otherwise), so every test and the dogfood inner instance behave identically
whether the site is right or wrong.

Measured against git 2.39.5 in this container, with
`GIT_TEST_ASSUME_DIFFERENT_OWNER=1`: the refusal names **one** path — the
repository root — and a single `safe.directory` entry for it satisfies the whole
command. So a failure line carries the workspace path, which maps straight to a
session id.

Sites that operate on a **root-owned** tree (the shared bare cache,
`/opt/shipit`, the plugin bare cache) correctly drop nothing and are listed for
completeness, not as gaps.

## The two shapes that reach git, and where the choke point is

| Executor | Sites | Drop | Enforced by |
|---|---|---|---|
| `safeSimpleGit(dir)` (`shared/git-hooks-guard.ts`) | every simple-git caller, including all `createGitManager` sites (~189) and `GitManager`'s own instance | Resolved from `dir` inside the factory — covered by construction | ESLint `no-restricted-imports` forbids importing `simple-git` directly, so there is no way around the factory |
| Raw `spawn` / `execFile` / `execFileSync` / `execFileAsync` of `"git"` | **29** literal sites across 9 files, all of them below | Spelled out per site (`gitSpawnOverridesForTree`) | `git-hooks-guard-coverage.test.ts` fails the build for a spawn that names a working directory and omits the call |

Two caveats on the choke point, both checked:

- **A caller's own `spawnOptions` wins** over the resolved drop
  (`git-hooks-guard.ts:145`). Grepped: **no caller passes `spawnOptions`.** The
  escape hatch is unused.
- **A bare `safeSimpleGit()` — no `baseDir` — has no tree to stat**, so it runs
  as root with no ownership predicate at all. That is its own table below, and
  it is where the gap was.

## Table A — raw git spawns (complete: all 29, by the scanner's own count)

Counts were taken with the scanner's own regex over its own roots
(`orchestrator/` + `shared/`, `integration_tests/` excluded) rather than by
hand, so this table lists the same population the CI rule enforces on. Nothing
holds the two in step automatically — the rule demands the drop per site and
does not pin a total, because a pinned total would churn on every legitimate
addition. Re-run the count before trusting this table against a later build.

| Site | Count | Tree | Verdict |
|---|---|---|---|
| `shared/git.ts:1085` `getFileBufferAtCommit` | 1 | session workspace (`cwd`) | ✅ drops — `gitSpawnOverridesForTree(this.workspaceDir)` |
| `orchestrator/git-lfs.ts:132` `runGit` | 1 | session workspace **or** bare cache (`cwd`, caller-supplied) | ✅ drops — resolved from `cwd`, so both cases answer correctly |
| `orchestrator/git-lfs-blob.ts:174` `git lfs smudge` | 1 | session workspace | ✅ drops |
| `orchestrator/github-auth.ts:396` `config --replace-all credential.helper` | 1 | session workspace | ✅ drops |
| `orchestrator/repo-git.ts:387` `isAncestor` | 1 | shared bare cache, root-owned | ✅ no drop needed; resolved from `this.repoDir` anyway |
| `orchestrator/services/updates.ts` | 10 | `/opt/shipit`, root-owned | ✅ no drop needed; every one takes `gitOpts`, which spreads the call at :229 (checked: 10 of 10) |
| `orchestrator/services/shipit-source.ts:89` | 1 | `/opt/shipit` (or `SHIPIT_SOURCE_DIR`), root-owned. Carries its directory as `-C`, not `cwd` | ✅ no drop needed; spelled out |
| `orchestrator/build-id.ts:33` `gitInHostRepo` | 1 | `/opt/shipit`, root-owned | ✅ no drop needed; spelled out |
| `orchestrator/build-id.ts:13` `resolveBuildId` | 1 | **inherited process cwd** — no `cwd`, no `-C` | ⚠️ out of the scanner's reach by construction; see *Residual blind spots* |
| `orchestrator/git-config.ts` | 11 | no repository at all (`config --global`, `config --file`) | ✅ n/a — git's ownership check applies to a repository, and these name none |

`integration_tests/test-helpers.ts` runs `execSync("git …")` in fixture repos.
Out of scope by the scanner's own rule, and correct: tests are non-root, so the
drop is inert and no `safe.directory` is written.

## Table B — bare `safeSimpleGit()` (no `baseDir`, therefore root)

This is the shape with no ownership predicate. Its purpose is always `clone`,
and the hazard is always the **destination**: root leaves it `root:root`, and the
next `safeSimpleGit(<destination>)` drops to that path's session uid.

| Site | Source tree | Destination handled? |
|---|---|---|
| `repo-git.ts:284` `cloneFromCache` | shared bare cache, root-owned | ✅ `handWorkspaceBackToWorker(sessionDir)` before the `config` writes — fixed by docs/270, which documents the exact reasoning |
| `services/marketplace.ts:143` | a URL — no local source tree | ✅ n/a — the marketplace cache is ShipIt's own, not a session's |
| `plugin-generations.ts:1068` `checkoutCommit` | plugin bare cache, root-owned | ❌ **was the gap — fixed in this change** |

`services/session-fork-merge.ts` used to be a fourth. planning#407 converted it:
it creates the destination, hands it to the source session's identity, and clones
with the drop resolved from the source tree. Its remaining `safeSimpleGit()`
mention is prose in a comment.

## Table C — the gap, and what it would have done

`plugin-generations.ts`'s `checkoutCommit` stages a plugin generation:

```ts
await safeSimpleGit().raw(["clone", "--local", "--no-checkout", bareCacheDir, targetDir]);
const git = safeSimpleGit(targetDir);          // ← drops to the SESSION's uid
await git.raw(["config", "gc.auto", "0"]);     // ← on a root:root tree
```

`targetDir` is `<sessionDir>/state/plugins/<repo>/generations/<commit>.staging-*`
— a path **inside a session**, so docs/270's resolver answers with that session's
own uid and the drop fires. The clone that created the tree ran as root. Shape B.

- **Today**: `git config gc.auto 0` cannot take `.git/config.lock` in a
  `root:root 0755` `.git`. Plugin activation fails with a permission error on any
  deployment running the non-root worker runtime.
- **Once armed**: it stops one step earlier, at
  `fatal: detected dubious ownership in repository at '<staging dir>'`.

Why it survived E2's audit: that audit classified this file as "the bare caches
in `repo-git.ts`, `plugin-generations.ts`" — true of `bareCacheDir`, and this
function's *other* tree is a session's. Why it survived testing: the drop is
inert below root, so the suite and the dogfood instance pass either way.
`plugin-install.ts:321`'s own comment ("a root-owned checkout would leave the
plugin root unwritable") records the tree's state at the time without connecting
it to the git that had already run there.

**Fixed here** by handing the tree over between the clone and the dropped git,
matching `cloneFromCache` exactly — including using the object-aware
`handWorkspaceBackToWorker` rather than a plain recursive chown, because
`clone --local` hardlinks `.git/objects` from the shared plugin cache and an
inode has one owner across every link.

## Table D — `safeSimpleGit(dir)` against a session tree

All covered by the choke point. Listed so "covered by construction" is a
statement someone checked rather than inherited, and because the *ordering*
question (is the tree owned by the uid we drop to, at this moment?) is per-site.

| Site | Tree | Ordering |
|---|---|---|
| `shared/git.ts` `GitManager` (all of auto-commit, push, rebase, merge, branch) | session workspace | ✅ owned by the session before any turn runs |
| `services/install-session.ts:103,107` · `services/headless-sessions.ts:370,372` · `services/claim-session.ts:439` · `services/session.ts:265,420` · `warm-pool-manager.ts:168` | session workspace | ✅ after `cloneFromCache`, which hands the tree over before returning |
| `services/child-sessions.ts:589,604` | claimed session workspace | ✅ same, plus `handWorkspaceBackToWorker` after the `reset --hard` |
| `services/session-fork-merge.ts:138,175,287` | source + fork workspaces | ✅ handled explicitly, both orderings argued in place |
| `git-utils.ts:317,385,461,463` (fetch, default-branch sync, cache-sync check) | session workspace | ✅ E3 mints a repo-scoped credential for the dropped fetch |
| `overlay-session.ts:366,557` | session workspace | ✅ |
| `services/rebase-driver.ts`, `services/github-ci-fix.ts` (via `GitManager`) | session workspace | ✅ |
| `repo-git.ts:120,140` · `startup-tasks.ts:259` · `workflow-loader.ts:101` · `plugin-generations.ts:1009,1062` · `services/marketplace.ts:132` | bare caches / ShipIt's own dirs, root-owned | ✅ no drop, correctly |

## What arming does NOT touch

Named because each is a plausible 2am worry, and each is answered by the layout
rather than by care:

- **Git inside the session container.** It reads
  `/credentials/.gitconfig` from the session's *own* credentials subtree, written
  by `writeContainerGitConfig` — a different file that never had a
  `safe.directory` entry. The workspace is owned by the uid the container runs
  as, so git's check passes on its own merits.
- **Host scripts** (`deployment/vps/*.sh`, `update.sh`). They run on the host
  against `/opt/shipit`, with the host's own git config. `GIT_CONFIG_GLOBAL` is
  the orchestrator process's, not theirs.
- **Compose services and plugin containers.** Their git is their own; nothing
  here reaches them.

## Residual blind spots

Stated because an overstated guarantee is worse than a named gap. Each is a
limit of the *scanner*, and each has a verdict.

| Blind spot | Verdict |
|---|---|
| **Inherited process cwd** — a spawn with no `cwd` and no `-C`. Live instance: `build-id.ts:13`. | Harmless in production: the orchestrator's cwd holds no repository. That is a property of the deployment, not something any rule here checks. |
| **A working directory reached through `GIT_DIR` / `GIT_WORK_TREE` / `--git-dir`.** | Grepped: **no orchestrator or shared source sets or passes any of them.** |
| **A spawn whose binary is not a quoted `git` literal** (`const GIT = "git"`). | Grepped for spawn-family calls with a variable binary in `orchestrator/` + `shared/`: **none.** |
| **`exec`/`execSync` with a shell string.** | Grepped: **none in production orchestrator code** (only `integration_tests/test-helpers.ts`). |
| **Indirection deeper than one in-file `const`.** | The scanner treats anything it cannot resolve as carrying a working directory — fail-closed, so this narrows what is *reported*, never what is *demanded*. |
| **A tree whose on-disk owner differs from the session record.** docs/270 reads identity from `<sessionsRoot>/<sessionId>`, deliberately not from the tree, so an Open session's root compose service that `chown`s its own workspace produces a real mismatch. | **Expected and correct to fail once armed.** That refusal is docs/270 req 2 working: the alternative is executing a `.git/config` payload at a uid the session chose. |

---

# Part 2 — the runbook

## Preconditions

1. E1 has been running in production and the uid drop has been **seen** working
   — sessions commit, push, and provision normally.
2. Part 1's audit is current for the deployed build. If the build predates the
   `plugin-generations.ts` fix in this change, **do not arm**: staging a plugin
   generation fails either way, and arming changes only the error text.
3. Pick a quiet window. Arming takes effect on the post-turn commit path.

## Arming

```bash
# On the host
echo 'SHIPIT_GIT_STRICT_OWNERSHIP=1' >> /etc/shipit/shipit.env
/opt/shipit/deployment/vps/deploy.sh
```

`deploy.sh` sources `/etc/shipit/shipit.env` with `set -a` (`deploy.sh:17-21`),
and `docker-compose.yml:159` passes the variable into the orchestrator's own
process environment. Exporting it in a shell without the compose line is a
silent no-op — the same trap `OVERLAY_DEP_STORE` and `SHIPIT_GIT_LFS` carry.

Confirm the entry is gone rather than assuming the redeploy took:

```bash
docker compose exec shipit git config --global --get-all safe.directory
# expect: no output, exit 1
```

`initGlobalGitConfig` actively `--unset-all`s the entry an earlier boot wrote,
because the config file lives in the persistent credentials volume. Both
directions are idempotent.

## What to watch

Git's message wording is the C-locale English: the orchestrator pins `LC_ALL=C`
on its own process (`pinGitMessageLocale`, `git-config.ts:331`), so this is git's
source wording rather than a property of the host's locale.

**The one string that covers every surface:**

```bash
docker compose logs -f shipit | grep -i 'dubious ownership'
```

Any hit is a missed call site. The line names the repository root, which maps to
a session id via `<sessionsRoot>/<sessionId>/workspace`.

Per surface:

| Surface | Healthy | Failure |
|---|---|---|
| **Post-turn auto-commit** | `[git] Committed: <hash> <summary> on branch: shipit/<name>` | `[git] auto-commit failed for <sessionId>: fatal: detected dubious ownership …` — **and the user sees it**: `autoCommit` rethrows, and `post-turn.ts` emits a persisted transcript notice beginning *"This turn was NOT committed"* with git's own text quoted. The working tree is untouched; the next turn commits everything once the site is fixed. |
| **Auto-push** | no log line — success is a client message, `Auto-pushed to origin/<branch>`, on the session's PR card | `[auto-push] <sessionId>: Auto-push failed: fatal: detected dubious ownership …`, and the same text in the session's log ring and transcript. The scheduler warns on **every** path that ends without a push (invariant 5), so a session that pushes nothing and logs nothing is itself worth checking. |
| **Session provisioning (LFS)** | `[git-lfs] Pulled LFS content for <workspaceDir> in <n>ms` | `[git-lfs] git lfs pull failed for <workspaceDir> — <reason>` |
| **Fork** | the fork's first turn commits normally | the `clone --local` refuses on the **source**: `fatal: detected dubious ownership in repository at '<src>/.git'` — note this names the *gitdir*, not the worktree root the post-turn failures name. planning#407's measurement against git 2.39.5, inherited here rather than re-run, and it is why that site was converted. |
| **Plugin activation** | the generation publishes and `active` resolves | a permission error or the refusal naming the `.staging-*` directory. Requires the fix in this change. |

**Soak for at least one full session lifecycle** — create, turn, push, fork,
archive — plus a session provisioning from a repo with LFS. The paths that only
run at *creation* are the ones a short soak misses.

## Rollback

Unsetting the variable and redeploying restores **today's behaviour exactly**.
That reversibility is the whole reason this shipped as a switch rather than as a
merged deletion, which would have needed a revert and a rebuild:

```bash
sed -i '/^SHIPIT_GIT_STRICT_OWNERSHIP=/d' /etc/shipit/shipit.env
/opt/shipit/deployment/vps/deploy.sh
```

On the next boot `initGlobalGitConfig` rewrites `safe.directory=*`, and every
site that was refusing runs exactly as it did before. Work that failed to commit
is still in the working tree — the notice above says so on purpose — and the
next turn commits it.

**Roll back to stop the bleeding, then fix the call site.** Do not close
planning#410 by leaving the variable unset: a permanent flag is a supported way
to turn the boundary back off, which is what the issue exists to prevent. A
breakage found here belongs on planning#403 or this doc as a missed call site.

## After a clean soak

Step 2 (planning#410) deletes, in one change: `gitStrictOwnership()`, the
`applySafeDirectoryPolicy` branch, the `docker-compose.yml` passthrough, their
tests, and the docstrings describing a switch. `git-config.ts` ends with no
`safe.directory` write at all.

The scanner rule that stops a future call site re-granting the key
(`git-hooks-guard-coverage.test.ts`) **stays** — it outlives both halves. After
step 2 the only remaining mention of `safe.directory` in the orchestrator should
be that test.
