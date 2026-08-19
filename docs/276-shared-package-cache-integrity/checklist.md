# Checklist — shared package cache integrity

Implementation steps for [plan.md](./plan.md). **Nothing here may start** until
the [open questions](./requirements.md#open-questions) are answered — the
answers to Q1 and Q2 decide which of these items exist at all.

## Blocked on the requester

- [ ] **Q1 answered** — does the fix have to hold without a lockfile?
- [ ] **Q2 answered** — must the live hardlink channel (req 4) be closed?
- [ ] **Q3 answered** — per-repo or per-session blast radius?
- [ ] **Q4 answered** — does `docs/270-per-session-worker-uids` req 9 bend?
- [ ] **Q5 answered** — accept the E4 sequencing constraint (req 8)?
- [ ] Answers recorded as dated receipts under `## Resolved questions`, with the
      open-question bullets removed and any requirement change in the same diff.

## Step 1 — close H1, the demonstrated npm RCE (reqs 1, 3, 5, 6)

- [ ] Spike: confirm npm tolerates a per-session `_cacache/index-v5` with a
      shared `content-v2`, and measure what warm-install time it actually costs
      (req 7). If it does not, this step needs a different mechanism.
- [ ] Make ShipIt's install path lockfile-pinned (`npm ci` semantics), subject
      to Q1's answer.
- [ ] Decide and implement the no-lockfile behaviour Q1 selects (install without
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
- [ ] H3 (req 4), only if Q2 is answered (a): scope option B properly as its own
      design — a cache-owning identity, the brokered populate step, and how the
      agent's own ad-hoc `npm install` keeps working (docs/270 req 10).
- [ ] Verify against req 2 that pnpm does not silently fall back to a private
      per-session store when the shared store is read-only.
- [ ] If Q2 is answered (b) or (c) instead: record the residual explicitly in
      `requirements.md` and in shipit-docs, so "integrity checking" is not read
      as covering it.

## Step 3 — optional, orthogonal (Q3)

- [ ] Add the repo hash to `pnpmStoreDirForRuntime`
      (`src/server/orchestrator/overlay-session.ts:607`).
- [ ] Extend the disk-janitor sweep for the now-larger set of store directories.
- [ ] Measure the disk regression from losing cross-repo dedup before shipping,
      and state it as a blast-radius reduction rather than a fix.

## Sequencing guard

- [ ] `docs/266-orchestrator-git-trust-boundary` E4 stays unshipped until step 1
      lands and Q2 is answered (req 8).
