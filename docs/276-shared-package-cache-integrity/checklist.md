# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). Requirement decisions are
recorded in [requirements.md](./requirements.md); none is open.

## H1 — per-session npm resolution cache (reqs 1, 3, 5, 6)

- [x] Spike: npm tolerates a private `_cacache/index-v5` with a symlinked shared
      `content-v2`. Offline install succeeds, the symlink survives, split is
      64 KB private / 688 KB shared, and a write to the shared `index-v5` no
      longer affects the victim.
- [ ] Measure warm-install time against req 7, and whether the symlinked
      `content-v2` survives `npm cache verify` and npm's own GC.
- [ ] Regression test: poisoned packument (`dist.integrity` **and**
      `hasInstallScript`) plus `npm install <new-package>` with a valid lockfile
      present must not run the attacker's `postinstall`. Cover the no-lockfile
      repo in the same test.
- [ ] Do not add lockfile pinning as a security measure; it covers only `npm ci`
      and an in-sync `npm install`.
- [ ] shipit-docs update if repos without a lockfile change behaviour.

## H3 — pnpm store (reqs 1, 4, 10, 11)

- [ ] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable.
- [ ] Set `verify-store-integrity=true` explicitly. ShipIt sets neither value
      today; `false` disables pnpm's content check completely.
- [ ] Decide whether the pnpm store moves inside the docs/183 overlay. As
      deployed it is a separate read-write bind at `/workspace/.pnpm-store`,
      outside any overlay, so overlayfs does not cover it and H3 survives there.
- [ ] Regression test for H3: a write to a store file must not change an
      already-installed `node_modules` file in another session.
- [ ] Regression test for req 11: an edit inside one session's installed
      packages must stay invisible to another session. A future return to
      hardlink sharing would silently break this.
- [ ] Detect reflink support on the state directory at startup and report it;
      never require it.
- [ ] Never `chown -R` through an overlay mount; act on the base or the upper.
- [ ] shipit-docs: describe store verification as pnpm's, and name
      `verify-store-integrity` as what it depends on.
- [x] Correct the "integrity-checked on link" claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md`.

## Sequencing guard (req 8)

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until the H1
      and H3 fixes land.

## Optional — per-repo pnpm store key

Not needed for any requirement. Only if cross-repo blast radius is wanted on its
own.

- [ ] Add the repo hash to `pnpmStoreDirForRuntime` and extend the disk-janitor
      sweep; measure the disk regression from losing cross-repo dedup first.
