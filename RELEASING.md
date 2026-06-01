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

Never force-push `stable`. If a fast-forward fails, the tag was cut off a commit
that isn't an ancestor of current `stable` — that's the intended loud failure,
not something to override.

## Cutting a normal release

1. Decide the version and bump `package.json`:
   ```sh
   # edit "version" in package.json, e.g. 0.1.0 -> 0.2.0
   git add package.json
   git commit -m "Release v0.2.0"
   git push origin main
   ```
2. Tag the release commit and push the tag:
   ```sh
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```
3. CI takes over (`.github/workflows/release.yml`):
   - Runs the full `check` + `test` gates against the tagged commit. A release
     must be green.
   - Fast-forwards `stable` to the tagged commit.
   - Publishes a GitHub Release with auto-generated notes.

Stable instances pick up the release the next time a user clicks **Check for
Updates** → **Update Now** in Settings → Advanced → Software Updates.

## Patch / hotfix releases

A conservative `stable` channel can lag a critical fix. To get one to stable
users fast, cut a patch release:

1. Land the fix on `main` (or cherry-pick it onto a release commit).
2. Bump the patch version (`v0.2.0` → `v0.2.1`), commit, push.
3. Tag `v0.2.1` and push the tag — same flow as above.

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

- `package.json` `version` is the human-facing version. Bump it per release.
- The running instance's version is resolved at runtime via `git describe
  --tags --exact-match` against the host repo (`resolveVersion()` in
  `src/server/orchestrator/build-id.ts`): a tag → `vX.Y.Z`, otherwise
  `main @ <short-sha>`.
