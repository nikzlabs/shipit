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
      `npm_config_cache` is `/plugin-npm-cache`, a directory of this generation's
      work dir reset before every install job, with `content-v2` symlinked to the
      shared per-source store and the shared `index-v5` removed. The reset is what
      bounds a forged packument — a different job already has its own directory, so
      the reset covers the forced same-generation re-install. Measured with both
      halves on ext4: a reset private cache installs `npm ci --offline` from the
      shared store alone (0 new blobs), content lands there at mode 0664, and the
      shared `index-v5` is never re-created. Single-package, so it establishes no
      download is needed, not throughput.
- [x] Rejected for the plugin split, on review: a **tmpfs** private root. It reads
      as the tidier answer (nothing to reset) and is wrong — npm keeps `_npx` trees
      and git-dependency checkouts under its cache root (measured: 2.7 MB for one
      `npx cowsay`, against a few KB of index), so RAM-backing caps a dependency
      tree against the container's memory limit, and Docker's tmpfs default is
      `noexec`, which would break running anything `npx` installed.

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
- [x] Builder configuration (R3 P1, narrowed R4): `builderScript` runs `pnpm install
      --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile` and `builderEnv`
      states the whole configuration — HOME inside the sandbox, `npm_config_userconfig`
      and `npm_config_globalconfig` at `/dev/null`, no credentials, `--store-dir` and
      `--registry` on the COMMAND LINE so a staged `.npmrc` cannot outrank them.
      `.pnpmfile.cjs` is admitted and `.pnpmfile.mjs`/`configDependencies` stay
      ineligible; stronger than designed, a `.pnpmfile` is never staged at all, so
      `--ignore-pnpmfile` is defence in depth. **Deviation, measured:** a baked pinned
      binary is NOT enough — a repo's `packageManager` reaches the builder by three
      routes and the pinned binary self-switches, so all three switches are set
      (FINDINGS.md).
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
- [x] Input contract (R3 P2, narrowed R4), one eligibility decision over the
      staged input set (`decidePnpmBaseEligibility`), every clause asserted in
      `pnpm-base-inputs.test.ts`: verify `optionalDependencies` like the rest; trust
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
- [x] Baseline correction (2026-09-20, re-verified on pnpm 12.5.1 with `pnpm store
      path`): `PNPM_CONFIG_STORE_DIR` relocates the store; `npm_config_store_dir` and
      `PNPM_STORE_DIR` move nothing for pnpm >= 11. So H2/H3/H4 were open only for
      pnpm <= 10, and for pnpm >= 11 section 5 ADDS sharing to a private store rather
      than fixing a shared one — req 2's baseline for them is "no sharing", req 10's
      is "a private store with hardlinks", and there is nothing to migrate off.
      `PNPM_STORE_DIR` removed: its `/dep-cache/pnpm` target is writable by every
      session of the repo, so a release that honoured it would arm H2/H4 at repo scope.
      Holes table and section 5 framing rewritten, not annotated.
- [x] Private per-session pnpm store: `preparePnpmStore` resolves
      `sessionPnpmStoreDir` (`<stateDir>/sessions/<id>/overlay/pnpm-store`), mounted at
      the same `/workspace/.pnpm-store` the base is built against, dropped with the
      session dir. Store path set under BOTH env spellings now that the target is
      private. `ensurePnpmStoreDir` seals it **0700 to the session uid**, replacing the
      group share — carrying that over would have left every session able to write
      every other session's index. The shared per-runtime store is retired; nothing is
      migrated from it. **Deviation:** its janitor sweep is kept rather than dropped —
      it is what reclaims the retired trees, and it now exempts no hash, ageing them
      out instead of deleting at once (a pre-upgrade container may still mount one).
- [x] Verified namespace: one fixed discriminator (`pnpm-verified-v1`) as a fourth
      field of `overlayScopeHash`, and an optional `namespace` on `OverlayScope` so the
      pointer, the publish and the mount address one scope. Omitting it reproduces the
      pre-namespace hash, so existing npm/yarn bases stay addressable.
      `prepareOverlaySpecs` mounts a pnpm session only when a published pointer exists
      in that namespace for every ELIGIBLE dep dir — read off the specs themselves, so
      the gate cannot address a different scope than the mount — and never falls back; a pointer in
      the un-namespaced scope — what the untrusted snapshot publisher writes — opens
      nothing, asserted as the control. `liveOverlayScopeHashes` claims both addresses
      for every session, since package-manager detection reads the mutable checkout and
      must not decide whether a base is reapable. No `admission` pointer fields.
- [x] Rebuild-in-container (`pnpm-base-builder.ts`): dedicated builder, `NetworkMode:
      none`, `CapDrop: ALL`, memory/pids/time limits, no workspace; publishes through
      `publishBase` → `copySnapshotToBase`, reusing `withScopeLock` and `finalize`
      unchanged. **Deviation, measured:** the sandbox store is populated by `pnpm fetch`
      through a LOOPBACK registry over the staged verified tarballs, not by ShipIt writing
      pnpm's store — `v11/index.db` is SQLite, so hand-writing it is a second
      implementation of pnpm's store. The loopback server is up for the fetch phase only;
      the phase that produces the published tree runs `--offline` against a dead port.
      The archive-to-manifest derivation is off the path with the store-entry shape it
      served; what is still leaned on (tarball sha512 == lockfile integrity == packument
      `dist.integrity`) is scripted in `pnpm-base-registry.test.ts` and
      `integration_tests/pnpm-verified-base-build.test.ts`. Version pinned **12.4.1**, not
      plan.md's 12.4.2, which was 6 days old and inside the dependency-policy window.
- [x] Immutable input snapshot (`stagePnpmInputs`): the manifests, lockfile,
      `pnpm-workspace.yaml` and applicable `.npmrc` are read out of ONE commit through
      git, never out of the session's checkout — asserted by a cell that edits the working
      tree after the commit and shows the snapshot unchanged. A committed `node_modules`
      is never a build input. The registry is the orchestrator's own; no lockfile URL is
      ever fetched (`pnpm-base-registry.test.ts`).
- [ ] Trigger: nothing calls `buildVerifiedPnpmBase` yet. It lands with the consumer-side
      changes that make mounting a verified base safe (no pnpm pre-stamp, the no-lockfile
      gate, the per-scope lock), because a published pointer opens the mount gate at once.
- [x] Independent review of the builder slice (2026-09-21, reviewer role, given the design
      cold). Its **P1 reproduced and is fixed**: the FETCH phase omitted `--ignore-pnpmfile`,
      and `globalPnpmfile` was not a rejected key — so a staged `hooks.cjs/package.json` with
      `main: "../.npmrc"` could have Node execute the staged `.npmrc` inside the builder,
      before the phase that publishes. Both halves are closed (the flag on both phases, and
      `pnpmfile`/`globalPnpmfile`/`global-pnpmfile` refused), with a cell naming the chain.
      Also confirmed and fixed: the base recorded `/build/store` while consumers use
      `/workspace/.pnpm-store`, which is a store mismatch at every consumer — the builder now
      uses the session's own constants, and a new cell consumes the built tree against an
      empty store at the recorded path; a local edge a plain specifier RESOLVED to escaped the
      decision (both importer `version` and `snapshots` edges are read now); authorized scope
      registries were accepted by the helper but unreachable through the builder (plumbed, and
      per-package registry selection added); two packages whose readable names collide shared
      one staged file (named by digest now); declaring the supported layout explicitly cost a
      repo its base (only a non-default value is refused); the missing-package control accepted
      any rejection and its corepack fallback could not launch (named failure; the fallback is
      a shim); and a crashed orchestrator stranded builder containers and work dirs
      (`reapOrphanPnpmBaseBuilds`, boot-only, wired into `startup-janitor.ts`). Its request for
      an executable script-suppression control produced two measurements that changed the
      fixture: `onlyBuiltDependencies` does not approve a build on 12.4.1, and the FETCH phase
      needs `--ignore-scripts` too (FINDINGS.md).
- [x] CI-only failure of the builder harness (2026-09-21), fixed without reproducing it, so
      the leading explanation is stated rather than claimed. The harness resolved a **host**
      pnpm first, which a session container has and the CI runner does not — so the path CI ran
      was the one never exercised locally, and on it `builderEnv`'s per-run HOME made corepack
      re-download the pinned pnpm on each of five invocations. The pinned spec is tried first
      now (same path everywhere, and it measures the version the image bakes), one
      `COREPACK_HOME` serves the file, ports come from the OS rather than `pid % 1000`, and a
      failed build reports pnpm's own output instead of the shell script. The builder script
      also notices a loopback registry that exited before it was ready and prints its log —
      that failure previously said nothing at all.
- [ ] Measure the build-inclusive base-hit install cost (approved registry dep +
      `--ignore-scripts` base + empty private store): warm-install time and the
      marginal build-output disk in the upper. The 8 KB result used scriptless
      deps and does not cover this; the tree spikes also ran as root, not as
      distinct session uids.
- [x] Independent review of the store + namespace slice (2026-09-20, reviewer role). Its
      P1 on the retired-store sweep was confirmed and fixed: ageing on the store ROOT's
      mtime is not an activity signal, because pnpm writes under `v11/files/<xx>/` and
      never touches the ancestor, so a store a surviving pre-upgrade container was still
      filling could be reaped. The sweep now ages on the newest mtime within 3 levels,
      with a guard that goes red on the root-only rule. Its P1 on
      `ERR_PNPM_UNEXPECTED_STORE` did NOT reproduce — measured on pnpm 12.5.1, the
      relocation re-fetches and rewrites `.modules.yaml`, rc=0 (FINDINGS.md); pnpm <= 10
      keeps the same recorded path. Also fixed: a tautological backward-compat hash
      assertion (now a literal pre-namespace digest), an ownership test that could not
      tell per-session identity from one global uid (the resolver is now injected), and
      two overstated agent-facing claims. Its P2 — liveness hashing `overlayRuntimeKey`
      alone while creation adds `overlayPinSegment` — is the pre-existing mismatch the
      concurrency item below already owns; it cannot bite yet, since nothing publishes
      into the verified namespace.
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

- [x] Set `package-import-method=copy` explicitly. Not `clone`: it fails the
      install where reflink is unavailable. With the store private, `copy` is an
      import-compatibility setting (a hardlink cannot cross the overlay
      boundary), not a cross-session security boundary — the private store and
      the verified base are that boundary. Shipped in `buildEnv`
      (`container-lifecycle.ts`) beside the store path, as
      `npm_config_package_import_method=copy` only — measured 2026-09-20 that
      pnpm 10.28.2 reads `npm_config_*` while 11.22.0 / 12.5.1 read only
      `PNPM_CONFIG_*`, and the store relocation uses the same pre-11 spelling, so
      copy reaches exactly the versions that share a store. pnpm ≥ 11 has a
      private in-container store and stays on hardlinks (requester's decision
      2026-09-20: copy there costs ~1.8× disk for no cross-session gain);
      **section 5 owns re-adding it** when the overlay makes the copy free. A
      unit test pins the shipped spelling, the absence of the pnpm ≥ 11 one, and
      that `clone` is never requested.
- [x] Regression test for H3: a write to a store file must not change an
      already-installed `node_modules` file in another session.
      `integration_tests/pnpm-store-import-method.test.ts`, real pnpm 10 (the
      range the shipped setting reaches) against a local registry: the poison is
      an in-place overwrite that keeps size and mtime, and the cell asserts the
      store file really changed before asserting the installed file did not. Its
      control imports by hardlink and shows the same write reaching the victim
      (`nlink` 2 → 1 across the pair).
- [x] Regression test for req 11: an edit inside one session's installed
      packages must stay invisible to another session. A future return to
      hardlink sharing would silently break this — its control measures exactly
      that, the same edit under the default import reaching the other session.
      Both fix cells were run red against a spelling that pnpm version ignores,
      so they fail on an ineffective setting, not only on a missing line. The
      controls request `hardlink` explicitly rather than pnpm's default, so a
      reflink filesystem or an inherited import method cannot decide what they
      measure.
- [ ] Req 10 gate: on ext4, `package-import-method=copy` alone regresses disk
      ~1.8×. Land the overlay (or accept the interim cost deliberately) before
      calling req 10 met — do not ship copy on ext4 as if it were free.
      **Still open after the 2026-09-20 ship**: the requester chose to land H3
      first and accept the interim ext4 cost (plan.md section 2), so this closes
      only when section 5's tree overlay makes the copy free again.
- [x] Never `chown -R` through an overlay mount; act on the base or the upper.
      Nothing was added that chowns: verified at the source that the worker
      entrypoint prunes `.pnpm-store` and every `SHIPIT_DEP_DIRS` entry from its
      chown/chmod walks (`docker/session-worker/entrypoint.sh:15-34`).
- [x] shipit-docs: describe the boundary as the private store plus the verified
      base; do not present `verify-store-integrity` as cross-session protection.
      `environment.md` now describes the copy import, the edit-stays-local
      consequence (req 11) and its ext4 disk cost, and says plainly that the
      store is not yet a boundary and `verify-store-integrity` is a local check.
- [ ] Migration for trees installed before the setting (independent review,
      2026-09-20, confirmed by measurement): `copy` governs an import, so an
      existing `node_modules` keeps its store hardlinks through a plain reinstall
      **and through `pnpm install --force`**; only removing the tree re-imports
      it. Reqs 4 and 11 hold for such a session from its next cold install. The
      "GAP" cell in `integration_tests/pnpm-store-import-method.test.ts` pins the
      behaviour so the caveat can be dropped if pnpm changes. Rebuilding those
      trees is a destructive step and a requester decision; section 5 moots it.
- [x] Correct the "integrity-checked on link" claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md`.

## Sequencing guard (req 8)

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until the H1
      fix lands and the pnpm store is safe against H3 and H4.
