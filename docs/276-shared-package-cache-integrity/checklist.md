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
- [x] Design verify-and-admit for the tree (2026-09-18, plan.md section 5,
      "The lifecycle"): verification inserted between the snapshot pull and
      `publishBase`; per package, registry `dist.integrity` is the authority
      for the lockfile's integrity (req 6), the tarball's manifest must match
      the package directory exactly, links must resolve to verified packages,
      `.modules.yaml`'s `allowBuilds`/`pendingBuilds` are reset; all-or-nothing
      admission, `skipped-unverified` outcome, session install never failed.
      Store private per session at the same container path. No shared
      metadata cache.
- [x] Spike `.bin/` shims and carried state (`tree-state-spike.sh`, PASS=9,
      FINDINGS.md): shims are NOT regenerated on a genuine no-op; an
      inconsistent carried lock.yaml self-heals on an install; a carried
      `allowBuilds`/`pendingBuilds` does NOT run a script without the session's
      own approval (positive control passes). And a base hit never runs pnpm
      (pre-stamped marker, install skipped) — so nothing carried can be checked
      later. Both settled by the revision: the orchestrator generates the tree,
      shims and state.
- [x] Independent review of the lifecycle (2026-09-18, reviewer role, both
      briefs): five P1s, all verified at the source, folded into the revised
      lifecycle (plan.md section 5). Dep-path id mapping dissolved (pnpm computes
      the ids in the rebuild).
- [ ] Verified namespace: salt the scope hash with the verifier identity;
      pointer records `admission: {verifier, lockfileHash}`;
      `prepareOverlaySpecs` mounts pnpm sessions only from it; the unverified
      npm/yarn publisher cannot write there (until planning#599).
- [ ] Rebuild-in-container: worker-image container, no workspace mount, no
      network, orchestrator-private store from staged tarballs, `pnpm install
      --offline --frozen-lockfile`, builds ignored; then `copySnapshotToBase` +
      `publishBase`.
- [ ] Staged hashing: tarball bytes (from `/dep-cache` or the registry) are
      hashed while copied into orchestrator-private staging and only the staged
      copy is used — never check-then-reopen a session-writable path.
- [ ] Pre-stamp gate: pre-stamp only when the workspace lockfile hash equals the
      base's `lockfileHash`; a repo with no committed lockfile never pre-stamps.
      Add `pnpm-workspace.yaml` (pnpm 12 `allowBuilds`) to the install inputs.
- [ ] `publishBase` takes no abort signal — give the rebuild step its own,
      bound to the runner's disposal like the snapshot pull.
- [ ] Janitor race: a renamed `g<N+1>` is reapable until the pointer is written
      (`steady-state-reclaim.ts:379-393`). Write the pointer first, or claim the
      generation for the window.
- [ ] Dependency: section 1 (H1) lands first — `npm_config_cache=/dep-cache/npm`
      is forwarded to every session (`container-lifecycle.ts:367`), pnpm repos
      included.
- [ ] Dependency: the Docker-proxy mount-path check is TOCTOU
      (`docker-proxy-auth.ts:66` → `docker-proxy-sanitize.ts:112`); the
      group-writable base relies on mount confinement. Filed as **planning#601**.
- [ ] Later refinement: a partial base for repos with a git/`file:`/private-
      registry dependency, which all-or-nothing leaves with no base (req 2 /
      req 10 not met for them).
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
