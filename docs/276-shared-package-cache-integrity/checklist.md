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
- [x] Publish trigger decided (2026-09-18): after a successful declared
      install, where docs/183 publishes; a verification failure skips the
      publish (`skipped-unverified`, first failing package named), the session
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
- [ ] Sterile builder (R3 P1): reject every hook source (`.pnpmfile.cjs`/`.mjs`,
      `configDependencies`) in preflight; run `pnpm install --offline
      --frozen-lockfile --ignore-scripts --ignore-pnpmfile`; disable
      `packageManager` version-switching (baking pnpm is not enough — a repo pin
      can switch it); no inherited global `.npmrc`/`pnpm-workspace.yaml`, no
      env a config value could expand. Measured: a `.pnpmfile.cjs` hook ran under
      `--ignore-scripts` and only `--ignore-pnpmfile` stopped it (FINDINGS.md).
- [ ] No-lockfile is a per-CONSUMER gate (R3 P1), enforced in
      `prepareOverlaySpecs`: a session with no independently established lockfile
      (none committed, or removed over the mount) gets **no base lowerdir**, since
      pnpm would synthesize the graph from the base's `.pnpm/lock.yaml`. An
      initial presence check is not enough — cover lockfile removal over a live
      mount. The base being built from committed default-branch inputs does not
      substitute for this.
- [ ] Worker install marker (R3): `markerMatches` returns `commit || depsHash`
      (`install-marker.ts:52`), so a same-commit approval change skips the
      install and the build never runs. For pnpm the marker must require the
      content hash, or invalidate on an input change.
- [ ] Input contract (R3 P2), each with an explicit outcome: verify
      `optionalDependencies` like the rest; trust `bundledDependencies` as part
      of the authenticated outer tarball; for an `npm:` alias verify the resolved
      target's digest not the alias; use an orchestrator-authorized
      scope→registry map for a private registry (`.npmrc` must not override it);
      do not reject a deprecated-but-present version; reject output-layout
      settings (`modulesDir`, `virtualStoreDir`, non-isolated `nodeLinker`,
      relocated global store); a missing lockfile-covered dep rejects the
      candidate without failing the session install.
- [ ] Verified namespace: salt the scope hash with the verifier identity;
      `prepareOverlaySpecs` mounts pnpm sessions only from it and never falls back
      to an unverified base; the unverified npm/yarn publisher cannot write there
      (until planning#599). No `admission` pointer fields — `lockfileHash` and a
      separate `verifier` are cut (nothing gates on them; the salted namespace and
      the source commit already identify verifier and inputs).
- [ ] Rebuild-in-container: dedicated builder, no workspace, no network; private
      store built inside the sandbox by unpacking staged integrity-checked
      tarballs (not the session's store index); staged manifests + config; then
      `copySnapshotToBase` + `publishBase`. **Bound the unpack** — pnpm's audited
      extractor rejects path traversal and non-regular entries but falls back to
      streaming past its eager limit without rejecting, so cap total expanded
      bytes, entry count, duration and staging disk.
- [ ] Immutable input snapshot: stage the manifests, lockfile and config from
      one snapshot of the default-branch commit; resolve the registry the
      orchestrator selects, never a lockfile URL.
- [ ] Measure the build-inclusive base-hit install cost (approved registry dep +
      `--ignore-scripts` base + empty private store): warm-install time and the
      marginal build-output disk in the upper. The 8 KB result used scriptless
      deps and does not cover this.
- [ ] Concurrency (R2/R3): give the rebuild-and-publish an abort signal bound to
      the runner. Pointer-last is necessary but not sufficient — the sweeps
      sample claims and the pointer separately and `claimOverlayBaseGeneration`
      expires at 10 min, so reclamation must consult **current** claims at the
      irreversible-delete moment and the claim must live for the whole
      select→claim→mount. A missing published generation must **fail closed**,
      not be recreated by `prepareOverlayDirs`. Compute liveness with the same
      scope function creation uses (`resolveOverlayScope` keys on runtime key +
      `overlayPinSegment`; `liveOverlayScopeHashes` uses runtime key alone —
      `overlay-session.ts:61` vs `:189`).
- [ ] Dependency: section 1 (H1) lands first — `npm_config_cache=/dep-cache/npm`
      is forwarded to every session (`container-lifecycle.ts:367`), pnpm repos
      included.
- [ ] Dependency: the Docker-proxy mount-path check is TOCTOU
      (`docker-proxy-auth.ts:66` → `docker-proxy-sanitize.ts:112`); the
      group-writable base relies on mount confinement. Filed as **planning#601**.
- [ ] Partial-base sharing for repos with a git/`file:`/`link:`/`workspace:`/
      patched/pnpmfile dependency — **required, not optional**: all-or-nothing
      leaves them with no base, so req 2 / req 10 / req 13 are not met for them.
      Measure how many real repos fall in this set before calling the feature
      done; design an unbuilt-base / private-build path for the built ones.
- [ ] Record the metadata-cache dependency in the wiring: an offline install
      needs resolution metadata (`XDG_CACHE_HOME/pnpm`, separate from the store)
      — a shared or privately-seeded cache, a lockfile carrying the resolution,
      or an online fetch. The store overlay alone does not make cross-session
      offline installs resolve; that metadata is a separate surface and, if
      shared writable, its own integrity question (req 6 class).
- [ ] Set `verify-store-integrity=true` explicitly (ShipIt sets neither pnpm
      value today), but treat it as necessary, not sufficient — it trusts the
      writable `index.db`.
- [ ] Regression test: a manifest rewrite in one session's store, or a write to
      the shared base, must not reach an install in another session.

## H3 — pnpm hardlink (reqs 1, 4, 10, 11)

- [ ] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable.
- [ ] `copy` alone does not make a shared store safe (H2/H4 survive); the store
      must stop being shared — private per session, with the verified
      `node_modules` base as the shared unit (the H2/H4 section above). `copy` is
      the import method for a new package into the overlay upper, since a
      hardlink cannot cross the overlay boundary.
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
