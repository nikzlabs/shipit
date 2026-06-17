
## Releases — how to cut a release

When the user asks to **cut / tag / publish a release** (e.g. "cut a 0.3.0 release", "release a patch", "tag an rc"), you are the actor that performs the mechanical steps. **Prefer the deterministic `shipit release` command** — `shipit release plan <bump>` (read-only: detect version + compute next, for the propose step) and `shipit release prepare <bump> [--pick <sha>…] [--from <branch>] [--bootstrap] [--prerelease [--confirm]]` (does the bump / branch / cherry-pick / PR or rc tag) — rather than hand-running git. ShipIt renders the result as an inline **release lifecycle card**. Read /shipit-docs/release.md for the full reference; the essentials:

**First, determine the release mechanism.** Check `shipit.yaml` for a `release.mechanism` key:

- **`release-branch`** — releases are cut by **merging a version-bump PR into a maintenance branch** (`release.branch`, default `stable`); CI tags + publishes on merge. **You never push a tag.** This is the flow for this repo if `shipit.yaml` sets it.
- **`tag-triggered`** (the default when absent) — you push an annotated `vX.Y.Z` tag and the repo's own CI publishes the GitHub Release.

**1. Propose first — never act without confirmation.** Detect the version source in this priority order: `package.json` (Node, `version` field) → `Cargo.toml` (Rust, `[package].version`) → `pyproject.toml` (Python, `[project].version` or `[tool.poetry].version`) → top-level `VERSION` file. If `shipit.yaml` has a `release.version-source` key, use that instead. If **multiple** version sources are found (monorepo), surface the ambiguity in chat rather than guessing, and offer to persist `release.version-source` (and `release.version-source-path` for the path) in `shipit.yaml`. Compute the next [semver](https://semver.org) for the requested bump (patch / minor / major, or the explicit version the user named), and **propose** it. Do NOT bump, commit, tag, open a PR, or push yet. Emit a proposal marker on its own line so ShipIt shows the confirmation card:

```
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: …\n- Fix: …"}-->
```

Then stop and wait. The card shows **Confirm & publish** / **Cancel**; the user confirms there (or replies "yes, ship it" in chat). A published tag and Release are outward-facing and effectively irreversible — this confirmation is the human-act gate.

**2a. On confirmation — `release-branch` repos: open a version-bump PR into the branch.** Run **`shipit release prepare <bump> [--pick <sha>…] [--from <branch>] [--bootstrap]`** — it creates the `release/<version>` branch off the maintenance branch, brings in the work (`--pick` for a hotfix, `--from` to bring a branch's content, `--bootstrap` for the first release), bumps the version source, and opens (or updates) the PR with base = the maintenance branch. You do NOT push a tag. **Merging that PR is the release** — on merge the repo's `release.yml` derives the tag from the merged commit, gates on a green build, creates + pushes the tag, and publishes the GitHub Release. You stop at the open PR; the user merges; CI does the irreversible publish. (Equivalent by hand only if the command is unavailable: `git checkout -B release/0.3.0 origin/stable` → bring in the work → bump the version source → commit → `gh pr create --base stable …`.)

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
