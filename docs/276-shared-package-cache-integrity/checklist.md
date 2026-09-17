# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). The shape is now settled: Q1 and
Q3 are closed by requirement 10 (2026-09-17) and Q2 is withdrawn. **Q4 and Q5**
remain open; Q4 gates only the sequencing guard at the end.

## Blocked on the requester

- [x] **Q1 closed** — the requester rejected both options (2026-09-17) and
      restated the requirement as having both. Copy-on-write satisfies it; recorded
      as requirement 10 with a dated receipt.
- [x] **Q2 withdrawn** — the lockfile question was never load-bearing. Measured
      2026-09-17: the per-session resolution cache covers a repo with no lockfile,
      so requiring one would have been a user-facing policy change buying nothing.
      Requirement 5 stands and is satisfied.
- [x] **Q3 closed** — it asked whether per-session copying was worth its disk;
      copy-on-write removes the disk, so the question no longer arises.
- [ ] **Q4 answered** — hold `docs/266-orchestrator-git-trust-boundary` E4
      (req 8)?
- [ ] **Q5 answered** — must the agent be able to edit files inside installed
      packages? Promoted from prose under the old Q1 into a numbered question, so
      it stops riding along in chat. Cheap to grant under options E/F (measured: a
      64 KB copy-up), so it decides whether that is a requirement or a side effect.
- [ ] Answers recorded as dated receipts under `## Resolved questions`, with the
      open-question bullets removed and any requirement change in the same diff.

## Step 1 — close H1, the demonstrated npm RCE (reqs 1, 3, 5, 6)

- [x] Spike: confirm npm tolerates a per-session `_cacache/index-v5` with a shared
      `content-v2`. **Done 2026-09-17: it does.** Private `index-v5` plus a
      symlinked shared `content-v2` installs offline (1 055 files), and the symlink
      survives the install. Split is **64 KB private / 688 KB shared**. An
      attacker's write to the shared `index-v5` had no effect on the victim, where
      the same write against today's shared cache broke the victim's install.
- [ ] Still to measure for this step: warm-install time against req 7, and whether
      the symlinked `content-v2` survives `npm cache verify` / npm's own GC.
- [ ] Do **not** make the install path lockfile-pinned as a security measure
      (Q2, withdrawn). Measured: it covers `npm ci` and an in-sync `npm install`,
      and **not** adding a package or an out-of-sync lockfile — while the
      per-session resolution cache covers all of those plus the no-lockfile repo.
- [ ] Regression test for the **adding** case specifically: with a valid lockfile
      present, `npm install <new-package>` against a poisoned packument must not
      execute the attacker's `postinstall`.
- [ ] Check whether a poisoned integrity can still reach `package-lock.json`, and
      therefore ShipIt's auto-commit. Measured today: it can, which turns a cache
      write into a committed change to the user's repository.
- [ ] No special no-lockfile behaviour is needed (Q2 withdrawn): measured, the
      per-session resolution cache protects a repo with no lockfile unchanged.
- [ ] Regression test that reproduces the packument-poisoning RCE and asserts it
      now fails closed — the test must poison `dist.integrity` **and**
      `hasInstallScript`, since the second is what makes it execute at install.
- [ ] shipit-docs update if repos without a lockfile change behaviour.

## Step 2 — the pnpm store: H2 (install path) and H3 (hardlink)

- [x] Correct the refuted claim in
      `docs/198-dep-cache-content-keying-and-pnpm-store/plan.md` — pnpm does
      **not** integrity-check on link. Done in this PR, as a dated correction
      note on the "Known caveat" bullet, since a shipped doc asserting a
      guarantee the code does not provide is how this work inherited the error
      in the first place. Not gated on the open questions: it is a factual fix.
- [x] H2 (poisoned store content installed normally) — **settled: not a hole.**
      Measured with `verify-h2.sh`, pnpm content-hash-checks on import (evicts and
      re-downloads online, fails closed offline), identically on 11.22.0 and
      12.4.2. ShipIt does not need to build verification; the earlier plan to do
      so is withdrawn.
- [ ] Set `verify-store-integrity=true` **explicitly** rather than inheriting the
      default — `false` disables the check completely and ShipIt currently asserts
      neither value. Small, and the only H2 work left.
- [ ] H3 (reqs 4, 10): set **`package-import-method=copy`**. Not `clone` — that
      fails the install outright where reflink is unavailable (`os error 95` on
      ext4, `os error 18` across filesystems). `copy` is correct everywhere: full
      cost on ext4, and it reflinks **automatically** on a reflink filesystem via
      `copy_file_range`. Ships independently of any storage change.
- [x] **Measure reflink on real XFS(reflink=1) storage.** Done 2026-09-17 on a
      loopback XFS image: fresh filesystem per run, `df` from empty — hardlink
      **91 MB**, copy **92 MB**, clone **92 MB** for a 3 353-file / 86 MB
      `node_modules`. Extent sharing confirmed with `filefrag` (1 054/1 057 files
      flagged `shared`, different inode). **Option E confirmed.**
- [ ] **Evaluate option F (overlayfs) as the ext4 answer.** Measured 2026-09-17:
      two sessions over one shared 59 MB / 1 547-file base cost **4 KB each**, and
      a write by one session left the other session and the base untouched — on
      plain ext4, no reflink, no privileges (Docker mounts the overlay as a
      volume). This is docs/183 machinery that docs/198 turned off for pnpm.
- [ ] Decide whether the pnpm store moves **inside** the overlay. As deployed it is
      a separate read-write bind at `/workspace/.pnpm-store`, outside any overlay,
      so option F does not cover it and H3 survives there. Moving it in is what
      closes that, and what costs an installing session its own tree.
- [ ] Re-frame docs/198 Part 2's 464 MB objection rather than treating it as
      settled: it applies only to sessions that CHANGE dependencies, which by
      definition no longer share the base's tree. Base-hit sessions pay ~nothing.
- [ ] Never `chown -R` through an overlay mount — it copies up every file and
      destroys the sharing (measured: a 4 KB upper became 110 MB). Same hazard as
      docs/272 for shared git trees. Act on the base or the upper directly.
- [ ] Detect reflink support on the state directory at startup and surface it, so
      an operator on ext4 can see why per-session disk rose and what would change
      it. **Detect and report — never require.** ShipIt installs on laptops and in
      Docker VMs; the filesystem is not ShipIt's to choose.
- [ ] Do **not** build a loopback-image mount. It needs `CAP_SYS_ADMIN`, which the
      orchestrator does not take today, and taking it to save disk in a change
      meant to reduce what a session can do is the wrong trade. Linux-only, and it
      nests a filesystem inside a VM on macOS/Windows. Left as an operator-level
      option, documented with its privilege cost, not as a ShipIt feature.
- [ ] Note for anyone re-running the reflink measurements: keep the store and the
      workspace on ONE filesystem (`EXDEV` otherwise — measured), and probe with a
      file larger than ~2 KB, since btrfs inlines smaller files into metadata and
      hides extent sharing entirely.
- [x] **Re-test H2 with a controlled harness.** Done — `verify-h2.sh`, committed
      beside this checklist. The apparent copied-vs-in-place difference that made
      H2 look unsettled was a defect in the first harness (one store reused across
      trials, so each poison ran against an entry pnpm had just re-verified), not
      a pnpm behaviour. Store-state and poison-length both turned out irrelevant.
- [ ] Record that ShipIt sets neither `package-import-method` nor
      `verify-store-integrity` anywhere in `src/` today — both run on pnpm
      defaults, so either is a new explicit setting rather than a change.
- [ ] No H3 work is needed for npm repos: npm does not hardlink `_cacache` into
      `node_modules` (measured, `links=1`), so it already pays the private-copy
      cost. H3 is pnpm-only.
- [x] Price **registry mediation** (mediate the fetch so `npm install` still
      works — req 9). Done: plan.md option D. **Refuted** — it closes none of the
      three holes, because the attacker writes the shared files directly and
      never asks the registry. Do not build it for this issue.
- [ ] In shipit-docs, describe store verification as **pnpm's**, not ShipIt's, and
      name `verify-store-integrity` as the thing it depends on. The residual to
      record is H3, which no content check can reach.

## Step 3 — optional, orthogonal (narrowing the store key)

*Not selected by requirement 10, and not needed for it. Worth doing only if
cross-repo blast radius is wanted for its own sake.*

- [ ] Add the repo hash to `pnpmStoreDirForRuntime`
      (`src/server/orchestrator/overlay-session.ts:607`).
- [ ] Extend the disk-janitor sweep for the now-larger set of store directories.
- [ ] Measure the disk regression from losing cross-repo dedup before shipping,
      and state it as a blast-radius reduction rather than a fix.

## Sequencing guard

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until step 1
      lands and the H3 item in step 2 ships (req 8).
