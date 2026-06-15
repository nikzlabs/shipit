---
issue: https://linear.app/shipit-ai/issue/SHI-154
title: Self-update resilient to an SSH origin
description: Orchestrator rewrites github.com SSH remotes to HTTPS so the update check keeps working when /opt/shipit is re-pointed at an SSH URL.
---

# Self-update resilient to an SSH origin

## The problem

"Check for updates" calls `checkForUpdates()` (`services/updates.ts`), which runs
`git fetch origin <branch> --tags` with `cwd: /opt/shipit` **inside the
orchestrator container**. The container is built from `docker/Dockerfile.prod`
and ships **no SSH key and no `known_hosts`** — there is no github.com SSH setup
anywhere in the image, and never has been in any commit.

So when `/opt/shipit`'s origin is an **SSH** remote
(`git@github.com:owner/repo.git`), the in-container fetch fails before auth is
even attempted:

```
Failed to fetch updates: Command failed: git fetch origin main --tags
Host key verification failed.
fatal: Could not read from remote repository.
Please make sure you have the correct access rights and the repository exists.
```

This is **not** a token problem. SSH never consults git's credential helper, so a
perfectly valid Settings-UI GitHub token is irrelevant on the SSH path. The
trailing "make sure you have the correct access rights" is git's generic
SSH-failure boilerplate, which is misleading — it reads like a permissions
failure when the real cause is an unverifiable host key.

### How a working install breaks

The updater was written assuming an **HTTPS** origin (the default
`https://github.com/nicolasalt/shipit.git`), over which the container's existing
credential helper authenticates fine. The break happens when something re-points
`/opt/shipit`'s origin to SSH — typically when moving a now-private upstream onto
an SSH **deploy key**, which makes host-side `git pull` / `update.sh` convenient.
After that switch:

- **Host** `git pull` / `update.sh` keep working — the host has the SSH key and
  `known_hosts`.
- **Container** "Check for updates" breaks immediately — it can't speak SSH.

A re-clone (`git clone git@github.com:…`) or `git remote set-url` performed by an
agent (Claude run on the host, or an ops session) rewrites `/opt/shipit/.git/config`
without ever touching the interactive shell's `~/.bash_history`, which is why the
change can be invisible in shell history yet show up as a fresh `.git/config`
mtime.

## The fix

Make the orchestrator's git **transport-agnostic** for github.com. In
`initGlobalGitConfig` (`git-config.ts`) — which writes the orchestrator's
`GIT_CONFIG_GLOBAL` — install a global `url.<base>.insteadOf` rewrite:

```
git config --global url."https://github.com/".insteadOf "git@github.com:"
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

Now every orchestrator git op (including the self-update fetch) that encounters a
github.com SSH URL transparently uses **HTTPS**, which flows through the global
credential helper — the **Settings-UI token** installed by
`setGlobalCredentialHelper`. No new credential, no SSH key in the container.

### Why this scope is correct

- **Orchestrator-only.** `initGlobalGitConfig` is called solely from
  `app-di.ts`; session containers receive a *separate* sanitized config via
  `writeContainerGitConfig`, so agents' project git is unaffected.
- **Host untouched.** The rewrite lives in the container's `GIT_CONFIG_GLOBAL`,
  not on the host. A host-side SSH deploy key keeps working for `update.sh` /
  `git pull`.
- **Unconditional + idempotent.** Applied on every boot regardless of
  `SHIPIT_SESSION_WORKER_UID`. `--replace-all <key> <value> <value_regex>` with a
  per-entry regex replaces each entry in place, so repeated init calls never
  duplicate it. Harmless for HTTPS origins (no rewrite happens).

### Prerequisite

The Settings-UI GitHub token must have **`repo` scope on the upstream repo** for
the HTTPS fetch to authenticate (classic PAT with `repo`, OAuth token, or a
fine-grained PAT that grants the repo). Otherwise the failure mode changes from
"Host key verification failed" to a 403 — which is at least an honest auth error.

## Key files

| File | Purpose |
|------|---------|
| `src/server/orchestrator/git-config.ts` | `initGlobalGitConfig` — installs the github.com SSH→HTTPS `insteadOf` rewrite |
| `src/server/orchestrator/git-config.test.ts` | Unit + functional (`ls-remote --get-url`) coverage of the rewrite |
| `src/server/orchestrator/services/updates.ts` | `checkForUpdates()` — the in-container fetch that this unblocks |
| `docs/083-self-update/plan.md` | The self-update feature this hardens |

## Notes / alternatives considered

- **Revert origin to HTTPS on the host** (`git remote set-url origin https://…`)
  fixes the symptom but undoes the deliberate SSH-deploy-key setup and re-couples
  the orchestrator to the origin's transport — it would break again on the next
  re-clone. The `insteadOf` rewrite is transport-agnostic and permanent.
- **Bake an SSH key + `known_hosts` into the orchestrator image** was rejected:
  it puts a deploy key inside the orchestrator container and runs against the
  whole HTTPS-token brokering design (docs/172).
</content>
</invoke>
