# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). **Nothing here may start** until
the [open questions](./requirements.md#open-questions) are answered — **Q1 and Q3
together** decide which of these items exist at all. Requirement 9 (2026-08-20)
already removed one option — see requirements.md.

## Blocked on the requester

- [ ] **Q1 answered** — how much protection: contain it, or per-session copies?
      *(Two live options. "Stop sessions writing" was ruled out by requirement 9;
      "check at install time" collapses into the per-session resolution cache,
      because a check is only worth its expectation source.)*
- [ ] **Q2 answered** — may we require projects to pin dependency versions?
      *(Defence in depth, not the fix — measured. Not urgent.)*
- [ ] **Q3 answered** — is per-session copying compatible with
      `docs/270-per-session-worker-uids` req 9? *(Gates Q1 option (b).)*
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
- [ ] H2 (poisoned store content installed normally) has no upstream fix to lean
      on. Decide whether ShipIt verifies store contents itself, or closes the
      write via option B — pricing the verification against req 7 first.
- [ ] H3 (req 4), if Q1 is answered (b): set `package-import-method`. Prefer
      `clone-or-copy` over `copy` — same isolation, and it becomes near-free the
      moment the filesystem supports reflink. Never `clone`: it fails the install
      outright on ext4 (measured, `os error 95`).
- [ ] **Measure reflink on a real XFS(reflink=1)/btrfs host before pricing option
      (b) as cheap.** This is the one unverified link in plan.md option E — this
      container has no capabilities, no `mkfs.xfs`/`mkfs.btrfs` and cannot mount,
      so the saving is inferred from the mechanism, not observed. Two claims in
      this doc have already flipped under measurement.
- [ ] Decide separately whether ShipIt's data disk moves off ext4. That is a host
      storage migration with its own risk and rollback story, and it is what makes
      option (b) cheap rather than a 1.8× disk regression.
- [ ] **Re-test H2 with a harness that controls pnpm's verification cache.**
      Today's runs contradicted each other depending on whether the store was
      copied aside or poisoned in place, so no H2 conclusion may be drawn from
      them. Also pin down `verify-store-integrity`: setting it false installed
      poisoned bytes every time, so a real check exists and something is gating it.
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
- [ ] Record the residual explicitly in `requirements.md` and in shipit-docs
      whenever H2 is left open, so "integrity checking" is not read as covering
      the store.

## Step 3 — optional, orthogonal (Q1 answered (a))

- [ ] Add the repo hash to `pnpmStoreDirForRuntime`
      (`src/server/orchestrator/overlay-session.ts:607`).
- [ ] Extend the disk-janitor sweep for the now-larger set of store directories.
- [ ] Measure the disk regression from losing cross-repo dedup before shipping,
      and state it as a blast-radius reduction rather than a fix.

## Sequencing guard

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until step 1
      lands and Q1 is answered (req 8).
