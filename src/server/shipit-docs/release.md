# Cutting a release

ShipIt lets you cut a versioned release of the current repo **from chat**. You
(the agent) perform the mechanical steps a maintainer would run; ShipIt renders
the result as an inline **release lifecycle card** and tracks the gate/CI status
and the published GitHub Release without anyone leaving ShipIt.

## Two mechanisms

How a repo publishes is set by `release.mechanism` in `shipit.yaml`:

- **`release-branch`** (docs/214) — a release is cut by **merging a version-bump
  PR into a long-lived maintenance branch** (`release.branch`, default `stable`).
  On merge, the repo's CI derives the tag from the version source on the merged
  commit, gates on a green build, **creates and pushes the tag itself**, and
  publishes the GitHub Release. **The agent never pushes a tag** — merging the PR
  is the human-act gate, CI does the irreversible publish.
- **`tag-triggered`** (the default when `release.mechanism` is absent) — the
  agent pushes an annotated `vX.Y.Z` tag and the repo's own
  `on: push: tags: ['v*']` workflow publishes the GitHub Release.

Determine the mechanism **before** proposing. The flows share step 1 (propose)
and step 4 (CI publishes, never the agent), and differ only in step 3.

## Use the `shipit release` command (don't hand-run the mechanics)

ShipIt provides a deterministic `shipit release` command that performs the
version detection, bump, branch, cherry-pick, and PR for you — so you never
hand-edit a version file or run `git tag`. **Prefer it over the manual git steps
below** (those are kept only to explain what the command does and as a fallback):

- `shipit release plan [<patch|minor|major|VERSION>] [--prerelease] [--version-source-path FILE] [--json]`
  — **read-only**: detect the version source and compute the next version. Run
  this in the propose step (it reflects a `proposed` card); then stop for confirm.
- `shipit release prepare [<bump|VERSION>] [--pick SHA]… [--from BRANCH] [--release-branch NAME] [--bootstrap] [--allow-empty] [--notes TEXT] [--prerelease [--confirm]] [--version-source-path FILE] [--json]`
  — on confirmation, do the release mechanics:
  - **`release-branch` final release:** opens (or updates) a version-bump PR
    against the release branch. `--pick <sha>` cherry-picks a hotfix; `--from <branch>`
    brings a branch's content; `--bootstrap` creates the release branch on the
    first release. **Merging the PR is the release** — CI tags + publishes. You
    stop at the open PR.
    - **Content-free guard:** a bare `prepare` with no `--pick`/`--from` brings no
      new commits over the release branch, so it would ship only the version bump —
      a release identical to the previous one. This is **refused** with an error
      naming the fix: pass `--from <branch>` (e.g. `--from main`) to bring content,
      or `--allow-empty` to cut a bump-only release on purpose. (`--bootstrap`
      implies this — the first release legitimately ships everything on the new
      branch.)

    **Cold-start caveat — the merge-trigger workflow must be on the branch.**
    GitHub Actions evaluates a workflow as it exists *on the branch that was
    pushed*. Merge-publish only fires once the maintenance branch carries the
    merge-triggered `release.yml` (`on: push: { branches: [<branch>] }`). If the
    branch has **no** workflow or still has the **legacy tag-triggered** one
    (`on: push: { tags: ['v*'] }`), merging the bump PR matches no trigger and
    runs **nothing** — the PR merges cleanly but **no tag, no Release**. `plan`
    and `prepare` detect this and print a **⚠ warning** when it applies — if you
    see it, **relay it to the user and do not present the merge as the release**.
    The one-time fix: bootstrap the branch by cutting the first release via the
    **tag path** (push a `vX.Y.Z` tag on a commit that already carries the
    merge-trigger workflow), or `--bootstrap` when the branch doesn't exist yet.
    After that the workflow is on the branch and every future merge auto-publishes.
  - **prerelease (rc):** `shipit release prepare --prerelease` proposes the rc;
    re-run with `--confirm` to cut + push the `vX.Y.Z-rc.N` tag (a tag push is
    always confirmation-gated). CI publishes it as a GitHub prerelease.

There is intentionally **no** `shipit release tag`/`publish`/`push` — publishing
is CI's job. The manual git in §3 below is the same thing done by hand; reach for
it only if the command is unavailable.

## The flow

### 1. Propose — never act without confirmation

When the user asks to cut/tag/publish a release:

1. Read the version source. ShipIt auto-detects the ecosystem in this priority order:
   - `package.json` (Node) — the `version` field
   - `Cargo.toml` (Rust) — `[package].version`
   - `pyproject.toml` (Python) — `[project].version` or `[tool.poetry].version`
   - `VERSION` (any) — plain semver string, first line
   - Tag-only — no version file; next version inferred from the latest `v*` git tag

   If `shipit.yaml` has a `release.version-source` key, use that instead of
   auto-detecting. For a monorepo where the version file isn't at the root,
   `release.version-source-path` says *where* it is (e.g.
   `packages/api/package.json`) while `release.version-source` says how to parse
   it. If **multiple** version sources are found, ask the user which one to
   release before proposing, and offer to persist the answer in `shipit.yaml`.
2. Compute the next [semver](https://semver.org) for the requested bump
   (`patch`/`minor`/`major`, or the explicit version the user named).
3. Derive the tag: `v{version}` (e.g. `v0.3.0`).
4. Draft a short notes preview.
5. **Emit a proposal marker** on its own line, then stop and wait:

```
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: …\n- Fix: …"}-->
```

ShipIt shows a **release lifecycle card** with **Confirm & publish** / **Cancel**.
The user confirms there, or replies "yes, ship it" in chat. **Do not bump,
commit, tag, open a PR, or push in the proposal turn.**

### 2. Idempotency — check before you act

- **`release-branch`:** check whether the version's tag already exists
  (`git ls-remote --tags origin v0.3.0`). If it does, the release already
  shipped — emit `already-released` and stop. Otherwise check whether an open
  release PR already exists for this version before opening a second one.
- **`tag-triggered`:** check both locally and on the remote:
  ```
  git tag --list v0.3.0
  git ls-remote --tags origin v0.3.0
  ```
  If it exists, emit and stop:
  ```
  <!--shipit:release {"action":"already-released","tag":"v0.3.0","version":"0.3.0"}-->
  ```

### 3a. `release-branch` — open a version-bump PR into the branch

Run **`shipit release prepare <bump> [--pick <sha>…] [--from <branch>] [--bootstrap]`** —
it creates the `release/<version>` branch off the maintenance branch, brings in
the work, bumps the version source, and opens (or updates) the PR. You do **not**
push a tag. The equivalent by hand, if the command is unavailable:

```
git fetch origin
git checkout -B release/0.3.0 origin/stable     # release.branch (default: stable)
# bring in what you're shipping:
#   release from main → git merge --no-ff origin/main
#   hotfix            → git cherry-pick <sha-from-main> [<sha> …]
# bump the version source (e.g. edit package.json "version" to 0.3.0)
git commit -am "Release v0.3.0"
```

Open the PR with **base = the maintenance branch**:

```
gh pr create --base stable -t "Release v0.3.0" --body-file - <<'EOF'
Release v0.3.0 — merge to tag + publish.
EOF
```

**Merging that PR is the release.** On merge, `release.yml` derives `v0.3.0`
from the merged commit's version source, gates on a green build, creates +
pushes the tag, and publishes the GitHub Release. Your job ends at the open PR;
the user merges; CI does the rest.

> The steps above are exactly what `shipit release prepare` runs for you — prefer
> the command; this manual sequence is the fallback.

### 3b. `tag-triggered` — bump, commit, tag, push

This is the **one** sanctioned exception to "don't run git yourself". For a
confirmed release you take explicit control so the tag points at exactly the
right commit:

```
# bump the version source (e.g. edit package.json "version" to 0.3.0)
git add -A && git commit -m "Release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"   # annotated, not lightweight
git push origin HEAD          # the bump commit
git push origin v0.3.0        # the tag — triggers the repo's release CI
```

Then emit a tagged marker including the tag's commit SHA:

```
# sha=$(git rev-parse v0.3.0)
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"<full-sha>"}-->
```

### 4. Do not create the GitHub Release yourself

Never run `gh release` — it is blocked by the `gh` shim by design. The repo's own
CI publishes the GitHub Release: from the **merged bump PR** (`release-branch`)
or the **pushed tag** (`tag-triggered`). Your job ends at the open PR or the
pushed tag + marker; ShipIt surfaces the published notes on the card when CI
finishes.

## Prereleases (release candidates)

rc's do **not** go through the maintenance branch (they must not advance the
stable line). For a `release-branch` repo, cut an rc with
**`shipit release prepare --prerelease`** (then re-run with `--confirm` to push
the `vX.Y.Z-rc.N` tag — a tag push is always confirmation-gated); CI publishes it
as a GitHub *prerelease*. The by-hand equivalent is pushing a `vX.Y.Z-rc.N` tag
with `"prerelease": true` in the marker. For a `tag-triggered` repo, set
`"prerelease": true` and use a `vX.Y.Z-rc.N` tag the same way.

## Marker reference

All markers are single-line HTML comments with a JSON payload, invisible in the
rendered chat — they drive the card.

| Marker | When | Effect |
|---|---|---|
| `{"action":"propose", …}` | After computing the next version | Card → **proposed** (Confirm/Cancel) |
| `{"action":"tagged","tag":…,"sha":…}` | After pushing the tag (tag-triggered) | Card → **gating**, polling starts |
| `{"action":"already-released","tag":…}` | Tag already exists | Card → "already released" |
| `{"action":"cancelled"}` | User cancelled | Card dismissed |

## Per-repo configuration (shipit.yaml)

```yaml
release:
  mechanism: release-branch      # tag-triggered (default) | release-branch | brokered
  branch: stable                 # maintenance branch for release-branch; default: stable
  version-source: package.json   # package.json | Cargo.toml | pyproject.toml | VERSION | tag
  version-source-path: packages/api/package.json  # monorepo: where the version file lives
  tag-pattern: "v{version}"      # must contain {version}; default: "v{version}"
  prerelease-pattern: "v{version}-rc.{n}"  # {n} auto-increments; default shown
  notes: github-generated        # github-generated | commits | changelog:CHANGELOG.md
  gate: "npm test"               # optional: local command the agent runs before tagging
  workflow: .github/workflows/release.yml  # path used for existence checks / scaffolding
```

All fields are optional. `release-branch` requires a file-backed `version-source`
(not `tag`) — a branch push has no tag to read the version from.

## Monorepo disambiguation

When multiple version files are detected, do **not** guess. Surface the ambiguity:

> "I see `packages/app/package.json` (1.2.3) and `packages/lib/package.json` (0.9.0)
>  — which one are we releasing, or is this a coordinated bump?"

On resolution, offer to write the `release:` block (`version-source` +
`version-source-path`) in `shipit.yaml` so the next release skips the question.

## Scaffold a release workflow

If the repo has **no release workflow**, you can scaffold one and open a PR — CI
still does the publish, so the repo gets the same hands-off auto-publish flow
without anyone leaving ShipIt. Use this when the user asks to "set up releases",
or when a release request hits a repo whose `.github/workflows/release.yml` (or
the path in `release.workflow`) is absent.

### Detect → offer → write → PR

1. **Detect.** Check whether a release workflow already exists at
   `.github/workflows/release.yml` (or `release.workflow` from `shipit.yaml`). If
   one is present, don't scaffold — use the normal release flow above.
2. **Offer.** Tell the user you can scaffold a merge-triggered auto-publish
   workflow, and confirm the parameters before writing:
   - **version source** — auto-detect (`package.json` / `Cargo.toml` /
     `pyproject.toml` / `VERSION`). A `release-branch` workflow needs an
     authoritative *file* version source; a tag-only repo can't use it (a branch
     push has no version to read). If multiple version files are detected
     (monorepo), ask which one — don't guess.
   - **release branch** — the long-lived maintenance branch a release is cut by
     merging into (default `stable`).
   - **gate** (optional) — a command to run before tag + publish (e.g.
     `npm test`).
   - **prerelease** — whether to also accept `vX.Y.Z-rc.N` tags for release
     candidates.
3. **Write** these three files into the workspace:
   - `.github/workflows/release.yml` — the auto-publish workflow (one workflow,
     gates + tags + publishes in the same run).
   - `.github/release.yml` — the categorized release-notes config.
   - `.github/scripts/shipit-read-version.mjs` — a tiny Node helper the workflow
     runs (via `setup-node`, even in non-Node repos) to read the version. It
     uses the **same logic** ShipIt uses to bump the version, so the tag CI
     creates can never silently disagree with the version source.
4. **Open a PR** via the normal auto-PR flow (you don't push the workflow to the
   default branch directly — it lands as a reviewable PR like any other change).

### How the scaffolded workflow publishes

A release is cut by **merging a version-bump PR into the release branch**. On
that merge the workflow reads HEAD's version, tags the commit, and publishes the
GitHub Release in the same run — it never *moves* the release branch. The agent
never pushes a tag for a final release; **merging the PR is the human-act gate**,
and CI does the irreversible publish. (When prereleases are enabled, an
`vX.Y.Z-rc.N` tag pushed directly is published as a GitHub prerelease via the
workflow's tag path.)

## Still unsupported (future phases)

- Orchestrator-brokered Release creation via the GitHub Releases API.
- Channel promotion (stable/edge) for arbitrary repos.
