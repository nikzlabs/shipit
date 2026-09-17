# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). The shape is now settled: Q1 and
Q3 are closed by requirement 10 (2026-09-17), which requires isolation **and** the
storage saving rather than a choice between them. Q2 and Q4 remain open but gate
only their own items, not this list.

## Blocked on the requester

- [x] **Q1 closed** — the requester rejected both options (2026-09-17) and
      restated the requirement as having both. Copy-on-write satisfies it; recorded
      as requirement 10 with a dated receipt.
- [ ] **Q2 answered** — may we require projects to pin dependency versions?
      *(Defence in depth, not the fix — measured. Not urgent.)*
- [x] **Q3 closed** — it asked whether per-session copying was worth its disk;
      copy-on-write removes the disk, so the question no longer arises.
- [ ] **Q4 answered** — hold `docs/266-orchestrator-git-trust-boundary` E4
      (req 8)?
- [ ] Answers recorded as dated receipts under `## Resolved questions`, with the
      open-question bullets removed and any requirement change in the same diff.

## Step 1 — close H1, the demonstrated npm RCE (reqs 1, 3, 5, 6)

- [ ] Spike: confirm npm tolerates a per-session `_cacache/index-v5` with a
      shared `content-v2`, and measure what warm-install time it actually costs
      (req 7). If it does not, this step needs a different mechanism. **This is
      the fix, not the lockfile** — it is the only cheap thing that also covers
      `npm install <new-package>`.
- [ ] Make ShipIt's install path lockfile-pinned (`npm ci` semantics), subject
      to Q2's answer. Defence in depth only: measured to cover `npm ci` and
      in-sync `npm install`, and **not** adding a package or an out-of-sync
      lockfile.
- [ ] Regression test for the **adding** case specifically: with a valid lockfile
      present, `npm install <new-package>` against a poisoned packument must not
      execute the attacker's `postinstall`.
- [ ] Check whether a poisoned integrity can still reach `package-lock.json`, and
      therefore ShipIt's auto-commit. Measured today: it can, which turns a cache
      write into a committed change to the user's repository.
- [ ] Decide and implement the no-lockfile behaviour Q2 selects (install without
      the shared cache, or warn).
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
- [ ] Put the **state directory** — store *and* session workspaces together — on a
      reflink-capable filesystem. Measured: reflink and hardlink both fail across a
      filesystem boundary (`EXDEV`), and moving the store alone buys nothing. A
      loopback XFS image on the existing ext4 works and avoids reformatting the
      host; price its sizing, loop-device management and fsck story before
      choosing it over a real filesystem.
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
