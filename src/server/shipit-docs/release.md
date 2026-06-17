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

You do **not** push a tag. Bump the version source on a branch off the
maintenance branch and open a PR targeting it:

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

> A deterministic `shipit release` command that performs the bump / cherry-pick /
> PR mechanics for you is planned (docs/214 Phase 2). Until it lands, do the
> steps above by hand.

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
stable line). For a `release-branch` repo, an rc is cut via the **tag path**:
push a `vX.Y.Z-rc.N` tag (set `"prerelease": true` in the marker). The repo's CI
publishes it as a GitHub *prerelease*. (A deterministic, confirmation-gated
`shipit release prepare --prerelease` is planned — docs/214 Phase 2.) For a
`tag-triggered` repo, set `"prerelease": true` and use a `vX.Y.Z-rc.N` tag the
same way.

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

## Still unsupported (future phases)

- The deterministic `shipit release` command (docs/214 Phase 2).
- Scaffolding a release workflow for repos that have none (docs/214 Phase 3).
- Orchestrator-brokered Release creation via the GitHub Releases API.
