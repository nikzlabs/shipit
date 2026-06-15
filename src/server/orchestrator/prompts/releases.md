
## Releases — how to cut a release

When the user asks to **cut / tag / publish a release** (e.g. "cut a 0.3.0 release", "release a patch", "tag an rc"), you are the actor that performs the mechanical steps, exactly as a maintainer would in a terminal. ShipIt renders the result as an inline **release lifecycle card**. Read /shipit-docs/release.md for the full reference; the essentials:

**1. Propose first — never tag without confirmation.** Detect the version source in this priority order: `package.json` (Node, `version` field) → `Cargo.toml` (Rust, `[package].version`) → `pyproject.toml` (Python, `[project].version` or `[tool.poetry].version`) → top-level `VERSION` file. If `shipit.yaml` has a `release.version-source` key, use that instead. If **multiple** version sources are found (monorepo), surface the ambiguity in chat rather than guessing, and offer to persist the resolved `release.version-source` in `shipit.yaml`. Compute the next [semver](https://semver.org) for the requested bump (patch / minor / major, or the explicit version the user named), and **propose** it. Do NOT bump, commit, tag, or push yet. Emit a proposal marker on its own line so ShipIt shows the confirmation card:

```
<!--shipit:release {"action":"propose","version":"0.3.0","bumpType":"minor","tag":"v0.3.0","prerelease":false,"notes":"- Feature: …\n- Fix: …"}-->
```

Then stop and wait. The card shows **Confirm & publish** / **Cancel**; the user confirms there (or replies "yes, ship it" in chat). A published tag and Release are outward-facing and effectively irreversible — this confirmation is the human-act gate.

**2. Check idempotency before tagging.** Before doing anything, check whether the tag already exists locally **and** on the remote: `git tag --list v0.3.0` and `git ls-remote --tags origin v0.3.0`. If it already exists, do NOT create a duplicate — emit `<!--shipit:release {"action":"already-released","tag":"v0.3.0","version":"0.3.0"}-->` and stop.

**3. On confirmation, perform the release.** This is the ONE sanctioned exception to "don't run git yourself": bump the version source, commit it, create an **annotated** tag, and push the branch **and** the tag:

```
git add -A && git commit -m "Release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"
git push origin HEAD
git push origin v0.3.0
```

Then emit a tagged marker with the tag's commit SHA (`git rev-parse v0.3.0`):

```
<!--shipit:release {"action":"tagged","tag":"v0.3.0","version":"0.3.0","sha":"<full-sha>"}-->
```

**4. Never create the GitHub Release yourself.** Do NOT run `gh release` (it is blocked, by design). The repo's own tag-triggered CI workflow publishes the GitHub Release from the tag you pushed; ShipIt polls for it and renders the published notes inline. Your job ends at the pushed tag + the marker.
