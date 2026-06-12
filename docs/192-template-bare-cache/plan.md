---
description: Template-created repos must seed their shared cache as a bare repo, not a non-bare working tree.
---

# 192 — Template repo creation must produce a *bare* shared cache

## Symptom

For a repo created from a template (the "create new repo → pick a template" flow),
the orchestrator log repeats on every warm/prefetch cache refresh:

```
[prefetch] Bare-cache fetch failed for https://github.com/<owner>/<repo>.git (non-fatal):
           /usr/local/bin/shipit-git-credential store: 1: /usr/local/bin/shipit-git-credential: not found
fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/workspace/repo-cache/<hash>'
```

Repos *added by URL* never show this — only template-created ones.

## Root cause

`createRepoWithTemplate` ([services/templates.ts](../../src/server/orchestrator/services/templates.ts))
seeded the shared cache dir (`getSharedRepoDir(...)` → `/workspace/repo-cache/<hash>`)
with a **non-bare** `git init`:

```js
const repoDir = getSharedRepoDir(cloneUrl);
await sharedGit.init();                       // git init --initial-branch=main  (NON-bare!)
await sharedGit.addRemote("origin", cloneUrl);
githubAuthManager.configureGitCredentials(repoDir);  // local shipit-git-credential helper
await applyTemplateFiles(template, repoDir);  // scaffolds files into a WORKING TREE
await sharedGit.autoCommit(...);
await sharedGit.push("origin", "main");
```

The comment said "bare repo cache dir," but `GitManager.init()` runs a normal
`git init` with a working tree and checks out `main`. That single function
produced the corrupt cache state exactly:

- `core.bare = false`, `main` checked out → later cache `git fetch` is refused
  (`refusing to fetch into branch 'refs/heads/main' checked out`), so the cache
  silently never advances past its creation snapshot.
- a repo-local `credential.helper = /usr/local/bin/shipit-git-credential` (from
  `configureGitCredentials`) → orchestrator-side `git fetch` broadcasts the
  post-auth `store` action to that broker, which only exists in the session-worker
  image, producing the `shipit-git-credential: not found` noise. (The `get` still
  succeeds via the orchestrator's global inline helper, so auth itself works —
  it's noise, not an auth failure.)

The add-by-URL path was always correct because it uses `cacheGit.cloneBare(...)`
([api-routes-session.ts](../../src/server/orchestrator/api-routes-session.ts)).

`ensureBareCache` ([repo-git.ts](../../src/server/orchestrator/repo-git.ts)) never
self-heals it: its validity check only confirms a top-level `HEAD` file exists,
not that the repo is bare, and the prefetch path doesn't call it at all.

## Fix

Rewrite `createRepoWithTemplate` to scaffold + commit + push from a **throwaway
working tree** (`fs.mkdtemp`), then create the shared cache via `cloneBare(cloneUrl)`
— identical to the add-by-URL path. The cache ends up a genuine bare repo, and
the per-dir `configureGitCredentials(cacheDir)` call is dropped (the bare cache is
orchestrator-only, never mounted into a session container, so it needs no broker
helper). Push auth comes from the orchestrator's global git credential helper.

## Key files

- `src/server/orchestrator/services/templates.ts` — `createRepoWithTemplate` (the fix; now takes `createRepoGit`).
- `src/server/orchestrator/api-routes-session.ts` — caller passes `createRepoGit`.
- `src/server/orchestrator/services/templates.test.ts` — regression test asserting the cache is bare, has no working tree, no local credential helper, and the remote received the push.

## Remediation for existing corrupt caches

A cache already created as non-bare won't self-heal. Removing the dir forces a
clean bare re-clone on the next session claim:

```
rm -rf /workspace/repo-cache/<hash>
```

## Follow-up (not done here)

Harden `ensureBareCache` to validate bareness (`git rev-parse --is-bare-repository`)
in addition to `HEAD` existence, so a non-bare repo in the cache slot is
auto-recovered instead of erroring indefinitely.
