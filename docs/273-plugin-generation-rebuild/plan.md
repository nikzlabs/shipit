---
issue: nikzlabs/shipit#2411
title: Rebuilding a plugin version that is live
description: Generation identity stops being the commit, so a re-install builds beside the live version instead of clearing it.
---

# Rebuilding a plugin version that is live

Implements [requirements.md](./requirements.md). Extends docs/262 (generations,
the consumer lease) and docs/266-plugin-install-diagnosability (`refresh
--force`).

## The two defects, as diagnosed

**A — the install never ran, and no later round could run it** (req 1).
`activateOnce` skips everything when the declared commit is already live:

```ts
if (previous?.commit === commit && !deps.force) return { status: "unchanged", ... };
```

The commit is the whole test. But what an activation installs is not decided by
the commit alone — it is `selected`, the intersection of the repository's
manifest exports with the consuming project's `plugins.use` entries, and only a
selected export's `install` ever runs. So a round that resolves an **empty**
selection publishes a generation with no install output and no install record
at all (`installCommands([])` is empty, and the runner records nothing when
there is nothing to run), and every later round — with the selection now
correct — returns `unchanged` and never installs.

An empty selection is not exotic: `parseUseList` **drops** a `use` entry whose
`from:` names no declared repo, so any moment where the `repos:` list and the
`use:` list disagree — exactly what a mid-session swap of a repository walks
through — yields one. Whatever produced it, the state is terminal: the commit
never moves again, so the round that would install is the round that returns
`unchanged`. Reproduced in `plugin-generations.test.ts` ("a selection that grew
after the commit went live").

**B — the recovery is deadlocked by the plugin it would repair** (reqs 2, 3).
`--force` re-stages the version already live, which means clearing
`generations/<commit>` (the overlay lowerdir) and `work/<commit>/upper` (the
live writable layer) under whatever is mounted on them. That is what the
consumer lease (`plugin-leases.ts`) forbids, so force asks it first and reports
`still in use` when it is refused. For a plugin that declares a service the
lease can never be granted:

- the in-process hold is taken per **declared** fragment
  (`holdResolvedGenerations`), not per running container — so stopping the
  service, or setting `autostart: false`, changes nothing; and
- a **stopped** container still pins its volume, so `removePluginOverlay`
  returns false as well.

The reporter's guess that the agent container's read-only `/plugins/<name>`
mount was the holder is wrong — a bind mount is not a lease, and holds come
only from the service surface and from a companion-CLI invocation. The service
surface alone is enough, and it re-takes its holds on every settle.

## The fix: a generation is identified by its build, not by its commit

Both defects are the same shape — *a version that is live cannot be rebuilt* —
and the subsystem already knows the answer to that, everywhere except here:
**stage a new tree and swap; never mutate the live one.** The only reason force
mutates in place is that the on-disk identity of a generation is its commit, so
a rebuild of the same commit has nowhere else to go.

So a generation directory is named by a **generation id**: the commit for an
ordinary build, and `<commit>.<8 hex>` for a rebuild of a commit whose
directory is in use. Everything a consumer mounts is keyed by that id — the
checkout under `generations/<id>`, the writable layer under `work/<id>`, and
the overlay volume — so a rebuild allocates a complete new set beside the live
one, installs into it, and publishes with the same atomic link swap every other
activation uses.

What that buys, per requirement:

- **req 2, 3** — a rebuild touches nothing the live version owns, so it needs
  no deletion lease and there is nothing to refuse. `still in use` is gone from
  the activation path (the prune keeps it, where a refusal only defers disk).
- **req 4** — nothing is discarded before the publish rename, so a rebuild that
  fails at fetch, install or the pre-publish gate leaves the live version and
  its layer untouched: an ordinary failed activation.
- **req 5** — the running service keeps its own lowerdir, upperdir and volume
  until the settle round after the publish rebuilds it on the new volume name.
  The superseded generation is then unheld and the next prune reclaims it.

The id is only forked when it has to be. `activateOnce` still stages into
`generations/<commit>` and takes the lease when that directory (or its layer)
already exists; the change is what happens when the lease is **refused** — the
build takes a fresh id and proceeds, instead of failing. That keeps every
existing property of the ordinary path, including the install stamp that makes
a re-stage after a failed publish a no-op.

### Knowing when to rebuild (req 1)

`GenerationRecord` gains `installedFor: string[]` — the selected exports whose
`install` this generation's layer was built for. The already-live shortcut then
asks a second question after "is the commit the same": does the live
generation's `installedFor` cover every selected export that declares an
`install`? The needed set is read from the live generation's **own manifest**,
which is exact — same commit, same file.

Three deliberate limits:

- **Only when an install runner exists.** In local/dogfood mode there is none,
  so a rebuild would install nothing, record `installedFor: []` again and
  rebuild on every round. There the `not-run` record and the existing warning
  are already the honest answer.
- **A record without `installedFor` covers everything.** Generations published
  before this change cannot say what they installed, and treating "unknown" as
  "not installed" would re-install every live plugin in every session on the
  first round after an upgrade — the opposite of req 5.
- **A failed rebuild does not retry on a timer.** The live generation keeps its
  old `installedFor`, so the next round triggered by an edit or a refresh tries
  again. Nothing loops on its own.

### `reinstalled` stops being about `--force`

`refreshPluginRepos` reports `reinstalled` only when the caller passed
`--force`, because before/after commits are equal by construction for a
re-install and `status` alone would read `unchanged`. An automatic rebuild has
exactly the same shape, so the flag is now "this round activated a generation
at the commit that was already live", whoever asked for it.

## Key files

| File | Change |
|---|---|
| `plugin-generations.ts` | Generation id (`GenerationRecord.id`), `installedFor`, the coverage test in the already-live shortcut, fresh id when the lease is refused, id-aware prune |
| `plugin-overlay.ts` | `pluginWorkDir` / `pluginOverlayVolumeName` / `buildPluginOverlaySpec` keyed by generation id; the volume name keeps its old form when the id is a bare commit |
| `plugin-install.ts` | `PluginInstallJob.generationId` — the layer and the stamp belong to the build, not the commit |
| `plugin-leases.ts` | `GenerationRef.generationId` — the lease key and the volume name must be the same identity |
| `services/plugin-services.ts`, `plugin-cli-run.ts`, `plugin-compose.ts` | Mount the id the live record names, not the commit |
| `services/plugin-refresh.ts` | `reinstalled` for any re-activation of the live commit |
| `agent-shim/shipit-plugin.ts` | `--force` help: no longer refused while a plugin container holds the version |

## What this does not change

- One activation per repository at a time, staging before publish, install
  before publish, and a failure leaving the prior generation live.
- The lease itself. A prune still takes it, and still declines to delete a tree
  a container has mounted; that refusal costs disk until the next round, never
  correctness.
- Disk: a rebuild holds one extra copy of the checkout and its install output
  until the superseded generation is unheld and pruned.
