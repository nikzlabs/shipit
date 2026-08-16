# Checklist — orchestrator-side git trust boundary

Build sequence from [plan.md](./plan.md) §5. Requirements are cited as `(req N)`.

## Shipped

- [x] **E1 — orchestrator git on a session workspace runs as the tree's owner**
      (reqs 1, 2, 3, 11). `shared/git-tree-uid.ts` decides by **ownership**, the
      same fact git's own CVE-2022-24765 check tests, applied inside
      `safeSimpleGit` so all ~189 `createGitManager` call sites and all 13 raw
      `safeSimpleGit(workspaceDir)` sites are covered without a hand-kept list.
      Gated on `process.getuid() === 0`, so the session worker, local mode and
      every test are unchanged.
- [x] The two raw git spawns that touch a session workspace converted —
      `git-lfs-blob.ts` (`git lfs smudge` resolves `filter.lfs.smudge` from the
      repo's own config) and `github-auth.ts` (writing `credential.helper` as
      root would also leave a root-owned file inside a worker-owned `.git`).
- [x] **A separate global config for the dropped-uid git**, 0600 and
      worker-owned, carrying identity and `commit.gpgsign=false` — without which
      `git commit` hard-fails with "Author identity unknown".
- [x] `/credentials` tightened to 0700 and its `.gitconfig` kept root-only. It
      was 0755/0644 — the PAT was readable by every uid in the orchestrator
      container. Harmless while nothing non-root ran there; not harmless once
      git drops uid. Worth doing on its own merits, so not gated on the drop.
- [x] **E5-detect (reqs 14, 15)** — the two permission states classified and
      surfaced as persisted transcript notices, with different words each:
      "this commit is short" for an unreadable **directory**, "this turn was NOT
      committed" for an unreadable **file**. Matched on message text, never on
      an exit code (`GitError.exitCode` is `undefined` by construction).
- [x] Tests: `git-tree-uid.test.ts` (the decision, via its injection seam) and
      `git-unreadable.test.ts` (both permission states against **real git**, not
      a mock — the design's original claim about this was wrong and only
      measurement caught it).

## Not shipped — tracked, and the reason each was split out

- [ ] **E2 — narrow `safe.directory=*`** so a missed call site fails closed
      rather than silently running as root (req 7). **planning#403.** Split
      because removing the `*` turns every missed site into a hard failure at
      once, on the post-turn commit path, and E1 cannot be exercised for real in
      a session container (no root; `unshare -r` refused). Land E1, observe it in
      production, then remove the `*`.
- [ ] **E3 — repo-scoped token instead of the PAT** for the dropped-uid git.
      **planning#404.** The dropped git must be able to `push`, so it needs a
      readable credential; today that is the PAT in a 0600 worker-owned file.
      Reach narrowed (every uid → root + worker uid) but `/credentials` is not
      out of scope, and **req 1 names it**. The credential is per-session and
      per-repo, so it cannot live in the boot-time, repo-less writer.
- [ ] **E4 — let the project's hooks fire again** (reqs 9, 10). Sequenced last
      by `plan.md` §5 because it is the only step that *adds* a way for the
      commit to fail, and it needs the bounded-attempt-then-`--no-verify`
      fallback to satisfy req 10.
- [ ] **Per-session uids** (req 13). **planning#405.** Until then a payload at
      the shared uid still reaches every session's workspace inside the
      orchestrator container.

## Do not write up as closed

planning#384 is **not** closed by this work. E1 removes root, the Docker socket
and the credential store *as a whole* from the payload's reach on the
tree-touching and remote paths. It does not remove `/credentials` (E3), it is
not yet fail-closed (E2), and cross-session workspace access remains (req 13).
