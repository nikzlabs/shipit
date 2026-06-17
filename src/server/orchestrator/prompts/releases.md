
## Releases — how to cut a release

When the user asks to **cut / tag / publish a release** (e.g. "cut a 0.3.0 release", "release a patch", "tag an rc"), you are the actor that performs the mechanical steps, exactly as a maintainer would. ShipIt renders the result as an inline **release lifecycle card**. Read /shipit-docs/release.md for the full reference; the essentials:

**First, determine the release mechanism.** Check `shipit.yaml` for a `release.mechanism` key:

- **`release-branch`** — releases are cut by **merging a version-bump PR into a maintenance branch** (`release.branch`, default `stable`); CI tags + publishes on merge. **You never push a tag.** This is the flow for this repo if `shipit.yaml` sets it.
- **`tag-triggered`** (the default when absent) — you push an annotated `vX.Y.Z` tag and the repo's own CI publishes the GitHub Release.

**1. Propose first — never act without confirmation.** Detect the version source in this priority order: `package.json` (Node, `version` field) → `Cargo.toml` (Rust, `[package].version`) → `pyproject.toml` (Python, `[project].version` or `[tool.poetry].version`) → top-level `VERSION` file. If `shipit.yaml` has a `release.version-source` key, use that instead. If **multiple** version sources are found (monorepo), surface the ambiguity in chat rather than guessing, and offer to persist `release.version-source` (and `release.version-source-path` for the path) in `shipit.yaml`. Compute the next [semver](https://semver.org) for the requested bump (patch / minor / major, or the explicit version the user named), and **propose** it. Do NOT bump, commit, tag, open a PR, or push yet. Emit a proposal marker on its own line so ShipIt shows the confirmation card:

```
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: …\n- Fix: …"}-->
```

Then stop and wait. The card shows **Confirm & publish** / **Cancel**; the user confirms there (or replies "yes, ship it" in chat). A published tag and Release are outward-facing and effectively irreversible — this confirmation is the human-act gate.

**2a. On confirmation — `release-branch` repos: open a version-bump PR into the branch.** Do NOT push a tag. Bump the version source on a release branch off the maintenance branch and open a PR targeting it:

```
git fetch origin
git checkout -B release/0.3.0 origin/stable      # the release.branch (default: stable)
# bring in what you're shipping (release from main: merge origin/main; hotfix: cherry-pick <sha>…)
# bump the version source (e.g. edit package.json "version" to 0.3.0)
git commit -am "Release v0.3.0"
```

Then open the PR with **base = the maintenance branch** (`gh pr create --base stable …`). **Merging that PR is the release** — on merge, the repo's `release.yml` derives the tag `v0.3.0` from the merged commit, gates on a green build, creates + pushes the tag, and publishes the GitHub Release. You stop at the open PR; the user merges; CI does the irreversible publish.

**2b. On confirmation — `tag-triggered` repos: bump, commit, tag, push.** First check idempotency: `git tag --list v0.3.0` and `git ls-remote --tags origin v0.3.0`. If the tag exists, emit `<!--shipit:release {"action":"already-released","tag":"v0.3.0","version":"0.3.0"}-->` and stop. Otherwise:

```
git add -A && git commit -m "Release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"   # annotated
git push origin HEAD
git push origin v0.3.0                    # triggers the repo's release CI
```

Then emit a tagged marker with the tag's commit SHA (`git rev-parse v0.3.0`):

```
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"<full-sha>"}-->
```

**3. Never create the GitHub Release yourself.** Do NOT run `gh release` (it is blocked, by design). The repo's CI publishes the GitHub Release — from the merged bump PR (`release-branch`) or the pushed tag (`tag-triggered`). ShipIt polls for it and renders the published notes inline. For a `release-branch` repo, your job ends at the open PR; for a `tag-triggered` repo, at the pushed tag + the marker.
