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
- [ ] Confirm npm re-hashes shared `content-v2` on read with no verification-skip
      cache — the exact failure mode found in pnpm's store (H2/H4). If npm trusts
      a `checkedAt`-style marker, sharing `content-v2` reopens the hole and the
      H1 fix is incomplete.
- [ ] Regression test: poisoned packument (`dist.integrity` **and**
      `hasInstallScript`) plus `npm install <new-package>` with a valid lockfile
      present must not run the attacker's `postinstall`. Cover the no-lockfile
      repo in the same test.
- [ ] Do not add lockfile pinning as a security measure; it covers only `npm ci`
      and an in-sync `npm install`.
- [ ] shipit-docs update if repos without a lockfile change behaviour.

## H2/H4 — the pnpm store index is trusted (reqs 1, 3, 6)

- [ ] **Spike the store-index isolation.** pnpm trusts `v11/index.db`, so a
      manifest rewrite (H4) or a warm-store byte poison (H2) installs attacker
      content with `verify-store-integrity=true`. Confirm whether pnpm can keep a
      per-session (or per-repo) `index.db` while sharing content blobs, the
      pnpm analogue of the H1 npm fix. Reproduce first with `verify-h4.sh`. This
      is the one unsolved mechanism in the design; do not build until it holds.
- [ ] Set `verify-store-integrity=true` explicitly (ShipIt sets neither pnpm
      value today), but treat it as necessary, not sufficient — it trusts the
      writable `index.db`.
- [ ] Regression test: a manifest rewrite in the shared store must not reach an
      install in another session.

## H3 — pnpm hardlink (reqs 1, 4, 10, 11)

- [ ] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable.
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
- [ ] Req 10 gate: on ext4, `package-import-method=copy` alone regresses disk
      ~1.8×. Land the overlay (or accept the interim cost deliberately) before
      calling req 10 met — do not ship copy on ext4 as if it were free.
- [ ] Never `chown -R` through an overlay mount; act on the base or the upper.
- [ ] shipit-docs: describe store verification as pnpm's, and name
      `verify-store-integrity` as what it depends on.
- [x] Correct the "integrity-checked on link" claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md`.

## Sequencing guard (req 8)

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until the H1
      fix lands and the pnpm store is safe against H3 and H4.

## Optional — per-repo pnpm store key

Not needed for any requirement. Only if cross-repo blast radius is wanted on its
own.

- [ ] Add the repo hash to `pnpmStoreDirForRuntime` and extend the disk-janitor
      sweep; measure the disk regression from losing cross-repo dedup first.
