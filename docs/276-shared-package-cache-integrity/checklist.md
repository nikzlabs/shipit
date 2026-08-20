# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). **Nothing here may start** until
the [open questions](./requirements.md#open-questions) are answered — the
answers to Q1 and Q2 decide which of these items exist at all. Requirement 9
(2026-08-20) already removed one option — see requirements.md.

## Blocked on the requester

- [ ] **Q1 answered** — how much protection: contain it, check at install, or
      per-session copies? *(Decides which option is viable. "Stop sessions
      writing" was ruled out by requirement 9.)*
- [ ] **Q2 answered** — may we require projects to pin dependency versions?
- [ ] **Q3 answered** — if the complete fix means sharing less, is that allowed
      (`docs/270-per-session-worker-uids` req 9)?
- [ ] **Q4 answered** — hold `docs/266-orchestrator-git-trust-boundary` E4
      (req 8)?
- [ ] Answers recorded as dated receipts under `## Resolved questions`, with the
      open-question bullets removed and any requirement change in the same diff.

## Step 1 — close H1, the demonstrated npm RCE (reqs 1, 3, 5, 6)

- [ ] Spike: confirm npm tolerates a per-session `_cacache/index-v5` with a
      shared `content-v2`, and measure what warm-install time it actually costs
      (req 7). If it does not, this step needs a different mechanism.
- [ ] Make ShipIt's install path lockfile-pinned (`npm ci` semantics), subject
      to Q2's answer.
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
- [ ] H3 (req 4), if Q1 is answered (c): switch to per-session copies
      (`package-import-method=copy`), and measure the actual disk cost per
      session before committing to it — docs/198 measured ~464 MB.
- [ ] Only if the requester asks for it: price **Reshaped B** (mediate the fetch
      at the registry layer, so `npm install` still works — req 9). Open
      sub-questions are in plan.md: every install path pointed at the mediator,
      the warm-install cost, and git / `file:` dependencies that bypass the
      registry.
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
