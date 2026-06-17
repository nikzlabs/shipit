# Releasing ShipIt

ShipIt ships in two **release channels** (see `docs/162-release-channels/plan.md`):

| Channel  | Tracks          | Audience                        |
|----------|-----------------|---------------------------------|
| `stable` | `origin/stable` | default; conservative operators |
| `edge`   | `origin/main`   | early adopters, contributors    |

`edge` always tracks `main` — nothing to do. This document is about cutting a
**stable** release.

## Release model

- **`stable` is a long-lived maintenance branch** — not a pointer CI drags
  behind `main`. It carries its own curated history: the released code, plus any
  fixes **cherry-picked** onto it. `origin/stable` is therefore "the latest
  stable release," queried with the same git machinery as `main`.
- **Releases are annotated tags** `vX.Y.Z` (semver) cut **from `stable`** (its
  HEAD). You bump + tag on `stable` and push the branch and the tag together, so
  the tag always sits on the stable commit.
- **CI does not move `stable`.** The release workflow only verifies the build is
  green and publishes the GitHub Release; advancing `stable` is a deliberate
  maintainer act (merge or cherry-pick from `main`, then bump + tag).
- A **GitHub Release** hangs auto-generated notes (PR titles since the previous
  tag) off each tag. Those notes are the changelog ShipIt surfaces inline in the
  update panel.
- The notes are **grouped into sections** (Features, Fixes, Docs, Dependencies,
  Maintenance) by PR label, configured in `.github/release.yml`. Label your PRs
  so they land in the right section — an unlabeled PR falls through to *Other
  Changes*, so nothing is dropped, but the notes read better when labeled.

Because `stable` is a real branch, **`main` and `stable` intentionally
diverge**: `main` (edge) carries everything; `stable` carries only what's been
vetted onto it. The flip side of that freedom is **forward-port discipline** — a
fix you cherry-pick onto `stable` should already exist on `main` (or land there
too), so the next minor doesn't regress it.

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

Releases are cut **from `stable` by a maintainer** with push access to it — not
through a ShipIt session/PR (those land on `main`). A release tag cut off any
branch other than `stable` puts the released code somewhere `stable` users never
receive it.

1. Get onto an up-to-date `stable` and bring in the changes you're shipping:
   ```sh
   git checkout stable && git pull origin stable
   # a whole batch of new work from main:
   git merge --no-ff origin/main
   # …or specific fixes only (the conservative path):
   git cherry-pick <sha-from-main> [<sha> …]
   ```
   Your squash-merge habit makes cherry-picking clean — each feature/fix is a
   single commit on `main`.
2. Bump the version and create the release commit + tag in one step:
   ```sh
   npm run release -- 0.2.1
   ```
   `npm run release` (`scripts/release.ts`) refuses to run on a dirty tree or a
   downgrade, rewrites `package.json` + `package-lock.json`, commits
   `Release v0.2.1`, and creates the annotated `v0.2.1` tag on `stable`'s HEAD.
   It does **not** push — pushing the tag is the deliberate act that triggers the
   release.
3. Push the branch and the tag:
   ```sh
   git push origin stable
   git push origin v0.2.1
   ```
4. CI takes over (`.github/workflows/release.yml`):
   - **`version-guard`** fails the release unless `package.json` version equals
     the tag (it always will when you use `npm run release`). This is the guard
     that keeps the human-facing version and the tag from drifting.
   - Runs the full `check` + `test` gates against the tagged commit. A release
     must be green.
   - Publishes a GitHub Release with auto-generated, label-grouped notes. **CI
     does not touch `stable`** — you already pushed it in step 3.

Stable instances pick up the release the next time a user clicks **Check for
Updates** → **Update Now** in Settings → Advanced → Software Updates (the updater
resets to `origin/stable`).

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

The release workflow publishes it as a **GitHub prerelease**. CI never moves
`stable` (for any release), so a prerelease leaves the stable channel untouched
by construction. Cut an rc off a release-candidate branch or off `stable` itself
without pushing `stable`; testers point at the specific tag. When it looks good,
fold the work into `stable` and cut the final `v0.2.0` the normal way.

## Patch / hotfix releases

A conservative `stable` channel can lag a critical fix. The maintenance-branch
model is built for exactly this — you ship **only** the fix, none of `main`'s
unrelated churn:

1. Land the fix on `main` as usual (so it's forward-ported).
2. Cherry-pick just that commit onto `stable`, then cut the patch:
   ```sh
   git checkout stable && git pull origin stable
   git cherry-pick <fix-sha-from-main>
   npm run release -- 0.2.1
   git push origin stable
   git push origin v0.2.1
   ```

This is the payoff for `stable` being a real branch: a `0.2.1` that carries the
security fix and nothing else, even if dozens of features have merged to `main`
since `0.2.0`.

## Bootstrapping the first stable release

The `stable` branch does not exist until the first release is cut. Until then:

- `setup.sh` falls back to `main` for new installs (it checks `ls-remote` for
  `stable` and degrades gracefully).
- The updater's `stable` channel resolves to `origin/stable`, which won't exist
  yet — cut `v0.1.0` before advertising the stable channel.

Create `stable` as a branch the first time, off the release commit, then cut the
release from it:

```sh
git checkout -b stable <release-commit>   # e.g. main at the point you're releasing
npm run release -- 0.2.0
git push -u origin stable
git push origin v0.2.0
```

From then on `stable` is a long-lived branch you cherry-pick onto and re-tag —
CI never recreates or moves it.

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
