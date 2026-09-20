# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). Requirement decisions are
recorded in [requirements.md](./requirements.md); none is open.

## H1 — per-session npm resolution cache (reqs 1, 3, 5, 6)

- [x] Spike: npm tolerates a private `_cacache/index-v5` with a symlinked shared
      `content-v2`. Offline install succeeds, the symlink survives, split is
      64 KB private / 688 KB shared, and a write to the shared `index-v5` no
      longer affects the victim.
- [x] Measured warm-install time against req 7 and the command compatibility of a
      split cache (`verify-h1.mjs`, PASS=17, npm 11.12.1, ext4, two full runs):
      warm `--prefer-offline` **0.97× / 1.07×**, cold private index
      **0.99× / 1.03×**, and the no-lockfile case that actually uses the index
      **1.05× / 0.99×**. Every cell is inside the ±5 % the same cell moves between
      runs, in both directions — no measurable cost, and not a speed-up either.
      An in-sync lockfile install writes no resolution index at all. The link
      survives an install that writes content; a new package's bytes still land in
      the shared store. `npm cache verify` and `npm doctor` **fail** on the split
      (cacache globs the content dir and gets the symlink back); `cache verify`
      aborts before its first delete and `doctor` loses and rewrites nothing,
      asserted per blob rather than by count. A real directory there would instead
      let one session's GC strip the repo's shared store. `npm cache clean --force`
      works and leaves the shared store byte-identical. All in
      `shipit-docs/environment.md`.
- [x] The one genuine reduction in sharing, measured and documented: resolution is
      no longer shared, so `npm install --offline <pkg>` for a package this session
      has never resolved fails `ENOTCACHED` where it could previously reuse another
      session's packument. Not a req 2 breach (no install fails *because another
      session wrote first*), and ShipIt's own install line is `--prefer-offline`
      (`install-runtime.ts:29`), which falls back to the registry.
- [x] Confirmed npm re-hashes shared `content-v2` on read with **no**
      verification-skip marker — `cacache/lib/content/read.js` checks every read
      and records no `checkedAt`; `hasContent` only stats. Measured: a blob
      poisoned in place with its mtime preserved (pnpm's H2 poison) fails closed
      offline and self-heals online. Sharing `content-v2` does not reopen the hole.
- [x] Regression test: `integration_tests/npm-cache-poisoning.test.ts` — poisoned
      packument (`dist.integrity` **and** `hasInstallScript`) against real npm and
      a local registry, `npm install <new-package>` with and without a lockfile
      (req 5), plus a control that asserts the attack does fire on a shared index
      with the registry reachable, and a content-poisoning cell for req 3.
- [x] No lockfile pinning was added; the split covers the adding case too.
- [x] shipit-docs updated (`environment.md`): the split, the per-session cache
      path, and the two commands that change. Repos without a lockfile install as
      before.
- [x] Same split at plugin scope (**planning#603**): the install container's
      `npm_config_cache` is `/plugin-npm-cache`, a tmpfs — private by construction,
      since it cannot outlive the container — with `content-v2` symlinked to the
      shared per-source store and the shared `index-v5` removed. Measured against
      real npm with the private root on tmpfs and the shared store on ext4:
      `npm ci --offline` with a wholly cold private index installs from the shared
      store alone (0 new blobs, 0 index entries), content written the other way
      crosses the boundary at mode 0664, and `npm cache clean --force` leaves the
      shared store intact.

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
- [x] Publish trigger decided (2026-09-18): after a successful declared
      install, where docs/183 publishes; a verification failure skips the
      publish (a publish outcome naming the first failing package), the session
      keeps its private tree, its install is never failed (req 9). A post-turn
      publish for mid-session `pnpm add` is a follow-up.
- [x] Measure the store-in-overlay attack ISOLATION via Docker-mounted overlays
      (`store-overlay-spike.sh`, [FINDINGS.md](./FINDINGS.md), services host
      2026-09-18, PASS=13). H4 and H2 each in its own cell through session A
      stayed in A's upper; base `index.db` byte-unchanged; victim B installed
      clean (asserted by digest); each attack's own no-overlay control poisoned
      B. The harness hard-asserts attack success and mandatory control poisoning,
      so a no-op attack cannot read as a pass.
- [x] Measure req 7 against a genuine hardlink baseline (scale set, ext4,
      install timed inside the container, link counts asserted): overlay-copy is
      **1.47×** the hardlink install (0.060 → 0.088 s best-of-5). Measurable,
      small-absolute for this workload, scales with file count; the cost is the
      copy, removed by a reflink fs.
- [x] Measure req 10 in **allocated** blocks (scale set, ext4): today's
      per-session marginal is **0 B** (node_modules hardlinks the store); the
      design pays **58.6 MB** (a full per-session node_modules copy). **Req 10 is
      NOT met on ext4 by copy alone** — the docs/198 per-session-copy objection,
      quantified.
- [x] Storage decision (2026-09-18, req 12): ext4 must be supported; reflink-only
      optimisations are out of scope. So the store-in-overlay shape is **not
      viable** (it needs reflink to meet req 10). Verified on the services host
      why it cannot be rescued: `fs.protected_hardlinks=1` denies a session a
      hardlink to any file it cannot write, and a hardlink to an overlay lower
      copies the data up. The reflink re-measure is dropped.
- [x] Requester's answer on cross-repo pnpm store dedup (2026-09-18): per-repo
      sharing is fine. Recorded as req 13; the share-the-tree redesign is
      unblocked.
- [x] Spike the redesign (`tree-overlay-spike.sh`, services host, ext4,
      2026-09-18, PASS=12): pnpm treats the lowerdir tree as up to date with an
      empty private store (rc=0, store untouched, upper 8 KB); `pnpm add` works
      against the private store (+229 KB upper, base byte-unchanged); an edit
      copies up only that file; a second session sees neither. Two wiring
      notes: the private store must sit at the base's recorded container path
      (`.modules.yaml` `storeDir`), and pnpm 12 exits 1 on an "Ignored build
      scripts" notice even for a no-op install (pnpm's default, the project's
      `approve-builds` concern).
- [x] Design verify-and-admit for the tree, revised through two review rounds
      (2026-09-18, plan.md section 5, "The lifecycle, revised through two review
      rounds"): the orchestrator rebuilds the base from the repo's committed
      manifests + lockfile + config, verifying each package's lockfile integrity
      against its OWN registry; every session runs its own install over the base
      (**no pnpm pre-stamp**), so builds run and the session's graph reconciles
      in its upper; the session snapshot pull is dropped for pnpm. All-or-nothing
      admission; git/`file:`/`link:`/`workspace:`/`patchedDependencies`/pnpmfile
      repos get no base.
- [x] Spike `.bin/` shims and carried state (`tree-state-spike.sh`, PASS=9,
      FINDINGS.md): shims NOT regenerated on a genuine no-op; an inconsistent
      carried lock.yaml self-heals on an install; a carried
      `allowBuilds`/`pendingBuilds` does NOT run a script without the session's
      own approval (positive control passes). Plus the base-hit-skips-install
      fact. All settled by having the orchestrator generate the tree and each
      session run its own install.
- [x] Two independent reviews of the lifecycle (2026-09-18, reviewer role, both
      briefs). R1: five P1s → rebuild instead of audit. R2: pre-stamp over an
      unbuilt base skips builds, no-lockfile inherits the carried graph → cut
      pre-stamp. R3: a pnpm HOOK runs under `--ignore-scripts` (measured), so a
      `configDependencies`/pnpmfile plugin executes in the builder; the
      no-lockfile gate must be per CONSUMER not per repo; the worker marker skips
      on commit alone; concurrency needs operation-lifetime claims. All folded
      into plan.md section 5.
- [x] Fourth review, subtractive (2026-09-20, reviewer role: for each element,
      would anyone notice if it were removed?). Cut: runner-bound cancellation
      of the build, the fleet census, `verify-store-integrity` as part of the
      fix, reflink detection, the optional per-repo store key, the extractor
      four-limit mandate, the live lockfile watcher. Narrowed: hook-presence
      rejection to `.mjs`/`configDependencies` only (`.cjs` suppression is
      measured), `npm:` aliases admitted, layout rejection to output that
      escapes `node_modules`. Simplified: the namespace to one fixed
      discriminator, claims to one per-scope lock, a missing generation to
      generation 0. Rejected: a gate over the existing snapshot publisher (it
      authenticates nothing). Folded into plan.md section 5.
- [ ] Builder configuration (R3 P1, narrowed R4): run `pnpm install --offline
      --frozen-lockfile --ignore-scripts --ignore-pnpmfile` with an explicit
      known config — no inherited global `.npmrc`/`pnpm-workspace.yaml`, no
      credentials, `packageManager` version-switching disabled (a repo pin can
      switch the baked pnpm). `.pnpmfile.cjs` is admitted (hook suppressed,
      measured); `.pnpmfile.mjs` and `configDependencies` are ineligible until
      their suppression is measured.
- [ ] No-lockfile consumer gate (R3 P1, narrowed R4): where `prepareOverlaySpecs`
      selects specs (`container-overlay-provisioner.ts:65`), a checkout with no
      `pnpm-lock.yaml` (committed or not) gets no base lowerdir. One-shot at
      mount; no live watcher — a later deletion inherits the default-branch
      graph the orchestrator built, the repo's own trust boundary.
- [ ] Worker install marker (R3): `markerMatches` returns `commit || depsHash`
      (`install-marker.ts:52`), so a same-commit approval change skips the
      install and the build never runs. For pnpm require the content hash, and
      always include `pnpm-workspace.yaml` in it — the default input list does
      (`deps-hash.ts:21`) but a custom `installInputs` replaces the list (`:89`).
- [ ] Input contract (R3 P2, narrowed R4), one eligibility decision over the
      staged input set: verify `optionalDependencies` like the rest; trust
      `bundledDependencies` as part of the authenticated outer tarball; for an
      `npm:` alias verify the resolved target's digest; use the
      orchestrator-authorized scope→registry map for a scoped registry (`.npmrc`
      must not override it) and admit when mapped; do not reject a
      deprecated-but-present version; override a relocated global store to the
      fixed builder path; ineligible only when output escapes one
      `node_modules` (`modulesDir`, `virtualStoreDir`, non-isolated
      `nodeLinker`) or the entry is `git`/`file:`/`link:`/`workspace:`/patched
      (first cut); a missing lockfile-covered dep skips the publish without
      failing the session install.
- [ ] Verified namespace: add one fixed discriminator (`pnpm-verified-v1`) to
      `overlayScopeHash` (`overlay-volume.ts:23`); `prepareOverlaySpecs` mounts
      pnpm sessions only from it and never falls back to an unverified base; the
      unverified npm/yarn publisher cannot write there. No `admission` pointer
      fields.
- [ ] Rebuild-in-container: dedicated builder, no workspace, no network; private
      store built inside the sandbox by unpacking staged integrity-checked
      tarballs (not the session's store index); staged manifests + config; then
      `copySnapshotToBase` + `publishBase` (reusing `withScopeLock` and
      `finalize`). Resource-limit the builder container (disk, time); the
      archive-to-manifest derivation was verified interactively, not by a
      committed harness, so script it.
- [ ] Immutable input snapshot: stage the manifests, lockfile and config from
      one snapshot of the default-branch commit; resolve the registry the
      orchestrator selects, never a lockfile URL.
- [ ] Measure the build-inclusive base-hit install cost (approved registry dep +
      `--ignore-scripts` base + empty private store): warm-install time and the
      marginal build-output disk in the upper. The 8 KB result used scriptless
      deps and does not cover this; the tree spikes also ran as root, not as
      distinct session uids.
- [ ] Concurrency (R2/R3, simplified R4): no runner-bound cancellation — a
      build that outlives its trigger finishes. Serialize claim-taking, publish
      and sweep on one per-scope lock (`withScopeLock`, `overlay-base.ts:101`,
      today publisher-only) and make a claim live for the whole select→mount;
      `claimOverlayBaseGeneration`'s 10-min expiry and the sweeps' separate
      sampling are what this replaces. A missing published generation selects
      generation 0 (`overlay-session.ts:119`) and installs; never `mkdirSync`
      the pointer's lowerdir (`container-lifecycle.ts:459`). Compute liveness
      with the same scope function creation uses (`resolveOverlayScope` keys on
      runtime key + `overlayPinSegment`; `liveOverlayScopeHashes` uses runtime
      key alone — `overlay-session.ts:61` vs `:189`).
- [x] Dependency: section 1 (H1) landed first — `npm_config_cache` is now the
      session's own cache, pnpm repos included, so a pnpm repo whose agent runs
      npm is no longer exposed to H1.
- [ ] Dependency: the Docker-proxy mount-path check is TOCTOU
      (`docker-proxy-auth.ts:66` → `docker-proxy-sanitize.ts:112`); the
      group-writable base relies on mount confinement. Filed as **planning#601**.
- [ ] Sharing for ineligible repos (git/`file:`/`link:`/`workspace:`/patched/
      `.mjs`-hook) — **required, not optional**: no base leaves req 2 / req 10 /
      req 13 unmet for them. Reuse the unbuilt-base / private-build shape; no
      second build path.
- [ ] Resolution metadata stays private per session (the container's own
      `XDG_CACHE_HOME/pnpm`); a lockfile carries the resolution for the offline
      case (FINDINGS.md). No shared or seeded metadata cache.
- [ ] Regression test: a manifest rewrite in one session's store, or a write to
      the shared base, must not reach an install in another session.

## H3 — pnpm hardlink (reqs 1, 4, 10, 11)

- [ ] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable. With the store private, `copy` is an
      import-compatibility setting (a hardlink cannot cross the overlay
      boundary), not a cross-session security boundary — the private store and
      the verified base are that boundary.
- [ ] Regression test for H3: a write to a store file must not change an
      already-installed `node_modules` file in another session.
- [ ] Regression test for req 11: an edit inside one session's installed
      packages must stay invisible to another session. A future return to
      hardlink sharing would silently break this.
- [ ] Req 10 gate: on ext4, `package-import-method=copy` alone regresses disk
      ~1.8×. Land the overlay (or accept the interim cost deliberately) before
      calling req 10 met — do not ship copy on ext4 as if it were free.
- [ ] Never `chown -R` through an overlay mount; act on the base or the upper.
- [ ] shipit-docs: describe the boundary as the private store plus the verified
      base; do not present `verify-store-integrity` as cross-session protection.
- [x] Correct the "integrity-checked on link" claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md`.

## Sequencing guard (req 8)

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until the H1
      fix lands and the pnpm store is safe against H3 and H4.
