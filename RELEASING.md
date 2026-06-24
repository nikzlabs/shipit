# Releasing ShipIt

ShipIt ships in two **release channels** (see `docs/162-release-channels/plan.md`):

| Channel  | Tracks                                              | Audience                        |
|----------|----------------------------------------------------|---------------------------------|
| `stable` | latest final tag reachable from `origin/stable`    | default; conservative operators |
| `edge`   | `origin/main`                                       | early adopters, contributors    |

`edge` always tracks `main` — nothing to do. This document is about cutting a
**stable** release.

## Release model (merge-triggered, auto-published)

ShipIt's own repo uses the **`release-branch`** mechanism (`shipit.yaml`
`release:` block, docs/214). A release is cut by **merging a version-bump PR into
`stable`** — CI does the rest. No hand-pushed tags, no `npm run release` push.

- **`stable` is a long-lived maintenance branch** — not a pointer CI drags behind
  `main`. It carries its own curated history: the released code, plus any fixes
  **cherry-picked** onto it.
- **A release is a merge into `stable`.** When a version-bump PR merges,
  `.github/workflows/release.yml` runs on the `stable` push: it derives the tag
  `v<package.json version>` from the merged commit, gates on a green build
  (`check` + `test`), **creates and pushes the annotated tag itself** on the
  merged commit, and publishes the GitHub Release with auto-generated notes.
- **CI does not move `stable`** — the merge already advanced it. CI only reads
  HEAD's version, tags that commit, and publishes.
- **The stable channel follows the latest final tag, not the branch tip**
  (docs/214 Option A). The updater resolves the highest final (non-prerelease)
  tag reachable from `origin/stable` and resets to *its commit* — so the
  merge-before-publish window (and any failed publish) is invisible to stable
  users; they only ever land on a vetted, published release. If no final tag is
  reachable yet, the channel reports "no stable release yet" and refuses to
  update (it never falls back to the un-tagged branch tip).
- A **GitHub Release** hangs auto-generated notes (PR titles since the previous
  tag) off each tag. Those notes are the changelog ShipIt surfaces inline in the
  update panel.

Because `stable` is a real branch, **`main` and `stable` intentionally
diverge**: `main` (edge) carries everything; `stable` carries only what's been
vetted onto it. The flip side is **forward-port discipline** — a fix you
cherry-pick onto `stable` should already exist on `main` (or land there too), so
the next minor doesn't regress it.

## The publish workflow — one workflow, two triggers

`.github/workflows/release.yml` triggers on **`push: { branches: [stable],
tags: ['v*'] }`** and self-publishes (a tag pushed by CI's own `GITHUB_TOKEN`
would not re-trigger an `on: push: tags` workflow, so the branch path must gate,
tag, *and* publish in one run):

- A **`resolve`** job classifies the trigger:
  - **branch path** (`stable` push): `tag = v<package.json version>`. Tag absent →
    new release. Tag exists but its Release is missing → **repair** (a prior run
    pushed the tag but `gh release create` failed). Tag + Release present → no-op.
    A `-rc.N` version on `stable` is **rejected** (rc's use the tag path).
  - **tag path** (a pushed `v*` tag): gate + publish that tag; never create one.
- **`version-guard`** runs on the **tag path only** — it checks `package.json`
  equals the tag. On the branch path the tag is *derived from* `package.json`, so
  they can't drift and the guard is skipped.
- **`check`** + **`test`** reuse `ci.yml`'s gates — a release must be green.
- **`publish`** (serialized per tag via `concurrency`): on green, on the branch
  path it creates the annotated tag on the merged commit and pushes it; then it
  checks **Release** existence (`gh release view`) and, if missing,
  `gh release create --generate-notes --verify-tag` (`--prerelease` for `-rc.N`).

CI on PRs into `stable` (`ci.yml` now triggers on PRs into `main` **and**
`stable`) gives reviewers a green check before merge — a recommended quality gate,
but no longer load-bearing for safety (tag-resolution owns that).

## Labels

The auto-generated GitHub Release notes are **grouped into sections by PR label**
(`.github/release.yml`):

| Section | Labels |
|---|---|
| 🚀 Features | `feature`, `enhancement` |
| 🐛 Fixes | `bug`, `fix` |
| 📝 Documentation | `documentation`, `docs` |
| ⬆️ Dependencies | `dependencies` |
| 🧰 Maintenance | `chore`, `refactor`, `ci`, `test` |
| Other Changes | everything else (`*`) |

PRs labeled `ignore-for-release` are excluded; an unlabeled PR lands in **Other
Changes**. `.github/labels.yml` is the source of truth for the label set, and the
auto-labeler applies best-effort labels by changed-file path — hand-label
anything the path rules miss so it lands in the right release-notes section.

## Cutting a normal release

The supported, hands-off path is **chat-driven**: in a ShipIt session on this
repo, ask the agent to cut the release. It opens a version-bump PR into `stable`;
you review and merge it; CI tags and publishes. Under the hood the agent runs
`shipit release prepare <bump> --from main`, which takes `main`'s tree **wholesale**
(`git.mergeOverride` — a 2-parent merge commit whose tree equals `main`, kept a
descendant of `stable`), so the release ships exactly `main`'s content at the new
version and **never** stops on a merge conflict — even when `stable` carries a
divergent hotfix. (Stable's hotfixes are expected to be forward-ported to `main`
anyway, so `main` is the source of truth.) The manual steps below use a plain
`git merge`, which **can** conflict and is the hand-operator's to resolve; the
chat-driven path is conflict-proof:

1. Create a release branch off `stable` and bring in what you're shipping:
   ```sh
   git fetch origin
   git checkout -B release/0.3.0 origin/stable
   # a whole batch of new work from main:
   git merge --no-ff origin/main
   # …or specific fixes only (the conservative path):
   git cherry-pick <sha-from-main> [<sha> …]
   ```
2. Bump the version source:
   ```sh
   # edit package.json "version" to 0.3.0 (and refresh package-lock.json)
   git commit -am "Release v0.3.0"
   ```
   `npm run release -- 0.3.0` (`scripts/release.ts`) still works as a local
   convenience to rewrite `package.json` + `package-lock.json` and commit — but
   **do not push a tag**; the version bump is all you need on the branch.
3. Open a PR with **base `stable`** and merge it once green:
   ```sh
   git push -u origin release/0.3.0
   gh pr create --base stable -t "Release v0.3.0" --label feature
   ```
4. **Merge the PR.** That's the release — `release.yml` runs on the `stable`
   push, gates, tags `v0.3.0` on the merged commit, and publishes the GitHub
   Release. Nothing else to push.

Stable instances pick up the release the next time a user clicks **Check for
Updates** → **Update Now** (the updater resets to the latest final tag reachable
from `origin/stable`).

### `main`'s version is auto-synced after publish

The version bump lands only on `stable` (the `release/<version>` PR is never
merged back to `main`), so `main`'s `package.json` would otherwise stay behind
every release. After a successful publish on the branch path, `release.yml`'s
**`sync-main`** job opens a small chore PR (`release-sync/vX.Y.Z` → `main`) that
bumps `main`'s `package.json` + `package-lock.json` to the just-released version.
Merge it to bring `main` in sync — it touches only the version files. The PR is
labeled `ignore-for-release` so it doesn't clutter the next release's notes, and
the job is idempotent (no-op when `main` already carries the version, or when the
sync branch already exists). rc's (the tag path) never touch `main`.

## Release candidates (prereleases)

rc's do **not** go through `stable` (they must not advance the stable channel, and
the channel ignores `-rc.N` tags anyway). Cut an rc via the **tag path** — push a
`vX.Y.Z-rc.N` tag directly:

```sh
git tag -a v0.3.0-rc.1 -m "Release v0.3.0-rc.1" <commit>
git push origin v0.3.0-rc.1
```

The release workflow's tag path publishes it as a **GitHub prerelease**. Testers
point at the specific tag. When it looks good, fold the work into a `stable` bump
PR and cut the final `v0.3.0` the normal (merge-triggered) way.

## Patch / hotfix releases

A conservative `stable` channel can lag a critical fix. Ship **only** the fix:

1. Land the fix on `main` as usual (so it's forward-ported).
2. Open a release branch off `stable`, cherry-pick just that commit, bump, and PR:
   ```sh
   git checkout -B release/0.2.1 origin/stable
   git cherry-pick <fix-sha-from-main>
   # bump package.json to 0.2.1
   git commit -am "Release v0.2.1"
   git push -u origin release/0.2.1
   gh pr create --base stable -t "Release v0.2.1" --label fix
   ```
3. Merge it — CI tags `v0.2.1` and publishes. A `0.2.1` carrying the fix and
   nothing else, even if dozens of features have merged to `main` since `0.2.0`.

## Bootstrapping the first stable release

`stable` does not exist until the first release. `setup.sh` falls back to `main`
for new installs until it does, and the stable channel reports "no stable release
yet" (it fails closed — never the branch tip) until a final tag is reachable.

Create `stable` off the release commit, bump, and push the branch — the push
triggers `release.yml`, which tags + publishes:

```sh
git checkout -b stable <release-commit>   # e.g. main at the release point
# bump package.json to 0.1.0
git commit -am "Release v0.1.0"
git push -u origin stable
```

From then on `stable` is a long-lived branch you open bump PRs against — CI never
recreates or moves it.

### Cold-start caveat: the merge-trigger workflow must already be on `stable`

**Merge-publish only works once `stable` carries the merge-triggered `release.yml`**
(`on: push: { branches: [stable] }`). GitHub Actions evaluates a workflow as it
exists *on the branch that was pushed*, so merging a bump PR into a `stable` that
still has the **legacy tag-triggered** workflow (`on: push: { tags: ['v*'] }`,
no `branches:` trigger) matches no trigger and runs **nothing** — the PR merges
cleanly but **no tag and no Release** are produced. This is a bootstrap deadlock:
the very commit that *adds* the merge-trigger workflow is unreleased on `main` and
only reaches `stable` by being released.

Break it with a **one-time tag-path release** on a `main` commit that already
carries the merge-triggered workflow (push a `vX.Y.Z` tag — CI evaluates the
workflow at the tagged commit and publishes). Once that workflow is on `stable`,
every subsequent merge auto-publishes and you never push a tag again.

`shipit release plan|prepare` checks the maintenance branch's workflow and
**warns** when a merge won't auto-publish yet, naming this remedy — so a normal
prepare never *looks* successful while the merge would silently no-op.

## Versioning notes

- `package.json` `version` is the human-facing version and the source CI derives
  the tag from. Bump it in the release PR; never push a `vX.Y.Z` tag by hand for a
  final release (CI owns that).
- The running instance's version is resolved at runtime against the host repo
  (`resolveVersion()` in `src/server/orchestrator/build-id.ts`): on `stable` the
  checkout sits on a release tag's commit, so `git describe --tags --exact-match`
  names it `vX.Y.Z`; otherwise `main @ <short-sha>`.
- The Android wrapper's version (`versionCode` / `versionName`) is **not** yet
  synced — tracked separately (SHI-66).
