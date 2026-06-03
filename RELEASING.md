# Releasing ShipIt

ShipIt ships in two **release channels** (see `docs/162-release-channels/plan.md`):

| Channel  | Tracks          | Audience                        |
|----------|-----------------|---------------------------------|
| `stable` | `origin/stable` | default; conservative operators |
| `edge`   | `origin/main`   | early adopters, contributors    |

`edge` always tracks `main` — nothing to do. This document is about cutting a
**stable** release.

## Release model

- **Releases are annotated tags** `vX.Y.Z` (semver) cut from a commit on `main`.
- The **`stable` branch is a fast-forward-only pointer** the release process
  moves to each new `vX.Y.Z` tag commit. `origin/stable` is therefore "the
  latest stable release," queried with the same git machinery as `main`.
- A **GitHub Release** hangs auto-generated notes (PR titles since the previous
  tag) off each tag. Those notes are the changelog ShipIt surfaces inline in the
  update panel.
- The notes are **grouped into sections** (Features, Fixes, Docs, Dependencies,
  Maintenance) by PR label, configured in `.github/release.yml`. Label your PRs
  so they land in the right section — an unlabeled PR falls through to *Other
  Changes*, so nothing is dropped, but the notes read better when labeled.

Never force-push `stable`. If a fast-forward fails, the tag was cut off a commit
that isn't an ancestor of current `stable` — that's the intended loud failure,
not something to override.

## Labels

The auto-generated GitHub Release notes are **grouped into sections by PR
label**. `.github/release.yml` maps labels to sections:

| Section | Labels |
|---|---|
| 🚀 Features | `feature`, `enhancement` |
| 🐛 Fixes | `bug`, `fix` |
| 📝 Documentation | `documentation`, `docs` |
| ⬆️ Dependencies | `dependencies` |
| 🧰 Maintenance | `chore`, `refactor`, `ci`, `test` |
| Other Changes | everything else (`*`) |

PRs labeled `ignore-for-release` are excluded from the notes entirely. An
unlabeled PR lands in **Other Changes**.

- **`.github/labels.yml` is the source of truth** for the label set (name,
  color, description). The `Sync labels` workflow (`.github/workflows/labels.yml`)
  creates/updates these labels in the repo on every push to `main` that touches
  `labels.yml`, and on manual `workflow_dispatch`. It runs with `skip-delete`,
  so GitHub's default labels are left untouched.
- **The auto-labeler applies best-effort labels.** On every PR, the labeler
  workflow (`.github/workflows/labeler.yml`, using `actions/labeler`) maps
  changed file paths to labels via `.github/labeler.yml` (e.g. `docs/**` →
  `documentation`, `.github/workflows/**` → `ci`). This is advisory only:
  **maintainers can add or remove labels by hand before merge**, and an
  unlabeled PR never fails CI. Hand-label anything the path rules miss so it
  lands in the right release-notes section.

## Cutting a normal release

1. From a clean `main`, bump the version and create the release commit + tag in
   one step:
   ```sh
   npm run release -- 0.2.0
   ```
   `npm run release` (`scripts/release.ts`) refuses to run on a dirty tree or a
   downgrade, rewrites `package.json` + `package-lock.json`, commits
   `Release v0.2.0`, and creates the annotated `v0.2.0` tag. It does **not**
   push — pushing the tag is the deliberate act that triggers the release.
2. Push the commit and the tag:
   ```sh
   git push origin HEAD
   git push origin v0.2.0
   ```
3. CI takes over (`.github/workflows/release.yml`):
   - **`version-guard`** fails the release unless `package.json` version equals
     the tag (it always will when you use `npm run release`). This is the guard
     that keeps the human-facing version and the tag from drifting.
   - Runs the full `check` + `test` gates against the tagged commit. A release
     must be green.
   - Fast-forwards `stable` to the tagged commit.
   - Publishes a GitHub Release with auto-generated, label-grouped notes.

Stable instances pick up the release the next time a user clicks **Check for
Updates** → **Update Now** in Settings → Advanced → Software Updates.

> The manual alternative (hand-edit `package.json`, commit, tag) still works,
> but `version-guard` will reject the release if the version and tag disagree —
> so `npm run release` is the supported path.

## Release candidates (prereleases)

To validate a build before promoting it to all stable users, cut a prerelease.
Any tag with a semver prerelease suffix (`vX.Y.Z-rc.N`) is treated specially:

```sh
npm run release -- 0.2.0-rc.1
git push origin HEAD
git push origin v0.2.0-rc.1
```

The release workflow publishes it as a **GitHub prerelease** and **skips the
`stable` fast-forward**, so `origin/stable` (and therefore the stable channel)
never moves. Testers can point at the specific tag; when it looks good, cut the
final `v0.2.0` the normal way.

## Patch / hotfix releases

A conservative `stable` channel can lag a critical fix. To get one to stable
users fast, cut a patch release:

1. Land the fix on `main` (or cherry-pick it onto a release commit).
2. Cut the patch the same way: `npm run release -- 0.2.1`, then push `HEAD` and
   the `v0.2.1` tag.

Because `stable` only ever fast-forwards, the patch commit must be an ancestor
chain ahead of the current `stable` commit (i.e. cut from `main` at or after the
current stable point).

## Bootstrapping the first stable release

The `stable` branch does not exist until the first release is cut. Until then:

- `setup.sh` falls back to `main` for new installs (it checks `ls-remote` for
  `stable` and degrades gracefully).
- The updater's `stable` channel resolves to `origin/stable`, which won't exist
  yet — cut `v0.1.0` before advertising the stable channel.

Cut the first release with the normal flow above; the `release.yml` `promote`
job creates `refs/heads/stable` on the first fast-forward push.

## Versioning notes

- `package.json` `version` is the human-facing version. Bump it with
  `npm run release -- <version>`, never by hand — the `version-guard` job
  enforces that it equals the tag.
- The running instance's version is resolved at runtime via `git describe
  --tags --exact-match` against the host repo (`resolveVersion()` in
  `src/server/orchestrator/build-id.ts`): a tag → `vX.Y.Z`, otherwise
  `main @ <short-sha>`.
- The Android wrapper's version (`versionCode` / `versionName`) is **not** yet
  synced by `npm run release` — that work is tracked separately (SHI-66).
