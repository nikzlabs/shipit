---
issue: https://linear.app/shipit-ai/issue/SHI-122
title: Dep-cache evolution — content-keyed install skip + pnpm shared store
description: Key the install-skip on a content hash of the dependency input files (not just the commit) so unchanged-dep sessions skip install; plus a shared per-runtime pnpm store to restore pnpm's hardlink economics under overlay.
---

# Dep-cache evolution: content-keyed install skip + pnpm shared store

Two follow-ups from the docs/183 overlay dep-store canary ([SHI-93](https://linear.app/shipit-ai/issue/SHI-93)).
They are independent and ship separately.

- **Part 1 — content-keyed install skip.** *(this PR)* Widen the stamped install
  marker so it skips on a **hash of the dependency input files**, not only an
  exact source-commit match. A feature-branch session that touches source/docs
  but not `package.json`/the lockfile then skips install entirely.
- **Part 2 — pnpm shared store volume.** *(planned)* Stop overlaying `node_modules`
  for pnpm repos — `EXDEV` across the overlayfs boundary forces pnpm to full-copy
  (~464 MB/session into the upper) instead of hardlinking. Mount a shared
  per-runtime content-addressed pnpm store on the workspace filesystem instead,
  restoring pnpm's native hardlink economics. Not implemented here.

> **Shelf (not scheduled).** Converge the overlay base store to a
> content-addressed multi-base map (`lockfileHash → base`), which would replace
> the ancestry/depth/flatten machinery in `overlay-base.ts`. Out of scope for
> both parts above.

---

## Part 1 — content-keyed install skip (implemented)

### Problem

The stamped install marker (`src/server/shared/install-marker.ts`, docs/183
Phase 3) skips `agent.install` only on an **exact** match of source commit +
runtime fingerprint + install commands. That is correct but too narrow: two
different commits that touch only non-dependency files (a README edit, a source
refactor) have byte-identical `package.json` and lockfiles — their dependency
trees are the same — yet the commit-keyed marker forces a full reinstall on the
second commit. Feature-branch sessions, which almost always differ from the base
commit, never benefit from the marker-skip even when their deps are unchanged.

### Design — a content key alongside the commit

Add a `depsHash` field to the marker stamp: a sha256 over the ordered
`(relpath, bytes)` of the dependency **input** files. The `/install` gate's match
widens from a strict AND to:

> skip when **runtimeKey** and **installCommands** match **AND**
> (**sourceCommit** matches **OR** **depsHash** matches).

The commit path is unchanged; the content path is purely additive. Both still go
through the empty-dep-dir contradiction check (docs/183 PR #1276) before a skip is
honored, so a content-match over an empty overlay mount still reinstalls.

**Safety invariant — a wrong/missing hash can only ever cause a miss (reinstall),
never a wrong skip.** A `null` `depsHash` on either side never matches via the
content path (`depsHashMatches` requires both non-null and equal), so a marker
without a content key, or a session whose content-keying is disabled, simply
falls back to commit-only.

### Which files are hashed (`deps-hash.ts`)

Per-ecosystem dependency input files, derived from the `agent.install` commands:

| Recognized command (common flags tolerated) | Hashed inputs |
|---|---|
| `npm install` / `npm ci` / `npm i` | `package.json`, `package-lock.json` |
| `pnpm install` | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| `yarn` / `yarn install` | `package.json`, `yarn.lock` |
| `pip install -r <file>` | the named requirements file(s) |
| `uv sync` | `pyproject.toml`, `uv.lock` |

Absent files don't contribute (so a lockfile appearing later changes the hash, as
it should); if **no** input file exists the hash is `null` (commit-only).

### Codegen safety rule

The content path is only active when **every** `agent.install` entry is a
recognized **pure dependency install** (the table above). If any command does
codegen, a build, or anything that consumes files beyond the manifest
(`npx prisma generate`, `npm run build`, a custom script), its output could change
without the hashed inputs moving — so the whole install falls back to commit-only
(`resolveDepsHashInputs` returns `null`).

An explicit **`agent.install-inputs: [files…]`** in `shipit.yaml` opts back in and
**replaces** the default per-command input set — for repos whose `install` mixes a
dep install with codegen but whose dependency surface is still a known file list.
`install-inputs` parses with the same structural rules as `dep-dirs` (literal
relative paths, no globs, no `..`, not the workspace root; invalid entries dropped
with a warning).

### Publish/ancestry CAS is unchanged

This only **widens skips**. It never publishes a base, never advances the overlay
rolling base, and does not touch the `overlay-base.ts` compare-and-swap or its
ancestry/depth/flatten logic.

### Key files

- `src/server/shared/install-marker.ts` — `depsHash` on `InstallMarkerStamp`;
  `INSTALL_MARKER_VERSION` bumped to **2** (a v1 marker parses to `null` → clean
  miss); `markerMatches` widened to the OR.
- `src/server/shared/deps-hash.ts` *(new)* — `depInputsForCommand`,
  `resolveDepsHashInputs`, `computeDepsHash`, `computeInstallDepsHash`.
- `src/server/shared/shipit-config.ts` — `agent.install-inputs` (`installInputs`
  on `AgentConfig`, default `null`; `KNOWN_AGENT_KEYS`; `parseInstallInputs`
  sharing `normalizeLiteralRelPath` with `dep-dirs`).
- `src/server/session/session-worker.ts` — the `/install` gate computes
  `depsHash` for the current stamp (`computeDepsHash` private helper, reads
  `install-inputs` from the resolved config).
- `src/server/orchestrator/overlay-session.ts` — `preStampInstallMarker` (warm
  pool / base-hit path) threads `depsHash` into the marker it writes, so a later
  session on a different commit with identical dep files can content-key-skip
  against the pre-stamped marker.
- `src/server/shipit-docs/shipit-yaml.md` — documents `install-inputs` and the
  content-keyed skip for the in-container agent.

### Tests

- `install-marker.test.ts` — round-trip with `depsHash`; v1/legacy markers miss;
  the OR logic incl. the null-never-matches invariant.
- `deps-hash.test.ts` *(new)* — the command allowlist, the override/default/fallback
  resolution, hash determinism + dep-edit bust + null-when-no-files.
- `shipit-config.test.ts` — `install-inputs` parsing (default null, string,
  list+normalize+dedup, explicit `[]`, invalid-drop, wrong-type fallback).
- `overlay-session.test.ts` — the pre-stamp carries `depsHash`.
- `integration_tests/session-worker.test.ts` — content-match skip on a different
  commit with identical dep files; a dep-file edit busts it; a non-allowlisted
  command stays commit-only.

---

## Part 2 — pnpm shared store volume (planned, not in this PR)

See SHI-122. Sketch: detect pnpm repos, skip the `node_modules` overlay for them
(EXDEV defeats pnpm's hardlinks across the overlay boundary), and instead mount a
shared per-`(runtime)` content-addressed pnpm store as a normal volume on the
workspace filesystem so `pnpm install` hardlinks into `node_modules` natively.
Tracked separately; this doc records the intent so the two parts stay legible
together.
