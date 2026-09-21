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
- [x] No-lockfile consumer gate (R3 P1, narrowed R4): where `prepareOverlaySpecs`
      selects specs, a pnpm checkout with no `pnpm-lock.yaml` (committed or not) gets no
      base lowerdir. One-shot at mount; no live watcher — a later deletion inherits the
      default-branch graph the orchestrator built, the repo's own trust boundary. The
      presence read is `hasPnpmLockfile` (`src/server/shared/pnpm-repo.ts`), beside the
      package-manager detection it is the narrower question of.
- [x] Worker install marker (R3): `markerMatches` took `commit || depsHash`, so a
      same-commit approval change skipped the install and the build never ran. It now
      takes `requireDepsHash`, which `install-controller.ts` sets for a pnpm checkout, and
      `resolveDepsHashInputs` appends `pnpm-workspace.yaml` to a custom `installInputs`
      list for a pnpm repo (the default list already carries it). **Consequence, stated
      rather than engineered around:** a pnpm repo whose install commands yield no content
      hash re-installs on every container start. That is the safe direction, and declaring
      `install-inputs` restores the skip; recorded in `shipit-docs/environment.md`.
- [x] `isPnpmRepo` moved to `src/server/shared/pnpm-repo.ts` (re-exported from
      `overlay-session.ts`). The worker needs the same answer from the same inputs and
      may not import from `orchestrator/` (eslint boundary).
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
- [x] Verified namespace: one discriminator (`pnpm-verified-v<N>`, at `v2` since
      planning#604 retired the pre-fix bases) as a fourth
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
- [x] Trigger (2026-09-21, after the consumer-side gates, because a published pointer opens the
      mount gate at once): `overlay-publish.ts`'s pnpm early-return is now
      `publishVerifiedPnpmBase`, on docs/183's own condition — a successful declared install whose
      session sits on the default-branch commit — building from the bare cache at that commit and
      publishing into the verified namespace. Nothing on this path reads the session's
      `node_modules`, and build/verification/eligibility failures are publish outcomes, never a
      failed session install (req 9). Four implementation decisions: a pointer already naming the
      commit skips the build (every session's install triggers, so without it the common case is a
      builder container per container start); admission lives in `buildVerifiedPnpmBase` — one
      build per scope claimed before the first await, plus `MAX_CONCURRENT_PNPM_BASE_BUILDS` across
      scopes — and **skips** rather than queues, since the next install triggers again; the trigger
      carries no abort signal, so a build outlives its triggering session (the npm/yarn loop beside
      it turns an aborted signal into an `error` outcome, so this had to be written not to inherit
      that); and `node_modules` is the only dep dir the builder can fill, so a pnpm repo declaring
      another gets no base rather than one its all-or-nothing mount gate could never accept.
- [x] Independent review of the trigger slice (2026-09-21, reviewer role, given the design cold).
      Its **P1 reproduced by measurement and is fixed**: pnpm records its resolved `<storeDir>/v<N>`
      in `.modules.yaml`, so a pnpm 10 consumer (store `v10`) of a tree the pinned pnpm 12 builder
      wrote (`v11`) prints `Recreating node_modules` and reinstalls — rc=0, so **not** the install
      failure the review expected, but over an overlay it whiteouts the whole base into the
      session's upper, inverting reqs 7 and 10. Measured in the same run: pnpm 11.22.0 and 12.5.1
      (both `v11`, and 12.5.1 is the image's corepack default) hit the base with no recreate and no
      download, and the review's own pnpm-11 concern was a store-**path** confound; and pnpm 12
      accepts a pnpm-10 `lockfileVersion: '9.0'` under `--frozen-lockfile`, so nothing else in the
      decision would have caught such a repo. `MIN_VERIFIED_BASE_PNPM_MAJOR` now gates the publisher
      (committed `packageManager`) and `prepareOverlaySpecs` (the checkout's). Both P2s confirmed by
      reading the code and fixed: the build slot was claimed before the `try`, so an ENOSPC while
      creating the work dir held it for the process's life (two such failures held the global cap —
      reproduced by the guard); and the whole-scope sweep removes a scope's base directory while its
      pointer survives outside the swept tree, so `publishBase` answered `skipped-equal` about a
      directory that was gone and the scope never got a base again — it now materializes
      (`repaired`), which fixes the npm/yarn publisher too. P3 fixed both halves: a throw out of
      Docker/fs/publish is reported as an `error` outcome instead of escaping the measurement line,
      and the agent docs now say "no NEW base is built" rather than promising a private install to a
      repo that already published one.
- [x] Second independent review of the trigger slice (2026-09-21, after the first round's fixes
      materially changed the diff). Both P2s confirmed and fixed. The version gates read
      `packageManager` only, and **`devEngines.packageManager` selects pnpm on its own** — measured
      on corepack 0.34.6, which reopened exactly the case the gates were added for; both gates now
      read either field, and two more measured shapes need no handling (disagreeing fields make
      corepack refuse any pnpm; a `devEngines` range is refused as "expected a semver version").
      And the **boot reaper could kill a live build**: it is launched un-awaited and sweeps pnpm
      after paced plugin cleanup, by which time a restored session can be building — every run now
      nests under a per-process id that is also a container label, so no start barrier is needed.
      P3 fixed: `install_ms` was read after the publish, so a 2 s install behind a 5 min build
      reported ~302 s on the one line req 7 is judged from. Its P1 is planning#601, the
      already-tracked Docker-proxy TOCTOU: the design records it as inherited from docs/183 and to
      be closed on its own, and the npm/yarn base has carried the same exposure since — this widens
      which repos have a shared base rather than adding a class of exposure. Stated in the PR body;
      still open below.
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
- [x] Measure the build-inclusive base-hit install cost (approved registry dep +
      `--ignore-scripts` base + empty private store): warm-install time and the
      marginal build-output disk in the upper. **Measured 2026-09-21**
      (`build-cost-spike.sh`, services host, PASS=14 FAIL=1 — the failure is the
      finding), with the base built by the pinned pnpm 12.4.1 and consumed by
      12.5.1, every session container running as its own non-root uid over a base
      owned by another uid with group write. **There is no build-inclusive cost to
      report, because the build does not run**: an approved pending build over a
      base hit costs 8 192 B and 286 ms and leaves the package silently unbuilt at
      rc=0, while the same project and approval file with no base builds (59 MiB
      tree + 52 MiB store, 1 043 ms). Isolation re-asserted under distinct uids:
      base byte-unchanged, session 2 inherits nothing. Two probe errors caught and
      recorded rather than shipped as passes (esbuild's binary comes from an
      optional dep; `require('better-sqlite3')` succeeds with no binding).
- [x] **A script-bearing repo gets a silently unbuilt tree once a base exists**
      (found by the measurement above, 2026-09-21; planning#604). The session's
      own install skips `pendingBuilds` — "Lockfile is up to date, resolution
      step is skipped" — and the two repairs fail under the session's own uid
      with `Operation not permitted`, because copy-up keeps the lower's owner and
      a session may rewrite a base file but not `chmod` it (`shareOne`,
      `session-worker-uid.ts:124`). The repo worked from its first private install
      and broke from the next container start. plan.md section 5's "that install
      is where builds run" is corrected there. Of the three candidates, the
      **fail-safe** shipped: a candidate whose packages carry an install-time
      script is INELIGIBLE (`pnpm-install-scripts.ts`, pnpm's own
      `pkgRequiresBuild` set read from the digest-verified tarballs) — no base,
      plain private install. A base carrying built output was rejected outright;
      the session-uid repair moves to "sharing for ineligible repos" below.
      Retiring the bases ALREADY published under the old rule is part of the same
      fix: a pointer is never invalidated in place, so the verified namespace
      went `pnpm-verified-v1` → `v2`.
- [x] The `.pnpmfile.mjs` and `configDependencies` suppression gap measured
      (2026-09-21, pnpm 12.4.1, FINDINGS.md): `--ignore-pnpmfile` suppresses
      **both** — module body and `readPackage` — exactly as it does `.cjs`. So
      the eligibility rule **may** admit them in a follow-up; deliberately not
      changed here, since admitting them widens what the builder runs on. The
      builder's refusal of the `pnpmfile`/`globalPnpmfile` keys closes the
      `configDependencies` route a second time.
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
- [x] Concurrency (R2/R3, simplified R4). `withScopeLock` is exported and now serializes
      claim-taking, publish and sweep; `claimOverlayBaseGeneration` takes the claiming
      session id and lives until `releaseOverlayBaseClaims` — the 10-minute expiry is
      gone, released in a `finally` around select→mount at both creation paths
      (`app-lifecycle.ts`, `warm-pool-manager.ts`). A published generation whose directory
      is gone selects generation 0 and installs (`selectGeneration`), and
      `prepareOverlayDirs` creates ONLY generation 0's lowerdir. `liveOverlayScopeHashes`
      claims the pinned address as well as the unpinned one (creation keys on runtime key
      + `overlayPinSegment`), a superset because the pin is read from the mutable checkout.
      Two defects the design did not name, both found by the independent review, both
      reproduced and fixed: `withScopeLock` itself **admitted concurrent holders** (it read its
      queue link back off the map after awaiting, so two same-tick callers shared one link and a
      third could enter mid-hold), and a claim's whole lifetime could fall **between** the
      pass-wide Docker sample and the per-scope claim read — the sweep now re-checks Docker
      inside the scope lock, after that scope's claim read, and only for a scope that would
      actually delete something. Both have guards that go red on the old code.
- [x] Independent review of this slice (2026-09-21, reviewer role, given the design cold). Four
      findings, all confirmed by reading the code and all fixed: the lock's shared queue link; the
      claim lifetime falling between the sweep's two readings; a session-keyed claim letting one
      creation attempt release another attempt's protection (claims are keyed by an opaque
      per-operation token now); and `install-inputs: []` — the explicit content-keying opt-out —
      becoming an approvals-only hash that could skip a needed install. It also named four test
      blind spots, each now covered: a third lock entrant, a claim taken after the sweep started,
      an empty override with a workspace dir, and the pnpm fixtures that had no lockfile and so
      passed the mount gate for the wrong reason.
- [x] Dependency: section 1 (H1) landed first — `npm_config_cache` is now the
      session's own cache, pnpm repos included, so a pnpm repo whose agent runs
      npm is no longer exposed to H1.
- [ ] Dependency: the Docker-proxy mount-path check is TOCTOU
      (`docker-proxy-auth.ts:66` → `docker-proxy-sanitize.ts:112`); the
      group-writable base relies on mount confinement. Filed as **planning#601**.
- [x] **Design: sharing for ineligible repos** (2026-09-21, plan.md section 5,
      "Sharing for ineligible repos"). Two committed harnesses,
      `ineligible-sharing-spike.sh` (in-container, PASS=26) and
      `ineligible-sharing-host-spike.sh` (services host, overlay + distinct
      uids, PASS=13). Outcome: one prerequisite (seed the executable targets), one
      new mechanism (a pruned base) covering the build-bearing class, two classes
      admitted outright, one left as a candidate, and the rest stay private with a
      reason each. The
      per-session whiteout the item used to name was rejected on the subtractive
      pass — the removed set must be uniform, so pruning at publish is the same
      effect with no per-session machinery.

- [ ] **Prerequisite, and a live req 9 defect: `pnpm add` over a verified base
      fails as the session's own uid.** pnpm chmods every executable target
      unconditionally (10 no-op calls measured); overlay copy-up keeps the
      lower's owner and group write does not grant `chmod`, so it EPERMs —
      `ERR_PNPM_CMD_SHIM_CHMOD`, confirmed on a real overlay. A base hit and an
      in-package edit make zero chmod calls, which is why production looks
      healthy. Fix: `prepareOverlayDirs` seeds the base's executable targets into
      the session's **upper**, chowned to the session uid. The set is `bin` **plus
      `directories.bin` when `bin` is absent** — measured (cell J), and a
      `bin`-only list silently misses the second form. 28 files / 204 KiB on
      ShipIt's own tree. Seed **once, at upper creation or reset**, never
      overwriting an existing entry: `prepareOverlayDirs` resets an upper only on
      generation supersession, so within a generation it is reused across
      restarts and re-seeding would overwrite the agent's own dependency edits
      (req 11). Resolve inside the upper without following symlinks — it is
      session-controlled (the docs/272 lesson, where docs/272 does not reach).
      Measured to fix both `pnpm add` and the pruned base; unseeded both fail.
      Guard: `pnpm add` as a non-owner uid over a base, red without the seed,
      plus a cell for a `directories.bin` package and one for an upper that
      already holds an edited file.

- [ ] **Pruned base for build-bearing repos** (the planning#604 class, the large
      one). At publish, remove each package carrying an install-time trigger from
      the built tree **and from the carried `node_modules/.pnpm/lock.yaml`**. The
      detection already exists and is verified — `scanTarballForBuildTriggers`
      (`pnpm-install-scripts.ts`), called from the fetch phase at
      `pnpm-base-registry.ts:266`, using pnpm's own `pkgRequiresBuild` set. It is
      **repurposed, not removed**: today its verdict refuses the candidate, and
      here the same verdict names the prune set, so those repos become eligible
      again with no new detector. Pruning the carried lockfile is load-bearing,
      not tidying: a hole in the tree alone is repaired only under
      `--frozen-lockfile`, and a bare `pnpm install` short-circuits on "Already
      up to date" and leaves a silently broken tree. ShipIt cannot assume the
      flag: `agent.install` is repo-authored with no default and `tuneNpmInstall`
      rewrites npm commands only. So the prune must be
      **verified after it is applied**, and a prune that cannot be verified yields
      no base rather than a pruned one — and that invariant has to be **stated**,
      not inferred: measured for a top-level package and for a retained dependent
      (`vite` retained, `esbuild` pruned, 47 incoming edges left, relinked and
      loading), but NOT for peer-qualified duplicates, `npm:` aliases,
      optional/platform-skipped packages, or a consumer lockfile differing from
      the publisher's commit. The prune also leaves `.modules.yaml` naming the
      removed package in `pendingBuilds`; harmless in both shapes, not
      established as harmless. Bump the verified namespace (`v2` → `v3`): the
      contract for what a base *contains* changes, and a pointer is never
      invalidated in place. Measured: rc=0, re-imported, built, addon loads,
      12 MiB upper + 12 MiB private store against a base hit's 8 KiB + 4 KiB,
      base byte-unchanged, second session inherits nothing. Depends on the seed
      above.

- [ ] **Admit `.pnpmfile.mjs`.** `--ignore-pnpmfile` suppresses both the module
      body and `readPackage` — measured twice now, and the refusal at
      `pnpm-base-inputs.ts:354` still says "unmeasured" in its own comment.
      Delete the `.mjs` clause; keep the builder's refusal of the
      `pnpmfile`/`globalPnpmfile`/`global-pnpmfile` keys as the second layer.
      `configDependencies` stays ineligible on purpose — its hook IS suppressed
      (measured, with a positive control), so the reason is that admitting it
      makes the builder **fetch and stage plugin packages** it otherwise would
      not, which widens the input surface.

- [ ] **Settle `workspace:` / `link:` / `file:` — a candidate, not yet an
      admission** (downgraded on review). What holds: a frozen, offline install
      against a dead registry succeeds with only the manifests staged, and pnpm
      writes a **relative** link that resolves in the consuming checkout. Two
      things must be settled first. (a) The builder publishes
      `projectDir/node_modules` alone (`pnpm-base-builder.ts`), while a
      workspace's members each carry `packages/*/node_modules`; no cell consumes
      a root-only base from a workspace repo. (b) `injectWorkspacePackages` and
      `dependenciesMeta[].injected` make pnpm **copy member content into the
      tree**, which would put unverified in-repo content into a published base —
      and nothing in `decidePnpmBaseEligibility` or `pnpm-lockfile.ts` detects
      either today. Then narrow `LOCAL_SPECIFIER`, with a cell showing an
      out-of-repo `link:` still refused and one showing an injected member
      refused.

- [ ] **Admit `patchedDependencies`.** Patch bytes are in the immutable snapshot
      and the tarball is digest-verified, so the output is verifiable by
      construction; pnpm applies the patch under the builder's own flags, and an
      unparseable patch fails the install closed naming the patch. Stage the
      patch paths the manifest actually references, not a conventional
      `patches/` directory. The cell measured 12.5.1 online with
      `--no-frozen-lockfile`, so the slice must re-check it on the real pipeline
      — pinned 12.4.1, verified tarballs, the fetch phase, a frozen offline
      install — and add a consumption cell with a changed patch.

- [ ] **The classes that stay private keep reqs 2 / 10 / 13 OPEN.** They are not
      exempt: no requirement has been waived, and only the requester can decide a
      class is permanently outside req 13. The two realistic candidates for an
      exemption are a `git:`/URL source and a repo pinning pnpm <= 10.
      Deliberately NOT filed under `## Open questions` — a bullet there blocks
      implementation code for the whole feature, including the req 9 fix above —
      so it is routed to the requester through the parent session instead. An
      independent review also noted that pnpm <= 10 may need only a
      **version-parameterized** builder rather than a second build path; price
      that before treating the row as closed.

- [ ] **shipit-docs (`environment.md`)**: what an agent sees on a pruned base —
      the packages that build are imported into the session's private store on
      first install and built as the session's own uid, so the first install after
      a container start is slower than a base hit and the rest of the tree is
      shared. Do not describe the seed; it has no agent-visible surface.
- [x] Resolution metadata stays private per session — **verified at the source 2026-09-21**,
      not inferred: nothing in `src/` sets `XDG_CACHE_HOME` for a session container, so pnpm
      falls back to `$HOME/.cache/pnpm` under `HOME=/home/shipit` (`buildEnv`,
      `shared/agent-home.ts:4`), and no bind or volume in `buildMounts` targets any path under
      it; under `readonlyRootfs` the home is a per-container tmpfs
      (`container-hardening.ts:readonlyRootfsTmpfs`) and the entrypoint's home links point only
      into the per-session `/credentials` (`docker/session-worker/entrypoint.sh:174-182`). The
      two other `XDG_CACHE_HOME` setters are off this path: `session-namer.ts:219`
      (orchestrator-side opencode run) and `pnpm-base-builder.ts:251` (inside the builder
      sandbox). No shared or seeded metadata cache; a lockfile carries the resolution for the
      offline case (FINDINGS.md). Cited in plan.md section 5, "Resolution metadata".
- [x] Regression test: `integration_tests/pnpm-store-isolation.test.ts`. The store half runs
      real pnpm >= 11 against a local registry, with the H4 attack re-derived for a current
      pnpm (FINDINGS.md): a whole-row swap is refused by `strictStorePkgContentCheck`, so the
      attack is a **key rename** — pnpm's own writer produces the row for the attacker's
      tarball and the attacker renames it onto the integrity everyone else asks for, leaving
      manifest, name, version and every blob digest consistent. Its control fires that attack
      through ONE shared store and asserts the victim installs `EVIL`; the fix runs it against
      two `sessionPnpmStoreDir` paths, with a non-vacuity cell showing the poisoned index is
      live for anyone who does share that store. Proven red by making the store path
      session-independent. The base half asserts the mount shape — one shared lowerdir, each
      session's own upper and work dir (red if the base is named as `upperdir`), and no bind
      exposing the base tree; the kernel copy-up half stays with the services-host spikes,
      which a session container cannot run.

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
- [x] Req 10 gate: on ext4, `package-import-method=copy` alone regresses disk
      ~1.8×. **Closed 2026-09-21 — the copy is now only applied where it is
      free.** Two measurements decide it (FINDINGS.md). In the standard container
      layout there is no hardlink baseline at all: `link()` compares mounts, not
      superblocks, so a hardlink from `/workspace/.pnpm-store` into a dep dir is
      **EXDEV** even on one ext4 device — raw `link()` EXDEV, and real pnpm 12.5.1
      on its default `auto` produced `nlink=1`. An ordinary session has been
      copying all along; the 1.8× row is copy-vs-hardlink on ONE mount. Two
      layouts DO recreate one mount (a `virtualStoreDir` on the store's mount,
      `nlink=2` measured; a dropped store mount, where pnpm 10 resolves its
      default to `/workspace/.pnpm-store/v10`) — so the pnpm >= 11 setting is
      applied only where a verified base is mounted, which neither layout can
      have, and they keep their free hardlinks into a store that is theirs alone.
      Where it IS set the overlay makes a base hit import nothing (8 KB upper,
      tree spike), so only an added package is copied. pnpm <= 10 keeps the
      unconditional pre-11 spelling, as shipped, and it is a no-op for it in the
      standard layout for the same EXDEV reason.
- [x] Never `chown -R` through an overlay mount; act on the base or the upper.
      Nothing was added that chowns: verified at the source that the worker
      entrypoint prunes `.pnpm-store` and every `SHIPIT_DEP_DIRS` entry from its
      chown/chmod walks (`docker/session-worker/entrypoint.sh:15-34`).
- [x] shipit-docs: describe the boundary as the private store plus the verified
      base; do not present `verify-store-integrity` as cross-session protection.
      `environment.md` now describes the copy import, the edit-stays-local
      consequence (req 11) and its ext4 disk cost, and says plainly that the
      store is not yet a boundary and `verify-store-integrity` is a local check.
- [x] Migration for trees installed before the setting (independent review,
      2026-09-20, confirmed by measurement): `copy` governs an import, so an
      existing `node_modules` keeps its store hardlinks through a plain reinstall
      **and through `pnpm install --force`**; only removing the tree re-imports
      it. The "GAP" cell in `integration_tests/pnpm-store-import-method.test.ts`
      pins the behaviour so the caveat can be dropped if pnpm changes.
      **Closed 2026-09-21: no cross-session-linked tree exists.** The first draft
      of this tick argued the private store makes the links intra-session; an
      independent review rejected that, correctly — deleting a store does not
      unlink two trees that hardlink the same inode, so had those links existed,
      an edit in one session's `node_modules` would still change another's
      (reqs 1, 4, 11). Measured instead of argued (FINDINGS.md): every store that
      was ever **shared** is mounted separately from the dep dirs, and `link()`
      refuses to cross a mount boundary even within one filesystem — raw `link()`
      EXDEV, and a real pnpm install `nlink=1`. So a tree installed from a shared
      store is a tree of copies and shares no inode with another session's. A
      tree that IS hardlinked (the two escaping layouts above) is linked only
      into its own session's store. Nothing to rebuild either way. The
      agent-facing caveat in `environment.md` described the one-mount pnpm
      behaviour and is corrected in the same change.
- [x] Correct the "integrity-checked on link" claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md`.

## Sequencing guard (req 8)

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until the H1
      fix lands and the pnpm store is safe against H3 and H4.
