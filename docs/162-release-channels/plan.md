---
status: planned
priority: medium
description: Add stable/edge release channels so self-hosters can pin to vetted, low-frequency releases instead of always tracking main.
---

# Release Channels

Let self-hosters choose how aggressively their ShipIt instance tracks upstream:
a **stable** channel that only advances to vetted, tagged releases, or an
**edge** channel that tracks `main` (today's only behavior). The choice is made
in the UI (Settings → Advanced → Software Updates) and persists across updates.

## Problem

Today there is exactly one way to run ShipIt: track `main`.

- `setup.sh` clones `origin/main` and `deploy.sh` builds whatever `HEAD` points at.
- The self-update flow (`docs/083-self-update`) is hardwired to `main`:
  - `checkForUpdates()` runs `git fetch origin main` and compares `HEAD` vs `origin/main`.
  - `update.sh` runs `git reset --hard origin/main` then `deploy.sh`.
- The only version identity is the commit SHA (`SHIPIT_BUILD_ID`, resolved by
  `build-id.ts`). There are no tags, no `package.json` version bumps per release
  (it's been static at `0.1.0`), and no CHANGELOG.

Consequences:

- Every self-hoster is a canary. A regression merged to `main` reaches everyone
  the next time they click **Update Now**, with no "wait for the dust to settle"
  option.
- There is no notion of "what version am I on" beyond a 7-char SHA, so users
  can't reason about, report, or compare releases.
- There is no rollback target — `git reset --hard origin/main` always moves
  forward to the tip.

We want fixed releases that a conservative operator can sit on, while letting
people who want the latest keep riding `main`.

## Goals

- Two release channels, selectable per instance: **stable** (default for new
  installs) and **edge** (current behavior).
- **stable** advances only to tagged, vetted releases cut from `main` on a
  slower cadence. **edge** tracks `main` exactly as today.
- The channel choice is persisted on the host and **survives `git reset --hard`**
  / rebuilds (i.e. it is not stored in a tracked repo file).
- The update check and the version display are channel-aware: a stable instance
  reports `v1.4.0`, an edge instance reports `main @ abc1234`.
- Release notes / changelog for the pending update render **inline** in the
  update panel — no link-out to GitHub Releases on the happy path (Principle §2).
- A repeatable release-cutting process (tag + GitHub Release + moving `stable`
  pointer) driven by CI, so cutting a release is one deliberate action, not a
  pile of manual git surgery.
- Backward compatible: existing installs keep working and default to **edge**
  (no surprise downgrade on upgrade-to-this-feature).

## Non-goals

- Pinning to an arbitrary historical version from the UI ("install exactly
  v1.2.0"). The channel model gives stable-vs-edge; explicit version pinning is
  noted under Future work, not built here.
- A package registry, signed release artifacts, or binary distribution. ShipIt
  is still built from source on the host.
- Multiple concurrent stable lines (e.g. backported `v1.x` and `v2.x` LTS
  branches). One linear stable pointer for now.
- Automatic background updates / auto-apply. Updates remain user-initiated.

## Principles check (CLAUDE.md §§1–5)

- **Inline, no link-out.** The update panel already renders the commit list
  inline. We extend it to render the release version and notes for the pending
  stable release inline. "View release on GitHub" stays as an escape hatch in an
  overflow position, not the primary affordance.
- **Chat is input, agent is actor; no shell-shaped buttons.** Picking a channel
  and clicking **Update Now** are instance-administration actions on the existing
  Software Updates surface — they configure ShipIt itself, not run project shell
  commands. This is the same category as the existing update button, so it does
  not introduce a new shell affordance.

## Release model

We use **git tags as the immutable release artifact** and a **moving `stable`
branch as the channel pointer**. This keeps the update plumbing branch-symmetric
(a channel is just "which ref do I track") while giving tags/Releases for
identity and notes.

### Refs and conventions

- **Final releases**: annotated tags `vX.Y.Z` (semver), cut from a commit on
  `main`. These are the only things the stable channel will advance to.
- **Pre-releases** (optional): `vX.Y.Z-rc.N`. Excluded from the stable channel.
- **`stable` branch**: a fast-forward-only pointer that the release process moves
  to each new `vX.Y.Z` tag commit. `origin/stable` is therefore "the latest
  stable release," queryable with the exact same `git fetch` / `rev-parse`
  machinery we already use for `main`.
- **`main`**: unchanged — the integration branch, and the edge channel's target.

Channel → tracking ref:

| Channel  | Target ref      | Cadence            | Audience                         |
|----------|-----------------|--------------------|----------------------------------|
| `stable` | `origin/stable` | per release cut    | default; conservative operators  |
| `edge`   | `origin/main`   | every merge        | early adopters, contributors     |

Why both a tag *and* a `stable` branch (rather than just tags): resolving "the
latest non-prerelease tag" requires semver sorting and prerelease filtering in
the updater. Pointing `stable` at the release commit lets `checkForUpdates()` and
`update.sh` stay a one-line `ref` parametrization of today's code. The tag is
still what we display as the version (`git describe --tags --exact-match` on the
`stable` commit yields `vX.Y.Z`) and what GitHub Releases hangs notes off of.

### Cutting a release (CI-driven)

A new workflow `.github/workflows/release.yml` triggered on pushing a `v*` tag:

1. Run the full `check` + `test` jobs (reuse `ci.yml` steps) against the tagged
   commit — a release must be green.
2. On success, fast-forward `stable` to the tagged commit
   (`git push origin <sha>:refs/heads/stable`). Fails loudly if it would not be a
   fast-forward (guards against tagging off a non-`main` commit).
3. Create a GitHub Release for the tag with auto-generated notes (PR titles since
   the previous tag). These notes are the changelog we surface inline.

Maintainer's release ritual becomes: bump `package.json` `version`, commit to
`main`, then `git tag -a vX.Y.Z -m … && git push origin vX.Y.Z`. CI does the rest.
A short `docs/` note or `RELEASING.md` documents this.

## Where the channel preference lives

The preference must survive `git reset --hard origin/<ref>` and image rebuilds,
so it cannot be a tracked file. Reuse the existing host-repo bind mount
(`/opt/shipit` is mounted into the orchestrator, see `docker-compose.yml:26`) and
the existing untracked-trigger-file pattern (`.update-requested`,
`.restart-requested`):

- **`/opt/shipit/.release-channel`** — a one-line file containing `stable` or
  `edge`. Untracked (add to `.gitignore`). Written by the orchestrator when the
  user changes channel; read by both the orchestrator (for checks/display) and
  `update.sh` (to choose the ref).
- Absent file ⇒ default. New installs: `setup.sh` writes `stable`. Existing
  installs (upgrading into this feature): treated as `edge` so their behavior
  does not silently change — see Migration.

This mirrors `.update-requested` exactly, so no new mount, volume, or IPC channel
is introduced.

## Update flow changes

### `checkForUpdates()` (`services/updates.ts`)

Becomes channel-aware:

1. Read `/opt/shipit/.release-channel` (default per Migration rules).
2. Resolve the target ref: `stable` → `origin/stable`, `edge` → `origin/main`.
3. `git fetch origin <branch> --tags` (tags needed so we can name the stable
   version).
4. Compare `HEAD` vs the target ref as today. Extend the returned
   `UpdateStatus` with:
   - `channel: "stable" | "edge"`
   - `currentVersion: string` — `git describe --tags --exact-match HEAD` if on a
     tag, else `main @ <short-sha>`.
   - `latestVersion: string` — same for the target ref (`vX.Y.Z` on stable).
   - keep `behindBy` / `commitMessages` (commit list between current and target,
     rendered inline as the changelog).
5. Handle the **direction** correctly: when a user switches edge→stable, `HEAD`
   (a recent `main` commit) may be *ahead of* `origin/stable`. `behindBy` via
   `HEAD..origin/stable` is then 0 but the refs differ — report this as
   "switch to stable (vX.Y.Z)" rather than "up to date," and flag it as a
   potential downgrade (see Risks).

### `setChannel()` (new in `services/updates.ts`)

Writes `/opt/shipit/.release-channel`. Exposed via a new route
`POST /api/updates/channel { channel }` in `api-routes-updates.ts`. Returns the
fresh `checkForUpdates()` result so the UI immediately shows what switching
implies.

### `update.sh`

Reads the channel and resets to the right ref:

```sh
CHANNEL="$(cat "$SHIPIT_DIR/.release-channel" 2>/dev/null || echo edge)"
case "$CHANNEL" in
  stable) REF="origin/stable" ;;
  *)      REF="origin/main" ;;
esac
git fetch origin --tags --prune
git fetch origin "${REF#origin/}"
git reset --hard "$REF"
bash "$SHIPIT_DIR/deployment/vps/deploy.sh"
```

`deploy.sh` is unchanged: it already bakes `SHIPIT_BUILD_ID="$(git rev-parse
HEAD)"`, which now points at the release commit on stable. No detached-HEAD
concerns because we reset a (local) ref to track the remote, we don't `checkout`
a tag.

### Version surfacing (`build-id.ts` + client)

`resolveBuildId()` keeps returning the SHA (it's the cache-busting identity the
client reload logic in `client-build.ts` depends on — leave that contract
alone). Add a separate human-facing version resolver:

- New `resolveVersion()` (server) returns `{ channel, version, commit }` where
  `version` is `vX.Y.Z` when on a release, else `main @ <short-sha>`. Surface it
  on the bootstrap payload / Software Updates panel; the Settings panel then
  shows e.g. **"Stable · v1.4.0"** or **"Edge · main @ abc1234"** instead of a
  bare SHA.
- **It must `git describe`/`rev-parse` inside the bind-mounted `/opt/shipit`, not
  reuse `resolveBuildId()`'s mechanism.** In the prod container `resolveBuildId()`
  reads the baked `SHIPIT_BUILD_ID` env var — the image has no `.git`, so running
  `git describe --tags --exact-match` in the container's own cwd sees no repo and
  returns nothing. `resolveVersion()` must shell out against `/opt/shipit` exactly
  as `checkForUpdates()` already does (`cwd: HOST_REPO_DIR`), and must define a
  fallback for the local/dogfood case where `/opt/shipit` is absent — fall back to
  the `SHIPIT_BUILD_ID` short SHA with channel reported as `edge`, the same
  graceful-degradation case as the channel selector.

## UI (Settings → Advanced → Software Updates, `Settings.tsx`)

- A **channel selector** (segmented control / radio): **Stable** (recommended) /
  **Edge**, with one-line descriptions ("Stable: vetted releases, fewer updates."
  / "Edge: latest changes from main, updated continuously.").
- Current version line uses the channel-aware label.
- **Check for Updates** behaves as today but the result reads in version terms:
  "v1.4.0 available (you're on v1.3.2)" with the inline changelog (commit/PR list
  or release notes).
- Switching channel calls `POST /api/updates/channel`, then re-renders the check
  result. If the switch implies a downgrade (edge→stable where stable is behind),
  show a clear warning before **Update Now** (see Risks).
- Overflow-only "View release on GitHub" escape hatch — secondary, per §2.

## Migration / backward compatibility

- **Existing installs** are running off `main` with no `.release-channel` file.
  The default-when-absent must be **edge** so clicking Update keeps doing exactly
  what it does today (track `main`). The selector lets them opt into stable.
- **New installs**: `setup.sh` writes `.release-channel=stable` and, ideally,
  clones/`reset --hard` to `origin/stable` so a fresh box boots on the latest
  release rather than the tip of `main`. (Requires `stable` to exist — bootstrap
  the first `stable` by cutting `v0.1.0` before this ships, otherwise `setup.sh`
  falls back to `main`.)
- **`setup.sh` re-run path must become channel-aware.** `setup.sh` is documented
  "safe to re-run" and its repo-update branch currently does an unconditional
  `git -C /opt/shipit pull` (line 88), which advances the checked-out branch to
  its upstream tip. On a stable box that would silently jump the instance forward
  to `main`'s tip (or whatever the local upstream is) on the next provisioning
  re-run — exactly the un-pinning the channel model exists to prevent. The
  re-run path must instead read `.release-channel`, then `git fetch origin --tags`
  and `git reset --hard <channel ref>`, mirroring `update.sh` rather than calling
  `git pull`.
- The default-absent asymmetry (existing→edge, new→stable) is intentional: it
  preserves current behavior for current users while making the safer choice the
  default for newcomers.

## Risks & mitigations

- **Downgrade on edge→stable / on a stable that's behind.** `git reset --hard` to
  an older commit can run older code against newer on-disk state (chat history
  JSON, usage, session metadata, repo caches). Mitigations: (1) the UI warns
  explicitly when the target is not strictly ahead; (2) treat persisted data as
  forward/backward tolerant — document that schema-breaking changes to those
  stores are release-boundary events. A true "safe downgrade" guarantee is out
  of scope; the warning + docs are the v1 answer.
- **Stable lags real bugfixes.** A conservative channel means security/critical
  fixes need a way to reach stable fast. Convention: patch releases (`vX.Y.Z+1`)
  cut from `main` (or a cherry-pick) on demand; stable users get them via the
  normal check. Document the patch-release path in `RELEASING.md`.
- **`stable` fast-forward invariant broken.** If someone tags off a branch that
  isn't an ancestor of current `stable`, the release workflow's FF push fails —
  this is the desired loud failure, not a silent force-push. Never force-push
  `stable`.
- **Tag fetch cost / detached HEAD.** We `git fetch --tags` (cheap) and only ever
  `reset --hard` a tracking branch ref, never `checkout` a tag, so HEAD stays on
  a branch and `build-id` stays a normal SHA.
- **Inner dogfood / local mode.** `RUNTIME_MODE=local` dev instances and the
  dogfood path have no `/opt/shipit` host mount; channel logic must degrade
  gracefully (default edge, hide/disable the selector) exactly as the existing
  update check already does when the host repo is absent.

## Key files

| File | Change |
|------|--------|
| `src/server/orchestrator/services/updates.ts` | Channel-aware `checkForUpdates()`; new `setChannel()`; extend `UpdateStatus` with channel/version fields |
| `src/server/orchestrator/api-routes-updates.ts` | New `POST /api/updates/channel`; channel in check response |
| `src/server/orchestrator/build-id.ts` | Add `resolveVersion()` — `git describe` against `/opt/shipit` (NOT the container cwd / `SHIPIT_BUILD_ID` env), with a short-SHA/`edge` fallback when the host repo is absent; keep `resolveBuildId()`'s SHA contract untouched |
| `src/server/shared/types/domain-types.ts` | Version/channel types surfaced to client |
| `src/client/components/Settings.tsx` | Channel selector + version label + inline release notes + downgrade warning |
| `deployment/vps/update.sh` | Read `.release-channel`, reset to the channel's ref |
| `deployment/vps/setup.sh` | Default new installs to `stable`; write `.release-channel`; clone/checkout `origin/stable`; **replace the re-run `git pull` (line 88) with a channel-aware `fetch --tags` + `reset --hard <ref>`** so a re-run never un-pins a stable box |
| `deployment/vps/docker-compose.yml` | (no change — `/opt/shipit` mount already present at line 26) |
| `.gitignore` | Add `.release-channel` |
| `.github/workflows/release.yml` | New: on `v*` tag → CI gate → FF `stable` → GitHub Release with notes |
| `package.json` | `version` becomes meaningful; bumped per release |
| `deployment/README.md` | Document channels, switching, and the release process |
| `RELEASING.md` (new) | Maintainer release ritual (tag, patch releases, stable FF) |
| `src/server/shipit-docs/*` | Update if channel/version becomes agent-visible |

## Rollout phases

1. **Foundations (no UI).** Establish tags + `stable` branch, cut `v0.1.0`, add
   `release.yml`. Stable now exists and tracks the first release.
2. **Channel-aware updater.** `.release-channel` file, channel-aware
   `checkForUpdates()` / `update.sh`, version resolver. Default edge everywhere
   so nothing changes for existing installs yet.
3. **UI.** Channel selector, version labels, inline notes, downgrade warning.
   Flip `setup.sh` default for new installs to stable.
4. **Docs.** README + `RELEASING.md` + shipit-docs.

## Future work

- Explicit version pinning ("stay on v1.4.x", manual install of a chosen tag).
- LTS / multiple stable lines with backports.
- Signed releases / artifact verification.
- Surfacing "you are N releases behind" and per-release notes history inline.
