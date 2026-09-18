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

- [x] **Spike the store-index isolation (2026-09-17): direction found, fix not
      solved.** A per-session *cold* `index.db` over shared blobs does not work
      (measured: offline install fails; the manifest is not reconstructable from
      the blobs). Overlay copy-up would isolate the writes — sound by the kernel
      contract — but the existing docs/183 overlay *excludes pnpm* on purpose
      (hardlinks cannot cross overlayfs), so this is new machinery.
- [x] **Design the trusted-base lifecycle (2026-09-18, plan.md section 5).**
      Content-based: the base is orchestrator-written and holds only entries
      verified against registry integrity (index.db key == tarball sha512;
      manifest re-derivable from the tarball — both measured). Sessions install
      into private uppers; publish = verify-and-admit; start the base empty
      rather than promote today's writable store; per-runtime key stays.
- [ ] Spike verify-and-admit: from a session upper, list new `index.db` entries,
      fetch each tarball by key, check hash == key, re-derive the manifest and
      match it, check each blob hashes to its name, admit to a new generation.
      Measure fetch cost per new package and confirm pnpm accepts the result.
- [ ] Decide the publish trigger (after each session install, as docs/183 does)
      and what a verification failure does: drop the entry from the base, keep
      it private to the session, and surface it — never fail the session's own
      install (req 9).
- [ ] Measure store-in-overlay for real via Docker-mounted overlays — adapt
      `docs/183-overlay-dep-store/prototype/nested-overlay-spike.sh`; run the
      manifest and blob attacks through session A and an install through B, with
      a shared-bind attack control. Not runnable in a session container.
- [ ] Measure the install-time disk and time (req 7, req 10) with the store on
      an overlay: whole-file `index.db` copy-up, imported package files, store
      lock. The 4 KB / 63 MB figures are for reading a base, not installing.
- [ ] Set `verify-store-integrity=true` explicitly (ShipIt sets neither pnpm
      value today), but treat it as necessary, not sufficient — it trusts the
      writable `index.db`.
- [ ] Regression test: a manifest rewrite in the shared store must not reach an
      install in another session.

## H3 — pnpm hardlink (reqs 1, 4, 10, 11)

- [ ] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable.
- [ ] `copy` alone does not make the shared store safe (H2/H4 survive); the
      store must also move inside an overlay (the H2/H4 section above). `copy` is
      also a prerequisite for that move, since a hardlink import cannot cross the
      overlay boundary.
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
