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
| `safeSimpleGit(dir)` (`shared/git-hooks-guard.ts`) | every simple-git caller, including all `createGitManager` sites (~189) and `GitManager`'s own instance | Resolved from `dir` inside the factory — covered by construction **for the tree it reads**; see the read/create note below | ESLint `no-restricted-imports` forbids importing `simple-git` directly, so there is no way around the factory |
| Raw `spawn` / `execFile` / `execFileSync` / `execFileAsync` of `"git"` | **29** literal sites across 9 files, all of them below | Spelled out per site (`gitSpawnOverridesForTree`) | `git-hooks-guard-coverage.test.ts` fails the build for a spawn that names a working directory and omits the call |

### The choke point is complete for a tree a site READS, and blind to one it CREATES

This is the sentence to take away, and it is sharper than "one site was missed".
`safeSimpleGit`'s own comment used to claim it "covers call sites nobody has
written yet" — corrected in this change, because the claim is true of exactly
half the problem. The drop is resolved from `baseDir`. **A `clone` names its
destination as an argument, never as `baseDir`**, so the factory cannot see the
tree that is about to come into existence. Two consequences, both of which have
been live bugs:

- **A bare `safeSimpleGit()`** has no `baseDir` at all, so it runs as root and
  leaves its destination `root:root`. The next `safeSimpleGit(<destination>)`
  drops to that path's session uid and meets a tree it does not own.
- **A `safeSimpleGit(<source>)` clone** drops to the *source's* uid, so the
  destination is created owned by whoever owns the source — correct only if
  someone then says so.

So every site is asked **two** questions here, not one: *does it drop uid*, and
*what owns the tree it writes into*. The first audit asked only the first, which
is why its verdicts needed re-checking; the tree-creating sites are Table B and
Table B2 below.

One more caveat on the choke point, checked: **a caller's own `spawnOptions`
wins** over the resolved drop (`git-hooks-guard.ts:145`). Grepped: **no caller
passes `spawnOptions`.** The escape hatch is unused.

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
| `services/marketplace.ts` `cloneCatalog` | a URL — no local source tree | ✅ n/a — the marketplace cache is ShipIt's own, not a session's |
| `plugin-generations.ts:1114` `checkoutCommit` | plugin bare cache, root-owned | ❌ **was the gap — fixed in this change** |

`services/session-fork-merge.ts` used to be a fourth. planning#407 converted it:
it creates the destination, hands it to the source session's identity, and clones
with the drop resolved from the source tree. Its remaining `safeSimpleGit()`
mention is prose in a comment.

## Table B2 — every other site that CREATES a tree

Re-checked under the second question after the gap was found, on the assumption
that one wrong classification is rarely the only one. These are the `clone` and
`init` sites that are **not** bare — a drop does resolve — so the narrower audit
cleared them correctly, but the question that matters for them is who owns the
directory at the moment git writes into it.

| Site | What it creates | Owner at that moment |
|---|---|---|
| `services/session-fork-merge.ts:138` `clone --local` with `baseDir` = the source session | the fork's workspace | ✅ chowned to the **source** session's identity before the clone and re-sealed to the fork's after, both orderings argued in place |
| `services/templates.ts:166` `createGitManager(sessionDir).init()` — a **standalone** session | `.git` in a fresh session workspace | ✅ `createSessionDirFactory` seals the session dir *and* `chownTreeToSessionWorker`s the empty tree before anything is written into it. Its comment names this exact failure — "a session whose RECORD says one uid and whose contents say another" |
| `services/templates.ts:69` `scaffoldGit.init()` | a throwaway `mkdtemp` scaffold | ✅ root-owned and outside `sessionsRoot`, so no drop resolves. Stated in place |
| `services/marketplace.ts` `cloneCatalog` → `<cacheDir>` | the catalog cache | ⚠️ `<stateDir>/marketplace-cache`, a sibling of `sessions/` and not under it, so the answer comes from the TREE — root-owned **when this deployment created it**, which is a property of the disk and not a guarantee. See the note below |
| `repo-git.ts:148,160` `clone [--bare] <url> .` | the shared bare cache | ✅ `baseDir` is the cache dir itself, root-owned |
| `route-registry.ts:429` `git.init()` | a test session's workspace | ✅ `isTestMode` only, and tests are non-root, so no drop resolves |

No further gaps. The one that was wrong is the one already fixed.

### Note — "root-owned" is a fact about the disk, not a guarantee (planning#418)

Two rows above used to read "root-owned throughout" as a clearance. They are
downgraded to ⚠️ because that phrasing hides where the fact comes from. For a
path outside `sessionsRoot`, `resolveGitTreeUid` answers from the TREE, so the
clearance holds only while the tree stays root-owned — and nothing in this
codebase enforces that. A cache root left non-root-owned by an older deployment,
a restore, or a non-root runtime silently flips the answer, and this is not
hypothetical: the marketplace cache reached exactly that state in production.

What it does when it flips is worth stating, because it is not the failure mode
the drop was designed around. `resolveGitTreeUid` stats **only the top-level
tree**, while git writes into `.git/objects`. So a checkout root owned by a
non-root uid makes a **root** orchestrator run git as that uid against a
`.git/objects` a root-era fetch left root-owned, and the result is
`insufficient permission for adding an object to repository database
.git/objects` from a root process — which reads as impossible and is exactly why
it was ruled out for a full pass of planning#418's diagnosis. A `⚠️` row is
therefore not "probably fine": it is a site whose correctness a future `ls -ldn`
can disprove, and where a permission error should be read as an ownership
disagreement between the tree and its `.git/objects` before anything else.

`services/marketplace.ts` recovers from its own instance (it rebuilds the cache,
which makes ownership uniform again) and logs all three trees plus the uid the
resolver chose. Neither is a general fix; the general question — whether the
resolver should consult `.git/objects` rather than the tree root — is open.

## Table C — the gap, and what it would have done

`plugin-generations.ts`'s `checkoutCommit` stages a plugin generation. **As it
was, before this change:**

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
| `repo-git.ts:120,140` · `startup-tasks.ts:259` · `workflow-loader.ts:101` · `plugin-generations.ts:1010,1063` · `services/marketplace.ts` `updateCatalogClone` | bare caches / ShipIt's own dirs, root-owned | ✅ no drop **while the tree stays root-owned** — see the marketplace note below |

## What arming does NOT touch

Named because each is a plausible 2am worry, and each is answered by the layout
rather than by care:

- **Git inside the session container.** `GIT_CONFIG_GLOBAL=/credentials/.gitconfig`
  there resolves to a *different file*: the container mounts the per-session
  subtree `sessions/<sessionId>`, not the credentials root (a volume `Subpath`
  mount in production, a direct bind in dev — `container-lifecycle.ts:343-361`),
  and that subtree's `.gitconfig` is `writeContainerGitConfig`'s sanitized
  output, which never carried a `safe.directory` entry. The orchestrator's own
  gitconfig sits at the volume root and is not visible from inside. The
  workspace is owned by the uid the container runs as, so git's check passes
  there on its own merits.
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
| **Inherited process cwd** — a spawn with no `cwd` and no `-C`. Live instance: `build-id.ts:13`. | Harmless in production because `Dockerfile.prod` sets `WORKDIR /app`, which holds no repository. That is a property of the image, not something any rule here checks — so it is a verdict that a future `WORKDIR` change silently invalidates. |
| **A working directory reached through `GIT_DIR` / `GIT_WORK_TREE` / `--git-dir`.** | Grepped: **no orchestrator or shared source sets or passes any of them.** |
| **A spawn whose binary is not a quoted `git` literal** (`const GIT = "git"`). | **Three exist, none of them git**, and finding them took a second look: `session-namer.ts:549` and `services/redaction.ts:263` spawn the agent CLI (`binary` from `cliInvocation`), `templates.ts:159` spawns the package manager (`LOCK_ONLY_COMMAND` — npm/pnpm/yarn). An earlier version of this row said "none", because the grep behind it required the binary on the *same line* as the call and all three wrap it onto the next — the same shape the scanner's own regex handles with a `\n?` and a hand-written grep did not. Corrected by the independent review; the verdict for arming is unchanged, and it is a reminder that "grepped: none" is a claim about a regex until someone checks it. |
| **`exec`/`execSync` with a shell string.** | Grepped: **none in production orchestrator code** (only `integration_tests/test-helpers.ts`). |
| **Indirection deeper than one in-file `const`.** | The scanner treats anything it cannot resolve as carrying a working directory — fail-closed, so this narrows what is *reported*, never what is *demanded*. |
| **A tree whose on-disk owner differs from the session record.** docs/270 reads identity from `<sessionsRoot>/<sessionId>`, deliberately not from the tree, so an Open session's root compose service that `chown`s its own workspace produces a real mismatch. | **Expected and correct to fail once armed.** That refusal is docs/270 req 2 working: the alternative is executing a `.git/config` payload at a uid the session chose. |

---

# Part 2 — the runbook

## Before anything else: a green local run proves nothing here

This class of failure is **invisible below root**. The uid drop is gated on
`process.getuid() === 0` (`git-tree-uid.ts`), so on any non-root process it
resolves to "no drop" and every site behaves identically whether its ownership
handling is right or wrong. That covers the entire test suite, the dogfood inner
instance (`RUNTIME_MODE=local`), and a developer's laptop.

It is not a theoretical caveat: it is *why* the `plugin-generations.ts` gap
survived review and shipped, and why it took a source audit rather than a failing
test to find. So an operator who ran the suite, drove the dogfood instance, and
saw green has learned nothing about the armed path. **The evidence that matters
is a production soak, and it is the reason this procedure has a soak step.**

## Preconditions

1. E1 has been running in production and the uid drop has been **seen** working
   — sessions commit, push, and provision normally.
2. Part 1's audit is current for the deployed build. Run the census
   (`npx vitest run src/server/shared/git-hooks-guard-coverage.test.ts`) against
   the deployed commit rather than trusting the tables as written. The
   production image strips test files and a VPS host has no node toolchain, so
   run it **inside the container** against the deployed source.
3. **The build must include the `plugin-generations.ts` fix** (planning#410).
   Test for it rather than inferring it — `checkoutCommit` must call
   `handWorkspaceBackToWorker(targetDir)` immediately after its `clone --local`.
   If that line is absent, do not arm: staging a plugin generation fails on that
   build either way, and arming changes only the error text.
4. **Deploy the target build UNARMED first, verify it healthy, then arm in a
   second deploy.** Arming together with an application change makes a refusal
   unattributable — and the deployed build is routinely behind the checkout, so
   this is the normal case rather than the careful one. Confirm which commit is
   actually running; do not assume it matches `/opt/shipit`.
5. Pick a quiet window. Arming takes effect on the post-turn commit path.

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
docker compose exec shipit git config --file /credentials/.gitconfig --get-all safe.directory
# expect: no output, exit 1
```

**`--file`, not `--global`.** `GIT_CONFIG_GLOBAL` is set by the orchestrator on
its **own process** at boot (`initGlobalGitConfig`, `git-config.ts:233`) and is
not in the container's declared environment, so a `docker compose exec` shell
does not inherit it. A `--global` read there resolves to `$HOME/.gitconfig` —
and the orchestrator's `HOME` is deliberately `/root` (`docker-compose.yml:44`,
"Do NOT set HOME here") — a file nothing writes. It prints nothing and exits 1
**whether or not the arming took**, which is worse than no check at all: it
reads as confirmation. Naming the path is the only reading that answers the
question asked.

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
| **Auto-push** | no log line — success is a client message, `Auto-pushed to origin/<branch>`, on the session's PR card | `[auto-push] <sessionId>: Auto-push failed: fatal: detected dubious ownership …`, plus the same text in the session's **log ring**. Watch the log ring and the server log, not the transcript: the transcript copy rides `emitMessage`, which is transport-only, so it is there for an attached viewer and gone after a reload. The scheduler warns on **every** path that ends without a push (invariant 5), so a session that pushes nothing and logs nothing is itself worth checking. |
| **Session provisioning (LFS)** | `[git-lfs] Pulled LFS content for <workspaceDir> in <n>ms` | `[git-lfs] git lfs pull failed for <workspaceDir> — <reason>` |
| **Fork** | the fork's first turn commits normally | the `clone --local` refuses on the **source**: `fatal: detected dubious ownership in repository at '<src>/.git'` — note this names the *gitdir*, not the worktree root the post-turn failures name. planning#407's measurement against git 2.39.5, inherited here rather than re-run, and it is why that site was converted. |
| **Plugin activation** | the generation publishes and the `active` symlink resolves to it | a permission error, or the refusal naming the `.staging-*` directory under `<sessionDir>/state/plugins/`. **Exercise this deliberately** — it is where the gap was, it is the surface least likely to be hit by an ordinary turn, and on a build without planning#410's fix it fails whether or not you armed anything |

**Soak for at least one full session lifecycle** — create, turn, push, fork,
archive — plus a session provisioned from a repo with **LFS**, plus one session
that **activates a plugin**. The paths that only run at *creation* are the ones a
short soak misses, and both of the known bugs in this class lived on exactly
those paths.

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
