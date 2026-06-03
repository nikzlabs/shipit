# Cutting a release

ShipIt lets you cut a versioned release of the current repo **from chat**. You
(the agent) perform the mechanical steps a maintainer would run in a terminal;
ShipIt renders the result as an inline **release lifecycle card** and tracks the
gate/CI status and the published GitHub Release without anyone leaving ShipIt.

This is the Phase 1 (MVP) flow: a Node repo with a `package.json` version and a
tag-triggered release workflow. The release is **tag-triggered** — you push an
annotated tag and the repo's own CI publishes the GitHub Release.

## The flow

### 1. Propose — never tag without confirmation

When the user asks to cut/tag/publish a release:

1. Read the version source. For a Node repo that's the `version` field in
   `package.json`.
2. Compute the next [semver](https://semver.org) for the requested bump:
   - `patch` → `0.3.0` → `0.3.1`
   - `minor` → `0.3.1` → `0.4.0`
   - `major` → `0.4.0` → `1.0.0`
   - or the explicit version the user named.
3. Derive the tag: `v{version}` (e.g. `v0.3.0`).
4. Draft a short notes preview (a few bullet points of what's in the release).
5. **Emit a proposal marker** on its own line, then stop and wait:

```
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: …\n- Fix: …"}-->
```

ShipIt shows a **release lifecycle card** with **Confirm & publish** / **Cancel**.
The user confirms there, or replies "yes, ship it" in chat. **Do not bump,
commit, tag, or push in the proposal turn.** A published tag and Release are
outward-facing and effectively irreversible; the confirmation is the human-act
gate.

### 2. Idempotency — check before you tag

Before creating anything, check whether the tag already exists, both locally and
on the remote:

```
git tag --list v0.3.0
git ls-remote --tags origin v0.3.0
```

If it already exists, **do not** create a duplicate. Emit:

```
<!--shipit:release {"action":"already-released","tag":"v0.3.0","version":"0.3.0"}-->
```

and stop — the card will show the existing release.

### 3. On confirmation — bump, commit, tag, push

This is the **one** sanctioned exception to "don't run git yourself" (normally
ShipIt auto-commits and auto-pushes for you). For a confirmed release you take
explicit control so the tag points at exactly the right commit:

```
# bump the version source (e.g. edit package.json "version" to 0.3.0)
git add -A && git commit -m "Release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin HEAD          # push the branch (the bump commit)
git push origin v0.3.0        # push the tag — this triggers the repo's release CI
```

Use an **annotated** tag (`git tag -a`), not a lightweight one — the annotation
is the canonical release artifact.

Then emit a tagged marker including the tag's commit SHA:

```
# sha=$(git rev-parse v0.3.0)
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"<full-sha>"}-->
```

ShipIt moves the card to **gating** and polls the gate/CI for that commit and the
published Release for the tag, rendering both inline.

### 4. Do not create the GitHub Release yourself

Never run `gh release` — it is blocked by the `gh` shim by design, because
publishing a Release is a deliberate, human-confirmed act. The repo's own
tag-triggered workflow (`on: push: tags: ['v*']`) runs its gate and publishes the
GitHub Release with `gh release create`. Your job ends at the pushed tag plus the
marker; ShipIt surfaces the published notes on the card when CI finishes.

## Prereleases

For a release candidate, set `"prerelease": true` and use a tag like
`v0.3.0-rc.1`. Prereleases are flagged on the card.

## Marker reference

All markers are single-line HTML comments with a JSON payload. They are invisible
in the rendered chat — they exist only to drive the card.

| Marker | When | Effect |
|---|---|---|
| `{"action":"propose", …}` | After computing the next version | Card → **proposed** (Confirm/Cancel) |
| `{"action":"tagged","tag":…,"sha":…}` | After pushing the tag | Card → **gating**, polling starts |
| `{"action":"already-released","tag":…}` | Tag already exists | Card → "already released" |
| `{"action":"cancelled"}` | User cancelled | Card dismissed |

## Out of scope (Phase 1)

- Non-Node version sources (`Cargo.toml`, `pyproject.toml`, `VERSION`, tag-only),
  the `release:` block in `shipit.yaml`, and monorepo disambiguation.
- Scaffolding a release workflow for a repo that has none.
- Orchestrator-brokered Release creation (ShipIt calling the GitHub Releases API).
- Channel promotion (stable/edge).

These are later phases — for now, the repo needs an existing tag-triggered release
workflow for the GitHub Release to appear.
